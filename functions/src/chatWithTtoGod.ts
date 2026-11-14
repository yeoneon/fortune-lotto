import {onCall} from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import OpenAI from "openai";

// 이 파일도 dailyFortune.ts와 마찬가지로 기존 index.ts(`fortuneLotto`)와
// 완전히 독립된 신규 함수다. 기존 함수는 절대 수정하지 않는다.
// 배경/제약: docs/ai-ddoshin/README.md, docs/ai-ddoshin/02-backend.md 참고.
//
// 캐시 불가 영역: 대화는 매 메시지가 유니크해서 데일리 운세처럼 캐시할 수
// 없다. 비용/어뷰즈 방어는 두 겹이다.
// (1) 클라이언트가 "티켓 1장 = 2턴"으로 호출 자체를 제한한다(티켓 소모는
//     클라에서 처리 — 이 함수는 티켓을 모른다).
// (2) 서버는 history 길이를 강제로 슬라이스해 프롬프트 폭주를 막는다.
// ⚠️ App Check: 이 함수는 캐시가 없어 매 호출이 실비용이라 다른 함수보다
// 어뷰즈에 취약하다. `onCall`의 `enforceAppCheck: true`는 Firebase 콘솔에서
// Play Integrity(Android)/App Attest(iOS) 프로바이더 등록이 끝난 뒤 켤 것.
// 콘솔 설정 전에 켜면 정상 요청까지 전부 거부된다.

let openai: OpenAI | null = null;

// 명시 버전 핀(latest 별칭 금지). 단가: 입력 $0.20 / 출력 $1.20 per M 토큰.
const OPENAI_MODEL_ID = "gpt-5.6-luna";
// 2026-08-01: 프롬프트를 3~4문장+그럴듯한 상황 요구로 강화했더니
// 실측 161~201자로 260자 상한 안에서도 이미 더 길고 설득력 있는
// 답변이 나와서, 상한 자체는 260으로 되돌렸다(맥락은 위 프롬프트
// 변경으로 유지됨).
const MAX_REPLY_LENGTH = 260;
const MAX_MESSAGE_LENGTH = 200;
// 턴 상한(클라의 "티켓 1장=2턴"과 별개로, 서버가 프롬프트 폭주를 막는
// 방어선). 최근 3턴(유저+또신 각 3개, 총 6개)만 인정한다.
const MAX_HISTORY_MESSAGES = 6;

interface ManseSymbol {
  hanja: string;
  korean: string;
  element: string;
  yinYang: string;
}

interface MansePillar {
  heavenlyStem: ManseSymbol;
  heavenlyStemTenGod: string;
  earthlyBranch: ManseSymbol;
  earthlyBranchTenGod: string;
  labelHanja: string;
  labelKorean: string;
}

interface FiveElements {
  wood: number;
  fire: number;
  earth: number;
  metal: number;
  water: number;
}

interface ManseData {
  calendarType: "solar" | "lunar";
  profile: {
    dayMaster: string;
    dayMasterElement: string;
    displayName: string;
    birthSummary: string;
  };
  pillars: {
    year: MansePillar;
    month: MansePillar;
    day: MansePillar;
    hour: MansePillar;
  };
  relations: { topRowTenGods: string[] };
  fiveElements: FiveElements;
}

interface TodayFortuneContext {
  score?: number;
  oneLine?: string;
  luckyNumbers?: number[];
  numberRationale?: string;
}

interface StatsSummary {
  hotNumbers?: number[];
  coldNumbers?: number[];
}

interface ChatMessage {
  role: "user" | "model";
  text: string;
}

interface ChatWithDdoshinRequest {
  // true면 AI를 부르지 않고 바로 돌아온다(서버 미리 깨우기용).
  warmup?: boolean;
  // 사주 미등록 사용자는 manse 없이 호출한다(통계 모드).
  manse?: ManseData;
  todayFortune?: TodayFortuneContext;
  statsSummary?: StatsSummary;
  history?: ChatMessage[];
  message: string;
}

interface ChatWithDdoshinResponse {
  reply: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isManseLike = (value: unknown): value is ManseData => {
  if (!isRecord(value)) return false;
  return isRecord(value.profile) &&
    isRecord(value.pillars) &&
    isRecord(value.fiveElements);
};

const isChatMessage = (value: unknown): value is ChatMessage => {
  if (!isRecord(value)) return false;
  return (value.role === "user" || value.role === "model") &&
    typeof value.text === "string";
};

/**
 * 클라가 보낸 history를 최근 N개만, 형식이 맞는 것만 골라 반환한다.
 * @param {unknown} value 요청으로 들어온 history 값.
 * @return {!Array<ChatMessage>} 정제된 최근 대화 이력.
 */
const sanitizeHistory = (value: unknown): ChatMessage[] => {
  if (!Array.isArray(value)) return [];
  const validOnly = value.filter(isChatMessage);
  return validOnly.slice(-MAX_HISTORY_MESSAGES);
};

const clampText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength).trim();
};

const deficientElements = (fiveElements: FiveElements): string[] => {
  const entries = Object.entries(fiveElements) as [string, number][];
  const min = Math.min(...entries.map(([, count]) => count));
  return entries
    .filter(([, count]) => count === min)
    .map(([element]) => element);
};

const ELEMENT_KOREAN: Record<string, string> = {
  wood: "목", fire: "화", earth: "토", metal: "금", water: "수",
};

/**
 * 사주/오늘운세/회차통계를 요약한 systemInstruction 문자열을 만든다.
 * @param {!ManseData} manse 만세력 데이터.
 * @param {!TodayFortuneContext} todayFortune 오늘의 운세(선택).
 * @param {!StatsSummary} statsSummary 회차 hot/cold 통계(선택).
 * @return {string} 모델 systemInstruction 텍스트.
 */
const buildSystemInstruction = (
  manse: ManseData,
  todayFortune: TodayFortuneContext,
  statsSummary: StatsSummary,
): string => {
  const deficientText = deficientElements(manse.fiveElements)
    .map((e) => ELEMENT_KOREAN[e] ?? e)
    .join(", ");
  const dayMaster = manse.profile.dayMaster || "정보 없음";
  const oneLine = todayFortune.oneLine || "정보 없음";
  const luckyNumbers = todayFortune.luckyNumbers?.join(", ") || "정보 없음";
  const hot = statsSummary.hotNumbers?.join(", ") || "정보 없음";
  const cold = statsSummary.coldNumbers?.join(", ") || "정보 없음";

  return `
    너는 '또신', 로또의 신이다.
    항상 공손한 존댓말만 사용하라. 예스러운 말투나 반말은 쓰지 마라.

    [사용자 사주 요약]
    - 일간(日主): ${dayMaster}
    - 오행 결핍(가장 적은 원소): ${deficientText}
    - 오늘의 한줄운세: ${oneLine}
    - 오늘의 행운번호: ${luckyNumbers}

    [최근 회차 번호 통계(선택 정보, 없으면 무시)]
    - 자주 나온 번호: ${hot}
    - 오래 안 나온 번호: ${cold}

    [규칙]
    - 반드시 위 사주·오행·오늘운세를 근거로 구체적으로 답하라. 일반론 금지.
    - 답은 3~4문장으로, 공손체를 유지하며 구체적인 사주 근거와
      그럴듯한 상황(예: 이번 주 언제쯤·어떤 계기로 등)을 들어
      설득력 있게 답하라.
    - 사용자가 물은 주제(일·돈·사람 등)에 그대로 답하라. 로또나 번호를
      물었을 때만 행운번호·회차 통계를 쓰고, 다른 질문을 번호 이야기로
      끌고 가지 마라.
    - 건강·죽음·투자수익을 단정하지 마라. 완곡하게 표현하라.
    - 순수 텍스트로만 답하라(JSON, 코드블록, 마크다운 금지).
    - 답변은 ${MAX_REPLY_LENGTH}자를 넘기지 마라.`;
};

/**
 * 사주 미등록 사용자용 systemInstruction(통계 모드). 사주를 지어내지 않고
 * 회차 통계만 근거로 답하며, 첫 답변에서만 사주 등록을 한 번 권한다.
 * @param {!StatsSummary} statsSummary 회차 hot/cold 통계(선택).
 * @param {boolean} isFirstReply 대화의 첫 답변인지.
 * @return {string} 모델 systemInstruction 텍스트.
 */
const buildGuestInstruction = (
  statsSummary: StatsSummary,
  isFirstReply: boolean,
): string => {
  const hot = statsSummary.hotNumbers?.join(", ") || "정보 없음";
  const cold = statsSummary.coldNumbers?.join(", ") || "정보 없음";
  const registerRule = isFirstReply ?
    `- 답변 마지막 문장에서 "또신 탭에서 생년월일을 등록하시면 사주로
      더 정확히 봐드릴게요"라는 취지를 한 번만 자연스럽게 안내하라.` :
    "- 사주 등록 안내는 이미 했으니 다시 하지 마라.";

  return `
    너는 '또신', 로또의 신이다.
    항상 공손한 존댓말만 사용하라. 예스러운 말투나 반말은 쓰지 마라.

    [사용자 정보]
    - 사용자는 아직 사주(생년월일)를 등록하지 않았다.
    - 사주·오행·운세를 지어내거나 추측하지 마라.

    [최근 회차 번호 통계]
    - 자주 나온 번호: ${hot}
    - 오래 안 나온 번호: ${cold}

    [규칙]
    - 번호를 물으면 위 회차 통계와 번호 패턴(홀짝·구간·연속번호 등)을
      근거로 답하라.
    - 답은 3~4문장으로, 공손체를 유지하며 구체적으로 답하라.
    - 번호와 관계없는 질문을 억지로 번호 이야기로 끌고 가지 마라.
    - 당첨을 보장하거나 예측이 맞는다고 단정하지 마라.
    - 건강·죽음·투자수익을 단정하지 마라. 완곡하게 표현하라.
    ${registerRule}
    - 순수 텍스트로만 답하라(JSON, 코드블록, 마크다운 금지).
    - 답변은 ${MAX_REPLY_LENGTH}자를 넘기지 마라.`;
};

const toOpenAiMessages = (
  history: ChatMessage[],
): OpenAI.ChatCompletionMessageParam[] =>
  history.map((entry) => ({
    role: entry.role === "model" ? "assistant" : "user",
    content: entry.text,
  }));

const DEFAULT_REPLY =
  "지금은 기운을 읽기 어렵네요. 잠시 후 다시 물어봐 주시겠어요?";

export const chatWithTtoGod = onCall(
  {region: "asia-northeast3"},
  async (request): Promise<ChatWithDdoshinResponse> => {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      throw new functions.https.HttpsError(
        "internal", "OPENAI_API_KEY is not set.",
      );
    }
    if (!openai) {
      openai = new OpenAI({apiKey: OPENAI_API_KEY});
    }

    const data = request.data as ChatWithDdoshinRequest;
    // 미리 깨우기: 앱이 또신 탭·대화 화면에 들어올 때 보낸다. 사용자가 질문을
    // 고르는 동안 인스턴스 기동(콜드 스타트, 실측 약 2.5초)을 끝내 두려는
    // 것이라 AI는 부르지 않는다(비용 없음).
    if (data?.warmup === true) {
      return {reply: ""};
    }
    // manse는 선택(없으면 통계 모드). 보냈는데 형식이 틀리면 거부한다.
    const hasManse = data.manse !== undefined && data.manse !== null;
    if (hasManse && !isManseLike(data.manse)) {
      throw new functions.https.HttpsError(
        "invalid-argument", "manse 형식이 올바르지 않습니다.",
      );
    }
    const message = typeof data.message === "string" ? data.message.trim() : "";
    if (!message) {
      throw new functions.https.HttpsError(
        "invalid-argument", "message가 필요합니다.",
      );
    }

    const clampedMessage = clampText(message, MAX_MESSAGE_LENGTH);
    const history = sanitizeHistory(data.history);
    const todayFortune = isRecord(data.todayFortune) ?
      (data.todayFortune as TodayFortuneContext) : {};
    const statsSummary = isRecord(data.statsSummary) ?
      (data.statsSummary as StatsSummary) : {};

    const systemInstruction = isManseLike(data.manse) ?
      buildSystemInstruction(data.manse, todayFortune, statsSummary) :
      buildGuestInstruction(statsSummary, history.length === 0);

    try {
      // gpt-5.6-luna는 temperature 커스텀 미지원(기본값 1 고정, 다른 값은
      // 400 unsupported_value) — 실제 호출로 확인(2026-07-31). max_completion_tokens는
      // 보이는 응답 외에 내부 reasoning_tokens까지 같은 예산을 공유해서
      // (실측 최대 238) 여유를 두고 잡음. 답변 길이 20% 증가(2026-08-01)에
      // 맞춰 600→700으로 상향.
      const result = await openai.chat.completions.create({
        model: OPENAI_MODEL_ID,
        max_completion_tokens: 700,
        // 2026-10-23: 추론을 끄면 같은 품질에서 응답이 약 40% 빨라진다
        // (실측 평균 4.4초→2.6초, 3회). 이 모델은 "minimal"을 지원하지 않고
        // none/low/medium/high/xhigh만 받는다.
        reasoning_effort: "none",
        messages: [
          {role: "system", content: systemInstruction},
          ...toOpenAiMessages(history),
          {role: "user", content: clampedMessage},
        ],
      });
      functions.logger.info("chatWithTtoGod token usage", {
        code: "TTOGOD_CHAT_TOKEN_USAGE",
        mode: hasManse ? "saju" : "guest",
        usage: result.usage,
      });
      const reply = clampText(
        result.choices[0]?.message?.content ?? "", MAX_REPLY_LENGTH,
      );
      return {reply: reply || DEFAULT_REPLY};
    } catch (error) {
      functions.logger.warn("chatWithTtoGod generation failed", {
        code: "TTOGOD_CHAT_FALLBACK",
        error: error instanceof Error ? error.message : String(error),
      });
      return {reply: DEFAULT_REPLY};
    }
  },
);

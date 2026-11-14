import {onCall} from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
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

if (admin.apps.length === 0) {
  admin.initializeApp();
}

let openai: OpenAI | null = null;

// 명시 버전 핀(latest 별칭 금지). 단가: 입력 $0.20 / 출력 $1.20 per M 토큰.
const OPENAI_MODEL_ID = "gpt-5.6-luna";
// 2026-11-15: 260자·3~4문장 제한에 "반드시 사주 근거"까지 겹쳐 답이
// 만세력 해설처럼 짧고 딱딱했다. 공감 → 쉬운 근거 → 오늘의 행동 순서로
// 쓰게 하고 상한을 500자로 늘렸다(넘치면 문장 단위로 자른다).
const MAX_REPLY_LENGTH = 500;
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

// 미등록자는 모두에게 같은 공통 오늘 운세(summary·scores·질문)만 보낸다.
interface TodayFortuneContext {
  score?: number;
  oneLine?: string;
  summary?: string;
  scores?: {money?: number; work?: number; people?: number};
  dayPillar?: string;
  luckyNumbers?: number[];
  numberRationale?: string;
  // 또신 탭 "오늘의 질문"과 카드에 보여준 답의 첫 문장.
  question?: string;
  questionTeaser?: string;
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

/**
 * 답변을 상한에 맞추되, 문장 중간에서 끊기지 않게 마지막 문장 끝에서 자른다.
 * @param {string} value 모델 답변.
 * @param {number} maxLength 최대 글자 수.
 * @return {string} 자른 답변.
 */
const clampReply = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const cut = trimmed.slice(0, maxLength);
  const lastEnd = Math.max(
    cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "),
    cut.lastIndexOf(".\n"),
  );
  return lastEnd > 0 ? cut.slice(0, lastEnd + 1).trim() : cut.trim();
};

/**
 * 화면에 보인 오늘의 운세를 프롬프트용 몇 줄로 만든다.
 * @param {!TodayFortuneContext} today 오늘의 운세.
 * @return {string} 프롬프트에 넣을 줄들.
 */
const todayLines = (today: TodayFortuneContext): string => {
  const s = today.scores ?? {};
  return [
    `- 오늘의 일진: ${today.dayPillar || "정보 없음"}`,
    today.score ? `- 오늘의 기운 점수: ${today.score}점(100점 만점)` : "",
    today.oneLine ? `- 한 줄 운세: ${today.oneLine}` : "",
    today.summary ? `- 오늘의 총평: ${today.summary}` : "",
    s.money ?
      `- 분야 점수(5점 만점): 재물 ${s.money}, 직장 ${s.work}, 사람 ${s.people}` :
      "",
  ].filter((line) => line).join("\n    ");
};

/**
 * 오늘의 질문 카드를 눌러 들어온 경우, 카드에 보인 첫 문장으로 답을
 * 이어가게 하는 규칙.
 * @param {!TodayFortuneContext} today 오늘의 운세.
 * @return {string} 규칙 한 줄(없으면 빈 문자열).
 */
const teaserRule = (today: TodayFortuneContext): string =>
  today.question && today.questionTeaser ?
    `- 사용자가 "${today.question}"(오늘의 질문)을 물으면 답을 반드시
      "${today.questionTeaser}"로 시작하고, 그 이유와 오늘 할 일을 이어서
      말하라.` :
    "";

// 공통 답변 방식. 만세력 해설이 아니라 고민 상담처럼 답하게 한다.
const ANSWER_STYLE = `
    [답하는 방식]
    1. 먼저 질문 속 마음(걱정·기대·답답함)을 한 문장으로 알아준다.
    2. 오늘의 운세(총평·점수·일진)에서 근거를 한두 개만 쉬운 말로 든다.
       일간·오행·십신 같은 용어는 꼭 필요할 때 한 번만, 풀어서 쓴다.
    3. 오늘이나 이번 주에 해 볼 구체적인 행동 하나로 맺는다.
    - 상황에 맞게 3~6문장으로 쓴다. 누구에게나 하는 뻔한 말 대신 이 사람의
      오늘에 맞춘 말을 한다.
    - 위 오늘의 운세(화면에 보인 내용)와 어긋나는 말을 하지 마라.`;

// ---- 질문 주제 집계 ----
//
// "또신 사용자들이 가장 많이 묻는 질문"을 실제 데이터로 고르기 위해 질문
// 주제만 날짜별로 센다. 질문 원문은 개인 정보가 섞일 수 있어 저장하지 않는다.
const TOPIC_KEYWORDS: [string, string[]][] = [
  ["lotto", ["로또", "번호", "당첨", "복권"]],
  ["business", ["사업", "창업", "가게", "장사", "매출", "동업", "거래처", "계약",
    "새로운 일", "새 일", "벌여"]],
  ["work", ["직장", "회사", "상사", "이직", "승진", "면접", "동료", "업무",
    "퇴사", "취업", "연봉", "일이", "미팅", "회의", "발표",
    "프로젝트", "출근"]],
  ["money", ["돈", "재물", "투자", "주식", "코인", "월급", "지출", "부동산",
    "빚", "대출", "수입", "부업", "목돈", "소비", "결제", "구매",
    "쇼핑"]],
  ["love", ["연애", "사랑", "결혼", "썸", "애인", "남친", "여친", "이별", "재회"]],
  ["people", ["사람", "친구", "가족", "관계", "배우자", "남편", "아내", "부모",
    "지인"]],
  ["health", ["건강", "병원", "아프", "몸", "잠"]],
];

/**
 * 질문을 주제 하나로 분류한다(키워드 기준, 먼저 맞는 주제).
 * @param {string} message 사용자 질문.
 * @return {string} 주제 키(맞는 게 없으면 other).
 */
const topicOf = (message: string): string => {
  for (const [topic, words] of TOPIC_KEYWORDS) {
    if (words.some((word) => message.includes(word))) return topic;
  }
  return "other";
};

/**
 * 질문 주제를 날짜별로 센다. 실패해도 답변에는 영향을 주지 않는다.
 * @param {string} message 사용자 질문.
 * @param {boolean} fromTodayQuestion 오늘의 질문 카드로 들어온 질문인지.
 * @return {!Promise<void>} 기록 완료 시 resolve.
 */
const countTopic = async (
  message: string,
  fromTodayQuestion: boolean,
): Promise<void> => {
  try {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateKey = kst.toISOString().slice(0, 10);
    const inc = admin.firestore.FieldValue.increment(1);
    await admin.firestore().collection("chatTopicStats").doc(dateKey).set({
      total: inc,
      topics: {[topicOf(message)]: inc},
      ...(fromTodayQuestion ? {todayQuestion: inc} : {}),
    }, {merge: true});
  } catch (error) {
    functions.logger.warn("chat topic count failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  const luckyNumbers = todayFortune.luckyNumbers?.join(", ") || "정보 없음";
  const hot = statsSummary.hotNumbers?.join(", ") || "정보 없음";
  const cold = statsSummary.coldNumbers?.join(", ") || "정보 없음";

  return `
    너는 '또신'이다. 3050의 돈·일·사업·사람 고민을 들어주는 다정하고
    노련한 운세 상담가다. 사주를 읽지만, 상담할 땐 사람의 고민이 먼저다.
    항상 공손한 존댓말만 사용하라. 예스러운 말투나 반말은 쓰지 마라.

    [이 사용자의 오늘 운세]
    ${todayLines(todayFortune)}
    - 일간(日主): ${dayMaster}
    - 오행 결핍(가장 적은 원소): ${deficientText}
    - 오늘의 행운번호: ${luckyNumbers}

    [최근 회차 번호 통계(선택 정보, 없으면 무시)]
    - 자주 나온 번호: ${hot}
    - 오래 안 나온 번호: ${cold}
    ${ANSWER_STYLE}

    [규칙]
    ${teaserRule(todayFortune)}
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
 * @param {!TodayFortuneContext} todayFortune 공통 오늘 운세(선택).
 * @param {!StatsSummary} statsSummary 회차 hot/cold 통계(선택).
 * @param {boolean} isFirstReply 대화의 첫 답변인지.
 * @return {string} 모델 systemInstruction 텍스트.
 */
const buildGuestInstruction = (
  todayFortune: TodayFortuneContext,
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
    - 이 사람만의 사주·오행은 지어내거나 추측하지 마라. 아래 오늘의 운세는
      모두에게 같은 공통 운세이니, 그 범위에서 근거로 써라.

    [오늘의 공통 운세]
    ${todayLines(todayFortune)}

    [최근 회차 번호 통계]
    - 자주 나온 번호: ${hot}
    - 오래 안 나온 번호: ${cold}
    ${ANSWER_STYLE}

    [규칙]
    ${teaserRule(todayFortune)}
    - 번호를 물으면 위 회차 통계와 번호 패턴(홀짝·구간·연속번호 등)을
      근거로 답하라.
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
      buildGuestInstruction(todayFortune, statsSummary, history.length === 0);
    const fromTodayQuestion = !!todayFortune.question &&
      clampedMessage === todayFortune.question;

    try {
      // gpt-5.6-luna는 temperature 커스텀 미지원(기본값 1 고정, 다른 값은
      // 400 unsupported_value) — 실제 호출로 확인(2026-07-31). max_completion_tokens는
      // 보이는 응답 외에 내부 reasoning_tokens까지 같은 예산을 공유해서
      // (실측 최대 238) 여유를 두고 잡음. 답변 길이 20% 증가(2026-08-01)에
      // 맞춰 600→700으로 상향.
      const [result] = await Promise.all([openai.chat.completions.create({
        model: OPENAI_MODEL_ID,
        // 답 상한 500자(약 600토큰)에 맞춰 늘렸다(2026-11-15).
        max_completion_tokens: 1100,
        // 2026-10-23: 추론을 끄면 같은 품질에서 응답이 약 40% 빨라진다
        // (실측 평균 4.4초→2.6초, 3회). 이 모델은 "minimal"을 지원하지 않고
        // none/low/medium/high/xhigh만 받는다.
        reasoning_effort: "none",
        messages: [
          {role: "system", content: systemInstruction},
          ...toOpenAiMessages(history),
          {role: "user", content: clampedMessage},
        ],
      }), countTopic(clampedMessage, fromTodayQuestion)]);
      functions.logger.info("chatWithTtoGod token usage", {
        code: "TTOGOD_CHAT_TOKEN_USAGE",
        mode: hasManse ? "saju" : "guest",
        usage: result.usage,
      });
      const reply = clampReply(
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

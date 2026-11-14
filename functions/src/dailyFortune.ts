import {onCall} from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import OpenAI from "openai";

// 이 파일은 기존 index.ts(`fortuneLotto`, 배포된 구버전 앱이 사용 중)와
// 완전히 독립된 신규 함수다. 기존 함수는 절대 수정하지 않는다.
// 배경/제약: docs/ai-ddoshin/README.md, docs/ai-ddoshin/02-backend.md 참고.
//
// 핵심 설계: 만세력은 이미 클라이언트(package:lunar)가 결정론적으로
// 계산해서 넘겨준다. 이 함수는 만세력을 "계산"하지 않고, 그 위에
// (1) 결정론적 점수/번호를 생성하고 (2) OpenAI로 서사(왜 이 번호인지,
// 오늘의 운세 문구)만 붙인다. 점수·번호·날짜/주차 캐시키가 전부 서버
// 시계(KST) 기준이라 클라 시계 조작으로 캐시를 우회할 수 없다.

if (admin.apps.length === 0) {
  admin.initializeApp();
}

let openai: OpenAI | null = null;

// 명시 버전 핀(latest 별칭 금지). 단가: 입력 $0.20 / 출력 $1.20 per M 토큰.
const OPENAI_MODEL_ID = "gpt-5.6-luna";

interface CompletionConfig {
  maxOutputTokens: number;
}

// gpt-5.6-luna는 temperature 커스텀을 지원하지 않는다(기본값 1 고정,
// 다른 값을 넘기면 400 unsupported_value) — 실제 호출로 확인(2026-07-31).
// maxOutputTokens는 "보이는 응답" 외에 내부 reasoning_tokens까지 같은
// 예산을 공유한다(관측된 reasoning_tokens: 데일리 54~293, 여기에 응답
// 텍스트가 더해짐). 예산이 부족하면 JSON이 잘린 채 반환돼 파싱 실패 →
// 폴백 문구로 빠진다. 실측 최대 사용량(데일리 425/주간 542) 대비
// 넉넉한 여유를 두고 값을 정함(2026-07-31, 3회 실측).
// 2026-11-14: 총평(summary)이 추가되며 응답이 길어져 900→1300으로 올림.
const DAILY_GENERATION_CONFIG: CompletionConfig = {
  maxOutputTokens: 1300,
};

// 2026-08-01: 분야별 문구를 20% 더 길고 구체적으로(근거+상황+조언 3문장)
// 바꾸면서 maxOutputTokens도 같이 올렸다 — 글자수 상한만 올리면 모델이
// 굳이 그 길이를 다 안 쓰고 기존 길이로 답하는 경향이 있어서(실측:
// 220자 한도에서도 실제로는 124~153자만 씀), 프롬프트의 문장 수/구성
// 요구를 같이 바꿔야 실제로 길어진다.
// 2026-11-14: 사업운(business)이 추가되며 1700→2100으로 올림.
const WEEKLY_GENERATION_CONFIG: CompletionConfig = {
  maxOutputTokens: 2100,
};

const MAX_TEXT_LENGTH = 120;
// 또신 탭 맨 위 "오늘의 운세" 카드에 2~3문장으로 보여주는 총평.
const SUMMARY_MAX_TEXT_LENGTH = 200;
// 주간 종합운세는 카드 미리보기가 아니라 전용 상세 페이지에 전체
// 노출되므로(TtoGodCategoryDetailPage), 데일리 문구보다 더 길고
// 전문적인 근거 설명을 담을 수 있게 별도로 여유를 둔다.
// 2026-08-01: 프롬프트를 3~4문장+구체적 상황 요구로 강화했더니 실측
// 183~215자로 220자 상한 안에서도 이미 더 길고 구체적인 문구가 나와서,
// 상한 자체는 220으로 되돌렸다(맥락은 위 프롬프트 변경으로 유지됨).
const WEEKLY_MAX_TEXT_LENGTH = 220;

// 클라이언트(lib/domain/entities/fortune_manse.dart)와 동일한 만세력 스키마.
interface ManseSymbol {
  hanja: string;
  korean: string;
  element: string; // wood | fire | earth | metal | water
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
  relations: {topRowTenGods: string[]};
  fiveElements: FiveElements;
}

interface GetDailyFortuneRequest {
  manse: ManseData;
  name?: string;
  // 오늘의 일진(예: "갑자(甲子)"). 앱이 lunar로 계산해 보낸다. 구버전 앱은
  // 보내지 않으므로 없으면 날짜만으로 쓴다.
  today?: {dayPillar?: string};
}

// 분야별 오늘의 기운(1~5). 총점(score)처럼 서버가 결정론으로 정하고,
// 모델은 이 점수에 맞춰 총평을 쓴다.
interface DailyScores {
  money: number;
  work: number;
  people: number;
}

interface DailyFortunePayload {
  date: string; // yyyy-mm-dd (KST 기준)
  score: number;
  oneLine: string;
  summary: string;
  scores: DailyScores;
  luckyNumbers: number[];
  numberRationale: string;
  lucky: {color: string; direction: string; time: string; food: string};
}

interface WeeklyFortunePayload {
  isoWeek: string; // 예: 2026-W31
  money: string;
  // 구버전 앱이 연애 카드를 계속 보여주므로 새 앱에서 빼도 계속 만든다.
  love: string;
  health: string;
  job: string;
  business: string;
}

interface GetDailyFortuneResponse {
  daily: DailyFortunePayload;
  weekly: WeeklyFortunePayload;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * 모델이 준 값이 비어있으면 fallback으로, 길면 최대 길이로 잘라 반환한다.
 * @param {unknown} value 검사할 값.
 * @param {string} fallback 값이 비었을 때 쓸 기본 문자열.
 * @param {number} maxLength 최대 허용 길이(기본값 MAX_TEXT_LENGTH).
 * @return {string} 정규화된 문자열.
 */
const normalizeText = (
  value: unknown,
  fallback: string,
  maxLength: number = MAX_TEXT_LENGTH,
): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim();
};

/**
 * 모델 응답 텍스트를 JSON으로 파싱한다. 코드블록으로 감싸져 오는
 * 경우를 대비해 코드펜스/중괄호 구간을 추출하는 폴백을 포함한다.
 * @param {string} raw 모델이 반환한 원본 텍스트.
 * @return {unknown} 파싱된 JSON 값.
 */
const parseJsonResponse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenced?.[1] ??
      raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    return JSON.parse(candidate);
  }
};

// ---- 결정론 유틸 ----

/**
 * 문자열을 32비트 해시로 변환한다(FNV-1a).
 * @param {string} value 해시할 문자열.
 * @return {number} 0 이상의 32비트 정수 해시값.
 */
const hashStringToUint32 = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/**
 * 시드가 같으면 항상 같은 수열을 내는 결정론적 난수 생성기(xorshift32).
 * @param {number} seed 시드값.
 * @return {function(): number} 0~1 사이 난수를 반환하는 함수.
 */
const makeSeededRandom = (seed: number): (() => number) => {
  let state = seed || 1;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967295;
  };
};

/**
 * 시드 난수로 배열을 결정론적으로 섞는다(Fisher-Yates).
 * @param {!Array<T>} items 섞을 배열.
 * @param {function(): number} rand 0~1 난수 생성 함수.
 * @return {!Array<T>} 섞인 새 배열.
 * @template T
 */
const shuffle = <T, >(items: T[], rand: () => number): T[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

/**
 * 서버 시계 기준 KST 날짜(yyyy-mm-dd)를 반환한다.
 * 클라 시계와 무관 — 캐시키/어뷰즈 방지의 기준점이다.
 * @param {!Date} now 기준 시각.
 * @return {string} yyyy-mm-dd 형식 날짜 문자열.
 */
const getKstDateKey = (now: Date): string => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
};

/**
 * ISO 8601 주차(예: 2026-W31)를 KST 기준으로 반환한다.
 * @param {!Date} now 기준 시각.
 * @return {string} "yyyy-Www" 형식 주차 문자열.
 */
const getIsoWeekKey = (now: Date): string => {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const date = new Date(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()),
  );
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const daysSinceYearStart =
    (date.getTime() - yearStart.getTime()) / 86400000;
  const weekNo = Math.ceil((daysSinceYearStart + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
};

/**
 * 사주 식별 해시를 만든다. 만세력은 결정론이라 같은 사주는
 * 항상 같은 값이 나온다(캐시 키/PRNG 시드로 쓰인다).
 * @param {!ManseData} manse 만세력 데이터.
 * @return {string} 36진수로 인코딩된 해시 문자열.
 */
const buildSajuHash = (manse: ManseData): string => {
  const signature = JSON.stringify({
    dayMaster: manse.profile.dayMaster,
    year: manse.pillars.year.labelHanja,
    month: manse.pillars.month.labelHanja,
    day: manse.pillars.day.labelHanja,
    hour: manse.pillars.hour.labelHanja,
  });
  return hashStringToUint32(signature).toString(36);
};

/**
 * 오행 중 개수가 가장 적은(결핍) 원소들을 찾는다.
 * @param {!FiveElements} fiveElements 오행 개수.
 * @return {!Array<string>} 결핍 원소 키 목록(wood/fire/earth/metal/water).
 */
const deficientElements = (fiveElements: FiveElements): string[] => {
  const entries = Object.entries(fiveElements) as [string, number][];
  const min = Math.min(...entries.map(([, count]) => count));
  return entries
    .filter(([, count]) => count === min)
    .map(([element]) => element);
};

// 하도수(河圖數): 끝자리 숫자 ↔ 오행의 전통적 대응 관계.
// 1·6=水, 2·7=火, 3·8=木, 4·9=金, 5·0=土.
const HETU_ELEMENT_BY_LAST_DIGIT: Record<number, string> = {
  1: "water", 6: "water",
  2: "fire", 7: "fire",
  3: "wood", 8: "wood",
  4: "metal", 9: "metal",
  5: "earth", 0: "earth",
};

/**
 * 주어진 오행 원소들에 해당하는 1~45 번호를 하도수 기준으로 뽑는다.
 * @param {!Array<string>} elements 대상 오행 키 목록.
 * @return {!Array<number>} 해당 원소의 번호 목록.
 */
const numbersForElements = (elements: string[]): number[] => {
  const numbers: number[] = [];
  for (let n = 1; n <= 45; n += 1) {
    if (elements.includes(HETU_ELEMENT_BY_LAST_DIGIT[n % 10])) {
      numbers.push(n);
    }
  }
  return numbers;
};

/**
 * 오행 결핍 원소 + (사주해시+날짜) 시드로 매일 다른 6개 번호를
 * 결정론적으로 생성한다.
 * @param {!ManseData} manse 만세력 데이터.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} dateKey KST 기준 날짜 캐시키.
 * @return {!Array<number>} 오름차순 정렬된 6개 로또 번호.
 */
const generateLottoNumbers = (
  manse: ManseData,
  sajuHash: string,
  dateKey: string,
): number[] => {
  const seed = hashStringToUint32(`numbers:${sajuHash}:${dateKey}`);
  const rand = makeSeededRandom(seed);
  const deficient = deficientElements(manse.fiveElements);
  const preferredPool = shuffle(numbersForElements(deficient), rand);

  const picked = new Set<number>();
  for (const n of preferredPool) {
    if (picked.size >= 4) break; // 결핍 오행 비중은 최대 4개까지만
    picked.add(n);
  }
  while (picked.size < 6) {
    picked.add(Math.floor(rand() * 45) + 1);
  }
  return Array.from(picked).sort((a, b) => a - b);
};

/**
 * 60~95 범위로 스케일한 오늘의 기운 점수를 만든다.
 * 운세앱 관례상 지나치게 낮은 점수는 피한다.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} dateKey KST 기준 날짜 캐시키.
 * @return {number} 60~95 사이의 정수 점수.
 */
const generateScore = (sajuHash: string, dateKey: string): number => {
  const seed = hashStringToUint32(`score:${sajuHash}:${dateKey}`);
  const rand = makeSeededRandom(seed);
  return Math.round(60 + rand() * 35);
};

/**
 * 재물·직장·사람 분야별 오늘의 기운(2~5)을 결정론적으로 만든다.
 * 총점과 같은 이유로 1점은 쓰지 않는다.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} dateKey KST 기준 날짜 캐시키.
 * @return {!DailyScores} 분야별 점수.
 */
const generateDailyScores = (
  sajuHash: string,
  dateKey: string,
): DailyScores => {
  const rand = makeSeededRandom(
    hashStringToUint32(`scores:${sajuHash}:${dateKey}`),
  );
  const pick = (): number => 2 + Math.floor(rand() * 4);
  return {money: pick(), work: pick(), people: pick()};
};

/**
 * 앱이 보낸 일진 문자열을 프롬프트에 넣어도 되는 형태로 걸러낸다.
 * @param {unknown} value 요청의 today.dayPillar 값.
 * @return {string} 정상이면 그 값, 아니면 빈 문자열.
 */
const sanitizeDayPillar = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > 0 && text.length <= 12 ? text : "";
};

// ---- Firestore 캐시 ----

const db = (): admin.firestore.Firestore => admin.firestore();

const dailyDocId = (sajuHash: string, dateKey: string): string =>
  `${sajuHash}_${dateKey}`;
const weeklyDocId = (sajuHash: string, isoWeek: string): string =>
  `${sajuHash}_${isoWeek}`;

/**
 * 캐시된 일간 운세를 조회한다.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} dateKey KST 기준 날짜 캐시키.
 * @return {!Promise<?DailyFortunePayload>} 캐시가 있으면 그 값, 없으면 null.
 */
const getCachedDaily = async (
  sajuHash: string,
  dateKey: string,
): Promise<DailyFortunePayload | null> => {
  const ref = db().collection("dailyFortune").doc(
    dailyDocId(sajuHash, dateKey),
  );
  const snapshot = await ref.get();
  return snapshot.exists ? (snapshot.data() as DailyFortunePayload) : null;
};

/**
 * 일간 운세를 캐시에 저장한다.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} dateKey KST 기준 날짜 캐시키.
 * @param {!DailyFortunePayload} payload 저장할 값.
 * @return {!Promise<void>} 저장 완료 시 resolve.
 */
const setCachedDaily = async (
  sajuHash: string,
  dateKey: string,
  payload: DailyFortunePayload,
): Promise<void> => {
  const ref = db().collection("dailyFortune").doc(
    dailyDocId(sajuHash, dateKey),
  );
  await ref.set(payload);
};

/**
 * 캐시된 주간 종합운세를 조회한다.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} isoWeek ISO 8601 주차 캐시키.
 * @return {!Promise<?WeeklyFortunePayload>} 캐시가 있으면 그 값, 없으면 null.
 */
const getCachedWeekly = async (
  sajuHash: string,
  isoWeek: string,
): Promise<WeeklyFortunePayload | null> => {
  const ref = db().collection("weeklyFortune").doc(
    weeklyDocId(sajuHash, isoWeek),
  );
  const snapshot = await ref.get();
  return snapshot.exists ? (snapshot.data() as WeeklyFortunePayload) : null;
};

/**
 * 주간 종합운세를 캐시에 저장한다.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} isoWeek ISO 8601 주차 캐시키.
 * @param {!WeeklyFortunePayload} payload 저장할 값.
 * @return {!Promise<void>} 저장 완료 시 resolve.
 */
const setCachedWeekly = async (
  sajuHash: string,
  isoWeek: string,
  payload: WeeklyFortunePayload,
): Promise<void> => {
  const ref = db().collection("weeklyFortune").doc(
    weeklyDocId(sajuHash, isoWeek),
  );
  await ref.set(payload);
};

// ---- 모델 프롬프트 ----

const DEFAULT_ONE_LINE = "오늘은 차분히 흐름을 지켜보기 좋은 날입니다.";
const DEFAULT_SUMMARY =
  "오늘은 큰 변화보다 지금 하던 일을 차분히 이어가기 좋은 날입니다. " +
  "급하게 결정하기보다 한 번 더 살펴보시면 흐름이 편안해집니다.";
const DEFAULT_NUMBER_RATIONALE =
  "사주의 기운 흐름을 참고해 골라드린 번호입니다.";
const DEFAULT_LUCKY = {
  color: "하양", direction: "동쪽", time: "오전 9시", food: "된장국",
};
const DEFAULT_WEEKLY: Omit<WeeklyFortunePayload, "isoWeek"> = {
  money: "이번 주는 오행의 흐름이 크게 치우치지 않아 재물운이 " +
    "무난하게 흘러갑니다. 큰 지출보다는 계획적인 소비를 " +
    "유지하시면 안정적으로 한 주를 보내실 수 있습니다.",
  love: "이번 주 관계운은 평온한 흐름입니다. 십신 배치상 " +
    "무리하게 관계를 서두르기보다 자연스러운 흐름에 " +
    "맡기시는 편이 좋은 결과로 이어집니다.",
  health: "이번 주는 컨디션 기복이 있을 수 있는 시기입니다. " +
    "무리한 일정보다는 충분한 휴식과 규칙적인 생활 리듬을 " +
    "유지하시면 한 주를 가볍게 보내실 수 있습니다.",
  job: "이번 주 직업운은 꾸준함이 결과를 좌우하는 흐름입니다. " +
    "맡은 일을 차근차근 처리하시면 성과로 이어지는 시기입니다.",
  business: "이번 주 사업운은 새로 벌이기보다 지금 하는 일을 다지기 " +
    "좋은 흐름입니다. 거래나 계약은 조건을 한 번 더 확인하시면 " +
    "안정적으로 이어집니다.",
};

const ELEMENT_KOREAN: Record<string, string> = {
  wood: "목", fire: "화", earth: "토", metal: "금", water: "수",
};

/**
 * 데일리 운세 프롬프트(오늘의 한줄운세/총평/번호서사/행운아이템)를 만든다.
 * @param {!ManseData} manse 만세력 데이터.
 * @param {!Array<number>} luckyNumbers 서버가 이미 확정한 오늘의 번호.
 * @param {!Array<string>} deficient 오행 결핍 원소 목록.
 * @param {string} dateKey KST 기준 오늘 날짜.
 * @param {string} dayPillar 오늘의 일진(없으면 빈 문자열).
 * @param {!DailyScores} scores 서버가 확정한 분야별 점수.
 * @return {{systemPrompt: string, userPrompt: string}} 프롬프트 쌍.
 */
const buildDailyPrompts = (
  manse: ManseData,
  luckyNumbers: number[],
  deficient: string[],
  dateKey: string,
  dayPillar: string,
  scores: DailyScores,
): {systemPrompt: string; userPrompt: string} => {
  const deficientText = deficient
    .map((e) => ELEMENT_KOREAN[e] ?? e)
    .join(", ");
  const dayPillarText = dayPillar || "정보 없음";

  const systemPrompt = `
    너는 '또신', 로또의 신이다.
    항상 공손한 존댓말만 사용하라. 예스러운 말투나 반말은 쓰지 마라.
    [규칙]
    - 반드시 입력된 만세력의 일간·오행불균형·십신을 근거로
      구체적으로 말하라. 일반론 금지.
    - 오늘의 일진이 주어지면, 그 일진과 사용자 일간의 관계(생·극·합·충,
      십신)를 근거로 "오늘"의 흐름을 말하라. 어제·내일과 같은 말이 되지
      않게 오늘에 맞춰 쓴다.
    - oneLine은 오늘 하루의 운세 자체(일·돈·사람)로 쓰고, 로또·번호·
      당첨은 언급하지 마라. 번호 이야기는 numberRationale에만 쓴다.
    - summary는 오늘의 총평 2~3문장이다. 주어진 분야별 점수
      (재물·직장·사람, 5점 만점)와 어긋나지 않게, 높은 분야는 살리고 낮은
      분야는 조심할 점과 대처를 말하라. 로또·번호·당첨은 언급하지 마라.
    - lottoNumbers는 서버가 이미 확정했다. 그 번호를 바꾸지 말고,
      numberRationale에서 왜 이 번호인지 사주 근거로 설명하라.
    - 오늘의 행운 아이템(색·방향·시간대·음식)을 각각 하나씩,
      구체적으로 제시하라.
    - 건강·죽음·투자수익을 단정하지 마라. 공손체로 완곡히 표현하라.
    - 출력은 JSON 객체만 허용한다(설명/코드블록 금지).
    [출력 키] oneLine(문자열,${MAX_TEXT_LENGTH}자 이내),
    summary(문자열,${SUMMARY_MAX_TEXT_LENGTH}자 이내),
    numberRationale(문자열,${MAX_TEXT_LENGTH}자 이내),
    lucky{color,direction,time,food}(각각 짧은 문자열)`;

  const userPrompt = `
    오늘 날짜(KST): ${dateKey}
    오늘의 일진: ${dayPillarText}
    분야별 점수(5점 만점): 재물 ${scores.money}, 직장 ${scores.work}, 사람 ${scores.people}
    만세력: ${JSON.stringify(manse)}
    오늘 확정된 행운번호: ${luckyNumbers.join(", ")}
    오행 결핍(가장 적은 원소): ${deficientText}

    반드시 JSON 객체만 반환하라.`;

  return {systemPrompt, userPrompt};
};

/**
 * 주간 종합운세 프롬프트(재물/연애/건강/직업/사업)를 만든다.
 * @param {!ManseData} manse 만세력 데이터.
 * @return {{systemPrompt: string, userPrompt: string}} 프롬프트 쌍.
 */
const buildWeeklyPrompts = (
  manse: ManseData,
): {systemPrompt: string; userPrompt: string} => {
  const systemPrompt = `
    너는 '또신', 20년 경력의 명리학(사주) 전문 상담사다.
    말투는 공손체(존댓말)로 흔들리지 마라.
    [규칙]
    - 이번 주 재물운·연애운·건강운·직업운·사업운을 각각 3~4문장으로,
      더 구체적이고 그럴듯하게 전문가답게 서술하라.
    - 각 분야마다 반드시 세 부분을 모두 포함하라: (1) 근거 문장 —
      입력된 만세력의 일간·오행·십신 중 구체적 요소를 최소 1개
      이상 명시적으로 언급하며 왜 그런 흐름인지 설명 (2) 구체적 상황
      문장 — 이번 주 실제로 있을 법한 구체적인 상황이나 장면을 하나
      제시하라(예: 재물운이면 특정 지출/수입 계기, 연애운이면 만남/
      갈등 장면, 건강운이면 컨디션이 흔들리는 시점, 직업운이면 업무
      상황, 사업운이면 매출·거래처·계약 상황) (3) 실전 조언 문장 — 이번 주 무엇을 하면 좋을지 구체적인
      행동 조언.
    - "무난합니다", "평온합니다" 같은 뭉뚱그린 위로형 문장만으로
      끝내지 마라. 반드시 사주 근거·구체적 상황·조언이 함께 있어야 한다.
    - 일반론 금지. 명리학 전문 용어(오행, 십신, 일간 등)를 자연스럽게
      섞어 전문성을 드러내되, 일반인도 이해할 수 있게 쉽게 풀어 설명하라.
    - 건강·투자수익을 단정하지 마라. 공손체로 완곡히 표현하라.
    - 출력은 JSON 객체만 허용한다(설명/코드블록 금지).
    [출력 키] money, love, health, job, business
    (각각 문자열, ${WEEKLY_MAX_TEXT_LENGTH}자 이내)`;

  const userPrompt = `
    만세력: ${JSON.stringify(manse)}

    반드시 JSON 객체만 반환하라.`;

  return {systemPrompt, userPrompt};
};

// ---- 생성 로직 (캐시 미스일 때만 호출) ----

interface JsonCompletionResult {
  text: string;
  usage: OpenAI.CompletionUsage | undefined;
}

/**
 * OpenAI Chat Completions를 JSON 객체 응답 모드로 호출한다.
 * @param {!OpenAI} client OpenAI 클라이언트.
 * @param {!CompletionConfig} config maxOutputTokens 설정.
 * @param {string} systemPrompt system 역할 프롬프트.
 * @param {string} userPrompt user 역할 프롬프트.
 * @return {!Promise<!JsonCompletionResult>} 응답 텍스트와 토큰 사용량.
 */
const generateJson = async (
  client: OpenAI,
  config: CompletionConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<JsonCompletionResult> => {
  const result = await client.chat.completions.create({
    model: OPENAI_MODEL_ID,
    max_completion_tokens: config.maxOutputTokens,
    response_format: {type: "json_object"},
    messages: [
      {role: "system", content: systemPrompt},
      {role: "user", content: userPrompt},
    ],
  });
  return {
    text: result.choices[0]?.message?.content ?? "",
    usage: result.usage,
  };
};

interface DailyPayloadResult {
  payload: DailyFortunePayload;
  // 모델 호출이 실패해 기본 문구로 대체된 경우 true. true면 캐시에
  // 쓰지 않는다 — 실패 결과를 성공인 것처럼 캐시하면, 모델 문제가
  // 고쳐진 뒤에도 캐시 만료 전까지 계속 기본 문구만 나가게 된다
  // (2026-07-28에 실제로 겪은 문제: 모델 호출이 404로 막혔을 때 생긴
  // 기본 문구가 그대로 캐시돼 문제 해결 후에도 안 바뀜).
  isFallback: boolean;
}

interface WeeklyPayloadResult {
  payload: WeeklyFortunePayload;
  isFallback: boolean;
}

/**
 * 일간 운세 페이로드를 생성한다. 번호/점수는 결정론으로 먼저 정하고,
 * OpenAI는 그 위에 서사(문구)만 붙인다. 호출 실패 시 서사만
 * 기본 문구로 대체하고 번호/점수는 그대로 유지한다.
 * @param {!OpenAI} client OpenAI 클라이언트.
 * @param {!ManseData} manse 만세력 데이터.
 * @param {string} dateKey KST 기준 날짜 캐시키.
 * @param {string} dayPillar 오늘의 일진(없으면 빈 문자열).
 * @return {!Promise<!DailyPayloadResult>} 생성된 일간 운세 + 폴백 여부.
 */
const createDailyPayload = async (
  client: OpenAI,
  manse: ManseData,
  dateKey: string,
  dayPillar: string,
): Promise<DailyPayloadResult> => {
  const sajuHash = buildSajuHash(manse);
  const score = generateScore(sajuHash, dateKey);
  const scores = generateDailyScores(sajuHash, dateKey);
  const luckyNumbers = generateLottoNumbers(manse, sajuHash, dateKey);
  const deficient = deficientElements(manse.fiveElements);

  try {
    const {systemPrompt, userPrompt} = buildDailyPrompts(
      manse, luckyNumbers, deficient, dateKey, dayPillar, scores,
    );
    const {text, usage} = await generateJson(
      client, DAILY_GENERATION_CONFIG, systemPrompt, userPrompt,
    );
    functions.logger.info("getDailyFortune daily token usage", {
      code: "DAILY_FORTUNE_TOKEN_USAGE",
      usage,
    });
    const parsed = parseJsonResponse(text.trim());
    const data = isRecord(parsed) ? parsed : {};
    const luckyRaw = isRecord(data.lucky) ? data.lucky : {};

    return {
      isFallback: false,
      payload: {
        date: dateKey,
        score,
        luckyNumbers,
        oneLine: normalizeText(data.oneLine, DEFAULT_ONE_LINE),
        summary: normalizeText(
          data.summary, DEFAULT_SUMMARY, SUMMARY_MAX_TEXT_LENGTH,
        ),
        scores,
        numberRationale: normalizeText(
          data.numberRationale, DEFAULT_NUMBER_RATIONALE,
        ),
        lucky: {
          color: normalizeText(luckyRaw.color, DEFAULT_LUCKY.color),
          direction: normalizeText(
            luckyRaw.direction, DEFAULT_LUCKY.direction,
          ),
          time: normalizeText(luckyRaw.time, DEFAULT_LUCKY.time),
          food: normalizeText(luckyRaw.food, DEFAULT_LUCKY.food),
        },
      },
    };
  } catch (error) {
    functions.logger.warn("getDailyFortune daily text fallback", {
      code: "DAILY_FORTUNE_TEXT_FALLBACK",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      isFallback: true,
      payload: {
        date: dateKey,
        score,
        luckyNumbers,
        oneLine: DEFAULT_ONE_LINE,
        summary: DEFAULT_SUMMARY,
        scores,
        numberRationale: DEFAULT_NUMBER_RATIONALE,
        lucky: DEFAULT_LUCKY,
      },
    };
  }
};

/**
 * 주간 종합운세 페이로드를 생성한다. 호출 실패 시 기본 문구로 대체한다.
 * @param {!OpenAI} client OpenAI 클라이언트.
 * @param {!ManseData} manse 만세력 데이터.
 * @param {string} isoWeek ISO 8601 주차 캐시키.
 * @return {!Promise<!WeeklyPayloadResult>} 생성된 주간 종합운세 + 폴백 여부.
 */
const createWeeklyPayload = async (
  client: OpenAI,
  manse: ManseData,
  isoWeek: string,
): Promise<WeeklyPayloadResult> => {
  try {
    const {systemPrompt, userPrompt} = buildWeeklyPrompts(manse);
    const {text, usage} = await generateJson(
      client, WEEKLY_GENERATION_CONFIG, systemPrompt, userPrompt,
    );
    functions.logger.info("getDailyFortune weekly token usage", {
      code: "WEEKLY_FORTUNE_TOKEN_USAGE",
      usage,
    });
    const parsed = parseJsonResponse(text.trim());
    const data = isRecord(parsed) ? parsed : {};

    return {
      isFallback: false,
      payload: {
        isoWeek,
        money: normalizeText(
          data.money, DEFAULT_WEEKLY.money, WEEKLY_MAX_TEXT_LENGTH,
        ),
        love: normalizeText(
          data.love, DEFAULT_WEEKLY.love, WEEKLY_MAX_TEXT_LENGTH,
        ),
        health: normalizeText(
          data.health, DEFAULT_WEEKLY.health, WEEKLY_MAX_TEXT_LENGTH,
        ),
        job: normalizeText(
          data.job, DEFAULT_WEEKLY.job, WEEKLY_MAX_TEXT_LENGTH,
        ),
        business: normalizeText(
          data.business, DEFAULT_WEEKLY.business, WEEKLY_MAX_TEXT_LENGTH,
        ),
      },
    };
  } catch (error) {
    functions.logger.warn("getDailyFortune weekly text fallback", {
      code: "WEEKLY_FORTUNE_TEXT_FALLBACK",
      error: error instanceof Error ? error.message : String(error),
    });
    return {isFallback: true, payload: {isoWeek, ...DEFAULT_WEEKLY}};
  }
};

/**
 * 캐시를 먼저 확인하고, 없으면 생성해서 저장 후 반환한다(일간).
 * @param {!OpenAI} client OpenAI 클라이언트.
 * @param {!ManseData} manse 만세력 데이터.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} dateKey KST 기준 날짜 캐시키.
 * @param {string} dayPillar 오늘의 일진(없으면 빈 문자열).
 * @return {!Promise<!DailyFortunePayload>} 캐시 또는 새로 생성된 값.
 */
const getOrCreateDaily = async (
  client: OpenAI,
  manse: ManseData,
  sajuHash: string,
  dateKey: string,
  dayPillar: string,
): Promise<DailyFortunePayload> => {
  const cached = await getCachedDaily(sajuHash, dateKey);
  // 총평(summary)이 생기기 전에 저장된 캐시는 다시 만든다(그날 한 번).
  if (cached?.summary) return cached;

  const {payload, isFallback} = await createDailyPayload(
    client, manse, dateKey, dayPillar,
  );
  if (!isFallback) {
    await setCachedDaily(sajuHash, dateKey, payload);
  }
  return payload;
};

/**
 * 캐시를 먼저 확인하고, 없으면 생성해서 저장 후 반환한다(주간).
 * @param {!OpenAI} client OpenAI 클라이언트.
 * @param {!ManseData} manse 만세력 데이터.
 * @param {string} sajuHash 사주 식별 해시.
 * @param {string} isoWeek ISO 8601 주차 캐시키.
 * @return {!Promise<!WeeklyFortunePayload>} 캐시 또는 새로 생성된 값.
 */
const getOrCreateWeekly = async (
  client: OpenAI,
  manse: ManseData,
  sajuHash: string,
  isoWeek: string,
): Promise<WeeklyFortunePayload> => {
  const cached = await getCachedWeekly(sajuHash, isoWeek);
  // 사업운(business)이 생기기 전에 저장된 캐시는 다시 만든다(그 주 한 번).
  if (cached?.business) return cached;

  const {payload, isFallback} = await createWeeklyPayload(
    client, manse, isoWeek,
  );
  if (!isFallback) {
    await setCachedWeekly(sajuHash, isoWeek, payload);
  }
  return payload;
};

/**
 * 요청으로 들어온 값이 최소한의 만세력 형태를 갖췄는지 검사한다.
 * @param {unknown} value 검사할 값.
 * @return {boolean} 만세력처럼 보이면 true.
 */
const isManseLike = (value: unknown): value is ManseData => {
  if (!isRecord(value)) return false;
  return isRecord(value.profile) &&
    isRecord(value.pillars) &&
    isRecord(value.fiveElements);
};

export const getDailyFortune = onCall(
  {region: "asia-northeast3"},
  async (request): Promise<GetDailyFortuneResponse> => {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      throw new functions.https.HttpsError(
        "internal", "OPENAI_API_KEY is not set.",
      );
    }
    if (!openai) {
      openai = new OpenAI({apiKey: OPENAI_API_KEY});
    }

    const {manse, today} = request.data as GetDailyFortuneRequest;
    if (!isManseLike(manse)) {
      throw new functions.https.HttpsError(
        "invalid-argument", "manse가 필요합니다.",
      );
    }

    const now = new Date();
    const dateKey = getKstDateKey(now);
    const isoWeek = getIsoWeekKey(now);
    const sajuHash = buildSajuHash(manse);
    const dayPillar = sanitizeDayPillar(
      isRecord(today) ? today.dayPillar : undefined,
    );

    const [daily, weekly] = await Promise.all([
      getOrCreateDaily(openai, manse, sajuHash, dateKey, dayPillar),
      getOrCreateWeekly(openai, manse, sajuHash, isoWeek),
    ]);

    return {daily, weekly};
  },
);

// ---- 띠별 오늘의 운세 (사주 미등록자용) ----
//
// 사주를 등록하지 않은 사람에게도 또신 탭에서 볼 거리를 주기 위해, 12띠의
// 오늘 한 줄 운세를 날짜당 한 번만 만들어 모든 사용자가 공유한다(캐시).
// 개인 정보가 들어가지 않는다.

const ZODIAC_KEYS = [
  "rat", "ox", "tiger", "rabbit", "dragon", "snake",
  "horse", "goat", "monkey", "rooster", "dog", "pig",
] as const;
type ZodiacKey = typeof ZODIAC_KEYS[number];

const ZODIAC_MAX_TEXT_LENGTH = 70;
const ZODIAC_GENERATION_CONFIG: CompletionConfig = {maxOutputTokens: 1600};
const DEFAULT_ZODIAC_LINE =
  "무리하지 않고 하던 일을 차분히 이어가면 편안한 하루입니다.";

interface ZodiacFortunePayload {
  date: string;
  dayPillar: string;
  lines: Record<ZodiacKey, string>;
}

/**
 * 띠별 오늘의 운세 프롬프트를 만든다.
 * @param {string} dateKey KST 기준 오늘 날짜.
 * @param {string} dayPillar 오늘의 일진(없으면 빈 문자열).
 * @return {{systemPrompt: string, userPrompt: string}} 프롬프트 쌍.
 */
const buildZodiacPrompts = (
  dateKey: string,
  dayPillar: string,
): {systemPrompt: string; userPrompt: string} => {
  const systemPrompt = `
    너는 '또신', 운세를 봐주는 신이다.
    항상 공손한 존댓말만 사용하라. 예스러운 말투나 반말은 쓰지 마라.
    [규칙]
    - 12띠 각각의 오늘 하루 운세를 한 문장으로 써라.
    - 오늘의 일진이 주어지면 그 일진의 지지와 각 띠(지지)의 관계(합·충·형 등)를
      근거로 띠마다 다르게 써라. 서로 비슷한 문장을 반복하지 마라.
    - 일·돈·사람 관계 중심으로, 오늘 무엇을 하면 좋을지 구체적으로 써라.
    - 로또·번호·당첨은 언급하지 마라.
    - 건강·죽음·투자수익을 단정하지 마라. 완곡하게 표현하라.
    - 출력은 JSON 객체만 허용한다(설명/코드블록 금지).
    [출력 키] ${ZODIAC_KEYS.join(", ")}
    (각각 문자열, ${ZODIAC_MAX_TEXT_LENGTH}자 이내.
    rat=쥐, ox=소, tiger=호랑이, rabbit=토끼, dragon=용, snake=뱀,
    horse=말, goat=양, monkey=원숭이, rooster=닭, dog=개, pig=돼지)`;

  const userPrompt = `
    오늘 날짜(KST): ${dateKey}
    오늘의 일진: ${dayPillar || "정보 없음"}

    반드시 JSON 객체만 반환하라.`;

  return {systemPrompt, userPrompt};
};

/**
 * 띠별 오늘의 운세를 생성한다. 실패 시 기본 문구로 채우고 캐시하지 않는다.
 * @param {!OpenAI} client OpenAI 클라이언트.
 * @param {string} dateKey KST 기준 오늘 날짜.
 * @param {string} dayPillar 오늘의 일진(없으면 빈 문자열).
 * @return {!Promise<{payload: !ZodiacFortunePayload, isFallback: boolean}>}
 *     생성된 띠별 운세와 폴백 여부.
 */
const createZodiacPayload = async (
  client: OpenAI,
  dateKey: string,
  dayPillar: string,
): Promise<{payload: ZodiacFortunePayload; isFallback: boolean}> => {
  const fallbackLines = Object.fromEntries(
    ZODIAC_KEYS.map((key) => [key, DEFAULT_ZODIAC_LINE]),
  ) as Record<ZodiacKey, string>;

  try {
    const {systemPrompt, userPrompt} = buildZodiacPrompts(dateKey, dayPillar);
    const {text, usage} = await generateJson(
      client, ZODIAC_GENERATION_CONFIG, systemPrompt, userPrompt,
    );
    functions.logger.info("getZodiacFortune token usage", {
      code: "ZODIAC_FORTUNE_TOKEN_USAGE",
      usage,
    });
    const parsed = parseJsonResponse(text.trim());
    const data = isRecord(parsed) ? parsed : {};
    const lines = Object.fromEntries(
      ZODIAC_KEYS.map((key) => [
        key,
        normalizeText(data[key], DEFAULT_ZODIAC_LINE, ZODIAC_MAX_TEXT_LENGTH),
      ]),
    ) as Record<ZodiacKey, string>;
    return {isFallback: false, payload: {date: dateKey, dayPillar, lines}};
  } catch (error) {
    functions.logger.warn("getZodiacFortune text fallback", {
      code: "ZODIAC_FORTUNE_TEXT_FALLBACK",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      isFallback: true,
      payload: {date: dateKey, dayPillar, lines: fallbackLines},
    };
  }
};

export const getZodiacFortune = onCall(
  {region: "asia-northeast3"},
  async (request): Promise<ZodiacFortunePayload> => {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      throw new functions.https.HttpsError(
        "internal", "OPENAI_API_KEY is not set.",
      );
    }
    if (!openai) {
      openai = new OpenAI({apiKey: OPENAI_API_KEY});
    }

    const dateKey = getKstDateKey(new Date());
    const ref = db().collection("zodiacFortune").doc(dateKey);
    const snapshot = await ref.get();
    if (snapshot.exists) return snapshot.data() as ZodiacFortunePayload;

    const data = request.data as {dayPillar?: unknown} | undefined;
    const dayPillar = sanitizeDayPillar(data?.dayPillar);
    const {payload, isFallback} = await createZodiacPayload(
      openai, dateKey, dayPillar,
    );
    if (!isFallback) {
      await ref.set(payload);
    }
    return payload;
  },
);

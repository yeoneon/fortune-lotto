import {onCall} from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import {GoogleGenerativeAI, GenerationConfig} from "@google/generative-ai";

let genAI: GoogleGenerativeAI | null = null;
const DEFAULT_TOTAL_FORTUNE_FALLBACK_TEXT =
  "수기운이 강한 계해일주에게 이번 주는 화기운의 조화가 필요한 시기입니다. " +
  "주변의 도움보다는 자신의 주관을 뚜렷하게 세워야 할 때입니다. " +
  "일상에서는 급한 마음을 내려놓고 차분하게 계획을 점검하면 뜻밖의 성취를 " +
  "맛볼 수 있는 한 주가 될 것입니다.";
const DEFAULT_MONEY_FORTUNE_FALLBACK_TEXT =
  "재물운은 흐름이 원활하나 지출 관리에 유의해야 합니다. " +
  "편재의 기운이 들어와 있으니 투기보다는 안정적인 자산 관리에 집중하세요. " +
  "충동적인 소비를 줄이고 계획적인 지출을 실천한다면 금전적인 여유가 " +
  "점차 안정적으로 자리 잡을 것입니다.";
const DEFAULT_LOTTO_FALLBACK_NUMBERS = [4, 12, 19, 27, 33, 41];
const UNKNOWN_VALUE = "unknown";
const DEFAULT_BIRTH_TIME_TEXT = "00:00";
const ABSENT_GUIDE_TEXT = "없음";
const DEFAULT_STATE_VALUE = "건록";
const DEFAULT_TEN_GOD_VALUE = "비견";
const DEFAULT_BIRTH_DATE_TEXT = "1900-01-01";
const DEFAULT_GENDER_TEXT = "미상";
const MAX_FORTUNE_TEXT_LENGTH = 150;
const GEMINI_GENERATION_CONFIG: GenerationConfig = {
  temperature: 0.2,
  maxOutputTokens: 1500,
  responseMimeType: "application/json",
};

interface FortuneLottoRequest {
  birthDate: string;
  birthTime?: string | null;
  isTimeKnown: boolean;
  gender: string;
  isSolar: boolean;
  desiredFortune?: {
    totalHint?: string;
    moneyHint?: string;
    keywords?: string[];
    avoidKeywords?: string[];
  };
  desiredManse?: {
    dayMaster?: string;
    preferredPillarsOrder?: "year-month-day-hour" | "hour-day-month-year";
    forceUnknownHourWhenTimeMissing?: boolean;
  };
}

type CalendarType = "solar" | "lunar";

interface StemInfo {
  hanja: string;
  korean: string;
  element: string;
  yinYang: string;
}

interface BranchInfo {
  hanja: string;
  korean: string;
  element: string;
  yinYang: string;
}

interface DetailedPillar {
  heavenlyStem: StemInfo;
  heavenlyStemTenGod: string;
  earthlyBranch: BranchInfo;
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

interface ManseProfile {
  dayMaster: string;
  dayMasterElement: string;
  displayName: string;
  birthSummary: string;
}

interface ManseRelations {
  topRowTenGods: string[];
  bottomRowStates: string[];
}

interface ManseData {
  calendarType: CalendarType;
  profile: ManseProfile;
  pillars: {
    year: DetailedPillar;
    month: DetailedPillar;
    day: DetailedPillar;
    hour: DetailedPillar;
  };
  relations: ManseRelations;
  fiveElements: FiveElements;
}

interface ManseNormalizationResult {
  manse: ManseData;
  correctionCounts: Record<string, number>;
}

interface UnknownScanResult {
  count: number;
  paths: string[];
}

interface FortuneLottoResponse {
  totalFortuneText: string;
  moneyFortuneText: string;
  lottoNumbers: number[];
  manse: ManseData;
}

interface ManseGenerationResult {
  manse: ManseData;
  correctionCounts: Record<string, number>;
  unknownBeforeRepairPaths: string[];
  unknownAfterRepairPaths: string[];
  hasManse: boolean;
}

interface FortuneGenerationResult {
  totalFortuneText: string;
  moneyFortuneText: string;
  lottoNumbers: number[];
  correctionCounts: Record<string, number>;
}

interface MansePromptInput {
  birthDate: string;
  birthTimeText: string;
  gender: string;
  isSolar: boolean;
  isTimeKnown: boolean;
  desiredDayMaster: string;
  preferredPillarsOrder: "year-month-day-hour" | "hour-day-month-year";
  legacyForceUnknownHourWhenTimeMissing?: boolean;
}

interface FortunePromptInput {
  manse: ManseData;
  desiredTotalHint: string;
  desiredMoneyHint: string;
  desiredKeywordsText: string;
  avoidKeywordsText: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ?
    value.trim() :
    undefined;

const normalizeStringArray = (
  value: unknown,
  expectedLength: number,
): string[] | undefined => {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    return undefined;
  }

  const normalized = value.map(
    (item: unknown) => normalizeString(item) ?? UNKNOWN_VALUE
  );
  return normalized.length === expectedLength ? normalized : undefined;
};

const normalizeFiveElementCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ?
    value :
    undefined;

const normalizeFiveElements = (value: unknown): FiveElements | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const wood = normalizeFiveElementCount(value.wood);
  const fire = normalizeFiveElementCount(value.fire);
  const earth = normalizeFiveElementCount(value.earth);
  const metal = normalizeFiveElementCount(value.metal);
  const water = normalizeFiveElementCount(value.water);

  if (wood === undefined || fire === undefined || earth === undefined ||
    metal === undefined || water === undefined) {
    return undefined;
  }

  return {wood, fire, earth, metal, water};
};

const makeUnknownStemInfo = (): StemInfo => ({
  hanja: UNKNOWN_VALUE,
  korean: UNKNOWN_VALUE,
  element: UNKNOWN_VALUE,
  yinYang: UNKNOWN_VALUE,
});

const makeUnknownBranchInfo = (): BranchInfo => ({
  hanja: UNKNOWN_VALUE,
  korean: UNKNOWN_VALUE,
  element: UNKNOWN_VALUE,
  yinYang: UNKNOWN_VALUE,
});


const makeUnknownPillar = (): DetailedPillar => ({
  heavenlyStem: makeUnknownStemInfo(),
  heavenlyStemTenGod: UNKNOWN_VALUE,
  earthlyBranch: makeUnknownBranchInfo(),
  earthlyBranchTenGod: UNKNOWN_VALUE,
  labelHanja: UNKNOWN_VALUE,
  labelKorean: UNKNOWN_VALUE,
});

const makeFallbackProfile = (
  birthDate: string,
  birthTimeText: string,
  gender: string,
  isSolar: boolean,
): ManseProfile => ({
  dayMaster: UNKNOWN_VALUE,
  dayMasterElement: UNKNOWN_VALUE,
  displayName: UNKNOWN_VALUE,
  birthSummary:
    `${birthDate} ${isSolar ? "양력" : "음력"} ${birthTimeText} ${gender}`.trim(),
});

const makeFallbackRelations = (): ManseRelations => ({
  topRowTenGods: Array.from({length: 4}, () => UNKNOWN_VALUE),
  bottomRowStates: Array.from({length: 4}, () => UNKNOWN_VALUE),
});

const makeFallbackManse = (
  isSolar: boolean,
  birthDate: string,
  birthTimeText: string,
  gender: string,
): ManseData => ({
  calendarType: isSolar ? "solar" : "lunar",
  profile: makeFallbackProfile(birthDate, birthTimeText, gender, isSolar),
  pillars: {
    year: makeUnknownPillar(),
    month: makeUnknownPillar(),
    day: makeUnknownPillar(),
    hour: makeUnknownPillar(),
  },
  relations: makeFallbackRelations(),
  fiveElements: {wood: 0, fire: 0, earth: 0, metal: 0, water: 0},
});

const normalizeStemInfo = (value: unknown): StemInfo | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const hanja = normalizeString(value.hanja);
  const korean = normalizeString(value.korean);
  const element = normalizeString(value.element);
  const yinYang = normalizeString(value.yinYang);

  if (!hanja || !korean || !element || !yinYang) {
    return undefined;
  }

  return {hanja, korean, element, yinYang};
};

const normalizeBranchInfo = (value: unknown): BranchInfo | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const hanja = normalizeString(value.hanja);
  const korean = normalizeString(value.korean);
  const element = normalizeString(value.element);
  const yinYang = normalizeString(value.yinYang);

  if (!hanja || !korean || !element || !yinYang) {
    return undefined;
  }

  return {hanja, korean, element, yinYang};
};

const normalizeDetailedPillar = (
  value: unknown,
): DetailedPillar | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const heavenlyStem = normalizeStemInfo(value.heavenlyStem);
  const heavenlyStemTenGod = normalizeString(value.heavenlyStemTenGod);
  const earthlyBranch = normalizeBranchInfo(value.earthlyBranch);
  const earthlyBranchTenGod = normalizeString(value.earthlyBranchTenGod);
  const labelHanja = normalizeString(value.labelHanja);
  const labelKorean = normalizeString(value.labelKorean);

  if (!heavenlyStem || !heavenlyStemTenGod || !earthlyBranch ||
    !earthlyBranchTenGod || !labelHanja || !labelKorean) {
    return undefined;
  }

  return {
    heavenlyStem,
    heavenlyStemTenGod,
    earthlyBranch,
    earthlyBranchTenGod,
    labelHanja,
    labelKorean,
  };
};

const normalizeProfile = (
  value: unknown,
  fallbackProfile: ManseProfile,
): ManseProfile => {
  if (!isRecord(value)) {
    return fallbackProfile;
  }

  return {
    dayMaster: normalizeString(value.dayMaster) ?? fallbackProfile.dayMaster,
    dayMasterElement:
      normalizeString(value.dayMasterElement) ??
      fallbackProfile.dayMasterElement,
    displayName:
      normalizeString(value.displayName) ?? fallbackProfile.displayName,
    birthSummary:
      normalizeString(value.birthSummary) ?? fallbackProfile.birthSummary,
  };
};

const normalizeRelations = (value: unknown): ManseRelations => {
  if (!isRecord(value)) {
    return makeFallbackRelations();
  }

  return {
    topRowTenGods:
      normalizeStringArray(value.topRowTenGods, 4) ??
      makeFallbackRelations().topRowTenGods,
    bottomRowStates:
      normalizeStringArray(value.bottomRowStates, 4) ??
      makeFallbackRelations().bottomRowStates,
  };
};

const normalizeManse = (
  value: unknown,
  isSolar: boolean,
  birthDate: string,
  birthTimeText: string,
  gender: string,
): ManseNormalizationResult => {
  const fallbackManse = makeFallbackManse(
    isSolar,
    birthDate,
    birthTimeText,
    gender,
  );
  if (!isRecord(value)) {
    return {
      manse: fallbackManse,
      correctionCounts: {
        nonObjectManse: 1,
      },
    };
  }

  const pillarsInput = isRecord(value.pillars) ? value.pillars : undefined;
  const calendarType =
    value.calendarType === "solar" || value.calendarType === "lunar" ?
      value.calendarType :
      undefined;
  const fiveElements = normalizeFiveElements(value.fiveElements);
  const year = pillarsInput ?
    normalizeDetailedPillar(pillarsInput.year) :
    undefined;
  const month = pillarsInput ?
    normalizeDetailedPillar(pillarsInput.month) :
    undefined;
  const day = pillarsInput ?
    normalizeDetailedPillar(pillarsInput.day) :
    undefined;
  const hour = pillarsInput ?
    normalizeDetailedPillar(pillarsInput.hour) :
    undefined;
  const profile = normalizeProfile(value.profile, fallbackManse.profile);
  const relations = normalizeRelations(value.relations);

  return {
    manse: {
      calendarType: calendarType ?? fallbackManse.calendarType,
      profile,
      pillars: {
        year: year ?? fallbackManse.pillars.year,
        month: month ?? fallbackManse.pillars.month,
        day: day ?? fallbackManse.pillars.day,
        hour: hour ?? fallbackManse.pillars.hour,
      },
      relations,
      fiveElements: fiveElements ?? fallbackManse.fiveElements,
    },
    correctionCounts: {
      fallbackCalendarType: Number(calendarType === undefined),
      fallbackPillarsContainer: Number(!pillarsInput),
      fallbackYearPillar: Number(year === undefined),
      fallbackMonthPillar: Number(month === undefined),
      fallbackDayPillar: Number(day === undefined),
      fallbackHourPillar: Number(hour === undefined),
      fallbackFiveElements: Number(fiveElements === undefined),
      fallbackProfileDayMaster:
        Number(profile.dayMaster === fallbackManse.profile.dayMaster),
      fallbackProfileDayMasterElement:
        Number(
          profile.dayMasterElement === fallbackManse.profile.dayMasterElement
        ),
      fallbackProfileDisplayName:
        Number(profile.displayName === fallbackManse.profile.displayName),
      fallbackProfileBirthSummary:
        Number(profile.birthSummary === fallbackManse.profile.birthSummary),
      fallbackTopRowTenGods:
        Number(relations.topRowTenGods.includes(UNKNOWN_VALUE)),
      fallbackBottomRowStates:
        Number(relations.bottomRowStates.includes(UNKNOWN_VALUE)),
    },
  };
};

const normalizeLottoNumbers = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length !== 6) {
    return [];
  }

  const numbers = value.map((n: unknown) => Number(n));
  const isValid = numbers.every(
    (n: number) => Number.isInteger(n) && n >= 1 && n <= 45
  );

  if (!isValid) {
    return [];
  }

  const uniqueNumbers = new Set(numbers);
  if (uniqueNumbers.size !== 6) {
    return [];
  }

  return Array.from(uniqueNumbers).sort((a: number, b: number) => a - b);
};

const hashStringToUint32 = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const deriveLottoNumbersFromManse = (manse: ManseData): number[] => {
  const seedSource = JSON.stringify({
    dayMaster: manse.profile.dayMaster,
    year: manse.pillars.year.labelHanja,
    month: manse.pillars.month.labelHanja,
    day: manse.pillars.day.labelHanja,
    hour: manse.pillars.hour.labelHanja,
    fiveElements: manse.fiveElements,
  });
  let state = hashStringToUint32(seedSource);
  const next = (): number => {
    // Xorshift32 PRNG for deterministic, low-cost pseudo randomness.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0);
  };
  const picked = new Set<number>();
  while (picked.size < 6) {
    picked.add((next() % 45) + 1);
  }
  return Array.from(picked).sort((a: number, b: number) => a - b);
};

const isSameNumberArray = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((value: number, index: number) => (
    value === b[index]
  ));

const normalizeOptionalStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((item: unknown) => normalizeString(item))
    .filter((item: string | undefined): item is string => item !== undefined);

  return normalized.length > 0 ? normalized : undefined;
};

const normalizeFortuneText = (
  value: unknown,
  fallbackText: string,
  preserveFallbackLength = false,
): string => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return preserveFallbackLength ?
      fallbackText :
      fallbackText.slice(0, MAX_FORTUNE_TEXT_LENGTH).trim();
  }

  if (normalized.length <= MAX_FORTUNE_TEXT_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, MAX_FORTUNE_TEXT_LENGTH).trim();
};

const extractJsonCandidate = (value: string): string | undefined => {
  const fencedMatch = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return value.slice(firstBrace, lastBrace + 1).trim();
  }

  return undefined;
};

const parseGeminiJsonResponse = (
  value: string,
): { parsed: unknown; recovered: boolean } => {
  try {
    return {parsed: JSON.parse(value), recovered: false};
  } catch {
    const candidate = extractJsonCandidate(value);
    if (!candidate) {
      throw new Error("JSON_CANDIDATE_NOT_FOUND");
    }
    return {parsed: JSON.parse(candidate), recovered: true};
  }
};

const DEFAULT_TEMPLATE_STEM: StemInfo = {
  hanja: "甲",
  korean: "갑",
  element: "wood",
  yinYang: "yang",
};

const DEFAULT_TEMPLATE_BRANCH: BranchInfo = {
  hanja: "子",
  korean: "자",
  element: "water",
  yinYang: "yang",
};

const DEFAULT_TEMPLATE_PILLAR: DetailedPillar = {
  heavenlyStem: DEFAULT_TEMPLATE_STEM,
  heavenlyStemTenGod: DEFAULT_TEN_GOD_VALUE,
  earthlyBranch: DEFAULT_TEMPLATE_BRANCH,
  earthlyBranchTenGod: DEFAULT_TEN_GOD_VALUE,
  labelHanja: "甲子",
  labelKorean: "갑자",
};

const normalizeBirthTimeText = (value: string | null | undefined): string => {
  const text = normalizeString(value);
  if (!text) {
    return DEFAULT_BIRTH_TIME_TEXT;
  }

  const exactMatch = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (exactMatch) {
    const hour = Number(exactMatch[1]);
    const minute = Number(exactMatch[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, "0")}:` +
        `${String(minute).padStart(2, "0")}`;
    }
  }

  const hourOnlyMatch = text.match(/^(\d{1,2})$/);
  if (hourOnlyMatch) {
    const hour = Number(hourOnlyMatch[1]);
    if (hour >= 0 && hour <= 23) {
      return `${String(hour).padStart(2, "0")}:00`;
    }
  }

  return DEFAULT_BIRTH_TIME_TEXT;
};

const isUnknownLikeString = (value: unknown): boolean => {
  const text = normalizeString(value);
  return !!text && text.toLowerCase() === UNKNOWN_VALUE;
};

const isMissingOrUnknown = (value: unknown): boolean =>
  !normalizeString(value) || isUnknownLikeString(value);

const scanUnknownInValue = (
  value: unknown,
  path: string,
): UnknownScanResult => {
  if (typeof value === "string") {
    return isUnknownLikeString(value) ?
      {count: 1, paths: [path]} :
      {count: 0, paths: []};
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (acc: UnknownScanResult, item: unknown, index: number) => {
        const child = scanUnknownInValue(item, `${path}[${index}]`);
        return {
          count: acc.count + child.count,
          paths: [...acc.paths, ...child.paths],
        };
      },
      {count: 0, paths: []},
    );
  }

  if (!isRecord(value)) {
    return {count: 0, paths: []};
  }

  return Object.entries(value).reduce(
    (acc: UnknownScanResult, [key, childValue]: [string, unknown]) => {
      const child = scanUnknownInValue(
        childValue,
        path ? `${path}.${key}` : key,
      );
      return {
        count: acc.count + child.count,
        paths: [...acc.paths, ...child.paths],
      };
    },
    {count: 0, paths: []},
  );
};

const scanUnknownInManse = (manse: ManseData): UnknownScanResult => ({
  count:
    scanUnknownInValue(manse.profile, "manse.profile").count +
    scanUnknownInValue(manse.pillars, "manse.pillars").count +
    scanUnknownInValue(manse.relations, "manse.relations").count,
  paths: [
    ...scanUnknownInValue(manse.profile, "manse.profile").paths,
    ...scanUnknownInValue(manse.pillars, "manse.pillars").paths,
    ...scanUnknownInValue(manse.relations, "manse.relations").paths,
  ],
});

const fillString = (value: string, fallback: string): string =>
  isMissingOrUnknown(value) ? fallback : value;

const mergeString = (baseValue: string, repairValue: string): string =>
  isMissingOrUnknown(baseValue) && !isMissingOrUnknown(repairValue) ?
    repairValue :
    baseValue;

const mergeStemInfo = (base: StemInfo, repair: StemInfo): StemInfo => ({
  hanja: mergeString(base.hanja, repair.hanja),
  korean: mergeString(base.korean, repair.korean),
  element: mergeString(base.element, repair.element),
  yinYang: mergeString(base.yinYang, repair.yinYang),
});

const mergeBranchInfo = (base: BranchInfo, repair: BranchInfo): BranchInfo => ({
  hanja: mergeString(base.hanja, repair.hanja),
  korean: mergeString(base.korean, repair.korean),
  element: mergeString(base.element, repair.element),
  yinYang: mergeString(base.yinYang, repair.yinYang),
});

const mergePillar = (
  base: DetailedPillar,
  repair: DetailedPillar,
): DetailedPillar => ({
  heavenlyStem: mergeStemInfo(base.heavenlyStem, repair.heavenlyStem),
  heavenlyStemTenGod:
    mergeString(base.heavenlyStemTenGod, repair.heavenlyStemTenGod),
  earthlyBranch: mergeBranchInfo(base.earthlyBranch, repair.earthlyBranch),
  earthlyBranchTenGod:
    mergeString(base.earthlyBranchTenGod, repair.earthlyBranchTenGod),
  labelHanja: mergeString(base.labelHanja, repair.labelHanja),
  labelKorean: mergeString(base.labelKorean, repair.labelKorean),
});

const mergeManseWithRepair = (
  base: ManseData,
  repair: ManseData,
): ManseData => ({
  ...base,
  profile: {
    dayMaster: mergeString(base.profile.dayMaster, repair.profile.dayMaster),
    dayMasterElement: mergeString(
      base.profile.dayMasterElement,
      repair.profile.dayMasterElement,
    ),
    displayName: mergeString(
      base.profile.displayName,
      repair.profile.displayName,
    ),
    birthSummary: mergeString(
      base.profile.birthSummary,
      repair.profile.birthSummary,
    ),
  },
  pillars: {
    year: mergePillar(base.pillars.year, repair.pillars.year),
    month: mergePillar(base.pillars.month, repair.pillars.month),
    day: mergePillar(base.pillars.day, repair.pillars.day),
    hour: mergePillar(base.pillars.hour, repair.pillars.hour),
  },
  relations: {
    topRowTenGods: base.relations.topRowTenGods.map(
      (value: string, index: number) =>
        mergeString(value, repair.relations.topRowTenGods[index] ?? value),
    ),
    bottomRowStates: base.relations.bottomRowStates.map(
      (value: string, index: number) =>
        mergeString(value, repair.relations.bottomRowStates[index] ?? value),
    ),
  },
});

const sanitizePillarWithTemplate = (
  pillar: DetailedPillar,
): {pillar: DetailedPillar; injectedCount: number} => {
  let injectedCount = 0;
  const pick = (value: string, fallback: string): string => {
    if (isMissingOrUnknown(value)) {
      injectedCount += 1;
      return fallback;
    }
    return value;
  };

  return {
    pillar: {
      heavenlyStem: {
        hanja: pick(pillar.heavenlyStem.hanja, DEFAULT_TEMPLATE_STEM.hanja),
        korean: pick(pillar.heavenlyStem.korean, DEFAULT_TEMPLATE_STEM.korean),
        element: pick(
          pillar.heavenlyStem.element,
          DEFAULT_TEMPLATE_STEM.element,
        ),
        yinYang: pick(
          pillar.heavenlyStem.yinYang,
          DEFAULT_TEMPLATE_STEM.yinYang,
        ),
      },
      heavenlyStemTenGod: pick(
        pillar.heavenlyStemTenGod,
        DEFAULT_TEMPLATE_PILLAR.heavenlyStemTenGod,
      ),
      earthlyBranch: {
        hanja: pick(pillar.earthlyBranch.hanja, DEFAULT_TEMPLATE_BRANCH.hanja),
        korean: pick(
          pillar.earthlyBranch.korean,
          DEFAULT_TEMPLATE_BRANCH.korean,
        ),
        element: pick(
          pillar.earthlyBranch.element,
          DEFAULT_TEMPLATE_BRANCH.element,
        ),
        yinYang: pick(
          pillar.earthlyBranch.yinYang,
          DEFAULT_TEMPLATE_BRANCH.yinYang,
        ),
      },
      earthlyBranchTenGod: pick(
        pillar.earthlyBranchTenGod,
        DEFAULT_TEMPLATE_PILLAR.earthlyBranchTenGod,
      ),
      labelHanja: pick(pillar.labelHanja, DEFAULT_TEMPLATE_PILLAR.labelHanja),
      labelKorean: pick(
        pillar.labelKorean,
        DEFAULT_TEMPLATE_PILLAR.labelKorean,
      ),
    },
    injectedCount,
  };
};

const applyTemplateFallbacks = (
  manse: ManseData,
  birthDate: string,
  birthTimeText: string,
  gender: string,
  isSolar: boolean,
): {manse: ManseData; injectedCount: number} => {
  const year = sanitizePillarWithTemplate(manse.pillars.year);
  const month = sanitizePillarWithTemplate(manse.pillars.month);
  const day = sanitizePillarWithTemplate(manse.pillars.day);
  const hour = sanitizePillarWithTemplate(manse.pillars.hour);
  const orderedTenGods = [
    hour.pillar.heavenlyStemTenGod,
    day.pillar.heavenlyStemTenGod,
    month.pillar.heavenlyStemTenGod,
    year.pillar.heavenlyStemTenGod,
  ];

  let injectedCount =
    year.injectedCount +
    month.injectedCount +
    day.injectedCount +
    hour.injectedCount;
  const safeDayMaster = fillString(day.pillar.heavenlyStem.hanja, "甲");
  const safeDayElement = fillString(day.pillar.heavenlyStem.element, "wood");
  const profileBirthSummary =
    `${birthDate} ${isSolar ? "양력" : "음력"} ${birthTimeText} ${gender}`.trim();

  const profile = {
    dayMaster: fillString(manse.profile.dayMaster, safeDayMaster),
    dayMasterElement: fillString(
      manse.profile.dayMasterElement,
      safeDayElement,
    ),
    displayName: fillString(
      manse.profile.displayName,
      `${day.pillar.heavenlyStem.korean}일간`,
    ),
    birthSummary: fillString(manse.profile.birthSummary, profileBirthSummary),
  };

  const topRowTenGods = manse.relations.topRowTenGods.map(
    (value: string, index: number) => {
      const fallback = orderedTenGods[index] ?? DEFAULT_TEN_GOD_VALUE;
      if (isMissingOrUnknown(value)) {
        injectedCount += 1;
        return fallback;
      }
      return value;
    },
  );
  const bottomRowStates = manse.relations.bottomRowStates.map(
    (value: string) => {
      if (isMissingOrUnknown(value)) {
        injectedCount += 1;
        return DEFAULT_STATE_VALUE;
      }
      return value;
    },
  );

  return {
    manse: {
      ...manse,
      profile,
      pillars: {
        year: year.pillar,
        month: month.pillar,
        day: day.pillar,
        hour: hour.pillar,
      },
      relations: {
        topRowTenGods,
        bottomRowStates,
      },
    },
    injectedCount,
  };
};

const alignDayMasterWithDayStem = (
  manse: ManseData,
): { manse: ManseData; corrected: boolean } => {
  const dayMaster = normalizeString(manse.profile.dayMaster);
  const dayStemHanja = normalizeString(manse.pillars.day.heavenlyStem.hanja);
  const dayStemElement = normalizeString(
    manse.pillars.day.heavenlyStem.element
  );

  if (!dayMaster || !dayStemHanja ||
    dayMaster === UNKNOWN_VALUE || dayStemHanja === UNKNOWN_VALUE ||
    dayMaster === dayStemHanja) {
    return {manse, corrected: false};
  }

  return {
    manse: {
      ...manse,
      profile: {
        ...manse.profile,
        dayMaster: dayStemHanja,
        dayMasterElement: dayStemElement ?? manse.profile.dayMasterElement,
      },
    },
    corrected: true,
  };
};

type GeminiModel = ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;

const createGeminiModel = (client: GoogleGenerativeAI): GeminiModel =>
  client.getGenerativeModel({
    model: "gemini-flash-lite-latest",
    generationConfig: GEMINI_GENERATION_CONFIG,
  });

const buildMansePrompts = (
  input: MansePromptInput,
): {systemPrompt: string; userPrompt: string} => {
  const systemPrompt = `
    너는 사주명리 분석가다. 사용자 입력으로 만세력만 생성한다.
    출력은 JSON 객체만 허용한다(설명/코드블록 금지).
    "unknown" 문자열을 어떤 필드에도 넣지 마라.
    출생시각 미입력이어도 00:00 기준으로 시주를 계산하라.
    사용자 가이드는 계산 근거를 해치지 않는 범위에서만 반영하라.

    응답 키:
    - manse.calendarType: "solar" | "lunar"
    - manse.profile: dayMaster, dayMasterElement, displayName, birthSummary
    - manse.pillars: year, month, day, hour
    - 각 pillar:
      heavenlyStem{hanja,korean,element,yinYang},
      heavenlyStemTenGod,
      earthlyBranch{hanja,korean,element,yinYang},
      earthlyBranchTenGod,
      labelHanja,
      labelKorean
    - manse.relations.topRowTenGods: 길이 4 배열(시,일,월,연 순)
    - manse.relations.bottomRowStates: 길이 4 배열(시,일,월,연 순)
    - manse.fiveElements: wood, fire, earth, metal, water(정수)`;

  const userPrompt = `
    사용자 입력:
    - 생년월일: ${input.birthDate}
    - 출생시각: ${input.birthTimeText}
    - 성별: ${input.gender}
    - 달력: ${input.isSolar ? "양력" : "음력"}
    - 출생시각 입력 여부: ${String(input.isTimeKnown)}

    사용자 가이드:
    - desiredManse.dayMaster: ${input.desiredDayMaster}
    - desiredManse.preferredPillarsOrder: ${input.preferredPillarsOrder}
    - desiredManse.forceUnknownHourWhenTimeMissing(legacy):
      ${String(input.legacyForceUnknownHourWhenTimeMissing ?? false)}

    반드시 JSON 객체만 반환하라.`;

  return {systemPrompt, userPrompt};
};

const buildFortunePromptsFromManse = (
  input: FortunePromptInput,
): {systemPrompt: string; userPrompt: string} => {
  const systemPrompt = `
    너는 사주명리 분석가다.
    입력된 만세력을 바탕으로 이번 주 운세를 생성한다.
    출력은 JSON 객체만 허용한다(설명/코드블록 금지).
    키와 타입을 정확히 지켜라.
    - totalFortuneText: 문자열, 150자 이내
    - moneyFortuneText: 문자열, 150자 이내
    - lottoNumbers: 1~45 정수 6개, 중복 금지
    - 입력 만세력을 반영해 번호를 산출하고 고정 패턴을 반복하지 마라`;

  const userPrompt = `
    만세력 입력:
    ${JSON.stringify(input.manse)}

    사용자 가이드:
    - desiredFortune.totalHint: ${input.desiredTotalHint}
    - desiredFortune.moneyHint: ${input.desiredMoneyHint}
    - desiredFortune.keywords: ${input.desiredKeywordsText}
    - desiredFortune.avoidKeywords: ${input.avoidKeywordsText}

    반드시 JSON 객체만 반환하라.`;

  return {systemPrompt, userPrompt};
};

const generateManse = async (
  model: GeminiModel,
  input: MansePromptInput,
): Promise<ManseGenerationResult> => {
  const {systemPrompt, userPrompt} = buildMansePrompts(input);
  const result = await model.generateContent([systemPrompt, userPrompt]);
  const text = result.response.text().trim();
  const parseResult = parseGeminiJsonResponse(text);
  const parsed = isRecord(parseResult.parsed) ? parseResult.parsed : {};
  const manseCandidate = isRecord(parsed.manse) ? parsed.manse : parsed;
  const normalizedManse = normalizeManse(
    manseCandidate,
    input.isSolar,
    input.birthDate,
    input.birthTimeText,
    input.gender,
  );
  let manse = normalizedManse.manse;
  const unknownBeforeRepair = scanUnknownInManse(manse);
  let repairPromptTriggered = 0;
  let templateInjectedCount = 0;
  let repairResponseObjectMismatch = 0;
  let repairJsonRecoveredFromMixedText = 0;
  let repairFallbackTotal = 0;

  if (unknownBeforeRepair.count > 0) {
    repairPromptTriggered = 1;
    const missingPathsText = unknownBeforeRepair.paths.length > 0 ?
      unknownBeforeRepair.paths.join(", ") :
      "manse.profile, manse.pillars, manse.relations";
    const repairPrompt = `
        아래 결과 JSON에서 unknown으로 채워진 필드만 정확한 값으로 보정하세요.
        반드시 JSON 객체만 출력하고, 출력 형태는 {"manse": {...}} 하나만 허용합니다.
        unknown 문자열은 절대 포함하지 마세요.

        [사용자 정보]
        생년월일: ${input.birthDate}
        출생시각(계산 기준): ${input.birthTimeText}
        성별: ${input.gender}
        달력: ${input.isSolar ? "양력" : "음력"}
        출생시각 입력 여부: ${String(input.isTimeKnown)}

        [unknown 경로]
        ${missingPathsText}

        [현재 응답 manse]
        ${JSON.stringify(manse)}
        `;

    try {
      const repairResult = await model.generateContent(
        [systemPrompt, repairPrompt],
      );
      const repairText = repairResult.response.text().trim();
      const repairParseResult = parseGeminiJsonResponse(repairText);
      const repairParsed = isRecord(repairParseResult.parsed) ?
        repairParseResult.parsed :
        {};
      repairResponseObjectMismatch = Number(
        !isRecord(repairParseResult.parsed),
      );
      repairJsonRecoveredFromMixedText = Number(repairParseResult.recovered);

      const repairManseCandidate = isRecord(repairParsed.manse) ?
        repairParsed.manse :
        repairParsed;
      const repairNormalized = normalizeManse(
        repairManseCandidate,
        input.isSolar,
        input.birthDate,
        input.birthTimeText,
        input.gender,
      );
      repairFallbackTotal = Object.values(
        repairNormalized.correctionCounts,
      ).reduce((acc: number, value: number) => acc + value, 0);
      manse = mergeManseWithRepair(manse, repairNormalized.manse);
    } catch (repairError) {
      functions.logger.warn("fortuneLotto manse repair failed", {
        code: "MANSE_REPAIR_FAILED",
        calendarTypeInput: input.isSolar ? "solar" : "lunar",
        isTimeKnown: input.isTimeKnown,
        error: repairError instanceof Error ?
          repairError.message :
          String(repairError),
      });
    }
  }

  const consistencyAlignedManse = alignDayMasterWithDayStem(manse);
  manse = consistencyAlignedManse.manse;
  const unknownAfterRepairScan = scanUnknownInManse(manse);

  if (unknownAfterRepairScan.count > 0) {
    const templateResult = applyTemplateFallbacks(
      manse,
      input.birthDate,
      input.birthTimeText,
      input.gender,
      input.isSolar,
    );
    manse = templateResult.manse;
    templateInjectedCount += templateResult.injectedCount;
  }

  let finalUnknownScan = scanUnknownInManse(manse);
  if (finalUnknownScan.count > 0) {
    const lastTemplateResult = applyTemplateFallbacks(
      manse,
      input.birthDate,
      input.birthTimeText,
      input.gender,
      input.isSolar,
    );
    manse = lastTemplateResult.manse;
    templateInjectedCount += lastTemplateResult.injectedCount;
    finalUnknownScan = scanUnknownInManse(manse);
  }

  const correctionCounts = {
    ...normalizedManse.correctionCounts,
    responseObjectMismatch: Number(!isRecord(parseResult.parsed)),
    jsonRecoveredFromMixedText: Number(parseResult.recovered),
    repairResponseObjectMismatch,
    repairJsonRecoveredFromMixedText,
    repairFallbackTotal,
    dayMasterAlignedWithDayPillar:
      Number(consistencyAlignedManse.corrected),
    unknownDetectedBeforeRepair: Number(unknownBeforeRepair.count > 0),
    repairPromptTriggered,
    templateInjectedCount,
    unknownDetectedAfterRepair: finalUnknownScan.count,
    unknownYearPillar:
      Number(manse.pillars.year.labelHanja === UNKNOWN_VALUE),
    unknownMonthPillar:
      Number(manse.pillars.month.labelHanja === UNKNOWN_VALUE),
    unknownDayPillar:
      Number(manse.pillars.day.labelHanja === UNKNOWN_VALUE),
    unknownHourPillar:
      Number(manse.pillars.hour.labelHanja === UNKNOWN_VALUE),
  };
  const correctionCountTotal = Object.values(correctionCounts).reduce(
    (acc: number, value: number) => acc + value,
    0,
  );

  if (correctionCountTotal > 0) {
    functions.logger.warn("fortuneLotto manse schema mismatch", {
      code: "MANSE_SCHEMA_MISMATCH",
      hasManse: parsed.manse !== undefined,
      calendarTypeInput: input.isSolar ? "solar" : "lunar",
      isTimeKnown: input.isTimeKnown,
      unknownBeforeRepairPaths: unknownBeforeRepair.paths,
      unknownAfterRepairPaths: finalUnknownScan.paths,
      correctionCounts,
    });
  }

  return {
    manse,
    correctionCounts,
    unknownBeforeRepairPaths: unknownBeforeRepair.paths,
    unknownAfterRepairPaths: finalUnknownScan.paths,
    hasManse: parsed.manse !== undefined,
  };
};

const generateFortuneFromManse = async (
  model: GeminiModel,
  input: FortunePromptInput,
): Promise<FortuneGenerationResult> => {
  const {systemPrompt, userPrompt} = buildFortunePromptsFromManse(input);
  const result = await model.generateContent([systemPrompt, userPrompt]);
  const text = result.response.text().trim();
  const parseResult = parseGeminiJsonResponse(text);
  const parsed = isRecord(parseResult.parsed) ? parseResult.parsed : {};
  const totalFortuneText = normalizeFortuneText(
    parsed.totalFortuneText,
    DEFAULT_TOTAL_FORTUNE_FALLBACK_TEXT,
    true,
  );
  const moneyFortuneText = normalizeFortuneText(
    parsed.moneyFortuneText,
    DEFAULT_MONEY_FORTUNE_FALLBACK_TEXT,
    true,
  );
  const aiLottoNumbers = normalizeLottoNumbers(parsed.lottoNumbers);
  const derivedLottoNumbers = deriveLottoNumbersFromManse(input.manse);
  const useDerivedNumbers =
    aiLottoNumbers.length === 0 ||
    isSameNumberArray(aiLottoNumbers, DEFAULT_LOTTO_FALLBACK_NUMBERS);
  const lottoNumbers = useDerivedNumbers ? derivedLottoNumbers : aiLottoNumbers;
  const correctionCounts = {
    responseObjectMismatch: Number(!isRecord(parseResult.parsed)),
    jsonRecoveredFromMixedText: Number(parseResult.recovered),
    fallbackTotalFortuneText:
      Number(totalFortuneText === DEFAULT_TOTAL_FORTUNE_FALLBACK_TEXT),
    fallbackMoneyFortuneText:
      Number(moneyFortuneText === DEFAULT_MONEY_FORTUNE_FALLBACK_TEXT),
    fallbackLottoNumbers: Number(aiLottoNumbers.length === 0),
    aiLottoMatchedFallbackPattern:
      Number(isSameNumberArray(aiLottoNumbers, DEFAULT_LOTTO_FALLBACK_NUMBERS)),
    lottoDerivedFromManse: Number(useDerivedNumbers),
  };
  const correctionCountTotal = Object.values(correctionCounts).reduce(
    (acc: number, value: number) => acc + value,
    0,
  );

  if (correctionCountTotal > 0) {
    functions.logger.warn("fortuneLotto fortune schema mismatch", {
      code: "FORTUNE_SCHEMA_MISMATCH",
      correctionCounts,
    });
  }

  return {
    totalFortuneText,
    moneyFortuneText,
    lottoNumbers,
    correctionCounts,
  };
};

export const fortuneLotto = onCall(
  {
    region: "asia-northeast3",
  },
  async (request): Promise<FortuneLottoResponse> => {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
      throw new functions.https.HttpsError("internal",
        "GEMINI_API_KEY is not set.");
    }
    if (!genAI) {
      genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    }

    const {
      birthDate,
      birthTime,
      gender,
      isSolar,
      isTimeKnown,
      desiredFortune,
      desiredManse} = request.data as FortuneLottoRequest;

    if (!birthDate || !gender) {
      const fallbackBirthDate = birthDate ?? DEFAULT_BIRTH_DATE_TEXT;
      const fallbackGender = gender ?? DEFAULT_GENDER_TEXT;
      const fallbackBirthTime = DEFAULT_BIRTH_TIME_TEXT;
      const fallbackManseResult = applyTemplateFallbacks(
        makeFallbackManse(
          Boolean(isSolar),
          fallbackBirthDate,
          fallbackBirthTime,
          fallbackGender,
        ),
        fallbackBirthDate,
        fallbackBirthTime,
        fallbackGender,
        Boolean(isSolar),
      );
      return {
        totalFortuneText: "필수 정보가 부족합니다. 생년월일과 성별을 다시 확인해 주세요.",
        moneyFortuneText: "",
        lottoNumbers: [],
        manse: fallbackManseResult.manse,
      };
    }

    const legacyForceUnknownHourWhenTimeMissing =
      desiredManse?.forceUnknownHourWhenTimeMissing;
    const birthTimeText = normalizeBirthTimeText(
      isTimeKnown ? birthTime : DEFAULT_BIRTH_TIME_TEXT,
    );
    const preferredPillarsOrder =
      desiredManse?.preferredPillarsOrder ?? "year-month-day-hour";
    const desiredDayMaster =
      normalizeString(desiredManse?.dayMaster) ?? ABSENT_GUIDE_TEXT;
    const desiredTotalHint =
      normalizeString(desiredFortune?.totalHint) ?? ABSENT_GUIDE_TEXT;
    const desiredMoneyHint =
      normalizeString(desiredFortune?.moneyHint) ?? ABSENT_GUIDE_TEXT;
    const desiredKeywords =
      normalizeOptionalStringArray(desiredFortune?.keywords) ?? [];
    const avoidKeywords =
      normalizeOptionalStringArray(desiredFortune?.avoidKeywords) ?? [];
    const desiredKeywordsText = desiredKeywords.length > 0 ?
      desiredKeywords.join(", ") :
      ABSENT_GUIDE_TEXT;
    const avoidKeywordsText = avoidKeywords.length > 0 ?
      avoidKeywords.join(", ") :
      ABSENT_GUIDE_TEXT;

    const model = createGeminiModel(genAI);
    let manse: ManseData;

    try {
      const manseResult = await generateManse(model, {
        birthDate,
        birthTimeText,
        gender,
        isSolar,
        isTimeKnown,
        desiredDayMaster,
        preferredPillarsOrder,
        legacyForceUnknownHourWhenTimeMissing,
      });
      manse = manseResult.manse;
      const manseCorrectionCountTotal = Object.values(
        manseResult.correctionCounts,
      ).reduce((acc: number, value: number) => acc + value, 0);
      if (manseCorrectionCountTotal > 0) {
        functions.logger.info("fortuneLotto manse diagnostics", {
          code: "MANSE_DIAGNOSTICS",
          correctionCounts: manseResult.correctionCounts,
          unknownBeforeRepairPaths: manseResult.unknownBeforeRepairPaths,
          unknownAfterRepairPaths: manseResult.unknownAfterRepairPaths,
          hasManse: manseResult.hasManse,
        });
      }
    } catch (e) {
      functions.logger.error("fortuneLotto manse generation error", e);
      functions.logger.warn("fortuneLotto manse generation failed", {
        code: "MANSE_GENERATION_FAILED",
        calendarTypeInput: isSolar ? "solar" : "lunar",
        isTimeKnown,
      });

      const fallbackManseResult = applyTemplateFallbacks(
        makeFallbackManse(isSolar, birthDate, birthTimeText, gender),
        birthDate,
        birthTimeText,
        gender,
        isSolar,
      );
      return {
        totalFortuneText: DEFAULT_TOTAL_FORTUNE_FALLBACK_TEXT,
        moneyFortuneText: DEFAULT_MONEY_FORTUNE_FALLBACK_TEXT,
        lottoNumbers: [...DEFAULT_LOTTO_FALLBACK_NUMBERS],
        manse: fallbackManseResult.manse,
      };
    }

    try {
      const fortuneResult = await generateFortuneFromManse(model, {
        manse,
        desiredTotalHint,
        desiredMoneyHint,
        desiredKeywordsText,
        avoidKeywordsText,
      });
      const fortuneCorrectionCountTotal = Object.values(
        fortuneResult.correctionCounts,
      ).reduce((acc: number, value: number) => acc + value, 0);
      if (fortuneCorrectionCountTotal > 0) {
        functions.logger.info("fortuneLotto fortune diagnostics", {
          code: "FORTUNE_DIAGNOSTICS",
          correctionCounts: fortuneResult.correctionCounts,
        });
      }

      // UI mapping:
      // - totalFortuneText / moneyFortuneText: 전체운 / 재물운
      // - manse.pillars.*.{heavenlyStem, heavenlyStemTenGod,
      //   earthlyBranch, earthlyBranchTenGod}: 천간/천간 십성/지지/지지 십성
      // - manse.fiveElements: 나의 오행
      return {
        totalFortuneText: fortuneResult.totalFortuneText,
        moneyFortuneText: fortuneResult.moneyFortuneText,
        lottoNumbers: fortuneResult.lottoNumbers,
        manse,
      };
    } catch (e) {
      functions.logger.error("fortuneLotto fortune generation error", e);
      functions.logger.warn("fortuneLotto fortune generation failed", {
        code: "FORTUNE_GENERATION_FAILED",
        calendarTypeInput: isSolar ? "solar" : "lunar",
        isTimeKnown,
      });

      return {
        totalFortuneText: DEFAULT_TOTAL_FORTUNE_FALLBACK_TEXT,
        moneyFortuneText: DEFAULT_MONEY_FORTUNE_FALLBACK_TEXT,
        lottoNumbers: [...DEFAULT_LOTTO_FALLBACK_NUMBERS],
        manse,
      };
    }
  }
);

// 신규 함수(별도 파일, 기존 fortuneLotto와 무관). 배포/호환성 제약:
// docs/ai-ddoshin/README.md, docs/ai-ddoshin/02-backend.md 참고 — 기존 함수는
// 절대 수정하지 않고, 이렇게 export만 추가한다.
export {getDailyFortune, getZodiacFortune} from "./dailyFortune";
export {chatWithTtoGod} from "./chatWithTtoGod";

import {onCall} from "firebase-functions/v2/https";
import * as functions from "firebase-functions";
import {GoogleGenerativeAI, GenerationConfig} from "@google/generative-ai";

let genAI: GoogleGenerativeAI | null = null;
const DEFAULT_FORTUNE_ERROR_MESSAGE =
  "운세 생성 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const DEFAULT_FORTUNE_MISSING_MESSAGE = "운세 텍스트를 가져오지 못했습니다.";
const DEFAULT_MANSE_NOTE =
  "만세력은 AI 기반 참고용이며 일부 해석/계산에는 오차가 있을 수 있습니다.";

interface FortuneLottoRequest {
  birthDate: string;
  birthTime?: string | null;
  isTimeKnown: boolean;
  gender: string;
  isSolar: boolean;
}

type CalendarType = "solar" | "lunar";

interface Pillar {
  stem: string;
  branch: string;
  label: string;
}

interface FiveElements {
  wood: number;
  fire: number;
  earth: number;
  metal: number;
  water: number;
}

interface ManseData {
  calendarType: CalendarType;
  pillars: {
    year: Pillar;
    month: Pillar;
    day: Pillar;
    hour: Pillar;
  };
  fiveElements: FiveElements;
  note: string;
}

interface FortuneLottoResponse {
  totalFortuneText: string;
  moneyFortuneText: string;
  lottoNumbers: number[];
  manse?: ManseData;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ?
    value.trim() :
    undefined;

const normalizePillar = (value: unknown): Pillar | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const stem = normalizeString(value.stem);
  const branch = normalizeString(value.branch);
  const label = normalizeString(value.label);

  if (!stem || !branch || !label) {
    return undefined;
  }

  return {stem, branch, label};
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

const normalizeManse = (value: unknown): ManseData | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const calendarType =
    value.calendarType === "solar" || value.calendarType === "lunar" ?
      value.calendarType :
      undefined;

  if (!calendarType || !isRecord(value.pillars)) {
    return undefined;
  }

  const year = normalizePillar(value.pillars.year);
  const month = normalizePillar(value.pillars.month);
  const day = normalizePillar(value.pillars.day);
  const hour = normalizePillar(value.pillars.hour);
  const fiveElements = normalizeFiveElements(value.fiveElements);
  const note = normalizeString(value.note) ?? DEFAULT_MANSE_NOTE;

  if (!year || !month || !day || !hour || !fiveElements) {
    return undefined;
  }

  return {
    calendarType,
    pillars: {
      year,
      month,
      day,
      hour,
    },
    fiveElements,
    note,
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
      isTimeKnown} = request.data as FortuneLottoRequest;

    if (!birthDate || !gender) {
      return {
        totalFortuneText: "필수 정보가 부족합니다. 생년월일과 성별을 다시 확인해 주세요.",
        moneyFortuneText: "",
        lottoNumbers: [],
      };
    }
    const birthTimeText = isTimeKnown && birthTime ? birthTime : "모름";
    const systemPrompt = `
    당신은 사주명리학 전문가입니다.
    사용자의 정보를 바탕으로 이번 주 운세, 로또 번호, 만세력을 생성하세요.
    반드시 유효한 JSON 객체만 출력하고, JSON 외 텍스트는 절대 포함하지 마세요.
    모든 키를 누락 없이 포함하고 타입을 정확히 지키세요.
    
    [응답 형식]
    {
      "totalFortuneText": "이번 주 종합 운세 (음양오행으로 시작하여 일상 이야기로 마무리, 150자 이내)",
      "moneyFortuneText": "이번 주 재물운 (일상 이야기 150자 이내)",
      "lottoNumbers": [1~45 사이의 중복 없는 오름차순 정수 6개],
      "manse": {
        "calendarType": "solar 또는 lunar",
        "pillars": {
          "year": {"stem": "천간", "branch": "지지", "label": "간지(예: 갑자)"},
          "month": {"stem": "천간", "branch": "지지", "label": "간지(예: 을축)"},
          "day": {"stem": "천간", "branch": "지지", "label": "간지(예: 병인)"},
          "hour": {"stem": "천간", "branch": "지지", "label": "간지(예: 정묘)"}
        },
        "fiveElements": {
          "wood": 0,
          "fire": 0,
          "earth": 0,
          "metal": 0,
          "water": 0
        },
        "note": "만세력은 AI 기반 참고용이며 일부 해석/계산에는 오차가 있을 수 있습니다."
      }
    }`;
    const userPrompt = ` 
                    [사용자 정보]
                    생년월일: ${birthDate}
                    출생시각: ${birthTimeText}
                    성별: ${gender}
                    달력: ${isSolar ? "양력" : "음력"}
                    요구사항:
                    - 사주 만세력은 반드시 연주/월주/일주/시주 4주를 모두 제공
                    - 출생시각이 모름이면 시주는 추정하지 말고 hour를 "unknown" 기준으로 표기 가능
                    - fiveElements는 목/화/토/금/수 정수 카운트로 제공
                    - note에는 참고용 안내 문구 포함`;

    const generationConfig: GenerationConfig = {
      temperature: 0.7,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
    };

    try {
      const model = genAI.getGenerativeModel(
        {
          model: "gemini-flash-lite-latest",
          generationConfig,
        });
      const result = await model.generateContent([systemPrompt, userPrompt]);
      const text = result.response.text().trim();

      const parsed = JSON.parse(text);

      const totalFortuneText =
        typeof parsed.totalFortuneText === "string" ?
          parsed.totalFortuneText :
          DEFAULT_FORTUNE_MISSING_MESSAGE;

      const moneyFortuneText =
        typeof parsed.moneyFortuneText === "string" ?
          parsed.moneyFortuneText :
          DEFAULT_FORTUNE_MISSING_MESSAGE;

      const lottoNumbers = normalizeLottoNumbers(parsed.lottoNumbers);
      const manse = normalizeManse(parsed.manse);

      if (parsed.manse !== undefined && !manse) {
        functions.logger.warn("fortuneLotto manse schema mismatch", {
          code: "MANSE_SCHEMA_MISMATCH",
          hasManse: true,
          calendarTypeInput: isSolar ? "solar" : "lunar",
          isTimeKnown,
        });
      }

      return {totalFortuneText, moneyFortuneText, lottoNumbers, manse};
    } catch (e) {
      functions.logger.error("fortuneLotto error", e);
      functions.logger.warn("fortuneLotto manse parse error", {
        code: "MANSE_PARSE_ERROR",
        calendarTypeInput: isSolar ? "solar" : "lunar",
        isTimeKnown,
      });

      return {
        totalFortuneText: DEFAULT_FORTUNE_ERROR_MESSAGE,
        moneyFortuneText: DEFAULT_FORTUNE_ERROR_MESSAGE,
        lottoNumbers: [],
        manse: {
          calendarType: isSolar ? "solar" : "lunar",
          pillars: {
            year: {stem: "unknown", branch: "unknown", label: "unknown"},
            month: {stem: "unknown", branch: "unknown", label: "unknown"},
            day: {stem: "unknown", branch: "unknown", label: "unknown"},
            hour: {stem: "unknown", branch: "unknown", label: "unknown"},
          },
          fiveElements: {wood: 0, fire: 0, earth: 0, metal: 0, water: 0},
          note: DEFAULT_MANSE_NOTE,
        },
      };
    }
  }
);

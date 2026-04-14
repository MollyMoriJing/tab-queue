import { buildDueHint, buildDueAtFromPreset, deriveBucketFromDueAt } from "./date";
import type {
  BucketId,
  DueHint,
  Priority,
  ReminderPreset,
  SuggestionInput,
  SuggestionResult,
  VoiceCaptureResult,
  TranscriptSource
} from "./types";

type ParsedTime = {
  dueHint?: DueHint;
  cleanedText: string;
};

type ParsedTimeZone = {
  matched: string;
  timeZone: string;
};

type BuiltInAiCapability = {
  availability?: () => Promise<string>;
  create?: (options?: Record<string, unknown>) => Promise<{ prompt: (text: string) => Promise<string>; destroy?: () => void }>;
};

const SHOPPING_DOMAINS = ["amazon.", "ebay.", "bestbuy.", "etsy.", "walmart.", "target."];
const WORK_DOMAINS = ["github.", "docs.google.", "notion.", "linear.", "jira.", "figma.", "miro."];
const HIGH_PRIORITY_WORDS = /\b(asap|urgent|today|now|reply|submit|fix|ship|deadline|follow up|follow-up|pay)\b/i;
const RESEARCH_WORDS = /\b(read|watch|research|compare|browse|learn|reference|idea)\b/i;
const WEEKDAY_RULES = [
  { names: ["mon", "monday"], day: 1 },
  { names: ["tue", "tues", "tuesday"], day: 2 },
  { names: ["wed", "wednesday"], day: 3 },
  { names: ["thu", "thur", "thurs", "thursday"], day: 4 },
  { names: ["fri", "friday"], day: 5 },
  { names: ["sat", "saturday"], day: 6 },
  { names: ["sun", "sunday"], day: 0 }
] as const;
const MONTH_RULES = [
  { names: ["jan", "january"], month: 0 },
  { names: ["feb", "february"], month: 1 },
  { names: ["mar", "march"], month: 2 },
  { names: ["apr", "april"], month: 3 },
  { names: ["may"], month: 4 },
  { names: ["jun", "june"], month: 5 },
  { names: ["jul", "july"], month: 6 },
  { names: ["aug", "august"], month: 7 },
  { names: ["sep", "sept", "september"], month: 8 },
  { names: ["oct", "october"], month: 9 },
  { names: ["nov", "november"], month: 10 },
  { names: ["dec", "december"], month: 11 }
] as const;
const TIME_ZONE_RULES: Array<{ names: string[]; timeZone: string }> = [
  { names: ["pt", "pst", "pdt"], timeZone: "America/Los_Angeles" },
  { names: ["mt", "mst", "mdt"], timeZone: "America/Denver" },
  { names: ["ct", "cst", "cdt"], timeZone: "America/Chicago" },
  { names: ["et", "est", "edt"], timeZone: "America/New_York" }
];

function domainForUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function nextWeekday(targetDay: number): Date {
  const now = new Date();
  const date = new Date(now);
  const distance = (targetDay - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + distance);
  return date;
}

function getTimeZoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const zoned = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return asUtc - date.getTime();
}

function zonedDateTimeToIso(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timeZone: string
): string {
  const wallUtc = Date.UTC(year, month, day, hours, minutes, 0, 0);
  let guess = wallUtc - getTimeZoneOffsetMs(new Date(wallUtc), timeZone);

  for (let index = 0; index < 3; index += 1) {
    const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
    const nextGuess = wallUtc - offset;
    if (Math.abs(nextGuess - guess) < 1_000) {
      guess = nextGuess;
      break;
    }
    guess = nextGuess;
  }

  return new Date(guess).toISOString();
}

function parseTimeZone(text: string): ParsedTimeZone | null {
  for (const rule of TIME_ZONE_RULES) {
    const pattern = new RegExp(`\\b(${rule.names.join("|")})\\b`, "i");
    const match = text.match(pattern);
    if (match) {
      return {
        matched: match[0],
        timeZone: rule.timeZone
      };
    }
  }

  return null;
}

function parseClock(text: string): { hours: number; minutes: number; matched: string } | null {
  const noon = text.match(/\bnoon\b/i);
  if (noon) {
    return { hours: 12, minutes: 0, matched: noon[0] };
  }

  const morning = text.match(/\bmorning\b/i);
  if (morning) {
    return { hours: 9, minutes: 0, matched: morning[0] };
  }

  const afternoon = text.match(/\bafternoon\b/i);
  if (afternoon) {
    return { hours: 15, minutes: 0, matched: afternoon[0] };
  }

  const evening = text.match(/\bevening\b/i);
  if (evening) {
    return { hours: 19, minutes: 0, matched: evening[0] };
  }

  const exact = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (exact) {
    const hoursRaw = Number(exact[1]);
    const minutes = Number(exact[2] || 0);
    const suffix = exact[3].toLowerCase();
    const hours =
      suffix === "pm" && hoursRaw !== 12 ? hoursRaw + 12 : suffix === "am" && hoursRaw === 12 ? 0 : hoursRaw;
    return { hours, minutes, matched: exact[0] };
  }

  const military = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (military) {
    return {
      hours: Number(military[1]),
      minutes: Number(military[2]),
      matched: military[0]
    };
  }

  return null;
}

function parseAbsoluteDate(text: string): { date: Date; matched: string } | null {
  for (const rule of MONTH_RULES) {
    const pattern = new RegExp(
      `\\b(${rule.names.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`,
      "i"
    );
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const day = Number(match[2]);
    const explicitYear = match[3] ? Number(match[3]) : undefined;
    const now = new Date();
    const year = explicitYear ?? now.getFullYear();
    const date = new Date(year, rule.month, day);

    if (!explicitYear && date.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
      date.setFullYear(year + 1);
    }

    return {
      date,
      matched: match[0]
    };
  }

  const numeric = text.match(/\b(\d{1,2})([/.])(\d{1,2})(?:\2(\d{2,4}))?\b/);
  if (!numeric) {
    return null;
  }

  const month = Number(numeric[1]) - 1;
  const day = Number(numeric[3]);
  const rawYear = numeric[4] ? Number(numeric[4]) : undefined;
  const now = new Date();
  const year =
    rawYear === undefined ? now.getFullYear() : rawYear < 100 ? 2000 + rawYear : rawYear;
  const date = new Date(year, month, day);

  if (rawYear === undefined && date.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
    date.setFullYear(year + 1);
  }

  return {
    date,
    matched: numeric[0]
  };
}

function applyTime(date: Date, clock?: { hours: number; minutes: number }) {
  if (!clock) {
    return;
  }

  date.setHours(clock.hours, clock.minutes, 0, 0);
}

function parseTimeIntent(text: string): ParsedTime {
  let cleaned = text;
  let dueAt: string | undefined;
  let preset: ReminderPreset | undefined;
  const lowered = text.toLowerCase();
  const clock = parseClock(text);
  const absoluteDate = parseAbsoluteDate(text);
  const parsedZone = parseTimeZone(text);

  const toIso = (date: Date, timeZone?: string) => {
    if (!timeZone) {
      return date.toISOString();
    }

    return zonedDateTimeToIso(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      timeZone
    );
  };

  if (absoluteDate) {
    const date = new Date(absoluteDate.date);
    applyTime(date, clock ?? { hours: 9, minutes: 0 });
    dueAt = toIso(date, parsedZone?.timeZone);
    preset = "custom";
    cleaned = cleaned.replace(absoluteDate.matched, " ");
  }

  if (!dueAt && /\btonight\b/i.test(text)) {
    preset = "tonight";
    dueAt = buildDueAtFromPreset("tonight");
    cleaned = cleaned.replace(/\btonight\b/gi, " ");
  } else if (!dueAt && /\btomorrow\b/i.test(text)) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    applyTime(tomorrow, clock ?? { hours: 9, minutes: 0 });
    dueAt = toIso(tomorrow, parsedZone?.timeZone);
    preset = clock ? "custom" : "tomorrow";
    cleaned = cleaned.replace(/\btomorrow\b/gi, " ");
  } else if (!dueAt && /\b(this )?weekend\b/i.test(text)) {
    preset = "weekend";
    dueAt = buildDueAtFromPreset("weekend");
    cleaned = cleaned.replace(/\b(this )?weekend\b/gi, " ");
  } else if (!dueAt) {
    for (const rule of WEEKDAY_RULES) {
      const pattern = new RegExp(`\\b(${rule.names.join("|")})\\b`, "i");
      const match = lowered.match(pattern);
      if (match) {
        const target = nextWeekday(rule.day);
        applyTime(target, clock ?? { hours: 9, minutes: 0 });
        dueAt = toIso(target, parsedZone?.timeZone);
        preset = "custom";
        cleaned = cleaned.replace(pattern, " ");
        break;
      }
    }
  }

  if (!dueAt && clock && !preset) {
    const today = new Date();
    applyTime(today, clock);
    if (today.getTime() > Date.now()) {
      dueAt = toIso(today, parsedZone?.timeZone);
      preset = "custom";
    }
  }

  if (clock) {
    cleaned = cleaned.replace(clock.matched, " ");
  }

  if (parsedZone) {
    cleaned = cleaned.replace(new RegExp(`\\b${parsedZone.matched}\\b`, "i"), " ");
  }

  const normalized = cleaned.replace(/\s+/g, " ").trim();
  return {
    dueHint: dueAt
      ? {
          preset: preset ?? "custom",
          dueAt,
          label:
            preset && preset !== "custom"
              ? buildDueHint(preset)?.label ?? `By ${new Date(dueAt).toLocaleString()}`
              : `By ${new Date(dueAt).toLocaleString()}`
        }
      : undefined,
    cleanedText: normalized
  };
}

function withBuiltInAiCapability(): BuiltInAiCapability | null {
  const candidate = globalThis as unknown as {
    LanguageModel?: BuiltInAiCapability;
  };

  return candidate.LanguageModel ?? null;
}

function defaultPriority(note: string, title: string, domain: string): Priority {
  const combined = `${title} ${note}`;

  if (HIGH_PRIORITY_WORDS.test(combined)) {
    return "high";
  }

  if (WORK_DOMAINS.some((entry) => domain.includes(entry))) {
    return "medium";
  }

  if (SHOPPING_DOMAINS.some((entry) => domain.includes(entry)) || RESEARCH_WORDS.test(combined)) {
    return "low";
  }

  return "medium";
}

function defaultBucket(note: string, title: string, domain: string, dueHint?: DueHint, dueAt?: string): BucketId {
  if (dueHint?.dueAt) {
    return deriveBucketFromDueAt(dueHint.dueAt);
  }

  if (dueAt) {
    return deriveBucketFromDueAt(dueAt);
  }

  const combined = `${title} ${note}`;
  if (HIGH_PRIORITY_WORDS.test(combined)) {
    return "today";
  }

  if (SHOPPING_DOMAINS.some((entry) => domain.includes(entry))) {
    return "later";
  }

  if (WORK_DOMAINS.some((entry) => domain.includes(entry))) {
    return "week";
  }

  return "later";
}

export function quickParse(input: SuggestionInput): { note?: string; dueHint?: DueHint } {
  const raw = input.quickInput?.trim() ?? "";
  if (!raw) {
    return {
      note: input.note?.trim() || undefined,
      dueHint: input.dueAt
        ? {
            preset: "custom",
            dueAt: input.dueAt,
            label: `By ${new Date(input.dueAt).toLocaleString()}`
          }
        : undefined
    };
  }

  const parsed = parseTimeIntent(raw);
  return {
    note: parsed.cleanedText || undefined,
    dueHint: parsed.dueHint
  };
}

export function suggestFromRules(input: SuggestionInput): SuggestionResult {
  const parsed = quickParse(input);
  const note = parsed.note ?? input.note?.trim() ?? "";
  const dueHint = input.dueAt
    ? {
        preset: "custom" as const,
        dueAt: input.dueAt,
        label: `By ${new Date(input.dueAt).toLocaleString()}`
      }
    : parsed.dueHint;
  const domain = domainForUrl(input.url);

  return {
    bucket: defaultBucket(note, input.title, domain, dueHint, input.dueAt),
    priority: defaultPriority(note, input.title, domain),
    dueHint,
    confidence: dueHint || HIGH_PRIORITY_WORDS.test(`${input.title} ${note}`) ? 0.76 : 0.58,
    source: "rules"
  };
}

export async function suggestWithProviders(input: SuggestionInput): Promise<SuggestionResult> {
  const fallback = suggestFromRules(input);
  const capability = withBuiltInAiCapability();

  if (!capability?.availability || !capability.create) {
    return fallback;
  }

  try {
    const availability = await capability.availability();
    if (availability !== "available") {
      return fallback;
    }

    const session = await capability.create();
    const response = await session.prompt(
      [
        "Return strict JSON only.",
        "You are helping classify one browser tab into a lightweight queue.",
        'Allowed bucket: "today" | "week" | "later" | "waiting".',
        'Allowed priority: "low" | "medium" | "high".',
        'Allowed due preset: "tonight" | "tomorrow" | "weekend" | null.',
        `Title: ${input.title}`,
        `URL: ${input.url}`,
        `Quick input: ${input.quickInput ?? ""}`,
        `Note: ${input.note ?? ""}`
      ].join("\n")
    );
    session.destroy?.();

    const parsed = JSON.parse(response) as {
      bucket?: BucketId;
      priority?: Priority;
      duePreset?: ReminderPreset | null;
      confidence?: number;
    };

    const aiHint =
      parsed.duePreset && parsed.duePreset !== "none" && parsed.duePreset !== "custom"
        ? buildDueHint(parsed.duePreset)
        : undefined;

    if (!parsed.bucket || !parsed.priority) {
      return fallback;
    }

    return {
      bucket: parsed.bucket,
      priority: parsed.priority,
      dueHint: aiHint ?? fallback.dueHint,
      confidence: parsed.confidence ?? 0.7,
      source: "built_in_ai"
    };
  } catch {
    return fallback;
  }
}

export function parseVoiceTranscript(transcript: string, transcriptSource: TranscriptSource): VoiceCaptureResult {
  const parsed = quickParse({
    title: "",
    url: "",
    quickInput: transcript
  });

  return {
    note: parsed.note || transcript.trim(),
    dueHint: parsed.dueHint,
    transcriptSource
  };
}

export function dueHintToDueAt(dueHint?: DueHint): string | undefined {
  if (!dueHint) {
    return undefined;
  }

  if (dueHint.preset === "custom") {
    return dueHint.dueAt;
  }

  return buildDueAtFromPreset(dueHint.preset, dueHint.dueAt);
}

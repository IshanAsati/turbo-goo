import { LLMError, complete, hasLLM, parseJSON } from "./llm";
import { addDays, busyLabel, crossesMidnight, daysLabel, fromMin, isoDay, nowStamp, plannerSettings, toMin } from "./planTime";
import type { Settings } from "./types";

// Date and time helpers live in planTime.ts and are re-exported so imports from "./schedule" keep working.
export { DAY_NAMES, addDays, busyLabel, busyLength, busyOn, crossesMidnight, daysLabel, diffDays, fromMin, isoDay, longDate, nowStamp, parseDay, shortDate, toMin, validBusy, validDay, windowLength } from "./planTime";

/**
 * Study planner. The form's inputs go to the AI as they were entered, and the AI answers with the whole plan as JSON.
 * The app does not place, check or change sessions.
 */

export type Confidence = "weak" | "ok" | "strong";
/** `minutes`: one fixed block of this length (for example a 3-hour sample paper). Unset means flexible. */
export type PlanTopic = { name: string; level: Confidence; minutes?: number };
/** `to` at or before `from` runs past midnight. `days` empty means every day; `date` means only that day. */
export type Busy = { label: string; days: number[]; from: string; to: string; date?: string; auto?: boolean };
export type PlanForm = {
  goal: string;
  topics: PlanTopic[];
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD, the exam or deadline
  weekdays: number[]; // 0 = Sunday ... 6 = Saturday
  from: string; // HH:MM
  to: string; // HH:MM; earlier than `from` means the next morning
  busy: Busy[];
  hours?: number; // older saved forms had a length in hours instead of an end time
  session: number; // preferred session length in minutes
  notes: string;
};
export type PlanKind = "learn" | "practice" | "revise" | "test";
export type PlanSession = {
  start: string;
  minutes: number;
  topic: string;
  task: string;
  kind: PlanKind;
  /** starts after midnight, still part of this study day */
  late?: boolean;
  /** problems and warnings from older planner versions; kept so saved plans still open */
  issue?: string;
};
export type PlanDay = { date: string; sessions: PlanSession[] };
export type Plan = {
  title: string;
  summary: string;
  days: PlanDay[];
  tips: string[];
  createdAt: number;
  /** the inputs the plan was built from, in words */
  used?: string[];
  note?: string;
  problems?: string[];
  warnings?: string[];
};

/* ---------------- form ---------------- */

export function defaultForm(now = new Date()): PlanForm {
  const today = isoDay(now);
  return { goal: "", topics: [{ name: "", level: "ok" }], start: today, end: addDays(today, 13), weekdays: [0, 1, 2, 3, 4, 5, 6], from: "17:00", to: "20:00", busy: [], session: 45, notes: "" };
}

/** The one thing the AI can't plan without: something to study and a deadline. Everything else is up to the AI. */
export function formProblem(f: PlanForm): string {
  if (!f.topics.some((t) => t.name.trim())) return "Add at least one subject or topic.";
  if (!f.end) return "Pick the exam or deadline date.";
  return "";
}

/** What the plan was built around, in plain words, shown above the result. */
export function describeForm(f: PlanForm): string[] {
  const out = [`${f.from}-${f.to}${crossesMidnight(f) ? " (past midnight)" : ""}, ${f.weekdays.length ? daysLabel(f.weekdays) : "any day"}`, `${f.session}-minute sessions`];
  for (const t of f.topics) if (t.name.trim() && t.minutes) out.push(`${t.name.trim()}: one ${t.minutes}-minute block`);
  for (const b of f.busy) out.push(`avoiding ${busyLabel(b)}`);
  return out;
}

/* ---------------- the AI call ---------------- */

const SYSTEM = `Make a study plan from the inputs you are given. Reply with one JSON object and nothing else, in this shape:
{"title": string, "summary": string, "tips": [string], "days": [{"date": "YYYY-MM-DD", "sessions": [{"start": "HH:MM", "minutes": number, "topic": string, "task": string, "kind": "learn" | "practice" | "revise" | "test"}]}]}`;

/** The form's inputs as plain text, exactly as the student entered them. */
function inputsText(f: PlanForm, now: Date): string {
  const topics = f.topics
    .filter((t) => t.name.trim())
    .map((t) => `- ${t.name.trim()} (${t.level}${t.minutes ? `, fixed length ${t.minutes} minutes` : ""})`);
  return [
    `Now: ${nowStamp(now)}`,
    `Goal: ${f.goal.trim() || "(none)"}`,
    `Topics:\n${topics.join("\n") || "(none)"}`,
    `Start date: ${f.start}`,
    `Exam or deadline: ${f.end}`,
    `Study days: ${f.weekdays.length ? daysLabel(f.weekdays) : "any day"}`,
    `Daily window: ${f.from} to ${f.to}${crossesMidnight(f) ? " (runs past midnight)" : ""}`,
    `Preferred session length: ${f.session} minutes`,
    `Busy times:\n${f.busy.map((b) => `- ${busyLabel(b)}`).join("\n") || "(none)"}`,
    `Notes from the student:\n${f.notes.trim() || "(none)"}`,
  ].join("\n");
}

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** Asks the AI for the plan and returns it as the AI wrote it. Throws when there is no key or the reply isn't JSON. */
export async function makePlan(s: Settings, f: PlanForm, o: { signal?: AbortSignal } = {}, now = new Date()): Promise<Plan> {
  if (!hasLLM(s)) throw new LLMError("Add an AI key in Settings to make a plan.");
  const reply = await complete(plannerSettings(s), "smart", [{ role: "system", content: SYSTEM }, { role: "user", content: inputsText(f, now) }], { json: true, signal: o.signal });
  const j = parseJSON<Record<string, unknown>>(reply);
  if (!j) throw new LLMError(`The AI didn't reply with JSON. It said: ${reply.trim().slice(0, 200)}`);
  const topics = f.topics.map((t) => t.name.trim()).filter(Boolean);
  return {
    title: str(j.title) || f.goal.trim() || `${topics[0] ?? "Study"} plan`,
    summary: str(j.summary),
    tips: Array.isArray(j.tips) ? j.tips.map(str).filter(Boolean) : [],
    days: Array.isArray(j.days) ? (j.days as PlanDay[]) : [],
    createdAt: Date.now(),
    used: describeForm(f),
  };
}

/* ---------------- saved form and plan ---------------- */

export const SAVE_KEY = "tg:schedule:v1";
export function loadSaved(): { form: PlanForm; plan: Plan | null } | null {
  try {
    const j = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null");
    if (j?.form && Array.isArray(j.form.topics)) {
      const form: PlanForm = { ...defaultForm(), ...j.form };
      if (!j.form.to && typeof j.form.hours === "number") form.to = fromMin(Math.min(24 * 60 - 1, toMin(form.from) + Math.round(j.form.hours * 60)));
      if (!Array.isArray(form.busy)) form.busy = [];
      return { form, plan: j.plan ?? null };
    }
  } catch {
    /* corrupt or blocked storage: start fresh */
  }
  return null;
}
export function save(form: PlanForm, plan: Plan | null) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ form, plan }));
  } catch {
    /* storage full or blocked */
  }
}

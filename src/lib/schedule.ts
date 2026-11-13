import { LLMError, complete, hasLLM, parseJSON } from "./llm";
import { addDays, busyLabel, busyOn, crossesMidnight, daysLabel, fromMin, isoDay, nowStamp, parseDay, plannerSettings, toMin, validBusy, validDay, windowLength } from "./planTime";
import type { Settings } from "./types";

// Date and time helpers live in planTime.ts and are re-exported so imports from "./schedule" keep working.
export { DAY_NAMES, addDays, busyLabel, busyLength, busyOn, crossesMidnight, daysLabel, diffDays, fromMin, isoDay, longDate, nowStamp, parseDay, shortDate, toMin, validBusy, validDay, windowLength } from "./planTime";

/**
 * Study planner. The form's inputs go to the AI as they are, and the AI answers with the whole plan as JSON.
 * Nothing else decides the schedule: no code places sessions, and when the AI fails the planner says so.
 */

export type Confidence = "weak" | "ok" | "strong";
/** `minutes`: one fixed block of exactly this length (for example a 3-hour sample paper). Unset means flexible. */
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
  /** a problem to show next to the session (set by older checks; the AI planner doesn't set it) */
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
  /** problems and warnings from older planner versions; kept so saved plans still open */
  problems?: string[];
  warnings?: string[];
};

export const MAX_DAYS = 42;
const MIN_STRETCH = 20; // a free stretch shorter than this can't hold a session

/* ---------------- form ---------------- */

export function defaultForm(now = new Date()): PlanForm {
  const today = isoDay(now);
  return { goal: "", topics: [{ name: "", level: "ok" }], start: today, end: addDays(today, 13), weekdays: [0, 1, 2, 3, 4, 5, 6], from: "17:00", to: "20:00", busy: [], session: 45, notes: "" };
}

/** Why the form can't be sent yet, or "" when it can. */
export function formProblem(f: PlanForm, now = new Date()): string {
  if (!f.topics.some((t) => t.name.trim())) return "Add at least one subject or topic.";
  if (!validDay(f.end)) return "Pick the exam or deadline date.";
  if (!f.weekdays.length) return "Pick at least one study day.";
  if (!Number.isFinite(toMin(f.from)) || !Number.isFinite(toMin(f.to))) return "Enter a start and an end time.";
  if (windowLength(f) < 30) return "The study window has to be at least 30 minutes long.";
  if (f.end < isoDay(now)) return "That date is in the past.";
  if (!slotsFor(f, now).length) return "There's no free time left in that range. Try a later deadline, a wider daily window, or fewer busy times.";
  return "";
}

/** A study day with the free stretches left after busy times (minutes from that day's midnight). */
export type Slot = { date: string; free: [number, number][]; startMin: number; budget: number };

function subtract(free: [number, number][], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of free) {
    if (to <= a || from >= b) out.push([a, b]);
    else {
      if (from > a) out.push([a, from]);
      if (to < b) out.push([to, b]);
    }
  }
  return out;
}

/** Every study day in the range, with the time left after busy times. Today starts at the current time. */
export function slotsFor(f: PlanForm, now = new Date()): Slot[] {
  const today = isoDay(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const open = toMin(f.from);
  const close = Number.isFinite(toMin(f.to)) ? open + windowLength(f) : open + Math.round((f.hours ?? 3) * 60);
  const first = f.start && f.start > today ? f.start : today;
  const last = f.end < addDays(first, MAX_DAYS - 1) ? f.end : addDays(first, MAX_DAYS - 1);
  const out: Slot[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!f.weekdays.includes(parseDay(d).getDay())) continue;
    let free: [number, number][] = [[d === today ? Math.max(open, Math.ceil((nowMin + 10) / 5) * 5) : open, close]];
    for (const x of busyOn(d, f.busy)) free = subtract(free, x.a, x.z);
    free = free.filter(([a, z]) => z - a >= MIN_STRETCH);
    const budget = free.reduce((n, [a, z]) => n + (z - a), 0);
    if (free.length && budget >= Math.min(30, f.session)) out.push({ date: d, free, startMin: free[0][0], budget });
  }
  return out;
}

/** What the plan was built around, in plain words, shown above the result. */
export function describeForm(f: PlanForm): string[] {
  const out = [`${f.from}-${f.to}${crossesMidnight(f) ? " (past midnight)" : ""}, ${daysLabel(f.weekdays)}`, `${f.session}-minute sessions`];
  for (const t of f.topics) if (t.name.trim() && t.minutes) out.push(`${t.name.trim()}: one ${t.minutes}-minute block`);
  for (const b of f.busy) if (validBusy(b)) out.push(`avoiding ${busyLabel(b)}`);
  return out;
}

/* ---------------- the AI call ---------------- */

const SYSTEM = `You make a study plan for a student. Use only the inputs you are given.

Reply with one JSON object and nothing else:
{"title": string, "summary": string, "tips": [string], "days": [{"date": "YYYY-MM-DD", "sessions": [{"start": "HH:MM", "minutes": number, "topic": string, "task": string, "kind": "learn" | "practice" | "revise" | "test"}]}]}

Rules:
- Times are 24-hour HH:MM. A session that runs past midnight stays on the same day.
- Plan only from the start date to the deadline, on the study days, inside the daily window.
- Never schedule study during a busy time, or during anything the student's notes say they are busy with.
- Use only the topics given. A topic with a fixed length is one session of exactly that length.
- Leave a short break between sessions. Give each topic enough sessions, weaker topics more.
- "summary" and "tips" must not contain clock times.`;

/** The form's inputs as plain text, exactly as the student entered them. */
function inputsText(f: PlanForm, now: Date): string {
  const topics = f.topics
    .filter((t) => t.name.trim())
    .map((t) => `- ${t.name.trim()} (${t.level === "weak" ? "weak" : t.level === "strong" ? "strong" : "okay"}${t.minutes ? `, one fixed block of ${t.minutes} minutes` : ""})`);
  const busy = f.busy.filter(validBusy).map((b) => `- ${busyLabel(b)}`);
  return [
    `Now: ${nowStamp(now)}`,
    `Goal: ${f.goal.trim() || "(none)"}`,
    `Topics:\n${topics.join("\n") || "(none)"}`,
    `Start date: ${f.start}`,
    `Exam or deadline: ${f.end}`,
    `Study days: ${daysLabel(f.weekdays)}`,
    `Daily window: ${f.from} to ${f.to}${crossesMidnight(f) ? " (runs past midnight)" : ""}`,
    `Preferred session length: ${f.session} minutes`,
    `Busy times (no study during these):\n${busy.join("\n") || "(none)"}`,
    `Notes from the student:\n${f.notes.trim() || "(none)"}`,
  ].join("\n");
}

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const kinds = ["learn", "practice", "revise", "test"];

/** Asks the AI for the plan and returns it as the AI wrote it. Throws when there is no key or the reply isn't a plan. */
export async function makePlan(s: Settings, f: PlanForm, o: { signal?: AbortSignal } = {}, now = new Date()): Promise<Plan> {
  if (!hasLLM(s)) throw new LLMError("Add an AI key in Settings to make a plan.");
  const reply = await complete(plannerSettings(s), "smart", [{ role: "system", content: SYSTEM }, { role: "user", content: inputsText(f, now) }], { json: true, signal: o.signal, temperature: 0.3, maxTokens: 6000 });
  const j = parseJSON<Record<string, unknown>>(reply);
  if (!j || !Array.isArray(j.days)) throw new LLMError(`The AI's reply wasn't a plan. It said: ${reply.trim().slice(0, 200)}`);
  const days: PlanDay[] = (j.days as Record<string, unknown>[]).map((d) => ({
    date: str(d?.date),
    sessions: (Array.isArray(d?.sessions) ? (d.sessions as Record<string, unknown>[]) : []).map((x) => ({
      start: str(x?.start),
      minutes: Number(x?.minutes) || 0,
      topic: str(x?.topic),
      task: str(x?.task),
      kind: (kinds.includes(str(x?.kind)) ? str(x?.kind) : "practice") as PlanKind,
    })),
  }));
  const topics = f.topics.map((t) => t.name.trim()).filter(Boolean);
  return {
    title: str(j.title) || f.goal.trim() || `${topics[0] ?? "Study"} plan`,
    summary: str(j.summary),
    tips: Array.isArray(j.tips) ? j.tips.map(str).filter(Boolean) : [],
    days,
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
      // a fixed length is kept only when it is a positive number of minutes
      form.topics = j.form.topics.map((t: PlanTopic) => {
        const { minutes, ...rest } = t;
        return typeof minutes === "number" && minutes > 0 ? { ...rest, minutes } : rest;
      });
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

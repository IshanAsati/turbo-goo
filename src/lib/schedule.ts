import { LLMError, complete, hasLLM, parseJSON } from "./llm";
import type { Settings } from "./types";

/**
 * Study schedule maker. The AI is told the current date and time and is handed the exact list of days and minutes
 * it may use, so the plan can never start in the past or land on a day the student ruled out. Whatever it returns
 * is then repaired in code (dates, times, overlaps, budgets). Without an API key, or if the model fails, a
 * deterministic offline plan is built from the same slots.
 */

export type Confidence = "weak" | "ok" | "strong";
export type PlanTopic = { name: string; level: Confidence };
export type PlanForm = {
  goal: string;
  topics: PlanTopic[];
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD, the exam or deadline (last day that can be studied)
  weekdays: number[]; // 0 = Sunday ... 6 = Saturday
  from: string; // HH:MM, when the daily window opens
  hours: number; // length of the daily window in hours
  session: number; // preferred session length in minutes
  notes: string;
};
export type PlanKind = "learn" | "practice" | "revise" | "test";
export type PlanSession = { start: string; minutes: number; topic: string; task: string; kind: PlanKind };
export type PlanDay = { date: string; sessions: PlanSession[] };
export type Plan = { title: string; summary: string; days: PlanDay[]; tips: string[]; createdAt: number; offline?: boolean; note?: string };

export const MAX_DAYS = 42;
export const KINDS: PlanKind[] = ["learn", "practice", "revise", "test"];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------------- dates (all local time) ---------------- */

const p2 = (n: number) => String(n).padStart(2, "0");
export const isoDay = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** Noon local time, so adding days never trips over a daylight-saving change. */
export const parseDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12);
};
export const addDays = (iso: string, n: number) => {
  const d = parseDay(iso);
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
export const diffDays = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
export const validDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDay(parseDay(s)) === s;
export const toMin = (hm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : NaN;
};
export const fromMin = (n: number) => `${p2(Math.floor(n / 60) % 24)}:${p2(n % 60)}`;
export const longDate = (iso: string) => parseDay(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const shortDate = (iso: string) => parseDay(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "Thursday, 12 November 2026, 14:35 (Asia/Calcutta, UTC+05:30)": what the model is told about "now". */
export function nowStamp(now = new Date()): string {
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "local time";
    }
  })();
  const off = -now.getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  return `${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${p2(now.getHours())}:${p2(now.getMinutes())} (${tz}, UTC${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)})`;
}

/* ---------------- form ---------------- */

export function defaultForm(now = new Date()): PlanForm {
  const today = isoDay(now);
  return { goal: "", topics: [{ name: "", level: "ok" }], start: today, end: addDays(today, 13), weekdays: [0, 1, 2, 3, 4, 5, 6], from: "17:00", hours: 3, session: 45, notes: "" };
}

/** Why the form can't be turned into a plan yet, or "" when it can. */
export function formProblem(f: PlanForm, now = new Date()): string {
  if (!f.topics.some((t) => t.name.trim())) return "Add at least one subject or topic.";
  if (!validDay(f.end)) return "Pick the exam or deadline date.";
  if (!f.weekdays.length) return "Pick at least one study day.";
  if (!Number.isFinite(toMin(f.from))) return "Enter a valid start time.";
  if (f.end < isoDay(now)) return "That date is in the past.";
  if (!slotsFor(f, now).length) return "There's no time left in that range. Try a later deadline, an earlier daily start, or more hours.";
  return "";
}

export type Slot = { date: string; startMin: number; budget: number };

/** Every day the student can study, with when the first session may start and how many minutes the day has. Today is trimmed to what is left of it. */
export function slotsFor(f: PlanForm, now = new Date()): Slot[] {
  const today = isoDay(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const open = toMin(f.from);
  const close = Math.min(24 * 60 - 1, open + Math.round(f.hours * 60));
  const first = f.start && f.start > today ? f.start : today;
  const last = f.end < addDays(first, MAX_DAYS - 1) ? f.end : addDays(first, MAX_DAYS - 1);
  const out: Slot[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!f.weekdays.includes(parseDay(d).getDay())) continue;
    let startMin = open;
    if (d === today) startMin = Math.max(open, Math.ceil((nowMin + 10) / 5) * 5); // never schedule into the past
    const budget = close - startMin;
    if (budget >= Math.min(30, f.session)) out.push({ date: d, startMin, budget });
  }
  return out;
}

/* ---------------- offline plan ---------------- */

const TASKS: Record<PlanKind, string[]> = {
  learn: ["Read the chapter once, then write short notes in your own words.", "Learn the key definitions and formulas, then close the book and recall them.", "Work through the solved examples and note the method for each type."],
  practice: ["Solve a set of exam-style questions without looking at the notes, then mark yourself.", "Redo the questions you got wrong last time, then try three new ones.", "Do a timed question set and write out full answers."],
  revise: ["Revise from your notes and flashcards, then test yourself on the weak points.", "Quick recall: write down everything you remember, then check what you missed.", "Go through formulas and key terms, then fix the mistakes you keep making."],
  test: ["Take a full timed mock paper, then mark it and list what to fix.", "Self-test on all topics, then spend the last minutes on the gaps."],
};

export function offlinePlan(f: PlanForm, now = new Date()): Plan {
  const topics = f.topics.filter((t) => t.name.trim());
  const slots = slotsFor(f, now);
  const weight = { weak: 3, ok: 2, strong: 1 } as const;
  const bag = topics.flatMap((t) => Array<PlanTopic>(weight[t.level]).fill(t));
  const seen = new Map<string, number>();
  let n = 0;
  const gap = 10;
  const days: PlanDay[] = slots.map((slot, di) => {
    const sessions: PlanSession[] = [];
    let at = slot.startMin;
    const end = slot.startMin + slot.budget;
    const lastThird = di >= Math.floor(slots.length * 0.75);
    const lastDay = di === slots.length - 1;
    while (at + Math.min(f.session, 30) <= end) {
      const minutes = Math.min(f.session, end - at);
      if (minutes < 20) break;
      // rotate through the topics, but not the same one twice in a day while another is available
      let t = bag[n % bag.length];
      for (let k = 1; k < bag.length && sessions.some((x) => x.topic === t.name.trim()) && topics.length > sessions.length; k++) t = bag[(n + k) % bag.length];
      n++;
      const times = seen.get(t.name) ?? 0;
      seen.set(t.name, times + 1);
      const kind: PlanKind = lastDay && sessions.length === 0 && slots.length > 2 ? "test" : lastThird ? "revise" : times === 0 ? "learn" : "practice";
      const pool = TASKS[kind];
      sessions.push({ start: fromMin(at), minutes, topic: t.name.trim(), task: pool[(times + di) % pool.length], kind });
      at += minutes + gap;
    }
    return { date: slot.date, sessions };
  });
  const total = days.reduce((a, d) => a + d.sessions.length, 0);
  return {
    title: f.goal.trim() || `${topics[0].name.trim()}${topics.length > 1 ? ` + ${topics.length - 1} more` : ""} study plan`,
    summary: `${total} sessions across ${days.length} study days, from ${shortDate(days[0]?.date ?? f.start)} to ${shortDate(days[days.length - 1]?.date ?? f.end)}. Weaker topics come up more often, and the last days are for revision and a mock test.`,
    days,
    tips: ["Study the hardest topic first, while your head is fresh.", "After each session, close the book and write down three things you remember.", "Sleep before an exam beats an extra late-night hour."],
    createdAt: Date.now(),
    offline: true,
  };
}

/* ---------------- AI plan ---------------- */

function promptFor(s: Settings, f: PlanForm, slots: Slot[], now: Date) {
  const cbse = (s.curriculum ?? "cbse10") === "cbse10";
  const system = `You are a careful study planner. Build a day-by-day study schedule that a real student can follow.

HARD RULES
- Use ONLY the dates in "Available days". Never invent other dates. A day's first session may not start before its "from" time, and the sessions plus the short breaks between them must fit its "minutes" budget.
- Session "minutes": a multiple of 5, between 20 and 90, near the preferred ${f.session} minutes. Leave 5-10 minutes between sessions, so each start time is the previous start plus its minutes plus the break. Times are 24-hour HH:MM.
- Every topic gets a first "learn" session early. Then "practice" sessions. Weak topics get more sessions and come earlier; strong topics fewer.
- The last 20-25% of the days are mainly "revise" sessions that mix topics. The final available day includes one "test" session (a timed mock paper or full self-test) and nothing heavy.
- Mix different topics within a day so the student doesn't tire; avoid the same topic back-to-back unless it is large.
- "task": one concrete instruction in at most 18 words, e.g. "Solve 10 questions on the quadratic formula, then redo the ones you missed". Name a chapter or exercise only if you are sure it exists. Never write vague tasks like "study chapter".
- Be realistic about workload. Do not exceed the budget of any day, and do not cover topics the student did not list.${cbse ? "\n- The student is preparing for CBSE Class 10 (NCERT). Use NCERT chapter names and board-exam style practice." : ""}
- "tips": 3-5 short, specific tips for THIS plan, not generic advice.

Schema: {"title":string (max 8 words),"summary":string (2 sentences),"tips":[string],"days":[{"date":"YYYY-MM-DD","sessions":[{"start":"HH:MM","minutes":number,"topic":string,"task":string,"kind":"learn"|"practice"|"revise"|"test"}]}]}`;
  const today = isoDay(now);
  const user = `Current date and time: ${nowStamp(now)}. Today is ${today}.
Goal: ${f.goal.trim() || "(not stated)"}
Exam or deadline: ${f.end} (${Math.max(0, diffDays(today, f.end))} days from today)
Topics:
${f.topics.filter((t) => t.name.trim()).map((t) => `- ${t.name.trim()} (${t.level === "weak" ? "weak, needs the most work" : t.level === "strong" ? "already strong" : "okay"})`).join("\n")}
Daily window: opens at ${f.from}, ${f.hours} hour${f.hours === 1 ? "" : "s"} long. Preferred session: ${f.session} minutes.
Student's notes: ${f.notes.trim() || "(none)"}

Available days (${slots.length}):
${slots.map((x) => `${x.date} ${shortDate(x.date).split(",")[0]} - from ${fromMin(x.startMin)}, ${x.budget} minutes${x.date === today ? " (today: only what is left of the day)" : ""}`).join("\n")}`;
  return { system, user };
}

/** Pulls whatever the model sent into a valid plan: real dates only, valid times, no overlaps, no day over budget. */
export function repairPlan(raw: unknown, f: PlanForm, now = new Date()): Plan | null {
  const slots = new Map(slotsFor(f, now).map((x) => [x.date, x]));
  const r = raw as { title?: unknown; summary?: unknown; tips?: unknown; days?: unknown } | null;
  if (!r || !Array.isArray(r.days)) return null;
  const byDate = new Map<string, PlanDay>();
  for (const d of r.days as { date?: unknown; sessions?: unknown }[]) {
    if (!validDay(d?.date) || !slots.has(d.date) || !Array.isArray(d.sessions)) continue;
    const slot = slots.get(d.date)!;
    const end = slot.startMin + slot.budget;
    const sessions: PlanSession[] = [];
    let at = slot.startMin;
    const list = (d.sessions as Record<string, unknown>[])
      .filter((x) => x && typeof x.topic === "string" && String(x.topic).trim())
      .map((x) => ({ x, s: toMin(String(x.start ?? "")) }))
      .sort((a, b) => (Number.isFinite(a.s) && Number.isFinite(b.s) ? a.s - b.s : 0));
    for (const { x, s } of list) {
      const minutes = Math.min(120, Math.max(15, Math.round(Number(x.minutes) / 5) * 5 || f.session));
      const start = Math.max(at, Number.isFinite(s) ? s : at);
      if (start + minutes > end + 5) continue; // does not fit in the day
      const kind = KINDS.includes(x.kind as PlanKind) ? (x.kind as PlanKind) : "practice";
      sessions.push({ start: fromMin(start), minutes, topic: String(x.topic).trim().slice(0, 80), task: String(x.task ?? "").trim().slice(0, 200), kind });
      at = start + minutes + 5;
    }
    if (sessions.length) byDate.set(d.date, { date: d.date, sessions: [...(byDate.get(d.date)?.sessions ?? []), ...sessions].sort((a, b) => toMin(a.start) - toMin(b.start)) });
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return null;
  const topics = f.topics.filter((t) => t.name.trim());
  return {
    title: (typeof r.title === "string" && r.title.trim().slice(0, 70)) || f.goal.trim() || `${topics[0].name.trim()} study plan`,
    summary: typeof r.summary === "string" ? r.summary.trim().slice(0, 500) : "",
    tips: Array.isArray(r.tips) ? r.tips.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 200)).slice(0, 6) : [],
    days,
    createdAt: Date.now(),
  };
}

/** Builds the plan with the AI; falls back to the offline plan (and says so) when there is no key or the model fails. */
export async function makePlan(s: Settings, f: PlanForm, o: { signal?: AbortSignal } = {}, now = new Date()): Promise<Plan> {
  if (!hasLLM(s)) return { ...offlinePlan(f, now), note: "No AI key is set, so this plan was built by TurboGoo's simple planner. Add a key in Settings for a smarter, more specific one." };
  const slots = slotsFor(f, now);
  const { system, user } = promptFor(s, f, slots, now);
  let why = "";
  for (let i = 0; i < 2; i++) {
    if (o.signal?.aborted) throw new LLMError("Cancelled.");
    try {
      const out = await complete(s, "smart", [{ role: "system", content: system + "\nRespond with a single valid JSON object only. No prose." }, { role: "user", content: user }], { json: true, signal: o.signal, temperature: 0.4, maxTokens: Math.min(12000, 1500 + slots.length * 450) });
      const plan = repairPlan(parseJSON<unknown>(out), f, now);
      if (plan) {
        if (!plan.summary) plan.summary = offlinePlan(f, now).summary;
        if (!plan.tips.length) plan.tips = offlinePlan(f, now).tips;
        return plan;
      }
      why = "The AI's plan had no usable days.";
    } catch (e) {
      if (o.signal?.aborted) throw e;
      why = e instanceof Error ? e.message : String(e);
      if (e instanceof LLMError && e.status && e.status < 500 && e.status !== 429) break; // auth / not-found: a second try won't help
    }
  }
  return { ...offlinePlan(f, now), note: `The AI couldn't build the plan (${why.replace(/\.$/, "")}), so this one comes from TurboGoo's simple planner. Try Regenerate in a moment.` };
}

/* ---------------- saved form and plan ---------------- */

const KEY = "tg:schedule:v1";
export function loadSaved(): { form: PlanForm; plan: Plan | null } | null {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (j?.form && Array.isArray(j.form.topics)) return { form: { ...defaultForm(), ...j.form }, plan: j.plan ?? null };
  } catch {
    /* corrupt or blocked storage: start fresh */
  }
  return null;
}
export function save(form: PlanForm, plan: Plan | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ form, plan }));
  } catch {
    /* storage full or blocked */
  }
}

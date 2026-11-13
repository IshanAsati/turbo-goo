import { LLMError, complete, hasLLM, parseJSON } from "./llm";
import { addDays, busyLabel, busyOn, crossesMidnight, daysLabel, diffDays, fromMin, isoDay, nowStamp, parseDay, plannerSettings, shortDate, toMin, validBusy, validDay, windowLength } from "./planTime";
import type { Settings } from "./types";
import { modelFor } from "./llm";
import { checkPlan } from "./planCheck";
import { mergeBusy, notesWarnings, readNotes } from "./planNotes";
import type { NotesRead } from "./planNotes";
import { newLog, saveLog } from "./planLog";
import type { PlanAttempt } from "./planLog";

// The date and time helpers live in planTime.ts; they are re-exported so existing imports from "./schedule" keep working.
export { DAY_NAMES, addDays, busyLabel, busyLength, busyOn, crossesMidnight, daysLabel, diffDays, fromMin, isoDay, longDate, nowStamp, parseDay, shortDate, toMin, validBusy, validDay, windowLength } from "./planTime";

/**
 * Study schedule maker. The AI writes the schedule. TurboGoo tells it the current date and time and the exact free
 * stretches of every study day, then checks what comes back against the student's rules (planCheck.ts), sends any
 * broken rule back to the model to fix, and shows whatever is still wrong instead of quietly editing it.
 * Without an API key, or if the model fails, a simple offline plan is built from the same free time.
 */

export type Confidence = "weak" | "ok" | "strong";
/** `minutes`: one fixed block of exactly this length (for example a 3-hour sample paper). Unset means flexible. */
export type PlanTopic = { name: string; level: Confidence; minutes?: number };
/**
 * A time the student can't study. `to` at or before `from` runs past midnight (sleep 23:30-07:00).
 * `days` empty means every day; `date` (YYYY-MM-DD) means only that one day. `auto`: found in the notes by the AI.
 */
export type Busy = { label: string; days: number[]; from: string; to: string; date?: string; auto?: boolean };
export type PlanForm = {
  goal: string;
  topics: PlanTopic[];
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD, the exam or deadline (last day that can be studied)
  weekdays: number[]; // 0 = Sunday ... 6 = Saturday
  from: string; // HH:MM, when the daily window opens
  to: string; // HH:MM, when it closes. Earlier than `from` means the next morning (17:00 to 02:00).
  busy: Busy[]; // times that are not available, e.g. tuition
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
  /** a rule this session still breaks (set by planCheck.ts), shown next to it */
  issue?: string;
};
export type PlanDay = { date: string; sessions: PlanSession[] };
export type Plan = {
  title: string;
  summary: string;
  days: PlanDay[];
  tips: string[];
  createdAt: number;
  offline?: boolean;
  note?: string;
  /** the inputs this plan was built around, in words */
  used?: string[];
  /** problems with the inputs: a commitment in the notes without a time, a bedtime inside the study window */
  warnings?: string[];
  /** rules the plan still breaks after the retries; shown under "Check these" */
  problems?: string[];
  /** how many times the AI was asked (1 = right first time) */
  attempts?: number;
  /** id of the saved AI log for this plan (planLog.ts) */
  logId?: string;
  /** busy times the AI found in the notes; the screen adds them to the form so they stay visible and editable */
  addedBusy?: Busy[];
};

export const MAX_DAYS = 42;
export const KINDS: PlanKind[] = ["learn", "practice", "revise", "test"];

/* ---------------- form ---------------- */

export function defaultForm(now = new Date()): PlanForm {
  const today = isoDay(now);
  return { goal: "", topics: [{ name: "", level: "ok" }], start: today, end: addDays(today, 13), weekdays: [0, 1, 2, 3, 4, 5, 6], from: "17:00", to: "20:00", busy: [], session: 45, notes: "" };
}

/** Why the form can't be turned into a plan yet, or "" when it can. */
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

/** A study day: its free stretches (minutes from that day's midnight; past 1440 is after midnight), when the first starts, and the free minutes in total. */
export type Slot = { date: string; free: [number, number][]; startMin: number; budget: number };

const MIN_STRETCH = 20; // a free stretch shorter than this can't hold a session

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

/**
 * Every day the student can study, with the free stretches left after busy times. Today starts at the current time,
 * so nothing is ever scheduled in the past. `extraBusy` adds blocks that are not in the form (found in the notes).
 */
export function slotsFor(f: PlanForm, now = new Date(), extraBusy: Busy[] = []): Slot[] {
  const today = isoDay(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const open = toMin(f.from);
  const close = Number.isFinite(toMin(f.to)) ? open + windowLength(f) : open + Math.round((f.hours ?? 3) * 60); // may be past 24:00
  const first = f.start && f.start > today ? f.start : today;
  const last = f.end < addDays(first, MAX_DAYS - 1) ? f.end : addDays(first, MAX_DAYS - 1);
  const busy = [...(f.busy ?? []), ...extraBusy];
  const out: Slot[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!f.weekdays.includes(parseDay(d).getDay())) continue;
    let free: [number, number][] = [[d === today ? Math.max(open, Math.ceil((nowMin + 10) / 5) * 5) : open, close]];
    for (const x of busyOn(d, busy)) free = subtract(free, x.a, x.z);
    free = free.filter(([a, z]) => z - a >= MIN_STRETCH);
    const budget = free.reduce((n, [a, z]) => n + (z - a), 0);
    if (free.length && budget >= Math.min(30, f.session)) out.push({ date: d, free, startMin: free[0][0], budget });
  }
  return out;
}

/** What the plan was built around, in plain words, shown above the result so the student can see their inputs were used. */
export function describeForm(f: PlanForm, extraBusy: Busy[] = []): string[] {
  const out = [`${f.from}-${f.to}${crossesMidnight(f) ? " (past midnight)" : ""}, ${daysLabel(f.weekdays)}`, `${f.session}-minute sessions`];
  for (const t of f.topics) if (t.name.trim() && t.minutes) out.push(`${t.name.trim()}: one ${t.minutes}-minute block`);
  for (const b of [...(f.busy ?? []), ...extraBusy]) if (validBusy(b)) out.push(`avoiding ${busyLabel(b)}${b.auto ? " (from your notes)" : ""}`);
  return out;
}
/* ---------------- offline plan ---------------- */

const TASKS: Record<PlanKind, string[]> = {
  learn: ["Read the chapter once, then write short notes in your own words.", "Learn the key definitions and formulas, then close the book and recall them.", "Work through the solved examples and note the method for each type."],
  practice: ["Solve a set of exam-style questions without looking at the notes, then mark yourself.", "Redo the questions you got wrong last time, then try three new ones.", "Do a timed question set and write out full answers."],
  revise: ["Revise from your notes and flashcards, then test yourself on the weak points.", "Quick recall: write down everything you remember, then check what you missed.", "Go through formulas and key terms, then fix the mistakes you keep making."],
  test: ["Take a full timed mock paper, then mark it and list what to fix.", "Self-test on all topics, then spend the last minutes on the gaps."],
};
const OFFLINE_TIPS = ["Study the hardest topic first, while your head is fresh.", "After each session, close the book and write down what you remember.", "Sleep before an exam beats an extra late-night hour."];
const BREAK = 10; // minutes between sessions in the offline plan
/** A topic that looks like a paper, exam or test: it goes in the latest day that fits. */
const PAPER = /\b(paper|papers|exam|exams|test|tests|mock|mocks)\b/i;
/** Fixed length in minutes, or 0 for a flexible topic. */
const fixedMin = (t: PlanTopic) => (typeof t.minutes === "number" && t.minutes > 0 ? Math.round(t.minutes) : 0);

/**
 * Builds a plan without the AI, from the same free time the AI gets. Fixed-length topics go first, each as one block in
 * the first free stretch that fits. The rest of the free time is filled with the other topics, weak ones more often.
 * The result goes through checkPlan, so anything it breaks is listed like an AI mistake.
 */
export function offlinePlan(f: PlanForm, now = new Date(), note?: string): Plan {
  const topics = f.topics.filter((t) => t.name.trim()).map((t) => ({ ...t, name: t.name.trim() }));
  const slots = slotsFor(f, now);
  const gaps = slots.map((s) => s.free.map(([a, z]) => [a, z] as [number, number]));
  const items: { di: number; at: number; minutes: number; topic: string; kind: PlanKind; task: string }[] = [];

  // Takes the first stretch of day `di` that holds `minutes`, starting at its beginning. Returns the start, or null.
  const takeFirst = (di: number, minutes: number): number | null => {
    for (let g = 0; g < gaps[di].length; g++) {
      const [a, z] = gaps[di][g];
      if (z - a < minutes) continue;
      const rest: [number, number][] = [];
      if (z - (a + minutes + BREAK) >= MIN_STRETCH) rest.push([a + minutes + BREAK, z]);
      gaps[di].splice(g, 1, ...rest);
      return a;
    }
    return null;
  };

  // 1. fixed-length topics, one block each
  for (const t of topics.filter((t) => fixedMin(t) > 0)) {
    const order = slots.map((_, i) => i);
    const test = PAPER.test(t.name);
    if (test) order.reverse();
    for (const di of order) {
      const at = takeFirst(di, fixedMin(t));
      if (at === null) continue;
      const kind: PlanKind = test ? "test" : "practice";
      items.push({ di, at, minutes: fixedMin(t), topic: t.name, kind, task: TASKS[kind][0] });
      break;
    }
  }

  // 2. the rest of the free time, rotating through the flexible topics; weak 3, ok 2, strong 1
  const weight = { weak: 3, ok: 2, strong: 1 } as const;
  const bag = topics.filter((t) => !fixedMin(t)).flatMap((t) => Array<PlanTopic>(weight[t.level]).fill(t));
  const seen = new Map<string, number>();
  const lateDay = (di: number) => slots.length > 1 && di >= Math.floor(slots.length * 0.75);
  let n = 0;
  if (bag.length)
    slots.forEach((_, di) => {
      let prev = "";
      for (const [a, z] of gaps[di]) {
        let at = a;
        while (z - at >= MIN_STRETCH) {
          let minutes = Math.min(f.session, z - at);
          if (z - at - minutes < MIN_STRETCH) minutes = Math.min(z - at, 120); // no stub too short for a session: give it to this one
          let t = bag[n % bag.length];
          for (let k = 1; k < bag.length && t.name === prev; k++) t = bag[(n + k) % bag.length];
          n++;
          prev = t.name;
          const times = seen.get(t.name) ?? 0;
          seen.set(t.name, times + 1);
          const kind: PlanKind = times === 0 ? "learn" : lateDay(di) ? "revise" : "practice";
          items.push({ di, at, minutes, topic: t.name, kind, task: TASKS[kind][(times + di) % TASKS[kind].length] });
          at += minutes + BREAK;
        }
      }
    });

  const days: PlanDay[] = slots
    .map((slot, di) => ({
      date: slot.date,
      sessions: items
        .filter((x) => x.di === di)
        .sort((p, q) => p.at - q.at)
        .map((x) => ({ start: fromMin(x.at), minutes: x.minutes, topic: x.topic, task: x.task, kind: x.kind, late: x.at >= 24 * 60 || undefined })),
    }))
    .filter((d) => d.sessions.length);
  const title = f.goal.trim() || `${topics[0]?.name ?? "Study"}${topics.length > 1 ? ` + ${topics.length - 1} more` : ""} study plan`;
  const raw: Plan = {
    title,
    summary: "Weaker topics get more sessions than strong ones.",
    days,
    tips: OFFLINE_TIPS,
    createdAt: Date.now(),
  };
  const checked = checkPlan(raw, f, slots, f.busy, { now });
  return { ...(checked.plan ?? raw), problems: checked.problems, offline: true, used: describeForm(f), note };
}

/* ---------------- AI plan ---------------- */

const JSON_ONLY = "\nRespond with a single valid JSON object only. No prose.";
const span = (a: number, z: number) => `${fromMin(a)}-${fromMin(z)}${z >= 24 * 60 ? " (after midnight)" : ""}`;
/** "Sat 14 Nov": the short date without the comma, as the prompt writes it. */
const dayName = (date: string) => shortDate(date).replace(",", "");
/** The study days that have one free stretch of at least `minutes`. */
const fitDays = (slots: Slot[], minutes: number) => slots.filter((x) => x.free.some(([a, z]) => z - a >= minutes));
/** One concrete place for a fixed-length block: the latest fitting day for a paper or test, else the first; the start of its first long-enough stretch. */
function suggestSlot(slots: Slot[], t: PlanTopic): string | null {
  const m = fixedMin(t);
  const days = fitDays(slots, m);
  const day = PAPER.test(t.name) ? days[days.length - 1] : days[0];
  const stretch = day?.free.find(([a, z]) => z - a >= m);
  return day && stretch ? `${dayName(day.date)} ${span(stretch[0], stretch[0] + m)}` : null;
}

/** The one-day or several-day prompt. Both give the exact free stretches, the busy times and the rules TurboGoo checks. */
function promptFor(s: Settings, f: PlanForm, slots: Slot[], busy: Busy[], notes: NotesRead, now: Date): { system: string; user: string } {
  const cbse = (s.curriculum ?? "cbse10") === "cbse10";
  const oneDay = slots.length <= 1;
  const today = isoDay(now);
  const topics = f.topics.filter((t) => t.name.trim());
  const fixed = topics.filter((t) => fixedMin(t) > 0);
  const wantsTest = PAPER.test([f.goal, f.notes, ...topics.map((t) => t.name)].join(" "));
  // where a fixed-length topic can go: every day, or the days with a free stretch long enough, and those stretches
  const fitWords = (m: number) => {
    const days = fitDays(slots, m);
    return days.length === slots.length ? "fits on any day" : `fits only on ${days.map((x) => dayName(x.date)).join(", ")}`;
  };
  const fixedRule = fixed.map((t) => {
    const m = fixedMin(t);
    const days = fitDays(slots, m);
    const where =
      days.length === slots.length
        ? "It fits on any day."
        : `It only fits on these days (a long enough free stretch): ${days.map((x) => `${dayName(x.date)} (${x.free.filter(([a, z]) => z - a >= m).map(([a, z]) => span(a, z)).join(", ")})`).join(", ")}. Put it inside one of those stretches.`;
    const latest = PAPER.test(t.name) ? " For a test, use the latest of these days." : "";
    const pick = suggestSlot(slots, t);
    return `- "${t.name.trim()}" must be ONE session of exactly ${m} minutes: one block inside a single free stretch. Never split it, shorten it or lengthen it. ${where}${latest}${pick ? ` Recommended: ${pick}. Plan the other sessions around it.` : ""}`;
  });
  const fillRule = notes.light
    ? "The student asked for a light plan: study about half of each day's free time, and leave 10-15 minute breaks between sessions."
    : "Fill at least 80% of each day's free time with study sessions. Leave 5-10 minute breaks between sessions.";
  const testRule = wantsTest
    ? `Include exactly one "test" session (a timed mock paper or a full self-test), because the goal, topics or notes mention a paper, exam, test or mock.`
    : `Never use kind "test": no paper, exam, test or mock was mentioned.`;
  const system = `You are a careful study planner. Build a day-by-day study schedule that a real student can follow.

HARD RULES
- Use ONLY the dates in "Available days". Never invent other dates.
- Each session must sit entirely inside ONE free stretch of its day: it may not start before the stretch starts, end after it ends, or overlap a busy time.
- Times are 24-hour HH:MM. A session that starts after midnight keeps the same study day and gets its real clock time, for example "00:30".
- Study sessions last 20-90 minutes, a multiple of 5, near the preferred ${f.session} minutes. Only a "test" may run longer, up to 180 minutes.
- Leave a 5-10 minute break between sessions: the next start is the previous start plus its minutes plus the break.
- Never schedule breaks, meals, rest, sleep, travel, or the student's own commitments (tuition, school, classes, gym and so on) as sessions. Leave that time empty.
- Every topic the student listed appears at least once. Never add topics the student did not list.
- ${fillRule}
- ${testRule}
- Weak topics get more sessions and come earlier. Strong topics get fewer.
- "task": one concrete instruction of at most 18 words, for example "Solve 10 questions on the quadratic formula, then redo the ones you missed". Name a chapter or exercise only when you are sure it exists. Never write a vague task such as "study chapter".
- Be realistic about workload. Do not exceed the minutes of any day.${cbse ? "\n- The student is preparing for CBSE Class 10 (NCERT). Use NCERT chapter names and board-exam style practice." : ""}
- "summary" and "tips" must NOT state clock times, dates, durations, counts or commitments. Talk about order, focus and technique instead. "tips" has 3-5 short tips for THIS plan.${fixedRule.length ? `\n\nFIXED-LENGTH TOPICS\n${fixedRule.join("\n")}` : ""}

${
  oneDay
    ? `ONE DAY
- Order: weak topics first, then the others. Harder work (learn, then practice) comes earlier in the day while the student is fresh, and revision comes later.
- Put the test, if there is one, in the longest free stretch.
- Mix the topics so the same topic never runs back to back.`
    : `SEVERAL DAYS
- Learn early: every topic gets its "learn" session in the first part of the plan.
- Then "practice" sessions. Weak topics get more of them.
- The last 20-25% of the days are mainly "revise" sessions that mix topics.
- If a test is wanted, put it on the last day that has a free stretch long enough for it (see FIXED-LENGTH TOPICS), with nothing heavy after it.`
}

Schema: {"title":string (max 8 words),"summary":string (2 sentences),"tips":[string],"days":[{"date":"YYYY-MM-DD","sessions":[{"start":"HH:MM","minutes":number,"topic":string,"task":string,"kind":"learn"|"practice"|"revise"|"test"}]}]}${JSON_ONLY}`;

  const user = `Current date and time: ${nowStamp(now)}. Today is ${today}.
Goal: ${f.goal.trim() || "(not stated)"}
Exam or deadline: ${f.end} (${Math.max(0, diffDays(today, f.end))} days from today)
Topics:
${topics.map((t) => `- ${t.name.trim()} (${t.level === "weak" ? "weak, needs the most work" : t.level === "strong" ? "already strong" : "okay"})${fixedMin(t) ? `, must be ONE session of exactly ${fixedMin(t)} minutes, ${fitWords(fixedMin(t))}` : ""}`).join("\n")}
Daily window: ${f.from} to ${f.to}${crossesMidnight(f) ? " (the window runs past midnight. A day's sessions may run on after 00:00: sort them by time, so after-midnight sessions come last in that day, with their real clock time, e.g. 00:30)" : ""}. Preferred session: ${f.session} minutes.
Not available (never schedule study here): ${busy.filter(validBusy).map(busyLabel).join("; ") || "nothing"}
${notes.bedtime ? `The student says they go to sleep at ${notes.bedtime}: where you can, end sessions before then.\n` : ""}Student's notes (follow them): ${f.notes.trim() || "(none)"}

Available days (${slots.length}). These free stretches are the only times you may use:
${slots.map((x) => `${x.date} (${parseDay(x.date).toLocaleDateString("en-GB", { weekday: "short" })}): free ${x.free.map(([a, z]) => span(a, z)).join(", ")}; ${x.budget} minutes${x.date === today ? " (today: only what is left of the day)" : ""}`).join("\n")}`;
  return { system, user };
}

/** Works out the plan with the AI, checks it, and sends broken rules back for up to three tries. Falls back to the offline plan when no try is usable. */
export async function makePlan(s: Settings, f: PlanForm, o: { signal?: AbortSignal; onStep?: (step: string) => void } = {}, now = new Date()): Promise<Plan> {
  if (!hasLLM(s)) {
    // the notes reader falls back to simple rules without a key, so times written in the notes are still kept free
    const notes = await readNotes(s, f, { signal: o.signal, now });
    const added = mergeBusy(f.busy, notes.busy);
    return {
      ...offlinePlan({ ...f, busy: [...f.busy, ...added] }, now, "No AI key is set, so this plan was built by TurboGoo's simple planner. Add a key in Settings for a smarter, more specific one."),
      warnings: notesWarnings(f, notes),
      addedBusy: added,
      used: describeForm(f, added),
    };
  }
  o.onStep?.("Reading your notes…");
  const notes = await readNotes(s, f, { signal: o.signal, now });
  const added = mergeBusy(f.busy, notes.busy);
  const busyAll = [...f.busy, ...added];
  const slots = slotsFor(f, now, added);
  const warnings = notesWarnings(f, notes);
  const used = describeForm(f, added);
  const withNotes: PlanForm = { ...f, busy: busyAll };
  if (!slots.length)
    return {
      ...offlinePlan(withNotes, now, added.length ? "Your notes' commitments use up all the free time in the study window, so nothing could be scheduled. Check the busy times in the form." : "There's no free time left in the study window, so nothing could be scheduled."),
      warnings,
      addedBusy: added,
      used,
    };

  // A fixed-length topic that fits no study day can't be met. Its warning goes in the plan, and the AI, the checker and the
  // fallback get a form without it, so retries aren't spent on a rule that can't be kept.
  const impossible = f.topics.filter((t) => t.name.trim() && fixedMin(t) > 0 && !fitDays(slots, fixedMin(t)).length);
  for (const t of impossible)
    warnings.push(`"${t.name.trim()}" needs one free stretch of ${fixedMin(t)} minutes, but none of your study days has one. It was left out of the plan. Widen the study window, move a busy time, or shorten it.`);
  const planForm: PlanForm = { ...withNotes, topics: withNotes.topics.filter((t) => !impossible.includes(t)) };
  if (!planForm.topics.some((t) => t.name.trim()))
    return {
      ...offlinePlan(planForm, now, "Every topic you listed needs a free stretch that no study day has, so nothing could be scheduled. See Before you start."),
      warnings,
      addedBusy: added,
      used,
    };

  const { system, user } = promptFor(s, planForm, slots, busyAll, notes, now);
  const log = newLog(modelFor(plannerSettings(s), "smart"), system, user);
  log.notes = { sent: notes.sent ?? "", reply: notes.reply ?? "", error: notes.error };
  const attempts: PlanAttempt[] = [];
  log.attempts = attempts;
  const maxTokens = Math.min(12000, 1500 + slots.length * 450);
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let best: { plan: Plan; problems: string[]; index: number } | null = null;
  let prevCount = 0;
  for (let k = 1; k <= 3; k++) {
    o.onStep?.(k === 1 ? "Asking the AI for a plan…" : prevCount ? `Fixing ${prevCount} ${prevCount === 1 ? "problem" : "problems"} (try ${k} of 3)…` : `Asking the AI again (try ${k} of 3)…`);
    const at = Date.now();
    const sent = messages[messages.length - 1].content;
    let reply = "";
    let problems: string[] = [];
    let plan: Plan | null = null;
    let error: string | undefined;
    let stop = false;
    try {
      reply = await complete(plannerSettings(s), "smart", messages, { json: true, signal: o.signal, temperature: 0.2, maxTokens });
      const parsed = parseJSON<unknown>(reply);
      if (parsed === null) problems = ["The reply wasn't valid JSON."];
      else {
        const res = checkPlan(parsed, planForm, slots, busyAll, { now, light: notes.light });
        plan = res.plan;
        problems = res.problems;
        if (!plan && !problems.length) problems = ["The plan has no usable sessions."];
      }
    } catch (e) {
      if (o.signal?.aborted) {
        log.outcome = "cancelled";
        saveLog(log);
        throw e;
      }
      error = e instanceof Error ? e.message : String(e);
      // a bad key or a missing model won't change on a retry
      stop = e instanceof LLMError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429;
    }
    attempts.push({ at, ms: Date.now() - at, sent, reply, problems, error });
    if (plan && (!best || problems.length < best.problems.length)) best = { plan, problems, index: attempts.length - 1 };
    if (plan && !problems.length) break;
    if (stop) break;
    // when a fixed-length block is wrong, repeat exactly where it can go: models tend to keep their first placement
    const reminders = planForm.topics
      .filter((t) => fixedMin(t) > 0 && problems.some((p) => p.includes(t.name.trim())))
      .map((t) => {
        const pick = suggestSlot(slots, t);
        return `- "${t.name.trim()}" is ONE session of exactly ${fixedMin(t)} minutes${pick ? `. Put it at ${pick}` : ""}. Never split it.`;
      });
    if (reply.trim()) messages.push({ role: "assistant", content: reply }, { role: "user", content: `Your plan breaks these rules:\n${problems.map((p) => `- ${p}`).join("\n")}${reminders.length ? `\n\nReminder:\n${reminders.join("\n")}` : ""}\nReturn the whole corrected plan as JSON in the same schema. Keep the parts that were fine.` });
    prevCount = problems.length;
  }

  const tries = attempts.length;
  if (best) {
    const left = best.problems.length;
    log.chosen = best.index;
    log.outcome = left ? `${left} ${left === 1 ? "problem" : "problems"} left after ${tries} ${tries === 1 ? "attempt" : "attempts"}` : `passed on attempt ${best.index + 1}`;
    saveLog(log);
    return {
      ...best.plan,
      tips: best.plan.tips.length ? best.plan.tips : OFFLINE_TIPS,
      problems: best.problems,
      warnings,
      attempts: tries,
      logId: log.id,
      addedBusy: added,
      used,
      note: left ? `The AI's plan still breaks ${left} ${left === 1 ? "rule" : "rules"} after ${tries} ${tries === 1 ? "try" : "tries"}. They're listed under Check these, and marked in the plan.` : undefined,
    };
  }
  const last = attempts[attempts.length - 1];
  const why = (last?.error ?? last?.problems[0] ?? "no usable plan").replace(/\.$/, "");
  log.chosen = -1;
  log.outcome = `fell back to the simple planner: ${why}`;
  saveLog(log);
  return {
    ...offlinePlan(planForm, now, `The AI couldn't build a usable plan (${why}), so this one comes from TurboGoo's simple planner.`),
    warnings,
    attempts: tries,
    logId: log.id,
    addedBusy: added,
    used,
  };
}

/* ---------------- saved form and plan ---------------- */

export const SAVE_KEY = "tg:schedule:v1";
const KEY = SAVE_KEY;
export function loadSaved(): { form: PlanForm; plan: Plan | null } | null {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null");
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
    localStorage.setItem(KEY, JSON.stringify({ form, plan }));
  } catch {
    /* storage full or blocked */
  }
}

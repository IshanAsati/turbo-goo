import type { Busy, Plan, PlanDay, PlanForm, PlanKind, PlanSession, Slot } from "./schedule";
import { busyOn, crossesMidnight, fromMin, isoDay, shortDate, toMin, validDay, windowLength } from "./planTime";

/**
 * Checks a plan the AI wrote against the student's rules. Sessions that break a rule stay in the plan with `issue`
 * set, and each broken rule is reported as one plain sentence in `problems`. The only edits are harmless clean-up
 * (trimmed text, "9:05" -> "09:05", sorted sessions, after-midnight starts marked `late`). Minutes and times never change.
 * See %TEMP%\tg-plan-harness\CONTRACT.md, section "planCheck.ts".
 */

export type CheckResult = { plan: Plan | null; problems: string[] };
export type CheckOptions = { now?: Date; light?: boolean };

const KINDS: PlanKind[] = ["learn", "practice", "revise", "test"];
const MAX_PROBLEMS = 30;

/** Words too common to identify a topic on their own. */
const GENERIC = new Set(["science", "maths", "math", "chapter", "topic", "topics", "questions", "practice", "revision", "revise", "paper", "sample", "class"]);
/** Words a revise or test session may use for a mixed session ("Mixed revision", "All topics", "Full mock test"). */
const MIX_WORDS = new Set([...GENERIC, "mixed", "mix", "all", "full", "mock", "overall", "whole", "combined", "general", "complete", "review", "test", "exam", "of", "and", "the", "last", "past", "final", "chapters"]);

/** Breaks, meals, and the student's own commitments. They are gaps in the day, not study. */
const BREAK_TOPIC = /\b(break|rest|lunch|dinner|breakfast|snack|meal|nap|sleep|shower|free time|buffer|gym|workout|tuition|coaching|school|class|commute|travel)\b/i;
const COMMITMENT = /\b(tuition|coaching|gym|school|college|dinner|lunch|sleep|nap|commute|travel)\b/i;
/** Clock times, durations and counts: facts the schedule already shows, which free text must not repeat. */
const HARD_FACTS = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b|\b\d+(?:\.\d+)?\s*[- ]?(?:hours?|hrs?|h|minutes?|mins?)\b|\b\d+\s+(?:\w+\s+){0,2}(?:questions?|sessions?|days?|papers?|problems?|topics?)\b/i;

/** Free text (summary sentences, tips) is kept only when it states no facts and no commitments. */
export function keepText(s: string): boolean {
  return !HARD_FACTS.test(s) && !COMMITMENT.test(s);
}

export function isBreakTopic(topic: string): boolean {
  return BREAK_TOPIC.test(topic);
}

/** A break for THIS student: a break word that is not part of one of their own topic names.
 *  "Class 10 Science" on a list that has it is study; "Physics tuition" when the list only has "Physics" is not. */
function isBreakFor(topic: string, topics: string[]): boolean {
  const own = topics.map((t) => ` ${norm(t)} `);
  const words = norm(topic).match(new RegExp(BREAK_TOPIC.source, "gi")) ?? [];
  return words.some((w) => !own.some((o) => o.includes(` ${w.toLowerCase()} `)));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Same topic: equal after normalising, one contains the other as whole words, or they share a word of 5+ letters that is not generic. */
function sameTopic(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || ` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `)) return true;
  const wy = new Set(y.split(" ").filter((w) => w.length >= 5 && !GENERIC.has(w)));
  return x.split(" ").some((w) => w.length >= 5 && !GENERIC.has(w) && wy.has(w));
}

/** The session topic is one of the student's topics, or (for revise and test) a mixed session built only from mix words. */
function onList(topic: string, kind: PlanKind, topics: string[]): boolean {
  if (topics.some((t) => sameTopic(topic, t))) return true;
  if (kind !== "revise" && kind !== "test") return false;
  const words = norm(topic).split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => MIX_WORDS.has(w));
}

/** A factual one-line summary computed from the final schedule, so it can never disagree with it. */
export function factsLine(plan: Plan): string {
  const sessions = plan.days.reduce((n, d) => n + d.sessions.length, 0);
  const minutes = plan.days.reduce((n, d) => n + d.sessions.reduce((a, s) => a + s.minutes, 0), 0);
  const hours = Math.round((minutes / 60) * 10) / 10;
  const days = plan.days.length;
  const topics = Array.from(new Set(plan.days.flatMap((d) => d.sessions.map((s) => s.topic))));
  const shown = topics.slice(0, 4);
  const list = topics.length > 4 ? `${shown.join(", ")} and ${topics.length - 4} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0] ?? "";
  return `${sessions} ${sessions === 1 ? "session" : "sessions"} over ${days} study ${days === 1 ? "day" : "days"}, ${hours} ${hours === 1 ? "hour" : "hours"} in total.${list ? ` Covers ${list}.` : ""}`;
}

/** Free time left after taking away the given intervals. */
function leftover(free: [number, number][], taken: [number, number][]): [number, number][] {
  let out = free;
  for (const [s, e] of taken) {
    out = out.flatMap(([a, z]): [number, number][] => {
      if (e <= a || s >= z) return [[a, z]];
      const parts: [number, number][] = [];
      if (s > a) parts.push([a, s]);
      if (e < z) parts.push([e, z]);
      return parts;
    });
  }
  return out;
}

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Item = { date: string; s: number; e: number; minutes: number; topic: string; kind: PlanKind; session: PlanSession };

export function checkPlan(raw: unknown, f: PlanForm, slots: Slot[], busy: Busy[], o: CheckOptions = {}): CheckResult {
  const now = o.now ?? new Date();
  const today = isoDay(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const open = toMin(f.from);
  const close = Number.isFinite(toMin(f.to)) ? open + windowLength(f) : open + Math.round((f.hours ?? 3) * 60);
  const topics = f.topics.map((t) => t.name.trim()).filter(Boolean);
  const fixed = f.topics.filter((t) => t.name.trim() && typeof t.minutes === "number" && t.minutes > 0);
  const sorted = [...slots].sort((a, b) => a.date.localeCompare(b.date));
  const slotOf = new Map(sorted.map((x) => [x.date, x]));

  const problems: string[] = [];
  const add = (p: string) => {
    if (!problems.includes(p)) problems.push(p);
  };

  const r = raw && typeof raw === "object" ? (raw as { title?: unknown; summary?: unknown; tips?: unknown; days?: unknown }) : null;
  if (!r || !Array.isArray(r.days)) return { plan: null, problems: ["The reply has no list of study days."] };

  // Clean up and drop what cannot be used. Sessions for the same date are merged.
  const byDate = new Map<string, Item[]>();
  for (const d of r.days as unknown[]) {
    const day = d && typeof d === "object" ? (d as { date?: unknown; sessions?: unknown }) : {};
    const date = day.date;
    const list = Array.isArray(day.sessions) ? day.sessions : [];
    if (!validDay(date)) {
      if (list.length) add(`A day dated "${String(date).slice(0, 20)}" isn't a valid date, so its sessions were dropped.`);
      continue;
    }
    if (!slotOf.has(date)) {
      if (list.length) add(`${shortDate(date)} isn't one of your study days, so its sessions were dropped.`);
      continue;
    }
    const items = byDate.get(date) ?? [];
    byDate.set(date, items);
    for (const x of list) {
      const q = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
      const start = typeof q.start === "string" ? q.start.trim() : "";
      const m = /^(\d{1,2}):(\d{2})$/.exec(start);
      const minutes = typeof q.minutes === "number" ? q.minutes : typeof q.minutes === "string" ? Number(q.minutes.trim()) : NaN;
      const topic = typeof q.topic === "string" ? q.topic.trim() : "";
      if (!m || +m[1] > 23 || +m[2] > 59 || !Number.isInteger(minutes) || minutes <= 0 || !topic) {
        add(`${shortDate(date)} a session is missing a valid start time, length or topic, so it was dropped.`);
        continue;
      }
      let s = toMin(start);
      let late = false;
      if (crossesMidnight(f) && s < open && s + 24 * 60 <= close) {
        s += 24 * 60; // 00:30 in a 17:00-02:00 window is 00:30 of the same study day; 13:50 stays 13:50 (before the window)
        late = true;
      }
      const kind: PlanKind = KINDS.includes(q.kind as PlanKind) ? (q.kind as PlanKind) : "practice";
      const session: PlanSession = { start: fromMin(s), minutes, topic: topic.slice(0, 80), task: typeof q.task === "string" ? q.task.trim().slice(0, 300) : "", kind };
      if (late) session.late = true;
      items.push({ date, s, e: s + minutes, minutes, topic: session.topic, kind, session });
    }
  }

  /** Rule 8: a day must use at least 80% of its free time (sessions plus gaps of 15 minutes or less). */
  const fillRule = (slot: Slot, items: Item[]) => {
    let used = 0;
    items.forEach((it, i) => {
      used += it.minutes;
      if (i > 0) {
        const gap = it.s - items[i - 1].e;
        if (gap >= 0 && gap <= 15) used += gap;
      }
    });
    if (used >= slot.budget * 0.8) return;
    const empty = leftover(slot.free, items.map((it): [number, number] => [it.s, it.e]))
      .filter(([a, z]) => z - a >= 30)
      .map(([a, z]) => `${fromMin(a)}-${fromMin(z)}`)
      .join(", ");
    add(`${shortDate(slot.date)} uses ${hm(used)} of ${hm(slot.budget)} free time. ${empty ? `Fill the empty time: ${empty}.` : "Fill the empty time with more study."}`);
  };

  const kept: Item[] = [];
  const days: PlanDay[] = [];
  for (const slot of sorted) {
    const items = (byDate.get(slot.date) ?? []).sort((a, b) => a.s - b.s);
    if (!items.length) {
      if (!o.light) fillRule(slot, []);
      continue;
    }
    kept.push(...items);
    const label = shortDate(slot.date);
    // Rules 1, 3, 4, 6: each session on its own.
    for (const it of items) {
      const { s, e, session } = it;
      const at = `${label} ${session.start}-${fromMin(e)} ${it.topic}`;
      const mark = (why: string) => {
        if (!session.issue) session.issue = cap(why);
      };
      // Rule 1: inside free time.
      const hit = busyOn(slot.date, busy).find((x) => s < x.z && x.a < e);
      let why = "";
      if (hit) why = `overlaps ${hit.b.label.trim() || "a busy time"} (${hit.b.from}-${hit.b.to}).`;
      else if (s < open) why = `starts before your ${fromMin(open)} start time.`;
      else if (e > close) why = `runs past your ${fromMin(close)} end time.`;
      else if (slot.date === today && s < nowMin) why = "is in the past.";
      else if (!slot.free.some(([a, z]) => s >= a && e <= z)) why = `is outside your free time (free: ${slot.free.map(([a, z]) => `${fromMin(a)}-${fromMin(z)}`).join(", ")}).`;
      if (why) {
        add(`${at} ${why}`);
        mark(why);
      }
      // Rule 3 (break or commitment) and rule 4 (one of the student's topics).
      if (isBreakFor(it.topic, topics)) {
        add(`${at} is a break or commitment, not study: leave that time free instead.`);
        mark("A break or commitment, not study. Leave this time free.");
      } else if (!onList(it.topic, it.kind, topics)) {
        add(`${at} isn't one of your topics.`);
        mark("Not one of your topics.");
      }
      // Rule 6: flexible sessions last 15-120 minutes; a test up to 240. Fixed-length topics are checked by rule 5.
      if (!fixed.some((t) => sameTopic(it.topic, t.name))) {
        const max = it.kind === "test" ? 240 : 120;
        if (it.minutes < 15 || it.minutes > max) {
          const why6 = `is ${it.minutes} minutes, but ${it.kind === "test" ? "a test" : "flexible sessions"} must last 15-${max} minutes.`;
          add(`${at} ${why6}`);
          mark(why6);
        }
      }
    }
    // Rule 2: no overlap between sessions of the same day.
    for (let j = 1; j < items.length; j++) {
      const b = items[j];
      const a = items.slice(0, j).find((x) => b.s < x.e && x.s < b.e);
      if (a) {
        const why2 = `overlaps ${a.topic} at ${a.session.start}.`;
        add(`${label} ${b.session.start}-${fromMin(b.e)} ${b.topic} ${why2}`);
        if (!b.session.issue) b.session.issue = cap(why2);
      }
    }
    // Rule 8: fill the free time.
    if (!o.light) fillRule(slot, items);
    days.push({ date: slot.date, sessions: items.map((it) => it.session) });
  }

  // Rule 5: fixed-length topics are exactly one session of that length.
  for (const t of fixed) {
    const name = t.name.trim();
    const mins = t.minutes as number;
    const mine = kept.filter((it) => sameTopic(it.topic, name));
    if (!mine.length) {
      add(`${name} needs one ${mins}-minute block, but the plan has none.`);
    } else if (mine.length > 1) {
      add(`${name} must be one ${mins}-minute block, not split into ${mine.length} sessions.`);
      for (const it of mine) if (!it.session.issue) it.session.issue = `Should be one ${mins}-minute block.`;
    } else if (mine[0].minutes !== mins) {
      const it = mine[0];
      add(`${name} must be one ${mins}-minute block; the plan has ${it.minutes} minutes (${shortDate(it.date)} ${it.session.start}-${fromMin(it.e)}).`);
      if (!it.session.issue) it.session.issue = `Should be one ${mins}-minute block.`;
    }
  }

  // Rule 7: every topic appears at least once (skipped when there is almost no free time).
  const freeTotal = sorted.reduce((n, x) => n + x.budget, 0);
  if (freeTotal >= 20 * topics.length) {
    for (const name of Array.from(new Set(topics))) {
      if (!kept.some((it) => !isBreakFor(it.topic, topics) && sameTopic(it.topic, name))) add(`${name} isn't in the plan.`);
    }
  }

  // The plan itself, with the model's text filtered by keepText.
  if (!days.length) {
    add("The reply has no sessions that could be used.");
    return { plan: null, problems: problems.slice(0, MAX_PROBLEMS) };
  }
  const firstTopic = topics[0] ?? "Study";
  const title = (typeof r.title === "string" ? r.title.trim().slice(0, 70) : "") || f.goal.trim().slice(0, 70) || `${firstTopic} plan`;
  const narrative = typeof r.summary === "string" ? (r.summary.match(/[^.!?]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x && keepText(x)).join(" ") : "";
  const tips = Array.isArray(r.tips) ? r.tips.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => t && keepText(t)).slice(0, 5) : [];
  const plan: Plan = { title, summary: "", tips, days, createdAt: Date.now(), problems: problems.slice(0, MAX_PROBLEMS) };
  plan.summary = [factsLine(plan), narrative].filter(Boolean).join(" ").slice(0, 500);
  return { plan, problems: plan.problems ?? [] };

}

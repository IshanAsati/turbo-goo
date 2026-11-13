import { LLMError, complete, hasLLM, parseJSON } from "./llm";
import { nowStamp, plannerSettings, toMin, fromMin } from "./planTime";
import type { Settings } from "./types";

// Date and time helpers live in planTime.ts. Re-exported for the PDF code.
export { fromMin, parseDay, toMin } from "./planTime";

/**
 * Study planner: the student types what they need to study, the AI answers with the plan as JSON.
 * The app doesn't place, check or change sessions.
 */

export type PlanKind = "learn" | "practice" | "revise" | "test";
export type PlanSession = {
  start: string;
  minutes: number;
  topic: string;
  task: string;
  kind: PlanKind;
  /** starts after midnight, still part of the study day it belongs to */
  late?: boolean;
  /** kept so plans saved by older versions still open */
  issue?: string;
};
export type PlanDay = { date: string; sessions: PlanSession[] };
export type Plan = {
  title: string;
  summary: string;
  days: PlanDay[];
  tips: string[];
  createdAt: number;
  /** kept so plans saved by older versions still open */
  used?: string[];
  note?: string;
  problems?: string[];
  warnings?: string[];
};

const SYSTEM = `Make a study plan from the student's message. Reply with one JSON object and nothing else, in this shape:
{"title": string, "summary": string, "tips": [string], "days": [{"date": "YYYY-MM-DD", "sessions": [{"start": "HH:MM", "minutes": number, "topic": string, "task": string, "kind": "learn" | "practice" | "revise" | "test"}]}]}`;

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** Sends the student's message (with the current time) to the AI and returns the plan it wrote. Throws when there is no key or the reply isn't JSON. */
export async function makePlan(s: Settings, request: string, o: { signal?: AbortSignal } = {}, now = new Date()): Promise<Plan> {
  if (!hasLLM(s)) throw new LLMError("Add an AI key in Settings to make a plan.");
  const user = `Now: ${nowStamp(now)}\n\n${request.trim()}`;
  const reply = await complete(plannerSettings(s), "smart", [{ role: "system", content: SYSTEM }, { role: "user", content: user }], { json: true, signal: o.signal });
  const j = parseJSON<Record<string, unknown>>(reply);
  if (!j) throw new LLMError(`The AI didn't reply with JSON. It said: ${reply.trim().slice(0, 200)}`);
  return {
    title: str(j.title) || "Study plan",
    summary: str(j.summary),
    tips: Array.isArray(j.tips) ? j.tips.map(str).filter(Boolean) : [],
    days: Array.isArray(j.days) ? (j.days as PlanDay[]) : [],
    createdAt: Date.now(),
  };
}

/* ---------------- saved text and plan ---------------- */

export const SAVE_KEY = "tg:schedule:v1";
export function loadSaved(): { text: string; plan: Plan | null } | null {
  try {
    const j = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null");
    if (j && typeof j === "object") return { text: typeof j.text === "string" ? j.text : "", plan: j.plan ?? null };
  } catch {
    /* corrupt or blocked storage: start fresh */
  }
  return null;
}
export function save(text: string, plan: Plan | null) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ text, plan }));
  } catch {
    /* storage full or blocked */
  }
}

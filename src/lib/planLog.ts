/**
 * Keeps what the planner sent to the AI and what came back, so a bad plan can be traced to the model or to TurboGoo.
 * The last KEEP logs live in localStorage, newest first. Storage errors are swallowed: a plan never fails because its log could not be saved.
 */

export type PlanAttempt = { at: number; ms: number; sent: string; reply: string; problems: string[]; error?: string };
export type PlanLog = {
  id: string;
  at: number;
  model: string;
  system: string;
  user: string;
  notes?: { sent: string; reply: string; error?: string };
  attempts: PlanAttempt[];
  /** index into `attempts` of the plan that was shown, or -1 when none was usable */
  chosen: number;
  /** one line: "passed on attempt 2", "3 problems left after 3 attempts", "fell back to the simple planner: ..." */
  outcome: string;
};

export const LOG_KEY = "tg:schedule:log:v1";
/** how many times the planner asks the AI for a plan */
export const TRIES = 3;
const KEEP = 5;
const CAP = 20000;

/** Shortens a long string so a few logs never fill localStorage. */
const cut = (s: string) => (s.length > CAP ? s.slice(0, CAP) + "... (cut)" : s);

/** Storage, or null when the browser blocks it (reading `localStorage` can throw too). */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isLog = (x: unknown): x is PlanLog => typeof x === "object" && x !== null && typeof (x as PlanLog).id === "string";

export function newLog(model: string, system: string, user: string): PlanLog {
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  return { id, at: Date.now(), model, system, user, attempts: [], chosen: -1, outcome: "" };
}

/** Saves a log, replacing an earlier save with the same id. The newest save goes first and only the last 5 are kept. */
export function saveLog(log: PlanLog): void {
  try {
    const short: PlanLog = {
      ...log,
      model: cut(log.model),
      system: cut(log.system),
      user: cut(log.user),
      outcome: cut(log.outcome),
      notes: log.notes && { ...log.notes, sent: cut(log.notes.sent), reply: cut(log.notes.reply), error: log.notes.error && cut(log.notes.error) },
      attempts: log.attempts.map((a) => ({ ...a, sent: cut(a.sent), reply: cut(a.reply), error: a.error && cut(a.error) })),
    };
    const next = [short, ...loadLogs().filter((x) => x.id !== log.id)].slice(0, KEEP);
    storage()?.setItem(LOG_KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked: the plan still shows, only its log is lost
  }
}

export function loadLogs(): PlanLog[] {
  try {
    const raw = storage()?.getItem(LOG_KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isLog) : [];
  } catch {
    return [];
  }
}

export function getLog(id: string): PlanLog | undefined {
  return loadLogs().find((x) => x.id === id);
}

/** Plain text of everything the planner sent and got back, for pasting into a bug report. */
export function logText(log: PlanLog): string {
  const out: string[] = [];
  const block = (title: string, body: string) => out.push(`----- ${title} -----`, body || "(empty)", "");
  const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);
  out.push(
    "TurboGoo planner log",
    `Time: ${new Date(log.at).toLocaleString()}`,
    `Model: ${log.model}`,
    `Outcome: ${log.outcome || "(none)"}`,
    `Shown: ${log.chosen >= 0 ? `attempt ${log.chosen + 1}` : "none"}`,
    "",
  );
  block("System prompt", log.system);
  block("User prompt", log.user);
  if (log.notes) {
    block("Notes call: sent", log.notes.sent);
    block("Notes call: reply", log.notes.reply);
    if (log.notes.error) block("Notes call: error", log.notes.error);
  }
  log.attempts.forEach((a, i) => {
    out.push(`===== Attempt ${i + 1} of ${TRIES} · ${secs(a.ms)} · ${new Date(a.at).toLocaleTimeString()} =====`, "");
    block("Sent", a.sent);
    block("Reply", a.reply);
    block("Problems", a.problems.length ? a.problems.map((p) => `- ${p}`).join("\n") : a.error ? "(not checked)" : "No problems found");
    if (a.error) block("Error", a.error);
  });
  return out.join("\n");
}

export function clearLogs(): void {
  try {
    storage()?.removeItem(LOG_KEY);
  } catch {
    // nothing to clear when storage is blocked
  }
}

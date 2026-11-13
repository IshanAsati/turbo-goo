import type { Busy, PlanForm } from "./schedule";

/**
 * Date and time helpers for the study planner. Everything is local time. Inside a study day, times are minutes from
 * that day's midnight: a value past 1440 is after midnight (a late night), a negative value is the evening before.
 */

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
/** "14:30" -> 870. Anything else -> NaN. */
export const toMin = (hm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? "").trim());
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : NaN;
};
/** 870 -> "14:30". Wraps past midnight (1530 -> "01:30") and before it (-30 -> "23:30"). */
export const fromMin = (n: number) => {
  const m = ((Math.round(n) % 1440) + 1440) % 1440;
  return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
};
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

/** Minutes between the daily start and end; an end at or before the start runs past midnight. */
export const windowLength = (f: Pick<PlanForm, "from" | "to">) => {
  const d = toMin(f.to) - toMin(f.from);
  return d > 0 ? d : d + 24 * 60;
};
export const crossesMidnight = (f: Pick<PlanForm, "from" | "to">) => toMin(f.to) <= toMin(f.from);

/** A busy time needs two valid times that differ. An end at or before the start runs past midnight (sleep 23:30-07:00). */
export const validBusy = (b: Busy) => Number.isFinite(toMin(b.from)) && Number.isFinite(toMin(b.to)) && toMin(b.to) !== toMin(b.from);
/** Length of a busy time in minutes, counting past midnight. */
export const busyLength = (b: Busy) => (((toMin(b.to) - toMin(b.from)) % 1440) + 1440) % 1440;

/**
 * The busy intervals that touch study day `date`, in minutes from that day's midnight.
 * A block belongs to the day it starts on. An overnight block from the evening before shows up with a negative
 * start, and one that starts this evening runs past 1440. `days` empty means every day; `date` means only that day.
 */
export function busyOn(date: string, busy: Busy[]): { b: Busy; a: number; z: number }[] {
  const out: { b: Busy; a: number; z: number }[] = [];
  for (const b of busy) {
    if (!validBusy(b)) continue;
    const from = toMin(b.from);
    const len = busyLength(b);
    for (const off of [-1, 0, 1]) {
      const day = addDays(date, off);
      if (b.date ? b.date !== day : b.days.length > 0 && !b.days.includes(parseDay(day).getDay())) continue;
      const a = from + off * 1440;
      out.push({ b, a, z: a + len });
    }
  }
  return out;
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
/** "Mon-Fri", "every day", "weekends", "Tue, Thu" ... */
export function daysLabel(days: number[]): string {
  const set = DAY_ORDER.filter((d) => days.includes(d));
  if (set.length === 7 || !set.length) return "every day";
  if (set.length === 5 && !days.includes(0) && !days.includes(6)) return "Mon-Fri";
  if (set.length === 2 && days.includes(0) && days.includes(6)) return "weekends";
  return set.map((d) => DAY_NAMES[d]).join(", ");
}

/** "Physics tuition 16:00-17:00, every day" / "Sleep 23:30-07:00 overnight, Mon-Fri" / "Gym 18:00-19:00, only Fri 13 Nov". */
export function busyLabel(b: Busy): string {
  const name = b.label.trim() || "Busy";
  const night = toMin(b.to) < toMin(b.from) ? " overnight" : "";
  return `${name} ${b.from}-${b.to}${night}, ${b.date ? "only " + shortDate(b.date) : daysLabel(b.days)}`;
}

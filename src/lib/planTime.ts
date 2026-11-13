import type { Settings } from "./types";

/** The few date and time helpers the planner uses. Local time. */

const p2 = (n: number) => String(n).padStart(2, "0");

/** "2026-11-13" -> a Date at noon, so day arithmetic never trips over daylight saving. */
export const parseDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12);
};

/** "14:30" -> 870. Anything else -> NaN. */
export const toMin = (hm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? "").trim());
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : NaN;
};

/** 870 -> "14:30". Wraps past midnight (1530 -> "01:30"). */
export const fromMin = (n: number) => {
  const m = ((Math.round(n) % 1440) + 1440) % 1440;
  return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
};

/** "2026-11-13" -> "Fri, 13 Nov". */
export const shortDate = (iso: string) => parseDay(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "Friday, 13 November 2026, 14:35 (Asia/Calcutta, UTC+05:30)": the current time, for the AI. */
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

/** The settings the planner's AI call uses: the Planner model if one is set, else the normal Smart model. */
export const plannerSettings = (s: Settings): Settings => {
  const m = (s.plannerModel ?? "").trim();
  return m ? { ...s, model: m, fastModel: m } : s;
};

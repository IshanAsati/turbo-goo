import regUrl from "../assets/fonts/PlusJakartaSans-Regular.ttf?url";
import semiUrl from "../assets/fonts/PlusJakartaSans-SemiBold.ttf?url";
import boldUrl from "../assets/fonts/PlusJakartaSans-ExtraBold.ttf?url";
import { Pdf, Ttf, hasUnsupported } from "./pdf";
import type { PdfFont } from "./pdf";
import { fromMin, parseDay, toMin } from "./schedule";
import type { Plan, PlanKind } from "./schedule";

/** Lays a study plan out as a clean, printable A4 PDF in Plus Jakarta Sans (the app's own typeface). */

const INK = "#1d1830";
const BODY = "#4a4566";
const MUTED = "#7a7494";
const LINE = "#e6e1f5";
const BOX = "#c9c1e6";
const BRAND = "#7f58ea";
const SOFT = "#f3effe";
const KIND: Record<PlanKind, { label: string; color: string; tint: string }> = {
  learn: { label: "LEARN", color: "#6a43d8", tint: "#efe9ff" },
  practice: { label: "PRACTICE", color: "#23805a", tint: "#e1f4ea" },
  revise: { label: "REVISE", color: "#b86a1f", tint: "#fdeedd" },
  test: { label: "TEST", color: "#c63a53", tint: "#fbe5ea" },
};
const M = 40;

/* ---------------- fonts (fetched once, only when a PDF is made) ---------------- */

let fontsLoad: Promise<Record<PdfFont, Ttf>> | null = null;
export function loadFonts(): Promise<Record<PdfFont, Ttf>> {
  fontsLoad ??= (async () => {
    const get = async (url: string, name: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't load the PDF font (${res.status}).`);
      return new Ttf(new Uint8Array(await res.arrayBuffer()), name);
    };
    const [reg, semi, bold] = await Promise.all([get(regUrl, "PlusJakartaSans-Regular"), get(semiUrl, "PlusJakartaSans-SemiBold"), get(boldUrl, "PlusJakartaSans-ExtraBold")]);
    return { reg, semi, bold };
  })().catch((e) => {
    fontsLoad = null; // allow a retry
    throw e;
  });
  return fontsLoad;
}

const dmy = (iso: string) => parseDay(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const plural = (n: number, one: string, many = one + "S") => (n === 1 ? one : many);
/** Monday-based week start of an ISO date. */
const weekStart = (iso: string) => {
  const d = parseDay(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function planHasUnsupportedText(plan: Plan) {
  return hasUnsupported([plan.title, plan.summary, ...plan.tips, ...(plan.problems ?? []), ...(plan.warnings ?? []), ...plan.days.flatMap((d) => d.sessions.flatMap((s) => [s.topic, s.task]))].join(" "));
}

export async function buildPlanPdf(plan: Plan, now = new Date()): Promise<Uint8Array> {
  const pdf = new Pdf(await loadFonts(), { title: plan.title, author: "TurboGoo" });
  const W = pdf.w;
  const H = pdf.h;
  const CW = W - M * 2;
  const bottom = H - 62;
  const first = plan.days[0]?.date;
  const last = plan.days[plan.days.length - 1]?.date;
  const sessions = plan.days.reduce((n, d) => n + d.sessions.length, 0);
  const minutes = plan.days.reduce((n, d) => n + d.sessions.reduce((a, s) => a + s.minutes, 0), 0);
  const manyWeeks = new Set(plan.days.map((d) => weekStart(d.date))).size > 1;

  /* ---- header band ---- */
  pdf.addPage();
  const titleLines = pdf.wrap(plan.title, "bold", 26, CW - 120).slice(0, 2);
  const extra = (titleLines.length - 1) * 31; // a two-line title moves the band, the cards and the body down
  pdf.rect(0, 0, W, 158 + extra, { fill: BRAND });
  pdf.circle(548, 40, 78, { fill: "#8e6bf0" });
  pdf.circle(478, 112 + extra, 38, { fill: "#6f48dc" });
  pdf.text(M, 46, "TURBOGOO  ·  STUDY PLAN", { font: "semi", size: 8.5, color: "#e1d8ff" });
  titleLines.forEach((l, i) => pdf.text(M, 84 + i * 31, l, { font: "bold", size: 26, color: "#ffffff" }));
  const subY = 84 + (titleLines.length - 1) * 31 + 28;
  if (first && last) {
    const year = parseDay(last).getFullYear();
    pdf.text(M, subY, first === last ? `${parseDay(first).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} ${year}` : `${dmy(first)} to ${dmy(last)} ${year}`, { font: "reg", size: 11, color: "#e9e2ff" });
  }

  /* ---- stat cards ---- */
  const hours = Math.round((minutes / 60) * 10) / 10;
  const stats: [string, string][] = [
    [String(plan.days.length), plural(plan.days.length, "STUDY DAY")],
    [String(sessions), plural(sessions, "SESSION")],
    [String(hours), hours === 1 ? "HOUR OF STUDY" : "HOURS OF STUDY"],
  ];
  const sw = (CW - 24) / 3;
  stats.forEach(([n, label], i) => {
    const x = M + i * (sw + 12);
    pdf.rect(x, 138 + extra, sw, 58, { fill: "#ffffff", stroke: LINE, lw: 1, r: 12 });
    pdf.text(x + 16, 169 + extra, n, { font: "bold", size: 22, color: BRAND });
    pdf.text(x + 16, 185 + extra, label, { font: "semi", size: 7.5, color: MUTED });
  });
  let y = 218 + extra;

  /* ---- summary + legend ---- */
  const continued = () => {
    pdf.addPage();
    pdf.text(M, 34, plan.title, { font: "semi", size: 8.5, color: MUTED });
    pdf.line(M, 42, W - M, 42, LINE, 1);
    y = 62;
  };

  /** A tinted box of bullet lines. When a bullet does not fit, the box ends and continues on the next page. */
  const noteBox = (title: string, items: string[], tint: string, accent: string) => {
    const wrapped = items.map((t) => pdf.wrap(t, "reg", 10, CW - 60));
    const itemH = (lines: string[]) => lines.length * 13.5 + 7;
    let i = 0;
    while (i < wrapped.length) {
      if (y + 48 + itemH(wrapped[i]) > bottom) continued();
      let h = 48;
      let j = i;
      while (j < wrapped.length && (j === i || y + h + itemH(wrapped[j]) <= bottom)) h += itemH(wrapped[j++]);
      pdf.rect(M, y, CW, h, { fill: tint, r: 12 });
      pdf.text(M + 18, y + 27, title, { font: "bold", size: 12, color: accent });
      let ty = y + 48;
      for (let k = i; k < j; k++) {
        pdf.circle(M + 22, ty - 3.5, 2.3, { fill: accent });
        wrapped[k].forEach((l, n) => pdf.text(M + 34, ty + n * 13.5, l, { font: "reg", size: 10, color: BODY }));
        ty += itemH(wrapped[k]);
      }
      y += h + 10;
      i = j;
    }
  };

  if (plan.summary) {
    const lines = pdf.wrap(plan.summary, "reg", 10.5, CW - 36);
    const h = 22 + lines.length * 15;
    pdf.rect(M, y, CW, h, { fill: SOFT, r: 12 });
    lines.forEach((l, i) => pdf.text(M + 18, y + 24 + i * 15, l, { font: "reg", size: 10.5, color: BODY }));
    y += h + 14;
  }
  if (plan.problems?.length) {
    noteBox("Check these", plan.problems, "#fbe5ea", "#c63a53");
    y += 4;
  }
  if (plan.warnings?.length) {
    noteBox("Before you start", plan.warnings, "#fdeedd", "#b86a1f");
    y += 4;
  }
  let lx = M;
  (Object.keys(KIND) as PlanKind[]).forEach((k) => {
    pdf.circle(lx + 4, y + 3.5, 3.5, { fill: KIND[k].color });
    const lab = KIND[k].label[0] + KIND[k].label.slice(1).toLowerCase();
    pdf.text(lx + 13, y + 7, lab, { font: "reg", size: 8.5, color: MUTED });
    lx += 13 + pdf.measure(lab, "reg", 8.5) + 16;
  });
  pdf.text(W - M, y + 7, "Tick the box when a session is done", { font: "reg", size: 8.5, color: MUTED, align: "right" });
  y += 28;

  /* ---- days ---- */
  let week = "";
  const X0 = M + 80; // left edge of the session column
  const XR = M + CW - 16;
  const TIME_W = 72;
  const topicX = X0 + 16 + TIME_W;
  for (const day of plan.days) {
    const ws = weekStart(day.date);
    const rows = day.sessions.map((s) => {
      const k = KIND[s.kind];
      const pillW = pdf.measure(k.label, "bold", 7) + 14;
      const durW = pdf.measure(`${s.minutes} min`, "reg", 8.5);
      const topicW = XR - pillW - durW - 18 - topicX;
      let topic = pdf.wrap(s.topic, "semi", 10.5, topicW);
      if (topic.length > 2) topic = [topic[0], pdf.fit(topic.slice(1).join(" "), "semi", 10.5, topicW)];
      const task = pdf.wrap(s.task, "reg", 9.5, XR - (X0 + 16)).slice(0, 3);
      return { s, topic, task, pillW };
    });
    const rowH = (r: { task: string[]; topic: string[] }) => 24 + (r.topic.length - 1) * 13.5 + Math.max(1, r.task.length) * 12.5;
    const cardH = Math.max(68, 14 + rows.reduce((n, r) => n + rowH(r), 0));
    const showWeek = manyWeeks && ws !== week;
    if (y + cardH + (showWeek ? 26 : 0) > bottom) continued();
    if (showWeek) {
      week = ws;
      pdf.text(M, y + 10, `WEEK OF ${dmy(ws).toUpperCase()}`, { font: "semi", size: 8, color: MUTED });
      pdf.line(M + 84, y + 7, W - M, y + 7, LINE, 1);
      y += 26;
    }
    pdf.rect(M, y, CW, cardH, { fill: "#ffffff", stroke: LINE, lw: 1, r: 12 });
    pdf.rect(M + 6, y + 6, 62, cardH - 12, { fill: SOFT, r: 9 });
    const d = parseDay(day.date);
    pdf.text(M + 37, y + 27, d.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase(), { font: "semi", size: 8, color: BRAND, align: "center" });
    pdf.text(M + 37, y + 51, String(d.getDate()), { font: "bold", size: 23, color: INK, align: "center" });
    pdf.text(M + 37, y + 64, d.toLocaleDateString("en-GB", { month: "short" }), { font: "reg", size: 8.5, color: MUTED, align: "center" });

    let ty = y + 13;
    rows.forEach(({ s, task, topic, pillW }, i) => {
      const k = KIND[s.kind];
      const base = ty + 12;
      pdf.rect(X0, base - 8.5, 9, 9, { stroke: BOX, lw: 1, r: 2 });
      const range = `${s.start}–${fromMin(toMin(s.start) + s.minutes)}`;
      pdf.text(X0 + 16, base, range, { font: "semi", size: 9, color: MUTED });
      if (s.late) pdf.text(X0 + 16 + pdf.measure(range, "semi", 9) + 2, base - 3, "+1", { font: "bold", size: 6.5, color: BRAND }); // after midnight, same study day
      if (s.issue) pdf.text(X0 + 16 + pdf.measure(range, "semi", 9) + (s.late ? 2 + pdf.measure("+1", "bold", 6.5) : 0) + 5, base, "!", { font: "bold", size: 9, color: "#c63a53" }); // breaks a rule, see Check these
      topic.forEach((l, j) => pdf.text(topicX, base + j * 13.5, l, { font: "semi", size: 10.5, color: INK }));
      pdf.rect(XR - pillW, base - 9.5, pillW, 14, { fill: k.tint, r: 7 });
      pdf.text(XR - pillW / 2, base - 0.3, k.label, { font: "bold", size: 7, color: k.color, align: "center" });
      pdf.text(XR - pillW - 8, base, `${s.minutes} min`, { font: "reg", size: 8.5, color: MUTED, align: "right" });
      const tb = base + 14 + (topic.length - 1) * 13.5;
      task.forEach((l, j) => pdf.text(X0 + 16, tb + j * 12.5, l, { font: "reg", size: 9.5, color: BODY }));
      ty += rowH({ task, topic });
      if (i < rows.length - 1) pdf.line(X0, ty - 5, XR, ty - 5, LINE, 0.75);
    });
    y += cardH + 10;
  }

  /* ---- tips ---- */
  if (plan.tips.length) {
    const tl = plan.tips.map((t) => pdf.wrap(t, "reg", 10, CW - 56));
    const h = 48 + tl.reduce((n, l) => n + l.length * 13.5 + 7, 0);
    if (y + h > bottom) continued();
    y += 6;
    pdf.rect(M, y, CW, h, { fill: SOFT, r: 12 });
    pdf.text(M + 18, y + 27, "Tips for this plan", { font: "bold", size: 12, color: INK });
    let ty = y + 48;
    tl.forEach((lines) => {
      pdf.circle(M + 22, ty - 3.5, 2.3, { fill: BRAND });
      lines.forEach((l, j) => pdf.text(M + 34, ty + j * 13.5, l, { font: "reg", size: 10, color: BODY }));
      ty += lines.length * 13.5 + 7;
    });
  }

  const made = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return pdf.build((p, n, total) => {
    p.line(M, H - 44, W - M, H - 44, LINE, 1);
    p.text(M, H - 28, `Made with TurboGoo on ${made}`, { font: "reg", size: 8, color: MUTED });
    p.text(W - M, H - 28, `Page ${n} of ${total}`, { font: "reg", size: 8, color: MUTED, align: "right" });
  });
}

export const planFileName = (plan: Plan) => (plan.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Study plan") + ".pdf";

/** Desktop app: save dialog and open. Browser: a normal download. Resolves to the saved name, or null if cancelled. */
export async function savePlanPdf(plan: Plan): Promise<string | null> {
  const bytes = await buildPlanPdf(plan);
  const name = planFileName(plan);
  const api = (window as unknown as { turbogoo?: { savePdf?: (n: string, b: Uint8Array) => Promise<string | null> } }).turbogoo;
  if (api?.savePdf) {
    const file = await api.savePdf(name, bytes);
    return file ? file.split(/[\\/]/).pop() ?? name : null;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

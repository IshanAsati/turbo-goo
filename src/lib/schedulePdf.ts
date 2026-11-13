import { Pdf, ascii, hasUnsupported, measure, wrap } from "./pdf";
import { fromMin, parseDay, toMin } from "./schedule";
import type { Plan, PlanKind } from "./schedule";

/** Lays a study plan out as a clean, printable A4 PDF. Pure and synchronous: it takes a few milliseconds. */

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

const fit = (s: string, font: "reg" | "bold", size: number, maxW: number) => {
  let t = ascii(s);
  if (measure(t, font, size) <= maxW) return t;
  while (t.length > 1 && measure(t + "...", font, size) > maxW) t = t.slice(0, -1);
  return t.trimEnd() + "...";
};
const dmy = (iso: string) => parseDay(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
/** Monday-based week start of an ISO date. */
const weekStart = (iso: string) => {
  const d = parseDay(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function planHasUnsupportedText(plan: Plan) {
  return hasUnsupported([plan.title, plan.summary, ...plan.tips, ...plan.days.flatMap((d) => d.sessions.flatMap((s) => [s.topic, s.task]))].join(" "));
}

export function buildPlanPdf(plan: Plan, now = new Date()): Uint8Array {
  const pdf = new Pdf({ title: plan.title, author: "TurboGoo" });
  const W = pdf.w;
  const H = pdf.h;
  const CW = W - M * 2;
  const bottom = H - 62;
  const first = plan.days[0]?.date;
  const last = plan.days[plan.days.length - 1]?.date;
  const sessions = plan.days.reduce((n, d) => n + d.sessions.length, 0);
  const minutes = plan.days.reduce((n, d) => n + d.sessions.reduce((a, s) => a + s.minutes, 0), 0);

  /* ---- header band ---- */
  pdf.addPage();
  pdf.rect(0, 0, W, 158, { fill: BRAND });
  pdf.circle(548, 40, 78, { fill: "#8e6bf0" });
  pdf.circle(478, 112, 38, { fill: "#6f48dc" });
  pdf.text(M, 46, "TURBOGOO  |  STUDY PLAN", { font: "bold", size: 8.5, color: "#e1d8ff" });
  const titleLines = wrap(plan.title, "bold", 25, CW - 120).slice(0, 2);
  titleLines.forEach((l, i) => pdf.text(M, 84 + i * 29, l, { font: "bold", size: 25, color: "#ffffff" }));
  const subY = 84 + (titleLines.length - 1) * 29 + 28;
  if (first && last) pdf.text(M, subY, `${dmy(first)} to ${dmy(last)} ${parseDay(last).getFullYear()}`, { size: 11, color: "#e9e2ff" });

  /* ---- stat cards ---- */
  const stats: [string, string][] = [
    [String(plan.days.length), "STUDY DAYS"],
    [String(sessions), "SESSIONS"],
    [`${Math.round((minutes / 60) * 10) / 10}`, "HOURS IN TOTAL"],
  ];
  const sw = (CW - 24) / 3;
  stats.forEach(([n, label], i) => {
    const x = M + i * (sw + 12);
    pdf.rect(x, 138, sw, 56, { fill: "#ffffff", stroke: LINE, lw: 1, r: 12 });
    pdf.text(x + 16, 168, n, { font: "bold", size: 20, color: BRAND });
    pdf.text(x + 16, 183, label, { font: "bold", size: 7.5, color: MUTED });
  });
  let y = 216;

  /* ---- summary + legend ---- */
  if (plan.summary) {
    const lines = wrap(plan.summary, "reg", 10, CW - 36);
    const h = 20 + lines.length * 14;
    pdf.rect(M, y, CW, h, { fill: SOFT, r: 12 });
    lines.forEach((l, i) => pdf.text(M + 18, y + 22 + i * 14, l, { size: 10, color: BODY }));
    y += h + 12;
  }
  let lx = M;
  (Object.keys(KIND) as PlanKind[]).forEach((k) => {
    pdf.circle(lx + 4, y + 3, 3.5, { fill: KIND[k].color });
    const lab = KIND[k].label[0] + KIND[k].label.slice(1).toLowerCase();
    pdf.text(lx + 13, y + 6.5, lab, { size: 8.5, color: MUTED });
    lx += 13 + measure(lab, "reg", 8.5) + 16;
  });
  pdf.text(W - M, y + 6.5, "Tick the box when a session is done", { font: "ital", size: 8.5, color: MUTED, align: "right" });
  y += 26;

  const continued = () => {
    pdf.addPage();
    pdf.text(M, 34, ascii(plan.title), { font: "bold", size: 8.5, color: MUTED });
    pdf.line(M, 42, W - M, 42, LINE, 1);
    y = 62;
  };

  /* ---- days ---- */
  let week = "";
  const X0 = M + 80; // left edge of the session column
  const XR = M + CW - 16;
  for (const day of plan.days) {
    const ws = weekStart(day.date);
    const topicX = X0 + 16 + 11 * 0.6 * 8.5 + 10;
    const rows = day.sessions.map((s) => {
      const k = KIND[s.kind];
      const pillW = measure(k.label, "bold", 7) + 14;
      const topicW = XR - pillW - measure(`${s.minutes} min`, "reg", 8.5) - 18 - topicX;
      let topic = wrap(s.topic, "bold", 10.5, topicW);
      if (topic.length > 2) topic = [topic[0], fit(topic.slice(1).join(" "), "bold", 10.5, topicW)];
      return { s, topic, pillW, task: wrap(s.task, "reg", 9, XR - (X0 + 16)).slice(0, 3) };
    });
    const rowH = (r: { task: string[]; topic: string[] }) => 22 + (r.topic.length - 1) * 13 + Math.max(1, r.task.length) * 11.5;
    const cardH = Math.max(66, 12 + rows.reduce((n, r) => n + rowH(r), 0) + 2);
    const need = cardH + (ws !== week ? 26 : 0);
    if (y + need > bottom) continued();
    if (ws !== week) {
      week = ws;
      pdf.text(M, y + 10, `WEEK OF ${dmy(ws).toUpperCase()}`, { font: "bold", size: 8, color: MUTED });
      pdf.line(M + 78, y + 7, W - M, y + 7, LINE, 1);
      y += 26;
    }
    pdf.rect(M, y, CW, cardH, { fill: "#ffffff", stroke: LINE, lw: 1, r: 12 });
    pdf.rect(M + 6, y + 6, 62, cardH - 12, { fill: SOFT, r: 9 });
    const d = parseDay(day.date);
    pdf.text(M + 37, y + 26, d.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase(), { font: "bold", size: 8, color: BRAND, align: "center" });
    pdf.text(M + 37, y + 49, String(d.getDate()), { font: "bold", size: 22, color: INK, align: "center" });
    pdf.text(M + 37, y + 62, d.toLocaleDateString("en-GB", { month: "short" }), { size: 8.5, color: MUTED, align: "center" });

    let ty = y + 12;
    rows.forEach(({ s, task, topic, pillW }, i) => {
      const top = ty;
      const k = KIND[s.kind];
      const base = top + 12;
      const end = toMin(s.start) + s.minutes;
      pdf.rect(X0, base - 8, 9, 9, { stroke: BOX, lw: 1, r: 2 });
      pdf.text(X0 + 16, base, `${s.start}-${fromMin(end)}`, { font: "mono", size: 8.5, color: MUTED });
      topic.forEach((l, j) => pdf.text(topicX, base + j * 13, l, { font: "bold", size: 10.5, color: INK }));
      pdf.rect(XR - pillW, base - 9, pillW, 13, { fill: k.tint, r: 6.5 });
      pdf.text(XR - pillW / 2, base - 0.2, k.label, { font: "bold", size: 7, color: k.color, align: "center" });
      pdf.text(XR - pillW - 8, base, `${s.minutes} min`, { size: 8.5, color: MUTED, align: "right" });
      const tb = base + 13 + (topic.length - 1) * 13;
      task.forEach((l, j) => pdf.text(X0 + 16, tb + j * 11.5, l, { size: 9, color: BODY }));
      ty += rowH({ task, topic });
      if (i < rows.length - 1) pdf.line(X0, ty - 5, XR, ty - 5, LINE, 0.75);
    });
    y += cardH + 10;
  }

  /* ---- tips ---- */
  if (plan.tips.length) {
    const tl = plan.tips.map((t) => wrap(t, "reg", 9.5, CW - 56));
    const h = 44 + tl.reduce((n, l) => n + l.length * 13 + 6, 0);
    if (y + h > bottom) continued();
    y += 6;
    pdf.rect(M, y, CW, h, { fill: SOFT, r: 12 });
    pdf.text(M + 18, y + 24, "Tips for this plan", { font: "bold", size: 11, color: INK });
    let ty = y + 44;
    tl.forEach((lines) => {
      pdf.circle(M + 22, ty - 3, 2.2, { fill: BRAND });
      lines.forEach((l, j) => pdf.text(M + 34, ty + j * 13, l, { size: 9.5, color: BODY }));
      ty += lines.length * 13 + 6;
    });
  }

  const made = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return pdf.build((p, n, total) => {
    p.line(M, H - 44, W - M, H - 44, LINE, 1);
    p.text(M, H - 28, `Made with TurboGoo on ${made}`, { size: 8, color: MUTED });
    p.text(W - M, H - 28, `Page ${n} of ${total}`, { size: 8, color: MUTED, align: "right" });
  });
}

export const planFileName = (plan: Plan) => (ascii(plan.title).replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "Study plan") + ".pdf";

/** Desktop app: save dialog and open. Browser: a normal download. Resolves to the saved name, or null if cancelled. */
export async function savePlanPdf(plan: Plan): Promise<string | null> {
  const bytes = buildPlanPdf(plan);
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

/**
 * A tiny PDF writer with no dependencies: A4 pages of vector shapes and text in the built-in Helvetica and Courier
 * fonts. Nothing is embedded or compressed, so a multi-page document is built in a few milliseconds.
 * Text is limited to what the built-in fonts can show: it is folded to plain ASCII (accents dropped, smart quotes
 * straightened). Scripts such as Devanagari or Chinese cannot be drawn and become "?".
 */

export type PdfFont = "reg" | "bold" | "ital" | "mono";

// Advance widths (1000 units per em) of ASCII 32..126 for Helvetica and Helvetica-Bold, from the Adobe core font metrics.
const W_REG = "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584".split(" ").map(Number);
const W_BOLD = "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584".split(" ").map(Number);

const MAP: Record<string, string> = { "–": "-", "—": "-", "−": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "•": "-", "·": "-", "×": "x", "÷": "/", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "°": " deg", "π": "pi", "√": "sqrt", "∞": "inf", "\u2044": "/", "\u00a0": " " };

/** Folds any text to printable ASCII that the built-in fonts can draw. */
export function ascii(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, (ch) => MAP[ch] ?? (/\s/.test(ch) ? " " : "?"));
}
/** True when the text has characters that the PDF cannot show (they would print as "?"). */
export const hasUnsupported = (s: string) => /[^\x20-\x7e\s]/.test(s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[–—−‘’“”•·×÷→←≤≥≠≈°π√∞\u2044\u00a0…]/g, ""));

export function measure(s: string, font: PdfFont, size: number): number {
  if (font === "mono") return s.length * 0.6 * size;
  const w = font === "bold" ? W_BOLD : W_REG;
  let n = 0;
  for (let i = 0; i < s.length; i++) n += w[s.charCodeAt(i) - 32] ?? 556;
  return (n * size) / 1000;
}

/** Greedy word wrap into lines no wider than `maxW`. Over-long words are cut. */
export function wrap(text: string, font: PdfFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of ascii(text).split(/\n/)) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (measure(word, font, size) > maxW) {
        let k = word.length - 1;
        while (k > 1 && measure(word.slice(0, k), font, size) > maxW) k--;
        if (line) (out.push(line), (line = ""));
        out.push(word.slice(0, k));
        word = word.slice(k);
      }
      const next = line ? line + " " + word : word;
      if (line && measure(next, font, size) > maxW) (out.push(line), (line = word));
      else line = next;
    }
    out.push(line);
  }
  return out;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(" ");
};
const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");
const FONT_KEY: Record<PdfFont, string> = { reg: "F1", bold: "F2", ital: "F3", mono: "F4" };
const FONT_NAME: Record<PdfFont, string> = { reg: "Helvetica", bold: "Helvetica-Bold", ital: "Helvetica-Oblique", mono: "Courier" };

export type Paint = { fill?: string; stroke?: string; lw?: number; r?: number };

export class Pdf {
  readonly w = 595.28;
  readonly h = 841.89;
  private done: string[] = [];
  private cur: string[] | null = null;
  constructor(private info: { title?: string; author?: string } = {}) {}

  get pageCount() {
    return this.done.length + (this.cur ? 1 : 0);
  }
  addPage() {
    if (this.cur) this.done.push(this.cur.join("\n"));
    this.cur = [];
  }
  private out(s: string) {
    if (!this.cur) this.addPage();
    this.cur!.push(s);
  }
  /** Y from the top of the page to PDF user space. */
  private Y = (y: number) => num(this.h - y);

  rect(x: number, y: number, w: number, h: number, p: Paint = {}) {
    const r = Math.min(p.r ?? 0, w / 2, h / 2);
    const k = r * 0.5523;
    const X = num;
    const Y = this.Y;
    let d: string;
    if (r > 0) {
      d =
        `${X(x + r)} ${Y(y)} m ${X(x + w - r)} ${Y(y)} l ${X(x + w - r + k)} ${Y(y)} ${X(x + w)} ${Y(y + r - k)} ${X(x + w)} ${Y(y + r)} c ` +
        `${X(x + w)} ${Y(y + h - r)} l ${X(x + w)} ${Y(y + h - r + k)} ${X(x + w - r + k)} ${Y(y + h)} ${X(x + w - r)} ${Y(y + h)} c ` +
        `${X(x + r)} ${Y(y + h)} l ${X(x + r - k)} ${Y(y + h)} ${X(x)} ${Y(y + h - r + k)} ${X(x)} ${Y(y + h - r)} c ` +
        `${X(x)} ${Y(y + r)} l ${X(x)} ${Y(y + r - k)} ${X(x + r - k)} ${Y(y)} ${X(x + r)} ${Y(y)} c h`;
    } else d = `${X(x)} ${Y(y + h)} ${X(w)} ${X(h)} re`;
    this.paint(d, p);
  }
  circle(cx: number, cy: number, r: number, p: Paint = {}) {
    const k = r * 0.5523;
    const X = num;
    const Y = this.Y;
    const d =
      `${X(cx + r)} ${Y(cy)} m ${X(cx + r)} ${Y(cy - k)} ${X(cx + k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c ${X(cx - k)} ${Y(cy - r)} ${X(cx - r)} ${Y(cy - k)} ${X(cx - r)} ${Y(cy)} c ` +
      `${X(cx - r)} ${Y(cy + k)} ${X(cx - k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c ${X(cx + k)} ${Y(cy + r)} ${X(cx + r)} ${Y(cy + k)} ${X(cx + r)} ${Y(cy)} c h`;
    this.paint(d, p);
  }
  private paint(path: string, p: Paint) {
    const parts: string[] = [];
    if (p.fill) parts.push(`${rgb(p.fill)} rg`);
    if (p.stroke) parts.push(`${rgb(p.stroke)} RG ${num(p.lw ?? 1)} w`);
    parts.push(`${path} ${p.fill && p.stroke ? "B" : p.fill ? "f" : "S"}`);
    this.out(parts.join(" "));
  }
  line(x1: number, y1: number, x2: number, y2: number, color: string, lw = 1, dash?: [number, number]) {
    this.out(`${rgb(color)} RG ${num(lw)} w ${dash ? `[${dash[0]} ${dash[1]}] 0 d` : "[] 0 d"} ${num(x1)} ${this.Y(y1)} m ${num(x2)} ${this.Y(y2)} l S [] 0 d`);
  }
  /** Draws one line of text with its baseline at `y`. `align` is relative to `x`. */
  text(x: number, y: number, s: string, o: { font?: PdfFont; size?: number; color?: string; align?: "left" | "right" | "center" } = {}) {
    const font = o.font ?? "reg";
    const size = o.size ?? 10;
    const t = ascii(s);
    const w = measure(t, font, size);
    const px = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    this.out(`BT ${rgb(o.color ?? "#000000")} rg /${FONT_KEY[font]} ${num(size)} Tf ${num(px)} ${this.Y(y)} Td (${esc(t)}) Tj ET`);
  }

  /** Assembles the file. `after(page, count)` runs once per page first, so footers can say "Page 2 of 5". */
  build(after?: (pdf: Pdf, page: number, count: number) => void): Uint8Array {
    if (this.cur) (this.done.push(this.cur.join("\n")), (this.cur = null));
    const pages = [...this.done];
    if (after) {
      const saved = this.done;
      pages.forEach((_, i) => {
        this.done = [];
        this.cur = [];
        after(this, i + 1, pages.length);
        pages[i] += "\n" + this.cur.join("\n");
      });
      this.done = saved;
      this.cur = null;
    }
    if (!pages.length) pages.push("");

    const objs: string[] = [];
    const add = (s: string) => objs.push(s) && objs.length;
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add(""); // pages, filled below
    (Object.keys(FONT_KEY) as PdfFont[]).forEach((f) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME[f]} /Encoding /WinAnsiEncoding >>`));
    const fonts = `/Font << ${(Object.keys(FONT_KEY) as PdfFont[]).map((f, i) => `/${FONT_KEY[f]} ${3 + i} 0 R`).join(" ")} >>`;
    const kids: number[] = [];
    for (const content of pages) {
      const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const pg = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.w)} ${num(this.h)}] /Resources << ${fonts} >> /Contents ${c} 0 R >>`);
      kids.push(pg);
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const infoId = add(`<< /Title (${esc(ascii(this.info.title ?? "Document"))}) /Producer (TurboGoo) /Creator (TurboGoo)${this.info.author ? ` /Author (${esc(ascii(this.info.author))})` : ""} >>`);

    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
    body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
    return bytes;
  }
}

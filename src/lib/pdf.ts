/**
 * A small dependency-free PDF writer: A4 pages of vector shapes and text, with TrueType fonts embedded
 * (Identity-H, so any glyph in the font works and the text stays searchable and copyable).
 * Building a multi-page document takes a few milliseconds; streams are deflated with the browser's CompressionStream.
 */

export type PdfFont = "reg" | "semi" | "bold";

/* ---------------- TrueType parsing (just what a PDF needs) ---------------- */

export class Ttf {
  readonly upm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly bbox: [number, number, number, number];
  readonly numGlyphs: number;
  private readonly v: DataView;
  private readonly adv: number[] = [];
  private readonly seg: { start: number; end: number; delta: number; ro: number; roPos: number }[] = [];
  private readonly groups: { start: number; end: number; gid: number }[] = [];

  constructor(readonly data: Uint8Array, readonly psName: string) {
    const v = (this.v = new DataView(data.buffer, data.byteOffset, data.byteLength));
    const tables = new Map<string, number>();
    for (let i = 0, n = v.getUint16(4); i < n; i++) {
      const o = 12 + i * 16;
      tables.set(String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)), v.getUint32(o + 8));
    }
    const t = (name: string) => {
      const o = tables.get(name);
      if (o === undefined) throw new Error(`Font is missing its ${name} table.`);
      return o;
    };
    const head = t("head");
    const hhea = t("hhea");
    this.upm = v.getUint16(head + 18);
    this.bbox = [v.getInt16(head + 36), v.getInt16(head + 38), v.getInt16(head + 40), v.getInt16(head + 42)];
    this.ascent = v.getInt16(hhea + 4);
    this.descent = v.getInt16(hhea + 6);
    this.numGlyphs = v.getUint16(t("maxp") + 4);
    const nHM = v.getUint16(hhea + 34);
    const hmtx = t("hmtx");
    for (let g = 0; g < this.numGlyphs; g++) this.adv.push(v.getUint16(hmtx + Math.min(g, nHM - 1) * 4));

    // cmap: prefer a full-Unicode format 12 table, else format 4 for the BMP
    const cmap = t("cmap");
    let f4 = -1;
    let f12 = -1;
    for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
      const plat = v.getUint16(cmap + 4 + i * 8);
      const enc = v.getUint16(cmap + 6 + i * 8);
      const off = cmap + v.getUint32(cmap + 8 + i * 8);
      const fmt = v.getUint16(off);
      if (fmt === 12 && ((plat === 3 && enc === 10) || plat === 0)) f12 = off;
      if (fmt === 4 && ((plat === 3 && enc === 1) || plat === 0)) f4 = off;
    }
    if (f12 >= 0) {
      for (let i = 0, n = v.getUint32(f12 + 12); i < n; i++) {
        const o = f12 + 16 + i * 12;
        this.groups.push({ start: v.getUint32(o), end: v.getUint32(o + 4), gid: v.getUint32(o + 8) });
      }
    } else if (f4 >= 0) {
      const sc = v.getUint16(f4 + 6) / 2;
      for (let i = 0; i < sc; i++) {
        const roPos = f4 + 16 + sc * 6 + i * 2;
        this.seg.push({ end: v.getUint16(f4 + 14 + i * 2), start: v.getUint16(f4 + 16 + sc * 2 + i * 2), delta: v.getInt16(f4 + 16 + sc * 4 + i * 2), ro: v.getUint16(roPos), roPos });
      }
    } else throw new Error("Font has no usable character map.");
  }

  /** Glyph id for a code point, or 0 when the font has no glyph for it. */
  gid(cp: number): number {
    if (this.groups.length) {
      for (const g of this.groups) if (cp >= g.start && cp <= g.end) return g.gid + (cp - g.start);
      return 0;
    }
    for (const s of this.seg) {
      if (cp > s.end) continue;
      if (cp < s.start) return 0;
      if (s.ro === 0) return (cp + s.delta) & 0xffff;
      const g = this.v.getUint16(s.roPos + s.ro + 2 * (cp - s.start));
      return g ? (g + s.delta) & 0xffff : 0;
    }
    return 0;
  }
  /** Advance width of a glyph in 1000-unit text space. */
  width(gid: number): number {
    return (this.adv[gid] ?? 0) * (1000 / this.upm);
  }
  scale(n: number) {
    return Math.round(n * (1000 / this.upm));
  }
}

/** Punctuation and symbols a font may lack, mapped to plain ASCII stand-ins. */
const FALLBACK: Record<string, string> = { "–": "-", "—": "-", "−": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "•": "-", "·": "-", "×": "x", "÷": "/", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "°": " deg", "…": "...", "\u2044": "/", "\u00a0": " ", "\t": " " };

/** Folds text to ASCII for the document info dictionary (which is not font-encoded). */
export function ascii(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, (ch) => FALLBACK[ch] ?? (/\s/.test(ch) ? " " : "?"));
}

/** True when the text contains scripts the bundled Latin fonts cannot show (Devanagari, Chinese, Arabic ...). */
export const hasUnsupported = (s: string) => /[^\u0000-\u024F\u2000-\u206F\u20A0-\u20CF\u2190-\u22FF\u2500-\u25FF\s]/.test(s);

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(" ");
};
const bytes = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

async function deflate(b: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate");
    const w = cs.writable.getWriter();
    void w.write(b as BufferSource);
    void w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch {
    return null;
  }
}

export type Paint = { fill?: string; stroke?: string; lw?: number; r?: number };
const KEY: Record<PdfFont, string> = { reg: "F1", semi: "F2", bold: "F3" };

export class Pdf {
  readonly w = 595.28;
  readonly h = 841.89;
  private pages: string[][] = [];
  private cur: string[] | null = null;
  private used: Record<PdfFont, Map<number, number>> = { reg: new Map(), semi: new Map(), bold: new Map() }; // gid -> code point

  constructor(private fonts: Record<PdfFont, Ttf>, private info: { title?: string; author?: string } = {}) {}

  get pageCount() {
    return this.pages.length;
  }
  addPage() {
    this.cur = [];
    this.pages.push(this.cur);
  }
  private out(s: string) {
    if (!this.cur) this.addPage();
    this.cur!.push(s);
  }
  private Y = (y: number) => num(this.h - y);

  /* ---- text ---- */

  /** Glyph ids for a string, with ASCII stand-ins for symbols the font lacks and "?" for anything else. */
  private glyphs(s: string, font: PdfFont): { ids: number[]; cps: number[] } {
    const f = this.fonts[font];
    const ids: number[] = [];
    const cps: number[] = [];
    const push = (cp: number) => {
      let g = f.gid(cp);
      if (!g) {
        const alt = FALLBACK[String.fromCodePoint(cp)];
        if (alt) return void [...alt].forEach((c) => push(c.codePointAt(0)!));
        if (cp < 32 || cp === 0xfeff || (cp >= 0x200b && cp <= 0x200f)) return;
        cp = 63;
        g = f.gid(63);
      }
      ids.push(g);
      cps.push(cp);
    };
    for (const ch of s.normalize("NFC")) push(ch.codePointAt(0)!);
    return { ids, cps };
  }
  measure(s: string, font: PdfFont, size: number): number {
    const f = this.fonts[font];
    return (this.glyphs(s, font).ids.reduce((n, g) => n + f.width(g), 0) * size) / 1000;
  }
  /** Greedy word wrap into lines no wider than `maxW`. Over-long words are cut. */
  wrap(text: string, font: PdfFont, size: number, maxW: number): string[] {
    const out: string[] = [];
    for (const para of text.split(/\n/)) {
      let line = "";
      for (let word of para.split(/\s+/).filter(Boolean)) {
        while (this.measure(word, font, size) > maxW && word.length > 1) {
          let k = word.length - 1;
          while (k > 1 && this.measure(word.slice(0, k), font, size) > maxW) k--;
          if (line) (out.push(line), (line = ""));
          out.push(word.slice(0, k));
          word = word.slice(k);
        }
        const next = line ? line + " " + word : word;
        if (line && this.measure(next, font, size) > maxW) (out.push(line), (line = word));
        else line = next;
      }
      out.push(line);
    }
    return out;
  }
  /** Shortens a string with an ellipsis so it fits `maxW`. */
  fit(s: string, font: PdfFont, size: number, maxW: number): string {
    if (this.measure(s, font, size) <= maxW) return s;
    let t = s;
    while (t.length > 1 && this.measure(t + "…", font, size) > maxW) t = t.slice(0, -1);
    return t.trimEnd() + "…";
  }
  /** Draws one line of text with its baseline at `y`. `align` is relative to `x`. */
  text(x: number, y: number, s: string, o: { font?: PdfFont; size?: number; color?: string; align?: "left" | "right" | "center" } = {}) {
    const font = o.font ?? "reg";
    const size = o.size ?? 10;
    const { ids, cps } = this.glyphs(s, font);
    if (!ids.length) return;
    const f = this.fonts[font];
    const w = (ids.reduce((n, g) => n + f.width(g), 0) * size) / 1000;
    const px = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    ids.forEach((g, i) => this.used[font].set(g, cps[i]));
    this.out(`BT ${rgb(o.color ?? "#000000")} rg /${KEY[font]} ${num(size)} Tf ${num(px)} ${this.Y(y)} Td <${ids.map(hex4).join("")}> Tj ET`);
  }

  /* ---- shapes ---- */

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
  line(x1: number, y1: number, x2: number, y2: number, color: string, lw = 1) {
    this.out(`${rgb(color)} RG ${num(lw)} w ${num(x1)} ${this.Y(y1)} m ${num(x2)} ${this.Y(y2)} l S`);
  }

  /* ---- file ---- */

  /** Assembles the file. `after(pdf, page, count)` runs once per page first, so footers can say "Page 2 of 5". */
  async build(after?: (pdf: Pdf, page: number, count: number) => void): Promise<Uint8Array> {
    if (!this.pages.length) this.addPage();
    if (after) {
      const n = this.pages.length;
      this.pages.forEach((ops, i) => {
        this.cur = ops;
        after(this, i + 1, n);
      });
    }
    this.cur = null;

    type Obj = { dict: string; stream?: Uint8Array };
    const objs: Obj[] = [];
    const add = (o: Obj) => (objs.push(o), objs.length);
    add({ dict: "<< /Type /Catalog /Pages 2 0 R >>" });
    add({ dict: "" }); // pages tree, filled in below

    const fontRefs: string[] = [];
    for (const font of ["reg", "semi", "bold"] as PdfFont[]) {
      const f = this.fonts[font];
      const used = [...this.used[font].entries()].sort((a, b) => a[0] - b[0]);
      const base = `AAAAAA+${f.psName}`;
      const raw = f.data;
      const z = await deflate(raw);
      const file = add({ dict: `<< /Length1 ${raw.length}${z ? " /Filter /FlateDecode" : ""} >>`, stream: z ?? raw });
      const desc = add({
        dict: `<< /Type /FontDescriptor /FontName /${base} /Flags 32 /FontBBox [${f.bbox.map((n) => f.scale(n)).join(" ")}] /ItalicAngle 0 /Ascent ${f.scale(f.ascent)} /Descent ${f.scale(f.descent)} /CapHeight ${Math.round(f.scale(f.ascent) * 0.7)} /StemV ${font === "bold" ? 140 : font === "semi" ? 110 : 80} /FontFile2 ${file} 0 R >>`,
      });
      const widths = used.map(([g]) => `${g} [${num(f.width(g))}]`).join(" ");
      const cid = add({ dict: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 0 /W [${widths}] >>` });
      const blocks: string[] = [];
      for (let i = 0; i < used.length; i += 100) {
        const chunk = used.slice(i, i + 100);
        blocks.push(`${chunk.length} beginbfchar\n${chunk.map(([g, cp]) => `<${hex4(g)}> <${cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp)}>`).join("\n")}\nendbfchar`);
      }
      const cmap = bytes(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${blocks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`);
      const zc = await deflate(cmap);
      const tu = add({ dict: `<< ${zc ? "/Filter /FlateDecode " : ""}>>`, stream: zc ?? cmap });
      fontRefs.push(`/${KEY[font]} ${add({ dict: `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>` })} 0 R`);
    }

    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = bytes(ops.join("\n"));
      const z = await deflate(content);
      const c = add({ dict: `<< ${z ? "/Filter /FlateDecode " : ""}>>`, stream: z ?? content });
      kids.push(add({ dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.w)} ${num(this.h)}] /Resources << /Font << ${fontRefs.join(" ")} >> >> /Contents ${c} 0 R >>` }));
    }
    objs[1] = { dict: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>` };
    const infoId = add({ dict: `<< /Title (${ascii(this.info.title ?? "Document").replace(/[\\()]/g, "\\$&")}) /Producer (TurboGoo) /Creator (TurboGoo)${this.info.author ? ` /Author (${ascii(this.info.author).replace(/[\\()]/g, "\\$&")})` : ""} >>` });

    const chunks: Uint8Array[] = [];
    let pos = 0;
    const push = (b: Uint8Array) => (chunks.push(b), (pos += b.length));
    push(bytes("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(pos);
      if (o.stream) {
        // the dictionary needs the stream length; keep any keys already present
        const dict = o.dict.replace(/^<< ?/, "").replace(/ ?>>$/, "");
        push(bytes(`${i + 1} 0 obj\n<< ${dict}${dict ? " " : ""}/Length ${o.stream.length} >>\nstream\n`));
        push(o.stream);
        push(bytes("\nendstream\nendobj\n"));
      } else push(bytes(`${i + 1} 0 obj\n${o.dict}\nendobj\n`));
    });
    const xref = pos;
    push(bytes(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    const all = new Uint8Array(pos);
    let at = 0;
    for (const c of chunks) (all.set(c, at), (at += c.length));
    return all;
  }
}

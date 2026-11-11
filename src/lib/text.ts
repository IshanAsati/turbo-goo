const STOP = new Set(
  "a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these those i you he she we they them his her our your their not no do does did have has had will would can could should may might about into over than too very just also which who whom what when where why how there here more most some any each other such only own same both few all one two get got like going gonna okay yeah right know think really".split(
    " ",
  ),
);

export const words = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) as string[];
export const contentWords = (s: string) => words(s).filter((w) => w.length > 2 && !STOP.has(w));

/** Classroom admin and small talk that should never become study material. */
const CHATTER = /\b(midterm|final exam|homework|assignment|due (on|monday|tuesday|wednesday|thursday|friday)|see you|any questions|cafeteria|coffee|settle down|let's get started|reminder that|don't forget|office hours|sign up|syllabus says|that's all for today)\b/i;

export function sentences(s: string): string[] {
  return s
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((x) => x.trim())
    .filter((x) => x.length > 25 && x.length < 400 && !CHATTER.test(x));
}

export function freq(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of contentWords(s)) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

export function topKeywords(s: string, n: number): string[] {
  return [...freq(s).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

export function topSentences(s: string, n: number): string[] {
  const f = freq(s);
  const scored = sentences(s).map((x, i) => {
    const cw = contentWords(x);
    return { x, i, score: cw.reduce((a, w) => a + (f.get(w) ?? 0), 0) / Math.sqrt(cw.length + 1) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((a) => a.x);
}

/** Chunk on sentence boundaries into ~size-char windows. */
export function chunk(s: string, size = 600): string[] {
  const out: string[] = [];
  let cur = "";
  for (const sent of s.replace(/[ \t]+/g, " ").split(/(?<=[.!?])\s+|\n{2,}/)) {
    if ((cur + " " + sent).length > size && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += " " + sent;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split a long source into model-sized segments (for map-reduce over long lectures). */
export function segments(s: string, max = 12000): string[] {
  if (s.length <= max) return [s];
  const parts = chunk(s, max - 500);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + "\n" + p).length > max && cur) {
      out.push(cur);
      cur = "";
    }
    cur += "\n" + p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** BM25 retrieval – the offline stand-in for vector search. */
export function retrieve(query: string, chunks: string[], k = 4): string[] {
  const q = [...new Set(contentWords(query))];
  if (!q.length || !chunks.length) return chunks.slice(0, k);
  const docs = chunks.map((c) => contentWords(c));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  docs.forEach((d) => new Set(d).forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)));
  const k1 = 1.4;
  const b = 0.75;
  return chunks
    .map((c, i) => {
      const tf = new Map<string, number>();
      docs[i].forEach((w) => tf.set(w, (tf.get(w) ?? 0) + 1));
      let score = 0;
      for (const w of q) {
        const f = tf.get(w) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (chunks.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].length) / avg));
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}

export const shuffle = <T,>(a: T[]): T[] => {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const mask = (sentence: string, term: string) => sentence.replace(new RegExp(`\\b${esc(term)}\\b`, "i"), "_______");
export const normalizeAnswer = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const dedupeBy = <T,>(items: T[], key: (t: T) => string) => {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = normalizeAnswer(key(i));
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Clean transcript noise: timestamps, SRT/VTT cue numbers, speaker tags, repeated lines. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/^WEBVTT.*$/gm, "")
    .replace(/^\d+\s*$/gm, "")
    .replace(/\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, "")
    .replace(/^\s*\(?\[?\d{1,2}:\d{2}(?::\d{2})?\]?\)?\s*/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .filter((l, i, a) => l.trim() && l !== a[i - 1])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

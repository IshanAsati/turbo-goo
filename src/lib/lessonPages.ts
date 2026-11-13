import type { CheckIn, PracticeQ, Section } from "./types";

/**
 * The lesson player shows one page at a time. Pages are cut client-side from the fields a lesson already has
 * (no extra AI calls): intro + objectives, the lesson body split at its sub-headings, the worked example,
 * one page per practice problem, and a recap. Old lessons (only `lesson` + `check`) work too.
 */
export type LessonPage =
  | { kind: "intro"; md: string; cover: string[] }
  | { kind: "content"; md: string }
  | { kind: "example"; md: string; n: number; of: number }
  | { kind: "practice"; i: number; of: number; q: PracticeQ }
  | { kind: "check"; check: CheckIn }
  | { kind: "recap"; items: string[] };

const PAGE_MAX = 1500; // characters a content page may hold before it is cut
const PAGE_GOAL = 900; // aim for about this much per page when cutting plain paragraphs
const TINY = 320; // a heading section shorter than this is merged into the next one

type Unit = { text: string; heading: boolean };

/** Splits markdown into paragraph-sized units without cutting through code fences or $$ math blocks. */
function units(md: string): Unit[] {
  const out: Unit[] = [];
  let cur: string[] = [];
  let fence = false;
  let math = false;
  const flush = () => {
    if (cur.length) out.push({ text: cur.join("\n"), heading: /^#{1,3}\s/.test(cur[0]) && cur.length === 1 });
    cur = [];
  };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (!math && /^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && ((line.match(/\$\$/g) ?? []).length % 2 === 1)) math = !math;
    if (!fence && !math && !line.trim()) {
      flush();
      continue;
    }
    if (!fence && !math && /^#{1,3}\s/.test(line)) {
      flush();
      cur.push(line);
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return out;
}

/** Groups units into pages of roughly `goal` characters, at most `maxUnits` units each. */
function group(us: Unit[], goal = PAGE_GOAL, maxUnits = 3): string[] {
  const pages: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const u of us) {
    if (cur.length && (len + u.text.length > goal || cur.length >= maxUnits)) {
      pages.push(cur.join("\n\n"));
      cur = [];
      len = 0;
    }
    cur.push(u.text);
    len += u.text.length;
  }
  if (cur.length) pages.push(cur.join("\n\n"));
  return pages;
}

/** Cuts markdown into page-sized chunks: at ##/### headings first, long chunks further by paragraph. */
export function splitMarkdown(md: string, lead: Unit[] = []): string[] {
  const us = [...lead, ...units(md)];
  const secs: Unit[][] = [];
  for (const u of us) {
    if (u.heading || !secs.length) secs.push([u]);
    else secs[secs.length - 1].push(u);
  }
  // headings that open nothing but a few words are merged into the next section
  const merged: Unit[][] = [];
  for (let i = 0; i < secs.length; i++) {
    let s = secs[i];
    const size = (x: Unit[]) => x.reduce((n, u) => n + u.text.length, 0);
    while (i + 1 < secs.length && size(s) < TINY && size(s) + size(secs[i + 1]) <= PAGE_MAX) s = [...s, ...secs[++i]];
    merged.push(s);
  }
  const pages: string[] = [];
  for (const s of merged) {
    const text = s.map((u) => u.text).join("\n\n");
    if (text.length <= PAGE_MAX) {
      pages.push(text);
      continue;
    }
    // too long: keep the heading with the first group
    const head = s[0].heading ? s[0] : null;
    const parts = group(head ? s.slice(1) : s);
    parts.forEach((p, k) => pages.push(k === 0 && head ? `${head.text}\n\n${p}` : p));
  }
  return pages.filter((p) => p.trim());
}

/** Drops a leading "## Lesson" style heading that only repeats the section name. */
const clean = (md: string) => md.replace(/^\s*#{1,3}\s*(lesson|worked example|practice|recap)\s*\n+/i, "").trim();

export function buildPages(sec: Section): LessonPage[] {
  const pages: LessonPage[] = [];
  const body = clean(sec.lesson ?? "");
  const all = units(body);
  const firstHead = all.findIndex((u) => u.heading);
  const preamble = firstHead === -1 ? all : all.slice(0, firstHead);
  const rest = firstHead === -1 ? [] : all.slice(firstHead);
  // intro = the first one or two paragraphs before any sub-heading
  const introUnits: Unit[] = [];
  let len = 0;
  const shortPre = preamble.length <= 3 && preamble.reduce((n, u) => n + u.text.length, 0) <= 800; // a short lead-in stays on one page
  for (const u of preamble) {
    if ((introUnits.length >= 2 && !shortPre) || (introUnits.length && len + u.text.length > 700)) break;
    introUnits.push(u);
    len += u.text.length;
  }
  const afterIntro = [...preamble.slice(introUnits.length), ...rest];
  const cover = (sec.objectives ?? []).filter(Boolean);
  if (introUnits.length || cover.length) pages.push({ kind: "intro", md: introUnits.map((u) => u.text).join("\n\n"), cover });

  // the remaining body: headings are page boundaries; plain text without headings is grouped by paragraph
  const hasHeads = afterIntro.some((u) => u.heading);
  const chunks = hasHeads ? splitMarkdown("", afterIntro) : group(afterIntro);
  chunks.forEach((md) => pages.push({ kind: "content", md }));

  const ex = sec.example?.trim();
  if (ex) {
    const parts = splitMarkdown(clean(ex));
    parts.forEach((md, n) => pages.push({ kind: "example", md, n, of: parts.length }));
  }
  const qs = sec.practice ?? [];
  qs.forEach((q, i) => pages.push({ kind: "practice", i, of: qs.length, q }));
  if (sec.check && !qs.length) pages.push({ kind: "check", check: sec.check });
  pages.push({ kind: "recap", items: (sec.recap ?? []).filter(Boolean) });
  if (!pages.some((p) => p.kind === "intro" || p.kind === "content" || p.kind === "example") && !body) pages.unshift({ kind: "content", md: "_This lesson has no text yet._" });
  return pages;
}

/** Plain text of markdown for read-aloud: no syntax, math symbols or links. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " the formula shown ")
    .replace(/\$[^$\n]+\$/g, " the formula ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_`>~|]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pageText(p: LessonPage, title: string): string {
  switch (p.kind) {
    case "intro":
      return plainText(`${p.md || title}\n\n${p.cover.length ? `What you'll cover. ${p.cover.join(". ")}` : ""}`);
    case "content":
    case "example":
      return plainText(p.md);
    case "practice":
      return plainText(p.q.q);
    case "check":
      return plainText(`${p.check.q}. ${p.check.options.map((o, i) => `Option ${i + 1}: ${o}`).join(". ")}`);
    case "recap":
      return plainText(p.items.length ? `Recap. ${p.items.join(". ")}` : `You finished ${title}.`);
  }
}

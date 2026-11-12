import type { DocKind, Settings } from "./types";
import { complete, hasLLM, hasSTT, transcribe } from "./llm";
import { cleanTranscript } from "./text";

export type Ingested = { title: string; source: string; kind: DocKind; sourceUrl?: string; audio?: Blob };
type Progress = (msg: string) => void;

const ext = (n: string) => n.split(".").pop()?.toLowerCase() ?? "";
const baseName = (n: string) => n.replace(/\.[^.]+$/, "");

export const ACCEPT = ".txt,.md,.markdown,.srt,.vtt,.csv,.json,.pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.m4a,.webm,.ogg,.mp4,.mov,text/*";

export async function ingestFile(file: File, s: Settings, progress: Progress): Promise<Ingested> {
  const e = ext(file.name);
  const title = baseName(file.name);

  if (["txt", "md", "markdown", "csv", "json"].includes(e) || file.type.startsWith("text/")) {
    return { title, source: await file.text(), kind: "file" };
  }
  if (["srt", "vtt"].includes(e)) return { title, source: cleanTranscript(await file.text()), kind: "file" };

  if (e === "pdf") return { title, source: await readPdf(file, s, progress), kind: "file" };
  if (e === "docx") {
    progress("Reading Word document…");
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { title, source: value, kind: "file" };
  }
  if (e === "pptx") {
    progress("Reading slides…");
    return { title, source: await readPptx(file), kind: "file" };
  }
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(e)) {
    progress("Reading text from image…");
    return { title, source: await ocrImage(file, s), kind: "image" };
  }
  if (file.type.startsWith("audio/") || file.type.startsWith("video/") || ["mp3", "wav", "m4a", "webm", "ogg", "mp4", "mov"].includes(e)) {
    if (!hasSTT(s)) {
      throw new Error("Transcribing audio/video files needs a speech-to-text provider (Settings → Speech-to-text). To work offline, use Record lecture (live transcription) instead.");
    }
    progress("Transcribing audio…");
    const text = await transcribe(s, file, file.name);
    return { title, source: text, kind: "audio", audio: file.type.startsWith("audio/") ? file : undefined };
  }
  throw new Error(`Unsupported file type “.${e}”. Try PDF, Word, PowerPoint, text, image, or audio.`);
}

/* ---------------- PDF ---------------- */

async function loadPdf(file: File) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  try {
    return await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e) {
    if ((e as Error)?.name === "PasswordException") throw new Error("This PDF is password-protected. Remove the password and try again.");
    throw e;
  }
}

async function readPdf(file: File, s: Settings, progress: Progress): Promise<string> {
  const pdf = await loadPdf(file);
  try {
    return await readPdfPages(pdf, s, progress);
  } finally {
    void pdf.loadingTask.destroy(); // frees the worker and page caches; otherwise every import leaks a parsed document
  }
}

async function readPdfPages(pdf: Awaited<ReturnType<typeof loadPdf>>, s: Settings, progress: Progress): Promise<string> {
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    progress(`Reading PDF page ${i} of ${pdf.numPages}…`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    page.cleanup();
    let line = "";
    const lines: string[] = [];
    let lastY: number | null = null;
    for (const it of content.items as any[]) {
      if (!("str" in it)) continue;
      const y = it.transform?.[5] as number;
      if (lastY !== null && Math.abs(y - lastY) > 4) {
        lines.push(line);
        line = "";
      }
      line += it.str + (it.hasEOL ? "\n" : "");
      lastY = y;
    }
    lines.push(line);
    pages.push(lines.join("\n"));
  }
  const text = pages.join("\n\n").replace(/-\n(?=[a-z])/g, "").replace(/[ \t]+/g, " ").trim();
  if (text.replace(/\s/g, "").length >= 80 * Math.min(pdf.numPages, 3)) return text;

  // Scanned PDF: render pages and OCR the first 25.
  const out: string[] = [];
  const limit = Math.min(pdf.numPages, 25);
  for (let i = 1; i <= limit; i++) {
    progress(`Scanned PDF: reading page ${i} of ${limit}…`);
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2, 2600 / Math.max(base.width, base.height)) }); // cap huge poster-size pages
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    try {
      await page.render({ canvas, viewport: vp } as any).promise;
      const blob = await new Promise<Blob>((r, j) => canvas.toBlob((b) => (b ? r(b) : j(new Error("Couldn't render that PDF page."))), "image/png"));
      out.push(await ocrImage(blob, s));
    } finally {
      canvas.width = canvas.height = 0; // release the bitmap right away
      page.cleanup();
    }
  }
  const ocrText = out.join("\n\n");
  // Don't truncate silently: say so inside the text (only when something was read, so the empty-result checks still fire).
  return ocrText.trim() && pdf.numPages > limit ? `${ocrText}\n\n[Only the first ${limit} of ${pdf.numPages} pages were read (scanned PDF).]` : ocrText;
}

/* ---------------- PPTX ---------------- */

/** Decode XML entities in one pass (sequential replaces turn "&amp;lt;" into "<"), including numeric ones and &apos;. */
export const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const c = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase() as "amp"] ?? m;
  });

const paragraphs = (xml: string) =>
  [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)]
    .map((p) => decodeXml([...p[1].replace(/<a:br\b[^>]*\/>|<a:br\b[^>]*>[\s\S]*?<\/a:br>/g, "<a:t> </a:t>").matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((t) => t[1]).join("")))
    .filter((p) => p.trim());

const relAttr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";

async function readPptx(file: File): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const read = async (n: string) => (await zip.file(n)?.async("string")) ?? "";
  const byNumber = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/\d+/)![0] - +b.match(/\d+/)![0]);

  // Real slide order lives in presentation.xml (file numbers don't follow it once slides are reordered).
  let slides = byNumber;
  try {
    const rels = new Map([...(await read("ppt/_rels/presentation.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)].map((m) => [relAttr(m[0], "Id"), relAttr(m[0], "Target")]));
    const ordered = [...(await read("ppt/presentation.xml")).matchAll(/<p:sldId\b[^>]*>/g)]
      .map((m) => rels.get(relAttr(m[0], "r:id")))
      .filter((t): t is string => !!t)
      .map((t) => (t.startsWith("/") ? t.slice(1) : "ppt/" + t.replace(/^\.\//, "")))
      .filter((n) => zip.file(n));
    if (ordered.length) slides = ordered;
  } catch {
    /* fall back to file-number order */
  }

  const out: string[] = [];
  for (const [i, n] of slides.entries()) {
    const parts = paragraphs(await read(n));
    // Speaker notes: only the body placeholder (the notes page also holds a slide thumbnail and a slide-number field).
    const relsXml = await read(n.replace("slides/", "slides/_rels/") + ".rels");
    const noteRel = [...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => /\/notesSlide$/.test(relAttr(r, "Type")));
    if (noteRel) {
      const notes = await read("ppt/notesSlides/" + relAttr(noteRel, "Target").split("/").pop());
      const body = [...notes.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).filter((sp) => /<p:ph\b[^>]*type="body"/.test(sp));
      const nt = body.flatMap(paragraphs);
      if (nt.length) parts.push("Notes: " + nt.join(" "));
    }
    if (parts.length) out.push(`Slide ${i + 1}\n${parts.join("\n")}`);
  }
  return out.join("\n\n");
}

/* ---------------- OCR (vision LLM if available, else in-browser Tesseract) ---------------- */

const toDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

export async function ocrImage(img: Blob, s: Settings): Promise<string> {
  if (hasLLM(s)) {
    try {
      const out = await complete(s, "fast", [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe all text in this image faithfully (handwriting included), preserving structure. Write math as LaTeX in $...$. Output only the transcription." },
            { type: "image_url", image_url: { url: await toDataUrl(img) } },
          ],
        },
      ]);
      if (out.trim()) return out;
    } catch (e) {
      console.warn("Vision OCR failed, falling back to Tesseract", e);
    }
  }
  const { createWorker } = await import("tesseract.js");
  const w = await createWorker("eng");
  try {
    const { data } = await w.recognize(img);
    return data.text;
  } finally {
    await w.terminate();
  }
}

/* ---------------- YouTube ---------------- */

export type YT = { title: string; text: string; author?: string; url: string; fromApi: boolean };

export function isYouTube(s: string) {
  return /(?:youtube\.com\/(?:watch|shorts|live|embed)|youtu\.be\/)/i.test(s.trim());
}

/** Fetch captions through the app's server route. Returns null if unavailable (static hosting or YouTube refused). */
export async function fetchYouTube(url: string): Promise<{ ok: true; data: YT } | { ok: false; error: string; title?: string }> {
  try {
    const r = await fetch(`/api/youtube?url=${encodeURIComponent(url.trim())}`, { signal: AbortSignal.timeout(60_000) }); // never hang on a stalled lookup
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return { ok: false, error: "The transcript service isn't available on this host." };
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j.error ?? "Transcript lookup failed.", title: j.title };
    return { ok: true, data: { title: j.title, text: j.text, author: j.author, url, fromApi: true } };
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError") return { ok: false, error: "The transcript lookup timed out." };
    return { ok: false, error: "Couldn't reach the transcript service." };
  }
}

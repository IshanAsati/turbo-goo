import type { DocKind, Settings } from "./types";
import { complete, hasLLM, transcribe } from "./llm";
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
    if (!hasLLM(s)) {
      throw new Error("Transcribing audio/video files needs a speech-to-text API key (Settings → AI provider). To work offline, use Record lecture (live transcription) instead.");
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
  return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

async function readPdf(file: File, s: Settings, progress: Progress): Promise<string> {
  const pdf = await loadPdf(file);
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    progress(`Reading PDF page ${i} of ${pdf.numPages}…`);
    const content = await (await pdf.getPage(i)).getTextContent();
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
    const vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvas, viewport: vp } as any).promise;
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    out.push(await ocrImage(blob, s));
  }
  return out.join("\n\n");
}

/* ---------------- PPTX ---------------- */

async function readPptx(file: File): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/\d+/)![0] - +b.match(/\d+/)![0]);
  const out: string[] = [];
  for (const [i, n] of slides.entries()) {
    const xml = await zip.files[n].async("string");
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(""));
    const text = paras.filter(Boolean).join("\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    if (text.trim()) out.push(`Slide ${i + 1}\n${text}`);
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
    const r = await fetch(`/api/youtube?url=${encodeURIComponent(url.trim())}`);
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return { ok: false, error: "The transcript service isn't available on this host." };
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j.error ?? "Transcript lookup failed.", title: j.title };
    return { ok: true, data: { title: j.title, text: j.text, author: j.author, url, fromApi: true } };
  } catch {
    return { ok: false, error: "Couldn't reach the transcript service." };
  }
}

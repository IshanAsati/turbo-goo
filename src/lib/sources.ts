import type { Attachment, Doc, DocKind, Settings } from "./types";
import { fetchYouTube, ingestFile, isYouTube } from "./ingest";
import { cleanTranscript } from "./text";
import { uid } from "./store";

/** Turn any input (file, YouTube link, pasted text, library document) into a prompt attachment. */

export async function attachFile(file: File, s: Settings, progress: (m: string) => void): Promise<Attachment> {
  const r = await ingestFile(file, s, progress);
  if (r.source.trim().length < 20) throw new Error(`I couldn't find any text in “${file.name}”.`);
  return { id: uid(), name: file.name, kind: r.kind, text: r.source };
}

export async function attachYouTube(url: string): Promise<Attachment> {
  if (!isYouTube(url)) throw new Error("That doesn't look like a YouTube link.");
  const r = await fetchYouTube(url);
  if (!r.ok) throw new Error(`${r.error} Open the video, use “Show transcript”, and attach it as pasted text instead.`);
  return { id: uid(), name: r.data.title || "YouTube video", kind: "youtube", text: r.data.text, url: url.trim() };
}

export function attachText(text: string, name?: string): Attachment {
  const clean = /-->|^\d{1,2}:\d{2}/m.test(text) ? cleanTranscript(text) : text.trim();
  return { id: uid(), name: name?.trim() || clean.split(/[\n.!?]/)[0].slice(0, 48) || "Pasted text", kind: "text", text: clean };
}

export function attachDoc(d: Doc): Attachment {
  return { id: uid(), name: d.title, kind: "doc", text: d.source.trim() || d.notes, docId: d.id };
}

/** One labelled source text, so the model (and the offline engine) can tell the sources apart. */
export function combineSources(atts: Attachment[]): string {
  if (atts.length === 1) return atts[0].text;
  return atts.map((a, i) => `## Source ${i + 1}: ${a.name}\n\n${a.text.trim()}`).join("\n\n");
}

export function kindOf(atts: Attachment[]): DocKind {
  if (atts.length === 1) return atts[0].kind === "doc" ? "text" : atts[0].kind;
  return atts.some((a) => a.kind === "audio" || a.kind === "youtube") ? "audio" : "file";
}

export const sizeLabel = (chars: number) => (chars > 9500 ? `${Math.round(chars / 1000)}k chars` : `${chars.toLocaleString()} chars`);

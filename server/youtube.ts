/**
 * YouTube transcript extraction (server side; used by the Vite dev middleware and the Vercel function).
 *
 * YouTube gates its plain caption URLs behind proof-of-origin tokens and blocks many datacenter IPs, so no single
 * method is reliable. We try several in order and report why each failed, so the UI can fall back to
 * "paste from Show transcript".
 */

export type Segment = { start: number; text: string };
export type Transcript = { videoId: string; title: string; author: string; lang: string; segments: Segment[]; text: string; method: string };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const COOKIE = "CONSENT=YES+cb; SOCS=CAI";

export function videoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const clean = (s: string) => decode(s).replace(/\s+/g, " ").trim();

async function get(url: string, init: RequestInit = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: COOKIE, ...(init.headers as object) } });
  } finally {
    clearTimeout(t);
  }
}

function extractJSON(html: string, marker: string): any | null {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  let j = html.indexOf("{", i);
  if (j < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(j, k + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

type Track = { baseUrl: string; languageCode: string; kind?: string; name?: any };

function pickTrack(tracks: Track[], prefer: string): Track | undefined {
  const rank = (t: Track) => (t.languageCode === prefer ? 0 : t.languageCode.startsWith(prefer) ? 1 : 2) * 2 + (t.kind === "asr" ? 1 : 0);
  return [...tracks].sort((a, b) => rank(a) - rank(b))[0];
}

function parseTimedText(body: string): Segment[] {
  const t = body.trim();
  if (!t) return [];
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    return (j.events ?? [])
      .filter((e: any) => e.segs)
      .map((e: any) => ({ start: (e.tStartMs ?? 0) / 1000, text: clean(e.segs.map((s: any) => s.utf8 ?? "").join("")) }))
      .filter((s: Segment) => s.text);
  }
  const out: Segment[] = [];
  // <text start="1.2" dur="3">…</text>  (classic)  or  <p t="1200" d="3000">…</p> (srv3)
  for (const m of t.matchAll(/<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) out.push({ start: +m[1], text: clean(m[2].replace(/<[^>]+>/g, "")) });
  if (!out.length) for (const m of t.matchAll(/<p[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) out.push({ start: +m[1] / 1000, text: clean(m[2].replace(/<[^>]+>/g, "")) });
  return out.filter((s) => s.text);
}

async function fromCaptionTracks(tracks: Track[], lang: string): Promise<{ segs: Segment[]; lang: string }> {
  const tr = pickTrack(tracks, lang);
  if (!tr) throw new Error("no caption tracks");
  for (const fmt of ["json3", "srv3", ""]) {
    const url = tr.baseUrl.replace(/&fmt=[^&]*/, "") + (fmt ? `&fmt=${fmt}` : "");
    const r = await get(url);
    const body = await r.text();
    const segs = body ? parseTimedText(body) : [];
    if (segs.length) return { segs, lang: tr.languageCode };
  }
  throw new Error("caption URL returned an empty body (proof-of-origin gate)");
}

/** Method 1: the same endpoint behind the "Show transcript" button. */
async function viaGetTranscript(html: string, id: string): Promise<{ segs: Segment[]; lang: string }> {
  const params = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/)?.[1];
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const ver = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? "2.20250101.00.00";
  if (!params || !key) throw new Error("watch page has no transcript panel");
  const r = await get(`https://www.youtube.com/youtubei/v1/get_transcript?key=${key}&prettyPrint=false`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.youtube.com", referer: `https://www.youtube.com/watch?v=${id}` },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: ver, hl: "en" } }, params }),
  });
  if (!r.ok) throw new Error(`get_transcript HTTP ${r.status}`);
  const j = await r.json();
  const list =
    j.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer
      ?.initialSegments ?? [];
  const segs: Segment[] = list
    .map((x: any) => x.transcriptSegmentRenderer)
    .filter(Boolean)
    .map((x: any) => ({
      start: (+x.startMs || 0) / 1000,
      text: clean((x.snippet?.runs ?? []).map((r: any) => r.text).join("") || x.snippet?.simpleText || ""),
    }))
    .filter((s: Segment) => s.text);
  if (!segs.length) throw new Error("get_transcript returned no segments");
  return { segs, lang: "en" };
}

/** Method 3: Android client player response (often exposes tracks the web player hides). */
async function viaAndroid(id: string, lang: string): Promise<{ segs: Segment[]; lang: string; title?: string; author?: string }> {
  const r = await get("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip" },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en" } }, videoId: id }),
  });
  if (!r.ok) throw new Error(`android player HTTP ${r.status}`);
  const j = await r.json();
  const tracks: Track[] = j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const res = await fromCaptionTracks(tracks, lang);
  return { ...res, title: j.videoDetails?.title, author: j.videoDetails?.author };
}

export async function getTranscript(input: string, lang = "en"): Promise<Transcript> {
  const id = videoId(input);
  if (!id) throw new Error("That doesn't look like a YouTube link.");

  const reasons: string[] = [];
  let html = "";
  try {
    html = await (await get(`https://www.youtube.com/watch?v=${id}&hl=en`)).text();
  } catch (e) {
    reasons.push(`watch page: ${(e as Error).message}`);
  }
  const player = html ? extractJSON(html, "ytInitialPlayerResponse") : null;
  const status = player?.playabilityStatus?.status;
  if (status && status !== "OK") throw new Error(`Video unavailable (${player.playabilityStatus.reason ?? status}).`);
  let title: string = player?.videoDetails?.title ?? "";
  let author: string = player?.videoDetails?.author ?? "";

  const finish = (segs: Segment[], l: string, method: string): Transcript => ({
    videoId: id,
    title: title || `YouTube ${id}`,
    author,
    lang: l,
    segments: segs,
    text: segs.map((s) => s.text).join(" "),
    method,
  });

  if (html) {
    try {
      const r = await viaGetTranscript(html, id);
      return finish(r.segs, r.lang, "transcript-panel");
    } catch (e) {
      reasons.push(`transcript panel: ${(e as Error).message}`);
    }
    try {
      const tracks: Track[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const r = await fromCaptionTracks(tracks, lang);
      return finish(r.segs, r.lang, "caption-tracks");
    } catch (e) {
      reasons.push(`caption tracks: ${(e as Error).message}`);
    }
  }
  try {
    const r = await viaAndroid(id, lang);
    title ||= r.title ?? "";
    author ||= r.author ?? "";
    return finish(r.segs, r.lang, "android-client");
  } catch (e) {
    reasons.push(`android client: ${(e as Error).message}`);
  }
  const err = new Error(`Couldn't fetch a transcript automatically (${reasons.join("; ")}).`) as Error & { title?: string };
  err.title = title;
  throw err;
}

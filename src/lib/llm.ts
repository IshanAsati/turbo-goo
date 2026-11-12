import type { Settings } from "./types";

export const hasLLM = (s: Settings) => !!s.apiKey.trim();

export class LLMError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export type Tier = "fast" | "smart";
export const modelFor = (s: Settings, tier: Tier) => (tier === "fast" ? s.fastModel || s.model : s.model);

const base = (s: Settings) => s.baseUrl.trim().replace(/\/+$/, "");
// Local servers (Ollama, Chatterbox, local Whisper) often need no key, so only send Authorization when there is one.
const headers = (s: Settings, extra: Record<string, string> = {}) => ({ ...(s.apiKey.trim() ? { Authorization: `Bearer ${s.apiKey}` } : {}), ...extra });
export const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u.trim());

function friendly(status: number, body: string): string {
  let detail = "";
  try {
    const j = JSON.parse(body);
    detail = typeof j.detail === "string" ? j.detail : typeof j.error?.message === "string" ? j.error.message : "";
  } catch {
    /* not JSON */
  }
  if (status === 401) return "The API key was rejected (401). Check it in Settings.";
  if (status === 404 && /not found for account/i.test(detail || body))
    return "That model isn't enabled for your account (404: function not found for account). Providers like NVIDIA turn models on per account. In Settings, click “Find models that work on my account” and pick one.";
  if (status === 404) return detail ? `Not found (404): ${detail.slice(0, 200)}` : "The endpoint or model wasn't found (404). Check the Base URL and model names in Settings.";
  if (status === 429) return "Rate limit or quota reached (429). Wait a moment or check your provider's billing.";
  if (status >= 500) return `The AI provider had a server error (${status}). Try again shortly.`;
  return `AI request failed (${status}): ${body.slice(0, 200)}`;
}

async function request(s: Settings, path: string, init: RequestInit, opts: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}): Promise<Response> {
  const { timeoutMs = 90_000, retries = 2, signal } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal?.aborted) throw new LLMError("Cancelled.");
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base(s)}${path}`, { ...init, signal: ctl.signal });
      if (res.ok) return res;
      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw new LLMError(friendly(res.status, body), res.status);
    } catch (e) {
      if (e instanceof LLMError) throw e;
      if (signal?.aborted) throw new LLMError("Cancelled.");
      lastErr = e;
      const timedOut = (e as Error).name === "AbortError";
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw new LLMError(
        timedOut
          ? "The AI provider took too long to respond. Try again, or use a faster model."
          : `Couldn't reach the AI provider (${(e as Error).message || "network error"}) at ${base(s)}${path}. Check your connection, the Base URL, and that the provider allows browser requests (CORS).`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

type Msg = { role: "system" | "user" | "assistant"; content: string | unknown[] };

/* ---------------- request stats (shown in Settings → Recent requests) ---------------- */

export type ReqStat = { at: number; model: string; kind: "stream" | "complete"; firstTokenMs?: number; totalMs: number; outTokens?: number; reasoningTokens?: number; outChars: number; reasoningChars: number; ok: boolean };
let stats: ReqStat[] = [];
const statListeners = new Set<() => void>();
function logStat(r: ReqStat) {
  stats = [r, ...stats].slice(0, 30);
  statListeners.forEach((l) => l());
  const tps = r.outTokens && r.firstTokenMs !== undefined ? Math.round(r.outTokens / Math.max(0.001, (r.totalMs - r.firstTokenMs) / 1000)) : undefined;
  console.info(`[llm] ${r.model} ${r.kind} first-token=${r.firstTokenMs ?? "-"}ms total=${r.totalMs}ms out=${r.outTokens ?? "?"}tok reasoning=${r.reasoningTokens ?? "?"}tok${tps ? ` ~${tps} tok/s` : ""}`);
}
export const subscribeStats = (cb: () => void) => (statListeners.add(cb), () => void statListeners.delete(cb));
export const getStats = () => stats;

/** Reasoning control. "auto" sends nothing, so providers that don't know the field never see it.
 *  `noThink` forces thinking off (used to retry when a reasoning model spent its whole output budget thinking). */
const rejectsReasoning = new Set<string>(); // base URLs that answered 400 to the reasoning field
function withReasoning(s: Settings, body: Record<string, unknown>, noThink = false) {
  const effort = noThink ? "none" : s.reasoning;
  // NVIDIA NIM ignores the `reasoning` effort field (measured: "low" still thought for 5-10k characters, 20-80 s per call).
  // Its only working switch is the chat template, so on NVIDIA "low" and "none" both mean thinking off.
  let host = "";
  try {
    host = new URL(base(s)).hostname;
  } catch {
    /* half-typed Base URL: request() reports it */
  }
  const nim = /(^|\.)nvidia\.com$/i.test(host);
  if (nim) {
    if (effort === "none" || effort === "low") body.chat_template_kwargs = { enable_thinking: false };
    return body;
  }
  if (effort && effort !== "auto" && !rejectsReasoning.has(base(s))) body.reasoning = { effort };
  // vLLM-style servers switch thinking off through the chat template as well.
  if (effort === "none") body.chat_template_kwargs = { enable_thinking: false };
  return body;
}

const EMPTY_MSG = "The model sent no answer: it used its whole output budget on hidden thinking. Set “Thinking before answering” to Off in Settings, or choose a model that doesn't think.";
/** Retry once without optional fields some providers reject (response_format, reasoning, stream_options). */
const OPTIONAL = ["response_format", "reasoning", "stream_options", "chat_template_kwargs"] as const;
async function sendTolerant(s: Settings, body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number; retries?: number }) {
  const post = (b: Record<string, unknown>) => request(s, "/chat/completions", { method: "POST", headers: headers(s, { "Content-Type": "application/json" }), body: JSON.stringify(b) }, opts);
  try {
    return await post(body);
  } catch (e) {
    if (!(e instanceof LLMError && e.status === 400) || !OPTIONAL.some((k) => k in body)) throw e;
    const rest = { ...body };
    OPTIONAL.forEach((k) => delete rest[k]);
    const res = await post(rest);
    if ("reasoning" in body) rejectsReasoning.add(base(s));
    return res;
  }
}

export async function complete(s: Settings, tier: Tier, messages: Msg[], o: { json?: boolean; signal?: AbortSignal; maxTokens?: number; temperature?: number } = {}, noThink = false): Promise<string> {
  // Structured jobs (cards, quiz, grading, outlines) gain nothing from hidden thinking and it can cost a minute per call.
  const body = withReasoning(s, { model: modelFor(s, tier), messages, temperature: o.temperature ?? 0.4 }, noThink || !!o.json);
  if (o.maxTokens) body.max_tokens = o.maxTokens;
  if (o.json) body.response_format = { type: "json_object" };
  const t0 = performance.now();
  const res = await sendTolerant(s, body, { signal: o.signal });
  const data = await res.json();
  const choice = data.choices?.[0];
  const msg = choice?.message ?? {};
  const out: string = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: { text?: string }) => p.text ?? "").join("") : "";
  const thought: string = msg.reasoning_content ?? msg.reasoning ?? "";
  logStat({ at: Date.now(), model: String(body.model), kind: "complete", totalMs: Math.round(performance.now() - t0), outTokens: data.usage?.completion_tokens, reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens, outChars: out.length, reasoningChars: thought.length, ok: !!out.trim() });
  if (!out.trim()) {
    // A thinking model can spend the whole budget before the first visible word. Try once with thinking off.
    if (!(noThink || o.json) && (thought || choice?.finish_reason === "length")) return complete(s, tier, messages, { ...o, maxTokens: o.maxTokens ? Math.max(o.maxTokens, 1500) : undefined }, true);
    throw new LLMError(thought || choice?.finish_reason === "length" ? EMPTY_MSG : "The model returned an empty answer. Try again, or choose a different model.");
  }
  return out;
}

/** Streams tokens via SSE. Calls onText with the accumulated answer so far, and onThinking while the model reasons. */
export async function stream(
  s: Settings,
  tier: Tier,
  messages: Msg[],
  onText: (full: string) => void,
  o: { signal?: AbortSignal; temperature?: number; maxTokens?: number; onThinking?: (chars: number) => void; noThink?: boolean } = {},
): Promise<string> {
  const body = withReasoning(s, { model: modelFor(s, tier), messages, stream: true, stream_options: { include_usage: true }, temperature: o.temperature ?? 0.4 }, !!o.noThink);
  if (o.maxTokens) body.max_tokens = o.maxTokens;
  const t0 = performance.now();
  const res = await sendTolerant(s, body, { signal: o.signal, timeoutMs: 120_000, retries: 1 });
  if (!res.body) {
    const msg = (await res.json()).choices?.[0]?.message ?? {};
    const t: string = typeof msg.content === "string" ? msg.content : "";
    if (!t.trim()) throw new LLMError(msg.reasoning_content || msg.reasoning ? EMPTY_MSG : "The model returned an empty answer. Try again, or choose a different model.");
    onText(t);
    return t;
  }
  const reader = res.body.getReader();
  // request() drops its abort listener once headers arrive, so stop the body read here too.
  // Cancelling the reader ends the loop and keeps whatever text has already streamed in.
  const stop = () => void reader.cancel().catch(() => {});
  o.signal?.addEventListener("abort", stop);
  if (o.signal?.aborted) stop();
  // A stream that goes silent (provider hung, connection half-open) would otherwise wait forever.
  const IDLE_MS = 90_000;
  let stalled = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ((stalled = true), stop()), IDLE_MS);
  };
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let thinking = 0;
  let first: number | undefined;
  let usage: any;
  let finish: string | undefined;
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          const ch = j.choices?.[0];
          if (ch?.finish_reason) finish = ch.finish_reason;
          const d = ch?.delta ?? {};
          const r = d.reasoning ?? d.reasoning_content;
          if (typeof r === "string" && r) {
            thinking += r.length;
            o.onThinking?.(thinking);
          }
          if (typeof d.content === "string" && d.content) {
            first ??= Math.round(performance.now() - t0);
            full += d.content;
            onText(full);
          }
        } catch {
          /* partial/keepalive line */
        }
      }
    }
  } finally {
    clearTimeout(idle);
    o.signal?.removeEventListener("abort", stop);
  }
  logStat({ at: Date.now(), model: String(body.model), kind: "stream", firstTokenMs: first, totalMs: Math.round(performance.now() - t0), outTokens: usage?.completion_tokens, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens, outChars: full.length, reasoningChars: thinking, ok: !!full.trim() });
  if (stalled && !full.trim()) throw new LLMError("The AI provider stopped responding mid-answer. Try again, or use a faster model.");
  if (!full.trim() && !o.signal?.aborted) {
    // Everything went into hidden thinking: retry once with thinking off, then fail with a clear message.
    if (!o.noThink && (thinking > 0 || finish === "length")) return stream(s, tier, messages, onText, { ...o, noThink: true, maxTokens: o.maxTokens ? Math.max(o.maxTokens, 2500) : undefined });
    throw new LLMError(thinking > 0 || finish === "length" ? EMPTY_MSG : "The model returned an empty answer. Try again, or choose a different model.");
  }
  return full;
}
/** Tolerant JSON extraction (models sometimes wrap JSON in prose or code fences). */
export function parseJSON<T>(text: string): T | null {
  const t = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as T;
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }
}

export async function completeJSON<T>(s: Settings, tier: Tier, system: string, user: string, o: { signal?: AbortSignal } = {}): Promise<T | null> {
  if (!hasLLM(s)) return null;
  const out = await complete(s, tier, [{ role: "system", content: system + "\nRespond with a single valid JSON object only. No prose." }, { role: "user", content: user }], { json: true, signal: o.signal, temperature: 0.3 });
  return parseJSON<T>(out);
}

/** Speech-to-text connection: its own provider if configured, otherwise the main AI provider.
 *  The main key is never sent to a different STT host. */
const sttConn = (s: Settings): Settings => (s.sttBaseUrl?.trim() ? { ...s, baseUrl: s.sttBaseUrl, apiKey: s.sttApiKey ?? "" } : s);
export const hasSTT = (s: Settings) => { const c = sttConn(s); return !!c.apiKey.trim() || (!!s.sttBaseUrl?.trim() && isLocalUrl(c.baseUrl)); };

/** Speech-to-text via an OpenAI-compatible /audio/transcriptions endpoint (Whisper). */
export async function transcribe(s: Settings, blob: Blob, filename = "audio.webm", signal?: AbortSignal): Promise<string> {
  if (blob.size > 25 * 1024 * 1024) throw new LLMError("That audio file is over 25 MB, the limit for transcription. Trim it or compress it first.");
  const c = sttConn(s);
  if (!hasSTT(s)) throw new LLMError("Speech-to-text isn't set up. Add a provider under Settings → Speech-to-text.");
  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("model", s.sttModel || "whisper-1");
  const res = await request(c, "/audio/transcriptions", { method: "POST", headers: headers(c), body: fd }, { timeoutMs: 600_000, retries: 1, signal });
  const data = await res.json();
  return data.text ?? "";
}

/** Sends a one-second silent WAV to check the STT provider, key and model. */
export async function testSTT(s: Settings): Promise<string> {
  const rate = 16000;
  const n = rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  const t0 = performance.now();
  await transcribe(s, new Blob([buf], { type: "audio/wav" }), "test.wav");
  return `Connected · ${s.sttModel || "whisper-1"} at ${base(sttConn(s))} answered in ${Math.round(performance.now() - t0)} ms`;
}

export const STT_PRESETS: { name: string; baseUrl: string; model: string; note: string }[] = [
  { name: "Same as AI provider", baseUrl: "", model: "whisper-1", note: "Uses the Base URL and key above. Works only if that provider has /audio/transcriptions." },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", note: "Fast, cheap Whisper. Free tier available." },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "whisper-1", note: "The original Whisper API." },
];

/* ---------------- text-to-speech (podcast voices) ---------------- */

/** TTS connection: its own provider if configured, otherwise the main AI provider. The main key never goes to another host. */
const ttsConn = (s: Settings): Settings => (s.ttsBaseUrl?.trim() ? { ...s, baseUrl: s.ttsBaseUrl, apiKey: s.ttsApiKey ?? "" } : s);
/** Local servers like Chatterbox need no key; hosted ones do. */
export const hasTTS = (s: Settings) => { const c = ttsConn(s); return !!c.apiKey.trim() || (!!s.ttsBaseUrl?.trim() && isLocalUrl(c.baseUrl)); };
export const ttsLabel = (s: Settings) => (/chatterbox/i.test(s.ttsModel) ? "Chatterbox" : s.ttsBaseUrl?.trim() ? new URL(base(ttsConn(s))).hostname : "HD");
/** Chatterbox-Turbo reads [laugh], [chuckle], [cough] etc. as sounds, so the podcast script may include them. */
export const ttsSupportsTags = (s: Settings) => /chatterbox/i.test(s.ttsModel) && hasTTS(s);
export const SOUND_TAGS = /\s*\[(laugh|laughs|chuckle|cough|sigh|gasp|groan|moan|sniff|clear throat|shush)\]\s*/gi;

/** Text-to-speech via an OpenAI-compatible /audio/speech endpoint. Returns an mp3 blob. */
export async function speech(s: Settings, text: string, voice: string, signal?: AbortSignal): Promise<Blob> {
  const c = ttsConn(s);
  if (!hasTTS(s)) throw new LLMError("Text-to-speech isn't set up. Add a provider under Settings → Text-to-speech.");
  const input = (ttsSupportsTags(s) ? text : text.replace(SOUND_TAGS, " ")).trim().slice(0, 4000);
  const res = await request(
    c,
    "/audio/speech",
    { method: "POST", headers: headers(c, { "Content-Type": "application/json" }), body: JSON.stringify({ model: s.ttsModel || "tts-1", voice, input, response_format: "mp3" }) },
    // Local models on CPU can take a while per line.
    { timeoutMs: isLocalUrl(c.baseUrl) ? 300_000 : 120_000, signal },
  );
  const blob = await res.blob();
  if (blob.type.includes("json") || blob.size < 200) throw new LLMError(`The speech server returned no audio: ${(await blob.text()).slice(0, 160)}`);
  return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: "audio/mpeg" });
}

export async function testTTS(s: Settings): Promise<{ msg: string; audio: Blob }> {
  const t0 = performance.now();
  const audio = await speech(s, "Hi! This is Goo, testing the podcast voice.", s.ttsVoiceA || "nova");
  return { msg: `Connected · ${s.ttsModel} at ${base(ttsConn(s))} made ${Math.round(audio.size / 1024)} KB of audio in ${((performance.now() - t0) / 1000).toFixed(1)} s`, audio };
}

/** Voice names from servers that list them (Chatterbox: GET /v1/audio/voices). OpenAI has no list, so this returns []. */
export async function listVoices(s: Settings): Promise<string[]> {
  const c = ttsConn(s);
  const res = await request(c, "/audio/voices", { headers: headers(c) }, { timeoutMs: 15_000, retries: 0 });
  const j = await res.json();
  const list = Array.isArray(j) ? j : (j.voices ?? j.data ?? []);
  return list.map((v: any) => (typeof v === "string" ? v : v.id ?? v.name ?? v.filename)).filter(Boolean);
}

export const TTS_PRESETS: { name: string; baseUrl: string; model: string; a: string; b: string; note: string }[] = [
  { name: "Same as AI provider", baseUrl: "", model: "tts-1", a: "nova", b: "onyx", note: "Uses the AI provider's Base URL and key. Works only if it has /audio/speech (OpenAI does)." },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "tts-1", a: "nova", b: "onyx", note: "Hosted, paid per character." },
  { name: "Chatterbox-Turbo (local)", baseUrl: "http://localhost:8004/v1", model: "chatterbox-turbo", a: "Olivia.wav", b: "Ryan.wav", note: "Free and private. Run Chatterbox-TTS-Server on this computer with the Turbo engine selected. No key needed." },
];

export async function testConnection(s: Settings): Promise<string> {
  const t0 = performance.now();
  const out = await complete(s, "fast", [{ role: "user", content: "Reply with the single word: ready" }], { maxTokens: 512, temperature: 0 });
  return `Connected · ${modelFor(s, "fast")} replied "${out.trim().slice(0, 20)}" in ${Math.round(performance.now() - t0)} ms`;
}

/* ---------------- find which models an account can actually use ---------------- */

export type ProbeResult = { id: string; ms: number };
const NOT_CHAT = /embed|rerank|safety|guard|reward|whisper|tts|speech|dall|image|moderation|clip|vision-encoder|parse|retriev|riva|transcri/i;

/** Lists the provider's models and sends each a tiny chat request. Returns the ones that answer, fastest first. */
export async function probeModels(s: Settings, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<ProbeResult[]> {
  const res = await request(s, "/models", { headers: headers(s) }, { timeoutMs: 20_000, retries: 0, signal });
  const ids: string[] = ((await res.json()).data ?? []).map((m: { id: string }) => m.id).filter((id: string) => id && !NOT_CHAT.test(id)).slice(0, 90);
  const found: ProbeResult[] = [];
  const queue = [...ids];
  let done = 0;
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const id = queue.shift()!;
      const t0 = performance.now();
      try {
        const r = await request(s, "/chat/completions", { method: "POST", headers: headers(s, { "Content-Type": "application/json" }), body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 300, temperature: 0.2 }) }, { timeoutMs: 20_000, retries: 0, signal });
        const j = await r.json();
        const m = j.choices?.[0]?.message;
        if (m && (m.content || m.reasoning_content || m.reasoning)) found.push({ id, ms: Math.round(performance.now() - t0) });
      } catch {
        /* not enabled, too slow, or not a chat model */
      }
      onProgress?.(++done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return found.sort((a, b) => a.ms - b.ms);
}
export const PRESETS: { name: string; baseUrl: string; model: string; fast: string; note: string; reasoning: Settings["reasoning"] }[] = [
  { name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", model: "nvidia/nemotron-3.5-lightning-free", fast: "nvidia/nemotron-3.5-lightning-free", note: "One key for many models. Nemotron 3.5 Lightning is free; the provider may retain prompts.", reasoning: "low" },
  { name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/nemotron-3-ultra-550b-a55b", fast: "nvidia/nemotron-3.5-lightning-30b-a3b", note: "Key starts with nvapi-. Models are enabled per account: use “Find models that work on my account” if one 404s. Desktop app only: NVIDIA blocks browser (CORS) requests.", reasoning: "none" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", fast: "gpt-4o-mini", note: "Also enables Whisper transcription and HD podcast voices.", reasoning: "auto" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5", fast: "google/gemini-2.5-flash", note: "One key for Claude, Gemini, Llama and more.", reasoning: "auto" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant", note: "Very fast. Whisper: set speech model to whisper-large-v3.", reasoning: "auto" },
  { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro", fast: "gemini-2.5-flash", note: "Generous free tier.", reasoning: "auto" },
  { name: "Together AI", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", fast: "meta-llama/Llama-3.1-8B-Instruct-Turbo", note: "Cheap open-weight models.", reasoning: "auto" },
  { name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1", fast: "llama3.1", note: "Free and private. Start Ollama with OLLAMA_ORIGINS=* and enter any key.", reasoning: "auto" },
];

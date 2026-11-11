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

const base = (s: Settings) => s.baseUrl.replace(/\/+$/, "");
const headers = (s: Settings, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${s.apiKey}`, ...extra });

function friendly(status: number, body: string): string {
  if (status === 401) return "The API key was rejected (401). Check it in Settings.";
  if (status === 404) return "The endpoint or model wasn't found (404). Check the Base URL and model names in Settings.";
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
          : "Couldn't reach the AI provider. Check your connection, the Base URL, and that the provider allows browser requests (CORS).",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

type Msg = { role: "system" | "user" | "assistant"; content: string | unknown[] };

export async function complete(s: Settings, tier: Tier, messages: Msg[], o: { json?: boolean; signal?: AbortSignal; maxTokens?: number; temperature?: number } = {}): Promise<string> {
  const body: Record<string, unknown> = { model: modelFor(s, tier), messages, temperature: o.temperature ?? 0.4 };
  if (o.maxTokens) body.max_tokens = o.maxTokens;
  const send = (json: boolean) =>
    request(s, "/chat/completions", { method: "POST", headers: headers(s, { "Content-Type": "application/json" }), body: JSON.stringify(json ? { ...body, response_format: { type: "json_object" } } : body) }, { signal: o.signal });
  let res: Response;
  try {
    res = await send(!!o.json);
  } catch (e) {
    // some providers reject response_format; retry once without it
    if (o.json && e instanceof LLMError && e.status === 400) res = await send(false);
    else throw e;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/** Streams tokens via SSE. Calls onDelta with the accumulated text so far. */
export async function stream(s: Settings, tier: Tier, messages: Msg[], onText: (full: string) => void, o: { signal?: AbortSignal; temperature?: number } = {}): Promise<string> {
  const res = await request(
    s,
    "/chat/completions",
    { method: "POST", headers: headers(s, { "Content-Type": "application/json" }), body: JSON.stringify({ model: modelFor(s, tier), messages, stream: true, temperature: o.temperature ?? 0.4 }) },
    { signal: o.signal, timeoutMs: 120_000, retries: 1 },
  );
  if (!res.body) {
    const t = (await res.json()).choices?.[0]?.message?.content ?? "";
    onText(t);
    return t;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onText(full);
        }
      } catch {
        /* partial/keepalive line */
      }
    }
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

/** Speech-to-text via an OpenAI-compatible /audio/transcriptions endpoint (Whisper). */
export async function transcribe(s: Settings, blob: Blob, filename = "audio.webm", signal?: AbortSignal): Promise<string> {
  if (blob.size > 25 * 1024 * 1024) throw new LLMError("That audio file is over 25 MB, the limit for transcription. Trim it or compress it first.");
  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("model", s.sttModel || "whisper-1");
  const res = await request(s, "/audio/transcriptions", { method: "POST", headers: headers(s), body: fd }, { timeoutMs: 600_000, retries: 1, signal });
  const data = await res.json();
  return data.text ?? "";
}

/** Text-to-speech via /audio/speech. Returns an mp3 blob. */
export async function speech(s: Settings, text: string, voice: string, signal?: AbortSignal): Promise<Blob> {
  const res = await request(
    s,
    "/audio/speech",
    { method: "POST", headers: headers(s, { "Content-Type": "application/json" }), body: JSON.stringify({ model: s.ttsModel || "tts-1", voice, input: text.slice(0, 4000) }) },
    { timeoutMs: 120_000, signal },
  );
  return res.blob();
}

export async function testConnection(s: Settings): Promise<string> {
  const t0 = performance.now();
  const out = await complete(s, "fast", [{ role: "user", content: "Reply with the single word: ready" }], { maxTokens: 8, temperature: 0 });
  return `Connected · ${modelFor(s, "fast")} replied "${out.trim().slice(0, 20)}" in ${Math.round(performance.now() - t0)} ms`;
}

export const PRESETS: { name: string; baseUrl: string; model: string; fast: string; note: string }[] = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", fast: "gpt-4o-mini", note: "Also enables Whisper transcription and HD podcast voices." },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5", fast: "google/gemini-2.5-flash", note: "One key for Claude, Gemini, Llama and more." },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant", note: "Very fast. Whisper: set speech model to whisper-large-v3." },
  { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro", fast: "gemini-2.5-flash", note: "Generous free tier." },
  { name: "Together AI", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", fast: "meta-llama/Llama-3.1-8B-Instruct-Turbo", note: "Cheap open-weight models." },
  { name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1", fast: "llama3.1", note: "Free and private. Start Ollama with OLLAMA_ORIGINS=* and enter any key." },
];

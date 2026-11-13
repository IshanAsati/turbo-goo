import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Activity, AudioLines, CheckCircle2, Database, Download, Eye, EyeOff, GraduationCap, Monitor, Moon, Palette as PaletteIcon, Plug, Sun, Upload, Volume2 } from "lucide-react";
import { PRESETS, STT_PRESETS, TTS_PRESETS, getStats, hasLLM, hasSTT, hasTTS, isLocalUrl, listVoices, probeModels, subscribeStats, testConnection, testSTT, testTTS } from "../lib/llm";
import { setSettings, setState, uid, useStore } from "../lib/store";
import { confirmDialog, toast } from "../components/feedback";
import { ankiTsv, download } from "./Flashcards";
import type { ProbeResult } from "../lib/llm";
import type { Doc, Settings, Thread } from "../lib/types";
import "../styles/settings.css";

type Result = { ok: boolean; msg: string } | null;

function useTest(fn: () => Promise<string>) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult({ ok: true, msg: await fn() });
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, run };
}

function KeyInput({ value, onChange, placeholder = "sk-…" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-row">
      <input type={show ? "text" : "password"} autoComplete="off" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value.trim())} />
      <button className="icon-btn" aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
    </div>
  );
}

const ResultBox = ({ r }: { r: Result }) =>
  r && (
    <div className={"callout " + (r.ok ? "ok" : "warn")} role="status">
      {r.ok && <CheckCircle2 size={18} />}
      <div>{r.msg}</div>
    </div>
  );

const REASONING: { id: Settings["reasoning"]; label: string }[] = [
  { id: "auto", label: "Provider default" },
  { id: "none", label: "Off" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

const SECTIONS = [
  { id: "focus", label: "Study focus", icon: GraduationCap },
  { id: "ai", label: "AI provider", icon: Plug },
  { id: "stt", label: "Speech-to-text", icon: AudioLines },
  { id: "tts", label: "Text-to-speech", icon: Volume2 },
  { id: "requests", label: "Recent requests", icon: Activity },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "data", label: "Your data", icon: Database },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** A rounded settings section with an icon, title, optional tag and a one-paragraph description. */
function Section({ id, tag, desc, children }: { id: SectionId; tag?: string; desc?: React.ReactNode; children: React.ReactNode }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  const Icon = s.icon;
  return (
    <section id={`se-${id}`} className="se-card" aria-labelledby={`se-h-${id}`}>
      <header className="se-card-head">
        <span className="se-ico" aria-hidden><Icon size={20} /></span>
        <div>
          <h2 id={`se-h-${id}`}>{s.label}{tag && <span className="se-tag">{tag}</span>}</h2>
          {desc && <p className="se-desc">{desc}</p>}
        </div>
      </header>
      <div className="se-body">{children}</div>
    </section>
  );
}

/** Sticky section index (wide screens). Highlights the section nearest the top of the viewport. */
function SectionIndex() {
  const [active, setActive] = useState<SectionId>("focus");
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(`se-${s.id}`)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.slice(3) as SectionId);
      },
      { rootMargin: "-90px 0px -65% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return (
    <nav className="se-index" aria-label="Settings sections">
      {SECTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={active === id ? "on" : ""}
          aria-current={active === id ? "true" : undefined}
          onClick={() => (setActive(id), document.getElementById(`se-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }))}
        >
          <Icon size={16} /> {label}
        </button>
      ))}
    </nav>
  );
}

export function SettingsView() {
  const { settings: s, docs, threads } = useStore();
  const importRef = useRef<HTMLInputElement>(null);
  const ai = useTest(() => testConnection(s));
  const stt = useTest(() => testSTT(s));
  const sttShared = !s.sttBaseUrl.trim();

  async function importBackup(f?: File) {
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list: Doc[] = Array.isArray(data) ? data : data.docs;
      if (!Array.isArray(list) || !list.every((d) => d && typeof d.title === "string")) throw new Error("not a TurboGoo backup");
      const existing = new Set(docs.map((d) => d.id));
      const fresh = list.map((d) => ({ ...d, id: existing.has(d.id) ? uid() : d.id }));
      const th: Thread[] = Array.isArray(data.threads) ? data.threads.filter((t: Thread) => t && Array.isArray(t.messages)) : [];
      const haveT = new Set(threads.map((t) => t.id));
      setState((st) => ({ ...st, docs: [...fresh, ...st.docs], threads: [...th.map((t) => ({ ...t, id: haveT.has(t.id) ? uid() : t.id })), ...st.threads] }));
      toast(`Imported ${fresh.length} document${fresh.length === 1 ? "" : "s"}${th.length ? ` and ${th.length} chats` : ""}.`, "ok");
    } catch {
      toast("That file isn't a valid TurboGoo backup.", "error");
    }
  }

  return (
    <div className="se">
      <SectionIndex />
      <div className="se-main">
        <header className="se-head">
          <h1>Settings</h1>
          <p className="muted">Set it up once. Everything is saved on this device.</p>
        </header>

        <Section
          id="focus"
          desc="Tunes how notes, flashcards, quizzes, courses and chat are written. With CBSE Class 10 on, every prompt uses NCERT terminology and board-paper style, plus subject-specific rules for Maths, Science, Social Science, English, Hindi and IT. The subject is picked on the home screen, or detected from your material."
        >
          <div className="chips" role="radiogroup" aria-label="Study focus">
            {([["cbse10", "CBSE Class 10"], ["general", "General"]] as const).map(([id, label]) => (
              <button key={id} role="radio" aria-checked={s.curriculum === id} className={"chip" + (s.curriculum === id ? " on" : "")} onClick={() => setSettings({ curriculum: id })}>{label}</button>
            ))}
          </div>
        </Section>

        <Section
          id="ai"
          desc="Works offline with a basic built-in engine. Connect any OpenAI-compatible provider for real notes, quizzes, courses and chat. Your key stays on this device and is sent only to the Base URL below."
        >
          <div className="chips">
            {PRESETS.map((p) => (
              <button key={p.name} className={"chip" + (s.baseUrl === p.baseUrl ? " on" : "")} title={p.note} onClick={() => setSettings({ baseUrl: p.baseUrl, model: p.model, fastModel: p.fast, reasoning: p.reasoning })}>
                {p.name}
              </button>
            ))}
          </div>
          <label>Base URL<input value={s.baseUrl} onChange={(e) => setSettings({ baseUrl: e.target.value })} /></label>
          <label>API key<KeyInput value={s.apiKey} onChange={(v) => setSettings({ apiKey: v })} /></label>
          <div className="two">
            <label>Smart model <small className="muted">notes, chat, courses</small><input value={s.model} onChange={(e) => setSettings({ model: e.target.value })} /></label>
            <label>Fast model <small className="muted">cards, quizzes, grading</small><input value={s.fastModel} onChange={(e) => setSettings({ fastModel: e.target.value })} /></label>
          </div>
          <label>Planner model <small className="muted">study planner: the plan and reading your notes. Empty = use the Smart model</small><input value={s.plannerModel ?? ""} placeholder={s.model} onChange={(e) => setSettings({ plannerModel: e.target.value })} /></label>
          <ModelFinder />
          <div className="field">
            <span className="field-label">Thinking before answering <small className="muted">for reasoning models</small></span>
            <div className="chips" role="radiogroup" aria-label="Reasoning effort">
              {REASONING.map((r) => (
                <button key={r.id} role="radio" aria-checked={s.reasoning === r.id} className={"chip" + (s.reasoning === r.id ? " on" : "")} onClick={() => setSettings({ reasoning: r.id })}>{r.label}</button>
              ))}
            </div>
            <p className="muted small">Reasoning models write hidden “thinking” tokens before the first visible word. Low is the fastest that still writes good notes. Providers that don't support this ignore it.</p>
          </div>
          <div className="row">
            <button className="primary" onClick={ai.run} disabled={ai.busy || !hasLLM(s)}>{ai.busy ? "Testing…" : "Test connection"}</button>
            <span className="small muted">{hasLLM(s) ? "AI mode" : "Offline mode (no key set)"}</span>
          </div>
          <ResultBox r={ai.result} />
        </Section>

        <Section
          id="stt"
          desc="Transcribes uploaded audio/video and recordings that the live transcript missed. Many chat providers (including AI Gateway and NVIDIA NIM here) don't offer Whisper, so you can use a separate one."
        >
          <div className="chips">
            {STT_PRESETS.map((p) => (
              <button key={p.name} className={"chip" + (s.sttBaseUrl === p.baseUrl ? " on" : "")} title={p.note} onClick={() => setSettings({ sttBaseUrl: p.baseUrl, sttModel: p.model })}>
                {p.name}
              </button>
            ))}
          </div>
          {!sttShared && (
            <>
              <label>Base URL<input value={s.sttBaseUrl} onChange={(e) => setSettings({ sttBaseUrl: e.target.value })} /></label>
              <label>API key<KeyInput value={s.sttApiKey} onChange={(v) => setSettings({ sttApiKey: v })} placeholder="Key for this speech provider" /></label>
            </>
          )}
          <label>Model<input value={s.sttModel} onChange={(e) => setSettings({ sttModel: e.target.value })} /></label>
          {sttShared && <p className="muted small">Using the AI provider's Base URL and key above.</p>}
          <div className="row">
            <button className="primary" onClick={stt.run} disabled={stt.busy || !hasSTT(s)}>{stt.busy ? "Testing…" : "Test speech-to-text"}</button>
            <span className="small muted">{hasSTT(s) ? "Ready" : "Not set up"}</span>
          </div>
          <ResultBox r={stt.result} />
        </Section>

        <TextToSpeech />

        <RecentRequests />

        <Section id="appearance" desc="Dark is the default. System follows your device.">
          <div className="se-themes" role="radiogroup" aria-label="Theme">
            {([["dark", "Dark", Moon], ["light", "Light", Sun], ["system", "System", Monitor]] as const).map(([t, label, Icon]) => (
              <button key={t} role="radio" aria-checked={s.theme === t} className={"se-theme" + (s.theme === t ? " on" : "")} onClick={() => setSettings({ theme: t })}>
                <Icon size={20} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section id="data" desc="Everything lives on this device (IndexedDB). Nothing is uploaded except what you send to your AI providers. Back up regularly; clearing browser data deletes it.">
          <div className="row">
            <button onClick={() => download("turbogoo-backup.json", JSON.stringify({ version: 3, docs, threads }, null, 2), "application/json")}><Download size={15} /> Backup (JSON)</button>
            <button onClick={() => importRef.current?.click()}><Upload size={15} /> Restore</button>
            <input ref={importRef} hidden type="file" accept="application/json,.json" aria-label="Restore backup file" onChange={(e) => (importBackup(e.target.files?.[0]), (e.target.value = ""))} />
            <button onClick={() => download("turbogoo-all-flashcards.txt", ankiTsv(docs.flatMap((d) => d.cards)))}><Download size={15} /> All flashcards for Anki</button>
          </div>
          <div className="se-danger">
            <div>
              <b>Delete everything</b>
              <p className="muted small">Removes all {docs.length} documents and {threads.length} chats from this device. This can't be undone.</p>
            </div>
            <button
              className="danger"
              onClick={async () => {
                if (await confirmDialog("Delete everything?", `All ${docs.length} documents, ${threads.length} chats, flashcards and recordings will be permanently removed from this device.`, "Delete everything", true)) setState((st) => ({ ...st, docs: [], threads: [] }));
              }}
            >
              Delete all documents and chats
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}

/** Tests the provider's models with this key and lets you pick one that actually works (some providers enable models per account). */
function ModelFinder() {
  const { settings: s } = useStore();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [found, setFound] = useState<ProbeResult[] | null>(null);
  const ctl = useRef<AbortController | null>(null);
  async function run() {
    setBusy(true);
    setFound(null);
    ctl.current = new AbortController();
    try {
      setFound(await probeModels(s, (d, t) => setProgress([d, t]), ctl.current.signal));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      <div className="row">
        <button onClick={run} disabled={busy || !hasLLM(s)}>{busy ? `Testing models… ${progress[0]}/${progress[1]}` : "Find models that work on my account"}</button>
        {busy && <button onClick={() => ctl.current?.abort()}>Stop</button>}
        {!busy && found && <span className="small muted" role="status">{found.length ? `${found.length} work with this key, fastest first` : "None answered. Check the key and Base URL."}</span>}
      </div>
      {found && found.length > 0 && (
        <ul className="pick-list model-list">
          {found.map((m) => (
            <li key={m.id}>
              <span className="mono">{m.id}</span>
              <small className="muted">{(m.ms / 1000).toFixed(1)} s</small>
              <button className={s.model === m.id ? "on" : ""} aria-pressed={s.model === m.id} onClick={() => setSettings({ model: m.id })}>Smart</button>
              <button className={s.fastModel === m.id ? "on" : ""} aria-pressed={s.fastModel === m.id} onClick={() => setSettings({ fastModel: m.id })}>Fast</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
/** Podcast voices: a separate TTS provider, including a local Chatterbox-Turbo server. */
function TextToSpeech() {
  const { settings: s } = useStore();
  const [voices, setVoices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const shared = !s.ttsBaseUrl.trim();
  const local = !shared && isLocalUrl(s.ttsBaseUrl);
  const tts = useTest(async () => {
    const r = await testTTS(s);
    const url = URL.createObjectURL(r.audio);
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    void a.play().catch(() => {});
    return r.msg;
  });
  async function loadVoices() {
    setLoading(true);
    try {
      const v = await listVoices(s);
      setVoices(v);
      toast(v.length ? `Found ${v.length} voices.` : "This server doesn't list voices. Type the names instead.", v.length ? "ok" : "info");
    } catch (e) {
      toast(`Couldn't list voices: ${(e as Error).message}`, "error");
    } finally {
      setLoading(false);
    }
  }
  return (
    <Section id="tts" tag="podcast voices" desc="Renders the two podcast hosts as real voices and makes the mp3 download. Without this, podcasts use your browser's built-in voices.">
      <div className="chips">
        {TTS_PRESETS.map((p) => (
          <button key={p.name} className={"chip" + (s.ttsBaseUrl === p.baseUrl ? " on" : "")} title={p.note} onClick={() => (setVoices([]), setSettings({ ttsBaseUrl: p.baseUrl, ttsModel: p.model, ttsVoiceA: p.a, ttsVoiceB: p.b }))}>
            {p.name}
          </button>
        ))}
      </div>
      {!shared && (
        <>
          <label>Base URL<input value={s.ttsBaseUrl} onChange={(e) => setSettings({ ttsBaseUrl: e.target.value })} /></label>
          <label>API key {local && <small className="muted">not needed for a local server</small>}<KeyInput value={s.ttsApiKey} onChange={(v) => setSettings({ ttsApiKey: v })} placeholder={local ? "Leave empty" : "Key for this speech provider"} /></label>
        </>
      )}
      {shared && <p className="muted small">Using the AI provider's Base URL and key above.</p>}
      <label>Model<input value={s.ttsModel} onChange={(e) => setSettings({ ttsModel: e.target.value })} /></label>
      <div className="two">
        <label>Goo's voice<input list="tts-voices" value={s.ttsVoiceA} onChange={(e) => setSettings({ ttsVoiceA: e.target.value })} /></label>
        <label>Turbo's voice<input list="tts-voices" value={s.ttsVoiceB} onChange={(e) => setSettings({ ttsVoiceB: e.target.value })} /></label>
      </div>
      <datalist id="tts-voices">{voices.map((v) => <option key={v} value={v} />)}</datalist>
      {/chatterbox/i.test(s.ttsModel) && (
        <div className="callout">
          <div className="small">
            <b>Running Chatterbox-Turbo locally</b>
            <ol className="steps">
              <li>Install <a href="https://github.com/devnen/Chatterbox-TTS-Server" target="_blank" rel="noreferrer">Chatterbox-TTS-Server</a> and run <code>start.bat</code> (Windows) or <code>./start.sh</code>. The first run downloads the model, a few GB.</li>
              <li>Open its web UI at <code>http://localhost:8004</code> and pick <b>Chatterbox‑Turbo</b> in the engine dropdown.</li>
              <li>Click <b>Load voices</b> below, choose one per host, then <b>Test voice</b>.</li>
            </ol>
            Scripts written while Chatterbox is selected include sound tags like [laugh] and [chuckle], which Turbo performs. A GPU is strongly recommended; on CPU each line can take several seconds.
          </div>
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={tts.run} disabled={tts.busy || !hasTTS(s)}>{tts.busy ? "Rendering…" : "Test voice"}</button>
        {!shared && <button onClick={loadVoices} disabled={loading}>{loading ? "Loading…" : "Load voices"}</button>}
        <span className="small muted">{hasTTS(s) ? "Ready" : "Not set up"}</span>
      </div>
      <ResultBox r={tts.result} />
    </Section>
  );
}

/** Timing for the last AI requests this session: shows whether time goes to waiting, thinking or writing. */
function RecentRequests() {
  const stats = useSyncExternalStore(subscribeStats, getStats);
  const lastMin = stats.filter((r) => Date.now() - r.at < 60_000).length;
  return (
    <Section id="requests" tag={`${lastMin} in the last minute`}>
      {stats.length === 0 ? (
        <p className="muted small">Nothing yet this session. Generate something and the timings show up here (and in the developer console).</p>
      ) : (
        <div className="table-wrap">
          <table className="stats-table">
            <thead>
              <tr><th>When</th><th>Model</th><th>First word</th><th>Total</th><th>Thinking</th><th>Answer</th><th>Speed</th></tr>
            </thead>
            <tbody>
              {stats.slice(0, 12).map((r, i) => {
                const writeS = (r.totalMs - (r.firstTokenMs ?? 0)) / 1000;
                const answerTok = r.outTokens !== undefined ? r.outTokens - (r.reasoningTokens ?? 0) : undefined;
                const tps = answerTok && r.firstTokenMs !== undefined && writeS > 0 ? Math.round(answerTok / writeS) : undefined;
                return (
                  <tr key={i}>
                    <td>{new Date(r.at).toLocaleTimeString()}</td>
                    <td className="mono">{r.model.split("/").pop()}</td>
                    <td>{r.firstTokenMs !== undefined ? `${(r.firstTokenMs / 1000).toFixed(1)} s` : "–"}</td>
                    <td>{(r.totalMs / 1000).toFixed(1)} s</td>
                    <td>{r.reasoningTokens !== undefined ? `${r.reasoningTokens} tok` : r.reasoningChars ? `${r.reasoningChars} ch` : "–"}</td>
                    <td>{answerTok !== undefined ? `${answerTok} tok` : `${r.outChars} ch`}</td>
                    <td>{tps ? `${tps} tok/s` : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">“First word” is the wait before visible text: queueing on the provider plus hidden thinking. “Speed” is answer tokens per second after that.</p>
    </Section>
  );
}

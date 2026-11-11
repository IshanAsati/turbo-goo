import { useRef, useState } from "react";
import { CheckCircle2, Download, Eye, EyeOff, Plug, Upload } from "lucide-react";
import { PRESETS, hasLLM, testConnection } from "../lib/llm";
import { setSettings, setState, uid, useStore } from "../lib/store";
import { confirmDialog, toast } from "../components/feedback";
import { ankiTsv, download } from "./Flashcards";
import type { Doc } from "../lib/types";

export function SettingsView() {
  const { settings: s, docs } = useStore();
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult({ ok: true, msg: await testConnection(s) });
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function importBackup(f?: File) {
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list: Doc[] = Array.isArray(data) ? data : data.docs;
      if (!Array.isArray(list) || !list.every((d) => d && typeof d.title === "string")) throw new Error("not a TurboGoo backup");
      const existing = new Set(docs.map((d) => d.id));
      const fresh = list.map((d) => ({ ...d, id: existing.has(d.id) ? uid() : d.id }));
      setState((st) => ({ ...st, docs: [...fresh, ...st.docs] }));
      toast(`Imported ${fresh.length} document${fresh.length === 1 ? "" : "s"}.`, "ok");
    } catch {
      toast("That file isn't a valid TurboGoo backup.", "error");
    }
  }

  return (
    <div className="page narrow">
      <h1>Settings</h1>

      <section className="panel">
        <h2><Plug size={18} /> AI provider</h2>
        <p className="muted small">
          TurboGoo works offline with a basic built-in engine. Connect any OpenAI-compatible provider for far better notes, quizzes, courses, tutoring, audio transcription and HD podcast voices.
          Your key stays in this browser and is sent only to the Base URL below. There is no TurboGoo server in between.
        </p>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p.name} className={"chip" + (s.baseUrl === p.baseUrl ? " on" : "")} title={p.note} onClick={() => setSettings({ baseUrl: p.baseUrl, model: p.model, fastModel: p.fast })}>
              {p.name}
            </button>
          ))}
        </div>
        <label>Base URL<input value={s.baseUrl} onChange={(e) => setSettings({ baseUrl: e.target.value })} /></label>
        <label>
          API key
          <div className="input-row">
            <input type={show ? "text" : "password"} autoComplete="off" value={s.apiKey} placeholder="sk-…" onChange={(e) => setSettings({ apiKey: e.target.value.trim() })} />
            <button className="icon-btn" aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
        </label>
        <div className="two">
          <label>Smart model <small className="muted">notes, tutoring, courses, podcasts</small><input value={s.model} onChange={(e) => setSettings({ model: e.target.value })} /></label>
          <label>Fast model <small className="muted">flashcards, quizzes, grading</small><input value={s.fastModel} onChange={(e) => setSettings({ fastModel: e.target.value })} /></label>
          <label>Speech-to-text model<input value={s.sttModel} onChange={(e) => setSettings({ sttModel: e.target.value })} /></label>
          <label>Text-to-speech model<input value={s.ttsModel} onChange={(e) => setSettings({ ttsModel: e.target.value })} /></label>
        </div>
        <div className="row">
          <button className="primary" onClick={test} disabled={testing || !hasLLM(s)}>{testing ? "Testing…" : "Test connection"}</button>
          <span className="small">{hasLLM(s) ? "AI mode" : "Offline mode (no key set)"}</span>
        </div>
        {result && (
          <div className={"callout " + (result.ok ? "ok" : "warn")}>
            {result.ok && <CheckCircle2 size={18} />}
            <div>{result.msg}</div>
          </div>
        )}
        <p className="muted small">Routing cheap tasks to the fast model and reasoning-heavy ones to the smart model keeps cost low, the same trick large study apps use.</p>
      </section>

      <section className="panel">
        <h2>Appearance</h2>
        <div className="seg">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} className={s.theme === t ? "on" : ""} onClick={() => setSettings({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Your data</h2>
        <p className="muted small">Everything lives on this device (IndexedDB). Nothing is uploaded except what you send to your AI provider. Back up regularly; clearing browser data deletes it.</p>
        <div className="row">
          <button onClick={() => download("turbogoo-backup.json", JSON.stringify({ version: 2, docs }, null, 2), "application/json")}><Download size={15} /> Backup (JSON)</button>
          <button onClick={() => importRef.current?.click()}><Upload size={15} /> Restore</button>
          <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(e) => (importBackup(e.target.files?.[0]), (e.target.value = ""))} />
          <button onClick={() => download("turbogoo-all-flashcards.txt", ankiTsv(docs.flatMap((d) => d.cards)))}><Download size={15} /> All flashcards for Anki</button>
        </div>
        <div className="row">
          <button
            className="danger"
            onClick={async () => {
              if (await confirmDialog("Delete everything?", `All ${docs.length} documents, flashcards, and recordings will be permanently removed from this device.`, "Delete everything", true)) setState((st) => ({ ...st, docs: [] }));
            }}
          >
            Delete all documents
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Pricing</h2>
        <p className="muted">Free, with no paywall, quotas or hidden tiers. If you connect an AI provider you pay them directly for what you use.</p>
      </section>
    </div>
  );
}

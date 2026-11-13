import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play, RefreshCw, Sparkles, X } from "lucide-react";
import { cancelJob } from "../lib/generate";
import { SOUND_TAGS, hasTTS, speech, ttsLabel } from "../lib/llm";
import { useStore } from "../lib/store";
import type { Doc, Job } from "../lib/types";
import { toast } from "../components/feedback";
import { Mascot } from "../components/Mascot";
import "../styles/study.css";


export function Podcast({ doc, job, onGenerate }: { doc: Doc; job?: Job; onGenerate: () => void }) {
  const { settings } = useStore();
  const lines = doc.podcast;
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [vGoo, setVGoo] = useState("");
  const [vTurbo, setVTurbo] = useState("");
  const [hd, setHd] = useState<Blob[] | null>(null);
  const [hdProgress, setHdProgress] = useState<number | null>(null);
  const run = useRef(0); // playback token: bumping it cancels the current chain
  const audio = useRef<HTMLAudioElement | null>(null);
  const hdCtl = useRef<AbortController | null>(null);
  const audioUrl = useRef("");
  const utter = useRef<SpeechSynthesisUtterance | null>(null); // Chrome can garbage-collect a playing utterance and never fire onend
  const supported = "speechSynthesis" in window;
  const canHD = hasTTS(settings);

  useEffect(() => {
    if (!supported) return;
    const load = () => {
      const v = speechSynthesis.getVoices().filter((x) => x.lang.toLowerCase().startsWith("en"));
      setVoices(v);
      setVGoo((cur) => cur || v.find((x) => /female|aria|jenny|samantha|zira|google uk english female/i.test(x.name))?.name || v[0]?.name || "");
      setVTurbo((cur) => cur || v.find((x) => /male|guy|davis|daniel|david|google us english/i.test(x.name) && !/female/i.test(x.name))?.name || v[1]?.name || v[0]?.name || "");
    };
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, [supported]);

  useEffect(
    () => () => {
      run.current++;
      hdCtl.current?.abort();
      speechSynthesis?.cancel();
      freeAudio();
    },
    [],
  );
  useEffect(() => {
    document.querySelector(".pc-line.now")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [idx]);
  // A new script invalidates playback position and any HD render of the old one.
  useEffect(() => {
    hdCtl.current?.abort();
    stop();
    setIdx(-1);
    setHd(null);
  }, [doc.podcast]); // eslint-disable-line react-hooks/exhaustive-deps

  function freeAudio() {
    const a = audio.current;
    if (a) {
      a.onended = a.onerror = null;
      a.pause();
    }
    audio.current = null;
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = "";
  }

  function stop() {
    run.current++;
    speechSynthesis?.cancel();
    freeAudio();
    setPlaying(false);
  }

  function play(from: number) {
    stop();
    const token = run.current;
    setPlaying(true);
    const step = (i: number) => {
      if (token !== run.current) return;
      if (i >= lines.length) {
        setPlaying(false);
        setIdx(-1);
        return;
      }
      setIdx(i);
      if (hd) {
        freeAudio();
        const url = URL.createObjectURL(hd[i]);
        audioUrl.current = url;
        const a = new Audio(url);
        a.playbackRate = rate;
        audio.current = a;
        a.onended = () => step(i + 1);
        a.onerror = () => step(i + 1);
        void a.play().catch(() => token === run.current && stop());
        return;
      }
      const u = new SpeechSynthesisUtterance(lines[i].text.replace(SOUND_TAGS, " "));
      const name = lines[i].host === "Goo" ? vGoo : vTurbo;
      u.voice = voices.find((v) => v.name === name) ?? null;
      u.rate = rate;
      u.pitch = voices.length < 2 ? (lines[i].host === "Goo" ? 1.15 : 0.85) : 1; // distinct personas even with one installed voice
      utter.current = u;
      u.onend = () => step(i + 1);
      u.onerror = (e) => e.error !== "interrupted" && e.error !== "canceled" && step(i + 1);
      speechSynthesis.speak(u);
    };
    step(from);
  }

  async function makeHD() {
    setHdProgress(0);
    const ctl = new AbortController();
    hdCtl.current = ctl;
    try {
      const out: Blob[] = [];
      for (let i = 0; i < lines.length; i++) {
        out.push(await speech(settings, lines[i].text, lines[i].host === "Goo" ? settings.ttsVoiceA : settings.ttsVoiceB, ctl.signal));
        setHdProgress((i + 1) / lines.length);
      }
      if (ctl.signal.aborted) return; // script was replaced or the view closed mid-render
      setHd(out);
      toast(`${ttsLabel(settings)} audio ready.`, "ok");
    } catch (e) {
      if (!ctl.signal.aborted) toast((e as Error).message, "error");
    } finally {
      if (hdCtl.current === ctl) hdCtl.current = null;
      setHdProgress(null);
    }
  }

  if (job && !job.error)
    return (
      <div className="st-wrap">
        <div className="pc-empty" role="status" aria-live="polite">
          <Mascot size={120} mood="thinking" />
          <h2>Recording your podcast</h2>
          <p className="muted">{job.step}</p>
          <div className="gen-indeterminate" aria-hidden><div /></div>
          <button className="gen-cancel" onClick={() => cancelJob(`${doc.id}:podcast`)}><X size={15} /> Cancel</button>
        </div>
      </div>
    );

  if (!lines.length)
    return (
      <div className="st-wrap">
        <div className="pc-empty">
          <Mascot size={120} mood="reading" />
          <h2>Listen to your notes</h2>
          <p className="muted">Turn your notes into a two-host conversation you can listen to anywhere.</p>
          <button className="primary gen-go" onClick={onGenerate} disabled={!doc.notes && !doc.source}><Sparkles size={16} /> Generate podcast</button>
          {job?.error && <p className="error-text" role="alert">{job.error}</p>}
        </div>
      </div>
    );

  return (
    <div className="st-wrap pc">
      <div className="pc-player">
        <button className="pc-play" onClick={() => (playing ? stop() : play(Math.max(0, idx)))} aria-label={playing ? "Pause" : "Play"} disabled={!supported && !hd}>
          {playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
        </button>
        <div className="pc-main">
          <b className="pc-title">{doc.title}</b>
          <span className="muted small">{lines.length} lines · Goo &amp; Turbo · {hd ? `${ttsLabel(settings)} voices` : "browser voices"}</span>
          <div className="progress-line" role="progressbar" aria-label="Podcast progress" aria-valuemin={0} aria-valuemax={lines.length} aria-valuenow={idx + 1}><div style={{ width: `${((idx + 1) / lines.length) * 100}%` }} /></div>
        </div>
        <label className="pc-speed">Speed
          <select value={rate} onChange={(e) => setRate(+e.target.value)}>
            {[0.8, 1, 1.15, 1.3, 1.5, 1.75].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
      </div>
      {job?.error && <p className="error-text" role="alert">{job.error}</p>}

      <div className="pc-tools">
        {!hd && voices.length > 0 && (
          <>
            <label className="pc-host goo"><span className="pc-chip">Goo</span><select aria-label="Goo's voice" value={vGoo} onChange={(e) => setVGoo(e.target.value)}>{voices.map((v) => <option key={v.name}>{v.name}</option>)}</select></label>
            <label className="pc-host turbo"><span className="pc-chip">Turbo</span><select aria-label="Turbo's voice" value={vTurbo} onChange={(e) => setVTurbo(e.target.value)}>{voices.map((v) => <option key={v.name}>{v.name}</option>)}</select></label>
          </>
        )}
        <span className="spacer" />
        {canHD && !hd && (
          <button onClick={makeHD} disabled={hdProgress !== null} title={`Renders every line with ${settings.ttsModel} (Settings → Text-to-speech)`}>
            {hdProgress !== null ? `Rendering ${Math.round(hdProgress * 100)}%` : `Render with ${ttsLabel(settings)}`}
          </button>
        )}
        {hd && (
          <button
            onClick={() => {
              const url = URL.createObjectURL(new Blob(hd, { type: "audio/mpeg" }));
              Object.assign(document.createElement("a"), { href: url, download: `${doc.title}-podcast.mp3` }).click();
              setTimeout(() => URL.revokeObjectURL(url), 30_000); // revoking synchronously can cancel the download
            }}
          >
            <Download size={15} /> Download mp3
          </button>
        )}
        {hdProgress !== null && <button onClick={() => hdCtl.current?.abort()}><X size={14} /> Cancel render</button>}
        <button onClick={onGenerate}><RefreshCw size={15} /> New script</button>
      </div>

      <div className="pc-script" aria-label="Script">
        {lines.map((l, i) => (
          <button key={i} className={"pc-line " + l.host + (i === idx ? " now" : "")} aria-current={i === idx ? "true" : undefined} onClick={() => play(i)}>
            <span className="pc-chip">{l.host}</span>
            <span className="pc-text">{l.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
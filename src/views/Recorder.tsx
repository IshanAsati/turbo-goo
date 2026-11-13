import { useCallback, useEffect, useRef, useState } from "react";
import { del, get, getMany, set } from "idb-keyval";
import { Flag, Mic, Pause, Play, Square, TriangleAlert } from "lucide-react";
import { hasSTT, transcribe } from "../lib/llm";
import { getState, uid } from "../lib/store";
import { toast } from "../components/feedback";

/* Web Speech API (prefixed in Chromium/Safari) */
type SR = { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; start(): void; stop(): void; abort(): void };

type Meta = { session: string; chunks: number; transcript: string; secs: number; startedAt: number };
const META = "rec:meta";
const chunkKey = (s: string, n: number) => `rec:${s}:${n}`;

const fmt = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

async function clearSession(m: Meta) {
  await Promise.all(Array.from({ length: m.chunks }, (_, i) => del(chunkKey(m.session, i))));
  await del(META);
}

async function assemble(m: Meta): Promise<Blob | undefined> {
  const parts = (await getMany<Blob>(Array.from({ length: m.chunks }, (_, i) => chunkKey(m.session, i)))).filter((b): b is Blob => !!b);
  return parts.length ? new Blob(parts, { type: parts[0].type || "audio/webm" }) : undefined;
}

export function Recorder({ onDone, busy }: { onDone: (title: string, transcript: string, audio?: Blob) => void; busy: boolean }) {
  const Ctor: (new () => SR) | undefined = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const [phase, setPhase] = useState<"idle" | "rec" | "paused">("idle");
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState("");
  const [recovered, setRecovered] = useState<Meta | null>(null);
  const [working, setWorking] = useState("");

  const sr = useRef<SR | null>(null);
  const want = useRef(false);
  const mr = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const raf = useRef(0);
  const wake = useRef<any>(null);
  const meta = useRef<Meta>({ session: uid(), chunks: 0, transcript: "", secs: 0, startedAt: Date.now() });
  const textRef = useRef("");
  const secsRef = useRef(0);
  const blobs = useRef<Blob[]>([]);
  const pending = useRef<Promise<unknown>>(Promise.resolve()); // serialised IndexedDB writes
  const alive = useRef(true);
  const finishing = useRef(false);
  const warned = useRef(false);
  textRef.current = text;
  secsRef.current = secs;

  // Crash recovery: look for an unfinished session left behind by a closed tab / killed browser.
  useEffect(() => {
    get<Meta>(META).then((m) => m && m.chunks > 0 && setRecovered(m));
  }, []);

  useEffect(() => {
    if (phase !== "rec") return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const persistMeta = useCallback(() => {
    meta.current = { ...meta.current, transcript: textRef.current, secs: secsRef.current };
    return set(META, meta.current); // returned so the chained write queue waits for it
  }, []);

  const teardown = useCallback(() => {
    want.current = false;
    try {
      sr.current?.abort();
    } catch {
      /* already stopped */
    }
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    void audioCtx.current?.close().catch(() => {});
    wake.current?.release?.().catch?.(() => {});
    setLevel(0);
    setInterim("");
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      teardown();
    };
  }, [teardown]);

  async function start() {
    setErr("");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setErr("Microphone access was blocked. Allow it in your browser's address bar, or type/paste a transcript below.");
      return;
    }
    if (!alive.current) return media.getTracks().forEach((t) => t.stop()); // left the page while the permission prompt was open
    stream.current = media;
    meta.current = { session: uid(), chunks: 0, transcript: text, secs: 0, startedAt: Date.now() };
    blobs.current = [];
    setHasRecovered(undefined); // a previously recovered clip must not be submitted in place of this recording

    let rec: MediaRecorder;
    try {
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(media, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24000 }); // ~11 MB/hour: fits Whisper's 25 MB limit for ~2 h
    } catch {
      media.getTracks().forEach((t) => t.stop()); // otherwise the mic stays live with nothing recording
      stream.current = null;
      setErr("This browser can't record audio. Type or paste a transcript below instead.");
      return;
    }
    const session = meta.current.session;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      blobs.current.push(e.data);
      const n = meta.current.chunks++;
      // flushed to disk as it records; writes are chained so the final chunk is always settled before the session is cleared
      pending.current = pending.current
        .then(() => set(chunkKey(session, n), e.data))
        .then(persistMeta)
        .catch(() => {
          if (warned.current) return;
          warned.current = true;
          toast("Couldn't save the recording to your device (storage full or blocked). Crash recovery is off for this session.", "error");
        });
    };
    rec.start(5000);
    mr.current = rec;

    try {
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(media).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter is optional */
    }

    try {
      wake.current = await (navigator as any).wakeLock?.request("screen"); // keep the screen/tab awake during class
    } catch {
      /* not allowed */
    }
    if (!alive.current) return teardown(); // unmounted while awaiting the wake lock

    startSpeech();
    setSecs(0);
    setPhase("rec");
  }

  function startSpeech() {
    if (!Ctor) {
      setErr("Live transcription isn't supported in this browser (use Chrome, Edge or Safari). Audio is still recorded; with an API key it's transcribed when you finish.");
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e: any) => {
      let fin = "";
      let tmp = "";
      for (let i = e.resultIndex; i < e.results.length; i++) (e.results[i].isFinal ? (fin += e.results[i][0].transcript + " ") : (tmp += e.results[i][0].transcript));
      if (fin) setText((t) => t + fin);
      setInterim(tmp);
    };
    r.onend = () => {
      if (want.current && sr.current === r) // a stale recogniser (pause then quick resume) must not restart and double the transcript
        try {
          r.start(); // browsers end recognition on silence; keep it going
        } catch {
          /* already started */
        }
    };
    r.onerror = (e: any) => {
      const code = e?.error;
      if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture" || code === "network") {
        want.current = false; // onend would otherwise restart it in a tight loop
        setErr(code === "network" ? "Live transcription lost its connection to the browser's speech service. Audio is still recording." : "Speech recognition was blocked by the browser. Audio is still recording.");
      }
    };
    try {
      sr.current?.abort();
    } catch {
      /* already stopped */
    }
    sr.current = r;
    want.current = true;
    try {
      r.start();
    } catch {
      /* already started */
    }
  }

  function pause() {
    mr.current?.pause();
    want.current = false;
    sr.current?.stop();
    setPhase("paused");
  }
  function resume() {
    mr.current?.resume();
    startSpeech();
    setPhase("rec");
  }
  function flag() {
    setText((t) => `${t.trimEnd()}\n[?] `);
    toast("Flagged. Ask about it in Chat after class.", "ok");
  }

  async function finish() {
    if (finishing.current) return; // double click on Stop would call onDone twice
    finishing.current = true;
    try {
      await finishInner();
    } finally {
      finishing.current = false;
    }
  }
  async function finishInner() {
    setWorking("Saving recording…");
    const rec = mr.current;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((res) => {
        rec.addEventListener("stop", () => setTimeout(res, 50), { once: true });
        rec.stop();
      });
    }
    teardown();
    setPhase("idle");
    const audio = blobs.current.length ? new Blob(blobs.current, { type: blobs.current[0].type || "audio/webm" }) : undefined;
    await complete(audio);
  }

  async function complete(audio?: Blob) {
    let transcript = textRef.current.trim();
    try {
      if (transcript.length < 40 && audio && hasSTT(getState().settings)) {
        setWorking("Transcribing audio…");
        transcript = (await transcribe(getState().settings, audio, "lecture.webm")).trim();
      }
    } catch (e) {
      toast((e as Error).message, "error");
    }
    setWorking("");
    if (transcript.length < 40) {
      setErr("There isn't enough transcript to build notes from yet. Add text below, or record again (with an API key, audio is transcribed automatically).");
      return;
    }
    onDone(`Lecture ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, transcript, audio);
    await pending.current; // let the last chunk and metadata writes land first, or they resurrect the session after it is cleared
    await clearSession(meta.current).catch(() => {});
    setHasRecovered(undefined);
  }

  async function recover() {
    if (!recovered) return;
    meta.current = recovered;
    setText(recovered.transcript);
    textRef.current = recovered.transcript;
    const audio = await assemble(recovered);
    blobs.current = audio ? [audio] : [];
    setRecovered(null);
    toast("Recording recovered. Review the transcript, then generate.", "ok");
    if (audio) setHasRecovered(audio);
  }
  const [recoveredAudio, setHasRecovered] = useState<Blob | undefined>();

  async function discard() {
    if (recovered) await clearSession(recovered);
    setRecovered(null);
  }

  const busyNow = busy || !!working;
  return (
    <>
      <h2>Record a lecture</h2>
      {recovered && (
        <div className="callout warn">
          <TriangleAlert size={18} />
          <div>
            <b>Unfinished recording found</b> ({fmt(recovered.secs)}, saved {new Date(recovered.startedAt).toLocaleString()}). It was saved to your device as you recorded.
            <div className="row">
              <button className="primary" onClick={recover}>Recover it</button>
              <button onClick={discard}>Discard</button>
            </div>
          </div>
        </div>
      )}
      <div className="rec-top">
        {phase === "idle" && (
          <button className="rec-btn" onClick={start} disabled={busyNow || !!recovered} title={recovered ? "Recover or discard the unfinished recording first" : undefined}>
            <Mic size={22} /> Start recording
          </button>
        )}
        {phase === "rec" && (
          <>
            <button className="rec-btn live" onClick={finish}><Square size={20} fill="currentColor" /> Stop</button>
            <button onClick={pause}><Pause size={16} /> Pause</button>
            <button onClick={flag} title="Mark a moment you didn't understand"><Flag size={16} /> Flag “?”</button>
          </>
        )}
        {phase === "paused" && (
          <>
            <button className="rec-btn" onClick={resume}><Play size={20} /> Resume</button>
            <button onClick={finish}><Square size={16} /> Stop</button>
          </>
        )}
        <span className="timer">{fmt(secs)}</span>
        {phase === "rec" && (
          <span className="meter" aria-label="Microphone level">
            <i style={{ transform: `scaleX(${Math.max(0.04, level)})` }} />
          </span>
        )}
      </div>
      {err && <div className="callout warn"><TriangleAlert size={18} /><div>{err}</div></div>}
      <textarea rows={10} aria-label="Transcript" placeholder="Live transcript appears here. You can edit it any time." value={text + (interim ? (text && !text.endsWith(" ") ? " " : "") + interim : "")} onChange={(e) => (setText(e.target.value), setInterim(""))} />
      <p className="muted small">
        Saved to your device every few seconds, so a crash or closed tab won't lose the lecture. In class, just flag confusing moments with “?” and ask about them afterwards.
        {Ctor && " Live transcription in Chrome/Edge is processed by the browser vendor's speech service."}
      </p>
      <button
        className="primary"
        disabled={busyNow || phase !== "idle" || (text.trim().length < 40 && !recoveredAudio)}
        onClick={() => complete(recoveredAudio ?? (blobs.current[0] && new Blob(blobs.current, { type: blobs.current[0].type })))}
      >
        {working || (busy ? "Starting…" : "Generate study materials")}
      </button>
    </>
  );
}

import { useRef, useState } from "react";
import { ArrowRight, Check, Compass, Lock, PartyPopper, RotateCcw, Upload } from "lucide-react";
import { go } from "../lib/nav";
import { createCourseDoc } from "../lib/generate";
import { ACCEPT, fetchYouTube, ingestFile, isYouTube } from "../lib/ingest";
import { hasLLM } from "../lib/llm";
import { recordActivity, updateDoc, useStore } from "../lib/store";
import type { Doc, Job } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { toast } from "../components/feedback";

const IDEAS = ["Antitrust law", "How transformers work", "The French Revolution", "Organic chemistry basics", "Personal finance 101"];

export function LearnHome() {
  const { settings, docs } = useStore();
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const courses = docs.filter((d) => d.course.length > 0);

  async function start() {
    const t = topic.trim();
    if (!t) return;
    setBusy("Starting…");
    try {
      if (isYouTube(t)) {
        setBusy("Fetching transcript…");
        const r = await fetchYouTube(t);
        if (!r.ok) throw new Error(r.error + " Try Library → YouTube to paste the transcript manually.");
        return go(`/doc/${createCourseDoc({ title: r.data.title, source: r.data.text, kind: "youtube" })}?tab=course`);
      }
      if (!hasLLM(settings)) {
        toast("Courses from a bare topic need an AI provider, since there's no source to draw on. Add an API key in Settings, or build a course from a file.", "error");
        return;
      }
      go(`/doc/${createCourseDoc({ title: t, source: "", kind: "topic" })}?tab=course`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  async function fromFile(f?: File) {
    if (!f) return;
    try {
      const r = await ingestFile(f, settings, setBusy);
      if (r.source.trim().length < 40) throw new Error("Not enough text in that file to build a course.");
      go(`/doc/${createCourseDoc(r)}?tab=course`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page narrow">
      <h1><Compass size={26} /> Learn Mode</h1>
      <p className="muted">Type any topic, paste a YouTube link, or add a file. TurboGoo builds a 12-section guided course with a check-in after each lesson, plus notes, flashcards, a quiz and a podcast.</p>
      <div className="learn-box">
        <input
          aria-label="Topic or YouTube link"
          placeholder="What do you want to learn? e.g. antitrust law"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
          disabled={!!busy}
        />
        <button className="primary" disabled={!!busy || !topic.trim()} onClick={start}>{busy ? <><span className="spinner" /> {busy}</> : <>Create course <ArrowRight size={16} /></>}</button>
      </div>
      <div className="suggest">
        {IDEAS.map((i) => <button key={i} className="chip" onClick={() => setTopic(i)}>{i}</button>)}
        <button className="chip" onClick={() => file.current?.click()}><Upload size={13} /> From a file</button>
      </div>
      <input ref={file} hidden type="file" accept={ACCEPT} onChange={(e) => (fromFile(e.target.files?.[0]), (e.target.value = ""))} />
      {!hasLLM(settings) && <p className="callout warn small">Without an API key, courses from files use a simple built-in engine and topic-only courses are unavailable. Add a key in Settings for the full experience.</p>}

      <h2>Your courses</h2>
      {courses.length === 0 && <p className="muted">None yet.</p>}
      <div className="grid">
        {courses.map((d) => {
          const done = d.course.filter((s) => s.done).length;
          return (
            <button key={d.id} className="card doc" onClick={() => go(`/doc/${d.id}`)}>
              <div className="doc-title">{d.title}</div>
              <div className="bar"><div style={{ width: `${(done / d.course.length) * 100}%` }} /></div>
              <span className="muted small">{done} of {d.course.length} sections</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Course({ doc, job, onGenerate }: { doc: Doc; job?: Job; onGenerate: () => void }) {
  const firstOpen = Math.max(0, doc.course.findIndex((s) => !s.done));
  const [open, setOpen] = useState(firstOpen);
  const [pick, setPick] = useState<number | null>(null);

  if (job && !job.error) return <div className="empty-note"><span className="spinner" /> {job.step}</div>;
  if (!doc.course.length)
    return (
      <div className="empty-note">
        <Compass size={32} />
        <p>Turn this document into a 12-section guided course with a check-in after every lesson.</p>
        <button className="primary" onClick={onGenerate}>Generate course</button>
        {job?.error && <p className="error-text">{job.error}</p>}
      </div>
    );

  const done = doc.course.filter((s) => s.done).length;
  const all = done === doc.course.length;
  const s = doc.course[Math.min(open, doc.course.length - 1)];
  const unlocked = (i: number) => i === 0 || doc.course[i - 1].done;
  const answered = pick !== null;
  const correct = pick === s.check.answer;

  const complete = () => {
    recordActivity(2);
    updateDoc(doc.id, (d) => ({ course: d.course.map((x) => (x.id === s.id ? { ...x, done: true } : x)) }));
  };
  const goTo = (i: number) => (setOpen(i), setPick(null));

  return (
    <div className="course">
      <div className="course-top">
        <div className="progress-line big"><div style={{ width: `${(done / doc.course.length) * 100}%` }} /></div>
        <span className="muted small">{done} / {doc.course.length} complete</span>
      </div>
      <div className="path" role="list">
        {doc.course.map((x, i) => (
          <button key={x.id} role="listitem" className={"node" + (x.done ? " done" : "") + (i === open ? " cur" : "")} disabled={!unlocked(i)} title={x.title} aria-label={`Section ${i + 1}: ${x.title}${x.done ? " (complete)" : !unlocked(i) ? " (locked)" : ""}`} onClick={() => goTo(i)}>
            {x.done ? <Check size={16} /> : unlocked(i) ? i + 1 : <Lock size={14} />}
          </button>
        ))}
      </div>

      {all && open >= doc.course.length - 1 && s.done ? (
        <div className="celebrate">
          <PartyPopper size={40} />
          <h2>Course complete</h2>
          <p className="muted">Lock it in with the flashcards, quiz and podcast in the tabs above.</p>
          <button onClick={() => (updateDoc(doc.id, (d) => ({ course: d.course.map((x) => ({ ...x, done: false })) })), goTo(0))}><RotateCcw size={15} /> Restart course</button>
        </div>
      ) : (
        <article>
          <small className="muted">Section {open + 1} of {doc.course.length}</small>
          <h2>{s.title}</h2>
          <Markdown text={s.lesson} />
          <div className="checkin">
            <b className="small">Check-in</b>
            <Markdown text={s.check.q} className="qtext" />
            <div className="options">
              {s.check.options.map((o, k) => (
                <button key={k} disabled={answered && (correct || s.done)} className={"option" + (answered && k === s.check.answer ? " right" : "") + (answered && pick === k && k !== s.check.answer ? " wrong" : "")} onClick={() => !s.done && setPick(k)}>
                  <kbd>{k + 1}</kbd> <Markdown text={o} />
                </button>
              ))}
            </div>
            {answered && (
              <div className={"result " + (correct ? "ok" : "bad")}>
                <b>{correct ? "Correct" : "Not quite. Try again."}</b>
                {correct && <Markdown text={s.check.explain} />}
                {correct ? (
                  <button className="primary" onClick={() => { complete(); if (open + 1 < doc.course.length) goTo(open + 1); }}>
                    {open + 1 < doc.course.length ? "Next section" : "Finish course"} <ArrowRight size={15} />
                  </button>
                ) : (
                  <button onClick={() => setPick(null)}>Try again</button>
                )}
              </div>
            )}
            {s.done && !answered && (
              <div className="row">
                <span className="muted small">Completed.</span>
                {open + 1 < doc.course.length && <button onClick={() => goTo(open + 1)}>Next section <ArrowRight size={15} /></button>}
              </div>
            )}
          </div>
        </article>
      )}
    </div>
  );
}

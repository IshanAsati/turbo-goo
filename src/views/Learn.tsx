import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Compass, Eye, EyeOff, Lightbulb, PartyPopper, RotateCcw, TriangleAlert, Upload, X } from "lucide-react";
import { go } from "../lib/nav";
import { cancelJob, createCourseDoc, generateCourse, rebuildCourse, retryLesson } from "../lib/generate";
import { ACCEPT, fetchYouTube, ingestFile, isYouTube } from "../lib/ingest";
import { hasLLM } from "../lib/llm";
import { recordActivity, updateDoc, useStore } from "../lib/store";
import type { CheckIn, Doc, Job, LessonStatus, Section } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { confirmDialog, toast } from "../components/feedback";

const IDEAS = ["Quadratic equations", "Light: reflection and refraction", "Nationalism in India", "Antitrust law", "How transformers work"];

/** Total estimated time, as "45 min" or "2 h 10 min". */
const fmtMin = (n: number) => (n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ""}` : `${n} min`);
/** Old saved lessons have no status: they were written in one piece, so they count as ready. */
const statusOf = (s: Section, running: boolean): LessonStatus => (s.status === "writing" && !running ? "pending" : s.status ?? "ready");

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
      <p className="muted">Type any topic, paste a YouTube link, or add a file. TurboGoo plans a course, then writes each lesson in full: an explanation, a worked example, practice problems with hints and solutions, and a recap. Notes, flashcards, a quiz and a podcast come along too.</p>
      <div className="learn-box">
        <input
          aria-label="Topic or YouTube link"
          placeholder="What do you want to learn? e.g. quadratic equations"
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
      {!hasLLM(settings) && <p className="callout warn small">Without an API key, courses from files use a simple built-in engine (lessons are your own text, grouped by topic) and topic-only courses are unavailable. Add a key in Settings for the full experience.</p>}

      <h2>Your courses</h2>
      {courses.length === 0 && <p className="muted">None yet.</p>}
      <div className="grid">
        {courses.map((d) => {
          const done = d.course.filter((s) => s.done).length;
          const written = d.course.filter((s) => (s.status ?? "ready") === "ready").length;
          return (
            <button key={d.id} className="card doc" onClick={() => go(`/doc/${d.id}?tab=course`)}>
              <div className="doc-title">{d.title}</div>
              <div className="bar"><div style={{ width: `${(done / d.course.length) * 100}%` }} /></div>
              <span className="muted small">{done} of {d.course.length} lessons done{written < d.course.length ? ` · ${written} written` : ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The course tab                                                       */
/* ------------------------------------------------------------------ */

/** Which lesson each course was last open on, so switching tabs does not send the student back to the overview. */
const lastOpen = new Map<string, string | null>();

export function Course({ doc, job, onGenerate }: { doc: Doc; job?: Job; onGenerate: () => void }) {
  const secs = doc.course;
  const running = !!job && !job.error;
  const [openId, setOpenId] = useState<string | null>(lastOpen.get(doc.id) ?? null);
  const top = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useEffect(() => {
    lastOpen.set(doc.id, openId);
    if (first.current) first.current = false;
    else top.current?.scrollIntoView({ block: "start" });
  }, [doc.id, openId]);

  if (!secs.length) {
    if (running)
      return (
        <div className="empty-note">
          <span className="spinner" /> {job!.step}
          <button onClick={() => cancelJob(`${doc.id}:course`)}>Cancel</button>
        </div>
      );
    return (
      <div className="empty-note">
        <Compass size={32} />
        <p>Turn this document into a guided course: an outline, then full lessons with a worked example, practice problems and a recap.</p>
        <button className="primary" onClick={onGenerate}>Generate course</button>
        {job?.error && <p className="error-text">{job.error}</p>}
      </div>
    );
  }

  const n = secs.length;
  const done = secs.filter((s) => s.done).length;
  const minutes = secs.reduce((a, s) => a + (s.minutes ?? 0), 0);
  const stat = (s: Section) => statusOf(s, running);
  const todo = secs.filter((s) => stat(s) === "pending" || stat(s) === "failed");
  const failed = secs.filter((s) => stat(s) === "failed").length;
  const idx = openId ? secs.findIndex((s) => s.id === openId) : -1;
  const sec = idx >= 0 ? secs[idx] : null;
  const resume = () => void generateCourse(doc);

  const setDone = (id: string, value: boolean) => {
    if (value) recordActivity(2);
    updateDoc(doc.id, (d) => ({ course: d.course.map((x) => (x.id === id ? { ...x, done: value } : x)) }));
  };
  const nextIdx = secs.findIndex((s) => !s.done);

  /* Generation status: shows what is being written, or offers to write what is missing. */
  const status = running ? (
    <div className="crs-status" role="status">
      <span className="spinner" />
      <span>{job!.step}</span>
      <button onClick={() => cancelJob(`${doc.id}:course`)}><X size={14} /> Cancel</button>
    </div>
  ) : job?.error ? (
    <div className="callout warn crs-status" role="alert">
      <TriangleAlert size={16} />
      <div>{job.error}</div>
      <button onClick={resume}>Write remaining lessons</button>
    </div>
  ) : todo.length > 0 ? (
    <div className="callout warn crs-status" role="status">
      <div>
        {todo.length} {todo.length === 1 ? "lesson isn't" : "lessons aren't"} written yet{failed ? ` (${failed} failed)` : ""}. Lessons you already have are kept.
      </div>
      <button onClick={resume}>Write remaining lessons</button>
    </div>
  ) : null;

  /* ---------------- overview ---------------- */
  if (!sec) {
    const all = done === n;
    const info = doc.courseInfo;
    return (
      <div className="crs" ref={top}>
        <header className="crs-hero">
          <p className="eyebrow">Course · {n} lessons{minutes ? ` · about ${fmtMin(minutes)}` : ""}</p>
          <h2 className="crs-title">{doc.title}</h2>
          {info?.summary && <p className="crs-summary">{info.summary}</p>}
          {!!info?.outcomes?.length && (
            <>
              <p className="eyebrow">By the end you will be able to</p>
              <ul className="crs-outcomes">{info.outcomes.map((o, i) => <li key={i}>{o}</li>)}</ul>
            </>
          )}
          <div className="crs-progress">
            <div className="progress-line big"><div style={{ width: `${(done / n) * 100}%` }} /></div>
            <span className="tally">{done}/{n} lessons</span>
          </div>
          <div className="row">
            <button className="primary" onClick={() => setOpenId(secs[Math.max(0, nextIdx)].id)}>
              {done === 0 ? "Start course" : all ? "Review from the start" : "Continue"} <ArrowRight size={16} />
            </button>
            {minutes > 0 && done > 0 && !all && <span className="muted small">{fmtMin(secs.filter((s) => !s.done).reduce((a, s) => a + (s.minutes ?? 0), 0))} left</span>}
          </div>
        </header>
        {status}
        {all && (
          <div className="crs-finished">
            <PartyPopper size={34} />
            <div>
              <h3>Course complete</h3>
              <p className="muted small">Lock it in with the flashcards, quiz and podcast in the tabs above.</p>
            </div>
            <button onClick={() => (updateDoc(doc.id, (d) => ({ course: d.course.map((x) => ({ ...x, done: false })) })), setOpenId(null))}><RotateCcw size={15} /> Restart course</button>
          </div>
        )}
        <h3 className="crs-h3">Lessons</h3>
        <Outline secs={secs} current={null} running={running} onPick={setOpenId} />
        {!running && (
          <p className="small muted crs-rebuild">
            Not what you wanted?{" "}
            <button
              className="link"
              onClick={async () => {
                if (await confirmDialog("Rebuild this course?", "A new outline and new lessons replace the current ones, and your lesson progress is reset.", "Rebuild", true)) void rebuildCourse(doc);
              }}
            >
              Rebuild the course
            </button>
          </p>
        )}
      </div>
    );
  }

  /* ---------------- lesson reader ---------------- */
  const st = stat(sec);
  const prev = secs[idx - 1];
  const next = secs[idx + 1];
  const finish = () => {
    if (!sec.done) setDone(sec.id, true);
    setOpenId(next ? next.id : null);
  };

  return (
    <div className="crs" ref={top}>
      <div className="crs-bar">
        <button className="ghost-btn" onClick={() => setOpenId(null)}><ArrowLeft size={15} /> Course overview</button>
        <div className="crs-bar-progress">
          <div className="progress-line"><div style={{ width: `${(done / n) * 100}%` }} /></div>
          <span className="tally">{done}/{n}</span>
        </div>
      </div>
      {status}
      <div className="crs-layout">
        <aside className="crs-side" aria-label="Course outline">
          <Outline secs={secs} current={sec.id} running={running} onPick={setOpenId} compact />
        </aside>
        <div className="crs-main">
          <select className="crs-pick" aria-label="Choose a lesson" value={sec.id} onChange={(e) => setOpenId(e.target.value)}>
            {secs.map((s, i) => <option key={s.id} value={s.id}>{`${i + 1}. ${s.title}${s.done ? " ✓" : ""}`}</option>)}
          </select>
          <article className="crs-lesson" key={sec.id}>
            <p className="eyebrow">{sec.module ? `${sec.module} · ` : ""}Lesson {idx + 1} of {n}{sec.minutes ? ` · ${sec.minutes} min` : ""}</p>
            <h2 className="crs-h">{sec.title}</h2>
            {!!sec.objectives?.length && (
              <div className="crs-obj">
                <span className="eyebrow">You will learn to</span>
                <ul className="crs-chips">{sec.objectives.map((o, i) => <li key={i}>{o}</li>)}</ul>
              </div>
            )}

            {st === "pending" && (
              <div className="crs-wait">
                <p>{running ? "This lesson is in the queue. It appears here as soon as it is written." : "This lesson hasn't been written yet."}</p>
                {!running && <button className="primary" onClick={resume}>Write remaining lessons</button>}
              </div>
            )}
            {st === "failed" && (
              <div className="callout warn" role="alert">
                <TriangleAlert size={16} />
                <div>
                  <b>This lesson didn't come through.</b>
                  <p className="small">{sec.error || "The model's reply could not be used."}</p>
                </div>
                <button onClick={() => retryLesson(doc.id, sec.id)}><RotateCcw size={14} /> Retry</button>
              </div>
            )}
            {st === "writing" && !sec.lesson && (
              <div className="crs-skel" aria-label="Writing this lesson">
                <i /><i /><i /><i /><i />
              </div>
            )}
            {(st === "ready" || (st === "writing" && !!sec.lesson)) && (
              <>
                <Markdown text={sec.lesson} className="crs-body" />
                {st === "writing" && <p className="small muted"><span className="cursor" /> Still writing this lesson…</p>}
                {sec.example && (
                  <aside className="crs-example">
                    <p className="eyebrow"><Lightbulb size={13} /> Worked example</p>
                    <Markdown text={sec.example} />
                  </aside>
                )}
              </>
            )}
            {st === "ready" && (
              <>
                {!!sec.practice?.length && <Practice sec={sec} />}
                {!!sec.recap?.length && (
                  <aside className="crs-recap">
                    <p className="eyebrow">Recap</p>
                    <Markdown text={sec.recap.map((r) => `- ${r}`).join("\n")} />
                  </aside>
                )}
                {sec.check && !sec.practice?.length && <QuickCheck check={sec.check} />}
              </>
            )}

            <footer className="crs-nav">
              <button disabled={!prev} onClick={() => prev && setOpenId(prev.id)}><ArrowLeft size={15} /> Previous</button>
              <span className="spacer" />
              {sec.done ? (
                <>
                  <span className="crs-done"><Check size={15} /> Completed</span>
                  <button className="link" onClick={() => setDone(sec.id, false)}>Mark as not done</button>
                  {next ? <button className="primary" onClick={() => setOpenId(next.id)}>Next lesson <ArrowRight size={15} /></button> : <button className="primary" onClick={() => setOpenId(null)}>Back to overview</button>}
                </>
              ) : (
                <button className="primary" disabled={st !== "ready"} onClick={finish}>
                  {next ? "Mark complete & continue" : "Mark complete & finish"} <ArrowRight size={15} />
                </button>
              )}
            </footer>
          </article>
        </div>
      </div>
    </div>
  );
}

/** Modules and their lessons, each with a status mark. Used full-width on the overview and compact beside the reader. */
function Outline({ secs, current, running, onPick, compact = false }: { secs: Section[]; current: string | null; running: boolean; onPick: (id: string) => void; compact?: boolean }) {
  const groups: { name: string; items: { s: Section; i: number }[] }[] = [];
  secs.forEach((s, i) => {
    const name = s.module ?? "";
    const g = groups[groups.length - 1];
    if (g && g.name === name) g.items.push({ s, i });
    else groups.push({ name, items: [{ s, i }] });
  });
  return (
    <nav className={"crs-outline" + (compact ? " compact" : "")}>
      {groups.map((g, gi) => (
        <section key={gi} className="crs-module">
          {g.name && <h4 className="crs-module-name">{g.name}</h4>}
          <ol className="crs-lessons" start={g.items[0].i + 1}>
            {g.items.map(({ s, i }) => {
              const st = statusOf(s, running);
              return (
                <li key={s.id}>
                  <button className={"crs-lesson-btn" + (s.id === current ? " cur" : "") + (s.done ? " done" : "") + ` ${st}`} aria-label={`${i + 1}. ${s.title}${s.done ? " (complete)" : ""}`} aria-current={s.id === current ? "true" : undefined} onClick={() => onPick(s.id)}>
                    <span className="crs-mark" aria-hidden>
                      {s.done ? <Check size={13} strokeWidth={3} /> : st === "writing" ? <span className="spinner" /> : st === "failed" ? <TriangleAlert size={13} /> : <span className="crs-num">{i + 1}</span>}
                    </span>
                    <span className="crs-lesson-title">{s.title}</span>
                    <span className="crs-lesson-meta">
                      {st === "writing" ? "writing" : st === "failed" ? "failed" : st === "pending" ? "queued" : s.minutes ? `${s.minutes} min` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </nav>
  );
}

/** Open problems: try first, then reveal the hint, then the full solution. */
function Practice({ sec }: { sec: Section }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setShown((p) => ({ ...p, [k]: !p[k] }));
  return (
    <section className="crs-practice">
      <h3>Practice</h3>
      <p className="muted small">Try each one on paper first. Use the hint if you are stuck, then compare your working with the solution.</p>
      {sec.practice!.map((p, i) => {
        const h = `${i}:hint`;
        const a = `${i}:sol`;
        return (
          <div className="crs-q" key={i}>
            <div className="crs-q-head"><span className="crs-q-no">Q{i + 1}</span></div>
            <Markdown text={p.q} className="crs-q-text" />
            <div className="crs-q-actions">
              {p.hint && <button aria-expanded={!!shown[h]} onClick={() => toggle(h)}><Lightbulb size={14} /> {shown[h] ? "Hide hint" : "Show hint"}</button>}
              <button aria-expanded={!!shown[a]} onClick={() => toggle(a)}>{shown[a] ? <EyeOff size={14} /> : <Eye size={14} />} {shown[a] ? "Hide solution" : "Show solution"}</button>
            </div>
            {shown[h] && p.hint && <div className="crs-hint"><b className="eyebrow">Hint</b><Markdown text={p.hint} /></div>}
            {shown[a] && <div className="crs-solution"><b className="eyebrow">Solution</b><Markdown text={p.answer} /></div>}
          </div>
        );
      })}
    </section>
  );
}

/** The old multiple-choice check-in, kept as one optional question at the end of courses made before the rework. */
function QuickCheck({ check }: { check: CheckIn }) {
  const [pick, setPick] = useState<number | null>(null);
  const answered = pick !== null;
  const correct = pick === check.answer;
  return (
    <section className="crs-quick">
      <p className="eyebrow">Quick check (optional)</p>
      <Markdown text={check.q} className="qtext" />
      <div className="options">
        {check.options.map((o, k) => (
          <button key={k} className={"option" + (answered && k === check.answer ? " right" : "") + (answered && pick === k && k !== check.answer ? " wrong" : "")} onClick={() => setPick(k)}>
            <kbd>{k + 1}</kbd> <Markdown text={o} />
          </button>
        ))}
      </div>
      {answered && (
        <div className={"result " + (correct ? "ok" : "bad")}>
          <b>{correct ? "Correct" : "Not quite."}</b>
          <Markdown text={check.explain} />
        </div>
      )}
    </section>
  );
}

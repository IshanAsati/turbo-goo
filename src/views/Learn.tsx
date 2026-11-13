import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, AudioLines, Check, ChevronLeft, CircleAlert, CircleCheck, CircleX, CornerDownLeft, Eye, Lightbulb, Loader2, Lock, MessageCircle, PartyPopper, RotateCcw, SendHorizontal, Square, Star, TriangleAlert, Upload, X, Zap } from "lucide-react";
import { go } from "../lib/nav";
import { cancelJob, createCourseDoc, generateCourse, rebuildCourse, retryLesson } from "../lib/generate";
import { chat, gradePractice } from "../lib/ai";
import type { PracticeVerdict } from "../lib/ai";
import { ACCEPT, fetchYouTube, ingestFile, isYouTube } from "../lib/ingest";
import { hasLLM } from "../lib/llm";
import { buildPages, pageText } from "../lib/lessonPages";
import type { LessonPage } from "../lib/lessonPages";
import { recordActivity, updateDoc, useStore } from "../lib/store";
import type { ChatMsg, Doc, Job, LessonStatus, Section } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { Mascot } from "../components/Mascot";
import { confirmDialog, toast } from "../components/feedback";
import "../styles/learn.css";

const IDEAS = ["Quadratic equations", "Light: reflection and refraction", "Nationalism in India", "Antitrust law", "How transformers work"];

/** Old saved lessons have no status: they were written in one piece, so they count as ready. A "writing" lesson with no running job is stale. */
const statusOf = (s: Section, running: boolean): LessonStatus => (s.status === "writing" && !running ? "pending" : s.status ?? "ready");
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Re-renders when a media query flips. */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

/* ------------------------------------------------------------------ */
/* #/learn: start a course                                              */
/* ------------------------------------------------------------------ */

function Ring({ value, size = 44 }: { value: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="lh-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} className="lh-ring-track" />
      <circle cx={size / 2} cy={size / 2} r={r} className="lh-ring-val" strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="lh-ring-n">{Math.round(value * 100)}</text>
    </svg>
  );
}

export function LearnHome() {
  const { settings, docs } = useStore();
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const courses = docs.filter((d) => d.course.length > 0).sort((a, b) => (b.openedAt ?? b.updatedAt) - (a.openedAt ?? a.updatedAt));

  async function start() {
    const t = topic.trim();
    if (!t) return;
    setBusy("Starting…");
    try {
      if (isYouTube(t)) {
        setBusy("Fetching transcript…");
        const r = await fetchYouTube(t);
        if (!r.ok) throw new Error(r.error + " Try Library → YouTube to paste the transcript manually.");
        return go(`/doc/${createCourseDoc({ title: r.data.title, source: r.data.text, kind: "youtube" })}?tab=learn`);
      }
      if (!hasLLM(settings)) {
        toast("Courses from a bare topic need an AI provider, since there's no source to draw on. Add an API key in Settings, or build a course from a file.", "error");
        return;
      }
      go(`/doc/${createCourseDoc({ title: t, source: "", kind: "topic" })}?tab=learn`);
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
      go(`/doc/${createCourseDoc(r)}?tab=learn`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="lh">
      <Mascot size={132} mood="reading" />
      <h1 className="lh-title">What do you want to <em>learn</em>?</h1>
      <p className="lh-sub">Type any topic, paste a YouTube link, or add a file. TurboGoo plans a course, then writes every lesson: an explanation, a worked example, practice with hints and solutions, and a recap.</p>
      <form className="lh-box" onSubmit={(e) => (e.preventDefault(), void start())}>
        <input aria-label="Topic or YouTube link" placeholder="e.g. quadratic equations" value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!!busy} />
        <button type="submit" className="primary lh-go" disabled={!!busy || !topic.trim()} aria-label="Create course">
          {busy ? <><span className="spinner" /> {busy}</> : <>Create course <ArrowRight size={16} /></>}
        </button>
      </form>
      <div className="lh-chips">
        {IDEAS.map((i) => <button key={i} className="chip" onClick={() => setTopic(i)}>{i}</button>)}
        <button className="chip" onClick={() => file.current?.click()}><Upload size={13} /> From a file</button>
      </div>
      <input ref={file} hidden type="file" accept={ACCEPT} onChange={(e) => (fromFile(e.target.files?.[0]), (e.target.value = ""))} />
      {!hasLLM(settings) && <p className="lh-note" role="note">Without an API key, courses from files use a simple built-in engine (lessons are your own text, grouped by topic) and topic-only courses are unavailable. Add a key in Settings for the full experience.</p>}

      <section className="lh-courses" aria-labelledby="lh-courses-h">
        <h2 id="lh-courses-h">Your courses</h2>
        {courses.length === 0 && <p className="muted">None yet. Your first course shows up here.</p>}
        <div className="lh-list">
          {courses.map((d) => {
            const done = d.course.filter((s) => s.done).length;
            const written = d.course.filter((s) => (s.status ?? "ready") === "ready").length;
            return (
              <button key={d.id} className="lh-card" onClick={() => go(`/doc/${d.id}?tab=learn`)}>
                <Ring value={done / d.course.length} />
                <span className="lh-card-t">
                  <b>{d.title}</b>
                  <small>{done} of {d.course.length} lessons done{written < d.course.length ? ` · ${written} written` : ""}</small>
                </span>
                <ArrowRight size={18} className="lh-card-go" />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* URL + session persistence                                            */
/* ------------------------------------------------------------------ */

/** The open lesson lives in the hash as &lesson=<n> (1-based), so a reload restores it. replaceState: no history entry, no re-route. */
const readLesson = (): number | null => {
  const h = location.hash;
  const q = h.indexOf("?");
  const n = q < 0 ? NaN : parseInt(new URLSearchParams(h.slice(q + 1)).get("lesson") ?? "", 10);
  return n >= 1 ? n - 1 : null;
};
function writeLesson(docId: string, i: number | null) {
  const h = location.hash;
  const q = h.indexOf("?");
  const path = q < 0 ? h : h.slice(0, q);
  if (!path.startsWith(`#/doc/${docId}`)) return; // the route already moved on
  const p = new URLSearchParams(q < 0 ? "" : h.slice(q + 1));
  if (i === null) p.delete("lesson");
  else p.set("lesson", String(i + 1));
  const s = p.toString();
  const next = path + (s ? `?${s}` : "");
  if (next !== h) history.replaceState(null, "", location.pathname + location.search + next);
}

/** What the student has done in a lesson this session. XP is derived from it, so it can never drift. */
type Rate = "got" | "review";
type PageUi = { hint?: boolean; sol?: boolean; text?: string; pick?: number; result?: PracticeVerdict & { for: string }; tries?: number };
type LState = { page: number; cont: number[]; rated: Record<number, Rate>; ui: Record<number, PageUi> };
type DState = Record<string, LState>;
const blank = (): LState => ({ page: 0, cont: [], rated: {}, ui: {} });
const skey = (docId: string) => `tg:lesson:${docId}`;
function loadState(docId: string): DState {
  try {
    return JSON.parse(sessionStorage.getItem(skey(docId)) ?? "{}") as DState;
  } catch {
    return {};
  }
}
const xpOf = (ls?: LState) => (ls ? ls.cont.length + Object.values(ls.rated).reduce((n, r) => n + (r === "got" ? 5 : 2), 0) : 0);

/* ------------------------------------------------------------------ */
/* The course tab: overview                                             */
/* ------------------------------------------------------------------ */

function HeroArt() {
  return (
    <svg className="lc-art" viewBox="0 0 200 170" fill="none" aria-hidden>
      <ellipse cx="100" cy="86" rx="92" ry="34" transform="rotate(-28 100 86)" className="a-orbit" />
      <g className="a-stars">
        <path d="M30 40l2.5 6 6 2.5-6 2.5L30 57l-2.5-6-6-2.5 6-2.5L30 40Z" />
        <path d="M172 112l2 4.6 4.6 2-4.6 2-2 4.6-2-4.6-4.6-2 4.6-2 2-4.6Z" />
        <circle cx="166" cy="34" r="3" />
        <circle cx="44" cy="120" r="2.4" />
      </g>
      {/* book */}
      <path d="M100 150c-22-12-52-14-74-6V98c22-8 52-6 74 6v46Z" className="a-page-l" />
      <path d="M100 150c22-12 52-14 74-6V98c-22-8-52-6-74 6v46Z" className="a-page-r" />
      <path d="M100 104v46" className="a-spine" />
      <path d="M38 112c16-4 38-3 54 4M38 124c16-4 38-3 54 4M108 116c16-7 38-8 54-4M108 128c16-7 38-8 54-4" className="a-lines" />
      <path d="M22 148c24-9 54-7 78 6 24-13 54-15 78-6v8c-24-9-54-7-78 6-24-13-54-15-78-6v-8Z" className="a-cover" />
      {/* rocket */}
      <g transform="rotate(14 100 66)">
        <path d="M100 14c13 15 16 38 10 62H90c-6-24-3-47 10-62Z" className="a-body" />
        <path d="M100 14c13 15 16 38 10 62h-6c4-24 1-46-4-62Z" className="a-shade" />
        <circle cx="100" cy="46" r="7" className="a-win" />
        <path d="M90 62l-14 16 14-4v-12ZM110 62l14 16-14-4v-12Z" className="a-fin" />
        <path d="M94 76h12l-6 20-6-20Z" className="a-flame" />
      </g>
    </svg>
  );
}

const OutcomeCard = ({ items }: { items: string[] }) => (
  <section className="lc-outcomes" aria-labelledby="lc-out-h">
    <h2 id="lc-out-h">What you'll be able to do</h2>
    <ul>{items.map((o, i) => <li key={i}>{o}</li>)}</ul>
  </section>
);

export function Course({ doc, job, onGenerate }: { doc: Doc; job?: Job; onGenerate: () => void }) {
  const secs = doc.course;
  const running = !!job && !job.error;
  const [openIdx, setOpenIdx] = useState<number | null>(readLesson);
  const [tutorMsgs, setTutorMsgs] = useState<Record<string, ChatMsg[]>>({});
  const [pulse, setPulse] = useState<string | null>(null);

  const n = secs.length;
  const stat = (s: Section) => statusOf(s, running);
  const current = secs.findIndex((s) => !s.done); // -1 = every lesson is done
  const isLocked = (i: number) => current !== -1 && i > current;
  const canOpen = (i: number) => !!secs[i] && !isLocked(i) && stat(secs[i]) === "ready";
  const playing = openIdx !== null && canOpen(openIdx) ? openIdx : null;

  /* keep the URL in step with the player */
  useEffect(() => {
    if (!n) return;
    writeLesson(doc.id, playing);
  }, [doc.id, playing, n]);
  useEffect(() => () => writeLesson(doc.id, null), [doc.id]);

  /* after finishing a lesson, bring the next one into view */
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (playing !== null || !pulse) return;
    const el = listRef.current?.querySelector(".lc-current");
    el?.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
    const t = setTimeout(() => setPulse(null), 2600);
    return () => clearTimeout(t);
  }, [playing, pulse]);

  const resume = () => void generateCourse(doc);

  function open(i: number) {
    const s = secs[i];
    if (!s) return;
    if (isLocked(i)) return toast(`Finish lesson ${current + 1} first`);
    const st = stat(s);
    if (st === "writing" || st === "pending") return toast(running ? "That lesson is still being written. It opens as soon as it's ready." : "That lesson hasn't been written yet. Use “Write remaining lessons”.");
    if (st === "failed") return toast("That lesson didn't come through. Tap Retry to write it again.", "error");
    setOpenIdx(i);
  }

  /* ---------------- empty / generating ---------------- */
  if (!n) {
    return (
      <div className="lc lc-empty">
        <Mascot size={150} mood={running ? "thinking" : "reading"} />
        {running ? (
          <>
            <h2>Building your course</h2>
            <p className="lc-step" role="status"><span className="spinner" /> {job!.step}</p>
            <button onClick={() => cancelJob(`${doc.id}:course`)}><X size={14} /> Cancel</button>
          </>
        ) : (
          <>
            <h2>Turn this into a course</h2>
            <p className="muted">A guided course: an outline, then full lessons with a worked example, practice problems and a recap. You learn one short page at a time.</p>
            <button className="primary lc-big" onClick={onGenerate}>Generate course</button>
            {job?.error && <p className="error-text" role="alert">{job.error}</p>}
          </>
        )}
      </div>
    );
  }

  const done = secs.filter((s) => s.done).length;
  const all = done === n;
  const todo = secs.filter((s) => stat(s) === "pending" || stat(s) === "failed");
  const failed = secs.filter((s) => stat(s) === "failed").length;
  const info = doc.courseInfo;
  const target = all ? 0 : current;
  const targetSec = secs[target];
  const targetReady = stat(targetSec) === "ready";

  const status = running ? (
    <div className="lc-status" role="status">
      <span className="spinner" />
      <span>{job!.step}</span>
      <button onClick={() => cancelJob(`${doc.id}:course`)}><X size={14} /> Cancel</button>
    </div>
  ) : job?.error ? (
    <div className="lc-status warn" role="alert">
      <TriangleAlert size={16} />
      <span>{job.error}</span>
      <button onClick={resume}>Write remaining lessons</button>
    </div>
  ) : todo.length > 0 ? (
    <div className="lc-status warn" role="status">
      <span>{plural(todo.length, "lesson isn't", "lessons aren't")} written yet{failed ? ` (${failed} failed)` : ""}. Lessons you already have are kept.</span>
      <button onClick={resume}>Write remaining lessons</button>
    </div>
  ) : null;

  const finish = (i: number) => {
    const s = secs[i];
    if (!s.done) {
      recordActivity(2);
      updateDoc(doc.id, (d) => ({ course: d.course.map((x) => (x.id === s.id ? { ...x, done: true } : x)) }));
      const nextS = secs.find((x, k) => k > i && !x.done);
      setPulse(nextS?.id ?? s.id);
    }
    setOpenIdx(null);
  };

  const pagesOf = (s: Section) => (stat(s) === "ready" ? buildPages(s).length : 0);
  const groups: { name: string; first: number }[] = [];
  secs.forEach((s, i) => {
    if ((s.module ?? "") !== (secs[i - 1]?.module ?? "") && s.module) groups.push({ name: s.module, first: i });
  });
  const label = (i: number) => groups.find((g) => g.first === i)?.name;

  return (
    <div className="lc">
      <header className="lc-hero">
        <HeroArt />
        <div>
          <h1 className="lc-title">{doc.title}</h1>
          {info?.summary && <p className="lc-summary">{info.summary}</p>}
        </div>
      </header>

      <div className="lc-cta">
        <button className="primary lc-big" disabled={!targetReady} onClick={() => open(target)}>
          {done === 0 ? "Start lesson" : all ? "Review" : "Continue"}
        </button>
        <div className="lc-next">
          <span>{all ? "Course complete" : "Up next"}</span>
          <b>{all ? "Start again from lesson 1" : targetSec.title}</b>
        </div>
      </div>

      {status}

      {all && (
        <section className="lc-finished" aria-label="Course complete">
          <Mascot size={96} mood="cheer" />
          <div>
            <h2>Course complete</h2>
            <p className="muted">Lock it in with the quiz, flashcards and podcast.</p>
          </div>
          <button className="primary" onClick={() => go(`/doc/${doc.id}?tab=quiz`)}>Take the quiz</button>
        </section>
      )}

      {!!info?.outcomes?.length && <OutcomeCard items={info.outcomes} />}

      <div className="lc-contents-head">
        <h2>Contents</h2>
        <span className="lc-count">{done} of {n} complete</span>
      </div>

      <ol className="lc-tl" ref={listRef}>
        {secs.map((s, i) => {
          const st = stat(s);
          const locked = isLocked(i);
          const isCur = i === current;
          const pages = pagesOf(s);
          const group = label(i);
          const meta = (
            <>
              {st === "writing" && <span className="lc-meta"><span className="spinner" /> Writing…</span>}
              {st === "pending" && <span className="lc-meta">Queued</span>}
              {st === "failed" && <span className="lc-meta bad"><TriangleAlert size={13} /> Failed</span>}
              {st === "ready" && pages > 0 && <span className="lc-meta">{plural(pages, "page")}</span>}
            </>
          );
          const retry = st === "failed" && (
            <button className="lc-retry" onClick={(e) => (e.stopPropagation(), retryLesson(doc.id, s.id))}><RotateCcw size={13} /> Retry</button>
          );
          const dot = (
            <span className={"lc-dot" + (isCur ? " cur" : "") + (s.done ? " done" : "")} aria-hidden>
              {s.done ? <Check size={18} strokeWidth={3} /> : i + 1}
            </span>
          );
          return (
            <li key={s.id} className={"lc-step-li" + (s.done ? " is-done" : "")}>
              {group && <p className="lc-group">{group}</p>}
              {isCur ? (
                <div className={"lc-row lc-current" + (pulse === s.id ? " pulse" : "")} aria-current="step">
                  {dot}
                  <div className="lc-card">
                    <div className="lc-card-t">
                      <h3>{s.title}</h3>
                      <p className="lc-sub">{meta}{st === "ready" && s.minutes ? <span className="lc-meta">{s.minutes} min</span> : null}</p>
                      {!!s.objectives?.length && st === "ready" && (
                        <ul className="lc-obj">{s.objectives.slice(0, 4).map((o, k) => <li key={k}>{o}</li>)}</ul>
                      )}
                    </div>
                    {st === "ready" ? <button className="primary lc-start" onClick={() => open(i)}>Start</button> : retry}
                  </div>
                </div>
              ) : (
                <div className="lc-row">
                  <button
                    className={"lc-line" + (locked ? " locked" : "") + (pulse === s.id ? " pulse" : "")}
                    aria-disabled={locked || st !== "ready"}
                    aria-label={`Lesson ${i + 1}: ${s.title}${s.done ? ", complete" : locked ? ", locked" : ""}`}
                    onClick={() => open(i)}
                  >
                    {dot}
                    <span className="lc-line-t">{s.title}</span>
                    <span className="lc-line-r">
                      {meta}
                      {locked ? <Lock size={15} aria-hidden /> : s.done ? <Check size={15} aria-hidden /> : null}
                    </span>
                  </button>
                  {retry}
                </div>
              )}
            </li>
          );
        })}
        <li className="lc-step-li">
          <div className="lc-row">
            <button className={"lc-line" + (all ? "" : " locked")} aria-disabled={!all} onClick={() => (all ? go(`/doc/${doc.id}?tab=quiz`) : toast(`Finish lesson ${current + 1} first`))}>
              <span className={"lc-dot star" + (all ? " cur" : "")} aria-hidden><Star size={17} /></span>
              <span className="lc-line-t">Checkpoint</span>
              <span className="lc-line-r"><span className="lc-meta">Quiz</span>{!all && <Lock size={15} aria-hidden />}</span>
            </button>
          </div>
        </li>
      </ol>

      {!running && (
        <div className="lc-foot">
          <button
            className="ghost-btn"
            onClick={async () => {
              if (await confirmDialog("Rebuild this course?", "A new outline and new lessons replace the current ones, and your lesson progress is reset.", "Rebuild", true)) void rebuildCourse(doc);
            }}
          >
            <RotateCcw size={14} /> Rebuild course
          </button>
          {done > 0 && (
            <button
              className="ghost-btn"
              onClick={async () => {
                if (await confirmDialog("Reset progress?", "Every lesson is marked as not done. The lessons themselves stay.", "Reset", true)) {
                  sessionStorage.removeItem(skey(doc.id));
                  updateDoc(doc.id, (d) => ({ course: d.course.map((x) => ({ ...x, done: false })) }));
                }
              }}
            >
              <PartyPopper size={14} /> Restart progress
            </button>
          )}
        </div>
      )}

      {playing !== null && (
        <LessonPlayer
          key={secs[playing].id}
          doc={doc}
          sec={secs[playing]}
          index={playing}
          total={n}
          msgs={tutorMsgs[secs[playing].id] ?? []}
          setMsgs={(fn) => setTutorMsgs((p) => ({ ...p, [secs[playing].id]: fn(p[secs[playing].id] ?? []) }))}
          onClose={() => setOpenIdx(null)}
          onFinish={() => finish(playing)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The lesson player                                                    */
/* ------------------------------------------------------------------ */

const speechOK = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

/** "Listen" pill: reads the page aloud with the browser's voice; toggles to Stop. */
function Listen({ text, resetKey }: { text: string; resetKey: unknown }) {
  const [on, setOn] = useState(false);
  const stop = useCallback(() => {
    try {
      speechSynthesis.cancel();
    } catch {
      /* no speech engine */
    }
    setOn(false);
  }, []);
  useEffect(() => {
    stop();
    return () => {
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [resetKey, stop]);
  if (!speechOK()) return null;
  const toggle = () => {
    if (on) return stop();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.98;
      u.onend = u.onerror = () => setOn(false);
      speechSynthesis.speak(u);
      setOn(true);
    } catch {
      setOn(false);
    }
  };
  return (
    <button className={"lp-listen" + (on ? " on" : "")} onClick={toggle} aria-pressed={on}>
      {on ? <Square size={14} fill="currentColor" /> : <AudioLines size={18} />} {on ? "Stop" : "Listen"}
    </button>
  );
}

/** A click that came from the mouse should not leave focus on the button, so Enter still means "Continue". */
const mouseBlur = (e: React.MouseEvent<HTMLElement>) => {
  if (e.detail > 0) e.currentTarget.blur();
};

function LessonPlayer({ doc, sec, index, total, msgs, setMsgs, onClose, onFinish }: { doc: Doc; sec: Section; index: number; total: number; msgs: ChatMsg[]; setMsgs: (fn: (m: ChatMsg[]) => ChatMsg[]) => void; onClose: () => void; onFinish: () => void }) {
  const pages = useMemo(() => buildPages(sec), [sec]);
  const last = pages.length - 1;
  const wide = useMedia("(min-width: 1100px)");
  const [tutorOpen, setTutorOpen] = useState(() => matchMedia("(min-width: 1100px)").matches);
  const [all, setAll] = useState<DState>(() => loadState(doc.id));
  const ls = all[sec.id] ?? blank();
  const page = Math.min(Math.max(0, ls.page), last);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const patch = useCallback(
    (fn: (l: LState) => LState) =>
      setAll((p) => {
        const next = { ...p, [sec.id]: fn(p[sec.id] ?? blank()) };
        try {
          sessionStorage.setItem(skey(doc.id), JSON.stringify(next));
        } catch {
          /* storage full or blocked: progress just isn't kept across reloads */
        }
        return next;
      }),
    [doc.id, sec.id],
  );
  const xp = Object.values(all).reduce((n, l) => n + xpOf(l), 0);

  const goTo = useCallback(
    (k: number) => {
      if (k < 0 || k > last || k === page) return;
      setDir(k > page ? "fwd" : "back");
      patch((l) => ({ ...l, page: k }));
    },
    [last, page, patch],
  );
  const next = useCallback(() => {
    if (page >= last) {
      patch((l) => ({ ...l, page: 0 }));
      return onFinish();
    }
    setDir("fwd");
    patch((l) => ({ ...l, page: page + 1, cont: l.cont.includes(page) ? l.cont : [...l.cont, page] }));
  }, [page, last, patch, onFinish]);

  /* open: take focus, stop the page behind from scrolling */
  useEffect(() => {
    root.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [page]);

  /* keyboard: Enter continues, arrows turn pages, Esc exits (or closes the tutor drawer / leaves a text box) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = t instanceof Element && !!t.closest("input, textarea, select, [contenteditable='true']");
      if (e.key === "Escape") {
        if (typing) return void (t as HTMLElement).blur();
        if (!wide && tutorOpen) return setTutorOpen(false);
        return onClose();
      }
      if (typing) return;
      if (e.key === "Enter") {
        if (t instanceof Element && t.closest("button, a")) return;
        e.preventDefault();
        next();
      } else if (e.key === "ArrowRight") goTo(page + 1);
      else if (e.key === "ArrowLeft") goTo(page - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, goTo, page, onClose, wide, tutorOpen]);

  const p = pages[page];
  const ui = ls.ui[page] ?? {};
  const setUi = (u: Partial<PageUi>) => patch((l) => ({ ...l, ui: { ...l.ui, [page]: { ...l.ui[page], ...u } } }));
  const rate = (r: Rate, force = false) => patch((l) => ({ ...l, rated: { ...l.rated, [page]: force ? r : l.rated[page] ?? r } }));
  const lessonText = [sec.lesson, sec.example, ...(sec.practice ?? []).map((q) => `${q.q}\n${q.answer}`), ...(sec.recap ?? [])].filter(Boolean).join("\n\n");

  return (
    <div className="lp" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Lesson: ${sec.title}`}>
      <div className="lp-main" ref={scroller}>
        <div className="lp-col">
          <header className="lp-head">
            <div className="lp-top">
              <button className="icon-btn lp-x" aria-label="Exit lesson" title="Exit (Esc)" onClick={onClose}><X size={20} /></button>
              <span className="lp-where">{sec.title} <span aria-hidden>·</span> <span>{page + 1} of {pages.length}</span></span>
              <span className="spacer" />
              {!tutorOpen && <button className="lp-tutor-btn" onClick={() => setTutorOpen(true)}><MessageCircle size={15} /> Tutor</button>}
              <span className="lp-xp" title="XP this session" aria-label={`${xp} XP`}><Zap size={16} fill="currentColor" /> <b>{xp}</b></span>
            </div>
            <div className="lp-bar" role="progressbar" aria-label="Lesson progress" aria-valuemin={0} aria-valuemax={pages.length} aria-valuenow={page}>
              <div style={{ width: `${(page / pages.length) * 100}%` }} />
            </div>
          </header>

          <section className={"lp-page " + dir} key={page} aria-live="polite" aria-label={`Page ${page + 1} of ${pages.length}`}>
            <PageBody p={p} sec={sec} subject={doc.subject} ui={ui} setUi={setUi} rated={ls.rated[page]} rate={rate} />
          </section>

          <footer className="lp-foot">
            <div className="lp-foot-l">
              {page > 0 && <button className="lp-back" aria-label="Previous page" title="Previous (←)" onClick={(e) => (mouseBlur(e), goTo(page - 1))}><ChevronLeft size={18} /></button>}
              <Listen text={pageText(p, sec.title)} resetKey={page} />
            </div>
            <button className="primary lp-next" onClick={next}>
              {page >= last ? (doc.course[index]?.done ? "Done" : "Finish lesson") : "Continue"}
              <span className="lp-key" aria-hidden><CornerDownLeft size={13} /></span>
            </button>
          </footer>
        </div>
      </div>

      {(wide ? tutorOpen : true) && <Tutor doc={doc} sec={sec} text={lessonText} open={tutorOpen} wide={wide} msgs={msgs} setMsgs={setMsgs} onClose={() => setTutorOpen(false)} />}
      {!wide && tutorOpen && <div className="lt-scrim" onClick={() => setTutorOpen(false)} aria-hidden />}
    </div>
  );
}

function PageBody({ p, sec, subject, ui, setUi, rated, rate }: { p: LessonPage; sec: Section; subject: Doc["subject"]; ui: PageUi; setUi: (u: Partial<PageUi>) => void; rated?: Rate; rate: (r: Rate, force?: boolean) => void }): ReactNode {
  switch (p.kind) {
    case "intro":
      return (
        <>
          {!p.md && <h1 className="lp-h1">{sec.title}</h1>}
          {p.md && <Markdown text={p.md} className="lp-md" />}
          {!!p.cover.length && (
            <>
              <h2 className="lp-cover-h">What you'll cover</h2>
              <Markdown text={p.cover.map((c) => `- ${c}`).join("\n")} className="lp-md lp-cover" />
            </>
          )}
        </>
      );
    case "content":
      return <Markdown text={p.md} className="lp-md" />;
    case "example":
      return (
        <>
          <p className="lp-eyebrow"><Lightbulb size={14} /> Worked example{p.of > 1 ? ` · ${p.n + 1} of ${p.of}` : ""}</p>
          <Markdown text={p.md} className="lp-md" />
        </>
      );
    case "practice":
      return <Practice p={p} subject={subject} ui={ui} setUi={setUi} rated={rated} rate={rate} />;
    case "check": {
      const c = p.check;
      const answered = ui.pick !== undefined;
      return (
        <>
          <p className="lp-eyebrow">Quick check (optional)</p>
          <Markdown text={c.q} className="lp-md lp-q" />
          <div className="lp-opts">
            {c.options.map((o, k) => (
              <button
                key={k}
                className={"lp-opt" + (answered && k === c.answer ? " right" : "") + (answered && ui.pick === k && k !== c.answer ? " wrong" : "")}
                disabled={answered}
                onClick={(e) => (mouseBlur(e), setUi({ pick: k }), rate(k === c.answer ? "got" : "review"))}
              >
                <kbd>{k + 1}</kbd> <Markdown text={o} />
              </button>
            ))}
          </div>
          {answered && (
            <div className={"lp-box " + (ui.pick === c.answer ? "sol" : "tip")}><b>{ui.pick === c.answer ? "Correct" : "Not quite"}</b><Markdown text={c.explain} className="lp-md" /></div>
          )}
        </>
      );
    }
    case "recap":
      return (
        <div className="lp-recap">
          <Mascot size={150} mood="cheer" />
          <h1 className="lp-h1">{p.items.length ? "Recap" : "Nice work!"}</h1>
          {p.items.length ? <Markdown text={p.items.map((r) => `- ${r}`).join("\n")} className="lp-md" /> : <p className="lp-md">You've been through every page of “{sec.title}”.</p>}
          <p className="lp-done-note">Ready? Finish the lesson to unlock the next one.</p>
        </div>
      );
  }
}

const VERDICT = {
  correct: { title: "Correct!", icon: CircleCheck },
  partial: { title: "Almost there", icon: CircleAlert },
  wrong: { title: "Not quite", icon: CircleX },
} as const;

/** A practice problem: type an answer, get it checked, then use the hint or the full solution. */
function Practice({ p, subject, ui, setUi, rated, rate }: { p: Extract<LessonPage, { kind: "practice" }>; subject: Doc["subject"]; ui: PageUi; setUi: (u: Partial<PageUi>) => void; rated?: Rate; rate: (r: Rate, force?: boolean) => void }) {
  const { settings } = useStore();
  const q = p.q;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const text = ui.text ?? "";
  const res = ui.result && ui.result.for === text.trim() ? ui.result : undefined; // editing the answer makes the old verdict stale
  const stale = !!ui.result && !res;

  async function check() {
    const answer = text.trim();
    if (!answer || busy) return;
    setErr("");
    setBusy(true);
    const c = new AbortController();
    ctl.current = c;
    try {
      const g = await gradePractice(settings, q.q, q.answer, answer, { signal: c.signal, subject });
      setUi({ result: { ...g, for: answer }, tries: (ui.tries ?? 0) + 1 });
      rate(g.verdict === "correct" ? "got" : "review", g.verdict === "correct");
    } catch (e) {
      if (!c.signal.aborted) setErr((e as Error).message || "Couldn't check that answer. Try again.");
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  }

  const V = res ? VERDICT[res.verdict] : null;
  return (
    <>
      <p className="lp-eyebrow">Practice{p.of > 1 ? ` · ${p.i + 1} of ${p.of}` : ""}</p>
      <Markdown text={q.q} className="lp-md lp-q" />
      <textarea
        className={"lp-answer" + (res ? " " + res.verdict : "")}
        rows={3}
        aria-label="Your answer"
        placeholder="Type your answer, then press Check"
        value={text}
        disabled={busy}
        onChange={(e) => setUi({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void check();
          }
        }}
      />
      <div className="lp-actions">
        {busy ? (
          <button className="primary" onClick={() => ctl.current?.abort()}><Loader2 size={15} className="spin" /> Checking… <small>Stop</small></button>
        ) : !res ? (
          <button className="primary" onClick={(e) => (mouseBlur(e), void check())} disabled={!text.trim()}>
            <Check size={15} /> {stale ? "Check again" : "Check answer"} <small>Ctrl+Enter</small>
          </button>
        ) : null}
        {q.hint && !ui.sol && (
          <button aria-expanded={!!ui.hint} onClick={(e) => (mouseBlur(e), setUi({ hint: !ui.hint }))}><Lightbulb size={15} /> {ui.hint ? "Hide hint" : "Show hint"}</button>
        )}
        <button aria-expanded={!!ui.sol} onClick={(e) => (mouseBlur(e), setUi({ sol: !ui.sol }))}><Eye size={15} /> {ui.sol ? "Hide solution" : "Show solution"}</button>
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}
      {res && V && (
        <div className={"lp-verdict " + res.verdict} role="status">
          <V.icon size={22} aria-hidden />
          <div>
            <b>{V.title}{rated === "got" && res.verdict === "correct" ? " +5 XP" : ""}</b>
            <Markdown text={res.feedback} className="lp-md" />
            {res.verdict !== "correct" && !ui.sol && <p className="lp-verdict-next">Edit your answer to try again, or open the hint or solution.</p>}
          </div>
        </div>
      )}
      {ui.hint && q.hint && !ui.sol && (
        <div className="lp-box tip"><b>Hint</b><Markdown text={q.hint} className="lp-md" /></div>
      )}
      {ui.sol && (
        <>
          <div className="lp-box sol"><b>Solution</b><Markdown text={q.answer} className="lp-md" /></div>
          {!res && (
            <div className="lp-rate" role="group" aria-label="How did you do?">
              <span>How did you do?</span>
              <button className={rated === "got" ? "on good" : "good"} aria-pressed={rated === "got"} onClick={(e) => (mouseBlur(e), rate("got"))} disabled={!!rated && rated !== "got"}><Check size={15} /> I got it <small>+5 XP</small></button>
              <button className={rated === "review" ? "on" : ""} aria-pressed={rated === "review"} onClick={(e) => (mouseBlur(e), rate("review"))} disabled={!!rated && rated !== "review"}><RotateCcw size={14} /> Need review <small>+2 XP</small></button>
            </div>
          )}
        </>
      )}
    </>
  );
}
/* ------------------------------------------------------------------ */
/* Lesson tutor                                                         */
/* ------------------------------------------------------------------ */

function Tutor({ doc, sec, text, open, wide, msgs, setMsgs, onClose }: { doc: Doc; sec: Section; text: string; open: boolean; wide: boolean; msgs: ChatMsg[]; setMsgs: (fn: (m: ChatMsg[]) => ChatMsg[]) => void; onClose: () => void }) {
  const { settings } = useStore();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs]);
  useEffect(() => {
    if (open && wide) box.current?.focus({ preventScroll: true });
  }, [open, wide]);

  async function send(q = input) {
    q = q.trim();
    if (!q || busy) return;
    setInput("");
    if (box.current) box.current.style.height = "";
    const history = msgs;
    setMsgs((m) => [...m, { role: "user", text: q }, { role: "assistant", text: "" }]);
    setBusy(true);
    const c = new AbortController();
    ctl.current = c;
    let got = "";
    const setLast = (t: string) => setMsgs((m) => (m.length ? [...m.slice(0, -1), { role: "assistant", text: t }] : m));
    try {
      const r = await chat(settings, text, "", history, q, (t) => ((got = t), setLast(t)), { signal: c.signal, subject: doc.subject });
      setLast(r.text);
    } catch (e) {
      if (!c.signal.aborted) {
        toast((e as Error).message, "error");
        if (!got) setMsgs((m) => (m.length && m[m.length - 1].role === "assistant" && !m[m.length - 1].text ? m.slice(0, -1) : m));
      } else if (!got) setMsgs((m) => (m.length && m[m.length - 1].role === "assistant" && !m[m.length - 1].text ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  }

  const starters = ["Explain this more simply", "Give me another example", "Why does this matter?"];
  return (
    <aside className={"lt" + (open ? " open" : "")} aria-label="Lesson tutor" inert={!open}>
      <div className="lt-head">
        <b>Lesson tutor</b>
        <button className="icon-btn" aria-label="Close tutor" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="lt-body" aria-live="polite">
        {msgs.length === 0 ? (
          <div className="lt-empty">
            <Mascot size={128} mood="reading" />
            <h2>Hey! I'm reading along with you.</h2>
            <p>Ask me for help, examples, or a deeper dive.</p>
            <div className="lt-starters">{starters.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        ) : (
          <div className="lt-msgs">
            {msgs.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="lt-msg me">{m.text}</div>
              ) : (
                <div key={i} className="lt-msg ai">{m.text ? <Markdown text={m.text} /> : <span className="lt-dots" aria-label="Thinking"><i /><i /><i /></span>}</div>
              ),
            )}
            <div ref={end} />
          </div>
        )}
      </div>
      <form className="lt-form" onSubmit={(e) => (e.preventDefault(), void send())}>
        <textarea
          ref={box}
          rows={1}
          aria-label={`Ask the tutor about ${sec.title}`}
          placeholder="Ask anything…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onInput={(e) => {
            const t = e.currentTarget;
            t.style.height = "auto";
            t.style.height = Math.min(t.scrollHeight, 120) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button type="button" className="primary lt-send" aria-label="Stop" title="Stop" onClick={() => ctl.current?.abort()}><Square size={14} fill="currentColor" /></button>
        ) : (
          <button type="submit" className="primary lt-send" aria-label="Send" disabled={!input.trim()}><SendHorizontal size={16} /></button>
        )}
      </form>
    </aside>
  );
}

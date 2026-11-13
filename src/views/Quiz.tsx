import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, Sparkles, Timer, X, XCircle } from "lucide-react";
import { gradeOpen, sameAnswer } from "../lib/ai";
import { cancelJob, generateQuiz, moreQuiz } from "../lib/generate";
import { newCard } from "../lib/srs";
import { recordActivity, uid, updateDoc, useJob, useStore } from "../lib/store";
import { shuffle } from "../lib/text";
import type { Doc, QuizQ } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { Mascot } from "../components/Mascot";
import { GeneratorScreen } from "../components/GeneratorScreen";
import { toast } from "../components/feedback";
import "../styles/study.css";

type Result = { ok: boolean; score: number; msg: string };
type Answered = { q: QuizQ; res: Result };

const KIND: Record<QuizQ["kind"], string> = { mc: "Multiple choice", cloze: "Fill in the blank", open: "Explain" };

export function Quiz({ doc }: { doc: Doc }) {
  const { settings } = useStore();
  const job = useJob(doc.id + ":quiz");
  const [order, setOrder] = useState<QuizQ[]>(() => shuffle(doc.quiz));
  const [i, setI] = useState(0);
  const [val, setVal] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [answered, setAnswered] = useState<Answered[]>([]);
  const [grading, setGrading] = useState(false);
  const [timed, setTimed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [custom, setCustom] = useState(false); // the student opened the generator to add questions to an existing quiz
  const before = useRef(0);

  const q: QuizQ | undefined = order[i];
  const finished = order.length > 0 && !q;

  const restart = useCallback((qs: QuizQ[]) => (setOrder(shuffle(qs)), setI(0), setAnswered([]), setRes(null), setVal(""), setPicked(null)), []);

  // Keep the session in sync when questions are written after the tab was opened, and drop it when the quiz is cleared.
  useEffect(() => {
    if (order.length === 0 && doc.quiz.length) restart(doc.quiz);
    else if (order.length && doc.quiz.length === 0) restart([]);
  }, [doc.quiz, order.length, restart]);
  // Questions the student asked for with options: play just the new ones.
  useEffect(() => {
    if (custom && !job && doc.quiz.length > before.current) {
      setCustom(false);
      restart(doc.quiz.slice(before.current));
    }
  }, [custom, job, doc.quiz, restart]);

  const submit = useCallback(
    async (choice?: number) => {
      if (!q || res) return;
      recordActivity();
      let r: Result;
      if (q.kind === "mc") {
        const ok = choice === q.answer;
        setPicked(choice ?? -1);
        r = { ok, score: ok ? 1 : 0, msg: choice === -1 ? "Time's up. " + q.explanation : q.explanation };
      } else if (q.kind === "cloze") {
        const ok = sameAnswer(val, q.answer);
        r = { ok, score: ok ? 1 : 0, msg: ok ? "Correct." : `The answer is “${q.answer}”.` };
      } else {
        setGrading(true);
        try {
          const g = await gradeOpen(settings, q.q, q.reference, val);
          r = { ok: g.score >= 0.6, score: g.score, msg: g.feedback };
        } catch (e) {
          toast((e as Error).message, "error");
          setGrading(false);
          return;
        }
        setGrading(false);
      }
      setRes(r);
      setAnswered((a) => [...a, { q, res: r }]);
    },
    [q, res, val, settings],
  );

  const next = useCallback(() => {
    const done = i + 1 >= order.length;
    if (done) {
      const total = answered.length;
      const score = answered.reduce((a, x) => a + x.res.score, 0);
      updateDoc(doc.id, (d) => ({ quizHistory: [...d.quizHistory, { at: Date.now(), score, total }] }));
    }
    setI(i + 1);
    setVal("");
    setRes(null);
    setPicked(null);
  }, [i, order.length, answered, doc.id]);

  // Keyboard: 1-4 (or A-D) pick an option, Enter continues.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target instanceof Element ? e.target : document.body).closest("input,textarea,select")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (res && e.key === "Enter") {
        if ((e.target instanceof Element ? e.target : document.body).closest("button")) return; // the focused button handles Enter itself
        return next();
      }
      if (!res && q?.kind === "mc") {
        const n = Number(e.key) || "abcd".indexOf(e.key.toLowerCase()) + 1;
        if (n >= 1 && n <= 4) void submit(n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, res, next, submit]);

  const total = answered.reduce((a, x) => a + x.res.score, 0);
  const missed = useMemo(() => answered.filter((a) => !a.res.ok), [answered]);
  const writing = !!job && !job.error;

  async function more() {
    const extra = await moreQuiz(doc);
    if (extra.length) restart(extra);
  }

  if (!doc.quiz.length || custom)
    return (
      <div className="st-wrap">
        <GeneratorScreen
          doc={doc}
          kind="quiz"
          job={job}
          jobKey={doc.id + ":quiz"}
          onGenerate={(o) => ((before.current = doc.quiz.length), void generateQuiz(doc, o))}
          onBack={doc.quiz.length ? () => (cancelJob(doc.id + ":quiz"), setCustom(false)) : undefined}
        />
      </div>
    );

  if (finished) {
    const pct = Math.round((total / Math.max(1, answered.length)) * 100);
    const R = 54;
    const C = 2 * Math.PI * R;
    return (
      <div className="st-wrap qz qz-results">
        <Mascot size={128} mood="cheer" />
        <div className="qz-ring" role="img" aria-label={`Score ${pct} percent`}>
          <svg viewBox="0 0 128 128" width="150" height="150" aria-hidden>
            <circle cx="64" cy="64" r={R} className="qz-ring-track" />
            <circle cx="64" cy="64" r={R} className="qz-ring-val" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} transform="rotate(-90 64 64)" />
          </svg>
          <b>{pct}%</b>
        </div>
        <h2 className="qz-title">{pct >= 80 ? "Great work" : pct >= 50 ? "Getting there" : "Keep practising"}</h2>
        <p className="muted">{Math.round(total * 10) / 10} of {answered.length} correct</p>
        {doc.quizHistory.length > 1 && <p className="muted small">Previous scores: {doc.quizHistory.slice(-6, -1).map((h) => Math.round((h.score / Math.max(1, h.total)) * 100) + "%").join(" · ")}</p>}
        <div className="qz-actions">
          <button className="primary" disabled={writing} onClick={more}>{writing ? "Writing…" : "More questions"}</button>
          <button onClick={() => restart(doc.quiz)}>Retake all</button>
          {missed.length > 0 && <button onClick={() => restart(missed.map((m) => m.q))}>Retry {missed.length} missed</button>}
          {missed.length > 0 && (
            <button
              onClick={() => {
                const cards = missed.map((m) => newCard(uid(), m.q.q, m.q.kind === "mc" ? `${m.q.options[m.q.answer]}. ${m.q.explanation}` : m.q.kind === "cloze" ? m.q.answer : m.q.reference, true));
                updateDoc(doc.id, (d) => ({ cards: [...cards, ...d.cards] }));
                toast(`Added ${cards.length} flashcards from your mistakes.`, "ok");
              }}
            >
              Turn mistakes into flashcards
            </button>
          )}
          <button onClick={() => (before.current = doc.quiz.length, setCustom(true))} disabled={writing}><Sparkles size={15} /> Choose how many</button>
          {writing && <button onClick={() => cancelJob(doc.id + ":quiz")}><X size={15} /> Cancel</button>}
        </div>
        {job?.error && <p className="error-text" role="alert">{job.error}</p>}
      </div>
    );
  }
  if (!q) return null;

  return (
    <div className="st-wrap qz">
      <div className="progress-line qz-progress" role="progressbar" aria-label="Quiz progress" aria-valuemin={0} aria-valuemax={order.length} aria-valuenow={i}>
        <div style={{ width: `${(i / order.length) * 100}%` }} />
      </div>
      <div className="qz-head">
        <span className="qz-count">Question {i + 1} of {order.length}</span>
        <span className="qz-kind">{KIND[q.kind]}</span>
        <span className="spacer" />
        <label className="qz-timed">
          <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
          <span className="qz-switch" aria-hidden />
          Timed
        </label>
        {timed && !res && <Countdown key={q.id} secs={q.kind === "open" ? 90 : 30} onEnd={() => (q.kind === "mc" ? submit(-1) : submit())} />}
      </div>

      <div className="qz-card">
        <Markdown text={q.q} className="qz-q" />
        {q.kind === "mc" && (
          <div className="qz-options" role="radiogroup" aria-label="Answer options">
            {q.options.map((o, k) => {
              const right = !!res && k === q.answer;
              const wrong = !!res && picked === k && k !== q.answer;
              return (
                <button
                  key={k}
                  role="radio"
                  aria-checked={picked === k}
                  disabled={!!res}
                  className={"qz-opt" + (right ? " right" : "") + (wrong ? " wrong" : "") + (res && !right && !wrong ? " dim" : "")}
                  onClick={() => submit(k)}
                  title={`Press ${k + 1}`}
                >
                  <span className="qz-badge" aria-hidden>{right ? <Check size={16} strokeWidth={3} /> : wrong ? <X size={16} strokeWidth={3} /> : "ABCD"[k]}</span>
                  <span className="qz-opt-text"><Markdown text={o} /></span>
                  {right && <span className="qz-flag">Correct answer</span>}
                  {wrong && <span className="qz-flag">Your answer</span>}
                </button>
              );
            })}
          </div>
        )}
        {q.kind !== "mc" && (
          <div className="qz-answer">
            {q.kind === "cloze" ? (
              <input autoFocus aria-label="Your answer" placeholder="Type the missing word or phrase" value={val} disabled={!!res} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && val.trim() && !res && submit()} />
            ) : (
              <textarea autoFocus aria-label="Your answer" rows={5} placeholder="Explain in your own words…" value={val} disabled={!!res} onChange={(e) => setVal(e.target.value)} />
            )}
            {!res && (
              <button className="primary" disabled={grading || !val.trim()} onClick={() => submit()}>
                {grading ? "Grading…" : "Check answer"}
              </button>
            )}
          </div>
        )}
      </div>
      {!res && q.kind === "mc" && <p className="qz-tip">Press 1–4 to choose</p>}

      {res && (
        <div className={"qz-result " + (res.ok ? "ok" : "bad")} role="status">
          <div className="qz-result-head">{res.ok ? <CheckCircle2 size={22} /> : <XCircle size={22} />} <b>{res.ok ? "Correct" : q.kind === "open" && res.score > 0.3 ? "Partly right" : "Not quite"}</b></div>
          <Markdown text={res.msg} />
          <button className="primary" autoFocus onClick={next}>{i + 1 >= order.length ? "See results" : "Next"} <kbd>Enter</kbd></button>
        </div>
      )}
    </div>
  );
}

function Countdown({ secs, onEnd }: { secs: number; onEnd: () => void }) {
  const [t, setT] = useState(secs);
  useEffect(() => {
    if (t <= 0) return void onEnd();
    const id = setTimeout(() => setT((x) => x - 1), 1000);
    return () => clearTimeout(id);
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span className={"qz-timer" + (t <= 5 ? " urgent" : "")} role="timer"><Timer size={14} /> {t}s</span>;
}

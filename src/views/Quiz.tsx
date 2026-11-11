import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Timer, XCircle } from "lucide-react";
import { gradeOpen, sameAnswer } from "../lib/ai";
import { moreQuiz } from "../lib/generate";
import { newCard } from "../lib/srs";
import { recordActivity, uid, updateDoc, useJob, useStore } from "../lib/store";
import { shuffle } from "../lib/text";
import type { Doc, QuizQ } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { toast } from "../components/feedback";

type Result = { ok: boolean; score: number; msg: string };
type Answered = { q: QuizQ; res: Result };

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

  const q: QuizQ | undefined = order[i];
  const finished = order.length > 0 && !q;

  // Keep the session in sync when generation finishes after the tab was opened.
  useEffect(() => {
    if (order.length === 0 && doc.quiz.length) setOrder(shuffle(doc.quiz));
  }, [doc.quiz, order.length]);

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

  // Keyboard: 1-4 pick an option, Enter continues.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return;
      if (res && e.key === "Enter") return next();
      if (!res && q?.kind === "mc") {
        const n = Number(e.key);
        if (n >= 1 && n <= 4) void submit(n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, res, next, submit]);

  const restart = (qs: QuizQ[]) => (setOrder(shuffle(qs)), setI(0), setAnswered([]), setRes(null), setVal(""), setPicked(null));
  const total = answered.reduce((a, x) => a + x.res.score, 0);
  const missed = useMemo(() => answered.filter((a) => !a.res.ok), [answered]);

  async function more() {
    const extra = await moreQuiz(doc);
    if (extra.length) restart(extra);
  }

  if (!doc.quiz.length)
    return (
      <div className="empty-note">
        <p className="muted">{job ? "Writing questions…" : "No quiz questions yet."}</p>
        <button className="primary" disabled={!!job && !job.error} onClick={more}>Generate quiz</button>
      </div>
    );

  if (finished) {
    const pct = Math.round((total / Math.max(1, answered.length)) * 100);
    return (
      <div className="quiz results">
        <h2>{pct >= 80 ? "Great work" : pct >= 50 ? "Getting there" : "Keep practising"}: {pct}%</h2>
        <p className="muted">{Math.round(total * 10) / 10} of {answered.length} correct</p>
        {doc.quizHistory.length > 1 && <p className="muted small">Previous scores: {doc.quizHistory.slice(-6, -1).map((h) => Math.round((h.score / Math.max(1, h.total)) * 100) + "%").join(" · ")}</p>}
        <div className="row">
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
          <button className="primary" disabled={!!job && !job.error} onClick={more}>{job && !job.error ? "Writing…" : "More questions"}</button>
        </div>
        {job?.error && <p className="error-text">{job.error}</p>}
      </div>
    );
  }
  if (!q) return null;

  return (
    <div className="quiz">
      <div className="progress-line"><div style={{ width: `${(i / order.length) * 100}%` }} /></div>
      <div className="toolbar-row">
        <span className="muted small">Question {i + 1} of {order.length} · {q.kind === "mc" ? "multiple choice" : q.kind === "cloze" ? "fill in the blank" : "explain"}</span>
        <span className="spacer" />
        <label className="check small"><input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Timed</label>
        {timed && !res && <Countdown key={q.id} secs={q.kind === "open" ? 90 : 30} onEnd={() => (q.kind === "mc" ? submit(-1) : submit())} />}
      </div>
      <Markdown text={q.q} className="qtext" />
      {q.kind === "mc" && (
        <div className="options" role="radiogroup">
          {q.options.map((o, k) => (
            <button
              key={k}
              role="radio"
              aria-checked={picked === k}
              disabled={!!res}
              className={"option" + (res && k === q.answer ? " right" : "") + (res && picked === k && k !== q.answer ? " wrong" : "")}
              onClick={() => submit(k)}
            >
              <kbd>{k + 1}</kbd> <Markdown text={o} />
            </button>
          ))}
        </div>
      )}
      {q.kind !== "mc" && (
        <>
          {q.kind === "cloze" ? (
            <input autoFocus aria-label="Your answer" placeholder="Type the missing word or phrase" value={val} disabled={!!res} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && val.trim() && !res && submit()} />
          ) : (
            <textarea autoFocus aria-label="Your answer" rows={4} placeholder="Explain in your own words…" value={val} disabled={!!res} onChange={(e) => setVal(e.target.value)} />
          )}
          {!res && (
            <button className="primary" disabled={grading || !val.trim()} onClick={() => submit()}>
              {grading ? "Grading…" : "Check answer"}
            </button>
          )}
        </>
      )}
      {res && (
        <div className={"result " + (res.ok ? "ok" : "bad")} role="status">
          <div className="result-head">{res.ok ? <CheckCircle2 size={20} /> : <XCircle size={20} />} <b>{res.ok ? "Correct" : q.kind === "open" && res.score > 0.3 ? "Partly right" : "Not quite"}</b></div>
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
  return <span className={"timer" + (t <= 5 ? " urgent" : "")}><Timer size={14} /> {t}s</span>;
}

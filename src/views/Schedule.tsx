import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, Download, Eraser, Loader2, RotateCcw, Sparkles, Square } from "lucide-react";
import { Mascot } from "../components/Mascot";
import { confirmDialog, toast } from "../components/feedback";
import { hasLLM } from "../lib/llm";
import { shortDate } from "../lib/planTime";
import { SAVE_KEY, fromMin, loadSaved, makePlan, save, toMin } from "../lib/schedule";
import type { Plan, PlanKind } from "../lib/schedule";
import { planHasUnsupportedText, savePlanPdf } from "../lib/schedulePdf";
import { useStore } from "../lib/store";
import "../styles/schedule.css";

const KIND_LABEL: Record<PlanKind, string> = { learn: "Learn", practice: "Practice", revise: "Revise", test: "Test" };

/** Study planner: one box for the student's request. The AI writes the plan from it. */
export function Schedule() {
  const { settings } = useStore();
  const saved = useMemo(() => loadSaved(), []);
  const [text, setText] = useState(saved?.text ?? "");
  const [plan, setPlan] = useState<Plan | null>(saved?.plan ?? null);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  /** what the last change replaced: the text and plan as they were before it */
  const [undo, setUndo] = useState<{ text: string; plan: Plan | null; what: string } | null>(null);
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => save(text, plan), [text, plan]);
  useEffect(() => () => ctl.current?.abort(), []);

  const dirty = !!plan || !!text.trim();
  const keyOk = hasLLM(settings);

  async function clearAll() {
    if (busy) ctl.current?.abort();
    if (dirty && !(await confirmDialog("Clear the planner?", "This removes your text and the plan on screen. You can undo this once.", "Clear", true))) return;
    setUndo({ text, plan, what: "clear" });
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* storage blocked */
    }
    setText("");
    setPlan(null);
    toast("Planner cleared. Undo brings it back.", "ok");
  }

  async function generate() {
    if (busy || !text.trim()) return;
    setBusy(true);
    const c = new AbortController();
    ctl.current = c;
    try {
      const p = await makePlan(settings, text, { signal: c.signal });
      setUndo({ text, plan, what: "new plan" });
      setPlan(p);
    } catch (e) {
      if (!c.signal.aborted) toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  }

  function undoLast() {
    if (!undo) return;
    setText(undo.text);
    setPlan(undo.plan);
    setUndo(null);
    toast("Undone", "ok");
  }

  async function download() {
    if (!plan || pdfBusy) return;
    setPdfBusy(true);
    try {
      const name = await savePlanPdf(plan);
      if (name) toast(`Saved ${name}`, "ok");
    } catch (e) {
      toast((e as Error).message || "Couldn't make the PDF.", "error");
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="page sc">
      <header className="sc-head">
        <Mascot size={84} mood="reading" />
        <div>
          <h1>Study planner</h1>
          <p className="muted">Type what you need to study and when. The AI writes the plan, and you can download it as a PDF.</p>
        </div>
      </header>

      <div className="sc-grid">
        <form className="sc-form" onSubmit={(e) => (e.preventDefault(), void generate())} aria-label="Your request">
          <div className="sc-form-head">
            <h2>Your request</h2>
            <div className="sc-form-btns">
              {undo && (
                <button type="button" className="sc-clear" onClick={undoLast} title={`Undo the last ${undo.what}`}><RotateCcw size={15} aria-hidden /> Undo</button>
              )}
              <button type="button" className="sc-clear" onClick={() => void clearAll()} disabled={!dirty && !busy}><Eraser size={15} aria-hidden /> Clear</button>
            </div>
          </div>
          <textarea
            className="sc-big"
            aria-label="What do you need to study, and when?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type anything: what you need to study, your exam date, when you're free, anything that's already booked."
          />
          {busy ? (
            <button type="button" className="primary sc-go" onClick={() => ctl.current?.abort()}><Square size={14} fill="currentColor" /> Stop</button>
          ) : (
            <button type="submit" className="primary sc-go" disabled={!text.trim() || !keyOk}><Sparkles size={16} /> {plan ? "Make a new plan" : "Build my plan"}</button>
          )}
          {!keyOk && <p className="sc-hint muted">The planner needs an AI key. Add one in Settings.</p>}
        </form>

        <section className="sc-out" aria-live="polite" aria-busy={busy}>
          {busy ? (
            <div className="sc-empty">
              <Loader2 size={30} className="spin" aria-hidden />
              <h2>Planning your days…</h2>
              <p className="muted">The AI is writing the plan. This can take up to a minute.</p>
            </div>
          ) : !plan ? (
            <div className="sc-empty">
              <CalendarDays size={34} aria-hidden />
              <h2>Your plan shows up here</h2>
              <p className="muted">Type your request on the left and press Build my plan.</p>
            </div>
          ) : (
            <PlanView plan={plan} pdfBusy={pdfBusy} onPdf={download} onAgain={generate} canAgain={!!text.trim() && keyOk} />
          )}
        </section>
      </div>
    </div>
  );
}

function PlanView({ plan, pdfBusy, onPdf, onAgain, canAgain }: { plan: Plan; pdfBusy: boolean; onPdf: () => void; onAgain: () => void; canAgain: boolean }) {
  const sessions = plan.days.reduce((n, d) => n + (d.sessions?.length ?? 0), 0);
  const mins = plan.days.reduce((n, d) => n + (d.sessions ?? []).reduce((a, s) => a + (Number(s.minutes) || 0), 0), 0);
  const hours = Math.round((mins / 60) * 10) / 10;
  return (
    <>
      <div className="sc-result-head">
        <div>
          <h2>{plan.title}</h2>
          <p className="muted">{plan.days.length} {plan.days.length === 1 ? "day" : "days"} · {sessions} {sessions === 1 ? "session" : "sessions"} · {hours} {hours === 1 ? "hour" : "hours"}</p>
        </div>
        <div className="sc-actions">
          <button className="primary" onClick={onPdf} disabled={pdfBusy}>{pdfBusy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} Download PDF</button>
          <button onClick={onAgain} disabled={!canAgain} title="Ask the AI for a different plan from the same text"><RotateCcw size={14} /> Regenerate</button>
        </div>
      </div>
      {planHasUnsupportedText(plan) && <p className="sc-note" role="note">The PDF font covers Latin scripts only. Other scripts will print as “?”.</p>}
      {plan.summary && <p className="sc-summary">{plan.summary}</p>}
      <ol className="sc-days-list">
        {plan.days.map((d) => (
          <li key={d.date} className="sc-day">
            <div className="sc-date"><b>{shortDate(d.date).split(" ").slice(0, 2).join(" ")}</b><span>{shortDate(d.date).split(" ").slice(2).join(" ")}</span></div>
            <ul>
              {(d.sessions ?? []).map((s, i) => (
                <li key={i}>
                  <span className="sc-time">
                    {s.start}–{fromMin(toMin(s.start) + Number(s.minutes))}
                    {s.late && <sup className="sc-late" title="After midnight, still part of this study day">+1</sup>}
                  </span>
                  <div>
                    <b>{s.topic}</b>
                    <p>{s.task}</p>
                  </div>
                  <span className={"sc-kind " + s.kind}>{KIND_LABEL[s.kind] ?? s.kind}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {!!plan.tips?.length && (
        <div className="sc-tips">
          <h3><Check size={16} aria-hidden /> Tips for this plan</h3>
          <ul>{plan.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
    </>
  );
}

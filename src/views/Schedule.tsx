import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, Clock, Download, Loader2, Plus, RotateCcw, Sparkles, Square, Trash2 } from "lucide-react";
import { Mascot } from "../components/Mascot";
import { toast } from "../components/feedback";
import { hasLLM } from "../lib/llm";
import { DAY_NAMES, addDays, defaultForm, formProblem, fromMin, isoDay, loadSaved, makePlan, nowStamp, save, shortDate, slotsFor, toMin } from "../lib/schedule";
import type { Confidence, Plan, PlanForm, PlanKind } from "../lib/schedule";
import { planHasUnsupportedText, savePlanPdf } from "../lib/schedulePdf";
import { useStore } from "../lib/store";
import "../styles/schedule.css";

const LEVELS: { id: Confidence; label: string }[] = [
  { id: "weak", label: "Weak" },
  { id: "ok", label: "OK" },
  { id: "strong", label: "Strong" },
];
const SESSIONS = [25, 45, 60, 90];
const RANGES = [
  { label: "1 week", days: 6 },
  { label: "2 weeks", days: 13 },
  { label: "1 month", days: 29 },
];
const KIND_LABEL: Record<PlanKind, string> = { learn: "Learn", practice: "Practice", revise: "Revise", test: "Test" };

/** Study planner: a short form, an AI-built day-by-day plan, and a one-click PDF. */
export function Schedule() {
  const { settings, docs } = useStore();
  const saved = useMemo(() => loadSaved(), []);
  const [form, setForm] = useState<PlanForm>(() => saved?.form ?? defaultForm());
  const [plan, setPlan] = useState<Plan | null>(saved?.plan ?? null);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const [, tick] = useState(0);

  useEffect(() => save(form, plan), [form, plan]);
  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000); // keep the "now" line honest while the page is open
    return () => clearInterval(t);
  }, []);

  const now = new Date();
  const today = isoDay(now);
  const problem = formProblem(form, now);
  const slots = problem ? [] : slotsFor(form, now);
  const set = (p: Partial<PlanForm>) => setForm((f) => ({ ...f, ...p }));
  const setTopic = (i: number, p: Partial<PlanForm["topics"][number]>) => setForm((f) => ({ ...f, topics: f.topics.map((t, k) => (k === i ? { ...t, ...p } : t)) }));
  const lessons = docs.filter((d) => !form.topics.some((t) => t.name.trim().toLowerCase() === d.title.trim().toLowerCase())).slice(0, 8);

  async function generate() {
    if (busy || problem) return;
    setBusy(true);
    const c = new AbortController();
    ctl.current = c;
    try {
      const p = await makePlan(settings, { ...form, start: form.start < today ? today : form.start }, { signal: c.signal });
      setPlan(p);
    } catch (e) {
      if (!c.signal.aborted) toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      ctl.current = null;
    }
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
          <p className="muted">Say what you need to study and when. TurboGoo builds a day-by-day plan around your time, then turns it into a clean PDF.</p>
        </div>
      </header>

      <div className="sc-grid">
        <form className="sc-form" onSubmit={(e) => (e.preventDefault(), void generate())} aria-label="Plan details">
          <section>
            <label className="sc-label" htmlFor="sc-goal">Goal <span className="sc-opt">optional</span></label>
            <input id="sc-goal" value={form.goal} placeholder="e.g. Class 10 pre-boards" maxLength={80} onChange={(e) => set({ goal: e.target.value })} />
          </section>

          <section>
            <span className="sc-label" id="sc-topics-l">What do you need to study?</span>
            <div className="sc-topics" role="group" aria-labelledby="sc-topics-l">
              {form.topics.map((t, i) => (
                <div className="sc-topic" key={i}>
                  <input aria-label={`Subject or topic ${i + 1}`} value={t.name} placeholder={i === 0 ? "e.g. Quadratic equations" : "Another subject or topic"} maxLength={80} onChange={(e) => setTopic(i, { name: e.target.value })} />
                  <div className="sc-seg" role="radiogroup" aria-label={`How confident are you in ${t.name || "this topic"}?`}>
                    {LEVELS.map((l) => (
                      <button type="button" key={l.id} role="radio" aria-checked={t.level === l.id} className={t.level === l.id ? "on " + l.id : ""} onClick={() => setTopic(i, { level: l.id })}>{l.label}</button>
                    ))}
                  </div>
                  {form.topics.length > 1 && (
                    <button type="button" className="icon-btn" aria-label={`Remove ${t.name || "topic " + (i + 1)}`} onClick={() => set({ topics: form.topics.filter((_, k) => k !== i) })}><Trash2 size={16} /></button>
                  )}
                </div>
              ))}
            </div>
            <div className="sc-addrow">
              <button type="button" className="sc-add" disabled={form.topics.length >= 12} onClick={() => set({ topics: [...form.topics, { name: "", level: "ok" }] })}><Plus size={15} /> Add another</button>
              {lessons.map((d) => (
                <button type="button" key={d.id} className="chip sc-lesson" title="Add from your lessons" onClick={() => set({ topics: [...form.topics.filter((t) => t.name.trim()), { name: d.title.slice(0, 80), level: "ok" }] })}>
                  <Plus size={12} /> {d.title.length > 28 ? d.title.slice(0, 27) + "…" : d.title}
                </button>
              ))}
            </div>
          </section>

          <section className="sc-two">
            <div>
              <label className="sc-label" htmlFor="sc-start">Start</label>
              <input id="sc-start" type="date" min={today} value={form.start < today ? today : form.start} onChange={(e) => e.target.value && set({ start: e.target.value })} />
            </div>
            <div>
              <label className="sc-label" htmlFor="sc-end">Exam or deadline</label>
              <input id="sc-end" type="date" min={today} value={form.end} onChange={(e) => e.target.value && set({ end: e.target.value })} />
            </div>
            <div className="sc-quick" role="group" aria-label="Quick deadline">
              {RANGES.map((r) => (
                <button type="button" key={r.label} className="chip" onClick={() => set({ end: addDays(form.start < today ? today : form.start, r.days) })}>{r.label}</button>
              ))}
            </div>
          </section>

          <section>
            <span className="sc-label" id="sc-days-l">Days you can study</span>
            <div className="sc-days" role="group" aria-labelledby="sc-days-l">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button type="button" key={d} aria-pressed={form.weekdays.includes(d)} className={form.weekdays.includes(d) ? "on" : ""} onClick={() => set({ weekdays: form.weekdays.includes(d) ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d] })}>{DAY_NAMES[d]}</button>
              ))}
            </div>
          </section>

          <section className="sc-three">
            <div>
              <label className="sc-label" htmlFor="sc-from">Start time</label>
              <input id="sc-from" type="time" value={form.from} onChange={(e) => e.target.value && set({ from: e.target.value })} />
            </div>
            <div>
              <label className="sc-label" htmlFor="sc-hours">Hours per day</label>
              <div className="sc-step">
                <button type="button" aria-label="Fewer hours" disabled={form.hours <= 0.5} onClick={() => set({ hours: Math.max(0.5, form.hours - 0.5) })}>−</button>
                <output id="sc-hours" aria-live="polite">{form.hours}</output>
                <button type="button" aria-label="More hours" disabled={form.hours >= 10} onClick={() => set({ hours: Math.min(10, form.hours + 0.5) })}>+</button>
              </div>
            </div>
            <div>
              <span className="sc-label" id="sc-sess-l">Session length</span>
              <div className="sc-seg wide" role="radiogroup" aria-labelledby="sc-sess-l">
                {SESSIONS.map((m) => (
                  <button type="button" key={m} role="radio" aria-checked={form.session === m} className={form.session === m ? "on" : ""} onClick={() => set({ session: m })}>{m}m</button>
                ))}
              </div>
            </div>
          </section>

          <section>
            <label className="sc-label" htmlFor="sc-notes">Anything else? <span className="sc-opt">optional</span></label>
            <textarea id="sc-notes" rows={3} maxLength={600} value={form.notes} placeholder="e.g. Maths is my weakest. Tuition on Tuesdays. I want Sundays lighter." onChange={(e) => set({ notes: e.target.value })} />
          </section>

          <p className="sc-now" role="status">
            <Clock size={14} aria-hidden /> It's {nowStamp(now).replace(/ \(.*$/, "")}. {problem ? problem : `${slots.length} study day${slots.length === 1 ? "" : "s"} available${slots[0]?.date === today ? `, starting today at ${fromMin(slots[0].startMin)}` : ""}.`}
          </p>

          {busy ? (
            <button type="button" className="primary sc-go" onClick={() => ctl.current?.abort()}><Square size={14} fill="currentColor" /> Stop</button>
          ) : (
            <button type="submit" className="primary sc-go" disabled={!!problem}><Sparkles size={16} /> {plan ? "Make a new plan" : "Build my plan"}</button>
          )}
          {!hasLLM(settings) && <p className="sc-hint muted">No AI key yet: plans come from a simple built-in planner. Add a key in Settings for a smarter one.</p>}
        </form>

        <section className="sc-out" aria-live="polite" aria-busy={busy}>
          {busy ? (
            <div className="sc-empty">
              <Loader2 size={30} className="spin" aria-hidden />
              <h2>Planning your days…</h2>
              <p className="muted">Fitting your topics into the time you have. This usually takes 10 to 30 seconds.</p>
            </div>
          ) : !plan ? (
            <div className="sc-empty">
              <CalendarDays size={34} aria-hidden />
              <h2>Your plan shows up here</h2>
              <p className="muted">Fill in the form and press Build my plan. You can download it as a PDF to print or keep on your phone.</p>
            </div>
          ) : (
            <PlanView plan={plan} pdfBusy={pdfBusy} onPdf={download} onAgain={generate} canAgain={!problem} />
          )}
        </section>
      </div>
    </div>
  );
}

function PlanView({ plan, pdfBusy, onPdf, onAgain, canAgain }: { plan: Plan; pdfBusy: boolean; onPdf: () => void; onAgain: () => void; canAgain: boolean }) {
  const sessions = plan.days.reduce((n, d) => n + d.sessions.length, 0);
  const mins = plan.days.reduce((n, d) => n + d.sessions.reduce((a, s) => a + s.minutes, 0), 0);
  return (
    <>
      <div className="sc-result-head">
        <div>
          <h2>{plan.title}</h2>
          <p className="muted">{plan.days.length} days · {sessions} sessions · {Math.round((mins / 60) * 10) / 10} hours</p>
        </div>
        <div className="sc-actions">
          <button className="primary" onClick={onPdf} disabled={pdfBusy}>{pdfBusy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} Download PDF</button>
          <button onClick={onAgain} disabled={!canAgain} title="Build a different plan from the same details"><RotateCcw size={14} /> Regenerate</button>
        </div>
      </div>
      {plan.note && <p className="sc-note" role="note">{plan.note}</p>}
      {planHasUnsupportedText(plan) && <p className="sc-note" role="note">The PDF font covers Latin scripts only. Other scripts will print as “?”.</p>}
      {plan.summary && <p className="sc-summary">{plan.summary}</p>}
      <ol className="sc-days-list">
        {plan.days.map((d) => (
          <li key={d.date} className="sc-day">
            <div className="sc-date"><b>{shortDate(d.date).split(" ").slice(0, 2).join(" ")}</b><span>{shortDate(d.date).split(" ").slice(2).join(" ")}</span></div>
            <ul>
              {d.sessions.map((s, i) => (
                <li key={i}>
                  <span className="sc-time">{s.start}–{fromMin(toMin(s.start) + s.minutes)}</span>
                  <div>
                    <b>{s.topic}</b>
                    <p>{s.task}</p>
                  </div>
                  <span className={"sc-kind " + s.kind}>{KIND_LABEL[s.kind]}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {!!plan.tips.length && (
        <div className="sc-tips">
          <h3><Check size={16} aria-hidden /> Tips for this plan</h3>
          <ul>{plan.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
    </>
  );
}

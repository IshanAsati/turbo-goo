import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, Clock, Download, Eraser, Loader2, Moon, Plus, RotateCcw, Sparkles, Square, Trash2 } from "lucide-react";
import { Mascot } from "../components/Mascot";
import { PlanLogPanel } from "../components/PlanLogPanel";
import { confirmDialog, toast } from "../components/feedback";
import { hasLLM } from "../lib/llm";
import { DAY_NAMES, SAVE_KEY, addDays, crossesMidnight, defaultForm, describeForm, formProblem, fromMin, isoDay, loadSaved, makePlan, nowStamp, save, shortDate, slotsFor, toMin } from "../lib/schedule";
import type { Busy, Confidence, Plan, PlanForm, PlanKind, PlanTopic } from "../lib/schedule";
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
  { label: "1 day", days: 0 },
  { label: "1 week", days: 6 },
  { label: "2 weeks", days: 13 },
  { label: "1 month", days: 29 },
];
const BUSY_DAYS: { id: string; label: string; days: number[] }[] = [
  { id: "all", label: "Every day", days: [] },
  { id: "wk", label: "Mon to Fri", days: [1, 2, 3, 4, 5] },
  { id: "we", label: "Weekends", days: [0, 6] },
  ...[1, 2, 3, 4, 5, 6, 0].map((d) => ({ id: "d" + d, label: ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][d], days: [d] })),
  { id: "date", label: "Only on a date", days: [] },
];
const busyId = (b: Busy) => (b.date !== undefined ? "date" : BUSY_DAYS.find((o) => o.days.length === b.days.length && o.days.every((d) => b.days.includes(d)))?.id ?? "all");
const KIND_LABEL: Record<PlanKind, string> = { learn: "Learn", practice: "Practice", revise: "Revise", test: "Test" };

/** A length in a topic name ("3 hours", "2.5 hrs", "90 min") as minutes, when it is one the form accepts (15-360). */
function durationIn(name: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?)\b/i.exec(name);
  if (!m) return undefined;
  const n = Math.round(Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1));
  return n >= 15 && n <= 360 ? n : undefined;
}

/** Study planner: a short form, an AI-built day-by-day plan, and a one-click PDF. */
export function Schedule() {
  const { settings, docs } = useStore();
  const saved = useMemo(() => loadSaved(), []);
  const [form, setForm] = useState<PlanForm>(() => saved?.form ?? defaultForm());
  const [plan, setPlan] = useState<Plan | null>(saved?.plan ?? null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
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
  const startDay = form.start < today ? today : form.start;
  const set = (p: Partial<PlanForm>) => setForm((f) => ({ ...f, ...p }));
  const setTopic = (i: number, p: Partial<PlanTopic>) => setForm((f) => ({ ...f, topics: f.topics.map((t, k) => (k === i ? { ...t, ...p } : t)) }));
  // Typing a duration in the name ("Science sample paper (3 hours)") fills the fixed length, unless the student already set one.
  const setTopicName = (i: number, name: string) =>
    setForm((f) => ({ ...f, topics: f.topics.map((t, k) => (k === i ? { ...t, name, minutes: t.minutes === undefined ? durationIn(name) : t.minutes } : t)) }));
  const lessons = docs.filter((d) => !form.topics.some((t) => t.name.trim().toLowerCase() === d.title.trim().toLowerCase())).slice(0, 8);

  const setBusy_ = (i: number, p: Partial<Busy>) => setForm((f) => ({ ...f, busy: f.busy.map((b, k) => (k === i ? { ...b, ...p } : b)) }));
  const dirty = !!plan || form.topics.some((t) => t.name.trim()) || !!form.goal.trim() || !!form.notes.trim() || form.busy.length > 0;

  async function clearAll() {
    if (busy) ctl.current?.abort();
    if (dirty && !(await confirmDialog("Clear the planner?", "This removes your inputs and the plan on screen. A PDF you already saved is not affected.", "Clear", true))) return;
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* storage blocked */
    }
    setForm(defaultForm());
    setPlan(null);
    toast("Planner cleared", "ok");
  }

  async function generate() {
    if (busy || problem) return;
    setBusy(true);
    setStep("");
    const c = new AbortController();
    ctl.current = c;
    try {
      const p = await makePlan(settings, { ...form, start: startDay }, { signal: c.signal, onStep: setStep });
      // busy times found in the notes join the form, so the student can see and edit them
      const added = p.addedBusy ?? [];
      if (added.length) setForm((f) => ({ ...f, busy: [...f.busy, ...added] }));
      setPlan(p);
    } catch (e) {
      if (!c.signal.aborted) toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      setStep("");
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
          <div className="sc-form-head">
            <h2>Your details</h2>
            <button type="button" className="sc-clear" onClick={() => void clearAll()} disabled={!dirty && !busy}><Eraser size={15} aria-hidden /> Clear</button>
          </div>
          <section>
            <label className="sc-label" htmlFor="sc-goal">Goal <span className="sc-opt">optional</span></label>
            <input id="sc-goal" value={form.goal} placeholder="e.g. Class 10 pre-boards" maxLength={80} onChange={(e) => set({ goal: e.target.value })} />
          </section>

          <section>
            <span className="sc-label" id="sc-topics-l">What do you need to study?</span>
            <div className="sc-topics" role="group" aria-labelledby="sc-topics-l">
              {form.topics.map((t, i) => {
                const name = t.name || "topic " + (i + 1);
                return (
                  <div className="sc-topic" key={i}>
                    <input aria-label={`Subject or topic ${i + 1}`} value={t.name} placeholder={i === 0 ? "e.g. Quadratic equations" : "Another subject or topic"} maxLength={80} onChange={(e) => setTopicName(i, e.target.value)} />
                    <div className="sc-seg" role="radiogroup" aria-label={`How confident are you in ${t.name || "this topic"}?`}>
                      {LEVELS.map((l) => (
                        <button type="button" key={l.id} role="radio" aria-checked={t.level === l.id} className={t.level === l.id ? "on " + l.id : ""} onClick={() => setTopic(i, { level: l.id })}>{l.label}</button>
                      ))}
                    </div>
                    {form.topics.length > 1 && (
                      <button type="button" className="icon-btn" aria-label={`Remove ${t.name || "topic " + (i + 1)}`} onClick={() => set({ topics: form.topics.filter((_, k) => k !== i) })}><Trash2 size={16} /></button>
                    )}
                    <div className="sc-len">
                      <div className="sc-len-row">
                        <span className="sc-len-l">Fixed length</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={15}
                          max={360}
                          step={15}
                          placeholder="flexible"
                          aria-label={`Fixed length in minutes for ${name}`}
                          value={t.minutes ?? ""}
                          onChange={(e) => setTopic(i, { minutes: e.target.value === "" || !Number.isFinite(Number(e.target.value)) ? undefined : Number(e.target.value) })}
                          onBlur={() => t.minutes !== undefined && setTopic(i, { minutes: Math.min(360, Math.max(15, Math.round(t.minutes))) })}
                        />
                        <span className="sc-len-u muted">min</span>
                      </div>
                      {t.minutes !== undefined && <p className="sc-len-hint">One block of {t.minutes} min</p>}
                    </div>
                  </div>
                );
              })}
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
              <input id="sc-start" type="date" min={today} value={startDay} onChange={(e) => e.target.value && set({ start: e.target.value })} />
            </div>
            <div>
              <label className="sc-label" htmlFor="sc-end">Exam or deadline</label>
              <input id="sc-end" type="date" min={today} value={form.end} onChange={(e) => e.target.value && set({ end: e.target.value })} />
            </div>
            <div className="sc-quick" role="group" aria-label="Quick deadline">
              {RANGES.map((r) => {
                const on = addDays(startDay, r.days) === form.end;
                return (
                  <button type="button" key={r.label} className={"chip" + (on ? " on" : "")} aria-pressed={on} onClick={() => set({ end: addDays(startDay, r.days) })}>{r.label}</button>
                );
              })}
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
              <label className="sc-label" htmlFor="sc-to">End time</label>
              <input id="sc-to" type="time" value={form.to} onChange={(e) => e.target.value && set({ to: e.target.value })} />
            </div>
            <p className={"sc-timehint" + (crossesMidnight(form) ? " night" : "")} id="sc-timehint">
              {crossesMidnight(form) ? <><Moon size={13} aria-hidden /> Sessions can run past midnight, until {form.to} the next morning.</> : <>Nothing is scheduled outside {form.from}–{form.to}. For a late night, set an end time after midnight (like 02:00).</>}
            </p>
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
            <span className="sc-label" id="sc-busy-l">Busy times <span className="sc-opt">never scheduled over</span></span>
            <div className="sc-busy" role="group" aria-labelledby="sc-busy-l">
              {form.busy.map((b, i) => {
                const overnight = toMin(b.to) < toMin(b.from);
                return (
                  <div className="sc-busy-row" key={i}>
                    <input aria-label={`Busy block ${i + 1} name`} value={b.label} maxLength={40} placeholder="e.g. Physics tuition" onChange={(e) => setBusy_(i, { label: e.target.value })} />
                    <select
                      aria-label="Which days"
                      value={busyId(b)}
                      onChange={(e) => {
                        const o = BUSY_DAYS.find((x) => x.id === e.target.value);
                        setBusy_(i, e.target.value === "date" ? { days: [], date: b.date ?? today } : { days: o?.days ?? [], date: undefined });
                      }}
                    >
                      {BUSY_DAYS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <input aria-label="Busy from" type="time" value={b.from} onChange={(e) => e.target.value && setBusy_(i, { from: e.target.value })} />
                    <input aria-label="Busy until" type="time" value={b.to} onChange={(e) => e.target.value && setBusy_(i, { to: e.target.value })} />
                    <button type="button" className="icon-btn" aria-label={`Remove ${b.label || "busy block " + (i + 1)}`} onClick={() => set({ busy: form.busy.filter((_, k) => k !== i) })}><Trash2 size={16} /></button>
                    {(b.date !== undefined || overnight || b.auto) && (
                      <div className="sc-busy-meta">
                        {b.date !== undefined && <input type="date" aria-label={`Date for ${b.label || "busy block " + (i + 1)}`} value={b.date} onChange={(e) => e.target.value && setBusy_(i, { date: e.target.value })} />}
                        {overnight && <span className="sc-tag">overnight</span>}
                        {b.auto && <span className="sc-tag auto">from your notes</span>}
                      </div>
                    )}
                  </div>
                );
              })}
              <button type="button" className="sc-add" disabled={form.busy.length >= 8} onClick={() => set({ busy: [...form.busy, { label: "", days: [], from: "16:00", to: "17:00" }] })}><Plus size={15} /> Add a busy time</button>
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
              <p className="muted">{step || "Fitting your topics into the time you have. This usually takes 10 to 30 seconds."}</p>
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
  const problems = plan.problems ?? [];
  const warnings = plan.warnings ?? [];
  const tries = plan.attempts;
  const checked = !tries
    ? ""
    : problems.length
      ? `Checked: ${problems.length} ${problems.length === 1 ? "problem" : "problems"} left after ${tries} ${tries === 1 ? "try" : "tries"}`
      : `Checked: passed on try ${tries}`;
  return (
    <>
      <div className="sc-result-head">
        <div>
          <h2>{plan.title}</h2>
          <p className="muted">{plan.days.length} {plan.days.length === 1 ? "day" : "days"} · {sessions} {sessions === 1 ? "session" : "sessions"} · {Math.round((mins / 60) * 10) / 10} {Math.round((mins / 60) * 10) / 10 === 1 ? "hour" : "hours"}</p>
          {checked && <p className={"sc-checked" + (problems.length ? " bad" : "")}>{checked}</p>}
        </div>
        <div className="sc-actions">
          <button className="primary" onClick={onPdf} disabled={pdfBusy}>{pdfBusy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} Download PDF</button>
          <button onClick={onAgain} disabled={!canAgain} title="Build a different plan from the same details"><RotateCcw size={14} /> Regenerate</button>
        </div>
      </div>
      {!!plan.used?.length && <ul className="sc-used" aria-label="This plan was built around">{plan.used.map((u, i) => <li key={i}>{u}</li>)}</ul>}
      {plan.note && <p className="sc-note" role="note">{plan.note}</p>}
      {planHasUnsupportedText(plan) && <p className="sc-note" role="note">The PDF font covers Latin scripts only. Other scripts will print as “?”.</p>}
      {!!warnings.length && (
        <div className="sc-box" role="note">
          <h3>Before you start</h3>
          <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      {!!problems.length && (
        <div className="sc-box bad" role="note">
          <h3>Check these</h3>
          <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {plan.summary && <p className="sc-summary">{plan.summary}</p>}
      <ol className="sc-days-list">
        {plan.days.map((d) => (
          <li key={d.date} className="sc-day">
            <div className="sc-date"><b>{shortDate(d.date).split(" ").slice(0, 2).join(" ")}</b><span>{shortDate(d.date).split(" ").slice(2).join(" ")}</span></div>
            <ul>
              {d.sessions.map((s, i) => (
                <li key={i}>
                  <span className="sc-time">
                    {s.start}–{fromMin(toMin(s.start) + s.minutes)}
                    {s.late && <sup className="sc-late" title="After midnight, still part of this study day">+1</sup>}
                    {s.issue && <span className="sc-flag" title={s.issue} aria-hidden>!</span>}
                  </span>
                  <div>
                    <b>{s.topic}</b>
                    <p>{s.task}</p>
                    {s.issue && <p className="sc-issue">{s.issue}</p>}
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
      {plan.logId && <PlanLogPanel logId={plan.logId} />}
    </>
  );
}

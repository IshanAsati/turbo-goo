/**
 * "What the AI returned": the saved planner log for one plan, with a Copy button.
 */
import { Copy } from "lucide-react";
import { getLog, logText, TRIES } from "../lib/planLog";
import { toast } from "./feedback";
import "../styles/planlog.css";

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

export function PlanLogPanel({ logId }: { logId: string }) {
  const log = getLog(logId);
  if (!log) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logText(log));
      toast("Log copied", "ok");
    } catch {
      toast("Couldn't copy the log. The browser blocked clipboard access.", "error");
    }
  };

  return (
    <details className="pl">
      <summary>What the AI returned</summary>
      <div className="pl-body">
        <div className="pl-top">
          <div>
            <p className="pl-outcome">{log.outcome || "No outcome was recorded."}</p>
            <p className="pl-meta">
              {log.model} · {new Date(log.at).toLocaleString()}
            </p>
          </div>
          <button type="button" className="pl-copy" onClick={copy}>
            <Copy size={14} aria-hidden="true" /> Copy log
          </button>
        </div>

        {log.notes && (
          <section className="pl-attempt" aria-label="Reading the notes">
            <h4>Reading the notes</h4>
            {log.notes.error && <p className="pl-error">{log.notes.error}</p>}
            <pre tabIndex={0} aria-label="Raw reply from reading the notes">
              {log.notes.reply || "(empty reply)"}
            </pre>
          </section>
        )}

        {log.attempts.map((a, i) => (
          <section key={i} className="pl-attempt" aria-label={`Attempt ${i + 1}`}>
            <h4>
              Attempt {i + 1} of {TRIES} · {secs(a.ms)}
              {i === log.chosen && <span className="pl-shown">Shown in the plan</span>}
            </h4>
            {a.error && <p className="pl-error">{a.error}</p>}
            {a.problems.length ? (
              <ul className="pl-problems">
                {a.problems.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            ) : (
              !a.error && <p className="pl-ok">No problems found</p>
            )}
            <pre tabIndex={0} aria-label={`Raw reply, attempt ${i + 1}`}>
              {a.reply || "(empty reply)"}
            </pre>
          </section>
        ))}
      </div>
    </details>
  );
}

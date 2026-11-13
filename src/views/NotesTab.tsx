import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertCircle, Bold, Code2, Columns2, Download, Eye, FileText, Heading2, Highlighter, Image as ImageIcon, Italic, Lightbulb, List, MessageCircleQuestion,
  Minus, Pencil, Plus, Quote, Sigma, Sparkles, Table2, Target, Underline, X,
} from "lucide-react";
import { annotate, type Annotation } from "../lib/ai";
import { hasLLM } from "../lib/llm";
import { updateDoc, useStore } from "../lib/store";
import type { Doc } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { toast } from "../components/feedback";
import "../styles/notes.css";

type Mode = "preview" | "edit" | "split";

const SIZE_KEY = "turbogoo:notes-size";
const SIZE_MIN = 12;
const SIZE_MAX = 28;
const readSize = () => {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return n >= SIZE_MIN && n <= SIZE_MAX ? n : 16;
  } catch {
    return 16;
  }
};

function F({ label, onClick, children, disabled }: { label: string; onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button className="nt-btn" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>
  );
}

/** Notes: a formatting toolbar, then the document as a wide reading column (or the Markdown editor). `trailing` is the page-level Chat toggle and ⋮ menu. */
export function NotesTab({ doc, generating, onAsk, trailing }: { doc: Doc; generating: boolean; onAsk: (q: string) => void; trailing?: ReactNode }) {
  const { settings } = useStore();
  const [mode, setMode] = useState<Mode>("preview");
  const [size, setSize] = useState(readSize);
  const [review, setReview] = useState(false);
  const [ann, setAnn] = useState<Annotation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const empty = !doc.notes.trim();
  const words = useMemo(() => (doc.notes.match(/\S+/g) ?? []).length, [doc.notes]);

  const edit = (v: string) => updateDoc(doc.id, { notes: v });
  const resize = (n: number) => {
    const v = Math.min(SIZE_MAX, Math.max(SIZE_MIN, n));
    setSize(v);
    try {
      localStorage.setItem(SIZE_KEY, String(v));
    } catch {
      /* private mode: the size just won't persist */
    }
  };

  /** Wrap the current selection (or insert a placeholder) with markdown syntax. */
  function wrap(before: string, after = before, placeholder = "text", linePrefix = false) {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const chosen = value.slice(a, b) || placeholder;
    let next: string;
    let from: number;
    if (linePrefix) {
      const start = value.lastIndexOf("\n", a - 1) + 1;
      next = value.slice(0, start) + before + value.slice(start);
      from = a + before.length;
    } else {
      next = value.slice(0, a) + before + chosen + after + value.slice(b);
      from = a + before.length;
    }
    edit(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from, linePrefix ? from : from + chosen.length);
    });
  }
  /** Formatting needs the editor: from Read mode, open Split first and then apply. */
  const fmt = (...args: Parameters<typeof wrap>) => {
    if (mode === "preview") {
      setMode("split");
      setTimeout(() => wrap(...args), 80);
    } else wrap(...args);
  };

  async function runAssistant() {
    setBusy(true);
    try {
      setAnn(await annotate(settings, doc.notes, doc.source));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  function jumpTo(snippet: string) {
    if (!snippet) return;
    setMode((m) => (m === "preview" ? "split" : m));
    setReview(false);
    setTimeout(() => {
      const el = ta.current;
      const i = el?.value.indexOf(snippet.slice(0, 40)) ?? -1;
      if (el && i >= 0) {
        el.focus();
        el.setSelectionRange(i, i + snippet.length);
        const lines = el.value.slice(0, i).split("\n").length;
        el.scrollTop = Math.max(0, (lines - 4) * 22);
      }
    }, 50);
  }

  /** Desktop app: render and save a real PDF file (and open it). Browser: fall back to the print dialog ("Save as PDF"). */
  const exportPdf = async () => {
    const api = (window as unknown as { turbogoo?: { exportPdf?: (title: string) => Promise<string | null> } }).turbogoo;
    if (!api?.exportPdf) return window.print();
    try {
      const file = await api.exportPdf(doc.title);
      if (file) toast("Saved and opened " + file.split(/[\\/]/).pop(), "ok");
    } catch (e) {
      toast("Couldn't save the PDF: " + (e as Error).message, "error");
    }
  };
  const exportMd = () => {
    const url = URL.createObjectURL(new Blob([doc.notes], { type: "text/markdown" }));
    Object.assign(document.createElement("a"), { href: url, download: `${doc.title}.md` }).click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!review) return;
    const f = (e: KeyboardEvent) => e.key === "Escape" && setReview(false);
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [review]);

  const modes: [Mode, string, typeof Eye][] = [["preview", "Read", Eye], ["split", "Split", Columns2], ["edit", "Edit", Pencil]];

  return (
    <div className="nt" style={{ "--nt-size": size + "px" } as CSSProperties}>
      <div className="nt-barwrap">
        <input className="nt-title" aria-label="Document title" placeholder="Untitled" title={doc.title} value={doc.title} onChange={(e) => updateDoc(doc.id, { title: e.target.value })} />
        <i className="nt-sep nt-sep-title" aria-hidden />
        <div className="nt-bar" role="toolbar" aria-label="Notes toolbar">
          <div className="nt-modes" role="tablist" aria-label="Editor mode">
            {modes.map(([m, label, Icon]) => (
              <button key={m} role="tab" aria-selected={mode === m} aria-label={label} title={label} className={mode === m ? "on" : ""} onClick={() => setMode(m)}><Icon size={16} /></button>
            ))}
          </div>
          <i className="nt-sep" aria-hidden />
          <div className="nt-size" role="group" aria-label="Text size">
            <F label="Smaller text" onClick={() => resize(size - 1)} disabled={size <= SIZE_MIN}><Minus size={16} /></F>
            <output className="nt-size-v" aria-label={`Text size ${size} pixels`}>{size}</output>
            <F label="Larger text" onClick={() => resize(size + 1)} disabled={size >= SIZE_MAX}><Plus size={16} /></F>
          </div>
          <i className="nt-sep" aria-hidden />
          <div className="nt-group" role="group" aria-label="Formatting">
            <F label="Bold" onClick={() => fmt("**")}><Bold size={16} /></F>
            <F label="Italic" onClick={() => fmt("*")}><Italic size={16} /></F>
            <F label="Underline" onClick={() => fmt("++")}><Underline size={16} /></F>
            <F label="Key term (shown in violet)" onClick={() => fmt("**", "**", "key term")}>
              <span className="nt-a" aria-hidden>A</span>
            </F>
            <F label="Highlight" onClick={() => fmt("==")}><Highlighter size={16} /></F>
            <F label="Inline math" onClick={() => fmt("$", "$", "x^2")}><Sigma size={16} /></F>
            <F label="Image (coming soon)" disabled><ImageIcon size={16} /></F>
            <F label="Table" onClick={() => fmt("\n| Term | Meaning |\n| --- | --- |\n| ", " | |\n", "A")}><Table2 size={16} /></F>
          </div>
          <i className="nt-sep" aria-hidden />
          <div className="nt-group" role="group" aria-label="Blocks">
            <F label="Heading" onClick={() => fmt("## ", "", "", true)}><Heading2 size={16} /></F>
            <F label="Bullet list" onClick={() => fmt("- ", "", "", true)}><List size={16} /></F>
            <F label="Quote / definition" onClick={() => fmt("> ", "", "", true)}><Quote size={16} /></F>
            <F label="Code" onClick={() => fmt("`")}><Code2 size={16} /></F>
          </div>
          <span className="nt-words muted small">{words.toLocaleString()} words</span>
        </div>

        <div className="nt-end">
          {sel && (
            <button className="nt-pill" onClick={() => onAsk(`Explain this part of my notes more simply:\n\n“${sel.slice(0, 600)}”`)}>
              <MessageCircleQuestion size={15} /> <span>Ask about selection</span>
            </button>
          )}
          <button className="nt-pill" onClick={exportMd} disabled={empty} title="Download as Markdown"><Download size={15} /> <span>.md</span></button>
          <button className="nt-pill" onClick={exportPdf} disabled={empty} title="Save as PDF"><FileText size={15} /> <span>PDF</span></button>
          <button className={"nt-pill" + (review ? " on" : "")} onClick={() => setReview(!review)} aria-pressed={review} aria-expanded={review} aria-controls="nt-review" title="Live Assistant: checks your notes against the source">
            <Sparkles size={15} /> <span>Review</span>
            {ann && ann.length > 0 && <b className="nt-count">{ann.length}</b>}
          </button>
          {trailing && <><i className="nt-sep" aria-hidden />{trailing}</>}
        </div>

        {review && (
          <section id="nt-review" className="nt-review" aria-label="Live Assistant">
            <div className="nt-review-head">
              <h3><Sparkles size={16} /> Live Assistant</h3>
              <span className="spacer" />
              <button className="primary" onClick={runAssistant} disabled={busy || empty}>{busy ? "Reviewing…" : ann ? "Review again" : "Review notes"}</button>
              <button className="icon-btn" aria-label="Close Live Assistant" onClick={() => setReview(false)}><X size={18} /></button>
            </div>
            <p className="muted small">Margin comments only. It never rewrites your text.{!hasLLM(settings) && " (Basic checks offline; connect an API key for deeper review.)"}</p>
            {ann === null && <p className="muted small">Edit your notes, then run a review to check them against the source.</p>}
            {ann?.length === 0 && <p>No gaps found.</p>}
            <div className="nt-ann-list">
              {ann?.map((a, i) => (
                <button key={i} className={"annotation " + a.kind} onClick={() => jumpTo(a.text)} disabled={!a.text}>
                  <span className="ann-ico">{a.kind === "error" ? <AlertCircle size={14} /> : a.kind === "gap" ? <Target size={14} /> : <Lightbulb size={14} />}</span>
                  <span>
                    {a.text && <small className="muted">“{a.text.slice(0, 80)}”</small>}
                    {a.note}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {empty && !generating ? (
        <div className="nt-empty">
          <p className="muted">No notes yet. Start typing, or generate them from your source.</p>
          <button className="primary" onClick={() => setMode("edit")}>Write notes</button>
        </div>
      ) : (
        <div className={"nt-panes m-" + mode}>
          {mode !== "preview" && (
            <textarea
              ref={ta}
              className="nt-edit"
              aria-label="Notes (Markdown)"
              spellCheck
              placeholder="Write in Markdown. Use $x^2$ for inline math and $$…$$ for equations."
              value={doc.notes}
              readOnly={generating}
              onChange={(e) => edit(e.target.value)}
              onSelect={(e) => {
                const t = e.currentTarget;
                setSel(t.value.slice(t.selectionStart, t.selectionEnd).trim().length > 8 ? t.value.slice(t.selectionStart, t.selectionEnd) : "");
              }}
            />
          )}
          {mode !== "edit" && (
            <article className="nt-doc" aria-label="Notes">
              <Markdown text={doc.notes || "*Writing your notes…*"} />
              {generating && <span className="nt-cursor" aria-hidden />}
            </article>
          )}
        </div>
      )}

      <div className="print-only">{!/^\s*#\s/.test(doc.notes) && <h1>{doc.title}</h1>}<Markdown text={doc.notes} /></div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bold, Code2, Columns2, Eye, Heading2, Italic, Lightbulb, List, MessageCircleQuestion, Pencil, Quote, Sigma, Sparkles, Table2, Target } from "lucide-react";
import { annotate, type Annotation } from "../lib/ai";
import { hasLLM } from "../lib/llm";
import { loadAudio, updateDoc, useStore } from "../lib/store";
import type { Doc } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { toast } from "../components/feedback";

type Mode = "preview" | "edit" | "split";

export function NotesTab({ doc, generating, onAsk }: { doc: Doc; generating: boolean; onAsk: (q: string) => void }) {
  const { settings } = useStore();
  const [mode, setMode] = useState<Mode>("preview");
  const [ann, setAnn] = useState<Annotation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const empty = !doc.notes.trim();
  const words = useMemo(() => (doc.notes.match(/\S+/g) ?? []).length, [doc.notes]);

  const edit = (v: string) => updateDoc(doc.id, { notes: v });

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

  return (
    <div className="notes-layout">
      <div className="editor">
        <div className="toolbar-row">
          <div className="seg" role="tablist" aria-label="Editor mode">
            <button role="tab" aria-selected={mode === "preview"} className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}><Eye size={15} /> Read</button>
            <button role="tab" aria-selected={mode === "split"} className={mode === "split" ? "on" : ""} onClick={() => setMode("split")}><Columns2 size={15} /> Split</button>
            <button role="tab" aria-selected={mode === "edit"} className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}><Pencil size={15} /> Edit</button>
          </div>
          {mode !== "preview" && (
            <div className="fmt" role="toolbar" aria-label="Formatting">
              <button title="Bold" aria-label="Bold" onClick={() => wrap("**")}><Bold size={15} /></button>
              <button title="Italic" aria-label="Italic" onClick={() => wrap("*")}><Italic size={15} /></button>
              <button title="Heading" aria-label="Heading" onClick={() => wrap("## ", "", "", true)}><Heading2 size={15} /></button>
              <button title="Bullet list" aria-label="Bullet list" onClick={() => wrap("- ", "", "", true)}><List size={15} /></button>
              <button title="Quote / example" aria-label="Quote" onClick={() => wrap("> ", "", "", true)}><Quote size={15} /></button>
              <button title="Inline math" aria-label="Inline math" onClick={() => wrap("$", "$", "x^2")}><Sigma size={15} /></button>
              <button title="Code" aria-label="Code" onClick={() => wrap("`")}><Code2 size={15} /></button>
              <button title="Table" aria-label="Table" onClick={() => wrap("\n| Term | Meaning |\n| --- | --- |\n| ", " | |\n", "A")}><Table2 size={15} /></button>
            </div>
          )}
          <span className="spacer" />
          {sel && (
            <button onClick={() => onAsk(`Explain this part of my notes more simply:\n\n“${sel.slice(0, 600)}”`)}>
              <MessageCircleQuestion size={15} /> Ask about selection
            </button>
          )}
          <button onClick={exportMd} disabled={empty}>.md</button>
          <button onClick={exportPdf} disabled={empty}>PDF</button>
          <span className="muted small">{words} words</span>
        </div>

        {empty && !generating ? (
          <div className="empty-note">
            <p className="muted">No notes yet. Start typing, or generate them from your source.</p>
            <button onClick={() => setMode("edit")}>Write notes</button>
          </div>
        ) : (
          <div className={"panes m-" + mode}>
            {mode !== "preview" && (
              <textarea
                ref={ta}
                className="note-edit"
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
              <div className="preview">
                <Markdown text={doc.notes || "*Writing your notes…*"} />
                {generating && <span className="cursor" aria-hidden />}
              </div>
            )}
          </div>
        )}
      </div>

      <aside className="margin">
        <div className="margin-head">
          <h3><Sparkles size={16} /> Live Assistant</h3>
          <button onClick={runAssistant} disabled={busy || empty}>{busy ? "Reviewing…" : "Review"}</button>
        </div>
        <p className="muted small">Margin comments only. It never rewrites your text.{!hasLLM(settings) && " (Basic checks offline; connect an API key for deeper review.)"}</p>
        {ann === null && <p className="muted small">Edit your notes, then click Review to check them against the source.</p>}
        {ann?.length === 0 && <p>No gaps found.</p>}
        {ann?.map((a, i) => (
          <button key={i} className={"annotation " + a.kind} onClick={() => jumpTo(a.text)} disabled={!a.text}>
            <span className="ann-ico">{a.kind === "error" ? <AlertCircle size={14} /> : a.kind === "gap" ? <Target size={14} /> : <Lightbulb size={14} />}</span>
            <span>
              {a.text && <small className="muted">“{a.text.slice(0, 80)}”</small>}
              {a.note}
            </span>
          </button>
        ))}
        <SourcePanel doc={doc} />
      </aside>

      <div className="print-only">{!/^\s*#\s/.test(doc.notes) && <h1>{doc.title}</h1>}<Markdown text={doc.notes} /></div>
    </div>
  );
}

function SourcePanel({ doc }: { doc: Doc }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let u = "";
    if (doc.hasAudio) loadAudio(doc.id).then((b) => b && setUrl((u = URL.createObjectURL(b))));
    return () => (u ? URL.revokeObjectURL(u) : undefined);
  }, [doc.id, doc.hasAudio]);
  return (
    <>
      {url && (
        <div className="audio-box">
          <b className="small">Original recording</b>
          <audio controls src={url} preload="metadata" />
        </div>
      )}
      {doc.sourceUrl && <a className="small" href={doc.sourceUrl} target="_blank" rel="noreferrer noopener">Open original video</a>}
      <details>
        <summary>Source material ({doc.source.length.toLocaleString()} chars)</summary>
        <pre className="source">{doc.source || "(none)"}</pre>
      </details>
    </>
  );
}

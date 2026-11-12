import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, ChevronDown, Flag, Send, Square } from "lucide-react";
import { chat } from "../lib/ai";
import { updateDoc, useStore } from "../lib/store";
import type { ChatMsg, Doc } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { toast } from "../components/feedback";

/** Moments the student flagged with [?] during recording, with a little context. */
function flaggedMoments(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\[\?\]\s*([^[]{0,160})/g)) {
    const before = source.slice(Math.max(0, (m.index ?? 0) - 140), m.index).replace(/\s+/g, " ").trim();
    const after = m[1].replace(/\s+/g, " ").trim();
    out.push(`I flagged a confusing moment in the lecture around: “…${before.slice(-100)} ${after}…”. Can you explain it?`);
  }
  return out.slice(0, 4);
}

export function Chat({ doc, draft, clearDraft }: { doc: Doc; draft: string; clearDraft: () => void }) {
  const { settings } = useStore();
  const [input, setInput] = useState("");
  const [live, setLive] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const flags = useMemo(() => flaggedMoments(doc.source), [doc.source]);

  useEffect(() => {
    if (draft) {
      setInput(draft);
      clearDraft();
    }
  }, [draft, clearDraft]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [doc.chat.length, live]);
  useEffect(
    () => () => {
      ctl.current?.abort();
    },
    [],
  );

  async function send(text = input) {
    const q = text.trim();
    if (!q || live !== null) return;
    setInput("");
    const history: ChatMsg[] = [...doc.chat, { role: "user", text: q }];
    updateDoc(doc.id, { chat: history });
    setLive("");
    ctl.current = new AbortController();
    try {
      const r = await chat(settings, doc.source, doc.notes, doc.chat, q, setLive, { signal: ctl.current.signal, subject: doc.subject });
      updateDoc(doc.id, { chat: [...history, { role: "assistant", text: r.text, sources: r.sources }] });
    } catch (e) {
      const partial = live ?? "";
      if (!ctl.current.signal.aborted) toast((e as Error).message, "error");
      if (partial) updateDoc(doc.id, { chat: [...history, { role: "assistant", text: partial }] });
    } finally {
      setLive(null);
    }
  }

  const appendToNotes = (m: ChatMsg) => {
    updateDoc(doc.id, (d) => ({ notes: `${d.notes.trimEnd()}\n\n## From chat\n\n${m.text}\n` }));
    toast("Added to your notes.", "ok");
  };

  const starters = ["Summarize the key points", "What are the most likely exam questions?", "Explain the hardest idea in simple terms"];

  return (
    <div className="chat">
      <div className="msgs" aria-live="polite">
        {doc.chat.length === 0 && live === null && (
          <div className="chat-empty">
            <p className="muted">Ask anything about this document. Answers come from your own material, with sources.</p>
            <div className="suggest">
              {flags.map((f) => (
                <button key={f} className="chip flag" onClick={() => send(f)}><Flag size={13} /> {f.slice(60, 130)}…</button>
              ))}
              {starters.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {doc.chat.map((m, i) => (
          <Message key={i} m={m} onAdd={() => appendToNotes(m)} />
        ))}
        {live !== null && (live ? <Message m={{ role: "assistant", text: live }} streaming /> : <div className="msg assistant"><span className="typing"><i /><i /><i /></span></div>)}
        <div ref={end} />
      </div>
      <div className="composer">
        <textarea
          aria-label="Ask a question"
          rows={Math.min(5, Math.max(1, input.split("\n").length))}
          placeholder="Ask about your notes…  (Enter to send, Shift+Enter for a new line)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {live !== null ? (
          <button aria-label="Stop" onClick={() => ctl.current?.abort()}><Square size={16} fill="currentColor" /></button>
        ) : (
          <button className="primary" aria-label="Send" onClick={() => send()} disabled={!input.trim()}><Send size={16} /></button>
        )}
      </div>
    </div>
  );
}

function Message({ m, onAdd, streaming }: { m: ChatMsg; onAdd?: () => void; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (m.role === "user") return <div className="msg user">{m.text}</div>;
  return (
    <div className="msg assistant">
      <Markdown text={m.text} />
      {!streaming && (
        <div className="msg-actions">
          {onAdd && <button className="link small" onClick={onAdd}><BookmarkPlus size={14} /> Add to notes</button>}
          {m.sources && m.sources.length > 0 && (
            <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
              Sources ({m.sources.length}) <ChevronDown size={13} className={open ? "flip" : ""} />
            </button>
          )}
        </div>
      )}
      {open && (
        <ol className="sources">
          {m.sources!.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

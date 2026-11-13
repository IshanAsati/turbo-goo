import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AudioLines, BookmarkPlus, ChevronDown, Flag, Layers, ListChecks, Mic, Paperclip, Square, X } from "lucide-react";
import { chat } from "../lib/ai";
import { updateDoc, useStore } from "../lib/store";
import type { ChatMsg, Doc } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { Mascot } from "../components/Mascot";
import { toast } from "../components/feedback";

/** Moments the student flagged with [?] during recording, with a little context. */
function flaggedMoments(source: string): { prompt: string; label: string }[] {
  const out: { prompt: string; label: string }[] = [];
  for (const m of source.matchAll(/\[\?\]\s*([^[]{0,160})/g)) {
    const before = source.slice(Math.max(0, (m.index ?? 0) - 140), m.index).replace(/\s+/g, " ").trim();
    const after = m[1].replace(/\s+/g, " ").trim();
    const ctx = `${before.slice(-100)} ${after}`.trim();
    out.push({ prompt: `I flagged a confusing moment in the lecture around: “…${ctx}…”. Can you explain it?`, label: (() => { const s = after || before.slice(-70); return s.length > 70 ? s.slice(0, 70).replace(/\s\S*$/, "") + "…" : s; })() });
  }
  return out.slice(0, 4);
}

export type StudyTool = "quiz" | "podcast" | "flashcards";

const TOOLS: { id: StudyTool; title: string; blurb: string; icon: typeof Mic; popular?: boolean }[] = [
  { id: "quiz", title: "Quizzes", blurb: "Test your knowledge", icon: ListChecks, popular: true },
  { id: "podcast", title: "Podcast", blurb: "Listen and learn on the go", icon: Mic },
  { id: "flashcards", title: "Flashcards", blurb: "Study with active recall", icon: Layers },
];

const STARTERS = ["Summarize the key points", "What are the most likely exam questions?", "Explain the hardest idea in simple terms"];

/** The docked "Chat" panel of a document: quick study shortcuts, then a conversation grounded in the document's own material. */
export function ChatPanel({ doc, draft, clearDraft, onClose, onPick }: { doc: Doc; draft: string; clearDraft: () => void; onClose: () => void; onPick: (tool: StudyTool) => void }) {
  const { settings } = useStore();
  const [input, setInput] = useState("");
  const [live, setLive] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const partial = useRef("");
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const flags = useMemo(() => flaggedMoments(doc.source), [doc.source]);
  const empty = doc.chat.length === 0 && live === null;

  useEffect(() => {
    if (draft) {
      setInput(draft);
      clearDraft();
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [draft, clearDraft]);
  useEffect(() => {
    if (!doc.chat.length && !live) return; // empty state stays at the top
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
    partial.current = "";
    setLive("");
    ctl.current = new AbortController();
    const signal = ctl.current.signal;
    try {
      const r = await chat(settings, doc.source, doc.notes, doc.chat, q, (t) => ((partial.current = t), setLive(t)), { signal, subject: doc.subject });
      updateDoc(doc.id, { chat: [...history, { role: "assistant", text: r.text, sources: r.sources }] });
    } catch (e) {
      if (!signal.aborted) toast((e as Error).message, "error");
      if (partial.current) updateDoc(doc.id, { chat: [...history, { role: "assistant", text: partial.current }] });
    } finally {
      setLive(null);
    }
  }

  const appendToNotes = (m: ChatMsg) => {
    updateDoc(doc.id, (d) => ({ notes: `${d.notes.trimEnd()}\n\n## From chat\n\n${m.text}\n` }));
    toast("Added to your notes.", "ok");
  };

  return (
    <section className="cp" aria-label="Chat">
      <header className="cp-head">
        <h2>Chat</h2>
        <button className="icon-btn" aria-label="Close chat" onClick={onClose}><X size={18} /></button>
      </header>

      <div className="cp-scroll" aria-live="polite">
        <div className={"cp-tools" + (empty ? "" : " compact")}>
          {TOOLS.map(({ id, title, blurb, icon: Icon, popular }) => (
            <button key={id} className="cp-tool" onClick={() => onPick(id)} aria-label={`${title}: ${blurb}`}>
              <span className="cp-tool-top">
                <Icon size={18} aria-hidden /> <b>{title}</b>
                {popular && <span className="cp-pop">Popular</span>}
              </span>
              <span className="cp-tool-blurb">{blurb}</span>
            </button>
          ))}
        </div>

        {empty ? (
          <div className="cp-hello">
            <Mascot size={72} mood="reading" />
            <h3>Hey, I'm Turbo</h3>
            <p>I can work with you on your doc and answer any questions!</p>
            <div className="cp-suggest">
              {flags.map((f) => (
                <button key={f.prompt} className="chip flag" onClick={() => send(f.prompt)}><Flag size={13} /> Explain: {f.label}</button>
              ))}
              {STARTERS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="cp-msgs">
            {doc.chat.map((m, i) => (
              <Message key={i} m={m} onAdd={() => appendToNotes(m)} />
            ))}
            {live !== null && (live ? <Message m={{ role: "assistant", text: live }} streaming /> : <div className="cp-msg assistant"><span className="cp-typing" role="status" aria-label="Turbo is thinking"><i /><i /><i /></span></div>)}
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="cp-composer">
        <div className="cp-box">
          <textarea
            ref={field}
            aria-label="Ask a question"
            rows={Math.min(6, Math.max(2, input.split("\n").length))}
            placeholder="Type a question here or type '@' to reference documents…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="cp-box-foot">
            <button className="cp-round" aria-label="Attach a file" title="Attachments aren't available in document chat yet" disabled><Paperclip size={16} /></button>
            <span className="spacer" />
            <button className="cp-talk" title="Voice chat isn't available yet" disabled><AudioLines size={16} /> Talk to Turbo</button>
            {live !== null ? (
              <button className="cp-send stop" aria-label="Stop" onClick={() => ctl.current?.abort()}><Square size={14} fill="currentColor" /></button>
            ) : (
              <button className="cp-send" aria-label="Send" onClick={() => send()} disabled={!input.trim()}><ArrowUp size={18} /></button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Message({ m, onAdd, streaming }: { m: ChatMsg; onAdd?: () => void; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (m.role === "user") return <div className="cp-msg user">{m.text}</div>;
  return (
    <div className="cp-msg assistant">
      <Markdown text={m.text} />
      {!streaming && (
        <div className="cp-actions">
          {onAdd && <button className="link small" onClick={onAdd}><BookmarkPlus size={14} /> Add to notes</button>}
          {m.sources && m.sources.length > 0 && (
            <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
              Sources ({m.sources.length}) <ChevronDown size={13} className={open ? "flip" : ""} />
            </button>
          )}
        </div>
      )}
      {open && (
        <ol className="cp-sources">
          {m.sources!.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

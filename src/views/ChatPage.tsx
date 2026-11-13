import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookmarkPlus, ChevronDown, MessageSquarePlus, Square, Trash2 } from "lucide-react";
import { chatWithSources } from "../lib/ai";
import { go } from "../lib/nav";
import { createDoc, retitleThread } from "../lib/generate";
import { combineSources, kindOf } from "../lib/sources";
import { handOff, takeHandOff } from "../lib/handoff";
import { addThread, deleteThread, updateThread, useStore } from "../lib/store";
import type { ChatMsg, Thread } from "../lib/types";
import { Markdown } from "../components/Markdown";
import { Mascot } from "../components/Mascot";
import { AttachmentChips, SourcePills, useAttachments } from "../components/SourceTray";
import { confirmDialog, toast } from "../components/feedback";
import "../styles/chat-page.css";

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 6e4);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function ChatPage({ id }: { id?: string }) {
  const { threads } = useStore();
  const thread = id ? threads.find((t) => t.id === id) : undefined;
  return (
    <div className="chat-shell">
      <aside className="threads" aria-label="Conversations">
        <button className="primary new-chat" onClick={() => go("/chat")}><MessageSquarePlus size={16} /> New chat</button>
        <ol>
          {threads.map((t) => (
            <li key={t.id} className={t.id === id ? "on" : ""}>
              <button className="thread-btn" onClick={() => go(`/chat/${t.id}`)}>
                <span className="thread-title">{t.title}</span>
                <span className="thread-meta">{ago(t.updatedAt)}{t.attachments.length ? ` · ${t.attachments.length} src` : ""}</span>
              </button>
              <button
                className="icon-btn thread-del"
                aria-label={`Delete ${t.title}`}
                onClick={async () => {
                  if (await confirmDialog("Delete conversation?", `“${t.title}” will be removed.`, "Delete", true)) {
                    deleteThread(t.id);
                    if (t.id === id) go("/chat");
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
          {threads.length === 0 && <li className="muted small empty-threads">Conversations you start appear here.</li>}
        </ol>
      </aside>
      {id && !thread ? (
        <div className="convo"><p className="muted">This conversation was deleted.</p></div>
      ) : (
        <Conversation key={id ?? "new"} thread={thread} />
      )}
    </div>
  );
}

function Conversation({ thread }: { thread?: Thread }) {
  const { settings } = useStore();
  const api = useAttachments(thread?.attachments ?? []);
  const [input, setInput] = useState("");
  const [live, setLive] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const idRef = useRef(thread?.id);
  const msgs = thread?.messages ?? [];

  // Keep the thread's attached sources in sync with the tray.
  useEffect(() => {
    if (idRef.current && thread && thread.attachments !== api.atts) updateThread(idRef.current, { attachments: api.atts });
  }, [api.atts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs.length, live]);
  // No abort on unmount: a reply keeps streaming into the thread if you switch pages.
  useEffect(() => {
    const t = thread && takeHandOff(thread.id);
    if (t) void send(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(text = input) {
    const q = text.trim();
    if (!q || live !== null) return;
    setInput("");
    const tid = idRef.current;
    if (!tid) {
      // Create the thread, then let its own page send the message.
      const t = addThread({ title: q.slice(0, 60), attachments: api.atts, autoTitle: true });
      handOff(t.id, q);
      return go(`/chat/${t.id}`);
    }
    const before = msgs;
    const userMsg: ChatMsg = { role: "user", text: q, attached: api.atts.map((a) => a.name) };
    updateThread(tid, { messages: [...before, userMsg] });
    setLive("");
    ctl.current = new AbortController();
    let partial = "";
    try {
      const r = await chatWithSources(settings, api.atts, before, q, (t) => ((partial = t), setLive(t)), { signal: ctl.current.signal });
      updateThread(tid, { messages: [...before, userMsg, { role: "assistant", text: r.text, sources: r.sources }] });
      if (!before.length) void retitleThread(tid, q, r.text);
    } catch (e) {
      if (!ctl.current.signal.aborted) toast((e as Error).message, "error");
      if (partial) updateThread(tid, { messages: [...before, userMsg, { role: "assistant", text: partial }] });
    } finally {
      setLive(null);
    }
  }

  const makeStudySet = () => {
    if (!api.atts.length) return;
    const title = thread?.title ?? api.atts[0].name;
    go(`/doc/${createDoc({ title, source: combineSources(api.atts), kind: kindOf(api.atts), autoTitle: !thread || !!thread.autoTitle })}`);
  };

  const starters = api.atts.length
    ? ["Summarize each source in 3 bullets", "Where do these sources agree and disagree?", "Quiz me on the hardest ideas"]
    : ["Explain a concept like I'm new to it", "Make me a study plan for this week", "Help me understand a proof step by step"];

  return (
    <section
      className={"convo" + (drag ? " drag" : "")}
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => (e.preventDefault(), setDrag(false), void api.addFiles(e.dataTransfer.files))}
    >
      <header className="convo-head">
        <h1 className="convo-title">{thread?.title ?? "New conversation"}</h1>
        {api.atts.length > 0 && <button className="make-set" onClick={makeStudySet}>Turn sources into a study set</button>}
      </header>

      <div className="msgs" aria-live="polite">
        {msgs.length === 0 && live === null && (
          <div className="chat-empty">
            <Mascot size={88} mood="thinking" />
            <h2 className="display">{api.atts.length ? `Ask across ${api.atts.length} source${api.atts.length > 1 ? "s" : ""}.` : "Ask anything. Attach as many sources as you like."}</h2>
            <p className="muted">Answers cite the attached files, links and library docs by number. Drop files anywhere on this page to attach them.</p>
            <div className="suggest">
              {starters.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => <Message key={i} m={m} threadId={thread?.id} />)}
        {live !== null && (live ? <Message m={{ role: "assistant", text: live }} streaming /> : <div className="msg assistant"><span className="typing"><i /><i /><i /></span></div>)}
        <div ref={end} />
      </div>

      <div className="composer-card chat-composer">
        <textarea
          aria-label="Message"
          rows={Math.min(8, Math.max(2, input.split("\n").length))}
          placeholder={api.atts.length ? "Ask about your sources…" : "Message, or attach sources first…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) (e.preventDefault(), void api.addFiles(files));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), void send());
          }}
        />
        <AttachmentChips api={api} compact />
        <div className="cc-row">
          <div className="cc-left"><SourcePills api={api} menuDir="up" /></div>
          <div className="cc-right">
            <span className="cc-hint hide-sm">Enter to send · Shift+Enter for a new line</span>
            {live !== null ? (
              <button className="send-btn stop" aria-label="Stop" title="Stop" onClick={() => ctl.current?.abort()}><Square size={15} fill="currentColor" aria-hidden /></button>
            ) : (
              <button className="primary send-btn" aria-label="Send" title="Send" disabled={!input.trim() || !!api.busy} onClick={() => send()}><ArrowUp size={20} strokeWidth={2.4} aria-hidden /></button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Message({ m, streaming, threadId }: { m: ChatMsg; streaming?: boolean; threadId?: string }) {
  const [open, setOpen] = useState(false);
  if (m.role === "user")
    return (
      <div className="msg user">
        {m.attached && m.attached.length > 0 && <div className="msg-att">{m.attached.length} source{m.attached.length > 1 ? "s" : ""} attached</div>}
        {m.text}
      </div>
    );
  return (
    <div className="msg assistant">
      <Markdown text={m.text} />
      {!streaming && (
        <div className="msg-actions">
          {threadId && (
            <button className="link small" onClick={() => go(`/doc/${createDoc({ title: m.text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) || "From chat", source: m.text, kind: "text" })}`)}>
              <BookmarkPlus size={14} /> Save as study set
            </button>
          )}
          {m.sources && m.sources.length > 0 && (
            <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
              Sources ({m.sources.length}) <ChevronDown size={13} className={open ? "flip" : ""} />
            </button>
          )}
        </div>
      )}
      {open && <ol className="sources">{m.sources!.map((s, i) => <li key={i}>{s}</li>)}</ol>}
    </div>
  );
}

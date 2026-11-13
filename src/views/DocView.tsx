import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Check, EllipsisVertical, FileText, Headphones, Layers, ListChecks, Loader2, MessageSquare, RefreshCw, StickyNote, Trash2, TriangleAlert, X } from "lucide-react";
import { go } from "../lib/nav";
import { cancelJob, generateMissing, generatePodcast, generateCourse, regenerate } from "../lib/generate";
import { deleteDoc, markOpened, updateDoc, useJob, useStore } from "../lib/store";
import { dueCount } from "../lib/srs";
import { SUBJECT_LIST } from "../lib/subjects";
import type { Doc, Subject } from "../lib/types";
import { confirmDialog } from "../components/feedback";
import { Flashcards } from "./Flashcards";
import { Quiz } from "./Quiz";
import { ChatPanel, type StudyTool } from "./Chat";
import { Podcast } from "./Podcast";
import { Course } from "./Learn";
import { NotesTab } from "./NotesTab";
import { SourceView } from "./SourceView";
import "../styles/doc.css";

const TABS = ["learn", "notes", "quiz", "flashcards", "podcast", "source"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { learn: "Learn", notes: "Notes", quiz: "Quiz", flashcards: "Flashcards", podcast: "Podcast", source: "Source" };
const ICON: Record<Tab, typeof BookOpen> = { learn: BookOpen, notes: StickyNote, quiz: ListChecks, flashcards: Layers, podcast: Headphones, source: FileText };

/** Deep links: ?tab=learn|course|notes|quiz|flashcards|podcast|source|chat. "chat" is the Notes tab with the Chat panel open. */
function parseTab(raw?: string): { tab: Tab | null; chat: boolean } {
  const t = raw?.toLowerCase();
  if (t === "chat") return { tab: "notes", chat: true };
  if (t === "course") return { tab: "learn", chat: false };
  return { tab: TABS.find((x) => x === t) ?? null, chat: false };
}
const defaultTab = (d?: Doc): Tab => (d?.course.length && !d.notes ? "learn" : "notes");

/** Wide enough to dock the chat panel beside the page (below this it becomes a drawer). */
function useWide() {
  const q = "(min-width: 1100px)";
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setWide(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return wide;
}

export function DocView({ id, initialTab }: { id: string; initialTab?: string }) {
  const { docs } = useStore();
  const doc = docs.find((d) => d.id === id);
  const job = useJob(id);
  const podJob = useJob(id + ":podcast");
  const courseJob = useJob(id + ":course");
  const wide = useWide();
  const [{ tab: first, chat: firstChat }] = useState(() => parseTab(initialTab));
  const [tab, setTab] = useState<Tab>(() => first ?? defaultTab(doc));
  const [chatOpen, setChatOpen] = useState(() => firstChat || (window.matchMedia("(min-width: 1100px)").matches && (first ?? defaultTab(doc)) === "notes"));
  const [draft, setDraft] = useState("");
  const clearDraft = useCallback(() => setDraft(""), []);
  const seen = useRef(initialTab);
  const exists = !!doc;

  useEffect(() => {
    if (exists) markOpened(id);
  }, [id, exists]);

  // A new deep link while this document is already open (same document, different ?tab=).
  useEffect(() => {
    if (seen.current === initialTab) return;
    seen.current = initialTab;
    const p = parseTab(initialTab);
    if (p.tab) {
      setTab(p.tab);
      setChatOpen(p.chat || (wide && p.tab === "notes"));
    }
  }, [initialTab, wide]);

  const select = (t: Tab) => {
    setTab(t);
    setChatOpen(wide && t === "notes");
    history.replaceState(null, "", `#/doc/${id}?tab=${t}`);
  };

  if (!doc) {
    return (
      <div className="page">
        <p>This document doesn't exist (it may have been deleted).</p>
        <button onClick={() => go("/")}>Back to library</button>
      </div>
    );
  }

  const notesStreaming = !!job && !job.error && !job.done && /Writing your notes|thinking/.test(job.step);
  const count: Partial<Record<Tab, number>> = { learn: doc.course.length || undefined, quiz: doc.quiz.length || undefined, flashcards: doc.cards.length || undefined, podcast: doc.podcast.length || undefined };
  const due = dueCount(doc.cards);
  const ask = (q: string) => (setDraft(q), setChatOpen(true));
  const pick = (t: StudyTool) => select(t);

  const trailing: ReactNode = (
    <>
      <button className={"dv-chat-btn" + (chatOpen ? " on" : "")} aria-pressed={chatOpen} aria-label={chatOpen ? "Close chat" : "Open chat"} onClick={() => setChatOpen(!chatOpen)}>
        <MessageSquare size={16} /> <span>Chat</span>
      </button>
      <DocMenu doc={doc} />
    </>
  );

  return (
    <div className={"dv" + (chatOpen ? " chat-open" : "") + " tab-" + tab}>
      <nav className="dv-rail" aria-label="Document sections">
        <div className="dv-rail-in" role="tablist" aria-orientation={wide ? "vertical" : "horizontal"}>
          {TABS.map((t) => {
            const Icon = ICON[t];
            return (
              <button key={t} role="tab" id={"dv-tab-" + t} aria-selected={tab === t} aria-controls="dv-pane" className={"dv-tab" + (tab === t ? " on" : "")} onClick={() => select(t)}>
                <span className="dv-ico">
                  <Icon size={22} strokeWidth={tab === t ? 2.2 : 1.8} />
                  {count[t] ? <span className="dv-count" aria-label={`${count[t]} items`}>{count[t]}</span> : null}
                  {t === "flashcards" && due > 0 && <span className="dv-dot" role="img" aria-label={`${due} cards due`} title={`${due} due`} />}
                </span>
                <span className="dv-label">{LABEL[t]}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="dv-main">
        {job && (
          <div className={"dv-banner " + (job.error ? "error" : job.done ? "ok" : "")} role="status">
            {job.error ? <TriangleAlert size={18} /> : job.done ? <Check size={18} /> : <Loader2 size={18} className="spin" />}
            <span>{job.error ? job.error : job.done ? "Study materials ready." : job.step}</span>
            {job.error ? (
              <button onClick={() => generateMissing(doc.id)}>Retry</button>
            ) : (
              !job.done && <button onClick={() => cancelJob(doc.id)}><X size={14} /> Cancel</button>
            )}
          </div>
        )}

        {tab !== "notes" && <div className="dv-actions">{trailing}</div>}

        <div className={"dv-pane dv-pane-" + tab} id="dv-pane" role="tabpanel" aria-labelledby={"dv-tab-" + tab}>
          {tab === "learn" && <Course doc={doc} job={courseJob} onGenerate={() => generateCourse(doc)} />}
          {tab === "notes" && <NotesTab doc={doc} generating={notesStreaming} onAsk={ask} trailing={trailing} />}
          {tab === "quiz" && <Quiz doc={doc} />}
          {tab === "flashcards" && <Flashcards doc={doc} />}
          {tab === "podcast" && <Podcast doc={doc} job={podJob} onGenerate={() => generatePodcast(doc)} />}
          {tab === "source" && <SourceView doc={doc} />}
        </div>
      </div>

      <div className="dv-scrim" hidden={!chatOpen} onClick={() => setChatOpen(false)} aria-hidden />
      <aside className="dv-panel" hidden={!chatOpen}>
        <ChatPanel doc={doc} draft={draft} clearDraft={clearDraft} onClose={() => setChatOpen(false)} onPick={pick} />
      </aside>
    </div>
  );
}

/** The ⋮ menu: subject, regenerate and delete. */
function DocMenu({ doc }: { doc: Doc }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const regen = async (w: "notes" | "cards" | "quiz") => {
    setOpen(false);
    if (await confirmDialog(`Regenerate ${w}?`, w === "notes" ? "Your current notes (including edits) will be replaced." : `Your current ${w === "cards" ? "flashcards and their progress" : "quiz questions"} will be replaced.`, "Regenerate", true)) regenerate(doc, w);
  };

  return (
    <div className="dv-menu-wrap" ref={wrap}>
      <button className="dv-more" aria-label="Document options" aria-haspopup="menu" aria-expanded={open} title="More" onClick={() => setOpen(!open)}>
        <EllipsisVertical size={18} />
      </button>
      {open && (
        <div className="dv-menu" role="menu" aria-label="Document options">
          <label className="dv-menu-field">
            <span>Subject</span>
            <select aria-label="Subject" title="Subject: used for new questions, chat and regenerated materials" value={doc.subject ?? "general"} onChange={(e) => updateDoc(doc.id, { subject: e.target.value as Subject })}>
              {SUBJECT_LIST.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <hr />
          <p className="dv-menu-h">Regenerate</p>
          <button role="menuitem" onClick={() => regen("notes")}><RefreshCw size={15} /> Notes</button>
          <button role="menuitem" onClick={() => regen("cards")}><RefreshCw size={15} /> Flashcards</button>
          <button role="menuitem" onClick={() => regen("quiz")}><RefreshCw size={15} /> Quiz</button>
          <hr />
          <button
            role="menuitem"
            className="danger"
            onClick={async () => {
              setOpen(false);
              if (await confirmDialog("Delete document?", "This also removes its flashcards, quiz and audio.", "Delete", true)) (deleteDoc(doc.id), go("/"));
            }}
          >
            <Trash2 size={15} /> Delete document
          </button>
        </div>
      )}
    </div>
  );
}

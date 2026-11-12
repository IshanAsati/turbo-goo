import { useState } from "react";
import { ArrowLeft, Check, ChevronDown, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react";
import { go } from "../lib/nav";
import { cancelJob, generateMissing, generatePodcast, generateCourse, regenerate } from "../lib/generate";
import { deleteDoc, updateDoc, useJob, useStore } from "../lib/store";
import { dueCount } from "../lib/srs";
import { SUBJECT_LIST } from "../lib/subjects";
import type { Subject } from "../lib/types";
import { confirmDialog } from "../components/feedback";
import { Flashcards } from "./Flashcards";
import { Quiz } from "./Quiz";
import { Chat } from "./Chat";
import { Podcast } from "./Podcast";
import { Course } from "./Learn";
import { NotesTab } from "./NotesTab";

const TABS = ["Notes", "Flashcards", "Quiz", "Chat", "Podcast", "Course"] as const;
type Tab = (typeof TABS)[number];

export function DocView({ id, initialTab }: { id: string; initialTab?: string }) {
  const { docs } = useStore();
  const doc = docs.find((d) => d.id === id);
  const job = useJob(id);
  const podJob = useJob(id + ":podcast");
  const courseJob = useJob(id + ":course");
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => t.toLowerCase() === initialTab?.toLowerCase()) ?? (doc?.course.length && !doc.notes ? "Course" : "Notes"));
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState(false);

  if (!doc) {
    return (
      <div className="page">
        <p>This document doesn't exist (it may have been deleted).</p>
        <button onClick={() => go("/")}>Back to library</button>
      </div>
    );
  }

  const notesStreaming = !!job && !job.error && !job.done && /Writing your notes|thinking/.test(job.step);
  const count: Partial<Record<Tab, number>> = { Flashcards: doc.cards.length, Quiz: doc.quiz.length, Course: doc.course.length || undefined, Podcast: doc.podcast.length || undefined };
  const due = dueCount(doc.cards);
  const ask = (q: string) => (setDraft(q), setTab("Chat"));

  return (
    <div className="page doc-page">
      <div className="doc-head">
        <button className="icon-btn" aria-label="Back to library" onClick={() => go("/")}><ArrowLeft size={20} /></button>
        <input className="title-input" aria-label="Document title" value={doc.title} onChange={(e) => updateDoc(doc.id, { title: e.target.value })} />
        <select className="subject-select" aria-label="Subject" title="Subject: used for new questions, chat and regenerated materials" value={doc.subject ?? "general"} onChange={(e) => updateDoc(doc.id, { subject: e.target.value as Subject })}>
          {SUBJECT_LIST.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <div className="menu-wrap">
          <button onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>Regenerate <ChevronDown size={14} /></button>
          {menu && (
            <div className="menu right" role="menu" onMouseLeave={() => setMenu(false)}>
              {(["notes", "cards", "quiz"] as const).map((w) => (
                <button
                  key={w}
                  role="menuitem"
                  onClick={async () => {
                    setMenu(false);
                    if (await confirmDialog(`Regenerate ${w}?`, w === "notes" ? "Your current notes (including edits) will be replaced." : `Your current ${w === "cards" ? "flashcards and their progress" : "quiz questions"} will be replaced.`, "Regenerate", true)) regenerate(doc, w);
                  }}
                >
                  <RefreshCw size={14} /> {w === "cards" ? "Flashcards" : w[0].toUpperCase() + w.slice(1)}
                </button>
              ))}
              <button
                role="menuitem"
                className="danger-text"
                onClick={async () => {
                  setMenu(false);
                  if (await confirmDialog("Delete document?", "This also removes its flashcards, quiz and audio.", "Delete", true)) (deleteDoc(doc.id), go("/"));
                }}
              >
                Delete document
              </button>
            </div>
          )}
        </div>
      </div>

      {job && (
        <div className={"banner " + (job.error ? "error" : job.done ? "ok" : "")} role="status">
          {job.error ? <TriangleAlert size={18} /> : job.done ? <Check size={18} /> : <Loader2 size={18} className="spin" />}
          <span>{job.error ? job.error : job.done ? "Study materials ready." : job.step}</span>
          {job.error ? (
            <button onClick={() => generateMissing(doc.id)}>Retry</button>
          ) : (
            !job.done && <button onClick={() => cancelJob(doc.id)}><X size={14} /> Cancel</button>
          )}
        </div>
      )}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={"tab" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>
            {t}
            {count[t] ? <span className="count">{count[t]}</span> : null}
            {t === "Flashcards" && due > 0 && <span className="dot" title={`${due} due`} />}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "Notes" && <NotesTab doc={doc} generating={notesStreaming} onAsk={ask} />}
        {tab === "Flashcards" && <Flashcards doc={doc} />}
        {tab === "Quiz" && <Quiz doc={doc} />}
        {tab === "Chat" && <Chat doc={doc} draft={draft} clearDraft={() => setDraft("")} />}
        {tab === "Podcast" && <Podcast doc={doc} job={podJob} onGenerate={() => generatePodcast(doc)} />}
        {tab === "Course" && <Course doc={doc} job={courseJob} onGenerate={() => generateCourse(doc)} />}
      </div>
    </div>
  );
}

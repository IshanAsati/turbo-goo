import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUp, BookOpen, Calculator, ChevronDown, Code, CirclePlay, Compass, FileText, FlaskConical, Globe, Image as ImageIcon, Languages, Mic, MoreHorizontal, NotebookText, Pin, Play, Plus, Search, Trash2, type LucideIcon } from "lucide-react";
import { go } from "../lib/nav";
import { addThread, dayKey, deleteDoc, setMeta, uid, updateDoc, useStore } from "../lib/store";
import { createCourseDoc, createDoc } from "../lib/generate";
import { tidyName } from "../lib/ai";
import { isYouTube } from "../lib/ingest";
import { hasLLM } from "../lib/llm";
import { attachText, combineSources, kindOf } from "../lib/sources";
import { handOff } from "../lib/handoff";
import { dueCount } from "../lib/srs";
import { SAMPLE_SOURCE, SAMPLE_TITLE } from "../lib/sample";
import { SUBJECT_LIST } from "../lib/subjects";
import { timeAgo } from "../lib/time";
import type { Doc, Subject } from "../lib/types";
import { Mascot } from "../components/Mascot";
import { confirmDialog, Modal, promptDialog, toast } from "../components/feedback";
import { AttachmentChips, SourcePills, useAttachments } from "../components/SourceTray";
import { Recorder } from "./Recorder";
import "../styles/home.css";

type Mode = "set" | "course" | "chat";
const MODES: { id: Mode; label: string }[] = [
  { id: "set", label: "Study set" },
  { id: "course", label: "Course" },
  { id: "chat", label: "Chat" },
];
const LONG_TEXT = 200; // typed text at least this long is treated as a source, shorter text as a topic/title
const MASTERED = 80; // a card counts as mastered from this mastery score

export function Home() {
  const { docs, meta, settings } = useStore();
  const api = useAttachments();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("set");
  const [subject, setSubject] = useState<Subject | "auto">("auto");
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<string>("all");
  const [recording, setRecording] = useState(false);
  const [drag, setDrag] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const folderId = folder === "all" ? "f-general" : folder;
  const text = input.trim();
  const isSource = text.length >= LONG_TEXT;
  const nSources = api.atts.length + (isSource ? 1 : 0);
  const canBuild = !api.busy && (nSources > 0 || text.length >= 3);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs
      .filter((d) => (folder === "all" || d.folderId === folder) && (!needle || (d.title + " " + d.notes).toLowerCase().includes(needle)))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  }, [docs, q, folder]);

  const latest = useMemo(() => docs.reduce<Doc | undefined>((best, d) => (!best || (d.openedAt ?? d.updatedAt) > (best.openedAt ?? best.updatedAt) ? d : best), undefined), [docs]);

  // Paste a YouTube link or an image anywhere on the page to attach it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target instanceof Element ? e.target : document.body).closest("input,textarea")) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) return void api.addFiles(files);
      const t = e.clipboardData?.getData("text") ?? "";
      if (isYouTube(t)) void api.addLink(t.trim());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // "/" jumps to the composer, like a search field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input,textarea,select,[contenteditable],[role=dialog]")) return;
      e.preventDefault();
      area.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function build() {
    if (!canBuild) return;
    const atts = isSource ? [...api.atts, attachText(text)] : api.atts;
    const typedTitle = isSource ? "" : text;

    if (mode === "chat") {
      const t = addThread({ title: (typedTitle || (atts[0] ? tidyName(atts[0].name) : "") || "New chat").slice(0, 60), attachments: atts, autoTitle: true });
      if (typedTitle) handOff(t.id, typedTitle);
      return go(`/chat/${t.id}`);
    }
    if (!atts.length) {
      // A bare topic: only an AI provider can research it.
      if (!hasLLM(settings)) return toast("Learning a bare topic needs an AI provider (Settings). Or attach a file, link or notes to build from.", "error");
      return go(`/doc/${createCourseDoc({ title: typedTitle, source: "", kind: "topic", folderId, subject: subject === "auto" ? undefined : subject })}?tab=learn`);
    }
    const source = combineSources(atts);
    if (source.trim().length < 40) return toast("There isn't enough text in those sources to build from yet.", "error");
    const title = typedTitle || (atts.length === 1 ? tidyName(atts[0].name) : `${tidyName(atts[0].name)} + ${atts.length - 1} more`);
    const sub = subject === "auto" ? undefined : subject;
    const id = mode === "course" ? createCourseDoc({ title, source, kind: kindOf(atts), folderId, subject: sub, autoTitle: !typedTitle }) : createDoc({ title, source, kind: kindOf(atts), folderId, subject: sub, autoTitle: !typedTitle });
    go(`/doc/${id}${mode === "course" ? "?tab=learn" : ""}`);
  }

  const plan =
    mode === "chat"
      ? nSources ? `Opens a conversation grounded in ${nSources} source${nSources > 1 ? "s" : ""}.` : "Opens a conversation. You can attach sources there too."
      : nSources
        ? `${nSources} source${nSources > 1 ? "s" : ""} → one ${mode === "course" ? "guided course" : "set of notes, flashcards and a quiz"}${!isSource && text ? `, titled “${text.slice(0, 40)}”` : ""}.`
        : text
          ? `No sources attached, so this researches “${text.slice(0, 40)}” as a topic and builds a course.`
          : "Type a topic, paste notes, or attach files, slides, recordings and links. As many as you like.";

  const newFolder = async () => {
    const name = await promptDialog("New folder", "Name", "", "Create", "e.g. Biology, Fall 2026");
    if (name) {
      const id = uid();
      setMeta((m) => ({ ...m, folders: [...m.folders, { id, name }] }));
      setFolder(id);
    }
  };
  const renameFolder = async () => {
    const f = meta.folders.find((x) => x.id === folder);
    const name = f && (await promptDialog("Rename folder", "Name", f.name));
    if (name) setMeta((m) => ({ ...m, folders: m.folders.map((x) => (x.id === folder ? { ...x, name } : x)) }));
  };
  const deleteFolder = async () => {
    if (!(await confirmDialog("Delete folder?", "Documents inside move to General.", "Delete folder", true))) return;
    setMeta((m) => ({ ...m, folders: m.folders.filter((x) => x.id !== folder) }));
    docs.filter((d) => d.folderId === folder).forEach((d) => updateDoc(d.id, { folderId: "f-general" }));
    setFolder("all");
  };
  const trySample = () => go(`/doc/${createDoc({ title: SAMPLE_TITLE, source: SAMPLE_SOURCE, kind: "audio", folderId })}`);

  return (
    <div className="page home">
      <header className="home-hero">
        <Mascot size={110} mood="reading" />
        <h1>What do you want to learn?</h1>
      </header>

      <section
        className={"composer-card home-composer" + (drag ? " drag" : "")}
        aria-label="Start learning"
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
        onDrop={(e) => (e.preventDefault(), setDrag(false), void api.addFiles(e.dataTransfer.files))}
      >
        <textarea
          ref={area}
          aria-label="Topic, text or instructions"
          rows={2}
          placeholder="Ask a question, name a topic, or paste your notes…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) (e.preventDefault(), void api.addFiles(files));
            const t = e.clipboardData.getData("text");
            if (!files.length && isYouTube(t) && !input.trim()) (e.preventDefault(), void api.addLink(t.trim()));
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && build()}
        />
        <AttachmentChips api={api} />
        <div className="cc-row">
          <div className="cc-left">
            <SourcePills api={api} onRecord={() => setRecording(true)} />
          </div>
          <div className="cc-right">
            <kbd className="slash-hint" title="Press / to start typing" aria-hidden>/</kbd>
            <Pick label="What to build" value={mode} onChange={(v) => setMode(v as Mode)} options={MODES.map((m) => ({ value: m.id, label: m.label }))} />
            {mode !== "chat" && (
              <Pick
                label="Subject: tunes the notes, flashcards and quiz"
                value={subject}
                onChange={(v) => setSubject(v as Subject | "auto")}
                options={[
                  { value: "auto", label: "Subject: auto" },
                  ...SUBJECT_LIST.filter((x) => x.id !== "general").map((x) => ({ value: x.id, label: x.label })),
                  { value: "general", label: "General" },
                ]}
              />
            )}
            <button className="primary send-btn" aria-label={mode === "chat" ? "Start chat" : "Build"} title={canBuild ? "Ctrl+Enter" : "Type a topic or attach a source first"} disabled={!canBuild} onClick={build}>
              <ArrowUp size={20} strokeWidth={2.4} aria-hidden />
            </button>
          </div>
        </div>
      </section>
      <p className="plan" aria-live="polite">{plan}{canBuild && <kbd>Ctrl ↵</kbd>}</p>

      {docs.length === 0 || !latest ? (
        <section className="first-run">
          <p className="eyebrow">First time?</p>
          <h2 className="display">See what it makes from a messy lecture.</h2>
          <p className="muted">A 5-minute calculus lecture with the chatter filtered out and the math typeset. Works offline, no setup.</p>
          <button className="primary" onClick={trySample}><Play size={16} /> Try the sample lecture</button>
        </section>
      ) : (
        <>
          <JumpBack d={latest} />

          <section className="lessons" aria-labelledby="lessons-h">
            <div className="lessons-head">
              <h2 id="lessons-h">Lessons</h2>
              <button className="text-btn" onClick={newFolder}><Plus size={15} aria-hidden /> New folder</button>
            </div>
            <div className="folders">
              <div className="folder-tabs" role="group" aria-label="Folders">
                <button className={"tabchip" + (folder === "all" ? " on" : "")} aria-pressed={folder === "all"} onClick={() => setFolder("all")}>All</button>
                {meta.folders.map((f) => (
                  <button key={f.id} className={"tabchip" + (folder === f.id ? " on" : "")} aria-pressed={folder === f.id} onClick={() => setFolder(f.id)}>{f.name}</button>
                ))}
                {folder !== "all" && folder !== "f-general" && (
                  <>
                    <button className="link small" onClick={renameFolder}>Rename</button>
                    <button className="link small danger-text" onClick={deleteFolder}>Delete</button>
                  </>
                )}
              </div>
              <div className="searchbox">
                <Search size={15} aria-hidden />
                <input aria-label="Search your library" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="muted lessons-empty">{q ? "No matches." : "This folder is empty."}</p>
            ) : (
              <ol className="lesson-list">
                {shown.map((d) => <LessonCard key={d.id} d={d} />)}
              </ol>
            )}
            <Heatmap activity={meta.activity} />
          </section>
        </>
      )}

      {recording && (
        <Modal onClose={() => setRecording(false)} label="Record lecture">
          <Recorder busy={false} onDone={(title, source, audio) => (setRecording(false), go(`/doc/${createDoc({ title, source, kind: "audio", audio, folderId, autoTitle: true })}`))} />
          <button className="link" onClick={() => setRecording(false)}>Close</button>
        </Modal>
      )}
    </div>
  );
}

/** A compact select styled as a pill. */
function Pick({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <span className="sel">
      <select aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={15} aria-hidden />
    </span>
  );
}

/** Course lessons done, or cards mastered, as a fraction for the progress ring. */
function progressOf(d: Doc) {
  if (d.course.length) return { done: d.course.filter((s) => s.done).length, total: d.course.length, unit: "lessons" };
  const mastered = d.cards.filter((c) => c.mastery >= MASTERED).length;
  return { done: mastered, total: d.cards.length, unit: "cards" };
}

function Ring({ value }: { value: number }) {
  const r = 10;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      <circle cx="14" cy="14" r={r} fill="none" strokeWidth="3.5" className="ring-track" />
      <circle cx="14" cy="14" r={r} fill="none" strokeWidth="3.5" strokeLinecap="round" className="ring-val" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))} transform="rotate(-90 14 14)" />
    </svg>
  );
}

function JumpBack({ d }: { d: Doc }) {
  const p = progressOf(d);
  const next = d.course.findIndex((s) => !s.done);
  const chapter = d.course.length ? (next < 0 ? d.course.length : next + 1) : 0;
  const summary = p.total ? `${p.done} of ${p.total} ${p.unit}` : "";
  return (
    <a className="jump" href={`#/doc/${d.id}`} onClick={(e) => (e.preventDefault(), go(`/doc/${d.id}`))} aria-label={`Jump back in: ${d.title}${summary ? `, ${summary}` : ""}`}>
      <Ring value={p.total ? p.done / p.total : 0} />
      <span className="jump-title">{d.title}</span>
      <span className="jump-meta">
        {chapter ? <>Ch. {chapter}<span className="jump-more"> · {summary}</span></> : summary}
      </span>
      <span className="jump-go">Jump back in <ArrowRight size={16} aria-hidden /></span>
    </a>
  );
}

const SUBJECT_ICON: Partial<Record<Subject, [LucideIcon, string]>> = {
  maths: [Calculator, "t-brand"],
  science: [FlaskConical, "t-ok"],
  sst: [Globe, "t-clay"],
  english: [NotebookText, "t-warn"],
  hindi: [Languages, "t-clay"],
  cs: [Code, "t-link"],
};
const KIND_ICON: Record<string, LucideIcon> = { youtube: CirclePlay, audio: Mic, image: ImageIcon, file: FileText, text: NotebookText, topic: Compass, blank: NotebookText };

function iconFor(d: Doc): [LucideIcon, string] {
  const s = d.subject && SUBJECT_ICON[d.subject];
  if (s) return s;
  if (d.course.length) return [BookOpen, "t-brand"];
  return [KIND_ICON[d.kind] ?? BookOpen, d.kind === "youtube" ? "t-bad" : d.kind === "audio" ? "t-clay" : "t-brand"];
}

function LessonCard({ d }: { d: Doc }) {
  const { meta } = useStore();
  const [menu, setMenu] = useState(false);
  const due = dueCount(d.cards);
  const done = d.course.filter((s) => s.done).length;
  const [Icon, tone] = iconFor(d);
  const seen = !!d.openedAt;
  const href = `/doc/${d.id}`;
  return (
    <li className="lesson" onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
      <span className={"l-tile " + tone} aria-hidden><Icon size={22} /></span>
      <div className="l-body">
        <a className="l-title" href={"#" + href} onClick={(e) => (e.preventDefault(), go(href))}>
          {d.pinned && <Pin size={13} aria-label="Pinned" />}
          <span>{d.title}</span>
        </a>
        <p className="l-meta">
          <span>{seen ? `Opened ${timeAgo(d.openedAt!)}` : `Added ${timeAgo(d.createdAt)}`}</span>
          {d.course.length > 0 && <span className="l-extra">{done} of {d.course.length} lessons</span>}
          {due > 0 && <span className="due-pill">{due} due</span>}
        </p>
      </div>
      <span className="l-go" aria-hidden>{seen ? "Continue" : "Start"} <ArrowRight size={16} /></span>
      <span className="menu-wrap l-menu">
        <button className="icon-btn" aria-label={`Menu for ${d.title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={18} /></button>
        {menu && (
          <div className="menu right" role="menu" onMouseLeave={() => setMenu(false)}>
            <button role="menuitem" onClick={() => (updateDoc(d.id, { pinned: !d.pinned }), setMenu(false))}><Pin size={14} /> {d.pinned ? "Unpin" : "Pin"}</button>
            <button
              role="menuitem"
              onClick={async () => {
                setMenu(false);
                const name = await promptDialog("Rename", "Title", d.title);
                if (name) updateDoc(d.id, { title: name });
              }}
            >
              Rename
            </button>
            <label className="menu-select">
              Move to
              <select value={d.folderId ?? ""} onChange={(e) => (updateDoc(d.id, { folderId: e.target.value }), setMenu(false))}>
                {meta.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            <button
              role="menuitem"
              className="danger-text"
              onClick={async () => {
                setMenu(false);
                if (await confirmDialog("Delete document?", `“${d.title}” and its flashcards, quiz and audio will be removed.`, "Delete", true)) deleteDoc(d.id);
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}
      </span>
    </li>
  );
}

function Heatmap({ activity }: { activity: Record<string, number> }) {
  const cells = useMemo(() => {
    const out: { k: string; n: number }[] = [];
    const end = new Date();
    for (let i = 16 * 7 - 1; i >= 0; i--) {
      const k = dayKey(new Date(end.getTime() - i * 864e5));
      out.push({ k, n: activity[k] ?? 0 });
    }
    return out;
  }, [activity]);
  if (!cells.some((c) => c.n)) return null;
  return (
    <section className="heat" aria-label="Study activity, last 16 weeks">
      <p className="eyebrow">Study activity · 16 weeks</p>
      <div className="heat-grid">
        {cells.map((c) => (
          <i key={c.k} title={`${c.k}: ${c.n}`} className={`l${c.n === 0 ? 0 : c.n < 5 ? 1 : c.n < 15 ? 2 : c.n < 30 ? 3 : 4}`} />
        ))}
      </div>
    </section>
  );
}

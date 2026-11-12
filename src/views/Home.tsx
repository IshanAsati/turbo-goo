import { useEffect, useMemo, useState } from "react";
import { ArrowRight, FolderPlus, Mic, MoreHorizontal, Pin, Play, Search, Trash2 } from "lucide-react";
import { go } from "../lib/nav";
import { addThread, dayKey, deleteDoc, liveStreak, setMeta, uid, updateDoc, useStore } from "../lib/store";
import { createCourseDoc, createDoc } from "../lib/generate";
import { isYouTube } from "../lib/ingest";
import { hasLLM } from "../lib/llm";
import { attachText, combineSources, kindOf } from "../lib/sources";
import { handOff } from "../lib/handoff";
import { dueCount } from "../lib/srs";
import { SAMPLE_SOURCE, SAMPLE_TITLE } from "../lib/sample";
import { SUBJECT_LIST } from "../lib/subjects";
import type { Doc, Subject } from "../lib/types";
import { confirmDialog, Modal, promptDialog, toast } from "../components/feedback";
import { AttachButton, AttachmentChips, useAttachments } from "../components/SourceTray";
import { Recorder } from "./Recorder";

type Mode = "set" | "course" | "chat";
const MODES: { id: Mode; label: string }[] = [
  { id: "set", label: "Study set" },
  { id: "course", label: "Course" },
  { id: "chat", label: "Chat" },
];
const LONG_TEXT = 200; // typed text at least this long is treated as a source, shorter text as a topic/title
const stripExt = (n: string) => n.replace(/\.[a-z0-9]{2,5}$/i, "");

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

  const due = docs.reduce((n, d) => n + dueCount(d.cards), 0);
  const streak = liveStreak(meta);
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

  // Paste a YouTube link or an image anywhere on the page to attach it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) return void api.addFiles(files);
      const t = e.clipboardData?.getData("text") ?? "";
      if (isYouTube(t)) void api.addLink(t.trim());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  function build() {
    if (!canBuild) return;
    const atts = isSource ? [...api.atts, attachText(text)] : api.atts;
    const typedTitle = isSource ? "" : text;

    if (mode === "chat") {
      const t = addThread({ title: (typedTitle || atts[0]?.name || "New chat").slice(0, 60), attachments: atts });
      if (typedTitle) handOff(t.id, typedTitle);
      return go(`/chat/${t.id}`);
    }
    if (!atts.length) {
      // A bare topic: only an AI provider can research it.
      if (!hasLLM(settings)) return toast("Learning a bare topic needs an AI provider (Settings). Or attach a file, link or notes to build from.", "error");
      return go(`/doc/${createCourseDoc({ title: typedTitle, source: "", kind: "topic", folderId, subject: subject === "auto" ? undefined : subject })}?tab=course`);
    }
    const source = combineSources(atts);
    if (source.trim().length < 40) return toast("There isn't enough text in those sources to build from yet.", "error");
    const title = typedTitle || (atts.length === 1 ? stripExt(atts[0].name) : `${stripExt(atts[0].name)} + ${atts.length - 1} more`);
    const sub = subject === "auto" ? undefined : subject;
    const id = mode === "course" ? createCourseDoc({ title, source, kind: kindOf(atts), folderId, subject: sub }) : createDoc({ title, source, kind: kindOf(atts), folderId, subject: sub });
    go(`/doc/${id}${mode === "course" ? "?tab=course" : ""}`);
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
      <header className="masthead">
        <p className="eyebrow">
          {new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
          {docs.length > 0 && <> · <button className="eyebrow-link" onClick={() => go("/review")}>{due} due</button> · {streak}-day streak</>}
        </p>
        <h1 className="display">{greeting()}. <em>What are we studying?</em></h1>
      </header>

      <section
        className={"composer-box big" + (drag ? " drag" : "")}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
        onDrop={(e) => (e.preventDefault(), setDrag(false), void api.addFiles(e.dataTransfer.files))}
      >
        <textarea
          aria-label="Topic, text or instructions"
          rows={3}
          placeholder="Antitrust law… or paste your lecture notes… or drop a PDF, slides and a YouTube link here"
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
        <div className="composer-foot">
          <AttachButton api={api} />
          <button className="ghost-btn" onClick={() => setRecording(true)}><Mic size={15} /> Record</button>
          <span className="spacer" />
          <select className="subject-select" aria-label="Subject" title="Subject: tunes the notes, flashcards and quiz" value={subject} onChange={(e) => setSubject(e.target.value as Subject | "auto")}>
            <option value="auto">Subject: auto</option>
            {SUBJECT_LIST.filter((x) => x.id !== "general").map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            <option value="general">General</option>
          </select>
          <div className="seg" role="radiogroup" aria-label="What to build">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
          <button className="primary build" disabled={!canBuild} onClick={build}>Build <ArrowRight size={16} /></button>
        </div>
      </section>
      <p className="plan">{plan}{canBuild && <kbd>Ctrl ↵</kbd>}</p>

      {docs.length === 0 ? (
        <section className="first-run">
          <p className="eyebrow">First time?</p>
          <h2 className="display">See what it makes from a messy lecture.</h2>
          <p className="muted">A 5-minute calculus lecture with the chatter filtered out and the math typeset. Works offline, no setup.</p>
          <button className="primary" onClick={trySample}><Play size={16} /> Try the sample lecture</button>
        </section>
      ) : (
        <section className="ledger" aria-label="Library">
          <div className="ledger-head">
            <h2 className="display">Library <span className="tally">{docs.length}</span></h2>
            <div className="searchbox">
              <Search size={15} />
              <input aria-label="Search your library" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="folders">
            <button className={"tabchip" + (folder === "all" ? " on" : "")} onClick={() => setFolder("all")}>All</button>
            {meta.folders.map((f) => (
              <button key={f.id} className={"tabchip" + (folder === f.id ? " on" : "")} onClick={() => setFolder(f.id)}>{f.name}</button>
            ))}
            <button className="tabchip add" onClick={newFolder}><FolderPlus size={13} /> Folder</button>
            {folder !== "all" && folder !== "f-general" && (
              <>
                <button className="link small" onClick={renameFolder}>Rename</button>
                <button className="link small danger-text" onClick={deleteFolder}>Delete</button>
              </>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="muted">{q ? "No matches." : "This folder is empty."}</p>
          ) : (
            <ol className="ledger-list">
              {shown.map((d) => <DocRow key={d.id} d={d} />)}
            </ol>
          )}
          <Heatmap activity={meta.activity} />
        </section>
      )}

      {recording && (
        <Modal onClose={() => setRecording(false)} label="Record lecture">
          <Recorder busy={false} onDone={(title, source, audio) => (setRecording(false), go(`/doc/${createDoc({ title, source, kind: "audio", audio, folderId })}`))} />
          <button className="link" onClick={() => setRecording(false)}>Close</button>
        </Modal>
      )}
    </div>
  );
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Late one" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
};

const KIND: Record<string, string> = { youtube: "Video", audio: "Lecture", file: "File", text: "Text", topic: "Topic", image: "Scan", blank: "Note" };

function DocRow({ d }: { d: Doc }) {
  const { meta } = useStore();
  const [menu, setMenu] = useState(false);
  const due = dueCount(d.cards);
  const done = d.course.filter((s) => s.done).length;
  return (
    <li className="doc-row" tabIndex={0} onClick={() => go(`/doc/${d.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/doc/${d.id}`)}>
      <span className="row-kind">{d.course.length ? "Course" : KIND[d.kind] ?? "Doc"}</span>
      <span className="row-title">{d.pinned && <Pin size={12} />} {d.title}</span>
      <span className="row-meta">
        {d.cards.length} cards · {d.quiz.length} q{d.course.length ? ` · ${done}/${d.course.length} lessons` : ""}
      </span>
      <span className="row-due">{due > 0 && <span className="due-pill">{due} due</span>}</span>
      <span className="row-date">{new Date(d.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" aria-label="Document menu" onClick={() => setMenu(!menu)}><MoreHorizontal size={16} /></button>
        {menu && (
          <div className="menu right" onMouseLeave={() => setMenu(false)}>
            <button onClick={() => (updateDoc(d.id, { pinned: !d.pinned }), setMenu(false))}><Pin size={14} /> {d.pinned ? "Unpin" : "Pin"}</button>
            <button
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

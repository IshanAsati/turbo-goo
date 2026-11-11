import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, Compass, FileText, Flame, FolderPlus, Layers, MoreHorizontal, Mic, Pin, Play, Search, Sparkles, Trash2, Upload, Video } from "lucide-react";
import { go } from "../lib/nav";
import { dayKey, deleteDoc, liveStreak, setMeta, uid, updateDoc, useStore } from "../lib/store";
import { createDoc } from "../lib/generate";
import { ACCEPT, fetchYouTube, ingestFile, isYouTube } from "../lib/ingest";
import { cleanTranscript } from "../lib/text";
import { dueCount } from "../lib/srs";
import { SAMPLE_SOURCE, SAMPLE_TITLE } from "../lib/sample";
import { confirmDialog, Modal, promptDialog, toast } from "../components/feedback";
import { Recorder } from "./Recorder";

type Dialog = null | "text" | "youtube" | "record";

export function Home() {
  const { docs, meta, settings } = useStore();
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<string>("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [ytPrefill, setYtPrefill] = useState("");
  const [working, setWorking] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const due = docs.reduce((n, d) => n + dueCount(d.cards), 0);
  const mastered = docs.reduce((n, d) => n + d.cards.filter((c) => c.mastery >= 80).length, 0);
  const folderId = folder === "all" ? "f-general" : folder;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs
      .filter((d) => (folder === "all" || d.folderId === folder) && (!needle || (d.title + " " + d.notes).toLowerCase().includes(needle)))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  }, [docs, q, folder]);

  async function handleFiles(files: FileList | File[] | null) {
    const f = files && Array.from(files)[0];
    if (!f) return;
    try {
      const r = await ingestFile(f, settings, setWorking);
      if (r.source.trim().length < 40) throw new Error("I couldn't find enough text in that file to build study materials from.");
      setWorking("");
      go(`/doc/${createDoc({ ...r, folderId })}`);
    } catch (e) {
      setWorking("");
      toast((e as Error).message, "error");
    }
  }

  // Paste a YouTube link or an image anywhere on the library page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return;
      const img = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (img) return void handleFiles([img]);
      const t = e.clipboardData?.getData("text") ?? "";
      if (isYouTube(t)) {
        setYtPrefill(t.trim());
        setDialog("youtube");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

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
    <div className="page">
      <header className="hero">
        <div>
          <h1>{greeting()}. What are we learning?</h1>
          <p className="muted">Drop in a lecture, PDF, video or topic. Get notes, flashcards, quizzes and a podcast in about a minute.</p>
        </div>
        {docs.length > 0 && (
          <div className="stats">
            <button className={"stat" + (due ? " hot" : "")} onClick={() => go("/review")} aria-label={`Review ${due} due cards`}>
              <Layers size={18} /> <b>{due}</b> <span>due</span>
            </button>
            <div className="stat"><Flame size={18} /> <b>{liveStreak(meta)}</b> <span>streak</span></div>
            <div className="stat"><Check size={18} /> <b>{mastered}</b> <span>mastered</span></div>
          </div>
        )}
      </header>

      <div className="tiles">
        <Tile icon={<FileText />} title="Paste text" sub="Notes, articles, transcripts" onClick={() => setDialog("text")} />
        <Tile icon={<Upload />} title="Upload" sub="PDF, Word, slides, audio, images" onClick={() => fileRef.current?.click()} />
        <Tile icon={<Mic />} title="Record lecture" sub="Live transcript, crash-safe" onClick={() => setDialog("record")} />
        <Tile icon={<Video />} title="YouTube" sub="Paste a link" onClick={() => setDialog("youtube")} />
        <Tile icon={<Compass />} title="Learn a topic" sub="12-section guided course" onClick={() => go("/learn")} accent />
      </div>
      <input ref={fileRef} hidden type="file" accept={ACCEPT} onChange={(e) => (handleFiles(e.target.files), (e.target.value = ""))} />

      <div
        className={"drop" + (drag ? " drag" : "")}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => (e.preventDefault(), setDrag(false), void handleFiles(e.dataTransfer.files))}
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
      >
        {working ? (
          <div className="working"><span className="spinner" /> {working}</div>
        ) : (
          <>
            <Upload size={22} />
            <b>Drop a file here</b>
            <span className="muted small">PDF · Word · PowerPoint · text · .srt/.vtt · images (OCR) · audio and video (needs an API key)</span>
          </>
        )}
      </div>

      {docs.length === 0 ? (
        <div className="empty">
          <Sparkles size={28} />
          <h2>Start with a sample</h2>
          <p className="muted">See what TurboGoo makes from a messy 5-minute calculus lecture (with the chatter filtered out and the math typeset).</p>
          <button className="primary" onClick={trySample}><Play size={16} /> Try the sample lecture</button>
          <p className="muted small">Works offline with no setup. Add an API key in Settings for much better output.</p>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <div className="searchbox">
              <Search size={16} />
              <input aria-label="Search your library" placeholder="Search your library" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="folders">
            <button className={"chip" + (folder === "all" ? " on" : "")} onClick={() => setFolder("all")}>All</button>
            {meta.folders.map((f) => (
              <button key={f.id} className={"chip" + (folder === f.id ? " on" : "")} onClick={() => setFolder(f.id)}>{f.name}</button>
            ))}
            <button className="chip ghost" onClick={newFolder}><FolderPlus size={14} /> Folder</button>
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
            <div className="grid">
              {shown.map((d) => (
                <DocCard key={d.id} id={d.id} />
              ))}
            </div>
          )}
          <Heatmap activity={meta.activity} />
        </>
      )}

      {dialog && (
        <Modal onClose={() => !working && setDialog(null)} label={dialog}>
          {dialog === "text" && <TextDialog onGo={(title, source) => (setDialog(null), go(`/doc/${createDoc({ title, source, kind: "text", folderId })}`))} />}
          {dialog === "youtube" && <YouTubeDialog initial={ytPrefill} onGo={(title, source, url) => (setDialog(null), setYtPrefill(""), go(`/doc/${createDoc({ title, source, kind: "youtube", sourceUrl: url, folderId })}`))} />}
          {dialog === "record" && <Recorder busy={false} onDone={(title, source, audio) => (setDialog(null), go(`/doc/${createDoc({ title, source, kind: "audio", audio, folderId })}`))} />}
          <button className="link" onClick={() => setDialog(null)}>Close</button>
        </Modal>
      )}
    </div>
  );
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

function Tile({ icon, title, sub, onClick, accent }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void; accent?: boolean }) {
  return (
    <button className={"tile" + (accent ? " accent" : "")} onClick={onClick}>
      <span className="tile-ico">{icon}</span>
      <b>{title}</b>
      <span className="small">{sub}</span>
    </button>
  );
}

function DocCard({ id }: { id: string }) {
  const { docs, meta } = useStore();
  const d = docs.find((x) => x.id === id)!;
  const [menu, setMenu] = useState(false);
  const due = dueCount(d.cards);
  const progress = d.course.length ? d.course.filter((s) => s.done).length / d.course.length : null;
  return (
    <div className="card doc" tabIndex={0} role="link" onClick={() => go(`/doc/${d.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/doc/${d.id}`)}>
      <div className="doc-ico">{d.course.length ? <Compass size={18} /> : d.kind === "youtube" ? <Video size={18} /> : d.kind === "audio" ? <Mic size={18} /> : <BookOpen size={18} />}</div>
      <div className="doc-title">{d.pinned && <Pin size={12} />} {d.title}</div>
      <div className="muted small">
        {d.cards.length} cards · {d.quiz.length} questions
        {due > 0 && <span className="due-pill">{due} due</span>}
      </div>
      {progress !== null && <div className="bar"><div style={{ width: `${progress * 100}%` }} /></div>}
      <div className="muted small">{new Date(d.updatedAt).toLocaleDateString()}</div>
      <button className="icon-btn kebab" aria-label="Document menu" onClick={(e) => (e.stopPropagation(), setMenu(!menu))}>
        <MoreHorizontal size={16} />
      </button>
      {menu && (
        <div className="menu" onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
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
    </div>
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
      <h3>Study activity</h3>
      <div className="heat-grid">
        {cells.map((c) => (
          <i key={c.k} title={`${c.k}: ${c.n}`} className={`l${c.n === 0 ? 0 : c.n < 5 ? 1 : c.n < 15 ? 2 : c.n < 30 ? 3 : 4}`} />
        ))}
      </div>
    </section>
  );
}

function TextDialog({ onGo }: { onGo: (title: string, source: string) => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const ok = text.trim().length >= 40;
  return (
    <>
      <h2>Paste text</h2>
      <input aria-label="Title" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea autoFocus rows={11} aria-label="Source text" placeholder="Paste lecture notes, an article, a textbook chapter, a transcript…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button className="primary" disabled={!ok} onClick={() => onGo(title.trim() || guessTitle(text), text)}>Generate study materials</button>
        {!ok && text.length > 0 && <span className="muted small">Add a little more text (40+ characters).</span>}
      </div>
    </>
  );
}

const guessTitle = (t: string) => t.trim().split(/[\n.!?]/)[0].slice(0, 60) || "Untitled";

function YouTubeDialog({ initial, onGo }: { initial: string; onGo: (title: string, source: string, url: string) => void }) {
  const [url, setUrl] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ error: string; title?: string } | null>(null);
  const [pasted, setPasted] = useState("");

  async function fetchIt(u = url) {
    if (!isYouTube(u)) return setFail({ error: "That doesn't look like a YouTube link." });
    setBusy(true);
    setFail(null);
    const r = await fetchYouTube(u);
    setBusy(false);
    if (r.ok) onGo(r.data.title, r.data.text, u.trim());
    else setFail(r);
  }
  useEffect(() => {
    if (initial) void fetchIt(initial);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <h2>Import from YouTube</h2>
      <input autoFocus aria-label="YouTube URL" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && fetchIt()} />
      <button className="primary" disabled={busy || !url.trim()} onClick={() => fetchIt()}>
        {busy ? <><span className="spinner" /> Fetching transcript…</> : "Get transcript & generate"}
      </button>
      {fail && (
        <div className="callout warn">
          <div>
            <b>{fail.error}</b>
            {!(window as any).turbogoo?.desktop && (
              <p className="small">
                Tip: the TurboGoo <b>desktop app</b> fetches transcripts from your own connection, which YouTube allows. Websites hosted in the cloud are often blocked.
              </p>
            )}
            <p className="small">
              You can still import it: on YouTube open the video, click <b>…more</b> under the title → <b>Show transcript</b>, select all the text, and paste it here. Timestamps are removed automatically.
            </p>
            <textarea rows={6} aria-label="Pasted transcript" placeholder="Paste transcript…" value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <button className="primary" disabled={cleanTranscript(pasted).length < 40} onClick={() => onGo(fail.title || "YouTube video", cleanTranscript(pasted), url.trim())}>
              Use pasted transcript
            </button>
          </div>
        </div>
      )}
    </>
  );
}

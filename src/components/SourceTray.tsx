import { useEffect, useRef, useState } from "react";
import { BookOpen, ClipboardPaste, Ellipsis, FileText, FileUp, Image, Library, Link2, Mic, Paperclip, Plus, SquarePlay, Video, X } from "lucide-react";
import type { Attachment, Doc } from "../lib/types";
import { ACCEPT, isYouTube } from "../lib/ingest";
import { attachDoc, attachFile, attachText, attachYouTube, sizeLabel } from "../lib/sources";
import { getState, useStore } from "../lib/store";
import { Modal, toast } from "./feedback";

/** State + actions for a list of prompt attachments. Files are read one after another so progress stays readable. */
export function useAttachments(initial: Attachment[] = []) {
  const [atts, setAtts] = useState<Attachment[]>(initial);
  const [busy, setBusy] = useState("");
  const add = (a: Attachment[]) => setAtts((cur) => [...cur, ...a.filter((x) => !cur.some((c) => (x.docId && c.docId === x.docId) || (x.url && c.url === x.url)))]);

  async function addFiles(files: FileList | File[] | null | undefined) {
    const list = Array.from(files ?? []);
    for (const [i, f] of list.entries()) {
      try {
        setBusy(`Reading ${f.name}${list.length > 1 ? ` (${i + 1}/${list.length})` : ""}…`);
        add([await attachFile(f, getState().settings, (m) => setBusy(`${f.name}: ${m}`))]);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    }
    setBusy("");
  }
  async function addLink(url: string) {
    setBusy("Fetching transcript…");
    try {
      add([await attachYouTube(url)]);
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setBusy("");
    }
  }
  const addText = (text: string, name?: string) => add([attachText(text, name)]);
  const addDocs = (docs: Doc[]) => add(docs.map(attachDoc));
  const remove = (id: string) => setAtts((cur) => cur.filter((a) => a.id !== id));
  const clear = () => setAtts([]);
  return { atts, setAtts, busy, addFiles, addLink, addText, addDocs, remove, clear };
}

export type AttachApi = ReturnType<typeof useAttachments>;

const ICON: Record<string, React.ReactNode> = {
  youtube: <Video size={13} />,
  audio: <Mic size={13} />,
  image: <Image size={13} />,
  doc: <BookOpen size={13} />,
  text: <ClipboardPaste size={13} />,
};

export function AttachmentChips({ api, compact }: { api: AttachApi; compact?: boolean }) {
  if (!api.atts.length && !api.busy) return null;
  return (
    <ul className={"att-list" + (compact ? " compact" : "")} aria-label="Attached sources">
      {api.atts.map((a, i) => (
        <li key={a.id} className={"att " + a.kind} title={a.name}>
          <span className="att-n">{i + 1}</span>
          {ICON[a.kind] ?? <FileText size={13} />}
          <span className="att-name">{a.name}</span>
          <span className="att-size">{sizeLabel(a.text.length)}</span>
          <button className="att-x" aria-label={`Remove ${a.name}`} onClick={() => api.remove(a.id)}><X size={12} /></button>
        </li>
      ))}
      {api.busy && <li className="att busy" role="status"><span className="spinner" /> {api.busy}</li>}
    </ul>
  );
}

type DialogKind = null | "link" | "text" | "library";

/** Closes a popup menu on Escape or a click outside it. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/** The link / paste text / library dialogs, shared by every entry point that can open them. */
function AttachDialogs({ api, dialog, onClose }: { api: AttachApi; dialog: DialogKind; onClose: () => void }) {
  if (!dialog) return null;
  return (
    <Modal onClose={onClose} label="Attach a source" narrow={dialog !== "library"}>
      {dialog === "link" && <LinkForm onDone={async (u) => (await api.addLink(u)) && onClose()} busy={!!api.busy} />}
      {dialog === "text" && <TextForm onDone={(t, n) => (api.addText(t, n), onClose())} />}
      {dialog === "library" && <LibraryPicker taken={api.atts.map((a) => a.docId).filter(Boolean) as string[]} onDone={(docs) => (api.addDocs(docs), onClose())} />}
    </Modal>
  );
}

function FileInput({ api, inputRef }: { api: AttachApi; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return <input ref={inputRef} hidden multiple type="file" accept={ACCEPT} aria-label="Choose files" onChange={(e) => (void api.addFiles(e.target.files), (e.target.value = ""))} />;
}

/** The "+ Attach" button and its menu: files, YouTube link, pasted text, library documents. */
export function AttachButton({ api, label = "Attach" }: { api: AttachApi; label?: string }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wrap = useDismiss(open, () => setOpen(false));
  const pick = (d: DialogKind) => (setOpen(false), setDialog(d));
  return (
    <div className="menu-wrap" ref={wrap}>
      <button className="ghost-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!!api.busy}>
        <Paperclip size={15} /> {label}
      </button>
      {open && (
        <div className="menu up" role="menu">
          <button role="menuitem" onClick={() => (setOpen(false), fileRef.current?.click())}><Plus size={14} /> Files <small>PDF, Word, slides, images, audio</small></button>
          <button role="menuitem" onClick={() => pick("link")}><Link2 size={14} /> YouTube link</button>
          <button role="menuitem" onClick={() => pick("text")}><ClipboardPaste size={14} /> Paste text</button>
          <button role="menuitem" onClick={() => pick("library")}><Library size={14} /> From your library</button>
        </div>
      )}
      <FileInput api={api} inputRef={fileRef} />
      <AttachDialogs api={api} dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

/**
 * The row of source pills in a composer: Record (when `onRecord` is given), Upload, YouTube, and a "More" menu
 * (paste text, from your library). All of them add to the same `useAttachments` state.
 */
export function SourcePills({ api, onRecord, menuDir = "below" }: { api: AttachApi; onRecord?: () => void; menuDir?: "up" | "below" }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wrap = useDismiss(open, () => setOpen(false));
  const busy = !!api.busy;
  const pick = (d: DialogKind) => (setOpen(false), setDialog(d));
  return (
    <>
      {onRecord && (
        <button className="src-pill" onClick={onRecord} disabled={busy}><Mic size={15} className="i-rec" aria-hidden /> Record</button>
      )}
      <button className="src-pill" onClick={() => fileRef.current?.click()} disabled={busy}><FileUp size={15} className="i-up" aria-hidden /> Upload</button>
      <button className="src-pill" onClick={() => setDialog("link")} disabled={busy}><SquarePlay size={15} className="i-yt" aria-hidden /> YouTube</button>
      <div className="menu-wrap" ref={wrap}>
        <button className="src-pill more" aria-haspopup="menu" aria-expanded={open} aria-label="More ways to add a source" title="More: paste text, from your library" onClick={() => setOpen(!open)} disabled={busy}>
          <Ellipsis size={16} aria-hidden />
        </button>
        {open && (
          <div className={"menu " + menuDir} role="menu">
            <button role="menuitem" onClick={() => pick("text")}><ClipboardPaste size={14} /> Paste text</button>
            <button role="menuitem" onClick={() => pick("library")}><Library size={14} /> From your library</button>
          </div>
        )}
      </div>
      <FileInput api={api} inputRef={fileRef} />
      <AttachDialogs api={api} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function LinkForm({ onDone, busy }: { onDone: (url: string) => void; busy: boolean }) {
  const [url, setUrl] = useState("");
  const ok = isYouTube(url);
  return (
    <>
      <h2>Attach a YouTube video</h2>
      <p className="muted small">The transcript is fetched and attached. Works best in the desktop app.</p>
      <input autoFocus aria-label="YouTube link" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok && onDone(url)} />
      <div className="row end">
        <button className="primary" disabled={!ok || busy} onClick={() => onDone(url)}>{busy ? <><span className="spinner" /> Fetching…</> : "Attach"}</button>
      </div>
    </>
  );
}

function TextForm({ onDone }: { onDone: (text: string, name: string) => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  return (
    <>
      <h2>Paste text</h2>
      <input placeholder="Name (optional)" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea autoFocus rows={10} aria-label="Text" placeholder="Lecture notes, an article, a transcript…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row end">
        <button className="primary" disabled={text.trim().length < 20} onClick={() => onDone(text, name)}>Attach</button>
      </div>
    </>
  );
}

function LibraryPicker({ taken, onDone }: { taken: string[]; onDone: (docs: Doc[]) => void }) {
  const { docs } = useStore();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const shown = docs.filter((d) => !taken.includes(d.id) && d.title.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <>
      <h2>Attach from your library</h2>
      <input autoFocus aria-label="Filter documents" placeholder="Filter documents" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="pick-list">
        {shown.map((d) => (
          <li key={d.id}>
            <label className="check">
              <input type="checkbox" checked={sel.has(d.id)} onChange={() => toggle(d.id)} />
              <span>{d.title}</span>
              <small className="muted">{sizeLabel((d.source || d.notes).length)}</small>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="muted small">{docs.length ? "No matching documents." : "Your library is empty."}</li>}
      </ul>
      <div className="row end">
        <button className="primary" disabled={!sel.size} onClick={() => onDone(docs.filter((d) => sel.has(d.id)))}>Attach {sel.size || ""}</button>
      </div>
    </>
  );
}

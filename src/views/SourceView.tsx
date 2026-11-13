import { Fragment, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, FilePen, FileText, FileUp, Image as ImageIcon, Lightbulb, Mic, Video } from "lucide-react";
import { loadAudio } from "../lib/store";
import type { Doc, DocKind } from "../lib/types";
import { toast } from "../components/feedback";

const KIND: Record<DocKind, { icon: typeof FileText; label: string }> = {
  blank: { icon: FilePen, label: "Blank document" },
  text: { icon: FileText, label: "Pasted text" },
  file: { icon: FileUp, label: "Uploaded file" },
  audio: { icon: Mic, label: "Recording" },
  youtube: { icon: Video, label: "Video transcript" },
  topic: { icon: Lightbulb, label: "Topic" },
  image: { icon: ImageIcon, label: "Image" },
};

/** The original material a document was built from: readable, selectable, with the recording if there is one. */
export function SourceView({ doc }: { doc: Doc }) {
  const { icon: Icon, label } = KIND[doc.kind] ?? KIND.text;
  const [audio, setAudio] = useState("");
  const words = useMemo(() => (doc.source.match(/\S+/g) ?? []).length, [doc.source]);
  const parts = useMemo(() => doc.source.split(/(\[\?\])/), [doc.source]);

  useEffect(() => {
    let u = "";
    let dead = false;
    if (doc.hasAudio) {
      loadAudio(doc.id).then((b) => {
        if (b && !dead) setAudio((u = URL.createObjectURL(b)));
      });
    }
    return () => {
      dead = true;
      if (u) URL.revokeObjectURL(u);
      setAudio("");
    };
  }, [doc.id, doc.hasAudio]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(doc.source);
      toast("Source copied.", "ok");
    } catch {
      toast("Couldn't copy. Select the text and press Ctrl+C.", "error");
    }
  };

  if (!doc.source.trim() && !audio && !doc.sourceUrl) {
    return (
      <div className="sv sv-empty">
        <Icon size={30} aria-hidden />
        <h2>No source material</h2>
        <p className="muted">This document was started from a blank page, so there is nothing to show here. Anything you add through the Notes tab stays in your notes.</p>
      </div>
    );
  }

  return (
    <div className="sv">
      <header className="sv-head">
        <span className="sv-kind" aria-hidden><Icon size={20} /></span>
        <div className="sv-meta">
          <h2>Source</h2>
          <p className="muted small">
            {label} · {doc.source.length.toLocaleString()} characters · {words.toLocaleString()} words
          </p>
        </div>
        <span className="spacer" />
        {doc.sourceUrl && (
          <a className="sv-link" href={doc.sourceUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={15} /> Open original
          </a>
        )}
        <button onClick={copy} disabled={!doc.source}><Copy size={15} /> Copy</button>
      </header>

      {audio && (
        <div className="sv-audio">
          <b className="small">Original recording</b>
          <audio controls src={audio} preload="metadata" />
        </div>
      )}

      {doc.source ? (
        <div className="sv-text" tabIndex={0} aria-label="Source text">
          {parts.map((p, i) => (p === "[?]" ? <mark key={i} className="sv-flag" title="You flagged this moment while recording">?</mark> : <Fragment key={i}>{p}</Fragment>))}
        </div>
      ) : (
        <p className="muted">There is no text for this source, only the recording above.</p>
      )}
    </div>
  );
}

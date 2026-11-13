import { lazy, Suspense, useEffect, useState } from "react";
import { useRoute } from "./lib/nav";
import { useStore } from "./lib/store";
import { DialogHost, Toaster } from "./components/feedback";
import { Palette } from "./components/Palette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TopBar } from "./components/TopBar";
import { Home } from "./views/Home";

const DocView = lazy(() => import("./views/DocView").then((m) => ({ default: m.DocView })));
const ChatPage = lazy(() => import("./views/ChatPage").then((m) => ({ default: m.ChatPage })));
const LearnHome = lazy(() => import("./views/Learn").then((m) => ({ default: m.LearnHome })));
const Stream = lazy(() => import("./views/Stream").then((m) => ({ default: m.Stream })));
const Review = lazy(() => import("./views/Review").then((m) => ({ default: m.Review })));
const Schedule = lazy(() => import("./views/Schedule").then((m) => ({ default: m.Schedule })));
const SettingsView = lazy(() => import("./views/SettingsView").then((m) => ({ default: m.SettingsView })));

export function App() {
  const route = useRoute();
  const { ready } = useStore();
  const [palette, setPalette] = useState(false);
  const [, a, rest] = route.split("/");
  const [id, query] = (rest ?? "").split("?");
  const tabParam = new URLSearchParams(query ?? "").get("tab");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="splash"><span className="wordmark">TurboGoo</span></div>;

  let view;
  if (a === "doc" && id) view = <DocView key={id} id={id} initialTab={tabParam ?? undefined} />;
  else if (a === "chat") view = <ChatPage id={id || undefined} />;
  else if (a === "learn") view = <LearnHome />;
  else if (a === "stream") view = <Stream />;
  else if (a === "review") view = <Review />;
  else if (a === "schedule") view = <Schedule />;
  else if (a === "settings") view = <SettingsView />;
  else view = <Home />;

  return (
    <div className={"shell" + (a === "chat" ? " full" : "")}>
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), document.getElementById("main")?.focus())}>Skip to content</a>
      <TopBar section={a || undefined} docId={a === "doc" ? id : undefined} onSearch={() => setPalette(true)} />
      <main className="main" id="main" tabIndex={-1}>
        <Suspense fallback={<div className="page muted">Loading…</div>}><ErrorBoundary resetKey={`${a}/${id ?? ""}`}>{view}</ErrorBoundary></Suspense>
      </main>
      <Palette open={palette} onClose={() => setPalette(false)} />
      <Toaster />
      <DialogHost />
    </div>
  );
}

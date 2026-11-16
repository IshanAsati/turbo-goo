import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
// Global styles first: each screen imports its own stylesheet from its component, and those must load after these to win.
import "./styles.css";
import "./styles/theme.css";
import { App } from "./App";
import { hydrate } from "./lib/store";
import { loadPublik } from "./lib/publik";

async function boot() {
  // The desktop shell's publik state is read before the first screen, so AI calls already know whether publik is on.
  await loadPublik();
  void hydrate();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void boot();

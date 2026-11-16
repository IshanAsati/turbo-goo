import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, Menu, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { getTranscript, setFetch } from "../server/youtube";
import { credentialPath, ensureSignedIn, readCredential, type GateScreen, type GateUI } from "./publik";

/**
 * TurboGoo desktop shell.
 *
 * - The built web app is served from a custom `turbogoo://app` origin (no TCP port is opened).
 * - /api/youtube runs here in the main process, so captions are fetched from the user's own connection
 *   (cloud servers are blocked by YouTube; residential IPs are not).
 * - CORS is relaxed for this app's own pages only, so any AI provider (Groq, OpenRouter, local Ollama...) works.
 */

const SCHEME = "turbogoo";
const ORIGIN = `${SCHEME}://app`;
const DEV_URL = process.env.TURBOGOO_DEV_URL; // e.g. http://localhost:5173 for hot-reload development
const DIST = path.join(app.getAppPath(), "dist");

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit(); // quit() is async: the whenReady handler below must not also open a second window

let win: BrowserWindow | null = null;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net blob:", // jsdelivr: Tesseract OCR worker
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src *",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Exact origin match: a prefix test would accept http://localhost:5173.evil.com or turbogoo://app-evil. */
function isOurPage(url: string | undefined) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === `${SCHEME}:`) return u.host === "app";
    return !!DEV_URL && u.origin === new URL(DEV_URL).origin;
  } catch {
    return false;
  }
}

async function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname !== "app") return new Response("Not found", { status: 404 });

  if (url.pathname === "/api/youtube") {
    try {
      const t = await getTranscript(url.searchParams.get("url") ?? "", url.searchParams.get("lang") ?? "en");
      return Response.json(t);
    } catch (e: any) {
      return Response.json({ error: e.message, title: e.title ?? "" }, { status: 502 });
    }
  }

  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 }); // malformed %-escape
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = path.normalize(path.join(DIST, rel));
  if (full !== DIST && !full.startsWith(DIST + path.sep)) return new Response("Forbidden", { status: 403 }); // path traversal guard

  let target = full;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    if (path.extname(rel)) return new Response("Not found", { status: 404 });
    target = path.join(DIST, "index.html"); // SPA fallback
  }
  const res = await net.fetch(pathToFileURL(target).toString());
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  // Always revalidate: after a rebuild, a cached index.html would keep loading the previous build's code.
  headers.set("Cache-Control", "no-cache");
  return new Response(res.body, { status: res.status, headers });
}

function hardenSession() {
  const ses = session.defaultSession;

  // Only the microphone, only for our own pages.
  ses.setPermissionRequestHandler((wc, permission, cb, details: any) => {
    const ok = isOurPage(details.requestingUrl ?? wc.getURL());
    if (permission === "media") return cb(ok && (details.mediaTypes ?? []).every((t: string) => t === "audio"));
    cb(ok && ["notifications", "clipboard-sanitized-write", "fullscreen"].includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => isOurPage(origin) && ["media", "notifications", "clipboard-sanitized-write", "fullscreen"].includes(permission));

  // Local model servers (Ollama, LM Studio) reject browser Origins; strip it for loopback requests from our pages.
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = { ...details.requestHeaders };
    // publik API: the page sends a placeholder key. The real install key is added here, and only for requests from this app's
    // own page to publik's API. The page never holds the key.
    const auth = h["Authorization"] ?? h["authorization"];
    if (auth === `Bearer ${PUBLIK_PLACEHOLDER}` && details.url.startsWith(`${PUBLIK_API}/`) && details.webContents && isOurPage(details.webContents.getURL())) {
      const cred = readCredential();
      if (cred) {
        delete h["authorization"];
        h["Authorization"] = `Bearer ${cred.key}`;
      }
    }
    try {
      const host = new URL(details.url).hostname;
      const origin = h["Origin"] ?? h["origin"];
      const ours = origin === ORIGIN || (!!DEV_URL && origin === new URL(DEV_URL).origin);
      if (ours && (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1")) {
        delete h["Origin"];
        delete h["origin"];
      }
    } catch {
      /* ignore */
    }
    cb({ requestHeaders: h });
  });

  // Let our own pages call any AI provider regardless of its CORS policy.
  ses.webRequest.onHeadersReceived((details, cb) => {
    const fromUs = details.webContents && isOurPage(details.webContents.getURL()) && !details.url.startsWith(`${SCHEME}:`) && !details.url.startsWith("file:") && !details.url.startsWith("devtools:");
    if (!fromUs) return cb({});
    const headers: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(details.responseHeaders ?? {})) if (!k.toLowerCase().startsWith("access-control-")) headers[k] = v;
    headers["Access-Control-Allow-Origin"] = [DEV_URL ? new URL(DEV_URL).origin : ORIGIN];
    headers["Access-Control-Allow-Headers"] = ["Authorization, Content-Type, Accept, X-Requested-With, OpenAI-Organization, X-Api-Key"];
    headers["Access-Control-Allow-Methods"] = ["GET, POST, PUT, PATCH, DELETE, OPTIONS"];
    headers["Vary"] = ["Origin"];
    cb({ responseHeaders: headers, ...(details.method === "OPTIONS" ? { statusLine: "HTTP/1.1 204 No Content" } : {}) });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    show: false,
    title: "TurboGoo",
    backgroundColor: "#f6f6fb",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win?.show());

  // External links open in the real browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isOurPage(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  void win.loadURL(DEV_URL ?? `${ORIGIN}/`);
  win.on("closed", () => (win = null));
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

/** Saves a PDF that the renderer built itself (the study schedule). Only PDFs, only from our own page, size-capped. */
ipcMain.handle("save-pdf", async (event, rawName: unknown, rawBytes: unknown) => {
  if (!isOurPage(event.senderFrame?.url)) throw new Error("Not allowed from this page.");
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : rawBytes instanceof ArrayBuffer ? new Uint8Array(rawBytes) : null;
  if (!bytes || bytes.length < 8 || bytes.length > 50 * 1024 * 1024) throw new Error("That isn't a PDF.");
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new Error("That isn't a PDF.");
  const name = (String(rawName ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/\.pdf$/i, "").slice(0, 80) || "TurboGoo study plan") + ".pdf";
  const testPath = !app.isPackaged ? process.env.TURBOGOO_TEST_PDF : undefined;
  let file = testPath;
  if (!file) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = { defaultPath: path.join(app.getPath("documents"), name), filters: [{ name: "PDF", extensions: ["pdf"] }] };
    const pick = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts));
    if (pick.canceled || !pick.filePath) return null;
    file = pick.filePath.toLowerCase().endsWith(".pdf") ? pick.filePath : pick.filePath + ".pdf";
  }
  fs.writeFileSync(file, Buffer.from(bytes));
  if (!testPath) void shell.openPath(file);
  return file;
});
/** "Save as PDF": render the page with its print stylesheet (the notes layout), ask where to save, write it, open it. */
ipcMain.handle("export-pdf", async (event, rawTitle: unknown) => {
  if (!isOurPage(event.senderFrame?.url)) throw new Error("Not allowed from this page.");
  const wc = event.sender;
  const name = (String(rawTitle ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "TurboGoo notes") + ".pdf";
  const data = await wc.printToPDF({ printBackground: true, pageSize: "A4", preferCSSPageSize: false, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  // Test hook, only in an unpackaged build: skip the dialog so automation can check the file.
  const testPath = !app.isPackaged ? process.env.TURBOGOO_TEST_PDF : undefined;
  let file = testPath;
  if (!file) {
    const win = BrowserWindow.fromWebContents(wc);
    const pick = await (win ? dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), name), filters: [{ name: "PDF", extensions: ["pdf"] }] }) : dialog.showSaveDialog({ defaultPath: path.join(app.getPath("documents"), name), filters: [{ name: "PDF", extensions: ["pdf"] }] }));
    if (pick.canceled || !pick.filePath) return null;
    file = pick.filePath.toLowerCase().endsWith(".pdf") ? pick.filePath : pick.filePath + ".pdf";
  }
  fs.writeFileSync(file, data);
  if (!testPath) void shell.openPath(file);
  return file;
});

/* ---------------- publik: optional sign-in, usage counting and publik API ----------------
 * The choice is asked once, on first launch, and remembered. "Continue without publik" means no sign-in, no publik key,
 * no usage counting and no request to publik: the app runs as it did before. The gate itself (sign-in screen, plan screen,
 * usage counting) is publik's module in ./publik; this file only decides when it runs, and adds the skip buttons. */

/** The page's placeholder key (src/lib/publik.ts) and publik's API base. Requests to that base get the real key added here. */
const PUBLIK_API = "https://publikhq.com/api/v1";
const PUBLIK_PLACEHOLDER = "publik-managed";
const SKIP_FOR_GOOD = "Continue without publik";
const SKIP_NOW = "Not now";

type Stored = { mode: "unset" | "signed_in" | "skipped"; ai: boolean };
const stateFile = () => path.join(app.getPath("userData"), "publik-mode.json");
function loadStored(): Stored {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (j.mode === "signed_in" || j.mode === "skipped") return { mode: j.mode, ai: j.mode === "signed_in" && j.ai === true };
  } catch {
    /* no choice saved yet */
  }
  return { mode: "unset", ai: false };
}
function saveStored(s: Stored) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s));
}
let stored = loadStored();
let connected = false; // the publik gate passed in this run
let started = false; // the window exists or is about to; "activate" must not open a second one during the gate

/** Thrown from a gate dialog when the person skips. forGood: "Continue without publik" (remembered); false: "Not now" (asked again). */
class PublikSkip extends Error {
  constructor(readonly forGood: boolean) {
    super("publik skipped");
  }
}

/** Draws publik's gate screens as native dialogs. The skip buttons are added here, not in the module. */
function gateUI(parent: BrowserWindow | null): GateUI {
  return {
    async show(screen: GateScreen, signal: AbortSignal) {
      // "unreachable" is a connection problem, so it only offers "Not now" (a skip for good would be wrong while offline).
      const offerForGood = screen.id !== "unreachable";
      const labels = [...screen.buttons.map((b) => b.label), ...(offerForGood ? [SKIP_FOR_GOOD] : []), SKIP_NOW];
      const opts = {
        type: "question" as const,
        title: "TurboGoo",
        message: screen.title,
        detail: [screen.body, screen.note].filter(Boolean).join("\n\n"),
        buttons: labels,
        defaultId: 0,
        cancelId: labels.length - 1, // closing the dialog counts as "Not now"
        noLink: true,
        signal,
      };
      const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      if (response < screen.buttons.length) return screen.buttons[response]!.action;
      throw new PublikSkip(offerForGood && response === screen.buttons.length);
    },
    openUrl: (url) => void shell.openExternal(url),
  };
}

type Outcome = "connected" | "skipped" | "not_now";
/** "Continue without publik": remembered, and no publik key is left on this computer. */
function skipForGood() {
  stored = { mode: "skipped", ai: false };
  saveStored(stored);
  fs.rmSync(credentialPath(), { force: true });
}
let gate: Promise<Outcome> | null = null;
/** Runs publik's gate, one at a time: at start-up, or from Settings. */
function runGate(parent: BrowserWindow | null): Promise<Outcome> {
  gate ??= (async (): Promise<Outcome> => {
    try {
      const r = await ensureSignedIn(gateUI(parent));
      connected = true;
      stored = { mode: "signed_in", ai: r.choice === "publik" };
      saveStored(stored);
      return "connected";
    } catch (e) {
      if (e instanceof PublikSkip) {
        if (!e.forGood) return "not_now";
        skipForGood();
        return "skipped";
      }
      dialog.showErrorBox("TurboGoo", `Couldn't finish signing in with publik: ${(e as Error).message}`);
      return "not_now";
    } finally {
      gate = null;
    }
  })();
  return gate;
}

/** Start-up. A person who signed in gets the gate before the window. A first-time user is asked once; the answer is remembered. */
async function startupGate(): Promise<void> {
  if (stored.mode === "signed_in") {
    await runGate(null);
    return;
  }
  if (stored.mode !== "unset") return;
  const r = await dialog.showMessageBox({
    type: "question",
    title: "TurboGoo",
    message: "Sign in with publik?",
    detail:
      "Signing in lets publik count your use of TurboGoo, and gives you publik API: AI for TurboGoo without a key of your own. It is optional.\n\n" +
      "Continue without publik uses TurboGoo as before. Nothing is sent to publik. You can change this later in Settings.\n\n" +
      "Not now asks again the next time you start TurboGoo.",
    buttons: ["Sign in with publik", SKIP_FOR_GOOD, SKIP_NOW],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (r.response === 0) await runGate(null);
  else if (r.response === 1) skipForGood();
}

const publikStatus = () => ({ mode: stored.mode, signedIn: connected, ai: stored.ai });
/** Only the app's own page may use these calls. */
const fromOurPage = (e: IpcMainInvokeEvent) => {
  if (!isOurPage(e.senderFrame?.url)) throw new Error("Not allowed from this page.");
};
ipcMain.handle("publik:status", (e) => (fromOurPage(e), publikStatus()));
ipcMain.handle("publik:sign-in", async (e) => {
  fromOurPage(e);
  await runGate(BrowserWindow.fromWebContents(e.sender));
  return publikStatus();
});
ipcMain.handle("publik:set-ai", (e, on: unknown) => {
  fromOurPage(e);
  if (!connected) throw new Error("Sign in with publik first.");
  stored = { ...stored, ai: on === true };
  saveStored(stored);
  return publikStatus();
});
ipcMain.handle("publik:turn-off", (e) => {
  fromOurPage(e);
  stored = { mode: "skipped", ai: false };
  saveStored(stored);
  connected = false;
  fs.rmSync(credentialPath(), { force: true }); // no publik key left on this computer
  setTimeout(() => {
    app.relaunch(); // a restart is what stops usage counting: the module's timer lives in this process
    app.exit(0);
  }, 800);
  return publikStatus();
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  setFetch(((input: any, init: any) => net.fetch(input, init)) as typeof fetch);
  protocol.handle(SCHEME, serve);
  hardenSession();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" as const },
    { role: "editMenu" as const },
    { role: "viewMenu" as const },
    { role: "windowMenu" as const },
  ]));
  if (process.env.PUBLIK_SELF_TEST) {
    // The build check: the module prints its self-test line and exits. It never shows the first-launch choice.
    await ensureSignedIn(gateUI(null));
    return;
  }
  try {
    await startupGate();
  } catch (e) {
    dialog.showErrorBox("TurboGoo", `publik: ${(e as Error).message}`);
  }
  started = true;
  createWindow();
});
app.on("activate", () => started && BrowserWindow.getAllWindows().length === 0 && createWindow());


app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());

import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, Menu } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { getTranscript, setFetch } from "../server/youtube";

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

app.whenReady().then(() => {
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
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());

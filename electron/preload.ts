import { contextBridge, ipcRenderer } from "electron";

// Small, explicit surface for the UI: it can tell it's the desktop app, and ask the main process to save the open notes as a PDF.
contextBridge.exposeInMainWorld("turbogoo", {
  desktop: true,
  platform: process.platform,
  /** Renders the current page's print layout to a PDF, asks where to save it, and opens it. Resolves to the saved path, or null if cancelled. */
  exportPdf: (title: string): Promise<string | null> => ipcRenderer.invoke("export-pdf", String(title ?? "")),
});
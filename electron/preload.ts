import { contextBridge } from "electron";

// Minimal, read-only surface so the UI can tell it's running as the desktop app.
contextBridge.exposeInMainWorld("turbogoo", { desktop: true, platform: process.platform });

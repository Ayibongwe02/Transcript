/**
 * Always-on-top companion shell for Knowledge Hub live sessions.
 *
 * Usage:
 *   cd companion && npm install
 *   KH_URL=http://127.0.0.1:8080/minutes npm start
 */
import { app, BrowserWindow, session, shell, systemPreferences } from "electron";

const KH_URL = process.env.KH_URL || "http://127.0.0.1:8080/minutes";

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 520,
    minWidth: 320,
    minHeight: 300,
    alwaysOnTop: true,
    frame: true,
    title: "Knowledge Hub — Live",
    backgroundColor: "#0e0f0c",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Allow mic + display-capture (system/tab audio) from the hub origin
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = new Set([
      "media",
      "microphone",
      "display-capture",
      "mediaKeySystem",
    ]);
    callback(allow.has(permission));
  });

  void win.loadURL(KH_URL);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  // macOS: prompt for mic early so getUserMedia is less surprising
  if (process.platform === "darwin" && systemPreferences?.askForMediaAccess) {
    try {
      await systemPreferences.askForMediaAccess("microphone");
    } catch {
      /* ignore */
    }
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent, OnBeforeSendHeadersListenerDetails, WebRequest } from "electron";
import { buildCompanionWindowOptions, registerCompanionWindowIpc } from "../dist/main/companion-window.js";
import { DESKTOP_IPC_CHANNELS as channels } from "../dist/shared/ipc-channels.js";

class WindowFixture extends EventEmitter {
  destroyed = false; shown = 0; focused = 0;
  url = "file:///safe/index.html";
  sent: unknown[][] = [];
  webContents = Object.assign(new EventEmitter(), {
    id: 1, mainFrame: { url: this.url, detached: false }, isDestroyed: () => this.destroyed,
    getURL: () => this.url, send: (...values: unknown[]) => { this.sent.push(values); },
    setWindowOpenHandler: (_callback: unknown) => {},
  });
  removeMenu() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  show() { this.shown++; }
  focus() { this.focused++; }
  async loadFile(path: string, options: { query: Record<string, string> }) {
    const url = pathToFileURL(path); url.search = new URLSearchParams(options.query).toString();
    this.url = url.href; this.webContents.mainFrame.url = this.url;
  }
  asWindow() { return this as unknown as BrowserWindow; }
  event() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame } as unknown as IpcMainInvokeEvent; }
}

function fixture() {
  const main = new WindowFixture(); let nextId = 2;
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  type Listener = Parameters<WebRequest["onBeforeSendHeaders"]>[0];
  let network: Listener;
  const onBeforeSendHeaders: WebRequest["onBeforeSendHeaders"] = (first: Electron.WebRequestFilter | Listener, second?: Listener) => {
    network = typeof first === "function" ? first : second ?? null;
  };
  const windows: WindowFixture[] = [];
  const dispose = registerCompanionWindowIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } },
    getMainWindow: () => main.asWindow(), webIndexPath: "/safe/index.html", daemonBaseUrl: "http://127.0.0.1:17891",
    getWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    createWindow: () => { const window = new WindowFixture(); window.webContents.id = nextId++; windows.push(window); return window.asWindow(); },
    webRequest: { onBeforeSendHeaders },
  });
  return { main, windows, dispose, handlers,
    call: (channel: string, event: IpcMainInvokeEvent = main.event(), ...args: unknown[]) => handlers.get(channel)!(event, ...args),
    headers: (window: WindowFixture, patch: Partial<OnBeforeSendHeadersListenerDetails> = {}) => {
      let headers: Record<string, string | string[]> | undefined;
      network!({ url: "http://127.0.0.1:17891/companions?cwd=%2Fw", method: "GET", webContentsId: window.webContents.id,
        webContents: window.webContents, frame: window.webContents.mainFrame, requestHeaders: { Origin: "null" }, ...patch } as OnBeforeSendHeadersListenerDetails,
      response => { headers = response.requestHeaders; });
      return headers;
    },
  };
}

test("desktop companion is a larger transparent sandboxed window clamped to its display", () => {
  const options = buildCompanionWindowOptions({ cwd: "/workspace", daemonBaseUrl: "http://127.0.0.1:17891", workArea: { x: -800, y: 0, width: 800, height: 600 } });
  assert.equal(options.width, 760); assert.equal(options.height, 600); assert.equal(options.x, -760);
  assert.equal(options.transparent, true); assert.equal(options.frame, false); assert.equal(options.alwaysOnTop, true);
  assert.equal(options.webPreferences?.nodeIntegration, false); assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(options.webPreferences?.contextIsolation, true);
  assert.match(options.webPreferences?.preload ?? "", /companion-window\.cjs$/u);
});

test("only the owned main frame opens a companion; the companion closes and returns to settings independently", async () => {
  const f = fixture();
  try {
    const foreign = new WindowFixture(); foreign.webContents.id = 99;
    assert.deepEqual(await f.call(channels.companionWindowOpen, foreign.event(), "/workspace"), { accepted: false, reason: "unauthorized_companion_window_sender" });
    assert.equal(f.windows.length, 0);
    const iframe = { ...f.main.event(), senderFrame: { ...f.main.webContents.mainFrame } } as IpcMainInvokeEvent;
    assert.equal((await f.call(channels.companionWindowOpen, iframe, "/workspace") as { accepted: boolean }).accepted, false);
    assert.equal((await f.call(channels.companionWindowOpen, f.main.event(), "relative") as { accepted: boolean }).accepted, false);
    await f.call(channels.companionWindowOpen, f.main.event(), "/workspace");
    const companion = f.windows[0]!;
    assert.equal(companion.shown, 1);
    await f.call(channels.companionWindowOpen, f.main.event(), "/workspace"); assert.equal(f.windows.length, 1);
    assert.equal((await f.call(channels.companionWindowOpen, companion.event(), "/workspace") as { accepted: boolean }).accepted, false);
    await f.call(channels.companionWindowSettings, companion.event());
    assert.equal(f.main.focused, 1); assert.deepEqual(f.main.sent, [[channels.companionSettingsRequested]]);
    await f.call(channels.companionWindowClose, companion.event()); assert.equal(companion.destroyed, true);
    assert.equal(f.main.destroyed, false);
    await f.call(channels.companionWindowOpen, f.main.event(), "/workspace");
    f.main.destroy(); assert.equal(f.windows[1]!.destroyed, true);
  } finally { f.dispose(); }
  assert.equal(f.handlers.size, 0);
});

test("native Companion requests project opaque Origin only for owned documents and top-level frames", async () => {
  const f = fixture();
  try {
    assert.equal(f.headers(f.main)?.Origin, "http://127.0.0.1:17891");
    await f.call(channels.companionWindowOpen, f.main.event(), "/workspace");
    assert.equal(f.headers(f.windows[0]!)?.Origin, "http://127.0.0.1:17891");
    assert.equal(f.headers(f.main, { frame: null })?.Origin, "null");
    assert.equal(f.headers(f.main, { frame: { ...f.main.webContents.mainFrame } as Electron.WebFrameMain })?.Origin, "null");
    assert.equal(f.headers(f.main, { url: "https://foreign.invalid/companions" })?.Origin, "null");
    assert.equal(f.headers(f.main, { url: "http://127.0.0.1:17891/teammates?cwd=%2Fw" })?.Origin, "http://127.0.0.1:17891");
    assert.equal(f.headers(f.main, { url: "http://127.0.0.1:17891/teammates/teammate_1?cwd=%2Fw" })?.Origin, "null");
    assert.equal(f.headers(f.main, { url: "http://127.0.0.1:17891/providers" })?.Origin, "null");
    f.main.url += "?untrusted=1"; f.main.webContents.mainFrame.url = f.main.url;
    assert.equal(f.headers(f.main)?.Origin, "null");
  } finally { f.dispose(); }
});

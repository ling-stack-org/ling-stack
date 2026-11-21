import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent, OnBeforeSendHeadersListenerDetails, WebRequest } from "electron";
import { buildCompanionWindowOptions, registerCompanionWindowIpc } from "../dist/main/companion-window.js";
import { DESKTOP_IPC_CHANNELS as channels } from "../dist/shared/ipc-channels.js";

class WindowFixture extends EventEmitter {
  destroyed = false; shown = 0; focused = 0;
  bounds = { x: 0, y: 0, width: 760, height: 680 };
  ignoredMouseEvents?: boolean;
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
  getBounds() { return this.bounds; }
  setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
  setIgnoreMouseEvents(ignored: boolean) { this.ignoredMouseEvents = ignored; }
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

test("trusted native documents project loopback Origin for their daemon requests", async () => {
  const f = fixture();
  const base = "http://127.0.0.1:17891";
  try {
    assert.equal(f.headers(f.main)?.Origin, base);
    await f.call(channels.companionWindowOpen, f.main.event(), "/workspace");
    const companion = f.windows[0]!;
    assert.equal(f.headers(companion)?.Origin, base);
    assert.equal(f.headers(companion, { url: `${base}/teammates?cwd=%2Fw` })?.Origin, base);
    assert.equal(f.headers(companion, { url: `${base}/user-input-answers`, method: "POST" })?.Origin, base);
    assert.equal(f.headers(companion, { url: `${base}/approvals/approval-1/approve`, method: "POST" })?.Origin, base);
    assert.equal(f.headers(companion, { url: `${base}/approvals/approval-1`, method: "GET" })?.Origin, base);
    assert.equal(f.headers(companion, { url: `${base}/teammates/teammate_1` })?.Origin, "null");
    assert.equal(f.headers(companion, { url: `${base}/workspaces` })?.Origin, "null");
    assert.equal(f.headers(f.main, { url: `${base}/workspaces`, requestHeaders: {} })?.Origin, base);
    assert.equal(f.headers(f.main, { url: `${base}/workspace/code-assessments`, method: "POST" })?.Origin, base);
    assert.equal(f.headers(f.main, { requestHeaders: { origin: "null" } })?.origin, base);
    const remoteOrigin = { Origin: "https://foreign.invalid" };
    assert.deepEqual(f.headers(f.main, { requestHeaders: remoteOrigin }), remoteOrigin);
    assert.equal(f.headers(f.main, { frame: null })?.Origin, "null");
    assert.equal(f.headers(f.main, { frame: { ...f.main.webContents.mainFrame } as Electron.WebFrameMain })?.Origin, "null");
    assert.equal(f.headers(f.main, { url: "https://foreign.invalid/companions" })?.Origin, "null");
    assert.equal(f.headers(f.main, { url: "http://127.0.0.1:17892/companions" })?.Origin, "null");
    assert.equal(f.headers(f.main, { webContentsId: 99 })?.Origin, "null");
    f.main.url += "?untrusted=1"; f.main.webContents.mainFrame.url = f.main.url;
    assert.equal(f.headers(f.main)?.Origin, "null");
  } finally { f.dispose(); }
});

test("desktop companion returns geometry and accepts bounded transparent layout", async () => {
  const f = fixture();
  try {
    await f.call(channels.companionWindowOpen, f.main.event(), "/workspace");
    const companion = f.windows[0]!;
    const geometry = await f.call(channels.companionWindowGeometryGet, companion.event()) as { bounds: typeof companion.bounds; workArea: { width: number; height: number } };
    assert.equal(geometry.workArea.width, 1440);
    const result = await f.call(channels.companionWindowLayout, companion.event(), {
      bounds: { x: -500, y: -500, width: 2000, height: 2000 },
      anchor: { x: 10, y: 10, width: 100, height: 100 },
      regions: [{ x: 0, y: 0, width: 100, height: 100 }],
      pointerPassthrough: true,
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(companion.ignoredMouseEvents, true);
    assert.deepEqual(companion.bounds, { x: 0, y: 0, width: 1440, height: 900 });

    const navigation = await f.call(channels.companionWindowNavigate, companion.event(), {
      workspace: "/workspace",
      kind: "source",
      sourceId: "approval-1",
      approvalId: "approval-1",
      runId: "run-1",
    });
    assert.deepEqual(navigation, { accepted: true });
    assert.deepEqual(f.main.sent.at(-1), [channels.companionNavigationRequested, {
      workspace: "/workspace",
      kind: "source",
      sourceId: "approval-1",
      approvalId: "approval-1",
      runId: "run-1",
    }]);

    const reportSource = {
      workspace: "/workspace",
      kind: "source",
      sourceId: "report-1",
      reportId: "report-1",
      channelId: "channel-1",
      threadId: "thread-1",
      sourceItemId: "result_terminal_report:report-1",
    };
    assert.deepEqual(await f.call(channels.companionWindowNavigate, companion.event(), reportSource), { accepted: true });
    assert.deepEqual(f.main.sent.at(-1), [channels.companionNavigationRequested, reportSource]);
    assert.deepEqual(await f.call(channels.companionWindowNavigate, companion.event(), {
      ...reportSource, workflowStepId: ["invalid"],
    }), { accepted: false, reason: "invalid_companion_navigation" });
  } finally {
    f.dispose();
  }
});

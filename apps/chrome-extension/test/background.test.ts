import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChromeFixture,
  ChromeFixtureGlobals,
  IntervalHandle,
  MessageListener,
  PopupListener,
  PopupMessage,
  PopupResponse,
  RuntimeListeners,
  SocketEvent,
  StoredValues,
  WireMessage,
} from "./background-fixture-types.ts";

test("stale Chrome sockets cannot clear the current heartbeat or execute commands", async () => {
  const original = {
    chrome: (globalThis as ChromeFixtureGlobals).chrome,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout,
    navigator: globalThis.navigator,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    WebSocket: globalThis.WebSocket,
  };
  const sockets: FakeWebSocket[] = [];
  const activeIntervals = new Set<IntervalHandle>();
  const runtimeListeners: RuntimeListeners = { alarm: undefined, installed: undefined, message: undefined, startup: undefined };
  let tabQueries = 0;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    declare url: string;
    declare readyState: number;
    declare listeners: Map<string, Array<(event: SocketEvent) => void>>;
    declare sent: string[];
    declare closeRequest?: { code?: number; reason?: string };

    constructor(url: string) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type: string, listener: (event: SocketEvent) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close(code?: number, reason?: string) {
      this.closeRequest = { code, reason };
      this.readyState = FakeWebSocket.CLOSING;
    }

    emit(type: string, event: SocketEvent = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    send(value: string) {
      this.sent.push(value);
    }
  }

  const stored: StoredValues = {
    "ling.chrome.credential": "credential",
    "ling.chrome.cwd": "/tmp/ling-chrome-background-test",
    "ling.chrome.daemonBaseUrl": "http://127.0.0.1:17891",
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      alarms: {
        clear: async () => true,
        create: () => undefined,
        get: async () => undefined,
        onAlarm: { addListener: (listener) => { runtimeListeners.alarm = listener; } },
      },
      runtime: {
        connectNative: () => { throw new Error("Specified native messaging host not found"); },
        getManifest: () => ({ version: "0.1.2" }),
        onInstalled: { addListener: (listener) => { runtimeListeners.installed = listener; } },
        onMessage: { addListener: (listener) => { runtimeListeners.message = listener; } },
        onStartup: { addListener: (listener) => { runtimeListeners.startup = listener; } },
        sendMessage: async () => undefined,
      },
      scripting: { executeScript: async () => undefined },
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])),
          remove: async (keys) => { for (const key of keys) delete stored[key]; },
          set: async (values) => Object.assign(stored, values),
        },
        session: {
          get: async () => ({}),
          remove: async () => undefined,
          set: async () => undefined,
        },
      },
      tabs: {
        query: async () => { tabQueries += 1; return []; },
      },
    } satisfies ChromeFixture,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Ling background test" },
  });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  globalThis.setInterval = ((callback: () => void) => {
    const handle = { callback };
    activeIntervals.add(handle);
    return handle;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle: IntervalHandle) => { activeIntervals.delete(handle); }) as unknown as typeof globalThis.clearInterval;
  globalThis.setTimeout = (() => ({ type: "timeout" })) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = () => undefined;

  try {
    await import(`../src/background.js?stale-socket-test=${Date.now()}`);
    await settle();
    assert.equal(sockets.length, 1);
    const first = sockets[0];
    first.open();
    assert.equal(activeIntervals.size, 1);

    assert.ok(runtimeListeners.startup, "expected the startup listener to be registered");
    runtimeListeners.startup();
    runtimeListeners.startup();
    await settle();
    assert.equal(sockets.length, 2);
    const second = sockets[1];
    second.open();
    assert.equal(activeIntervals.size, 1);
    const currentHeartbeat = [...activeIntervals][0];

    first.emit("close", { code: 1000, reason: "ling_session_replaced" });
    assert.equal(activeIntervals.has(currentHeartbeat), true);

    const command = JSON.stringify({
      protocol: "ling.chrome.v1",
      type: "command",
      id: "stale_command",
      method: "chrome_tabs",
      params: {},
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    first.emit("message", { data: command });
    await settle();
    assert.equal(tabQueries, 0);

    second.emit("message", { data: command });
    await settle();
    assert.equal(tabQueries, 1);
    assert.equal(second.sent.some((value) => value.includes('"type":"result"')), true);

    second.emit("close", { code: 4002, reason: "chrome_browser_credential_invalid" });
    await settle();
    assert.equal(stored["ling.chrome.credential"], undefined);
    assert.equal(stored["ling.chrome.cwd"], undefined);
    assert.equal(activeIntervals.size, 0);
  } finally {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: original.chrome });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: original.navigator });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original.WebSocket });
    globalThis.setInterval = original.setInterval;
    globalThis.clearInterval = original.clearInterval;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
  }
});

test("Native connection owns commands and removes legacy workspace credentials after migration", async () => {
  const original = {
    chrome: (globalThis as ChromeFixtureGlobals).chrome,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout,
    navigator: globalThis.navigator,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    WebSocket: globalThis.WebSocket,
  };
  const ports: FakeNativePort[] = [];
  const screenshotCalls: Array<[string, number, object]> = [];
  const activeIntervals = new Set<IntervalHandle>();
  const runtimeListeners: RuntimeListeners = { alarm: undefined, installed: undefined, message: undefined, startup: undefined };
  const stored: StoredValues = {
    "ling.chrome.credential": "legacy-credential",
    "ling.chrome.cwd": "/tmp/legacy-workspace",
    "ling.chrome.daemonBaseUrl": "http://127.0.0.1:17891",
  };

  class FakeNativePort {
    declare messages: WireMessage[];
    declare messageListeners: MessageListener[];
    declare disconnectListeners: Array<() => void>;
    declare disconnected?: boolean;

    constructor() {
      this.messages = [];
      this.messageListeners = [];
      this.disconnectListeners = [];
    }

    onMessage = { addListener: (listener: MessageListener) => this.messageListeners.push(listener) };
    onDisconnect = { addListener: (listener: () => void) => this.disconnectListeners.push(listener) };

    postMessage(message: WireMessage) {
      this.messages.push(message);
    }

    disconnect() {
      this.disconnected = true;
      for (const listener of this.disconnectListeners) listener();
    }

    emitMessage(message: WireMessage) {
      for (const listener of this.messageListeners) listener(message);
    }
  }

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      alarms: {
        clear: async () => true,
        create: () => undefined,
        get: async () => undefined,
        onAlarm: { addListener: (listener) => { runtimeListeners.alarm = listener; } },
      },
      runtime: {
        connectNative: (name) => {
          assert.equal(name, "com.lingstack.browser");
          const port = new FakeNativePort();
          ports.push(port);
          return port;
        },
        getManifest: () => ({ version: "0.1.2" }),
        onInstalled: { addListener: (listener) => { runtimeListeners.installed = listener; } },
        onMessage: { addListener: (listener) => { runtimeListeners.message = listener; } },
        onStartup: { addListener: (listener) => { runtimeListeners.startup = listener; } },
        sendMessage: async () => undefined,
      },
      scripting: { executeScript: async () => undefined },
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])),
          remove: async (keys) => { for (const key of keys) delete stored[key]; },
          set: async (values) => Object.assign(stored, values),
        },
        session: {
          get: async () => ({}),
          remove: async () => undefined,
          set: async () => undefined,
        },
      },
      tabs: {
        captureVisibleTab: async (windowId, options) => {
          screenshotCalls.push(["tabs.captureVisibleTab", windowId, options]);
          return "data:image/jpeg;base64,ZmFrZQ==";
        },
        get: async () => ({ id: 7, windowId: 1, active: true, title: "Ling fixture", url: "https://example.com" }),
        query: async () => [{ id: 7, windowId: 1, active: true, title: "Ling fixture", url: "https://example.com" }],
        update: async (tabId, options) => {
          screenshotCalls.push(["tabs.update", tabId, options]);
          return { id: tabId, windowId: 1, active: true, title: "Ling fixture", url: "https://example.com" };
        },
      },
      windows: {
        update: async (windowId, options) => {
          screenshotCalls.push(["windows.update", windowId, options]);
          return { id: windowId, focused: true };
        },
      },
    } satisfies ChromeFixture,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Chrome/151 Ling native test" },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class UnexpectedWebSocket {
      constructor() { throw new Error("legacy transport must not start when Native is available"); }
    },
  });
  globalThis.setInterval = ((callback: () => void) => {
    const handle = { callback };
    activeIntervals.add(handle);
    return handle;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle: IntervalHandle) => { activeIntervals.delete(handle); }) as unknown as typeof globalThis.clearInterval;
  globalThis.setTimeout = (() => ({ type: "timeout" })) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = () => undefined;

  try {
    await import(`../src/background.js?native-migration-test=${Date.now()}`);
    await settle();
    assert.equal(ports.length, 1);
    assert.deepEqual(ports[0].messages[0], {
      protocol: "ling.chrome.native.v1",
      type: "hello",
      extensionVersion: "0.1.2",
      browserVersion: "Chrome/151 Ling native test",
      paused: false,
    });
    assert.equal("cwd" in ports[0].messages[0], false);

    ports[0].emitMessage({
      protocol: "ling.chrome.native.v1",
      type: "ready",
      connected: true,
      migratedLegacyCredential: true,
    });
    await settle();
    assert.equal(stored["ling.chrome.credential"], undefined);
    assert.equal(stored["ling.chrome.cwd"], undefined);
    assert.equal(stored["ling.chrome.daemonBaseUrl"], undefined);

    assert.ok(runtimeListeners.message, "expected the popup listener to be registered");
    const connected = await sendPopupMessage(runtimeListeners.message, { type: "status" });
    assert.equal(connected.connected, true);
    assert.equal(connected.state, "connected");
    assert.equal(connected.transport, "native_messaging");
    assert.equal(activeIntervals.size, 1);
    [...activeIntervals][0].callback();
    assert.equal(ports[0].messages.some((message) => message.type === "heartbeat"), true);

    ports[0].emitMessage({
      protocol: "ling.chrome.v1",
      type: "command",
      id: "native-tabs",
      method: "chrome_tabs",
      params: {},
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await settle();
    assert.equal(ports[0].messages.some((message) => message.id === "native-tabs" && message.ok === true), true);

    ports[0].emitMessage({
      protocol: "ling.chrome.v1",
      type: "command",
      id: "native-screenshot",
      method: "chrome_screenshot",
      params: { tabId: 7 },
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await settle();
    assert.deepEqual(screenshotCalls, [
      ["windows.update", 1, { focused: true }],
      ["tabs.update", 7, { active: true }],
      ["tabs.captureVisibleTab", 1, { format: "jpeg", quality: 75 }],
    ]);
    assert.equal(ports[0].messages.some((message) => message.id === "native-screenshot" && message.ok === true), true);

    const paused = await sendPopupMessage(runtimeListeners.message, { type: "pause" });
    assert.equal(paused.state, "paused");
    assert.equal(stored["ling.chrome.paused"], true);
    assert.equal(ports.length, 2);
    assert.equal(ports[1].messages[0].paused, true);
  } finally {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: original.chrome });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: original.navigator });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original.WebSocket });
    globalThis.setInterval = original.setInterval;
    globalThis.clearInterval = original.clearInterval;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
  }
});

function sendPopupMessage(listener: PopupListener, message: PopupMessage): Promise<PopupResponse> {
  return new Promise<PopupResponse>((resolve, reject) => {
    const keepAlive = listener(message, {}, (response) => {
      if (response?.ok === false) reject(new Error(response.error));
      else resolve(response);
    });
    assert.equal(keepAlive, true);
  });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

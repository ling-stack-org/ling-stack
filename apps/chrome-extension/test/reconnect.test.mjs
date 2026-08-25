import assert from "node:assert/strict";
import { test } from "node:test";

const RECONNECT_ALARM = "ling.chrome.reconnect";
const RECONNECT_ATTEMPT_KEY = "ling.chrome.reconnectAttempt";
const RECONNECT_PERIOD_MINUTES = 0.5;

test("Native disconnect leaves a durable Alarm that reconnects without opening the popup", async () => {
  const original = {
    chrome: globalThis.chrome,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout,
    navigator: globalThis.navigator,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    WebSocket: globalThis.WebSocket,
  };
  const alarms = new Map();
  const localStored = {};
  const sessionStored = {};
  const ports = [];
  const timeouts = new Map();
  let nextTimeoutId = 1;
  let heldAlarmClear;
  const runtimeListeners = { alarm: undefined, installed: undefined, message: undefined, startup: undefined };

  class FakeNativePort {
    constructor() {
      this.messages = [];
      this.messageListeners = [];
      this.disconnectListeners = [];
    }

    onMessage = { addListener: (listener) => this.messageListeners.push(listener) };
    onDisconnect = { addListener: (listener) => this.disconnectListeners.push(listener) };

    postMessage(message) {
      this.messages.push(message);
    }

    disconnect() {
      this.emitDisconnect("");
    }

    emitDisconnect(errorMessage) {
      globalThis.chrome.runtime.lastError = errorMessage ? { message: errorMessage } : undefined;
      for (const listener of this.disconnectListeners) listener();
      delete globalThis.chrome.runtime.lastError;
    }

    emitMessage(message) {
      for (const listener of this.messageListeners) listener(message);
    }
  }

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      alarms: {
        clear: async (name) => {
          if (heldAlarmClear) await heldAlarmClear.promise;
          return alarms.delete(name);
        },
        create: (name, options) => alarms.set(name, options),
        get: async (name) => alarms.get(name),
        onAlarm: { addListener: (listener) => { runtimeListeners.alarm = listener; } },
      },
      runtime: {
        connectNative: () => {
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
        local: storageArea(localStored),
        session: storageArea(sessionStored),
      },
      tabs: { query: async () => [] },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Chrome/151 Ling durable reconnect test" },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class UnexpectedWebSocket {
      constructor() {
        throw new Error("legacy transport must not start in the Native reconnect fixture");
      }
    },
  });
  globalThis.setInterval = () => ({ type: "interval" });
  globalThis.clearInterval = () => undefined;
  globalThis.setTimeout = (callback, delay) => {
    const id = nextTimeoutId++;
    timeouts.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => { timeouts.delete(id); };

  try {
    await import(`../src/background.js?durable-reconnect-test=${Date.now()}`);
    await settle();
    assert.equal(ports.length, 1);

    ports[0].emitDisconnect("Native host has exited.");
    assert.equal(
      alarms.has(RECONNECT_ALARM),
      true,
      "the disconnect listener must register its durable wake-up before yielding",
    );
    await settle();
    assert.equal(typeof runtimeListeners.alarm, "function");
    assert.equal(alarms.has(RECONNECT_ALARM), true);
    assert.deepEqual(alarms.get(RECONNECT_ALARM), {
      delayInMinutes: RECONNECT_PERIOD_MINUTES,
      periodInMinutes: RECONNECT_PERIOD_MINUTES,
    });
    assert.equal(sessionStored[RECONNECT_ATTEMPT_KEY], 1);
    assert.equal([...timeouts.values()][0]?.delay, 1_000);

    runtimeListeners.alarm({ name: "unrelated.alarm" });
    await settle();
    assert.equal(ports.length, 1);

    runtimeListeners.alarm({ name: RECONNECT_ALARM });
    await settle();
    assert.equal(ports.length, 2);
    assert.equal(alarms.has(RECONNECT_ALARM), true);

    heldAlarmClear = deferred();
    ports[1].emitMessage({
      protocol: "ling.chrome.native.v1",
      type: "ready",
      connected: true,
      migratedLegacyCredential: false,
    });
    await settle();
    runtimeListeners.startup();
    await settle();
    assert.equal(ports.length, 3);
    heldAlarmClear.resolve();
    heldAlarmClear = undefined;
    await settle();

    let status = await sendPopupMessage(runtimeListeners.message, { type: "status" });
    assert.equal(status.connected, false);
    ports[2].emitMessage({
      protocol: "ling.chrome.native.v1",
      type: "ready",
      connected: true,
      migratedLegacyCredential: false,
    });
    await settle();
    assert.equal(alarms.has(RECONNECT_ALARM), false);
    assert.equal(sessionStored[RECONNECT_ATTEMPT_KEY], undefined);

    status = await sendPopupMessage(runtimeListeners.message, { type: "status" });
    assert.equal(status.connected, true);
    assert.equal(status.transport, "native_messaging");

    runtimeListeners.alarm({ name: RECONNECT_ALARM });
    await settle();
    assert.equal(ports.length, 3);

    ports[2].emitDisconnect("Native host has exited.");
    await settle();
    assert.equal(alarms.has(RECONNECT_ALARM), true);
    await fireNextTimeout(timeouts);
    assert.equal(ports.length, 4);

    ports[3].emitMessage({
      protocol: "ling.chrome.native.v1",
      type: "ready",
      connected: true,
      migratedLegacyCredential: false,
    });
    await settle();
    ports[3].emitDisconnect("Native host has exited.");
    await settle();
    const paused = await sendPopupMessage(runtimeListeners.message, { type: "pause" });
    assert.equal(paused.state, "paused");
    assert.equal(alarms.has(RECONNECT_ALARM), false);
    assert.equal(sessionStored[RECONNECT_ATTEMPT_KEY], undefined);
    assert.equal(timeouts.size, 0);
    assert.equal(ports.length, 5);

    runtimeListeners.alarm({ name: RECONNECT_ALARM });
    await settle();
    assert.equal(ports.length, 5);

    const resumed = await sendPopupMessage(runtimeListeners.message, { type: "resume" });
    assert.equal(resumed.state, "checking");
    assert.equal(ports.length, 6);
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

function storageArea(stored) {
  return {
    get: async (keys) => Object.fromEntries(
      keys.filter((key) => key in stored).map((key) => [key, stored[key]]),
    ),
    remove: async (keys) => {
      for (const key of keys) delete stored[key];
    },
    set: async (values) => Object.assign(stored, values),
  };
}

function sendPopupMessage(listener, message) {
  return new Promise((resolve, reject) => {
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

async function fireNextTimeout(timeouts) {
  const [id, timeout] = timeouts.entries().next().value ?? [];
  assert.ok(timeout, "expected an active reconnect timeout");
  timeouts.delete(id);
  timeout.callback();
  await settle();
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

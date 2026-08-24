import {
  DEFAULT_DAEMON_BASE_URL,
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL,
  PROTOCOL,
  dataUrlImage,
  isAllowedPageUrl,
  safeTab,
  shouldForgetCredentialAfterSocketClose,
  validateCommand,
  validateNativeControlMessage,
  websocketUrl,
} from "./protocol.js";

const storageKeys = {
  credential: "ling.chrome.credential",
  cwd: "ling.chrome.cwd",
  daemonBaseUrl: "ling.chrome.daemonBaseUrl",
  paused: "ling.chrome.paused",
};
const sessionStorageKeys = {
  reconnectAttempt: "ling.chrome.reconnectAttempt",
};
const RECONNECT_ALARM = "ling.chrome.reconnect";
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_DURABLE_WAKE_MS = 30_000;

let nativeConnection;
let legacySocket;
let heartbeatTimer;
let reconnectTimer;
let connectionLoop;
let connectionRequested = false;
let connectionState = "checking";
let activeTransport = "none";
const intentionalSocketClosures = new WeakSet();
const intentionalNativeClosures = new WeakSet();

chrome.runtime.onInstalled.addListener(() => {
  void requestConnection();
});

chrome.runtime.onStartup.addListener(() => {
  void requestConnection();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  if (["connected", "paused", "plugin_disabled", "incompatible"].includes(connectionState)) {
    void clearReconnectState();
    return;
  }
  clearReconnectTimer();
  void chrome.alarms.clear(RECONNECT_ALARM).then(() => requestConnection());
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handlePopupMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: safeError(error) });
  });
  return true;
});

void requestConnection();

async function handlePopupMessage(message) {
  if (!message || typeof message !== "object") throw new Error("Invalid extension request");
  if (message.type === "status") return { ok: true, ...(await status()) };
  if (message.type === "connect" || message.type === "resume") {
    await chrome.storage.local.set({ [storageKeys.paused]: false });
    await requestConnection({ refresh: true });
    return { ok: true, ...(await status()) };
  }
  if (message.type === "pause") {
    await chrome.storage.local.set({ [storageKeys.paused]: true });
    await requestConnection({ refresh: true });
    return { ok: true, ...(await status()) };
  }
  throw new Error("Unsupported extension request");
}

async function status() {
  const stored = await chrome.storage.local.get([storageKeys.credential, storageKeys.paused]);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const paused = stored[storageKeys.paused] === true;
  return {
    connected: !paused && connectionState === "connected",
    state: paused ? "paused" : connectionState,
    transport: activeTransport,
    legacyCredentialPresent: typeof stored[storageKeys.credential] === "string",
    activeTab: activeTab ? safeTab(activeTab) : undefined,
  };
}

function requestConnection({ refresh = false } = {}) {
  if (connectionLoop) {
    if (refresh) connectionRequested = true;
    return connectionLoop;
  }
  connectionRequested = true;
  connectionLoop = runConnectionLoop()
    .catch(async () => {
      connectionState = "ling_unavailable";
      activeTransport = "none";
      publishStatusChanged();
      await scheduleReconnect();
    })
    .finally(() => {
      connectionLoop = undefined;
      if (connectionRequested) void requestConnection();
    });
  return connectionLoop;
}

async function runConnectionLoop() {
  while (connectionRequested) {
    connectionRequested = false;
    await connectPreferredSession();
  }
}

async function connectPreferredSession() {
  clearConnections();
  const stored = await chrome.storage.local.get([storageKeys.paused]);
  const paused = stored[storageKeys.paused] === true;
  connectionState = paused ? "paused" : "checking";
  activeTransport = "none";
  publishStatusChanged();
  if (paused) await clearReconnectState();
  await connectNativeSession(paused);
}

async function connectNativeSession(paused) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    connectionState = paused ? "paused" : "host_missing";
    publishStatusChanged();
    if (!paused) await fallbackOrReconnect();
    return;
  }
  const connection = { port, errorCode: undefined, connected: false };
  nativeConnection = connection;
  port.onMessage.addListener((message) => {
    if (nativeConnection !== connection) return;
    void handleNativeMessage(connection, message);
  });
  port.onDisconnect.addListener(() => {
    if (nativeConnection !== connection) return;
    nativeConnection = undefined;
    activeTransport = "none";
    clearHeartbeat();
    if (intentionalNativeClosures.has(port)) return;
    const nativeError = chrome.runtime.lastError?.message ?? "";
    if (paused) {
      connectionState = "paused";
      void clearReconnectState();
    } else if (connection.errorCode) {
      connectionState = nativeErrorState(connection.errorCode);
      if (connectionState === "host_missing" || connectionState === "ling_unavailable") {
        void fallbackOrReconnect();
      } else {
        void clearReconnectState();
      }
    } else if (isNativeHostMissingError(nativeError)) {
      connectionState = "host_missing";
      void fallbackOrReconnect();
    } else {
      connectionState = "ling_unavailable";
      void scheduleReconnect();
    }
    publishStatusChanged();
  });
  try {
    port.postMessage({
      protocol: NATIVE_PROTOCOL,
      type: "hello",
      extensionVersion: chrome.runtime.getManifest().version,
      browserVersion: navigator.userAgent,
      paused,
    });
  } catch {
    clearNativeConnection();
    connectionState = paused ? "paused" : "host_missing";
    publishStatusChanged();
    if (!paused) await fallbackOrReconnect();
  }
}

async function handleNativeMessage(connection, message) {
  if (message?.protocol === PROTOCOL && message?.type === "command") {
    await handleDaemonCommand(nativeTarget(connection), message);
    return;
  }
  let control;
  try {
    control = validateNativeControlMessage(message);
  } catch {
    connection.errorCode = "native_protocol_invalid";
    await clearReconnectState();
    if (nativeConnection !== connection) return;
    connectionState = "incompatible";
    publishStatusChanged();
    return;
  }
  if (control.type === "error") {
    connection.errorCode = control.code;
    const nextState = nativeErrorState(control.code);
    if (nextState === "incompatible" || nextState === "plugin_disabled") {
      await clearReconnectState();
    }
    if (nativeConnection !== connection) return;
    connectionState = nextState;
    publishStatusChanged();
    return;
  }
  if (!control.connected) {
    await clearReconnectState();
    if (nativeConnection !== connection) return;
    connectionState = "paused";
    activeTransport = "none";
    publishStatusChanged();
    return;
  }
  await clearReconnectState();
  if (nativeConnection !== connection) return;
  connection.connected = true;
  connectionState = "connected";
  activeTransport = "native_messaging";
  clearLegacySocket();
  startHeartbeat(nativeTarget(connection));
  await chrome.storage.local.remove([
    storageKeys.credential,
    storageKeys.cwd,
    storageKeys.daemonBaseUrl,
  ]);
  if (nativeConnection !== connection || !connection.connected) return;
  publishStatusChanged();
}

async function fallbackOrReconnect() {
  if (!await connectLegacyStoredSession()) await scheduleReconnect();
}

async function connectLegacyStoredSession() {
  const stored = await chrome.storage.local.get([
    storageKeys.credential,
    storageKeys.cwd,
    storageKeys.daemonBaseUrl,
    storageKeys.paused,
  ]);
  const credential = stored[storageKeys.credential];
  const cwd = stored[storageKeys.cwd];
  const daemonBaseUrl = stored[storageKeys.daemonBaseUrl] ?? DEFAULT_DAEMON_BASE_URL;
  if (stored[storageKeys.paused] === true || typeof credential !== "string" || typeof cwd !== "string") {
    return false;
  }
  clearLegacySocket();
  const next = new WebSocket(websocketUrl(daemonBaseUrl, cwd));
  legacySocket = next;
  next.addEventListener("open", () => {
    if (legacySocket !== next) {
      intentionalSocketClosures.add(next);
      next.close(1000, "ling_session_replaced");
      return;
    }
    void clearReconnectState();
    connectionState = "connected";
    activeTransport = "legacy_websocket";
    next.send(JSON.stringify({
      protocol: PROTOCOL,
      type: "hello",
      credential,
      extensionVersion: chrome.runtime.getManifest().version,
      browserVersion: navigator.userAgent,
    }));
    startHeartbeat(webSocketTarget(next));
    publishStatusChanged();
  });
  next.addEventListener("message", (event) => {
    if (legacySocket !== next) return;
    void handleDaemonCommand(webSocketTarget(next), event.data);
  });
  next.addEventListener("close", (event) => {
    if (legacySocket !== next) return;
    legacySocket = undefined;
    activeTransport = "none";
    clearHeartbeat();
    if (intentionalSocketClosures.has(next)) return;
    if (shouldForgetCredentialAfterSocketClose(event)) {
      void chrome.storage.local.remove([storageKeys.credential, storageKeys.cwd, storageKeys.daemonBaseUrl]);
      connectionState = "host_missing";
      publishStatusChanged();
      void scheduleReconnect();
      return;
    }
    connectionState = "ling_unavailable";
    publishStatusChanged();
    void scheduleReconnect();
  });
  return true;
}

async function scheduleReconnect() {
  const paused = (await chrome.storage.local.get([storageKeys.paused]))[storageKeys.paused] === true;
  if (paused) {
    await clearReconnectState();
    return;
  }
  const existingAlarm = await chrome.alarms.get(RECONNECT_ALARM);
  if (!existingAlarm) {
    chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + RECONNECT_DURABLE_WAKE_MS });
  }
  if (reconnectTimer) return;
  const stored = await chrome.storage.session.get([sessionStorageKeys.reconnectAttempt]);
  const attempt = Number.isInteger(stored[sessionStorageKeys.reconnectAttempt])
    ? Math.max(0, stored[sessionStorageKeys.reconnectAttempt])
    : 0;
  const delayMs = Math.min(1_000 * (2 ** attempt), RECONNECT_MAX_DELAY_MS);
  await chrome.storage.session.set({ [sessionStorageKeys.reconnectAttempt]: attempt + 1 });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void requestConnection();
  }, delayMs);
}

async function clearReconnectState() {
  clearReconnectTimer();
  await Promise.all([
    chrome.alarms.clear(RECONNECT_ALARM),
    chrome.storage.session.remove([sessionStorageKeys.reconnectAttempt]),
  ]);
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function clearConnections() {
  clearNativeConnection();
  clearLegacySocket();
}

function clearNativeConnection() {
  const current = nativeConnection;
  nativeConnection = undefined;
  if (current) {
    intentionalNativeClosures.add(current.port);
    current.port.disconnect();
  }
}

function clearLegacySocket() {
  clearHeartbeat();
  const current = legacySocket;
  legacySocket = undefined;
  if (current && current.readyState < WebSocket.CLOSING) {
    intentionalSocketClosures.add(current);
    current.close(1000, "ling_disconnect");
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function startHeartbeat(target) {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!target.isOpen()) return;
    try {
      target.send({ protocol: PROTOCOL, type: "heartbeat", sentAt: new Date().toISOString() });
    } catch {
      // Native Messaging reports the transport failure through onDisconnect.
    }
  }, 20_000);
}

async function handleDaemonCommand(target, data) {
  let id = "unknown";
  try {
    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    if (serialized.length > 1024 * 1024) throw new Error("Command exceeds the safe limit");
    const command = validateCommand(typeof data === "string" ? JSON.parse(data) : data);
    id = command.id;
    const result = await executeCommand(command.method, command.params ?? {});
    if (target.isOpen()) {
      target.send({ protocol: PROTOCOL, type: "result", id, ok: true, result });
    }
  } catch (error) {
    if (target.isOpen()) {
      target.send({
        protocol: PROTOCOL,
        type: "result",
        id,
        ok: false,
        error: { code: "chrome_command_failed", message: safeError(error) },
      });
    }
  }
}

function nativeTarget(connection) {
  return {
    isOpen: () => nativeConnection === connection && connection.connected,
    send: (message) => connection.port.postMessage(message),
  };
}

function webSocketTarget(target) {
  return {
    isOpen: () => legacySocket === target && target.readyState === WebSocket.OPEN,
    send: (message) => target.send(JSON.stringify(message)),
  };
}

function nativeErrorState(code) {
  if (code === "host_missing") return "host_missing";
  if (code === "version_incompatible" || code === "native_protocol_invalid" || code === "origin_forbidden") return "incompatible";
  if (code === "plugin_disabled") return "plugin_disabled";
  return "ling_unavailable";
}

function isNativeHostMissingError(message) {
  return /native messaging host.*not found|specified native messaging host not found/iu.test(message);
}

function publishStatusChanged() {
  void Promise.resolve(chrome.runtime.sendMessage?.({ type: "ling.chrome.status_changed" })).catch(() => undefined);
}

async function executeCommand(method, params) {
  if (method === "chrome_tabs") {
    return (await chrome.tabs.query({})).filter((tab) => isAllowedPageUrl(tab.url ?? "")).slice(0, 100).map(safeTab);
  }
  if (method === "chrome_navigate") {
    if (!isAllowedPageUrl(params.url)) throw new Error("Only HTTP and HTTPS navigation is allowed");
    const tab = Number.isInteger(params.tabId)
      ? await chrome.tabs.update(params.tabId, { url: params.url, active: true })
      : await chrome.tabs.create({ url: params.url, active: true });
    return safeTab(tab);
  }
  const tab = await resolveTargetTab(params.tabId);
  if (!tab.id || !isAllowedPageUrl(tab.url ?? "")) throw new Error("Target tab is unavailable");
  if (method === "chrome_screenshot") {
    await chrome.tabs.update(tab.id, { active: true });
    const image = dataUrlImage(await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 75 }));
    return { tabId: tab.id, ...image };
  }
  if (method === "chrome_snapshot") return sendToTab(tab.id, { type: "ling_snapshot" });
  if (method === "chrome_click") return sendToTab(tab.id, {
    type: "ling_click",
    ref: params.ref,
    snapshotRevision: params.snapshotRevision,
  });
  if (method === "chrome_type") return sendToTab(tab.id, {
    type: "ling_type",
    ref: params.ref,
    text: params.text,
    snapshotRevision: params.snapshotRevision,
  });
  throw new Error("Unsupported Chrome command");
}

async function resolveTargetTab(tabId) {
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active Chrome tab");
  return tab;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512).replace(/(?:credential|pairing|token)[^\s]*/giu, "[redacted]");
}

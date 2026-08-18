import {
  DEFAULT_DAEMON_BASE_URL,
  PROTOCOL,
  dataUrlImage,
  isAllowedPageUrl,
  pairingUrl,
  safeTab,
  shouldForgetCredentialAfterSocketClose,
  validateCommand,
  websocketUrl,
} from "./protocol.js";

const storageKeys = {
  credential: "ling.chrome.credential",
  cwd: "ling.chrome.cwd",
  daemonBaseUrl: "ling.chrome.daemonBaseUrl",
};

let socket;
let heartbeatTimer;
let reconnectTimer;
let reconnectDelayMs = 1_000;
const intentionalClosures = new WeakSet();

chrome.runtime.onInstalled.addListener(() => {
  void connectStoredSession();
});

chrome.runtime.onStartup.addListener(() => {
  void connectStoredSession();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handlePopupMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

void connectStoredSession();

async function handlePopupMessage(message) {
  if (!message || typeof message !== "object") throw new Error("Invalid extension request");
  if (message.type === "status") return { ok: true, ...(await status()) };
  if (message.type === "pair") {
    const pairingCode = typeof message.pairingCode === "string" ? message.pairingCode.trim() : "";
    const cwd = typeof message.cwd === "string" ? message.cwd.trim() : "";
    const stored = await chrome.storage.local.get([storageKeys.daemonBaseUrl]);
    const daemonBaseUrl = typeof message.daemonBaseUrl === "string"
      ? message.daemonBaseUrl.trim()
      : typeof stored[storageKeys.daemonBaseUrl] === "string"
        ? stored[storageKeys.daemonBaseUrl]
        : DEFAULT_DAEMON_BASE_URL;
    if (!pairingCode || !cwd) throw new Error("Pairing code and workspace are required");
    const response = await fetch(pairingUrl(daemonBaseUrl, cwd), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: PROTOCOL,
        pairingCode,
        extensionVersion: chrome.runtime.getManifest().version,
        browserVersion: navigator.userAgent,
      }),
    });
    const body = await response.json();
    if (!response.ok || typeof body.credential !== "string") {
      throw new Error(typeof body.message === "string" ? body.message : "Ling pairing failed");
    }
    await chrome.storage.local.set({
      [storageKeys.credential]: body.credential,
      [storageKeys.cwd]: cwd,
      [storageKeys.daemonBaseUrl]: daemonBaseUrl,
    });
    await connectStoredSession();
    return { ok: true, ...(await status()) };
  }
  if (message.type === "disconnect") {
    await chrome.storage.local.remove([storageKeys.credential, storageKeys.cwd]);
    clearSocket();
    return { ok: true, ...(await status()) };
  }
  throw new Error("Unsupported extension request");
}

async function status() {
  const stored = await chrome.storage.local.get(Object.values(storageKeys));
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return {
    paired: typeof stored[storageKeys.credential] === "string",
    connected: socket?.readyState === WebSocket.OPEN,
    cwd: typeof stored[storageKeys.cwd] === "string" ? stored[storageKeys.cwd] : "",
    daemonBaseUrl: typeof stored[storageKeys.daemonBaseUrl] === "string"
      ? stored[storageKeys.daemonBaseUrl]
      : DEFAULT_DAEMON_BASE_URL,
    activeTab: activeTab ? safeTab(activeTab) : undefined,
  };
}

async function connectStoredSession() {
  const stored = await chrome.storage.local.get(Object.values(storageKeys));
  const credential = stored[storageKeys.credential];
  const cwd = stored[storageKeys.cwd];
  const daemonBaseUrl = stored[storageKeys.daemonBaseUrl] ?? DEFAULT_DAEMON_BASE_URL;
  if (typeof credential !== "string" || typeof cwd !== "string") return;
  clearSocket();
  const next = new WebSocket(websocketUrl(daemonBaseUrl, cwd));
  socket = next;
  next.addEventListener("open", () => {
    if (socket !== next) {
      intentionalClosures.add(next);
      next.close(1000, "ling_session_replaced");
      return;
    }
    reconnectDelayMs = 1_000;
    next.send(JSON.stringify({
      protocol: PROTOCOL,
      type: "hello",
      credential,
      extensionVersion: chrome.runtime.getManifest().version,
      browserVersion: navigator.userAgent,
    }));
    heartbeatTimer = setInterval(() => {
      if (next.readyState === WebSocket.OPEN) {
        next.send(JSON.stringify({ protocol: PROTOCOL, type: "heartbeat", sentAt: new Date().toISOString() }));
      }
    }, 20_000);
  });
  next.addEventListener("message", (event) => {
    if (socket !== next) return;
    void handleDaemonCommand(next, event.data);
  });
  next.addEventListener("close", (event) => {
    const wasCurrentSocket = socket === next;
    if (!wasCurrentSocket) return;
    socket = undefined;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (intentionalClosures.has(next)) return;
    if (shouldForgetCredentialAfterSocketClose(event)) {
      reconnectDelayMs = 1_000;
      void chrome.storage.local.remove([storageKeys.credential, storageKeys.cwd]);
      return;
    }
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connectStoredSession(), reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
}

function clearSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  const current = socket;
  socket = undefined;
  if (current && current.readyState < WebSocket.CLOSING) {
    intentionalClosures.add(current);
    current.close(1000, "ling_disconnect");
  }
}

async function handleDaemonCommand(target, data) {
  let id = "unknown";
  try {
    if (typeof data !== "string" || data.length > 1024 * 1024) throw new Error("Command exceeds the safe limit");
    const command = validateCommand(JSON.parse(data));
    id = command.id;
    const result = await executeCommand(command.method, command.params ?? {});
    if (target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify({ protocol: PROTOCOL, type: "result", id, ok: true, result }));
    }
  } catch (error) {
    if (target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify({
        protocol: PROTOCOL,
        type: "result",
        id,
        ok: false,
        error: { code: "chrome_command_failed", message: safeError(error) },
      }));
    }
  }
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
  return message.slice(0, 512).replace(/(?:credential|pairing)[^\s]*/giu, "[redacted]");
}

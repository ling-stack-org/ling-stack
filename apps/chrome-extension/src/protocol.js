export const PROTOCOL = "ling.chrome.v1";
export const NATIVE_PROTOCOL = "ling.chrome.native.v1";
export const NATIVE_HOST_NAME = "com.lingstack.browser";
export const DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:17891";
export const MAX_TEXT_LENGTH = 64 * 1024;
export const MAX_ELEMENTS = 300;
export const MAX_SCREENSHOT_BASE64_LENGTH = 1024 * 1024;
const ACCESS_REVOKED_CLOSE_CODE = 4003;
const ACCESS_REVOKED_CLOSE_REASON = "chrome_access_revoked";
const CREDENTIAL_INVALID_CLOSE_CODE = 4002;
const CREDENTIAL_INVALID_CLOSE_REASON = "chrome_browser_credential_invalid";

export const commandMethods = new Set([
  "chrome_tabs",
  "chrome_snapshot",
  "chrome_navigate",
  "chrome_click",
  "chrome_type",
  "chrome_screenshot",
]);

const nativeErrorCodes = new Set([
  "host_missing",
  "ling_unavailable",
  "descriptor_invalid",
  "origin_forbidden",
  "plugin_disabled",
  "version_incompatible",
  "native_protocol_invalid",
]);

export function validateNativeControlMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native control message");
  if (value.type === "ready") {
    assertExactKeys(value, ["protocol", "type", "connected", "migratedLegacyCredential"]);
    if (value.protocol !== NATIVE_PROTOCOL
      || typeof value.connected !== "boolean"
      || typeof value.migratedLegacyCredential !== "boolean") {
      throw new Error("Invalid native ready message");
    }
    return value;
  }
  if (value.type === "error") {
    assertExactKeys(value, ["protocol", "type", "code"]);
    if (value.protocol !== NATIVE_PROTOCOL || !nativeErrorCodes.has(value.code)) {
      throw new Error("Invalid native error message");
    }
    return value;
  }
  throw new Error("Unsupported native control message");
}

export function isAllowedPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function shouldForgetCredentialAfterSocketClose(event) {
  return (event?.code === ACCESS_REVOKED_CLOSE_CODE && event?.reason === ACCESS_REVOKED_CLOSE_REASON)
    || (event?.code === CREDENTIAL_INVALID_CLOSE_CODE && event?.reason === CREDENTIAL_INVALID_CLOSE_REASON);
}

export function validateCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command");
  assertExactKeys(value, ["protocol", "type", "id", "method", "params", "deadlineAt"]);
  if (value.protocol !== PROTOCOL || value.type !== "command") throw new Error("Unsupported command protocol");
  const id = readString(value.id, "command id", 128);
  if (!commandMethods.has(value.method)) throw new Error("Unsupported command method");
  const deadlineAt = readString(value.deadlineAt, "deadlineAt", 64);
  if (!Number.isFinite(Date.parse(deadlineAt)) || Date.parse(deadlineAt) <= Date.now()) throw new Error("Command expired");
  return { ...value, id, deadlineAt, params: validateCommandParams(value.method, value.params) };
}

function validateCommandParams(method, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command params");
  if (method === "chrome_tabs") {
    assertExactKeys(value, []);
    return {};
  }
  if (method === "chrome_snapshot" || method === "chrome_screenshot") {
    assertExactKeys(value, ["tabId"]);
    return value.tabId === undefined ? {} : { tabId: readTabId(value.tabId) };
  }
  if (method === "chrome_navigate") {
    assertExactKeys(value, ["tabId", "url"]);
    const url = readString(value.url, "url", 4096);
    if (!isAllowedPageUrl(url)) throw new Error("Only HTTP and HTTPS navigation is allowed");
    return { ...(value.tabId === undefined ? {} : { tabId: readTabId(value.tabId) }), url };
  }
  if (method === "chrome_click" || method === "chrome_type") {
    const allowed = method === "chrome_type"
      ? ["tabId", "ref", "snapshotRevision", "text"]
      : ["tabId", "ref", "snapshotRevision"];
    assertExactKeys(value, allowed);
    return {
      ...(value.tabId === undefined ? {} : { tabId: readTabId(value.tabId) }),
      ref: readString(value.ref, "ref", 128),
      snapshotRevision: readString(value.snapshotRevision, "snapshotRevision", 128),
      ...(method === "chrome_type" ? { text: readString(value.text, "text", 16_384, true) } : {}),
    };
  }
  throw new Error("Unsupported command method");
}

function assertExactKeys(value, allowed) {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((key) => !allowlist.has(key))) throw new Error("Unknown command field");
}

function readTabId(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("Invalid tabId");
  return value;
}

function readString(value, field, maxLength, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function safeTab(tab) {
  const url = typeof tab.url === "string" && isAllowedPageUrl(tab.url) ? tab.url : undefined;
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active === true,
    title: typeof tab.title === "string" ? tab.title.slice(0, 512) : "",
    ...(url ? { url } : {}),
  };
}

export function websocketUrl(baseUrl, cwd) {
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new Error("Ling daemon must use loopback");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/browser-extension/v1/connect";
  url.search = new URLSearchParams({ cwd }).toString();
  return url.toString();
}

export function pairingUrl(baseUrl, cwd) {
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new Error("Ling daemon must use loopback");
  }
  url.pathname = "/browser-extension/v1/pair";
  url.search = new URLSearchParams({ cwd }).toString();
  return url.toString();
}

export function dataUrlImage(value) {
  if (typeof value !== "string") throw new Error("Screenshot is unavailable");
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/u.exec(value);
  if (!match || match[2].length > MAX_SCREENSHOT_BASE64_LENGTH) throw new Error("Screenshot exceeds the safe limit");
  return { mimeType: match[1], data: match[2] };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL,
  PROTOCOL,
  dataUrlImage,
  isAllowedPageUrl,
  pairingUrl,
  safeTab,
  shouldForgetCredentialAfterSocketClose,
  validateCommand,
  validateNativeControlMessage,
  websocketUrl,
} from "../src/protocol.js";

test("extension native control protocol is exact and versioned", () => {
  assert.equal(NATIVE_HOST_NAME, "com.lingstack.browser");
  assert.equal(NATIVE_PROTOCOL, "ling.chrome.native.v1");
  assert.deepEqual(validateNativeControlMessage({
    protocol: NATIVE_PROTOCOL,
    type: "ready",
    connected: true,
    migratedLegacyCredential: true,
  }), {
    protocol: NATIVE_PROTOCOL,
    type: "ready",
    connected: true,
    migratedLegacyCredential: true,
  });
  assert.throws(() => validateNativeControlMessage({
    protocol: NATIVE_PROTOCOL,
    type: "ready",
    connected: true,
    migratedLegacyCredential: false,
    cwd: "/forbidden",
  }), /Unknown command field/);
  assert.throws(() => validateNativeControlMessage({
    protocol: NATIVE_PROTOCOL,
    type: "error",
    code: "unknown",
  }), /Invalid native error/);
});

test("extension protocol allows only bounded loopback and HTTP page operations", () => {
  assert.equal(isAllowedPageUrl("https://example.com/path"), true);
  assert.equal(isAllowedPageUrl("http://127.0.0.1:5173"), true);
  for (const url of ["chrome://settings", "file:///tmp/a", "javascript:alert(1)", "data:text/plain,x"]) {
    assert.equal(isAllowedPageUrl(url), false);
  }
  assert.match(websocketUrl("http://127.0.0.1:17891", "/tmp/work"), /^ws:\/\/127\.0\.0\.1:17891\/browser-extension\/v1\/connect\?/u);
  assert.match(pairingUrl("http://localhost:17891", "/tmp/work"), /^http:\/\/localhost:17891\/browser-extension\/v1\/pair\?/u);
  assert.throws(() => websocketUrl("https://example.com", "/tmp/work"), /loopback/);
});

test("extension protocol validates commands and strips unsupported tab URLs", () => {
  const command = validateCommand({
    protocol: PROTOCOL,
    type: "command",
    id: "chrome_1",
    method: "chrome_tabs",
    params: {},
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(command.method, "chrome_tabs");
  assert.throws(() => validateCommand({ ...command, method: "chrome_eval" }), /Unsupported command/);
  assert.throws(() => validateCommand({ ...command, params: { unexpected: true } }), /Unknown command field/);
  assert.throws(() => validateCommand({ ...command, method: "chrome_snapshot", params: { tabId: "1" } }), /Invalid tabId/);
  assert.throws(() => validateCommand({ ...command, method: "chrome_navigate", params: { url: "javascript:alert(1)" } }), /HTTP and HTTPS/);
  assert.throws(() => validateCommand({ ...command, method: "chrome_click", params: { ref: "e1" } }), /snapshotRevision/);
  assert.deepEqual(validateCommand({
    ...command,
    method: "chrome_type",
    params: { tabId: 1, ref: "e1", snapshotRevision: "revision", text: "" },
  }).params, { tabId: 1, ref: "e1", snapshotRevision: "revision", text: "" });
  assert.deepEqual(safeTab({ id: 1, windowId: 2, active: true, title: "Settings", url: "chrome://settings" }), {
    id: 1,
    windowId: 2,
    active: true,
    title: "Settings",
  });
});

test("extension screenshot parser accepts bounded PNG/JPEG data only", () => {
  assert.deepEqual(dataUrlImage("data:image/png;base64,YQ=="), { mimeType: "image/png", data: "YQ==" });
  assert.throws(() => dataUrlImage("data:text/plain;base64,YQ=="), /safe limit|unavailable/);
});

test("extension forgets credentials only after authoritative revocation or invalidation", () => {
  assert.equal(shouldForgetCredentialAfterSocketClose({ code: 4003, reason: "chrome_access_revoked" }), true);
  assert.equal(shouldForgetCredentialAfterSocketClose({ code: 4002, reason: "chrome_browser_credential_invalid" }), true);
  assert.equal(shouldForgetCredentialAfterSocketClose({ code: 4003, reason: "chrome_plugin_disabled" }), false);
  assert.equal(shouldForgetCredentialAfterSocketClose({ code: 4002, reason: "chrome_browser_disabled" }), false);
  assert.equal(shouldForgetCredentialAfterSocketClose({ code: 1000, reason: "chrome_access_revoked" }), false);
  assert.equal(shouldForgetCredentialAfterSocketClose({ code: 1006, reason: "" }), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHROME_BROWSER_PROTOCOL,
  parseChromeBrowserExtensionMessage,
  parseChromeBrowserPairingRequest,
} from "../dist/index.js";

test("Chrome browser protocol accepts bounded pairing and session messages", () => {
  assert.deepEqual(parseChromeBrowserPairingRequest({
    protocol: CHROME_BROWSER_PROTOCOL,
    pairingCode: "PAIR-1234",
    extensionVersion: "0.1.0",
    browserVersion: "Chrome/140",
  }), {
    protocol: CHROME_BROWSER_PROTOCOL,
    pairingCode: "PAIR-1234",
    extensionVersion: "0.1.0",
    browserVersion: "Chrome/140",
  });
  assert.equal(parseChromeBrowserExtensionMessage({
    protocol: CHROME_BROWSER_PROTOCOL,
    type: "hello",
    credential: "credential-value",
    extensionVersion: "0.1.0",
  }).type, "hello");
  assert.equal(parseChromeBrowserExtensionMessage({
    protocol: CHROME_BROWSER_PROTOCOL,
    type: "result",
    id: "command-1",
    ok: false,
    error: { code: "tab_missing", message: "Tab is unavailable." },
  }).type, "result");
});

test("Chrome browser protocol rejects version drift, secret overflow, and unknown fields", () => {
  assert.throws(() => parseChromeBrowserPairingRequest({
    protocol: "ling.chrome.v2",
    pairingCode: "PAIR-1234",
    extensionVersion: "0.1.0",
  }), /Unsupported Chrome browser protocol/);
  assert.throws(() => parseChromeBrowserExtensionMessage({
    protocol: CHROME_BROWSER_PROTOCOL,
    type: "hello",
    credential: "x".repeat(257),
    extensionVersion: "0.1.0",
  }), /credential must be a non-empty string/);
  assert.throws(() => parseChromeBrowserExtensionMessage({
    protocol: CHROME_BROWSER_PROTOCOL,
    type: "heartbeat",
    sentAt: "2026-08-17T00:00:00.000Z",
    token: "must-not-be-accepted",
  }), /Unknown Chrome browser field/);
  assert.throws(() => parseChromeBrowserExtensionMessage({
    protocol: CHROME_BROWSER_PROTOCOL,
    type: "result",
    id: "command-1",
    ok: false,
  }), /must include an error/);
});

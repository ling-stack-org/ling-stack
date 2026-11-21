import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHROME_BROWSER_NATIVE_PROTOCOL,
  CHROME_BROWSER_PROTOCOL,
  CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
  isCompatibleChromeBrowserNativeVersion,
  parseChromeBrowserExtensionMessage,
  parseChromeBrowserNativeBrokerHello,
  parseChromeBrowserNativeExtensionHello,
  parseChromeBrowserPairingRequest,
  parseChromeBrowserRuntimeDescriptorV1,
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

test("Chrome native transport accepts exact no-workspace handshakes and descriptors", () => {
  assert.equal(parseChromeBrowserNativeExtensionHello({
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    type: "hello",
    extensionVersion: "0.1.1",
    browserVersion: "Chrome/151",
    paused: false,
  }).type, "hello");
  assert.equal(parseChromeBrowserNativeBrokerHello({
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    type: "hello",
    extensionVersion: "0.1.1",
    browserVersion: "Chrome/151",
    paused: false,
    token: "startup-token",
    origin: "chrome-extension://mbmlnnfhebclljonhedpjghbhibfapei/",
    hostVersion: "0.1.1",
  }).hostVersion, "0.1.1");
  assert.equal(parseChromeBrowserRuntimeDescriptorV1({
    schema: CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    hostVersion: "0.1.1",
    port: 43123,
    token: "startup-token",
    generation: "generation",
    daemonPid: 42,
    expiresAtEpochMs: Date.now() + 60_000,
  }).port, 43123);
  assert.equal(isCompatibleChromeBrowserNativeVersion("0.1.1"), true);
  assert.equal(isCompatibleChromeBrowserNativeVersion("0.1.0"), false);
});

test("Chrome native transport rejects workspace authority and unknown descriptor fields", () => {
  assert.throws(() => parseChromeBrowserNativeExtensionHello({
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    type: "hello",
    extensionVersion: "0.1.1",
    paused: false,
    cwd: "/must/not/enter/native/transport",
  }), /Unknown Chrome browser field/);
  assert.throws(() => parseChromeBrowserRuntimeDescriptorV1({
    schema: CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    hostVersion: "0.1.1",
    port: 43123,
    token: "startup-token",
    generation: "generation",
    daemonPid: 42,
    expiresAtEpochMs: Date.now() + 60_000,
    workspace: "/forbidden",
  }), /Unknown Chrome browser field/);
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

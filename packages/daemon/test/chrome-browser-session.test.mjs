import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHROME_BROWSER_PLUGIN_ID, CHROME_BROWSER_PROTOCOL } from "@ling-stack/contracts";
import { createSqliteRunStore } from "@ling-stack/core";
import { WebSocket } from "ws";
import {
  ChromeBrowserSessionController,
  ChromeBrowserPluginService,
  attachChromeBrowserWebSocketServer,
  createChromeBrowserGenerationBroker,
  normalizeChromeBrowserStoreUrl,
} from "../dist/index.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const descriptor = {
  id: CHROME_BROWSER_PLUGIN_ID,
  displayName: "Chrome",
  version: "0.1.0",
  sourceKind: "built-in",
  trustSummary: "Controls the user's explicitly paired Chrome extension.",
  contributions: [],
};

test("Chrome Web Store URLs allow only the official HTTPS origin", () => {
  assert.equal(
    normalizeChromeBrowserStoreUrl("https://chromewebstore.google.com/detail/ling/abcdefghijklmnop"),
    "https://chromewebstore.google.com/detail/ling/abcdefghijklmnop",
  );
  assert.equal(normalizeChromeBrowserStoreUrl("javascript:alert(1)"), undefined);
  assert.equal(normalizeChromeBrowserStoreUrl("https://example.com/detail/ling"), undefined);
  assert.equal(normalizeChromeBrowserStoreUrl("https://user:secret@chromewebstore.google.com/detail/ling"), undefined);
});

async function fixture(options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-stack-chrome-session-"));
  const store = createSqliteRunStore(cwd);
  store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: true,
    descriptor,
  }, "2026-08-17T00:00:00.000Z");
  const tokens = ["pairing-code", "persistent-credential", "replacement-code", "replacement-credential"];
  const controller = new ChromeBrowserSessionController({
    workspaceCwd: cwd,
    allowedExtensionIds: [extensionId],
    getStore: () => store,
    token: () => tokens.shift() ?? "fallback-token",
    ...options,
  });
  return { cwd, store, controller };
}

test("Chrome pairing is one-time, allowlisted, hash-backed, and revocable", async () => {
  const { cwd, store, controller } = await fixture();
  try {
    const grant = controller.createPairing(cwd);
    assert.equal(grant.pairingCode, "pairing-code");
    assert.throws(() => controller.pair(cwd, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
      protocol: CHROME_BROWSER_PROTOCOL,
      pairingCode: grant.pairingCode,
      extensionVersion: "0.1.0",
    }), /not trusted/);
    assert.throws(() => controller.pair(cwd, extensionId, {
      protocol: CHROME_BROWSER_PROTOCOL,
      pairingCode: "wrong-code",
      extensionVersion: "0.1.0",
    }), /pairing code is invalid/);

    const paired = controller.pair(cwd, extensionId, {
      protocol: CHROME_BROWSER_PROTOCOL,
      pairingCode: grant.pairingCode,
      extensionVersion: "0.1.0",
    });
    assert.equal(paired.credential, "persistent-credential");
    const stored = store.getChromeBrowserCredential("workspace_default", CHROME_BROWSER_PLUGIN_ID, extensionId);
    assert.equal(stored?.credentialHash.length, 64);
    assert.equal(stored?.credentialHash.includes("persistent-credential"), false);
    assert.throws(() => controller.pair(cwd, extensionId, {
      protocol: CHROME_BROWSER_PROTOCOL,
      pairingCode: grant.pairingCode,
      extensionVersion: "0.1.0",
    }), /expired/);
    assert.equal(controller.snapshot(cwd).paired, true);
    assert.equal(controller.revoke(cwd), 1);
    assert.equal(controller.snapshot(cwd).paired, false);
  } finally {
    controller.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Chrome WebSocket authority executes commands, fences replacement, and cancels", async () => {
  const { cwd, store, controller } = await fixture({ commandTimeoutMs: 500, heartbeatTimeoutMs: 5_000 });
  const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  const websocket = attachChromeBrowserWebSocketServer({
    server,
    controller,
    host: "127.0.0.1",
    port: 0,
    workspaceCwd: cwd,
  });
  try {
    const grant = controller.createPairing(cwd);
    const paired = controller.pair(cwd, extensionId, {
      protocol: CHROME_BROWSER_PROTOCOL,
      pairingCode: grant.pairingCode,
      extensionVersion: "0.1.0",
    });
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}/browser-extension/v1/connect?cwd=${encodeURIComponent(cwd)}`;
    const first = await connectChrome(url, paired.credential);
    await waitFor(() => controller.snapshot(cwd).connected);

    first.once("message", (data) => {
      const command = JSON.parse(data.toString());
      first.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "result",
        id: command.id,
        ok: true,
        result: [{ id: 1, title: "Ling" }],
      }));
    });
    assert.deepEqual(await controller.execute(cwd, "chrome_tabs", {}), [{ id: 1, title: "Ling" }]);

    const logicalServer = store.createMcpServer({
      id: "mcp_chrome_browser",
      displayName: "Chrome browser",
      enabled: true,
      transport: { type: "streamable-http", url: "http://127.0.0.1:1/internal", headers: {}, secretHeaderRefs: {} },
    }, "2026-08-17T00:00:00.000Z");
    const broker = createChromeBrowserGenerationBroker({
      baseBroker: {
        async checkServer() { throw new Error("unexpected base check"); },
        async listTools() { throw new Error("unexpected base list"); },
        async callTool() { throw new Error("unexpected base call"); },
      },
      workspaceCwd: cwd,
      controller,
    });
    first.once("message", (data) => {
      const command = JSON.parse(data.toString());
      first.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "result",
        id: command.id,
        ok: true,
        result: [{ id: 2, windowId: 1, active: true, title: "Broker", url: "https://example.com" }],
      }));
    });
    const brokerResult = await broker.callTool(logicalServer, { workspaceCwd: cwd, secretResolver: {} }, "chrome_tabs", {});
    assert.equal(brokerResult.content[0].type, "text");
    assert.match(brokerResult.content[0].text, /untrusted_web_content/);
    assert.match(brokerResult.content[0].text, /Broker/);

    first.once("message", (data) => {
      const command = JSON.parse(data.toString());
      first.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "result",
        id: command.id,
        ok: true,
        result: { tabId: 2, mimeType: "image/png", data: "YQ==" },
      }));
    });
    const screenshotResult = await broker.callTool(logicalServer, { workspaceCwd: cwd, secretResolver: {} }, "chrome_screenshot", { tabId: 2 });
    assert.equal(screenshotResult.content[0].type, "text");
    assert.match(screenshotResult.content[0].text, /untrusted_web_content/);
    assert.equal(screenshotResult.content[1].type, "image");

    first.once("message", (data) => {
      const command = JSON.parse(data.toString());
      first.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "result",
        id: command.id,
        ok: true,
        result: [{ id: "not-an-integer", title: "Invalid", url: "https://example.com" }],
      }));
    });
    await assert.rejects(
      broker.callTool(logicalServer, { workspaceCwd: cwd, secretResolver: {} }, "chrome_tabs", {}),
      /chrome_browser_tabs_invalid/,
    );

    first.once("message", (data) => {
      const command = JSON.parse(data.toString());
      first.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "result",
        id: command.id,
        ok: true,
        result: { ok: false, error: "page rejected the click" },
      }));
    });
    await assert.rejects(
      broker.callTool(logicalServer, { workspaceCwd: cwd, secretResolver: {} }, "chrome_click", { tabId: 2, ref: "e1", snapshotRevision: "revision" }),
      /chrome_browser_interaction_failed/,
    );

    const pending = controller.execute(cwd, "chrome_snapshot", { tabId: 1 });
    const second = await connectChrome(url, paired.credential);
    await assert.rejects(pending, /session ended/);
    await waitFor(() => controller.snapshot(cwd).connected);

    const abortController = new AbortController();
    const cancelled = controller.execute(cwd, "chrome_click", { tabId: 1, ref: "e1" }, abortController.signal);
    abortController.abort();
    await assert.rejects(cancelled, /cancelled/);
    second.close();
  } finally {
    websocket.close();
    controller.close();
    await closeServer(server);
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Chrome WebSocket upgrade rejects non-extension origins", async () => {
  const { cwd, store, controller } = await fixture();
  const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  const websocket = attachChromeBrowserWebSocketServer({ server, controller, host: "127.0.0.1", port: 0, workspaceCwd: cwd });
  try {
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}/browser-extension/v1/connect?cwd=${encodeURIComponent(cwd)}`;
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { origin: "https://example.com" });
      socket.once("open", resolve);
      socket.once("error", reject);
    }));
  } finally {
    websocket.close();
    controller.close();
    await closeServer(server);
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid Chrome credentials project an incompatible state until repair starts", async () => {
  const { cwd, store, controller } = await fixture();
  const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  const websocket = attachChromeBrowserWebSocketServer({ server, controller, host: "127.0.0.1", port: 0, workspaceCwd: cwd });
  let socket;
  try {
    controller.createPairing(cwd);
    controller.pair(cwd, extensionId, {
      protocol: CHROME_BROWSER_PROTOCOL,
      pairingCode: "pairing-code",
      extensionVersion: "0.1.0",
    });
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    socket = await connectChrome(
      `ws://127.0.0.1:${address.port}/browser-extension/v1/connect?cwd=${encodeURIComponent(cwd)}`,
      "invalid-credential",
    );
    await waitFor(() => controller.snapshot(cwd).errorCode === "chrome_browser_credential_invalid");
    const service = new ChromeBrowserPluginService({ controller, getStore: () => store });
    service.sync(cwd, "2026-08-17T00:01:00.000Z");
    assert.equal(service.setup(cwd, "2026-08-17T00:01:00.000Z").browserState, "incompatible");

    controller.createPairing(cwd);
    assert.equal(controller.snapshot(cwd).errorCode, undefined);
    assert.notEqual(service.setup(cwd, "2026-08-17T00:02:00.000Z").browserState, "incompatible");
  } finally {
    socket?.close();
    websocket.close();
    controller.close();
    await closeServer(server);
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Chrome plugin synchronization is idempotent for MCP authority", async () => {
  const { cwd, store, controller } = await fixture();
  try {
    const service = new ChromeBrowserPluginService({ controller, getStore: () => store });
    service.enable(cwd, "2026-08-17T00:00:00.000Z");
    const before = store.getMcpAuthorityRevision("mcp_chrome_browser");
    service.sync(cwd, "2026-08-17T00:01:00.000Z");
    service.sync(cwd, "2026-08-17T00:02:00.000Z");
    assert.deepEqual(store.getMcpAuthorityRevision("mcp_chrome_browser"), before);
  } finally {
    controller.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Chrome Host repair installs the current Host and projects it as ready without pairing", async () => {
  const { cwd, store, controller } = await fixture();
  const calls = [];
  try {
    const service = new ChromeBrowserPluginService({
      controller,
      getStore: () => store,
      hostPath: "/Applications/Ling.app/Contents/Resources/browser-host/ling-browser-host",
      installHost: async (input) => {
        calls.push(input);
        return {
          installed: true,
          platform: "darwin",
          hostPath: input.hostPath,
          manifestPaths: ["/tmp/com.lingstack.browser.json"],
          missing: [],
        };
      },
    });
    const health = await service.repairHost(cwd, "2026-08-17T00:03:00.000Z");
    assert.deepEqual(calls, [{ hostPath: "/Applications/Ling.app/Contents/Resources/browser-host/ling-browser-host" }]);
    assert.equal(controller.snapshot(cwd).hostState, "ready");
    assert.notEqual(health.details.browserState, "host_missing");
    assert.equal(controller.snapshot(cwd).paired, false);
  } finally {
    controller.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function connectChrome(url, credential) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: `chrome-extension://${extensionId}` });
    socket.once("open", () => {
      socket.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "hello",
        credential,
        extensionVersion: "0.1.0",
        browserVersion: "Chrome/140",
      }));
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

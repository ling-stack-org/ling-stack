import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHROME_BROWSER_NATIVE_PROTOCOL,
  CHROME_BROWSER_PLUGIN_ID,
  CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
  CHROME_BROWSER_PROTOCOL,
} from "@ling-stack/contracts";
import { createSqliteRunStore } from "@ling-stack/core";
import {
  ChromeBrowserSessionController,
  createChromeBrowserNativeBroker,
} from "../dist/index.js";

const origin = `chrome-extension://${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}/`;

test("Native broker binds daemon workspace, migrates legacy credentials, and executes shared commands", async () => {
  const fixture = await createFixture();
  try {
    const grant = fixture.controller.createPairing(fixture.cwd);
    fixture.controller.pair(fixture.cwd, CHROME_BROWSER_PRODUCTION_EXTENSION_ID, {
      protocol: CHROME_BROWSER_PROTOCOL,
      pairingCode: grant.pairingCode,
      extensionVersion: "0.1.0",
    });
    const socket = await connectBroker(fixture.broker.descriptor().port);
    writeFrame(socket, nativeHello(fixture.broker.descriptor().token));
    const ready = await readFrame(socket);
    assert.deepEqual(ready, {
      protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
      type: "ready",
      connected: true,
      migratedLegacyCredential: true,
    });
    const snapshot = fixture.controller.snapshot(fixture.cwd);
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.transport, "native_messaging");
    assert.equal(snapshot.paired, false);
    assert.equal(snapshot.hostState, "ready");

    const resultPromise = fixture.controller.execute(fixture.cwd, "chrome_tabs", {});
    const command = await readFrame(socket);
    assert.equal(command.protocol, CHROME_BROWSER_PROTOCOL);
    assert.equal(command.method, "chrome_tabs");
    writeFrame(socket, {
      protocol: CHROME_BROWSER_PROTOCOL,
      type: "result",
      id: command.id,
      ok: true,
      result: [{ id: 1, title: "Native" }],
    });
    assert.deepEqual(await resultPromise, [{ id: 1, title: "Native" }]);
    socket.end();
  } finally {
    await fixture.close();
  }
});

test("Native broker projects pause and rejects token or workspace fields", async () => {
  const fixture = await createFixture();
  try {
    const paused = await connectBroker(fixture.broker.descriptor().port);
    writeFrame(paused, nativeHello(fixture.broker.descriptor().token, { paused: true }));
    assert.equal((await readFrame(paused)).connected, false);
    assert.equal(fixture.controller.snapshot(fixture.cwd).extensionState, "paused");

    const wrongToken = await connectBroker(fixture.broker.descriptor().port);
    writeFrame(wrongToken, nativeHello("wrong-token"));
    assert.equal((await readFrame(wrongToken)).code, "descriptor_invalid");

    const withWorkspace = await connectBroker(fixture.broker.descriptor().port);
    writeFrame(withWorkspace, { ...nativeHello(fixture.broker.descriptor().token), cwd: fixture.cwd });
    assert.equal((await readFrame(withWorkspace)).code, "native_protocol_invalid");
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "ling-browser-native-broker-"));
  const store = createSqliteRunStore(cwd);
  store.upsertManagedPlugin({
    id: CHROME_BROWSER_PLUGIN_ID,
    sourceKind: "built-in",
    version: "0.1.1",
    enabled: true,
    descriptor: {
      id: CHROME_BROWSER_PLUGIN_ID,
      displayName: "Chrome",
      version: "0.1.1",
      sourceKind: "built-in",
      trustSummary: "test",
      contributions: [],
    },
  }, new Date().toISOString());
  const tokens = ["pairing", "credential"];
  const controller = new ChromeBrowserSessionController({
    workspaceCwd: cwd,
    allowedExtensionIds: [CHROME_BROWSER_PRODUCTION_EXTENSION_ID],
    getStore: () => store,
    token: () => tokens.shift() ?? "fallback",
    commandTimeoutMs: 500,
  });
  const descriptorPath = join(cwd, "browser-host", "runtime-v1.json");
  const hostPath = join(cwd, "ling-browser-host");
  await writeFile(hostPath, "test-host");
  const broker = createChromeBrowserNativeBroker({
    controller,
    workspaceCwd: cwd,
    descriptorPath,
    hostPath,
    token: () => "native-startup-token",
  });
  await broker.start();
  return {
    cwd,
    store,
    controller,
    broker,
    close: async () => {
      await broker.close();
      controller.close();
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function nativeHello(token, overrides = {}) {
  return {
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    type: "hello",
    extensionVersion: "0.1.1",
    browserVersion: "Chrome/151",
    paused: false,
    token,
    origin,
    hostVersion: "0.1.1",
    ...overrides,
  };
}

function connectBroker(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function writeFrame(socket, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      if (buffered.length < 4 + length) return;
      socket.off("data", onData);
      resolve(JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

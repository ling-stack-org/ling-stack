import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);
const nativeRoot = resolve(import.meta.dirname, "../../browser-host/native");
const manifestPath = join(nativeRoot, "Cargo.toml");
const executablePath = join(
  nativeRoot,
  "target",
  "debug",
  process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host",
);
const origin = `chrome-extension://${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}/`;

test("real Native Host bridges the shared daemon session and exits when the broker closes", async () => {
  await execFileAsync("cargo", ["build", "--quiet", "--locked", "--manifest-path", manifestPath]);
  const fixture = await createFixture();
  let child;
  try {
    child = spawn(executablePath, [origin], {
      env: {
        ...process.env,
        LING_BROWSER_HOST_RUNTIME_DESCRIPTOR: fixture.descriptorPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const read = createFrameReader(child.stdout);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    writeFrame(child.stdin, extensionHello("0.1.1"));
    assert.deepEqual(await read(), {
      protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
      type: "ready",
      connected: true,
      migratedLegacyCredential: false,
    });
    assert.equal(fixture.controller.snapshot(fixture.cwd).transport, "native_messaging");

    const resultPromise = fixture.controller.execute(fixture.cwd, "chrome_tabs", {});
    const command = await read();
    assert.equal(command.protocol, CHROME_BROWSER_PROTOCOL);
    assert.equal(command.method, "chrome_tabs");
    writeFrame(child.stdin, {
      protocol: CHROME_BROWSER_PROTOCOL,
      type: "result",
      id: command.id,
      ok: true,
      result: [{ id: 7, title: "Real Native Host" }],
    });
    assert.deepEqual(await resultPromise, [{ id: 7, title: "Real Native Host" }]);

    const exit = once(child, "exit");
    await fixture.broker.close();
    const [code] = await withTimeout(exit, 2_000, "Native Host did not exit after broker shutdown");
    assert.equal(code, 0);
    assert.equal(stderr.includes("native-startup-token"), false);
  } finally {
    child?.kill();
    await fixture.close();
  }
});

test("real Native Host rejects an incompatible extension without disclosing descriptor secrets", async () => {
  await execFileAsync("cargo", ["build", "--quiet", "--locked", "--manifest-path", manifestPath]);
  const fixture = await createFixture();
  const child = spawn(executablePath, [origin], {
    env: {
      ...process.env,
      LING_BROWSER_HOST_RUNTIME_DESCRIPTOR: fixture.descriptorPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const read = createFrameReader(child.stdout);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    writeFrame(child.stdin, extensionHello("0.1.0"));
    assert.deepEqual(await read(), {
      protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
      type: "error",
      code: "version_incompatible",
    });
    const [code] = await withTimeout(once(child, "exit"), 2_000, "Incompatible Native Host did not exit");
    assert.equal(code, 1);
    assert.equal(stderr.includes("native-startup-token"), false);
  } finally {
    child.kill();
    await fixture.close();
  }
});

async function createFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "ling-browser-native-host-process-"));
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
  const controller = new ChromeBrowserSessionController({
    workspaceCwd: cwd,
    allowedExtensionIds: [CHROME_BROWSER_PRODUCTION_EXTENSION_ID],
    getStore: () => store,
    commandTimeoutMs: 500,
  });
  const descriptorPath = join(cwd, "browser-host", "runtime-v1.json");
  const broker = createChromeBrowserNativeBroker({
    controller,
    workspaceCwd: cwd,
    descriptorPath,
    hostPath: executablePath,
    token: () => "native-startup-token",
  });
  await broker.start();
  return {
    cwd,
    store,
    controller,
    broker,
    descriptorPath,
    close: async () => {
      await broker.close();
      controller.close();
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function extensionHello(extensionVersion) {
  return {
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    type: "hello",
    extensionVersion,
    browserVersion: "Chrome/151",
    paused: false,
  };
}

function writeFrame(stream, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  stream.write(frame);
}

function createFrameReader(stream) {
  let buffered = Buffer.alloc(0);
  const waiters = [];
  let ended = false;
  stream.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    drain();
  });
  stream.on("end", () => {
    ended = true;
    drain();
  });
  stream.on("error", (error) => {
    while (waiters.length > 0) waiters.shift().reject(error);
  });
  return () => new Promise((resolvePromise, reject) => {
    waiters.push({ resolve: resolvePromise, reject });
    drain();
  });

  function drain() {
    while (waiters.length > 0 && buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < 4 + length) break;
      const payload = buffered.subarray(4, 4 + length);
      buffered = buffered.subarray(4 + length);
      waiters.shift().resolve(JSON.parse(payload.toString("utf8")));
    }
    if (ended && waiters.length > 0) {
      const error = new Error("Native Host output ended before the next frame");
      while (waiters.length > 0) waiters.shift().reject(error);
    }
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

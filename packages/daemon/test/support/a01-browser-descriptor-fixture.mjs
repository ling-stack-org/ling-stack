import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export function signal() {
  let complete;
  const promise = new Promise(done => { complete = done; });
  return { promise, complete };
}

export async function bounded(promise, label, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`A01 fixture deadline: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function assertA01Isolation() {
  for (const name of ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"]) {
    const path = process.env[name];
    assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
    assert.ok(statSync(path).isDirectory());
  }
}

export function a01Environment(home, workspace, caseName) {
  return { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC",
    LING_STACK_HOME: home, LING_STACK_DEFAULT_WORKSPACE_CWD: workspace, LING_A01_CASE: caseName };
}

export async function runA01Child(caseName, entryUrl) {
  assertA01Isolation();
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a01-${caseName}-`)));
  const home = join(root, "user"), workspace = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(workspace);
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(entryUrl)], {
    env: a01Environment(home, workspace, caseName), stdio: ["ignore", "pipe", "pipe"], timeout: 45_000,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
  const exit = await new Promise((done, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
  });
  process.stdout.write(stdout); process.stderr.write(stderr);
  console.log(`A01 child exit: ${JSON.stringify({ caseName, root, ...exit })}`);
  assert.ok(stdout.includes(`A01 child entered: ${caseName}`));
  assert.equal(exit.signal, null, "the owned child must finish, not be killed");
  assert.equal(exit.code, 0, `${caseName}: actual child regression failed`);
}

/** Process-global builtin wrappers; install before product import in one owned child. */
export function observeA01Descriptor(t, descriptorPath) {
  assertA01Isolation();
  assert.ok(descriptorPath.startsWith(`${process.env.LING_STACK_HOME}/`));
  const original = { readFile: fs.readFile, rename: fs.rename, rm: fs.rm, chmod: fs.chmod };
  const events = [], contention = signal();
  let contentions = 0;
  const gates = new Set();
  let readGate, renameGate, renamed = false;
  let published = signal();
  const record = (kind, details = {}) => {
    const event = { kind, ...details }; events.push(event);
    console.log(`A01 fs evidence: ${JSON.stringify(event)}`);
  };
  const patches = [
    t.mock.method(fs, "readFile", async function (path, ...args) {
      const bytes = await original.readFile(path, ...args);
      if (path === descriptorPath && readGate && !readGate.used) {
        const value = JSON.parse(bytes.toString());
        if (value.generation === readGate.generation) {
          readGate.used = true; record("read-captured", { generation: value.generation });
          readGate.entered.complete(value); await readGate.release.promise;
        }
      }
      return bytes;
    }),
    t.mock.method(fs, "rename", async function (source, destination) {
      if (destination === descriptorPath) {
        assert.equal(dirname(source), dirname(descriptorPath));
        record("rename-enter");
        if (renameGate && !renameGate.used) {
          renameGate.used = true;
          const value = JSON.parse(await original.readFile(source, "utf8"));
          if (renameGate.generation !== undefined) assert.equal(value.generation, renameGate.generation);
          record("rename-paused", { generation: value.generation });
          renameGate.entered.complete(value); await renameGate.release.promise;
        }
      }
      const result = await original.rename(source, destination);
      if (destination === descriptorPath) { renamed = true; record("rename-complete"); }
      return result;
    }),
    t.mock.method(fs, "rm", async function (path, ...args) {
      if (path === descriptorPath) record("remove-enter");
      const result = await original.rm(path, ...args);
      if (path === descriptorPath) record("remove-complete");
      return result;
    }),
    t.mock.method(fs, "chmod", async function (path, ...args) {
      const result = await original.chmod(path, ...args);
      if (path === descriptorPath && renamed) { record("publication-modes-complete"); published.complete(); }
      return result;
    }),
  ];
  // Future GREEN can observe a real SQLite lock rejection, not a wait timeout.
  // This does not create a database, return a fake lock, or select the production backend.
  const actualExec = DatabaseSync.prototype.exec;
  patches.push(t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    try { return actualExec.call(this, sql); }
    catch (error) {
      const path = this.location();
      if (/^\s*BEGIN\b/iu.test(sql) && path && dirname(path) === dirname(descriptorPath)
        && typeof error.errcode === "number" && (error.errcode & 0xff) === 5) {
        const evidence = { path, code: error.code, errcode: error.errcode };
        contentions++;
        if (contentions === 1) record("lock-contention", evidence);
        contention.complete(evidence);
      }
      throw error;
    }
  }));
  const previousHome = os.homedir;
  patches.push(t.mock.method(os, "homedir", () => process.env.LING_STACK_HOME));
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return; restored = true;
    for (const gate of gates) gate.release.complete();
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    assert.equal(os.homedir, previousHome);
  };
  t.after(restore);
  const makeGate = generation => {
    const gate = { generation, used: false, entered: signal(), release: signal() }; gates.add(gate); return gate;
  };
  return { events, contention, get contentionCount() { return contentions; }, get published() { return published; }, record, restore,
    readGate(generation) { readGate = makeGate(generation); return readGate; },
    renameGate(generation) { renamed = false; published = signal(); renameGate = makeGate(generation); return renameGate; },
    releaseAll() { for (const gate of gates) gate.release.complete(); },
    async actualRead() {
      try { return JSON.parse(await original.readFile(descriptorPath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    },
  };
}

export function descriptorPathForA01() {
  return join(process.env.LING_STACK_HOME, ".ling-stack", "browser-host", "runtime-v1.json");
}

export async function createA01Broker({ workspace = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, refreshMs = 60_000, now } = {}) {
  assertA01Isolation();
  await fs.mkdir(workspace, { recursive: true });
  const { createSqliteRunStore } = await import("../../../core/dist/index.js");
  const { ChromeBrowserSessionController, createChromeBrowserNativeBroker } = await import("../../dist/index.js");
  const { CHROME_BROWSER_PLUGIN_ID, CHROME_BROWSER_PRODUCTION_EXTENSION_ID } = await import("../../../contracts/dist/index.js");
  const store = createSqliteRunStore(workspace);
  store.upsertManagedPlugin({ id: CHROME_BROWSER_PLUGIN_ID, sourceKind: "built-in", version: "0.1.1", enabled: true,
    descriptor: { id: CHROME_BROWSER_PLUGIN_ID, displayName: "Chrome", version: "0.1.1", sourceKind: "built-in",
      trustSummary: "A01 isolated fixture", contributions: [] } }, new Date().toISOString());
  const controller = new ChromeBrowserSessionController({ workspaceCwd: workspace,
    allowedExtensionIds: [CHROME_BROWSER_PRODUCTION_EXTENSION_ID], getStore: () => store, commandTimeoutMs: 500 });
  const broker = createChromeBrowserNativeBroker({ controller, workspaceCwd: workspace,
    descriptorPath: descriptorPathForA01(), hostPath: join(workspace, "missing-owned-native-host"), descriptorRefreshMs: refreshMs,
    ...(now ? { now } : {}) });
  return { broker, controller, workspace, async close() { try { await broker.close(); } finally { controller.close(); store.close(); } } };
}

export async function assertA01BrokerHandshake(descriptor, { keepOpen = false, expectedCode, hello = {} } = {}) {
  const { CHROME_BROWSER_NATIVE_PROTOCOL, CHROME_BROWSER_PRODUCTION_EXTENSION_ID } = await import("../../../contracts/dist/index.js");
  const socket = connect({ host: "127.0.0.1", port: descriptor.port });
  let succeeded = false;
  try {
    await bounded(new Promise((done, reject) => { socket.once("connect", done); socket.once("error", reject); }), "owned broker connect");
    const result = bounded(new Promise((done, reject) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", bytes => {
        buffer = Buffer.concat([buffer, bytes]);
        if (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
          try { done(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)))); } catch (error) { reject(error); }
        }
      });
      socket.once("error", reject); socket.once("end", () => reject(new Error("A01 owned handshake ended")));
    }), "owned broker native ready");
    const payload = Buffer.from(JSON.stringify({ protocol: CHROME_BROWSER_NATIVE_PROTOCOL, type: "hello",
      extensionVersion: "0.1.1", hostVersion: "0.1.1", paused: false, token: descriptor.token,
      origin: `chrome-extension://${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}/`, ...hello }));
    const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
    const response = await result;
    if (expectedCode) assert.equal(response.code, expectedCode);
    else assert.equal(response.connected, true);
    succeeded = true;
    return socket;
  } finally { if (!keepOpen || !succeeded) socket.destroy(); }
}

export function spawnA01Worker(entryUrl, role, workspace) {
  const child = spawn(process.execPath, [fileURLToPath(entryUrl)], {
    env: a01Environment(process.env.LING_STACK_HOME, workspace, role), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [], listeners = new Set(); let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
  child.on("message", message => { messages.push(message); for (const listener of listeners) listener(message); });
  const exited = new Promise((done, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => {
      process.stdout.write(stdout); process.stderr.write(stderr);
      console.log(`A01 worker exit: ${JSON.stringify({ role, workspace, code, signal })}`); done({ code, signal });
    });
  });
  return { child, exited, send(message) { child.send(message); },
    wait(kind) { return this.waitAny([kind]); },
    async waitAny(kinds) {
      const existing = messages.find(message => kinds.includes(message.kind)); if (existing) return existing;
      let listener;
      try { return await bounded(new Promise(done => { listener = message => { if (kinds.includes(message.kind)) done(message); }; listeners.add(listener); }), `worker ${role} ${kinds.join("/")}`); }
      finally { listeners.delete(listener); }
    },
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { registerExecutionEngineIpc } from "../dist/main/execution-engines/ipc.js";
import { DESKTOP_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";

const documentUrl = "file:///fixture/web/index.html";
const operationId = "a3c5e7f9-1234-4567-89ab-123456789abc";
const loginOperation = { id: operationId, engineId: "codex-app-server", profileId: "fixture-profile", profileRevision: 2,
  expiresAt: "2099-01-01T00:00:00Z", status: "waiting",
  challenge: { type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "fixture-code" } };
const loginRoutes = [
  ["executionEngineLoginStart", "startLogin", ["codex-app-server", 2, "chatgptDeviceCode"]],
  ["executionEngineLoginGet", "getLogin", ["codex-app-server", operationId]],
  ["executionEngineLoginCancel", "cancelLogin", ["codex-app-server", operationId]],
];

function fixture() {
  const handlers = new Map();
  const frame = { url: documentUrl, detached: false };
  const webContents = { id: 1, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  let reads = 0;
  const calls = [];
  const client = Object.fromEntries(["listProfiles", "getProfile", "saveProfile", "saveProfileWithSecret", "disconnectProfile", "probeProfile", "probeConnection",
    "startLogin", "getLogin", "cancelLogin"].map((name) => [name, async (...args) => {
    calls.push({ name, args });
    return loginRoutes.some(([, method]) => method === name) ? loginOperation : { profiles: [] };
  }]));
  const input = { ipcMainImpl: { handle: (key, fn) => handlers.set(key, fn), removeHandler: (key) => handlers.delete(key) },
    getMainWindow: () => window, trustedDocumentUrl: documentUrl, getClient: async () => { reads++; return client; } };
  return { input, handlers, event, frame, calls, client, reads: () => reads };
}

test("engine IPC exposes the exact profile, discovery, managed install and owned login routes, never the host authority", async () => {
  const f = fixture();
  const unregister = registerExecutionEngineIpc(f.input);
  assert.deepEqual(new Set(f.handlers.keys()), new Set([
    DESKTOP_IPC_CHANNELS.executionEnginesList,
    DESKTOP_IPC_CHANNELS.executionEnginesDiscover,
    DESKTOP_IPC_CHANNELS.executionEnginesInstall,
    DESKTOP_IPC_CHANNELS.executionEnginesInstallStatus,
    DESKTOP_IPC_CHANNELS.executionEngineProfileGet,
    DESKTOP_IPC_CHANNELS.executionEngineProfileSave,
    DESKTOP_IPC_CHANNELS.executionEngineProfileDisconnect,
    DESKTOP_IPC_CHANNELS.executionEngineProfileSecretSave,
    DESKTOP_IPC_CHANNELS.executionEngineProfileProbe,
    DESKTOP_IPC_CHANNELS.executionEngineConnectionProbe,
    ...loginRoutes.map(([channel]) => DESKTOP_IPC_CHANNELS[channel]),
  ]));
  const configuration = { engineId: "codex-app-server", executablePath: "/fixture/codex", authProfileId: "native" };
  await f.handlers.get(DESKTOP_IPC_CHANNELS.executionEnginesList)(f.event);
  await f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineProfileGet)(f.event, "codex-app-server");
  await f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineProfileSave)(f.event, "codex-app-server", { expectedRevision: 0, configuration });
  await f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineProfileDisconnect)(f.event, "codex-app-server", 1);
  await f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineProfileProbe)(f.event, "codex-app-server", 1);
  await f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineConnectionProbe)(f.event, "codex-app-server", 1);
  assert.deepEqual(f.calls.map((c) => c.name), ["listProfiles", "getProfile", "saveProfile", "disconnectProfile", "probeProfile", "probeConnection"]);
  assert.equal([...f.handlers.keys()].some((name) => /token|enrollment|credential/.test(name)), false);
  unregister();
  assert.equal(f.handlers.size, 0);
});

test("login IPC forwards exactly the typed arguments and returns the owned operation", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  for (const [channel, , args] of loginRoutes) {
    assert.deepEqual(await f.handlers.get(DESKTOP_IPC_CHANNELS[channel])(f.event, ...args), loginOperation);
  }
  await f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineLoginStart)(f.event, "codex-app-server", 2, "chatgpt");
  assert.deepEqual(f.calls, [
    ...loginRoutes.map(([, name, args]) => ({ name, args })),
    { name: "startLogin", args: ["codex-app-server", 2, "chatgpt"] },
  ]);
});

test("write-only secret IPC validates payloads and sender before client access", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  const handle = f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineProfileSecretSave);
  const request = { expectedRevision: 0, configuration: { engineId: "codex-app-server", executablePath: "/fixture/codex", authProfileId: "new" }, secret: "synthetic-private-key" };
  for (const secret of [undefined, "", "a\nb", "密".repeat(1024), ["value"]]) {
    await assert.rejects(handle(f.event, "codex-app-server", { ...request, secret }), /engine_request_invalid/);
  }
  await assert.rejects(handle(f.event, "codex-app-server", { ...request, configuration: { ...request.configuration, secretRef: "env:KEY" } }), /engine_request_invalid/);
  await assert.rejects(handle({ ...f.event, senderFrame: { ...f.frame } }, "codex-app-server", request), /engine_ipc_forbidden/);
  assert.equal(f.reads(), 0);
  await handle(f.event, "codex-app-server", request);
  assert.deepEqual(f.calls, [{ name: "saveProfileWithSecret", args: ["codex-app-server", request] }]);
  f.client.saveProfileWithSecret = async () => { throw new Error("synthetic-private-key"); };
  await assert.rejects(handle(f.event, "codex-app-server", request), { message: "engine_operation_failed" });
});

test("invalid login payloads fail before IPC client resolution", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  const start = f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineLoginStart);
  for (const method of [undefined, null, {}, ["chatgpt"], "", "api_key", "chatgptAuthTokens", "device_code", "CHATGPT"]) {
    await assert.rejects(start(f.event, "codex-app-server", 2, method), /engine_request_invalid/);
  }
  for (const revision of [undefined, null, "2", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(start(f.event, "codex-app-server", revision, "chatgptDeviceCode"), /engine_request_invalid/);
  }
  for (const channel of [DESKTOP_IPC_CHANNELS.executionEngineLoginGet, DESKTOP_IPC_CHANNELS.executionEngineLoginCancel]) {
    const handler = f.handlers.get(channel);
    for (const id of [undefined, null, 42, {}, [operationId], "", "not-a-uuid", operationId.replaceAll("-", ""),
      ` ${operationId}`, `${operationId}\n`, `${operationId}/../profile`, `${operationId}?code=private`, `${operationId}%2f`]) {
      await assert.rejects(handler(f.event, "codex-app-server", id), /engine_request_invalid/);
    }
  }
  for (const [channel, , args] of loginRoutes) {
    const handler = f.handlers.get(DESKTOP_IPC_CHANNELS[channel]);
    await assert.rejects(handler(f.event, ...args, "extra"), /engine_request_invalid/);
    await assert.rejects(handler(f.event, ...args.slice(0, -1)), /engine_request_invalid/);
    for (const engineId of [null, "../../health", "other", ["codex-app-server"]]) {
      await assert.rejects(handler(f.event, engineId, ...args.slice(1)), /engine_request_invalid/);
    }
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.calls.length, 0);
});

test("API-key IPC selects the saved secret reference without accepting renderer key material", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  const start = f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineLoginStart);
  await start(f.event, "codex-app-server", 2, "apiKey");
  assert.deepEqual(f.calls, [{ name: "startLogin", args: ["codex-app-server", 2, "apiKey"] }]);
  await assert.rejects(start(f.event, "codex-app-server", 2, "apiKey", "private-renderer-key"), /engine_request_invalid/);
  assert.equal(f.calls.length, 1);
});

test("all login IPCs reject foreign senders, child frames and untrusted documents", async () => {
  for (const [channel, , args] of loginRoutes) {
    const f = fixture();
    registerExecutionEngineIpc(f.input);
    const handler = f.handlers.get(DESKTOP_IPC_CHANNELS[channel]);
    for (const event of [
      { ...f.event, sender: { ...f.event.sender, id: 2 } },
      { ...f.event, senderFrame: { ...f.frame } },
      { ...f.event, senderFrame: undefined },
    ]) await assert.rejects(handler(event, ...args), /engine_ipc_forbidden/);
    f.frame.detached = true;
    await assert.rejects(handler(f.event, ...args), /engine_ipc_forbidden/);
    f.frame.detached = false;
    for (const url of ["https://attacker.example", "file:///fixture/other.html"]) {
      f.frame.url = url;
      await assert.rejects(handler(f.event, ...args), /engine_ipc_forbidden/);
    }
    assert.equal(f.reads(), 0);
    assert.equal(f.calls.length, 0);
  }
});

test("Kimi terminal IPC forwards typed intent but rejects raw commands and foreign senders", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  const start = f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineLoginStart);
  const operation = { ...loginOperation, engineId: "kimi-acp", challenge: { type: "terminal", text: "fixture-terminal-code" } };
  f.client.startLogin = async (...args) => { f.calls.push({ name: "startLogin", args }); return operation; };
  assert.deepEqual(await start(f.event, "kimi-acp", 2, "terminal"), operation);
  assert.deepEqual(f.calls, [{ name: "startLogin", args: ["kimi-acp", 2, "terminal"] }]);
  await assert.rejects(start(f.event, "kimi-acp", 2, "terminal", { command: "arbitrary-shell" }), /engine_request_invalid/);
  await assert.rejects(start({ ...f.event, sender: { ...f.event.sender, id: 99 } }, "kimi-acp", 2, "terminal"), /engine_ipc_forbidden/);
  assert.equal(f.calls.length, 1);
});

test("navigation during client resolution fences all login operations", async () => {
  for (const [channel, , args] of loginRoutes) {
    const f = fixture();
    registerExecutionEngineIpc({ ...f.input, getClient: async () => {
      const client = await f.input.getClient();
      f.frame.url = "https://attacker.example";
      return client;
    } });
    await assert.rejects(f.handlers.get(DESKTOP_IPC_CHANNELS[channel])(f.event, ...args), /engine_ipc_forbidden/);
    assert.equal(f.reads(), 1);
    assert.equal(f.calls.length, 0);
  }
});

test("a late login challenge is withheld after navigation or sender destruction", async () => {
  for (const [channel, method, args] of loginRoutes) {
    for (const change of ["navigation", "destruction"]) {
      const f = fixture();
      let release;
      const response = new Promise((resolve) => { release = resolve; });
      let called;
      const started = new Promise((resolve) => { called = resolve; });
      f.client[method] = async () => { called(); return response; };
      registerExecutionEngineIpc(f.input);
      const request = f.handlers.get(DESKTOP_IPC_CHANNELS[channel])(f.event, ...args);
      await started;
      if (change === "navigation") f.frame.url = "https://attacker.example";
      else f.event.sender.isDestroyed = () => true;
      release(loginOperation);
      await assert.rejects(request, /engine_ipc_forbidden/);
    }
  }
});

test("login IPC exposes stable error codes but not native errors or challenges", async () => {
  for (const [channel, method, args] of loginRoutes) {
    for (const [error, expected] of [
      [new Error("private-native-error fixture-code"), "engine_operation_failed"],
      [Object.assign(new Error("private-native-error fixture-code"), { code: "engine_login_browser_unsupported" }), "engine_login_browser_unsupported"],
    ]) {
      const f = fixture();
      f.client[method] = async () => { throw error; };
      registerExecutionEngineIpc(f.input);
      await assert.rejects(f.handlers.get(DESKTOP_IPC_CHANNELS[channel])(f.event, ...args), { message: expected });
    }
  }
});

test("foreign windows, child frames and navigated documents cannot read host credentials", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  const read = f.handlers.get(DESKTOP_IPC_CHANNELS.executionEnginesList);
  for (const event of [
    { ...f.event, sender: { ...f.event.sender, id: 2 } },
    { ...f.event, senderFrame: { ...f.frame } },
    { ...f.event, senderFrame: undefined },
  ]) await assert.rejects(read(event), /engine_ipc_forbidden/);
  f.frame.url = "https://attacker.example";
  await assert.rejects(read(f.event), /engine_ipc_forbidden/);
  f.frame.url = "file:///fixture/other.html";
  await assert.rejects(read(f.event), /engine_ipc_forbidden/);
  assert.equal(f.reads(), 0);
});

test("navigation during authority loading fences the eventual native operation", async () => {
  const f = fixture();
  registerExecutionEngineIpc({ ...f.input, getClient: async () => {
    const client = await f.input.getClient();
    f.frame.url = "https://attacker.example";
    return client;
  } });
  await assert.rejects(f.handlers.get(DESKTOP_IPC_CHANNELS.executionEnginesList)(f.event), /engine_ipc_forbidden/);
  assert.equal(f.calls.length, 0);
});

test("invalid ids, extra payloads and stale revisions fail before authority loading", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  for (const [channel, args] of [
    [DESKTOP_IPC_CHANNELS.executionEnginesList, ["extra"]],
    [DESKTOP_IPC_CHANNELS.executionEngineProfileGet, ["../../health"]],
    [DESKTOP_IPC_CHANNELS.executionEngineProfileDisconnect, ["codex-app-server", -1]],
    [DESKTOP_IPC_CHANNELS.executionEngineConnectionProbe, ["codex-app-server", 1, "extra"]],
    [DESKTOP_IPC_CHANNELS.executionEngineProfileSave, ["codex-app-server", { expectedRevision: 0, configuration: { engineId: "kimi-acp" } }]],
  ]) await assert.rejects(f.handlers.get(channel)(f.event, ...args), /engine_request_invalid/);
  assert.equal(f.reads(), 0);
});

test("connection probes retain window and frame checks before any client operation", async () => {
  const f = fixture();
  registerExecutionEngineIpc(f.input);
  const probe = f.handlers.get(DESKTOP_IPC_CHANNELS.executionEngineConnectionProbe);
  await assert.rejects(probe({ ...f.event, senderFrame: { ...f.frame } }, "codex-app-server", 1), /engine_ipc_forbidden/);
  f.frame.url = "https://attacker.example";
  await assert.rejects(probe(f.event, "codex-app-server", 1), /engine_ipc_forbidden/);
  assert.equal(f.reads(), 0);
});

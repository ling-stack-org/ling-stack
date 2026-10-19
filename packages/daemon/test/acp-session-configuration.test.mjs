import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AcpLiveClient } from "../dist/runtime/acp/live-client.js";

const cwd = "/tmp/ling-owned-config-fixture";
const prompt = [{ type: "text", text: "Synthetic prompt; no model executes" }];
const openclawRoute = { agentId: "fixture", sessionKey: "agent:fixture:ling:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", requireExistingSession: false };
const select = (id, currentValue, values, category = id) => ({ id, name: id, type: "select", category,
  currentValue, options: values.map(value => ({ value, name: value })) });
const catalog = () => [select("model", "model-a", ["model-a", "model-b"]),
  select("mode", "default", ["default", "plan", "auto", "yolo"]),
  select("thinking", "off", ["off", "on"], "thought_level")];

function setup(t, options = {}) {
  const output = new PassThrough();
  const abort = new AbortController();
  const wire = [];
  const accepted = [];
  const updates = [];
  let configOptions = structuredClone(options.catalog ?? catalog());
  const send = message => output.write(`${JSON.stringify(message)}\n`);
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const update = value => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: value } });
  const peer = { send, result, update, get catalog() { return structuredClone(configOptions); } };
  const input = new Writable({ write(bytes, _encoding, done) {
    const message = JSON.parse(bytes.toString()); wire.push(message);
    if (options.onWire?.(message, peer) !== true) {
      if (message.method === "initialize") result(message.id, { protocolVersion: 1,
        agentInfo: { name: options.engineId === "openclaw-acp" ? "openclaw-acp" : "Kimi Code CLI", version: "fixture" },
        agentCapabilities: { loadSession: true }, authMethods: [] });
      if (["session/new", "session/load"].includes(message.method)) result(message.id, {
        ...(message.method === "session/new" ? { sessionId: "session-1" } : {}), configOptions,
      });
      if (message.method === "session/set_config_option") {
        const { configId, value } = message.params;
        configOptions = configOptions.map(option => option.id === configId ? { ...option, currentValue: value } : option);
        if (configId === "model") configOptions = configOptions.map(option => option.id === "thinking"
          ? select("thinking", "low", ["low", "high"], "thought_level") : option);
        update({ sessionUpdate: "config_option_update", configOptions });
        result(message.id, { configOptions });
      }
      if (message.method === "session/prompt") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Synthetic completion" } });
        result(message.id, { stopReason: "end_turn" });
      }
    }
    done();
  } });
  const client = new AcpLiveClient({ input, output, signal: abort.signal, engineId: options.engineId ?? "kimi-acp", expectedVersion: "fixture",
    requestTimeoutMs: 100, hostTimeoutMs: 200, turnTimeoutMs: 1000,
    onSessionAccepted: async binding => { accepted.push(binding); await options.onAccepted?.(binding); },
    onPromptSubmitting: async () => {}, onUpdate: async update => { updates.push(update); }, onPermission: async () => "deny",
    ...options.client });
  t.after(async () => { client.close(); input.destroy(); output.destroy(); await client.closed; });
  return { client, wire, accepted, updates, peer, abort };
}

test("ACP applies the selected model before negotiating that model's thinking level and accepting the session", async t => {
  const f = setup(t);
  await f.client.initialize();
  const configuration = { cwd, modelId: "model-b", thoughtLevel: "high" };
  assert.deepEqual(await f.client.openSession(configuration), { sessionId: "session-1", configuration });
  assert.deepEqual(f.wire.filter(message => message.method === "session/set_config_option").map(message => message.params), [
    { sessionId: "session-1", configId: "model", value: "model-b" },
    { sessionId: "session-1", configId: "thinking", value: "high" },
  ]);
  assert.equal(f.accepted.length, 1);
  assert.equal(f.client.sessionSettings.configOptions.find(option => option.id === "model").currentValue, "model-b");
  assert.equal((await (await f.client.startPrompt(prompt)).completed).stopReason, "end_turn");
});

test("Kimi negotiates manual Plan mode before model configuration without surfacing automatic approval modes", async t => {
  const f = setup(t);
  await f.client.initialize();
  await f.client.openSession({ cwd, modeId: "plan", modelId: "model-b" });
  assert.deepEqual(f.wire.filter(message => message.method === "session/set_config_option").map(message => message.params), [
    { sessionId: "session-1", configId: "mode", value: "plan" },
    { sessionId: "session-1", configId: "model", value: "model-b" },
  ]);
  assert.equal((await (await f.client.startPrompt(prompt)).completed).stopReason, "end_turn");
});

test("Kimi cannot begin a prompt when the native current mode silently skips approvals", async t => {
  const options = catalog(); options[1].currentValue = "yolo";
  const f = setup(t, { catalog: options });
  await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd }), { code: "unsupported_capability" });
  assert.deepEqual(f.accepted, []);
  assert.equal(f.wire.some(message => message.method === "session/prompt"), false);
});

test("legacy mode negotiation waits for the confirmed native mode notification", async t => {
  let confirmation;
  const f = setup(t, { onWire: (message, peer) => {
    if (message.method === "session/new") {
      peer.result(message.id, { sessionId: "session-1", modes: { currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } }); return true;
    }
    if (message.method === "session/set_mode") {
      confirmation = () => peer.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
      peer.result(message.id, {}); return true;
    }
  } });
  await f.client.initialize();
  const opening = f.client.openSession({ cwd, modeId: "plan" });
  for (let i = 0; i < 10 && !confirmation; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof confirmation, "function");
  assert.deepEqual(f.accepted, []);
  confirmation();
  await opening;
  assert.equal(f.client.sessionSettings.modes.currentModeId, "plan");
  assert.equal((await (await f.client.startPrompt(prompt)).completed).stopReason, "end_turn");
});

test("a native current-mode notification cannot switch a bound Kimi session to yolo", async t => {
  const f = setup(t);
  await f.client.initialize(); await f.client.openSession({ cwd });
  f.peer.update({ sessionUpdate: "current_mode_update", currentModeId: "yolo" });
  await assert.rejects(f.client.startPrompt(prompt), { code: "binding_mismatch" });
  assert.equal(f.wire.some(message => message.method === "session/prompt"), false);
});

test("OpenClaw thought_level is negotiated as thinking, not a permission mode", async t => {
  const f = setup(t, { engineId: "openclaw-acp", catalog: [select("thought_level", "low", ["low", "high"])] });
  await f.client.initialize();
  await f.client.openSession({ cwd, thoughtLevel: "high" }, undefined, openclawRoute);
  assert.deepEqual(f.wire.filter(message => message.method === "session/set_config_option").map(message => message.params), [
    { sessionId: "session-1", configId: "thought_level", value: "high" },
  ]);
  assert.equal(f.wire.some(message => message.method === "session/set_mode"), false);
});

for (const configuration of [{ modeId: "plan" }, { modelId: "model-b" }]) test("OpenClaw cannot reuse Kimi's mode or model configuration", async t => {
  const f = setup(t, { engineId: "openclaw-acp" });
  await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd, ...configuration }, undefined, openclawRoute), { code: "unsupported_capability" });
  assert.equal(f.wire.some(message => message.method.startsWith("session/set_")), false);
  assert.deepEqual(f.accepted, []);
});

test("a mode notification during binding cannot be lost behind a previously received catalog", async t => {
  const f = setup(t, { onWire: (message, peer) => {
    if (message.method !== "session/new") return;
    peer.result(message.id, { sessionId: "session-1", configOptions: catalog() });
    peer.update({ sessionUpdate: "current_mode_update", currentModeId: "yolo" }); return true;
  } });
  await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd }), { code: "binding_mismatch" });
  assert.deepEqual(f.accepted, []);
});

test("configuration updates before the new-session response still require the accepted session identity", async t => {
  const f = setup(t, { onWire: (message, peer) => {
    if (message.method !== "session/new") return;
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other-session",
      update: { sessionUpdate: "config_option_update", configOptions: catalog() } } });
    peer.result(message.id, { sessionId: "session-1", configOptions: catalog() }); return true;
  } });
  await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd }), { code: "binding_mismatch" });
  assert.deepEqual(f.accepted, []);
});

test("load preserves its native session and does not send a guessed or already-effective model", async t => {
  const f = setup(t);
  await f.client.initialize(); await f.client.openSession({ cwd, modelId: "model-a" }, "session-1");
  assert.equal(f.wire.some(message => message.method === "session/new" || message.method.startsWith("session/set_")), false);
  const snapshot = f.client.sessionSettings;
  snapshot.configOptions[0].currentValue = "model-b";
  assert.equal(f.client.sessionSettings.configOptions[0].currentValue, "model-a");
  await (await f.client.startPrompt(prompt)).completed;
});

test("grouped model options use wire values, not their repeated labels or optional category", async t => {
  const models = { id: "model", name: "Name", type: "select", currentValue: "model-a", options: [
    { group: "route-a", name: "Route", options: [{ value: "model-a", name: "Same" }] },
    { group: "route-b", name: "Route", options: [{ value: "model-b", name: "Same" }] },
  ] };
  const f = setup(t, { catalog: [models] });
  await f.client.initialize(); await f.client.openSession({ cwd, modelId: "model-b" });
  assert.equal(f.wire.find(message => message.method === "session/set_config_option").params.value, "model-b");
});

for (const [label, configOptions] of [
  ["duplicate ids", [select("model", "a", ["a"]), select("model", "b", ["b"])]],
  ["duplicate values", [select("model", "a", ["a", "a"])]],
  ["invalid current value", [select("model", "missing", ["a"])]],
  ["invalid name discarded by SDK", [{ ...select("model", "a", ["a"]), name: ["private payload"] }]],
  ["mixed grouped options", [{ ...select("model", "a", ["a"]), options: [
    { value: "a", name: "A" }, { group: "group", name: "Group", options: [{ value: "b", name: "B" }] },
  ] }]],
]) test(`raw ACP catalog rejects ${label} before host acceptance`, async t => {
  const f = setup(t, { catalog: configOptions });
  await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd }), { code: "protocol_error" });
  assert.deepEqual(f.accepted, []);
});

for (const fault of ["wrong-value", "missing-config", "remote-error", "timeout", "cancel"]) test(`configuration ${fault} cannot accept a session or submit a prompt`, async t => {
  const f = setup(t, { onWire: (message, peer) => {
    if (message.method !== "session/set_config_option") return;
    if (fault === "wrong-value") peer.result(message.id, { configOptions: catalog() });
    if (fault === "missing-config") peer.result(message.id, {});
    if (fault === "remote-error") peer.send({ jsonrpc: "2.0", id: message.id,
      error: { code: -32602, message: "private token=SECRET-DO-NOT-EXPOSE", data: { private: "SECRET-DO-NOT-EXPOSE" } } });
    if (fault === "cancel") f.abort.abort();
    return true;
  } });
  await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd, modelId: "model-b" }), error => {
    assert.equal(error.code, fault === "wrong-value" ? "binding_mismatch" : fault === "cancel" ? "cancelled" : fault === "timeout" ? "timeout" : "protocol_error");
    assert.equal(String(error.stack).includes("SECRET-DO-NOT-EXPOSE"), false);
    assert.equal(error.outcome, "not_submitted"); return true;
  });
  assert.deepEqual(f.accepted, []);
  assert.equal(f.wire.some(message => message.method === "session/prompt"), false);
});

test("model drift during a prompt fails the owned submission without emitting the changed catalog", async t => {
  let acceptedPrompts = 0;
  const f = setup(t, { client: { onPromptAccepted: () => { acceptedPrompts++; } }, onWire: (message, peer) => {
    if (message.method !== "session/prompt") return;
    const changed = catalog(); changed[0].currentValue = "model-b";
    peer.update({ sessionUpdate: "config_option_update", configOptions: changed }); return true;
  } });
  await f.client.initialize(); await f.client.openSession({ cwd, modelId: "model-a" });
  await assert.rejects(async () => { await (await f.client.startPrompt(prompt)).completed; }, { code: "binding_mismatch", outcome: "unknown" });
  assert.equal(acceptedPrompts, 0);
  assert.deepEqual(f.updates, []);
});

test("model-dependent unsupported thinking cannot silently fall back or accept the session", async t => {
  const f = setup(t);
  await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd, modelId: "model-b", thoughtLevel: "off" }), { code: "unsupported_capability" });
  assert.deepEqual(f.wire.filter(message => message.method === "session/set_config_option").map(message => message.params.configId), ["model"]);
  assert.deepEqual(f.accepted, []);
});

test("load response supersedes historical mode replay before freezing current configuration", async t => {
  const f = setup(t, { onWire: (message, peer) => {
    if (message.method !== "session/load") return;
    peer.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    peer.result(message.id, { configOptions: catalog() }); return true;
  } });
  await f.client.initialize(); await f.client.openSession({ cwd }, "session-1");
  assert.equal(f.client.sessionSettings.configOptions.find(option => option.id === "mode").currentValue, "default");
  assert.equal((await (await f.client.startPrompt(prompt)).completed).stopReason, "end_turn");
});

for (const engineId of ["kimi-acp", "openclaw-acp"]) test(`owned ${engineId} child confirms session configuration and streams a prompt`, { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url))], {
    env: { LING_ACP_PEER_ENGINE: engineId, LING_ACP_PEER_CONFIGURATION: "true" }, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close");
  const wire = [];
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  child.on("message", message => wire.push(message));
  const configuration = { cwd, ...(engineId === "kimi-acp" ? { modelId: "model-b", modeId: "plan" } : {}), thoughtLevel: "high" };
  let accepted;
  const updates = [];
  const client = new AcpLiveClient({ input: child.stdin, output: child.stdout, signal: new AbortController().signal,
    engineId, expectedVersion: "owned-peer-1", requestTimeoutMs: 1000, turnTimeoutMs: 2000,
    onSessionAccepted: async binding => { accepted = binding; }, onPromptSubmitting: async () => {},
    onUpdate: async update => { updates.push(update); }, onPermission: async () => "deny" });
  t.after(async () => { client.close(); child.kill(); await closed; });
  await client.initialize(); await client.openSession(configuration, undefined, engineId === "openclaw-acp" ? openclawRoute : undefined);
  assert.deepEqual(accepted, { sessionId: "owned-session", configuration });
  assert.equal((await (await client.startPrompt(prompt)).completed).stopReason, "end_turn");
  client.close();
  assert.equal((await closed)[0], 0);
  assert.equal(stderr, "");
  assert.deepEqual(wire.filter(message => message.method === "session/set_config_option").map(message => [message.params.configId, message.params.value]),
    engineId === "kimi-acp" ? [["mode", "plan"], ["model", "model-b"], ["thinking", "high"]] : [["thought_level", "high"]]);
  assert.ok(updates.some(update => update.update.content?.text === "final decision output"));
  assert.equal(updates.some(update => ["config_option_update", "current_mode_update"].includes(update.update.sessionUpdate)), false);
});

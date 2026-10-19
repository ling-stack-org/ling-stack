import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { AcpLiveClient } from "../dist/runtime/acp/live-client.js";
import { acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";

const route = () => ({ agentId: "main", sessionKey: `agent:main:ling:${randomUUID()}`, requireExistingSession: false });
function fixture(t, engineId = "openclaw-acp") {
  const output = new PassThrough(), wire = [], accepted = [];
  const send = (id, result) => output.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const input = new Writable({ write(bytes, _encoding, done) {
    const message = JSON.parse(bytes.toString()); wire.push(message);
    if (message.method === "initialize") send(message.id, { protocolVersion: 1,
      agentInfo: { name: engineId === "openclaw-acp" ? engineId : "Kimi Code CLI", version: "fixture" },
      agentCapabilities: { loadSession: true }, authMethods: [] });
    if (message.method === "session/new") send(message.id, { sessionId: "acp-uuid" });
    if (message.method === "session/load") send(message.id, {});
    if (message.method === "session/prompt") send(message.id, { stopReason: "cancelled" });
    done();
  } });
  const client = new AcpLiveClient({ input, output, signal: new AbortController().signal, engineId, expectedVersion: "fixture",
    onSessionAccepted: async () => {}, onPromptSubmitting: async () => {},
    onPromptAccepted: value => accepted.push(value), onUpdate: async () => {}, onPermission: async () => "deny" });
  t.after(async () => { client.close(); await client.closed; input.destroy(); output.destroy(); });
  return { client, wire, accepted };
}

for (const load of [false, true]) for (const requireExistingSession of [false, true]) {
  test(`OpenClaw ${load ? "load" : "new"} sends only its trusted route (history=${requireExistingSession})`, async t => {
    const f = fixture(t), selected = { ...route(), requireExistingSession };
    await f.client.initialize();
    await f.client.openSession({ cwd: "/tmp/owned" }, load ? "acp-uuid" : undefined, selected);
    const expected = { cwd: "/tmp/owned", mcpServers: [],
      _meta: { sessionKey: selected.sessionKey, resetSession: false, requireExistingSession },
      ...(load ? { sessionId: "acp-uuid" } : {}) };
    assert.deepEqual(f.wire.find(value => value.method === (load ? "session/load" : "session/new")).params, expected);
    assert.deepEqual(f.wire.map(value => value.method), ["initialize", load ? "session/load" : "session/new"]);
  });
}

test("OpenClaw rejects missing or caller-selected metadata before sending a session request", async t => {
  const valid = route();
  const candidates = [undefined, null, {}, { ...valid, sessionKey: "agent:main:main" },
    { ...valid, sessionKey: `agent:main:acp:${randomUUID()}` }, { ...valid, agentId: "other" },
    { ...valid, agentId: "MAIN" }, { ...valid, requireExistingSession: "false" },
    { ...valid, sessionLabel: "global" }, { ...valid, resetSession: true },
    { ...valid, _meta: { sessionKey: "agent:main:main" } }];
  for (const selected of candidates) {
    const f = fixture(t); await f.client.initialize();
    await assert.rejects(f.client.openSession({ cwd: "/tmp/owned" }, undefined, selected), { code: "invalid_input" });
    assert.deepEqual(f.wire.map(value => value.method), ["initialize"]);
  }
});

test("Kimi never accepts OpenClaw routing and retains its original session wire", async t => {
  const f = fixture(t, "kimi-acp"); await f.client.initialize();
  await assert.rejects(f.client.openSession({ cwd: "/tmp/owned" }, undefined, route()), { code: "invalid_input" });
  assert.deepEqual(f.wire.map(value => value.method), ["initialize"]);
  await f.client.openSession({ cwd: "/tmp/owned" });
  assert.deepEqual(f.wire.at(-1).params, { cwd: "/tmp/owned", mcpServers: [] });
});

test("OpenClaw configuration fingerprints bind the canonical selected Agent without changing Kimi", () => {
  const configuration = { cwd: "/tmp/owned" }, target = { engineId: "openclaw-acp", expectedVersion: "fixture", agentId: "Main" };
  assert.equal(acpConfigurationFingerprint(target, configuration), acpConfigurationFingerprint({ ...target, agentId: "main" }, configuration));
  assert.notEqual(acpConfigurationFingerprint(target, configuration), acpConfigurationFingerprint({ ...target, agentId: "other" }, configuration));
  for (const agentId of [undefined, "", "with.dot", "a".repeat(65)]) {
    assert.throws(() => acpConfigurationFingerprint({ ...target, agentId }, configuration), { code: "invalid_input" });
  }
  assert.throws(() => acpConfigurationFingerprint({ ...target, engineId: "kimi-acp" }, configuration), { code: "invalid_input" });
});

test("OpenClaw cancellation alone is not accepted remote-history evidence", async t => {
  const f = fixture(t); await f.client.initialize();
  await f.client.openSession({ cwd: "/tmp/owned" }, undefined, route());
  assert.equal((await (await f.client.startPrompt([{ type: "text", text: "Synthetic" }])).completed).stopReason, "cancelled");
  assert.deepEqual(f.accepted, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonServer } from "../dist/index.js";

const binding = { kind: "native_profile", engineId: "codex-app-server", profileId: "fixture-profile", profileRevision: 2, nativeModelId: "fixture-model" };

// Synthetic host dispatcher validates integration; no model/platform certification is claimed.
async function fixture(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-native-conversation-"));
  const previous = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "host");
  const calls = [];
  let available = true;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false } }, {
    remoteReplyDispatcher: null,
    nativeRunTargetDispatcher: {
      async assertAvailable(input) { if (!available) throw new Error("fixture availability revoked"); await options.inspect?.(input); },
      async dispatch(input) {
        calls.push(input);
        await options.dispatch?.(input, calls);
        const event = input.store.appendEvent(input.run.id, "assistant_text_delta", { text: "NATIVE_CANONICAL_REPLY" });
        input.onEvent(event);
        return { status: "completed", events: [event] };
      },
    },
  });
  t.after(async () => {
    await daemon.stop();
    if (previous === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = previous;
    rmSync(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const baseUrl = `http://127.0.0.1:${daemon.server.address().port}`;
  const url = path => `${baseUrl}${path}?cwd=${encodeURIComponent(cwd)}`;
  const initial = await (await fetch(url("/runtime/settings"))).json();
  const response = await fetch(url("/runtime/settings"), { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: initial.settings.updatedAt,
      allowedRunnerIds: ["pi", "codex-app-server"], defaultRunnerId: "codex-app-server", defaultExecutionBinding: binding }) });
  assert.equal(response.status, 200, await response.text());
  return { calls, url, revoke() { available = false; }, async send(input) {
    const response = await fetch(url("/conversations/stream"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.text() };
  } };
}

for (const explicit of [true, false]) test(`native conversation persists canonical binding and replay (${explicit ? "explicit" : "workspace default"})`, async t => {
  const f = await fixture(t);
  const input = { message: "NATIVE_USER_INPUT", idempotencyKey: `native-conversation-${explicit}`, ...(explicit ? { executionBinding: binding } : {}) };
  const first = await f.send(input);
  assert.equal(first.status, 200, first.body);
  assert.match(first.body, /event: done/);
  assert.match(first.body, /NATIVE_CANONICAL_REPLY/);
  assert.equal(f.calls.length, 1);
  const { store, run, runRequest } = f.calls[0];
  assert.equal(run.providerPresetId, undefined);
  assert.equal(runRequest.provider, undefined);
  assert.deepEqual(runRequest.executionBinding, binding);
  const prepared = store.getConversationPreparedInput(runRequest.normalConversationContext.hydration.source.itemId, "request");
  assert.deepEqual(prepared.payload.request.executionBinding, binding);
  assert.equal(runRequest.normalConversationPreparedRequestRef.id, prepared.id);
  assert.equal(store.getLingTurnForRun(run.id).id, runRequest.turnId);
  assert.equal(store.getRun(run.id).status, "succeeded");
  f.revoke();
  const retry = await f.send(input);
  assert.equal(retry.status, 200, retry.body);
  assert.match(retry.body, new RegExp(run.id));
  assert.equal(f.calls.length, 1, "accepted duplicate replays before current availability/default resolution");
});

test("normal native conversation consumes canonical FIFO guidance without expanding independent permissions", async t => {
  const interventions = [];
  const f = await fixture(t, { dispatch(input, calls) {
    if (calls.length !== 1) return;
    const queuedAt = new Date().toISOString();
    for (let index = 0; index < 2; index++) interventions.push(input.store.createRunIntervention({
      id: index === 0 ? "rint_z_first" : "rint_a_second",
      sourceRunId: input.run.id, sourceWorkUnitId: input.workUnit.id, sourceAttemptId: input.attempt.id,
      mode: "queue_followup", instruction: `Canonical native followup ${index}`, idempotencyKey: `normal-native-fifo-${index}`, requestedBy: "local-user",
    }, queuedAt).id);
  } });
  const response = await f.send({ message: "Native FIFO source", executionBinding: binding,
    authorizationMode: "smart", workspaceAccessMode: "read_only", permissionMode: "custom" });
  assert.equal(response.status, 200, response.body);
  const store = f.calls[0].store;
  for (let index = 0; index < 100 && !interventions.every(id => store.getRunIntervention(id).completedAt); index++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 3, JSON.stringify(interventions.map(id => store.getRunIntervention(id))));
  const root = f.calls[0].run;
  assert.deepEqual(store.listRunInterventions({ sourceRunId: root.id }).map(item => item.id), interventions);
  assert.deepEqual(f.calls.slice(1).map(call => call.runRequest.interventionId), interventions);
  for (const call of f.calls) {
    assert.deepEqual(call.runRequest.executionBinding, binding);
    assert.equal(call.runRequest.authorizationMode, "smart");
    assert.equal(call.runRequest.workspaceAccessMode, "read_only");
    assert.equal(call.runRequest.provider, undefined);
    assert.equal(call.runRequest.providerPresetId, undefined);
    const turn = store.getLingTurnForRun(call.run.id);
    assert.equal(turn.id, call.runRequest.turnId);
    assert.equal(turn.threadId, root.threadId);
    const prepared = store.getConversationPreparedInput(turn.sourceItemId, "request");
    assert.deepEqual(prepared.payload.request.executionBinding, binding);
    if (call.run.id !== root.id) {
      assert.equal(call.run.parentRunId, root.id);
      assert.equal(turn.sourceTurnId, store.getLingTurnForRun(root.id).id);
    }
  }
  for (const id of interventions) {
    const item = store.getRunIntervention(id);
    assert.equal(item.status, "started");
    assert.ok(item.completedAt);
    assert.equal(store.getRun(item.continuationRunId).status, "succeeded");
  }
});


test("conversation availability uses native admission without creating a Run", async t => {
  const f = await fixture(t);
  const response = await fetch(f.url("/runtime/conversation-execution"));
  assert.equal(response.status, 200);
  const selection = await response.json();
  assert.equal(selection.status, "ready");
  assert.deepEqual(selection.executionBinding, binding);
  assert.equal(f.calls.length, 0);
  f.revoke();
  const blocked = await (await fetch(f.url("/runtime/conversation-execution"))).json();
  assert.equal(blocked.status, "blocked");
  assert.equal(f.calls.length, 0);
});

test("native FIFO successor is blocked when current execution authority is revoked", async t => {
  let intervention, f;
  f = await fixture(t, { dispatch(input, calls) {
    if (calls.length !== 1) return;
    intervention = input.store.createRunIntervention({ sourceRunId: input.run.id, sourceWorkUnitId: input.workUnit.id,
      sourceAttemptId: input.attempt.id, mode: "queue_followup", instruction: "Must remain blocked",
      idempotencyKey: "revoked-native-successor", requestedBy: "local-user" }, new Date().toISOString());
    f.revoke();
  } });
  const response = await f.send({ message: "Native revocation source", executionBinding: binding });
  assert.equal(response.status, 200, response.body);
  const store = f.calls[0].store;
  for (let index = 0; index < 100 && ["queued", "starting_continuation"].includes(store.getRunIntervention(intervention.id).status); index++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 1, "revocation cannot invoke a successor or fall back to Pi");
  const item = store.getRunIntervention(intervention.id);
  assert.equal(item.status, "failed");
  assert.equal(item.continuationRunId, undefined);
});

test("native edited replacement inherits binding and independent permissions", async t => {
  const f = await fixture(t);
  const first = await f.send({ message: "Before edit", executionBinding: binding,
    authorizationMode: "smart", workspaceAccessMode: "read_only", permissionMode: "custom" });
  assert.equal(first.status, 200, first.body);
  const original = f.calls[0];
  const input = { surface: "normal_conversation", ownerId: original.run.threadId,
    messageId: original.store.getLingTurnForRun(original.run.id).sourceItemId, expectedRevision: 1,
    body: "After edit", idempotencyKey: "native-edit" };
  const edit = () => fetch(f.url("/conversation-message-edits"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const response = await edit();
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(f.calls.length, 2, JSON.stringify(result));
  const replacement = f.calls[1].runRequest;
  assert.deepEqual(replacement.executionBinding, binding);
  assert.equal(replacement.providerPresetId, undefined);
  assert.equal(replacement.authorizationMode, "smart");
  assert.equal(replacement.workspaceAccessMode, "read_only");
  f.revoke();
  const replay = await edit();
  assert.equal(replay.status, 200, await replay.text());
  assert.equal(f.calls.length, 2, "accepted replacement must replay without executing a new Run");
});

test("availability inspects full access without fabricating a run confirmation", async t => {
  let inspected;
  const f = await fixture(t, { inspect(input) { inspected = input; } });
  const response = await fetch(`${f.url("/runtime/conversation-execution")}&authorizationMode=smart&workspaceAccessMode=full_access`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ready");
  assert.equal(inspected.runRequest.permissionConfirmation, undefined);
  assert.equal(inspected.effectivePolicySnapshot.workspaceAccessMode, "full_access");
  assert.equal(f.calls.length, 0);
  const send = await f.send({ message: "Unconfirmed full access", executionBinding: binding,
    authorizationMode: "smart", workspaceAccessMode: "full_access" });
  assert.match(send.body, /full_access_confirmation_required/);
  assert.equal(f.calls.length, 0, "read-only inspection never grants full-access execution authority");
});

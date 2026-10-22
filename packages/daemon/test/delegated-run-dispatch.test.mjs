import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { delegationDigest, delegationPreparedExecutionDigest } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { createDelegatedRunDispatchAuthority, readOriginalDelegatedRunDispatchAuthority,
  rebuildDelegatedRunRequest } from "../dist/features/harness/delegations/delegated-run-dispatch.js";

const now = "2026-10-19T00:00:02.000Z", createdAt = "2026-10-19T00:00:01.000Z";
const fence = { workUnitId: "child-unit", attemptId: "child-attempt", runtimeInstanceId: "runtime", fencingToken: "1" };
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegated-dispatch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const adapter = new PiRunnerAdapter(), authority = createDelegatedRunDispatchAuthority();
  const task = { id: "child-task", title: "Read", prompt: "Inspect fixture files without changing them." };
  const provider = { provider: "dispatch-fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false };
  const options = { cwd, agentDir: join(cwd, "agent"), task, provider, tools: [],
    initialToolSurface: { mediaGeneration: false, toolHydration: false, userInput: false } };
  const sdkInput = await adapter.prepareTaskInput(options);
  const execution = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput: sdkInput });
  const run = { id: "child", taskId: task.id, taskSnapshot: task, cwd, workUnitId: fence.workUnitId,
    parentRunId: "root", status: "queued", providerName: provider.provider, providerModel: provider.model };
  const unit = { id: fence.workUnitId, linkedRunId: run.id, activeAttemptId: fence.attemptId,
    status: "claimed", ownerType: "delegation_step", ownerId: "step" };
  const attempt = { id: fence.attemptId, workUnitId: fence.workUnitId, runtimeInstanceId: fence.runtimeInstanceId,
    fencingToken: fence.fencingToken, attemptNumber: 1, status: "created", createdAt };
  const child = { run, workUnit: unit, attempt, step: { id: "step", rootRunId: "root", parentRunId: "root", state: "spawning" },
    reservation: { id: "reservation", state: "reserved", deadlineAt: "2026-10-19T00:01:00.000Z" }, replayed: false };
  const request = { cwd, task, parentRunId: "root", provider, runnerId: "pi", tools: [] };
  const policy = { mode: "workspace_write", workspacePolicyUpdatedAt: createdAt, toolDecisions: {}, allowedWritePaths: [cwd], riskNotes: [] };
  const token = authority.capturePreparation({ child, request, execution, policy, now });
  const payload = authority.readExecutionPreparation(token), digest = delegationPreparedExecutionDigest(payload);
  const artifact = { id: "preparation", runId: run.id, path: "sqlite:delegation-execution", sealedPayload: payload, contentSha256: digest };
  const artifacts = new Map([[artifact.id, artifact]]), runs = new Map([[run.id, run]]), attempts = new Map([[attempt.id, attempt]]);
  const store = { getRun: id => runs.get(id), getWorkUnit: id => id === unit.id ? unit : undefined,
    getWorkUnitAttempt: id => attempts.get(id), getArtifact: id => artifacts.get(id), getLingTurnForRun: () => undefined };
  const prepared = { artifactId: artifact.id, digest, payload };
  const receipt = changes => ({ schemaVersion: 1, boundary: "pi-session-ready", runId: run.id,
    attemptId: child.attempt.id, taskId: task.id, preparedInputFingerprint: sdkInput.fingerprint, ...changes });
  const accepted = [];
  const withReceiver = (changes = {}) => authority.withReceiver({ store, child, prepared, adapter, options,
    now: () => now, onAccepted: (reference, at) => { accepted.push({ observation: authority.readRunnerStartObservation(reference), at }); }, ...changes });
  return { cwd, adapter, authority, child, run, unit, attempt, request, policy, options, execution, sdkInput,
    prepared, payload, token, artifact, artifacts, runs, attempts, store, receipt, accepted, withReceiver };
}

test("dispatch composition and preparation require original factory/token custody", async t => {
  const f = await fixture(t);
  assert.equal(readOriginalDelegatedRunDispatchAuthority(f.authority), f.authority);
  for (const fake of [{ ...f.authority }, {}, { readExecutionPreparation: () => f.payload }]) {
    assert.throws(() => readOriginalDelegatedRunDispatchAuthority(fake), { code: "delegation.authority_invalid" });
  }
  for (const fake of [{ ...f.token }, f.payload]) assert.throws(() => f.authority.readExecutionPreparation(fake), { code: "delegation.authority_invalid" });
  assert.throws(() => createDelegatedRunDispatchAuthority().readExecutionPreparation(f.token), { code: "delegation.authority_invalid" });
  const read = f.authority.readExecutionPreparation(f.token);
  read.requestSnapshot.task.prompt = "Mutation must not escape the read";
  f.request.task.prompt = "Caller mutation";
  assert.equal(f.authority.readExecutionPreparation(f.token).requestSnapshot.task.prompt, "Inspect fixture files without changing them.");
});

test("preparation never persists inline credentials or headers", async t => {
  const f = await fixture(t);
  const token = f.authority.capturePreparation({ child: f.child,
    request: { ...f.request, provider: { ...f.options.provider, apiKey: "local-fixture-credential", headers: { Authorization: "Bearer fixture" } } },
    execution: f.execution, policy: f.policy, now });
  const payload = f.authority.readExecutionPreparation(token);
  assert.deepEqual(payload.requestSnapshot.provider, f.options.provider);
  assert.equal(JSON.stringify(payload).includes("local-fixture-credential"), false);
});

test("verified Pi prepared-input ACK yields one child/fence-owned start reference", async t => {
  const f = await fixture(t), options = f.withReceiver();
  assert.deepEqual(options.preparedInput, f.sdkInput);
  assert.equal(options.runId, "child");
  assert.equal(options.runnerAttemptId, f.attempt.id);
  await options.onPreparedInputAccepted(f.receipt(), new AbortController().signal);
  assert.equal(f.accepted.length, 1);
  assert.deepEqual(f.accepted[0].observation.sourceFence, fence);
  assert.equal(f.accepted[0].at, now);
  await assert.rejects(options.onPreparedInputAccepted(f.receipt(), new AbortController().signal), { code: "delegation.already_received" });
});

test("wrong SDK receipt identity cannot mint an accepted-start reference", async t => {
  const f = await fixture(t), options = f.withReceiver();
  for (const changed of [{ runId: "foreign" }, { attemptId: "old" }, { taskId: "other" },
    { preparedInputFingerprint: "a".repeat(64) }, { boundary: "model-ready" }]) {
    await assert.rejects(options.onPreparedInputAccepted(f.receipt(changed), new AbortController().signal), { code: "delegation.authority_invalid" });
  }
  assert.equal(f.accepted.length, 0);
});

test("native adapters, conflicting receivers and changed Provider endpoint are refused", async t => {
  const f = await fixture(t);
  assert.throws(() => f.withReceiver({ adapter: { runTask() {} } }), { code: "delegation.native_execution_unsupported" });
  assert.throws(() => f.withReceiver({ options: { ...f.options, onPreparedInputAccepted() {} } }), { code: "delegation.receiver_conflict" });
  assert.throws(() => f.withReceiver({ options: { ...f.options, provider: { ...f.options.provider, baseUrl: "https://other.invalid/v1" } } }), { code: "delegation.authority_invalid" });
});

test("ACK rechecks current Attempt and durable plan after receiver setup", async t => {
  const f = await fixture(t), options = f.withReceiver();
  f.unit.activeAttemptId = "new-attempt";
  await assert.rejects(options.onPreparedInputAccepted(f.receipt(), new AbortController().signal), { code: "delegation.source_attempt_stale" });
  f.unit.activeAttemptId = f.attempt.id;
  f.artifact.contentSha256 = "f".repeat(64);
  await assert.rejects(options.onPreparedInputAccepted(f.receipt(), new AbortController().signal), { code: "delegation.preparation_changed" });
  assert.equal(f.accepted.length, 0);
});

test("expired deadline and pre-aborted signal cannot acknowledge model dispatch", async t => {
  const f = await fixture(t), expired = f.withReceiver({ now: () => f.child.reservation.deadlineAt });
  await assert.rejects(expired.onPreparedInputAccepted(f.receipt(), new AbortController().signal), { code: "delegation.deadline_exceeded" });
  const controller = new AbortController(); controller.abort(new Error("stopped before receiver"));
  await assert.rejects(f.withReceiver().onPreparedInputAccepted(f.receipt(), controller.signal), /stopped before receiver/);
  assert.equal(f.accepted.length, 0);
});

test("failed start commit and abort during ACK remain single-attempt, never restart the SDK session", async t => {
  const f = await fixture(t);
  let calls = 0;
  const options = f.withReceiver({ onAccepted() { calls++; throw new Error("SQLite commit failed"); } });
  await assert.rejects(options.onPreparedInputAccepted(f.receipt(), new AbortController().signal), /SQLite commit failed/);
  await assert.rejects(options.onPreparedInputAccepted(f.receipt(), new AbortController().signal), { code: "delegation.already_received" });
  assert.equal(calls, 1);
  const controller = new AbortController();
  const aborted = f.withReceiver({ onAccepted() { controller.abort(new Error("stopped during commit")); } });
  await assert.rejects(aborted.onPreparedInputAccepted(f.receipt(), controller.signal), /stopped during commit/);
  await assert.rejects(aborted.onPreparedInputAccepted(f.receipt(), new AbortController().signal), { code: "delegation.already_received" });
});

test("resumed child retains original preparation and binds acceptance to the new Attempt", async t => {
  const f = await fixture(t);
  f.attempt.status = "cancelled"; f.attempt.endedAt = now;
  const next = { ...f.attempt, id: "child-attempt-2", attemptNumber: 2, runtimeInstanceId: "runtime-2", fencingToken: "2", status: "created", endedAt: undefined };
  f.attempts.set(next.id, next); f.unit.activeAttemptId = next.id;
  f.child.attempt = next; f.child.step.state = "resuming"; f.run.status = "running";
  const request = rebuildDelegatedRunRequest({ store: f.store, child: f.child, prepared: f.prepared });
  assert.deepEqual(request.runnerExecutionInput, f.execution);
  assert.equal(f.prepared.payload.sourceFence.attemptId, "child-attempt");
  const options = f.withReceiver();
  await options.onPreparedInputAccepted(f.receipt(), new AbortController().signal);
  assert.equal(f.accepted[0].observation.sourceFence.attemptId, next.id);
  assert.equal(f.accepted[0].observation.sourceFence.fencingToken, "2");
});

function addParentAuthority(f, child = f.child, parentAttemptId = "root-attempt") {
  const provider = { providerId: f.options.provider.provider, baseUrl: f.options.provider.baseUrl,
    api: f.options.provider.api, model: f.options.provider.model };
  const capture = { rootRunId: child.step.rootRunId, runId: child.step.parentRunId,
    sourceFence: { workUnitId: "parent-unit", attemptId: parentAttemptId, runtimeInstanceId: "root-runtime", fencingToken: "root-token" },
    runnerId: "pi", provider, currency: "USD", authority: { schemaVersion: 1, authoritySetId: "authority", sourceRevision: "revision",
      workspaceId: "workspace", participantIds: [], runnerIds: ["pi"], maxDepth: 3, sandbox: "workspace_write", mayEscalate: false,
      tools: ["read", "write"], toolDecisions: { read: "allow", write: "deny" }, workspaceRoots: [{ path: f.cwd, access: "write" }],
      providers: [provider], networkScopes: ["fixture.invalid"], secretRefs: [] } };
  const payload = { kind: "delegation.authority.v1", capture }, id = `authority:${child.step.id}`;
  f.artifacts.set(id, { id, runId: child.step.parentRunId, sealedPayload: payload, contentSha256: delegationDigest(payload) });
  child.step.permissionSnapshotArtifactId = id; child.step.parentAttemptId = parentAttemptId;
}

test("initial child request inherits only frozen input and intersected tools, never parent control bindings", async t => {
  const f = await fixture(t);
  const task = { id: "root-task", title: "Parent", prompt: "Parent frozen objective" };
  f.runs.set("root", { id: "root", cwd: f.cwd, taskId: task.id, taskSnapshot: task,
    providerName: f.options.provider.provider, providerModel: f.options.provider.model,
    requestSnapshot: { cwd: f.cwd, provider: { ...f.options.provider, apiKey: "parent-local-credential" },
      systemPrompt: "Frozen parent system", harnessFeatureSnapshot: { continuations: "enforce" },
      workflowExecutionOperation: { secretInternalOwner: "must-not-copy" }, normalConversationAcceptedSnapshotId: "parent-only" } });
  addParentAuthority(f);
  const request = rebuildDelegatedRunRequest({ store: f.store, child: f.child });
  assert.equal(request.task.prompt, f.run.taskSnapshot.prompt);
  assert.equal(request.systemPrompt, "Frozen parent system");
  assert.deepEqual(request.tools, ["read"], "undefined parent selection means SDK defaults intersected with sealed authority");
  assert.equal(request.provider.apiKey, undefined);
  assert.equal(request.workflowExecutionOperation, undefined);
  assert.equal(request.normalConversationAcceptedSnapshotId, undefined);
  assert.equal(request.parentRunId, "root");
});

test("dynamic child strips bash because process-group close cannot prove escaped-descendant containment", async t => {
  const f = await fixture(t);
  const task = { id: "root-task", title: "Parent", prompt: "Parent frozen objective" };
  f.runs.set("root", { id: "root", cwd: f.cwd, taskId: task.id, taskSnapshot: task,
    providerName: f.options.provider.provider, providerModel: f.options.provider.model,
    requestSnapshot: { cwd: f.cwd, provider: f.options.provider, tools: ["read", "bash", "write"],
      harnessFeatureSnapshot: { continuations: "enforce" } } });
  addParentAuthority(f);
  const payload = f.artifacts.get(`authority:${f.child.step.id}`).sealedPayload;
  payload.capture.authority.tools = ["read", "bash", "write"];
  payload.capture.authority.toolDecisions.bash = "allow";
  f.artifacts.get(`authority:${f.child.step.id}`).contentSha256 = delegationDigest(payload);
  const request = rebuildDelegatedRunRequest({ store: f.store, child: f.child });
  assert.deepEqual(request.tools, ["read"], "write stays denied by authority and bash stays fail-closed by containment");
});

test("sealed or newly captured delegated execution cannot reintroduce bash", async t => {
  const f = await fixture(t);
  assert.throws(() => f.authority.capturePreparation({ child: f.child,
    request: { ...f.request, tools: ["bash"] }, execution: f.execution, policy: f.policy, now }),
  { code: "delegation.command_containment_unverified" });
  f.prepared.payload.requestSnapshot.tools = ["bash"];
  f.artifact.contentSha256 = delegationPreparedExecutionDigest(f.prepared.payload);
  f.prepared.digest = f.artifact.contentSha256;
  assert.throws(() => rebuildDelegatedRunRequest({ store: f.store, child: f.child, prepared: f.prepared }),
  { code: "delegation.command_containment_unverified" });
});

test("nested child request comes from its parent's original sealed preparation, not a new chat projection", async t => {
  const f = await fixture(t), nested = structuredClone(f.child);
  nested.run = { ...nested.run, id: "grandchild", workUnitId: "grand-unit", parentRunId: "child" };
  nested.workUnit = { ...nested.workUnit, id: "grand-unit", linkedRunId: "grandchild", activeAttemptId: "grand-attempt", ownerId: "grand-step" };
  nested.attempt = { ...nested.attempt, id: "grand-attempt", workUnitId: "grand-unit" };
  nested.step = { ...nested.step, id: "grand-step", parentRunId: "child" };
  nested.reservation = { ...nested.reservation, id: "grand-reservation" };
  f.runs.set(nested.run.id, nested.run); f.attempts.set(nested.attempt.id, nested.attempt);
  f.run.requestSnapshot = { kind: "delegated_child", latestConversation: "must-not-enter-context" };
  addParentAuthority(f, nested, f.attempt.id);
  const store = { ...f.store, getWorkUnit: id => id === nested.workUnit.id ? nested.workUnit : f.store.getWorkUnit(id) };
  const request = rebuildDelegatedRunRequest({ store, child: nested, parentPrepared: f.prepared });
  assert.equal(request.task.prompt, nested.run.taskSnapshot.prompt);
  assert.equal(request.latestConversation, undefined);
  assert.equal(request.parentRunId, "child");
  assert.throws(() => rebuildDelegatedRunRequest({ store, child: nested }), /snapshot|enforced continuation/);
});

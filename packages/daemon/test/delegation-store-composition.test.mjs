import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, SqliteRunStore, resolveStoragePaths, resolveSessionRunPolicy,
  applyConversationModeToEffectiveRunPolicySnapshot } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { createOriginalDelegationStoreComposition, admitOriginalDelegationRoot, admitOriginalDelegatedChild,
  readOriginalDelegatedExecutionEntry, readOriginalDelegationLifecycle, readOriginalRunSuspensionLifecycle } from "../dist/features/harness/delegations/store-composition.js";
import { createDelegatedRunDispatchAuthority } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { bindOriginalDelegationProviderBudget } from "../dist/features/harness/delegations/provider-budget-host.js";

const NOW = "2026-10-19T08:00:00.000Z", LATER = "2026-10-19T08:00:01.000Z";
const KEY_REF = "env:DELEGATION_SYNTHETIC_KEY";
const scope = { providerId: "delegation-fixture", baseUrl: "https://delegation.invalid/v1", api: "openai-completions", model: "fixture-model" };
const price = { schemaVersion: 1, version: "fixture-price-1", currency: "USD", scope,
  inputMicrosPerMillionTokens: 1_000_000, cachedInputMicrosPerMillionTokens: 500_000, outputMicrosPerMillionTokens: 2_000_000 };

async function createCompositionFixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-composition-"));
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, harness: { delegations: { mode: options.mode ?? "enforce",
    rootBudget: options.rootBudget ?? { tokenBudget: 1000, wallTimeBudgetMs: 60_000 }, ...(options.prices ? { prices: options.prices } : {}) } } });
  const supervisor = new RuntimeSupervisor(config);
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Fixture Pi", status: "enabled", adapter: new PiRunnerAdapter() }]);
  const values = new Map([[KEY_REF, "synthetic-private-key"]]);
  const resolver = { status: ref => ({ ref, kind: "env", configured: values.has(ref) }),
    resolve: ref => ({ ref, configured: values.has(ref), value: values.get(ref), status: { ref, kind: "env", configured: values.has(ref) } }) };
  const dispatch = options.dispatch ? createDelegatedRunDispatchAuthority() : undefined;
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
    ...(dispatch ? { delegatedDispatchAuthority: dispatch } : {}) });
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  t.after(async () => { supervisor.releaseAll(); if (store.database.isOpen) store.close(); await rm(cwd, { recursive: true, force: true }); });
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, NOW);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Delegation fixture", providerId: scope.providerId,
    model: scope.model, api: scope.api, baseUrl: scope.baseUrl, apiKeyRef: KEY_REF, contextWindow: 100, maxTokens: 20,
    capabilities: ["chat"], enabled: true }, NOW);
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id, skipProviderPreflight: true }, resolver);
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Budget fixture", objective: "Read" }, NOW);
  const unit = store.createWorkUnit({ id: "unit", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run", ownerType: "run", ownerId: "root",
    status: "claimed", runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: "unit", createdByActor: "system", request: {}, now: NOW });
  const attempt = store.createWorkUnitAttempt({ id: "attempt", workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime", runnerId: "pi", effectiveRunnerId: "pi", now: NOW });
  const run = store.createRun({ id: "root", cwd, taskId: "inline", workUnitId: unit.id, threadId: thread.id,
    providerPresetId: preset.id, providerName: provider.provider, providerModel: provider.model,
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: NOW });
  store.linkRunToWorkUnit(run.id, unit.id, NOW);
  const request = { cwd, providerPresetId: preset.id, threadId: thread.id, task: { id: "inline", title: "Read", prompt: "Read" }, tools: ["read"],
    authorizationMode: "smart", workspaceAccessMode: "workspace_write" };
  const policy = () => applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart", workspaceAccessMode: "workspace_write", channelBoundPath: cwd }).snapshot, thread.conversationMode.mode);
  const admission = changes => ({ store, run: store.getRun(run.id), attempt: store.getWorkUnitAttempt(attempt.id), originalProvider: provider,
    effectivePolicySnapshot: policy(), runtimeTools: ["read"], request, now: NOW, ...changes });
  const start = () => {
    store.database.prepare("UPDATE run_sessions SET status='running',started_at=? WHERE id='root'").run(LATER);
    store.database.prepare("UPDATE work_units SET status='running',started_at=? WHERE id='unit'").run(LATER);
    store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id='attempt'").run(LATER);
  };
  const binding = changes => bindOriginalDelegationProviderBudget({ store, run: store.getRun(run.id), attempt: store.getWorkUnitAttempt(attempt.id), originalProvider: provider,
    now: () => LATER, ...changes });
  const reserve = (port, invocationId = "call") => port.reserve({ invocationId, taskId: "inline", runId: "root", attemptId: "attempt", provider: provider.provider,
    model: provider.model, api: provider.api, contextWindowTokens: 100, maxOutputTokens: 20, payloadSha256: "a".repeat(64), payload: { messages: [] } });
  const receipt = reservation => ({ invocationId: "call", reservationId: reservation.reservationId, runId: "root", attemptId: "attempt", provider: provider.provider,
    model: provider.model, api: provider.api });
  return { cwd, config, supervisor, composition, runners, store, preset, provider, request, resolver, values, admission, start, binding, reserve, receipt };
}

test("Host composition rejects lookalike Supervisor and duplicate binding", async t => {
  assert.throws(() => createOriginalDelegationStoreComposition({ supervisor: { getHarnessFeatures: () => ({ delegations: { mode: "off" } }) } }), { code: "delegation.authority_invalid" });
  const f = await createCompositionFixture(t);
  assert.throws(() => f.composition.bindExactStore(f.store), { code: "delegation.authority_invalid" });
  assert.equal("freezeRootDelegationBudget" in f.store, false);
  assert.throws(() => createOriginalDelegationStoreComposition({ supervisor: f.supervisor, runnerRegistry: f.runners,
    secretResolver: {}, delegatedDispatchAuthority: { readExecutionPreparation() {}, readRunnerStartObservation() {} } }),
  { code: "delegation.authority_invalid" });
});

test("private lifecycle carries suspension authority even with dispatch off, never on ordinary Store", async t => {
  const f = await createCompositionFixture(t, { mode: "off" }), lifecycle = readOriginalDelegationLifecycle(f.composition.lifecycle, f.store);
  for (const name of ["requestRunSuspension", "sealRunSuspension", "getRunSuspensionForAttempt", "getRunSuspension",
    "beginRunSuspensionStop", "commitRunSuspensionStopped", "getRunSuspensionStop"]) {
    assert.equal(typeof lifecycle[name], "function"); assert.equal(name in f.store, false);
  }
  assert.equal(lifecycle.getRunSuspensionForAttempt("missing"), undefined);
  assert.equal(lifecycle.getRunSuspension("missing"), undefined);
  assert.throws(() => lifecycle.requestRunSuspension({}));
  assert.throws(() => lifecycle.sealRunSuspension({}));
  assert.throws(() => readOriginalDelegationLifecycle({ ...lifecycle }, f.store), { code: "delegation.authority_invalid" });
  f.store.close();
  assert.throws(() => lifecycle.getRunSuspensionForAttempt("missing"), { code: "delegation.authority_invalid" });
});

test("ordinary/off-delegation suspension lookup retains only the exact original suspension and stopped-recovery capabilities", async t => {
  const f = await createCompositionFixture(t, { mode: "off" });
  const lifecycle = readOriginalRunSuspensionLifecycle(f.store, f.supervisor);
  assert.equal(Object.isFrozen(lifecycle), true);
  assert.deepEqual(Object.keys(lifecycle).sort(), ["beginRunSuspensionStop", "commitRunSuspensionStopped", "getRunSuspension",
    "getRunSuspensionForAttempt", "getRunSuspensionStop", "readStoppedCompactionSuspensionRecovery",
    "readStoppedFinalSettlementRecovery", "requestRunSuspension", "sealRunSuspension"].sort());
  assert.equal(lifecycle.getRunSuspensionStop("missing"), undefined);
  assert.throws(() => readOriginalRunSuspensionLifecycle({ ...f.store }, f.supervisor), { code: "delegation.authority_invalid" });
  assert.throws(() => readOriginalRunSuspensionLifecycle(f.store, { ...f.supervisor }), { code: "delegation.authority_invalid" });
  f.store.close();
  assert.throws(() => lifecycle.getRunSuspensionStop("missing"), { code: "delegation.authority_invalid" });
});

test("admission and Provider budget binding fail closed without original Store composition", async t => {
  const f = await createCompositionFixture(t);
  assert.throws(() => admitOriginalDelegationRoot(f.admission({ store: {} })), { code: "delegation.store_composition_unavailable" });
  assert.throws(() => f.binding({ store: {} }), { code: "delegation.store_composition_unavailable" });
});

test("off mode leaves ordinary root execution without a budget ledger or Provider port", async t => {
  const f = await createCompositionFixture(t, { mode: "off" });
  assert.equal(admitOriginalDelegationRoot(f.admission()), undefined);
  assert.equal(f.binding(), undefined);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM delegation_root_budgets").get().n, 0);
});

test("original live Provider freezes root once, preserving deadline across readmission", async t => {
  const f = await createCompositionFixture(t);
  const root = admitOriginalDelegationRoot(f.admission());
  assert.equal(root.tokenBudget, 1000);
  assert.equal(root.deadlineAt, "2026-10-19T08:01:00.000Z");
  const artifact = f.store.getArtifact(root.authorityArtifactId);
  assert.doesNotMatch(JSON.stringify(artifact.sealedPayload), /synthetic-private-key/);
  assert.deepEqual(artifact.sealedPayload.capture.authority.secretRefs, [KEY_REF]);
  assert.deepEqual(artifact.sealedPayload.capture.authority.tools, ["read"]);
  assert.equal(admitOriginalDelegationRoot(f.admission({ now: LATER })).deadlineAt, root.deadlineAt);
  f.start();
  assert.equal(admitOriginalDelegationRoot(f.admission({ now: LATER })).deadlineAt, root.deadlineAt);
});

test("a cloned Provider cannot borrow original D1 authority", async t => {
  const f = await createCompositionFixture(t);
  assert.throws(() => admitOriginalDelegationRoot(f.admission({ originalProvider: { ...f.provider } })), { code: "delegation.provider_authority_unavailable" });
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM delegation_root_budgets").get().n, 0);
});

test("unknown price only rejects monetary root admission; token/time admission still works", async t => {
  const money = await createCompositionFixture(t, { rootBudget: { costBudgetMicros: 1000 } });
  assert.throws(() => admitOriginalDelegationRoot(money.admission()), { code: "delegation.price_unknown" });
  const tokens = await createCompositionFixture(t);
  assert.equal(admitOriginalDelegationRoot(tokens.admission()).tokenBudget, 1000);
});

test("current provider key, policy, runner revocation and owner retirement deny further durable reservation", async t => {
  for (const kind of ["provider", "policy", "runner", "retired"]) {
    const f = await createCompositionFixture(t);
    admitOriginalDelegationRoot(f.admission()); f.start(); const port = f.binding();
    if (kind === "provider") f.values.set(KEY_REF, "changed-synthetic-key");
    if (kind === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, LATER);
    if (kind === "runner") patchWorkspaceRuntimeSettings(f.store, f.runners, { allowedRunnerIds: [] }, LATER);
    if (kind === "retired") f.store.close();
    assert.throws(() => f.reserve(port));
    if (kind !== "retired") assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM delegation_budget_charges").get().n, 0);
  }
});

test("Provider port reserves full resolved context, measures real usage and latches unknown debt", async t => {
  const f = await createCompositionFixture(t, { rootBudget: { tokenBudget: 1000, costBudgetMicros: 1000 }, prices: [price] });
  admitOriginalDelegationRoot(f.admission()); f.start(); const port = f.binding();
  const reservation = f.reserve(port);
  assert.equal(reservation.reservedTokens, 120); assert.equal(reservation.reservedCostMicros, 140);
  port.settle({ ...f.receipt(reservation), outcome: "succeeded", usage: { input: 10, cacheRead: 5, cacheWrite: 0, output: 4, totalTokens: 19 } });
  const row = f.store.database.prepare("SELECT * FROM delegation_budget_charges WHERE id=?").get(reservation.reservationId);
  assert.equal(row.state, "measured"); assert.equal(row.input_tokens, 15); assert.equal(row.actual_cost_micros, 21);
  const unknown = f.reserve(port, "unknown");
  port.settleUnknown({ ...f.receipt(unknown), invocationId: "unknown", outcome: "cancelled" });
  assert.equal(f.store.database.prepare("SELECT state FROM delegation_budget_charges WHERE id=?").get(unknown.reservationId).state, "unresolved");
  assert.throws(() => f.reserve(port, "after"), { code: "delegation.usage_unknown" });
});

test("private lifecycle and single-use execution entry reject shape copies and wrong owners", async t => {
  const f = await createCompositionFixture(t, { dispatch: true });
  assert.equal(readOriginalDelegationLifecycle(f.composition.lifecycle, f.store), f.composition.lifecycle);
  assert.throws(() => readOriginalDelegationLifecycle({ ...f.composition.lifecycle }, f.store), { code: "delegation.authority_invalid" });
  assert.throws(() => readOriginalDelegationLifecycle(f.composition.lifecycle, {}), { code: "delegation.authority_invalid" });
  admitOriginalDelegationRoot(f.admission()); f.start();
  const prepared = f.composition.lifecycle.spawn({ parentRunId: "root", sourceFence: {
    workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: f.store.getWorkUnitAttempt("attempt").fencingToken },
    spawnCallId: "spawn", objective: "Read child", requestedBudget: { tokenBudget: 300 }, required: true, now: LATER });
  const claimed = f.composition.lifecycle.claim({ reservationId: prepared.reservation.id,
    expectedStepRevision: 0, runtimeInstanceId: "runtime", now: LATER });
  const entry = f.composition.lifecycle.createExecutionEntry(claimed);
  assert.equal(f.composition.lifecycle.createExecutionEntry(claimed), entry);
  assert.throws(() => readOriginalDelegatedExecutionEntry({ ...entry }, f.store), { code: "delegation.authority_invalid" });
  assert.throws(() => readOriginalDelegatedExecutionEntry(entry, {}), { code: "delegation.authority_invalid" });
  const execution = readOriginalDelegatedExecutionEntry(entry, f.store);
  assert.equal(execution.claimed.run.id, claimed.run.id);
  assert.equal(typeof execution.assertCurrent, "function"); assert.equal(typeof execution.buildRequest, "function");
  assert.equal(typeof execution.assertSuspensionCleanupCurrent, "function");
  assert.throws(() => execution.assertSuspensionCleanupCurrent(), { code: "delegation.source_attempt_stale" },
    "ordinary execution custody alone cannot authorize graceful cleanup without the exact private stop chain");
  assert.equal(Object.isFrozen(execution.claimed.run), true);
  assert.throws(() => readOriginalDelegatedExecutionEntry(entry, f.store), { code: "delegation.recovery_required" });
  assert.equal("writer" in execution, false);
});

test("child Provider must have its own original preflight and charges the same root ledger", async t => {
  const f = await createCompositionFixture(t, { dispatch: true });
  admitOriginalDelegationRoot(f.admission()); f.start();
  const prepared = f.composition.lifecycle.spawn({ parentRunId: "root", sourceFence: {
    workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: f.store.getWorkUnitAttempt("attempt").fencingToken },
    spawnCallId: "spawn", objective: "Read child", requestedBudget: { tokenBudget: 300 }, required: true, now: LATER });
  const claimed = f.composition.lifecycle.claim({ reservationId: prepared.reservation.id,
    expectedStepRevision: 0, runtimeInstanceId: "runtime", now: LATER });
  assert.throws(() => bindOriginalDelegationProviderBudget({ store: f.store, run: claimed.run,
    attempt: claimed.attempt, originalProvider: f.provider }), { code: "delegation.run_admission_missing" });
  const provider = resolveProviderForRun(f.store, { providerPresetId: f.preset.id, skipProviderPreflight: true }, f.resolver);
  assert.notEqual(provider, f.provider);
  const request = { ...f.request, task: claimed.run.taskSnapshot, parentRunId: "root" };
  const input = { store: f.store, claimed, originalProvider: provider, request,
    effectivePolicySnapshot: f.admission().effectivePolicySnapshot, runtimeTools: ["read"], now: LATER };
  f.store.appendRuntimeEvent({ workUnitId: claimed.workUnit.id, attemptId: claimed.attempt.id,
    runtimeInstanceId: claimed.attempt.runtimeInstanceId, fencingToken: claimed.attempt.fencingToken,
    type: "work_unit_progress", actor: "system", ts: "2026-10-19T08:00:01.500Z", data: { phase: "preparing" } });
  assert.notEqual(f.store.getWorkUnit(claimed.workUnit.id).lastEventAt, claimed.workUnit.lastEventAt);
  assert.throws(() => admitOriginalDelegatedChild({ ...input, originalProvider: { ...provider } }), { code: "delegation.provider_authority_unavailable" });
  assert.throws(() => admitOriginalDelegatedChild({ ...input, hasAdditionalToolSurfaces: true }), { code: "delegation.dynamic_tool_surface_unverified" });
  assert.throws(() => admitOriginalDelegatedChild({ ...input, runtimeTools: ["bash"] }), { code: "delegation.command_containment_unverified" });
  const admitted = admitOriginalDelegatedChild(input);
  assert.equal(admitted.root.rootRunId, "root"); assert.equal(admitted.reservation.tokenReserved, 300);
  assert.throws(() => bindOriginalDelegationProviderBudget({ store: f.store, run: claimed.run,
    attempt: claimed.attempt, originalProvider: f.provider }), { code: "delegation.provider_authority_unavailable" });
  // Isolated ledger fixture only: production starts exclusively through the Pi
  // session ACK. This test does not claim adapter/session acceptance coverage.
  f.store.database.prepare("UPDATE run_sessions SET status='running',started_at=? WHERE id=?").run(LATER, claimed.run.id);
  f.store.database.prepare("UPDATE work_units SET status='running',started_at=? WHERE id=?").run(LATER, claimed.workUnit.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(LATER, claimed.attempt.id);
  f.store.database.prepare("UPDATE delegation_steps SET state='running',child_run_id=?,revision=revision+1,updated_at=? WHERE id=?")
    .run(claimed.run.id, LATER, claimed.step.id);
  const port = bindOriginalDelegationProviderBudget({ store: f.store, run: f.store.getRun(claimed.run.id),
    attempt: f.store.getWorkUnitAttempt(claimed.attempt.id), originalProvider: provider, now: () => LATER });
  const reserved = port.reserve({ invocationId: "child-call", taskId: "inline", runId: claimed.run.id, attemptId: claimed.attempt.id,
    provider: provider.provider, model: provider.model, api: provider.api, contextWindowTokens: 100, maxOutputTokens: 20,
    payloadSha256: "b".repeat(64), payload: { messages: [] } });
  const row = f.store.database.prepare("SELECT root_run_id,reservation_id,run_id FROM delegation_budget_charges WHERE id=?").get(reserved.reservationId);
  assert.equal(row.root_run_id, "root"); assert.equal(row.reservation_id, claimed.reservation.id); assert.equal(row.run_id, claimed.run.id);
  port.settle({ invocationId: "child-call", reservationId: reserved.reservationId, runId: claimed.run.id, attemptId: claimed.attempt.id,
    provider: provider.provider, model: provider.model, api: provider.api, outcome: "succeeded",
    usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 4, totalTokens: 14 } });
  assert.equal(f.store.database.prepare("SELECT state FROM delegation_budget_charges WHERE id=?").get(reserved.reservationId).state, "measured");
});

test("claim admission permits activity clocks but rejects changed custody, requests and budget", async t => {
  const f = await createCompositionFixture(t, { dispatch: true });
  admitOriginalDelegationRoot(f.admission()); f.start();
  const prepared = f.composition.lifecycle.spawn({ parentRunId: "root", sourceFence: {
    workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: f.store.getWorkUnitAttempt("attempt").fencingToken },
    spawnCallId: "claim-identity", objective: "Read child", requestedBudget: { tokenBudget: 300 }, required: true, now: LATER });
  const claimed = f.composition.lifecycle.claim({ reservationId: prepared.reservation.id,
    expectedStepRevision: 0, runtimeInstanceId: "runtime", now: LATER });
  const activityAt = "2026-10-19T08:00:01.500Z";
  let unexpectedReads = 0;
  const withGetter = { ...claimed };
  Object.defineProperty(withGetter, "run", { enumerable: true, get() { unexpectedReads++; throw new Error("must not read"); } });
  const withProxy = { ...claimed, run: new Proxy(claimed.run, {
    ownKeys() { unexpectedReads++; throw new Error("must not enumerate"); },
  }) };
  for (const invalid of [withGetter, withProxy]) {
    assert.throws(() => f.composition.lifecycle.createExecutionEntry(invalid), { code: "delegation.invalid_input" });
  }
  assert.equal(unexpectedReads, 0);
  f.store.appendRuntimeEvent({ workUnitId: claimed.workUnit.id, attemptId: claimed.attempt.id,
    runtimeInstanceId: claimed.attempt.runtimeInstanceId, fencingToken: claimed.attempt.fencingToken,
    type: "work_unit_progress", actor: "system", ts: activityAt, data: { phase: "preparing" } });
  f.store.database.prepare("UPDATE run_sessions SET updated_at=? WHERE id=?").run(activityAt, claimed.run.id);
  f.store.database.prepare("UPDATE work_units SET last_heartbeat_at=? WHERE id=?").run(activityAt, claimed.workUnit.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET last_heartbeat_at=? WHERE id=?").run(activityAt, claimed.attempt.id);
  for (const mutate of [
    child => { child.step.revision++; },
    child => { child.reservation.tokenReserved++; },
    child => { child.reservation.revision++; },
    child => { child.run.providerModel = "other-model"; },
    child => { child.run.taskSnapshot = { prompt: "injected" }; },
    child => { child.run.requestSnapshot = { prompt: "injected" }; },
    child => { child.workUnit.activeAttemptId = "other-attempt"; },
    child => { child.workUnit.request = { permissionMode: "full_access" }; },
    child => { child.attempt.fencingToken = "other-fence"; },
    child => { child.attempt.abortRequestedAt = activityAt; },
    child => { child.run.endedAt = activityAt; },
  ]) {
    const changed = structuredClone(claimed); mutate(changed);
    assert.throws(() => f.composition.lifecycle.createExecutionEntry(changed), { code: "delegation.source_attempt_stale" });
  }
  const entry = f.composition.lifecycle.createExecutionEntry(claimed);
  const execution = readOriginalDelegatedExecutionEntry(entry, f.store);
  assert.equal(execution.claimed.attempt.id, claimed.attempt.id);
  assert.equal(execution.claimed.run.updatedAt, activityAt);
});

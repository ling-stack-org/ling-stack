import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { applyConversationModeToEffectiveRunPolicySnapshot, createSqliteRunStore, DEFAULT_WORKSPACE_ID,
  resolveSessionRunPolicy, resolveStoragePaths, toRuntimeAttemptFence } from "../../dist/index.js";
import type { AcquireRuntimeSemaphoreSlotInput, ClaimNextRuntimeRunInput, CreateResourceLeaseInput,
  DispatchRuntimeQueuedRunInput, EnqueueRuntimeRunInput, RuntimeConcurrencyLimits, RuntimeRunQueueClaim,
  RuntimeRunQueueStore } from "../../dist/index.js";
import { admissionRace } from "./workflow-step-admission-fixture.mjs";
import { testDatabase } from "./sqlite-test-database.ts";

type Store = ReturnType<typeof createSqliteRunStore>;
type Channel = ReturnType<Store["createChannel"]>;
type Preset = ReturnType<Store["createProviderPreset"]>;
type Thread = ReturnType<Store["createLingThread"]>;
type PrepareOptions = {
  kind?: "task_run" | "conversation_run";
  channel?: Channel;
  tools?: string[];
  preset?: Preset;
  thread?: Thread;
  teammateId?: string;
  sourceRuntimeId?: string;
  requestOverrides?: Record<string, unknown>;
  runOverrides?: Partial<Parameters<Store["createRun"]>[0]>;
};

const executionTables = ["tasks", "run_sessions", "run_events", "work_units", "work_unit_attempts", "runtime_events",
  "runtime_heartbeats", "resource_leases", "runtime_semaphore_slots", "state_transition_events", "runner_continuations"];
const limits = { maxConcurrentRuns: 64, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4,
  maxRunsPerProvider: 64, maxRunsPerRunner: 64 };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Real first-Attempt SQLite authority; no Provider, Runner or daemon is started. */
export async function runtimeRunQueueFixture(t: TestContext,
  { policyLimits = {}, clockStart = Date.now() }: { policyLimits?: Partial<RuntimeConcurrencyLimits>; clockStart?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-runtime-run-queue-")));
  const cwd = join(root, "workspace"), opened = new Set<Store>(), epoch = clockStart, providers = new Map<string, Preset>();
  await mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  t.after(async () => {
    try { for (const store of opened) if (testDatabase(store).isOpen) store.close(); }
    finally {
      assert.ok(root.startsWith(`${await realpath(tmpdir())}/ling-runtime-run-queue-`));
      await rm(root, { recursive: true, force: true });
    }
  });
  const at = (seconds: number) => new Date(epoch + seconds * 1_000).toISOString();
  const open = () => {
    const store = createSqliteRunStore(cwd, paths);
    opened.add(store);
    assert.equal(typeof store.enqueueRuntimeRun, "function", "queue tests require the current Core queue API");
    assert.equal(testDatabase(store).prepare("SELECT name FROM schema_migrations WHERE version=217").get()?.name, "runtime_run_queue");
    return store;
  };
  const connections = { store: open(), peer: open() }, workspaceId = DEFAULT_WORKSPACE_ID;
  const channelFor = (name: string, runtimePolicy: Partial<Channel["runtimePolicy"]> = {}) => connections.store.createChannel({ name: `Queue ${name}`, boundPath: cwd,
    allowedTools: ["read", "write", "edit", "bash"], runtimePolicy: { maxConcurrentRuns: 64,
      queueOnConflict: true, writeLockScope: "boundPath", ...runtimePolicy } }, at(0));
  let channel = channelFor("default");
  const installPolicy = (overrides: Partial<RuntimeConcurrencyLimits> = {},
    { store = connections.store, runtimeInstanceId, enabled = true, now }:
      { store?: Store; runtimeInstanceId?: string; enabled?: boolean; now?: string } = {}) => {
    const previous = store.getRuntimeConcurrencyPolicy(workspaceId);
    const expectedRevision = previous?.revision ?? 0;
    const result = store.installRuntimeConcurrencyPolicy({ workspaceId,
      runtimeInstanceId: runtimeInstanceId ?? `queue-executor-${expectedRevision + 1}`, expectedRevision, enabled,
      limits: { ...limits, ...overrides }, installedAt: now ?? at(expectedRevision + 1) });
    assert.equal(result.status, "installed", JSON.stringify(result));
    assert.deepEqual(connections.peer.getRuntimeConcurrencyPolicy(workspaceId), result.policy);
    return result.policy;
  };
  installPolicy(policyLimits);
  const providerFor = (name: string): Preset => {
    if (!providers.has(name)) providers.set(name, connections.store.createProviderPreset({ kind: "openai-compatible",
      displayName: `Queue ${name}`, providerId: `queue-${name}`, model: "queue-model", api: "openai-completions",
      baseUrl: "https://queue.fixture.invalid/v1", capabilities: ["chat", "tool_call"], enabled: true }, at(0)));
    const preset = providers.get(name);
    assert.ok(preset);
    return preset;
  };
  const presetDefault = providerFor("shared");
  const prepare = (name: string, { kind = "task_run", channel: selectedChannel = channel, tools = ["read"], preset = presetDefault,
    thread, teammateId, sourceRuntimeId = `queue-source-${name}`, requestOverrides = {}, runOverrides = {} }: PrepareOptions = {}) => {
    const channel = selectedChannel, store = connections.store;
    const task = store.createTask({ channelId: channel.id, title: `Inspect ${name}`,
      prompt: `Inspect ${name}.txt` }, at(2));
    if (kind === "conversation_run" && !thread) thread = store.createLingThread({ kind: "conversation",
      title: task.title, objective: task.prompt }, at(2));
    const taskInput = { id: task.id, title: task.title, prompt: task.prompt, ...(channel ? { channelId: channel.id } : {}) };
    const provider = { provider: preset.providerId, model: preset.model, api: preset.api, baseUrl: preset.baseUrl };
    const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
      workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always", workspaceAccessMode: "full_access",
      channelBoundPath: channel?.boundPath ?? cwd }).snapshot, "default");
    const prepared = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id, systemPrompt: "Inspect the local fixture.",
      userPrompt: [`Channel: ${channel.id}`, "", `Task: ${task.title}`, "", task.prompt].join("\n"), model: { id: provider.model, provider: provider.provider, api: provider.api,
        baseUrl: provider.baseUrl, reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192 },
      tools: tools.map(tool => ({ name: tool, description: `Fixture ${tool}`, parameters: { type: "object" } })), thinkingLevel: "off" };
    const execution = { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
      input: { cwd, task: taskInput, provider, tools: [...tools], systemPrompt: prepared.systemPrompt },
      preparedInput: { ...prepared, fingerprint: hash(prepared) } };
    const request = { cwd, workspaceCwd: cwd, executionCwd: cwd, task: taskInput, tools: [...tools], runnerId: "pi",
      providerPresetId: preset.id, provider, authorizationMode: "always", workspaceAccessMode: "full_access",
      permissionMode: policy.mode, effectivePolicySnapshot: policy, runnerExecutionInput: execution,
      ...(teammateId ? { teammateId } : {}),
      ...(thread ? { threadId: thread.id } : {}), ...requestOverrides };
    const unit = store.createWorkUnit({ id: `queue-unit-${name}`, workspaceId, kind,
      ownerType: kind === "conversation_run" ? "conversation" : "task", ownerId: thread?.id ?? task.id,
      taskId: task.id, channelId: channel?.id, teammateId, runnerId: "pi", effectiveRunnerId: "pi", providerPresetId: preset.id,
      idempotencyKey: `queue-unit-${name}`, createdByActor: "system", request, now: at(2) });
    const attempt = store.createWorkUnitAttempt({ id: `queue-attempt-${name}`, workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: sourceRuntimeId, runnerId: "pi", effectiveRunnerId: "pi", providerPresetId: preset.id, now: at(2) });
    const run = store.createRun({ id: `queue-run-${name}`, cwd, taskId: task.id, channelId: channel?.id,
      threadId: thread?.id, teammateId, workUnitId: unit.id, providerPresetId: preset.id, providerName: provider.provider,
      providerModel: provider.model, taskSnapshot: taskInput, providerSnapshot: { providerPresetId: preset.id, ...provider },
      requestSnapshot: request, createdAt: at(2), ...runOverrides });
    store.linkRunToWorkUnit(run.id, unit.id, at(2));
    const storedRun = store.getRun(run.id), storedUnit = store.getWorkUnit(unit.id);
    assert.ok(storedRun && storedUnit);
    const current = { run: { ...storedRun, requestSnapshot: storedRun.requestSnapshot as typeof request },
      unit: { ...storedUnit, request: storedUnit.request as typeof request }, task, attempt,
      fence: toRuntimeAttemptFence(attempt), channel, thread, execution, policy };
    assert.equal(current.unit.attemptCount, 1);
    assert.equal(current.attempt.status, "created");
    assert.deepEqual(current.run.requestSnapshot.runnerExecutionInput, current.unit.request.runnerExecutionInput);
    assert.deepEqual(current.run.requestSnapshot.effectivePolicySnapshot, current.unit.request.effectivePolicySnapshot);
    assert.ok(Array.isArray(current.run.requestSnapshot.runnerExecutionInput.input.tools));
    return current;
  };
  type Prepared = ReturnType<typeof prepare>;
  const enqueueInput = (current: Prepared, overrides: Partial<EnqueueRuntimeRunInput> = {}): EnqueueRuntimeRunInput => ({ runId: current.run.id, sourceFence: current.fence,
    reason: "runtime_semaphore_conflict", now: at(3), ...overrides });
  const enqueue = (current: Prepared, overrides: Partial<EnqueueRuntimeRunInput> = {}, store = connections.store) => {
    const result = store.enqueueRuntimeRun(enqueueInput(current, overrides));
    assert.equal(result.status, "enqueued", JSON.stringify(result));
    return result.entry;
  };
  const claimInput = (overrides: Partial<ClaimNextRuntimeRunInput> = {}): ClaimNextRuntimeRunInput => {
    const policy = connections.peer.getRuntimeConcurrencyPolicy(workspaceId);
    assert.ok(policy);
    return { workspaceId, runtimeInstanceId: policy.runtimeInstanceId,
      ownerId: "queue-worker-a", leaseMs: 60_000, now: at(4), ...overrides };
  };
  const claim = (overrides: Partial<ClaimNextRuntimeRunInput> = {}, store = connections.store) => {
    const result = store.claimNextRuntimeRun(claimInput(overrides));
    assert.equal(result.status, "claimed", JSON.stringify(result));
    return result.claim;
  };
  const resources = (current: Prepared, now = at(5)) => {
    const run = connections.peer.getRun(current.run.id);
    assert.ok(run);
    const channel = run.channelId ? connections.peer.getChannel(run.channelId) : undefined;
    const request = run.requestSnapshot as Prepared["run"]["requestSnapshot"];
    const expiresAt = new Date(Date.parse(now) + 6 * 60 * 60 * 1_000).toISOString();
    const base = { workspaceId, ...current.fence, acquiredAt: now, expiresAt };
    const leases: CreateResourceLeaseInput[] = [{ ...base, ownerType: "run", ownerId: run.id, resourceType: "task", resourceKey: run.taskId }];
    if (request.runnerExecutionInput.input.tools.some(tool => ["write", "edit", "bash"].includes(tool))) {
      const scope = channel?.runtimePolicy.writeLockScope ?? "boundPath";
      const resourceType = scope === "workspace" || scope === "channel" && !channel ? "workspace"
        : scope === "channel" ? "channel" : "bound_path";
      const resourceKey = resourceType === "workspace" ? workspaceId : resourceType === "channel" ? channel!.id : run.cwd;
      leases.push({ ...base, ownerType: "run", ownerId: run.id, resourceType, resourceKey });
    }
    const entries: Pick<AcquireRuntimeSemaphoreSlotInput, "resourceType" | "resourceKey" | "limit">[] = [
      { resourceType: "provider", resourceKey: run.providerPresetId ?? `${run.providerName}:${run.providerModel}`, limit: 4 },
      { resourceType: "runner", resourceKey: current.attempt.effectiveRunnerId, limit: 4 },
      ...(channel ? [{ resourceType: "channel_parallel", resourceKey: channel.id,
        limit: Math.max(channel.runtimePolicy.maxConcurrentRuns, 1) } as const] : [])];
    const semaphores: AcquireRuntimeSemaphoreSlotInput[] = entries.map(entry =>
      ({ ...base, ...entry, ownerType: "work_unit_attempt", ownerId: current.attempt.id }));
    return { leases, semaphores };
  };
  const dispatchInput = (current: Prepared, claim: RuntimeRunQueueClaim, overrides: Partial<DispatchRuntimeQueuedRunInput> = {}): DispatchRuntimeQueuedRunInput => {
    const now = overrides.now ?? at(5);
    return { claim, ...resources(current, now), now, ...overrides };
  };
  const dispatch = (current: Prepared, claim: RuntimeRunQueueClaim, overrides: Partial<DispatchRuntimeQueuedRunInput> = {}, store = connections.store) =>
    store.dispatchRuntimeQueuedRun(dispatchInput(current, claim, overrides));
  const rows = (table: string, store = connections.peer) => testDatabase(store).prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const executionSnapshot = () => Object.fromEntries(executionTables.map(table => [table, rows(table)]));
  const snapshot = () => ({ ...executionSnapshot(), runtime_run_queue: rows("runtime_run_queue"),
    runtime_concurrency_policies: rows("runtime_concurrency_policies") });
  const noWrites = <T>(action: () => T): T => {
    const before = snapshot();
    try { return action(); }
    finally {
      assert.deepEqual(snapshot(), before);
      for (const store of [connections.store, connections.peer]) if (typeof testDatabase(store).isTransaction === "boolean") assert.equal(testDatabase(store).isTransaction, false);
    }
  };
  const noAdmission = (current: Prepared) => {
    for (const table of ["resource_leases", "runtime_semaphore_slots"]) assert.equal(testDatabase(connections.peer)
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE attempt_id=?`).get(current.attempt.id)?.n, 0,
    "a failed dispatch must not leave even released half-group history");
    assert.equal(connections.peer.getTask(current.task.id)?.status, "todo");
    assert.equal(connections.peer.getWorkUnit(current.unit.id)?.status, "queued");
    assert.equal(connections.peer.getWorkUnitAttempt(current.attempt.id)?.status, "created");
    assert.equal(connections.peer.getRuntimeRunQueueEntry(current.run.id)?.dispatchedAt, undefined);
  };
  const release = (current: Prepared, now = at(6)) => ({
    leases: connections.store.releaseResourceLeasesForAttempt(current.fence, now, "fixture execution stopped"),
    semaphores: connections.store.releaseRuntimeSemaphoreSlotsForAttempt(current.fence, now, "fixture execution stopped"),
  });
  const reopen = (which: "store" | "peer" = "store") => {
    if (testDatabase(connections[which]).isOpen) connections[which].close();
    opened.delete(connections[which]);
    return connections[which] = open();
  };
  const race = <M extends "enqueueRuntimeRun" | "claimNextRuntimeRun" | "dispatchRuntimeQueuedRun">(
    operations: { method: M; input: Parameters<RuntimeRunQueueStore[M]>[0] }[]):
    Promise<ReturnType<RuntimeRunQueueStore[M]>[]> => admissionRace<M>(t, { cwd, paths }, operations);
  return { root, cwd, paths, at, workspaceId, get store() { return connections.store; }, get peer() { return connections.peer; },
    get channel() { return channel; }, set channel(value: Channel) { channel = value; }, preset: presetDefault,
    channelFor, installPolicy, provider: providerFor, prepare, enqueueInput, enqueue, claimInput, claim, resources,
    dispatchInput, dispatch, rows, executionSnapshot, snapshot, noWrites, noAdmission, release, reopen, race };
}

export type RuntimeRunQueueFixture = Awaited<ReturnType<typeof runtimeRunQueueFixture>>;
export type PreparedQueueRun = ReturnType<RuntimeRunQueueFixture["prepare"]>;

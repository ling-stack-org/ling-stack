import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiRunnerRunOptions } from "../../runner-pi/dist/index.js";
import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { reconcileAutomationRunForTerminal } from "../dist/features/automations/run.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(label);
}

class BlockingAutomationRunner extends ToolFreePiRunner {
  readonly runIds: string[] = [];
  readonly firstEntered = deferred<void>();
  readonly releaseFirst = deferred<void>();

  override async runTask(options: PiRunnerRunOptions) {
    this.runIds.push(options.runId ?? "");
    const ordinal = this.runIds.length;
    if (ordinal === 1) this.firstEntered.resolve();
    if (ordinal === 1) await this.releaseFirst.promise;
    return super.runTask(options, () => `automation-capacity-reply-${ordinal}`);
  }
}

test("automation waits in the durable queue when Host capacity is full and resumes after release", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-automation-host-capacity-"));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const environmentKeys = ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"] as const;
  const environment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  process.env.LING_STACK_HOME = home;
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;

  let store: RunStore | undefined;
  const runner = new BlockingAutomationRunner();
  const emptySecrets = {
    status: (ref: string) => ({ ref, kind: "env" as const, configured: false }),
    resolve: (ref: string) => ({ ref, configured: false }),
  };
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    concurrency: {
      enabled: true,
      maxConcurrentRuns: 1,
      maxReadOnlyRuns: 1,
      maxWorkspaceWriteRuns: 1,
      maxRunsPerProvider: 1,
      maxRunsPerRunner: 1,
    },
    channels: { autoRoute: false, intentSelector: false, terminalReports: false },
  }, {
    runner,
    secretResolver: emptySecrets,
    onStoreInitialized: (initializedCwd, initializedStore) => {
      if (initializedCwd === cwd) store = initializedStore;
    },
  });
  t.after(async () => {
    runner.releaseFirst.resolve();
    await daemon.stop();
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await daemon.start();
  assert.ok(store);
  const ownedStore = store;
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const url = (path: string) => `${base}${path}?cwd=${encodeURIComponent(cwd)}`;
  const api = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as Record<string, any>;
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };

  const now = new Date().toISOString();
  const provider = ownedStore.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Automation Host capacity fixture",
    providerId: "automation-host-capacity-fixture",
    model: "automation-capacity-model",
    api: "openai-completions",
    baseUrl: "https://automation-host-capacity.fixture.invalid/v1",
    authHeader: false,
    enabled: true,
    capabilities: ["chat"],
    input: ["text"],
  }, now);
  ownedStore.recordProviderCheckResult(provider.id, {
    ok: true,
    code: "ready",
    message: "Controlled Pi SDK transport",
    checkedAt: now,
  });

  const createAutomation = async (title: string) => {
    const result = await api("/automations", {
      kind: "custom_prompt",
      title,
      target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd },
      trigger: { type: "manual" },
      promptTemplate: {
        templateVersion: 1,
        promptMarkdown: `${title} prompt`,
        maxContextItems: 1,
        contextSelectors: [{ kind: "recent_runs", limit: 1 }],
      },
      executionPolicy: {
        providerPresetId: provider.id,
        allowedTools: ["read"],
        approvalProfile: { mode: "none" },
      },
    });
    return result.automation as { id: string };
  };
  const firstAutomation = await createAutomation("Host holder automation");
  const secondAutomation = await createAutomation("Queued automation");

  const firstResponsePromise = api(`/automations/${firstAutomation.id}/run`, { idempotencyKey: "host-holder-run" });
  await runner.firstEntered.promise;
  const firstResponse = await firstResponsePromise;
  assert.equal(firstResponse.automationRun.status, "running");
  const firstRun = ownedStore.getRun(firstResponse.automationRun.runId);
  assert.ok(firstRun);
  assert.ok(firstRun.workUnitId);
  assert.equal(ownedStore.getWorkUnit(firstRun.workUnitId)?.createdByActor, "scheduler");

  const secondResponse = await api(`/automations/${secondAutomation.id}/run`, { idempotencyKey: "host-queued-run" });
  assert.equal(secondResponse.automationRun.status, "queued");
  assert.equal(secondResponse.run.status, "queued");
  assert.equal(runner.runIds.length, 1, "Host capacity must prevent the second automation from reaching the runner");
  const secondRun = ownedStore.getRun(secondResponse.automationRun.runId);
  assert.ok(secondRun);
  assert.ok(secondRun.workUnitId);
  assert.equal(ownedStore.getRuntimeRunQueueEntry(secondRun.id)?.dispatchedAt, undefined);
  assert.equal(ownedStore.getWorkUnit(secondRun.workUnitId)?.createdByActor, "scheduler");

  runner.releaseFirst.resolve();
  await until(() => runner.runIds.length === 2, "the queued automation was not dispatched after Host release");
  await until(() => ownedStore.getRun(secondRun.id)?.status === "succeeded"
    && ownedStore.getAutomationRun(secondResponse.automationRun.id)?.status === "succeeded",
  "the queued automation did not reach terminal success");

  const completedAutomation = ownedStore.getAutomationRun(secondResponse.automationRun.id);
  assert.equal(completedAutomation?.startedAt !== undefined, true);
  assert.equal(completedAutomation?.completedAt, ownedStore.getRun(secondRun.id)?.endedAt);
  assert.ok(ownedStore.getRuntimeRunQueueEntry(secondRun.id)?.dispatchedAt);
  assert.equal(ownedStore.listArtifacts(secondRun.id).length, 1, "queued ready callbacks must not duplicate the context artifact");
  assert.deepEqual(new Set(runner.runIds), new Set([firstResponse.automationRun.runId, secondResponse.automationRun.runId]));
  assert.deepEqual(ownedStore.listRuntimeSemaphoreSlots({ status: "active", limit: 100 }), []);

  const terminalRun = ownedStore.getRun(secondRun.id);
  assert.ok(terminalRun);
  ownedStore.updateAutomationRun(secondResponse.automationRun.id, { status: "queued", completedAt: null }, new Date().toISOString());
  reconcileAutomationRunForTerminal(ownedStore, terminalRun, "2026-11-10T00:00:00.000Z");
  const recoveredAutomation = ownedStore.getAutomationRun(secondResponse.automationRun.id);
  assert.equal(recoveredAutomation?.status, "succeeded");
  assert.equal(recoveredAutomation?.completedAt, terminalRun.endedAt);
});

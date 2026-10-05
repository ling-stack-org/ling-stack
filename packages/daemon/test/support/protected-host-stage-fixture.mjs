import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compileExecutionSandboxPolicy, createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveSessionRunPolicy,
  toRuntimeAttemptFence } from "@ling-stack/core";
import { resolveConfig } from "../../dist/config.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { macosSandboxCommandFingerprint, prepareMacosSandboxCommand, readMacosSandboxBackendIdentity } from "../../dist/runtime/sandbox/macos-native-command.js";
import { MACOS_SYSTEM_READ_ROOTS } from "../../dist/runtime/sandbox/macos-seatbelt-profile.js";

export const commandFor = code => "node -e '" + code.replace(/'/gu, "'\\''") + "'";
export async function waitActor(child) {
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(status.code, 0, stderr); assert.equal(status.signal, null);
  return stdout;
}
export function createProtectedHostStageFixture(t) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-protected-host-stage-")), cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  const stagePath = join(root, "stage"); mkdirSync(stagePath, { mode: 0o700 });
  const store = createSqliteRunStore(cwd), arenas = [], stages = new Set();
  const pin = path => ({ path: realpathSync(path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  const config = { inputHelper: { ...pin("/usr/bin/true"), version: "stage-test-v1" }, executables: { node: pin(process.execPath) } };
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd, sandbox: { restrictedCommands: config } }));
  const registry = supervisor.getProtectedHostStageRegistry(), runtime = supervisor.getRestrictedCommandRuntime();
  let runCount = 0;
  function createRun() {
    const now = new Date().toISOString(), id = "stage-run-" + ++runCount;
    const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
      idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now });
    const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "stage-test-runtime",
      runnerId: "pi", status: "started", now });
    const policy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always",
      workspaceAccessMode: "workspace_write" }).snapshot;
    store.createRun({ id, cwd, workUnitId: unit.id, taskId: "stage-task", providerName: "stage-test", providerModel: "stage-test",
      taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: { effectivePolicySnapshot: policy }, createdAt: now });
    store.linkRunToWorkUnit(id, unit.id, now); store.markRunStarted(id, now);
    return { run: store.getRun(id), sourceFence: toRuntimeAttemptFence(attempt), policy };
  }
  const current = createRun();
  function register(context = current, path = stagePath) {
    const token = registry.registerStage({ store, ...context, stagePath: path }); stages.add(token); return token;
  }
  function source(command, context = current, toolCallId = "stage-call") {
    return runtime.captureProtectedActorSource({ store, ...context, command, toolCallId });
  }
  function input(command, context = current, toolCallId = "stage-call") {
    return { command, cwd, inputRefs: [], policy: context.policy,
      source: { ...context.sourceFence, workspaceId: DEFAULT_WORKSPACE_ID, runId: context.run.id, toolCallId },
      protectedActorSource: source(command, context, toolCallId), assertCurrentAuthority() {} };
  }
  function directPrepared(context = current, alter = () => {}) {
    const command = { kind: "argv", argv: [config.executables.node.path, "-e", "process.exit(0)"] };
    const arena = realpathSync(mkdtempSync("/private/tmp/ling-command-")); arenas.push(arena);
    const copy = join(arena, "workspace"), scratch = join(arena, "scratch");
    mkdirSync(copy, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
    const token = source("node -e 'process.exit(0)'", context), protectedRoots = registry.protectedRoots(token);
    const policyInput = { now: new Date().toISOString(), platform: "darwin", tool: "bash", policy: { ...context.policy, allowedWritePaths: [] },
      workspaceRoot: copy, cwd: copy, temporaryRoot: scratch, runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS, config.executables.node.path],
      deniedReadRoots: [cwd, ...protectedRoots], protectedWriteRoots: protectedRoots, backend: readMacosSandboxBackendIdentity(), grants: [],
      binding: { ...context.sourceFence, workspaceId: DEFAULT_WORKSPACE_ID, runId: context.run.id, toolCallId: "stage-call",
        operationHash: macosSandboxCommandFingerprint(command, copy, scratch) } };
    alter(policyInput);
    const prepared = prepareMacosSandboxCommand({ policy: compileExecutionSandboxPolicy(policyInput), command });
    return { token, prepared, arena, copy, scratch };
  }
  t.after(() => {
    for (const token of stages) try { registry.closeStage(token); } catch { /* Tests explicitly retain unknown tombstones. */ }
    supervisor.releaseAll(); store.close();
    for (const arena of arenas) rmSync(arena, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, store, stagePath, registry, runtime, config, current, createRun, register, source, input, directPrepared };
}

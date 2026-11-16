import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";

export const reservationDist = new URL("../../dist/", import.meta.url);
const exec = promisify(execFile);

// Diagnostic opt-in only; acceptance runs use the compiled dist tree.
export function installReservationSourceHooks() {
  if (process.env.LING_WORKFLOW_RESERVATION_DIAGNOSTIC_SOURCE !== "1") return;
  const modules = ["features/workspaces/workflow-repository-fence", "features/channels/workflow-isolation-planning",
    "features/workspaces/workflow-git-repository"].map(name => [new URL(`${name}.js`, reservationDist).href,
    new URL(`../../src/${name}.ts`, import.meta.url).href]);
  const sources = new Map(modules), compiled = new Map(modules.map(([js, ts]) => [ts, js]));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = compiled.get(context.parentURL);
      const target = parent && specifier.startsWith(".") ? new URL(specifier, parent).href : specifier;
      if (sources.has(target)) return { url: sources.get(target), shortCircuit: true };
      const result = nextResolve(target, context);
      return sources.has(result.url) ? { url: sources.get(result.url), shortCircuit: true } : result;
    },
    load(url, context, nextLoad) {
      return compiled.has(url) ? { format: "module", shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }) }
        : nextLoad(url, context);
    },
  });
}

export async function reservationRecoveryFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-reservation-recovery-")));
  const cwd = join(root, "workspace"), worktreeRoot = join(root, "worktrees");
  await mkdir(cwd);
  await mkdir(worktreeRoot);
  const git = async (...args) => (await exec("/usr/bin/git", args, { cwd,
    env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Reservation fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
      GIT_COMMITTER_NAME: "Reservation fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
  await git("init", "--initial-branch=main");
  await writeFile(join(cwd, ".gitignore"), "*\n!.gitignore\n!owned.txt\n");
  await writeFile(join(cwd, "owned.txt"), "base\n");
  await git("add", "--", ".gitignore", "owned.txt");
  await git("commit", "-m", "initial");
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const f = { root, cwd, paths, git, workers: new Set(), store: createSqliteRunStore(cwd, paths) };
  t.after(async () => {
    for (const worker of f.workers) await worker.kill();
    f.store.close();
    assert.ok(root.startsWith(`${await realpath(tmpdir())}/ling-reservation-recovery-`));
    await rm(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString(), participantId = "teammate_builtin_engineer";
  let channel = f.store.createChannel({ name: "Reservation recovery", boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] }, now);
  f.store.replaceTeammateChannelMemberships(participantId, [{ channelId: channel.id }], now);
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Reservation fixture",
    providerId: "reservation-fixture", model: "fixture", api: "openai-responses", capabilities: ["chat", "tool_call"],
    input: ["text"], authHeader: false, enabled: true }, now);
  f.store.recordProviderCheckResult(provider.id, { ok: true, code: "static_check", message: "No transport", checkedAt: now });
  channel = f.store.updateChannel(channel.id, { defaultProviderPresetId: provider.id,
    runtimePolicy: { ...channel.runtimePolicy, writeLockScope: "boundPath", maxConcurrentRuns: 2 } }, now);
  const graph = { schemaVersion: 1, id: "reservation-recovery", name: "Reservation recovery", entryNodeId: "left",
    nodes: ["left", "right"].map(id => ({ id, kind: "step", name: id, prompt: "Write an owned file",
      sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 } })), edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
  f.workflow = f.store.createChannelWorkflow({ channelId: channel.id, title: "Reservation recovery",
    objective: "Exercise crash recovery without a Runner", status: "ready", createdBy: "local-user",
    metadata: { maxParallelSteps: 2, workflowGraph: graph, workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, now);
  f.steps = ["left", "right"].map((title, position) => f.store.createChannelWorkflowStep({ workflowId: f.workflow.id,
    title, position, prompt: "Write an owned file", toParticipantId: participantId, toParticipantLabel: "Engineer",
    metadata: { providerPresetId: provider.id, sideEffectClass: "workspace_write", requestedRunnerId: "pi",
      requiredTools: ["read", "write"], parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } } }, now));
  f.input = { workflowId: f.workflow.id, roundId: "reservation-recovery-round", worktreeRoot,
    validationRequirements: [{ id: "static", fingerprint: "reservation-fixture-v1" }],
    parallelExecution: { profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" } };
  f.fencePath = join(cwd, ".git", "ling-workflow-repository-fence.sqlite");
  return f;
}

export function reservationSnapshot(f) {
  const database = new DatabaseSync(f.fencePath, { readOnly: true });
  try {
    const fence = database.prepare("SELECT owner_json,state FROM repository_fence WHERE singleton=1").get();
    return { fence, owner: fence && JSON.parse(fence.owner_json),
      stores: database.prepare("SELECT database_path,identity_json FROM repository_stores ORDER BY database_path").all() };
  } finally { database.close(); }
}

export function reservationOrdinaryRun(f) {
  const now = new Date().toISOString(), taskId = "reservation-ordinary-task";
  const workUnit = f.store.createWorkUnit({ kind: "task_run", workspaceId: f.workflow.workspaceId,
    ownerType: "task", ownerId: taskId, taskId, runnerId: "pi", effectiveRunnerId: "pi",
    idempotencyKey: "reservation-ordinary-run", createdByActor: "local-user", request: {}, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: workUnit.id, attemptNumber: 1,
    runtimeInstanceId: "reservation-ordinary-host", runnerId: "pi", effectiveRunnerId: "pi", now });
  return { store: f.store, runRequest: { cwd: f.cwd, tools: ["write"], task: { id: taskId, title: "Write", prompt: "Write" } },
    runId: `ordinary-${workUnit.id}`, workUnit, attempt, now };
}

export function reservationWorker(f, options = {}) {
  const child = fork(new URL("./workflow-repository-reservation-recovery-worker.mjs", import.meta.url),
    [JSON.stringify({ cwd: f.cwd, paths: f.paths, fencePath: f.fencePath, planInput: f.input, ...options })],
    { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = [], waiters = [];
  let stderr = "", ended;
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  child.on("message", message => waiters.length ? waiters.shift().resolve(message) : messages.push(message));
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    ended = { code, signal };
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Reservation worker exited ${JSON.stringify(ended)}: ${stderr}`));
    resolve(ended);
  }));
  const worker = {
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      if (ended) return Promise.reject(new Error(`Reservation worker exited: ${stderr}`));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    resume(fail = false) { child.send({ fail }); },
    resumeMarker() { child.kill("SIGCONT"); },
    async done() { assert.deepEqual(await exited, { code: 0, signal: null }, stderr); },
    async kill() { if (!ended) child.kill("SIGKILL"); return exited; },
    exited,
  };
  f.workers.add(worker);
  return worker;
}

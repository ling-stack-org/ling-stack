import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { AppServerDevelopmentService } from "../dist/server/app-server-development.js";

test("development verification plans bind allowlisted checks and leave unconfigured checks blocked", async t => {
  const { cwd, context } = await verificationFixture(t);
  const service = new AppServerDevelopmentService({ context });
  const plan = await service.planVerification({
    cwd,
    candidate: { workspaceId: cwd, candidateDigest: "candidate-a" },
    requestedChecks: ["typecheck", "browser-smoke"],
  });
  assert.equal(plan.checks.length, 2);
  assert.equal(plan.checks[0]?.kind, "typecheck");
  assert.equal(plan.checks[1]?.kind, "browser");
  assert.equal(plan.checks[1]?.command, undefined);
  assert.match(plan.checks[0]?.recipeDigest ?? "", /^[a-f0-9]{64}$/u);
  await assert.rejects(
    service.startVerification({ planId: plan.planId, planRevision: plan.planRevision, candidateDigest: "other", idempotencyKey: "start-1" }),
    /stale|unavailable/u,
  );
});

test("instructions init discovers scoped project rules and blocks unversioned apply", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ling-app-server-instructions-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "workspace");
  const nested = join(cwd, "packages", "feature");
  await mkdir(nested, { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "root rules\n");
  await writeFile(join(nested, "AGENTS.md"), "feature rules\n");
  const service = new AppServerDevelopmentService({ context: { config: { defaultWorkspaceCwd: cwd } } as never });
  const preview = await service.initInstructions({ cwd, taskPath: "packages/feature", mode: "preview", idempotencyKey: "init-1" });
  assert.equal(preview.status, "draft");
  assert.deepEqual(preview.sources.map(source => source.path), ["AGENTS.md", "packages/feature/AGENTS.md"]);
  const blocked = await service.initInstructions({ cwd, mode: "apply", idempotencyKey: "init-2" });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.conflicts, ["apply requires expectedWorkspaceRevision"]);
});

test("verification persists a single start receipt and recovers in its originating workspace", async t => {
  const { cwd, context, storeRegistry, restart } = await verificationFixture(t);
  const project = join(cwd, "project");
  await mkdir(project);
  const first = new AppServerDevelopmentService({
    context,
    executeVerificationCheck: () => new Promise(() => undefined),
  });
  const candidate = { workspaceId: project, candidateDigest: "restart-candidate" };
  const plan = await first.planVerification({ cwd: project, candidate, idempotencyKey: "plan" });
  assert.deepEqual(await first.planVerification({ cwd: project, candidate, idempotencyKey: "plan" }), plan);
  const input = { cwd: project, planId: plan.planId, planRevision: plan.planRevision, candidateDigest: candidate.candidateDigest, idempotencyKey: "restart" };
  const operation = await first.startVerification(input);
  assert.equal((await first.startVerification(input)).operationId, operation.operationId);
  assert.equal(first.getVerification({ cwd: project, operationId: operation.operationId }).operation.status, "running");
  const otherPlan = await first.planVerification({ cwd: project, candidate, requestedChecks: ["test"] });
  await assert.rejects(first.startVerification({ ...input, planId: otherPlan.planId, planRevision: otherPlan.planRevision }), { code: "idempotency_conflict" });
  assert.equal(storeRegistry.getStore(project).listAppServerState("verify_operation").length, 1);

  const restored = new AppServerDevelopmentService({ context: restart() });
  assert.throws(() => restored.getVerification({ operationId: operation.operationId }), /not found/u);
  const recovered = await restored.startVerification(input);
  assert.equal(recovered.operationId, operation.operationId);
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.blocker, "daemon_restart_reconciliation_required");
  assert.deepEqual(recovered.checks.map(check => check.status), ["unknown", "not_run"]);
});

test("verification passes cancellation to the active check and ignores remaining work", async t => {
  const { cwd, context, restart } = await verificationFixture(t);
  let checkSignal: AbortSignal | undefined;
  let finishCheck: (status: "passed") => void = () => assert.fail("No check is active.");
  let starts = 0;
  const service = new AppServerDevelopmentService({
    context,
    executeVerificationCheck: ({ signal }) => {
      starts++;
      checkSignal = signal;
      return new Promise(resolve => { finishCheck = resolve; });
    },
  });
  const plan = await service.planVerification({ candidate: { workspaceId: cwd, candidateDigest: "cancel-fixture" } });
  const start = { planId: plan.planId, planRevision: plan.planRevision, candidateDigest: plan.candidate.candidateDigest, idempotencyKey: "start" };
  const { operationId } = await service.startVerification(start);
  assert.equal(service.cancelVerification({ operationId, idempotencyKey: "cancel" }).status, "cancel_requested");
  assert.equal(checkSignal?.aborted, true);
  finishCheck("passed");
  await setImmediate();
  assert.equal(starts, 1);
  const restored = new AppServerDevelopmentService({ context: restart() });
  const result = restored.getVerification({ operationId }).operation;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.checks.map(check => check.status), ["passed", "not_run"]);
  assert.deepEqual(await restored.startVerification(start), result);
});

async function verificationFixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-app-server-verify-")));
  const makeRegistry = () => new RunStoreRegistry(workspace => createSqliteRunStore(workspace, resolveStoragePaths(workspace, {
    homeDir: cwd, env: {}, workspaceStateLocation: "repo-local",
  }).workspace));
  let registry = makeRegistry();
  const makeContext = () => ({ config: { defaultWorkspaceCwd: cwd }, storeRegistry: registry }) as never;
  t.after(async () => {
    registry.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, context: makeContext(), storeRegistry: registry, restart() {
    registry.closeAll();
    registry = makeRegistry();
    return makeContext();
  } };
}

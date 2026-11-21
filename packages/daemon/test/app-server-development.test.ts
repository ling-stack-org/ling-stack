import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerDevelopmentService } from "../dist/server/app-server-development.js";

test("development verification plans are candidate-bound and deterministic", async () => {
  const service = new AppServerDevelopmentService({ context: {} as never });
  const plan = await service.planVerification({
    cwd: "/tmp/ling-app-server-fixture",
    candidate: { workspaceId: "/tmp/ling-app-server-fixture", candidateDigest: "candidate-a" },
    requestedChecks: ["typecheck", "browser-smoke"],
  });
  assert.equal(plan.checks.length, 2);
  assert.equal(plan.checks[0]?.kind, "typecheck");
  assert.equal(plan.checks[1]?.kind, "browser");
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

test("verification state survives service recreation and marks in-flight work unknown", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-app-server-verify-state-")));
  const records = new Map<string, { kind: string; recordId: string; payload: unknown; idempotencyKey?: string }>();
  const store = {
    putAppServerState(input: { kind: string; recordId: string; payload: unknown; idempotencyKey?: string }) {
      records.set(`${input.kind}:${input.recordId}`, input);
      return { status: "created" as const, record: { workspaceId: "workspace_default", revision: 1, createdAt: "now", updatedAt: "now", ...input } };
    },
    getAppServerState(kind: string, recordId: string) {
      const value = records.get(`${kind}:${recordId}`);
      return value ? { workspaceId: "workspace_default", revision: 1, createdAt: "now", updatedAt: "now", ...value } : undefined;
    },
  };
  const storeRegistry = { getStore: () => store };
  const context = { config: { defaultWorkspaceCwd: cwd }, storeRegistry } as never;
  const first = new AppServerDevelopmentService({ context, storeRegistry: storeRegistry as never });
  const plan = await first.planVerification({ cwd, candidate: { workspaceId: cwd, candidateDigest: "restart-candidate" } });
  const operation = await first.startVerification({ planId: plan.planId, planRevision: plan.planRevision, candidateDigest: plan.candidate.candidateDigest, idempotencyKey: "restart-verify" });
  const second = new AppServerDevelopmentService({ context, storeRegistry: storeRegistry as never });
  const recovered = second.getVerification({ operationId: operation.operationId });
  assert.equal(recovered.operation.status, "unknown");
  assert.equal(recovered.operation.blocker, "daemon_restart_reconciliation_required");
});

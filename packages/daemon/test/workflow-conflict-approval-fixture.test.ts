import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { toRuntimeAttemptFence, type RunStore } from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { ApprovalResumeCoordinator } from "../dist/features/runs/approval-resume-coordinator.js";
import { recoverApprovalPostCommitStore } from "../dist/features/runs/approval-postcommit-recovery.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { now, recoveryHost, workflowConflictRecoveryFixture } from "./support/workflow-conflict-recovery-fixture.mjs";

test("a live fixture Host approval retains its owner while background recovery scans", recoveryHost, async t => {
  const f = await workflowConflictRecoveryFixture(t);
  const round = await f.create(), item = await f.start(round, 0);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: f.cwd }));
  t.after(() => supervisor.releaseAll());
  const resume = new ApprovalResumeCoordinator({
    runtimeSupervisor: supervisor, activeRuns: new ActiveRunRegistry(), runnerRegistry: f.runners,
  });
  let scans = 0, resumes = 0, ownerStatusAtScan: string | undefined;
  const approve = f.store.approveApprovalRequest.bind(f.store) as RunStore["approveApprovalRequest"];
  t.mock.method(f.store, "approveApprovalRequest", (...args: Parameters<typeof approve>) => {
    const approval = approve(...args);
    assert.ok(approval);
    queueMicrotask(() => {
      scans += 1;
      ownerStatusAtScan = f.store.listApprovalPostCommitEffects({ approvalId: approval.id })
        .find(effect => effect.effectKind === "owner")?.status;
      recoverApprovalPostCommitStore({ store: f.store, cwd: f.cwd, now: now(), onOwnerResolved: value => {
        resumes += 1;
        const result = resume.resumeAfterApproval({ store: f.store, approval: value });
        if (result.status === "blocked") throw new Error(result.reason);
        return undefined;
      } });
    });
    return approval;
  });

  const write = await item.write("live approval owner\n");
  assert.equal(scans, 1, "Recovery must run during the original Host callback's approval wait");
  assert.equal(ownerStatusAtScan, "claimed");
  assert.equal(resumes, 0, "The fixture owns a live callback, not a suspended Run to resume");
  assert.equal(f.store.getRun(item.run.id)?.status, "running");
  const attempt = f.store.getWorkUnitAttempt(item.fence.attemptId);
  assert.ok(attempt);
  assert.equal(attempt.status, "started");
  assert.deepEqual(toRuntimeAttemptFence(attempt), item.fence);
  assert.equal(f.store.getWorkUnit(item.fence.workUnitId)?.activeAttemptId, item.fence.attemptId);
  assert.equal(f.store.getApprovalRequest(write.approvalId)?.status, "approved");
  assert.equal(f.store.listApprovalPostCommitEffects({ approvalId: write.approvalId })
    .find(effect => effect.effectKind === "owner")?.status, "completed");
  assert.equal(await readFile(join(round.plans[0].executionRoot, "shared.txt"), "utf8"), "live approval owner\n");
  await f.finish(item);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  LING_APP_SERVER_METHOD_SCHEMAS,
  getLingAppServerSchema,
  validateLingAppServerNotificationParams,
  validateLingAppServerParams,
  validateLingAppServerResult,
  validateLingAppServerServerRequestParams,
} from "../dist/app-server-schema.js";
import { LING_APP_SERVER_METHODS, LING_APP_SERVER_NOTIFICATION_METHODS, LING_APP_SERVER_SERVER_REQUEST_METHODS } from "../dist/app-server.js";
import type {
  LingAppServerGitHubDeliveryResult, LingAppServerGitHubQueueResult,
  LingAppServerVerifyOperation, LingAppServerVerifyPlanResult,
} from "../dist/app-server.js";

test("App Server exposes a versioned schema for every registered method", () => {
  const document = getLingAppServerSchema();
  assert.equal(document.protocolVersion, "ling-app-server/1");
  assert.deepEqual(Object.keys(document.methods), LING_APP_SERVER_METHODS);
  assert.deepEqual(Object.keys(document.notifications), LING_APP_SERVER_NOTIFICATION_METHODS);
  assert.deepEqual(Object.keys(document.serverRequests), LING_APP_SERVER_SERVER_REQUEST_METHODS);
  assert.equal(document.methods, LING_APP_SERVER_METHOD_SCHEMAS);
  assert.equal(document.methods["turn/start"]?.params.type, "object");
  assert.equal(document.methods["turn/start"]?.result.type, "object");
});

test("App Server consumers can validate streamed text, replay and server request parameters", () => {
  const delta = { subscriptionId: "subscription", workspaceId: "workspace", subject: { kind: "thread", threadId: "thread", turnId: "turn" },
    runId: "run", itemId: "item", streamEpoch: "epoch", offset: 2, text: "More output" };
  assert.ok(validateLingAppServerNotificationParams("item/delta", delta).ok);
  assert.equal(validateLingAppServerNotificationParams("item/delta", { ...delta, offset: "2" }).path, "params.offset");
  assert.equal(validateLingAppServerNotificationParams("item/delta", { ...delta, subject: { kind: "workItem" } }).ok, false);
  assert.ok(validateLingAppServerNotificationParams("server/restarted", { previousServerInstanceId: "old", serverInstanceId: "new" }).ok);
  assert.equal(validateLingAppServerNotificationParams("server/restarted", { serverInstanceId: "new" }).ok, false);
  assert.ok(validateLingAppServerNotificationParams("thread/resync/required", { reason: "authorization_changed", threadId: "thread" }).ok);
  assert.ok(validateLingAppServerNotificationParams("workItem/resync/required", { disposition: "snapshot_required", workItemId: "item" }).ok);
  assert.equal(validateLingAppServerNotificationParams("turn/start", {}).ok, false);
  const decision = { approvalId: "approval", pendingId: "approval", revision: "revision" };
  assert.ok(validateLingAppServerServerRequestParams("approval/requestDecision", decision).ok);
  assert.equal(validateLingAppServerServerRequestParams("approval/requestDecision", { ...decision, revision: 2 }).path, "params.revision");
  const question = { pendingId: "input", threadId: "thread", itemId: "item", request: { requestId: "input", status: "pending" } };
  assert.ok(validateLingAppServerServerRequestParams("input/requestAnswer", question).ok);
  assert.equal(validateLingAppServerServerRequestParams("input/requestAnswer", { ...question, request: { status: "answered" } }).ok, false);
});

test("App Server parameter validation checks high-risk required fields while retaining extension fields", () => {
  assert.equal(validateLingAppServerParams("turn/start", { threadId: "thread-1", extension: true }).ok, true);
  const invalid = validateLingAppServerParams("turn/start", {});
  assert.deepEqual(invalid, { ok: false, path: "params.threadId", message: "is required" });
  assert.equal(validateLingAppServerParams("approval/respond", { approvalId: "approval-1", decision: "later" }).ok, false);
  assert.equal(validateLingAppServerParams("turn/start", "invalid").ok, false);
  const grant = { label: "Stage", subject: { kind: "workItem", id: "item" }, scopes: [], expiresAt: "2026-11-24T06:00:00Z",
    credentialSha256: "f".repeat(64), idempotencyKey: "stage-grant", stageExecution: { runId: "run", attemptId: "attempt" } };
  assert.ok(validateLingAppServerParams("server/grants/create", grant).ok);
  assert.equal(validateLingAppServerParams("server/grants/create", {
    ...grant, stageExecution: { runId: "run" },
  }).path, "params.stageExecution.attemptId");
});

test("App Server recovery requires a pinned revision and validates the evidence projection", () => {
  const prepare = { expectedRevision: 0, idempotencyKey: "prepare-recovery" };
  assert.ok(validateLingAppServerParams("server/recovery/prepare", prepare).ok);
  assert.equal(validateLingAppServerParams("server/recovery/prepare", { ...prepare, expectedRevision: "0" }).path, "params.expectedRevision");
  assert.equal(validateLingAppServerParams("server/recovery/reconcile", {}).path, "params.expectedRevision");
  const report = { cwd: "/workspace", revision: 1, status: "reconciliation_required", pendingCount: 1,
    entries: [{ id: "record", kind: "github_queue_enqueue", recordedAt: "2026-11-22T00:00:00.000Z", pending: true,
      repositoryId: "73", workItemId: "work", pullRequestNumber: 12, headSha: "a".repeat(40) }] };
  assert.ok(validateLingAppServerResult("server/recovery/read", report).ok);
  assert.equal(validateLingAppServerResult("server/recovery/read", {
    ...report, entries: [{ ...report.entries[0], repositoryId: undefined }],
  }).path, "result.entries[0]");
});

test("Verify results validate check provenance, execution and cancellation", () => {
  const verifier = { verifierBasisRef: "basis", coverageDigest: "coverage", producerRefs: ["trusted-verifier"] };
  const checkPlan = { checkId: "behavior", kind: "test", label: "Behavior", required: true, recipeDigest: "recipe", ...verifier } as const;
  const plan = {
    planId: "verify-plan", planRevision: "verify-plan-revision", candidate: { workspaceId: "/workspace", candidateDigest: "candidate" },
    checks: [checkPlan], rationale: [], environmentRequirements: [],
  } satisfies LingAppServerVerifyPlanResult;
  assert.ok(validateLingAppServerResult("verify/plan", plan).ok);
  assert.equal(validateLingAppServerResult("verify/plan", { ...plan, checks: [{ ...checkPlan, required: "yes" }] }).path,
    "result.checks[0].required");

  const check = {
    checkId: checkPlan.checkId, candidateDigest: plan.candidate.candidateDigest, planRevision: plan.planRevision,
    recipeDigest: checkPlan.recipeDigest, environmentDigest: "environment", ...verifier, attemptId: "attempt",
    status: "passed", evidenceRefs: ["report"],
  } as const;
  const operation = {
    operationId: "verify-operation", planId: plan.planId, candidateDigest: plan.candidate.candidateDigest, status: "passed", checks: [check],
  } satisfies LingAppServerVerifyOperation;
  assert.ok(validateLingAppServerResult("verify/start", operation).ok);
  assert.equal(validateLingAppServerResult("verify/status", { operation: { ...operation, checks: [{ ...check, producerRefs: "trusted-verifier" }] } }).path,
    "result.operation.checks[0].producerRefs");
  const execution = { startedAt: "start", endedAt: "end", exitCode: null, timedOut: true, output: "", outputTruncated: false };
  assert.ok(validateLingAppServerResult("verify/status", { operation: { ...operation, status: "blocked", checks: [
    { ...check, status: "blocked", execution },
  ] } }).ok);
  assert.equal(validateLingAppServerResult("verify/start", { ...operation, checks: [
    { ...check, execution: { ...execution, exitCode: "0" } },
  ] }).path, "result.checks[0].execution.exitCode");
  assert.ok(validateLingAppServerResult("verify/cancel", { operationId: operation.operationId, status: "unknown" }).ok);
  assert.equal(validateLingAppServerResult("verify/cancel", { operationId: operation.operationId, status: "passed" }).path, "result.status");
});

test("GitHub delivery results carry the source of each check and the exact run attempt", () => {
  const delivery = {
    cwd: "/workspace",
    delivery: {
      deliveryId: "delivery", workItemId: "work", acceptanceId: "acceptance", threadId: "thread",
      candidateDigest: "candidate", policyRevision: "policy", baseCommit: "base",
      subject: { githubInstanceId: "github.com", repository: "example/ling", repositoryId: "73", kind: "pull_request",
        number: 12, title: "Repair replay", state: "open", sourceRevision: "source", headSha: "head" },
      checks: [{
        check: { name: "integration", appId: 19, workflowId: 5, workflowPath: ".github/workflows/ci.yml",
          workflowSha256: "workflow", basis: "merge_group", coverageRefs: ["ci-integration"] },
        outcome: "passed", testedCommit: "group", runId: 15, runAttempt: 2, checkRunId: 16, jobId: 16,
      }],
      status: "delivery_pending", observedAt: "2026-11-23T01:00:00Z",
    },
  } satisfies LingAppServerGitHubDeliveryResult;
  assert.ok(validateLingAppServerResult("github/delivery/reconcile", delivery).ok);
  const proof = delivery.delivery.checks[0]!;
  assert.equal(validateLingAppServerResult("workItem/delivery/read", {
    ...delivery, delivery: { ...delivery.delivery, checks: [{ ...proof, runAttempt: "2" }] },
  }).path, "result.delivery.checks[0].runAttempt");
  assert.equal(validateLingAppServerResult("delivery/read", {
    ...delivery, delivery: { ...delivery.delivery, checks: [{ ...proof, check: { ...proof.check, appId: undefined } }] },
  }).path, "result.delivery.checks[0].check.appId");

  const queue = {
    cwd: "/workspace",
    receipt: { workItemId: "work", queueReceiptId: "queue", deliveryId: "delivery", repository: "example/ling",
      repositoryId: "73", pullRequestNumber: 12, headSha: "head", status: "unknown", createdAt: "2026-11-23T01:00:00Z" },
  } satisfies LingAppServerGitHubQueueResult;
  assert.ok(validateLingAppServerResult("github/delivery/enqueue", queue).ok);
  assert.equal(validateLingAppServerResult("github/delivery/queue/read", {
    ...queue, receipt: { ...queue.receipt, status: "passed" },
  }).path, "result.receipt.status");
});

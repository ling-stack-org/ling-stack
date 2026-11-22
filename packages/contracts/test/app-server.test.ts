import assert from "node:assert/strict";
import test from "node:test";
import {
  LING_APP_SERVER_ERROR_NUMERIC_CODES,
  LING_APP_SERVER_METHODS,
  LING_APP_SERVER_NOTIFICATION_METHODS,
  LING_APP_SERVER_PROTOCOL_VERSION,
  isLingAppServerErrorCode,
  isLingAppServerMethod,
  isLingAppServerNotification,
  isLingAppServerNotificationMethod,
  isLingAppServerRequest,
} from "../src/app-server.ts";
import type {
  LingAppServerDoctorRunResult,
  LingAppServerExternalAgentRegistration,
  LingAppServerExternalAgentTaskSubmission,
  LingAppServerVerifyPlanResult,
  LingAppServerWorkItemCollaborationAppendParams,
  LingAppServerWorkItemCollaborationRecord,
} from "../src/app-server.ts";

test("App Server V1 exposes a unique method and notification registry", () => {
  assert.equal(LING_APP_SERVER_PROTOCOL_VERSION, "ling-app-server/1");
  assert.equal(new Set(LING_APP_SERVER_METHODS).size, LING_APP_SERVER_METHODS.length);
  assert.equal(new Set(LING_APP_SERVER_NOTIFICATION_METHODS).size, LING_APP_SERVER_NOTIFICATION_METHODS.length);
  assert.equal(isLingAppServerMethod("thread/start"), true);
  assert.equal(isLingAppServerMethod("unknown/method"), false);
  assert.equal(isLingAppServerNotificationMethod("workItem/status/changed"), true);
  assert.equal(isLingAppServerNotificationMethod("thread/start"), false);
  assert.equal(isLingAppServerErrorCode("candidate_stale"), true);
  assert.equal(isLingAppServerErrorCode("not_an_error"), false);
  assert.equal(LING_APP_SERVER_ERROR_NUMERIC_CODES.server_draining, -32002);
});

test("App Server request and notification guards enforce JSON-RPC direction", () => {
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", id: 1, method: "thread/start", params: {} }), true);
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", method: "server/ping" }), true);
  assert.equal(isLingAppServerRequest({ jsonrpc: "1.0", id: 1, method: "thread/start" }), false);
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", id: null, method: "thread/start" }), false);
  assert.equal(isLingAppServerRequest({ jsonrpc: "2.0", id: 1, method: "unknown/method" }), false);
  assert.equal(isLingAppServerNotification({ jsonrpc: "2.0", method: "initialized" }), true);
  assert.equal(isLingAppServerNotification({ jsonrpc: "2.0", id: 1, method: "initialized" }), false);
  assert.equal(isLingAppServerNotification({ jsonrpc: "2.0", method: "thread/start" }), false);
});

test("typed development and federation DTOs retain candidate and authorization lineage", () => {
  const plan: LingAppServerVerifyPlanResult = {
    planId: "verify-plan-1",
    planRevision: "rev-1",
    candidate: { workspaceId: "workspace-1", candidateDigest: "sha256:abc" },
    checks: [{ checkId: "typecheck", kind: "typecheck", label: "Typecheck", recipeDigest: "sha256:recipe", required: true }],
    rationale: ["Changed TypeScript source"],
    environmentRequirements: ["node"],
  };
  const doctor: LingAppServerDoctorRunResult = {
    doctorVersion: 1,
    cwd: "/workspace",
    overallStatus: "ok",
    checks: [{ id: "instructions", category: "instructions", status: "ok", summary: "Loaded" }],
    generatedAt: "2026-11-21T00:00:00.000Z",
  };
  const registration: LingAppServerExternalAgentRegistration = {
    agentId: "agent-1",
    adapterKind: "ling-app-server",
    protocolVersion: "ling-app-server/1",
    displayName: "Agent",
    capabilities: ["workItem.read"],
    workspaceScopes: ["workspace-1"],
    toolScopes: [],
    approvalModes: ["observe"],
    source: "local",
    version: "1.0.0",
  };
  const submission: LingAppServerExternalAgentTaskSubmission = {
    workItemId: "work-1",
    workItemRevision: "rev-1",
    objective: "Inspect the candidate",
    acceptanceSnapshot: { revision: "goal-1" },
    workspaceId: "workspace-1",
    instructionManifestDigest: "sha256:instructions",
    idempotencyKey: "submission-1",
  };
  assert.equal(plan.candidate.candidateDigest, "sha256:abc");
  assert.equal(doctor.checks[0]?.category, "instructions");
  assert.equal(registration.workspaceScopes[0], "workspace-1");
  assert.equal(submission.workItemRevision, "rev-1");
});

test("collaboration DTOs preserve typed record lineage and CAS inputs", () => {
  const record: LingAppServerWorkItemCollaborationRecord = {
    id: "collab-record-1",
    workspaceId: "workspace-1",
    workItemId: "work-item-1",
    collaborationRevision: 2,
    workItemRevision: 4,
    kind: "handoff",
    action: "accepted",
    actorId: "agent-b",
    payload: { expectedOutput: "verification report" },
    parentRecordId: "collab-record-0",
    sourceRefs: [{ type: "run", id: "run-1", revision: "3" }],
    idempotencyKey: "handoff-accept-1",
    createdAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
  const input: LingAppServerWorkItemCollaborationAppendParams = {
    workItemId: record.workItemId,
    expectedWorkItemRevision: record.workItemRevision,
    expectedCollaborationRevision: record.collaborationRevision,
    kind: record.kind,
    action: record.action,
    actorId: record.actorId,
    payload: record.payload,
    parentRecordId: record.parentRecordId,
    sourceRefs: record.sourceRefs,
    idempotencyKey: record.idempotencyKey,
  };
  assert.equal(input.expectedCollaborationRevision, 2);
  assert.equal(record.sourceRefs[0]?.type, "run");
});

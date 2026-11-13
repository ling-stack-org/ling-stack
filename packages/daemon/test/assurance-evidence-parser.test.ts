import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { FrameworkAssuranceEvidenceResponse } from "@ling-stack/contracts";
import { collectLiveExecutionEvidence, loadExecutionEvidence, parseLiveExecutionEvidenceResponse }
  from "../../../scripts/framework-assurance/execution-evidence.mjs";

const frozen = loadExecutionEvidence(await readFile(new URL("../../../fixtures/framework-assurance/execution-evidence/valid.json", import.meta.url)));

function source(): FrameworkAssuranceEvidenceResponse {
  const execution = frozen.execution;
  return {
    schemaVersion: 1, kind: "live_execution_evidence", comparison: frozen.comparison,
    execution, snapshots: frozen.snapshots, artifacts: frozen.artifacts,
    observedAt: frozen.observedAt, limitations: ["read_only_host_projection"],
    lifecycle: {
      status: "drained", currentAttemptId: execution.attemptId, currentGeneration: 1, attemptCount: 1, oldAttemptCount: 0,
      attempts: [{ attemptId: execution.attemptId, attemptNumber: 1, runtimeInstanceId: execution.runtimeInstanceId,
        fencingToken: execution.fencingToken, status: "succeeded", isCurrent: true, abortRequestedAt: null,
        endedAt: frozen.observedAt, localExecution: "drained", effects: "settled" }],
      stop: { localExecution: "drained", effects: "settled", allAttemptsTerminal: true, reusable: true },
    },
    completion: {
      status: "not_applicable", rootRunIds: [], fingerprint: null, stepCount: 0, requiredStepCount: 0,
      completedStepCount: 0, steps: [], issues: [], resultArtifacts: [],
    },
    budget: {
      status: "not_applicable", roots: [], reservations: [], charges: [],
      usage: { tokenStatus: "not_applicable", costStatus: "not_applicable", tokens: null, costMicros: null, tokenLimit: null, costLimitMicros: null },
      issues: [], blockers: [],
    },
    isolation: {
      status: "blocked", workflowId: "workflow-parser", workflowStepId: "step-parser", selection: null,
      safetyPlan: { present: false, valid: false, profile: null, digest: null, toolsCount: 0, writeRootsCount: 0, networkAccess: null },
      binding: { status: "missing", bindingId: null, revision: null, planDigest: null, matchesCurrentFence: false },
      round: null,
      history: [{ roundId: "round-parser", generation: 1, revision: 1, phase: "blocked", reason: null }],
      effects: [], receipts: [],
      branchResults: [{ workflowStepId: "step-parser", status: "missing", packetDigest: null, packetContentSha256: null }],
      approval: { status: "not_requested", approvalId: null, requestId: null, authorityDigest: null, basisFingerprint: null },
      apply: { status: "not_started", code: null, intentPresent: false }, blockers: ["workflow_isolation.binding_missing"],
    },
    admission: {
      status: "blocked", profile: null, safetyPlan: { present: false, valid: false, digest: null },
      toolBroker: { mode: "off", required: true, satisfies: false },
      binding: { status: "missing", matchesCurrentFence: false }, blockers: ["workflow_admission.execution_binding_invalid"],
    },
  };
}

const invalidManifest = (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_manifest";
const fields: [string, (value: FrameworkAssuranceEvidenceResponse, invalid: unknown) => void][] = [
  ["history reason", (value, invalid) => { Object.assign(value.isolation.history[0], { reason: invalid }); }],
  ["branch packet digest", (value, invalid) => { Object.assign(value.isolation.branchResults[0], { packetDigest: invalid }); }],
  ["branch content digest", (value, invalid) => { Object.assign(value.isolation.branchResults[0], { packetContentSha256: invalid }); }],
  ...["approvalId", "requestId", "authorityDigest", "basisFingerprint"].map(field =>
    [`approval ${field}`, (value: FrameworkAssuranceEvidenceResponse, invalid: unknown) => {
      Object.assign(value.isolation.approval, { [field]: invalid });
    }] as [string, (value: FrameworkAssuranceEvidenceResponse, invalid: unknown) => void]),
];

test("live evidence accepts absent optional isolation identifiers and valid populated values", () => {
  assert.equal(parseLiveExecutionEvidenceResponse(source()).isolation.approval.approvalId, null);
  const value = source();
  Object.assign(value.isolation.history[0], { reason: "workflow_merge.approval_pending" });
  Object.assign(value.isolation.branchResults[0], { packetDigest: "packet-parser", packetContentSha256: "a".repeat(64) });
  Object.assign(value.isolation.approval, { approvalId: "approval-parser", requestId: "request-parser", authorityDigest: "authority-parser", basisFingerprint: "basis-parser" });
  assert.equal(parseLiveExecutionEvidenceResponse(value).isolation.branchResults[0].packetContentSha256, "a".repeat(64));
});

for (const [field, mutate] of fields) {
  for (const [kind, invalid] of [["boolean", false], ["object", { body: "private-body" }], ["oversized", "x".repeat(201)]] as const) {
    test(`live evidence rejects ${kind} ${field}`, () => {
      const value = source();
      mutate(value, invalid);
      assert.throws(() => parseLiveExecutionEvidenceResponse(value), invalidManifest);
    });
  }
}

test("live collection rejects a private body in an optional isolation identifier", async () => {
  const value = source();
  Object.assign(value.isolation.approval, { approvalId: { body: "private-body" } });
  await assert.rejects(collectLiveExecutionEvidence({
    client: { getRunAssuranceEvidence: async () => value }, cwd: "/workspace/parser", runId: frozen.execution.runId,
    taskIdentity: frozen.taskIdentity, sourceCommit: frozen.sourceCommit, inputDigests: frozen.inputDigests,
    caseId: frozen.caseId, invocationId: "00000000-0000-4000-8000-000000000001",
  }), invalidManifest);
});

function withReceipt(): FrameworkAssuranceEvidenceResponse {
  const value = source();
  Object.assign(value.completion, { fingerprint: "completion-parser" });
  Object.assign(value.isolation, { receipts: [{ receiptId: "receipt-parser", intentId: "intent-parser", outcome: "confirmed",
    observedDigest: `observation_${"a".repeat(64)}`, artifactId: "artifact-parser", artifactContentSha256: "a".repeat(64) }] });
  Object.assign(value.isolation.branchResults[0], { packetContentSha256: "a".repeat(64) });
  return value;
}

test("live evidence accepts string fingerprints and receipt content digests", () => {
  assert.equal(parseLiveExecutionEvidenceResponse(withReceipt()).completion.fingerprint, "completion-parser");
});

const shapedFields: [string, unknown, (value: FrameworkAssuranceEvidenceResponse, invalid: unknown) => void][] = [
  ["array completion fingerprint", ["completion-parser"], (value, invalid) => { Object.assign(value.completion, { fingerprint: invalid }); }],
  ["numeric completion fingerprint", 123, (value, invalid) => { Object.assign(value.completion, { fingerprint: invalid }); }],
  ["array branch content digest", ["a".repeat(64)], (value, invalid) => { Object.assign(value.isolation.branchResults[0], { packetContentSha256: invalid }); }],
  ["array receipt content digest", ["a".repeat(64)], (value, invalid) => { Object.assign(value.isolation.receipts[0], { artifactContentSha256: invalid }); }],
];
for (const [field, invalid, mutate] of shapedFields) {
  test(`live evidence rejects ${field}`, () => {
    const value = withReceipt();
    mutate(value, invalid);
    assert.throws(() => parseLiveExecutionEvidenceResponse(value), invalidManifest);
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { FrameworkAssuranceEvidenceResponse } from "@ling-stack/contracts";
import { adaptLiveExecutionEvidenceForDiagnostics, collectLiveExecutionEvidence, loadExecutionEvidence }
  from "../../../scripts/framework-assurance/execution-evidence.mjs";
import { linkAssuranceReport, readHarnessDiagnosticsReportFromClient }
  from "../../../scripts/framework-assurance/diagnostics.mjs";

const frozen = loadExecutionEvidence(await readFile(new URL("../../../fixtures/framework-assurance/execution-evidence/valid.json", import.meta.url)));
const cwd = "/workspace/assurance-diagnostics";
const { runId, workUnitId } = frozen.execution;
type Source = Pick<FrameworkAssuranceEvidenceResponse,
  "schemaVersion" | "kind" | "comparison" | "execution" | "snapshots" | "artifacts" | "observedAt" | "limitations">;
type Collected = Awaited<ReturnType<typeof collectLiveExecutionEvidence>>;

function source(): Source {
  return structuredClone({
    schemaVersion: 1, kind: "live_execution_evidence", comparison: frozen.comparison,
    execution: frozen.execution, snapshots: frozen.snapshots, artifacts: frozen.artifacts,
    observedAt: frozen.observedAt, limitations: ["read_only_host_projection", "no_evaluation_grade", "no_evaluation_grade_body", "attempt_artifact_binding_unavailable"],
  });
}

async function collect(): Promise<Collected> {
  const calls: unknown[] = [];
  const result = await collectLiveExecutionEvidence({
    client: { getRunAssuranceEvidence: async (requestedRunId, requestedCwd) => {
      calls.push([requestedRunId, requestedCwd]);
      return source();
    } },
    cwd, runId, taskIdentity: frozen.taskIdentity, sourceCommit: frozen.sourceCommit,
    inputDigests: frozen.inputDigests, caseId: frozen.caseId, invocationId: "invocation-diagnostics",
  });
  assert.deepEqual(calls, [[runId, cwd]]);
  return result;
}

const errorCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;

test("collected Host evidence joins F4 diagnostics through the explicit three-field envelope", async () => {
  const collected = await collect();
  assert.throws(() => linkAssuranceReport(collected, { runId, workUnitId }), errorCode("diagnostics_invalid_response"));
  const envelope = adaptLiveExecutionEvidenceForDiagnostics(collected);
  assert.deepEqual(Object.keys(envelope).sort(), ["lineage", "observation", "observedAt"]);
  assert.equal(envelope.observation.assessment, "not_assessed");
  assert.ok(collected.source.limitations.includes("no_evaluation_grade"));
  assert.ok(collected.source.limitations.includes("no_evaluation_grade_body"));
  assert.ok(envelope.observation.limitations.includes("attempt_artifact_binding_unavailable"));
  const calls: unknown[] = [];
  const report = await readHarnessDiagnosticsReportFromClient({
    cwd, runId, workUnitId, assurance: envelope,
    client: { getWorkUnitHarnessDiagnostics: async (...args: unknown[]) => {
      calls.push(args);
      return {
        schemaVersion: 1, cwd, workUnitId, runId, status: "available", observedAt: frozen.observedAt,
        items: [], projectionCheckpoints: ["continuation", "tool_execution", "evaluation", "delegation"].map(domain => ({
          domain, generation: 1, sourceEpoch: 1, builtEpoch: 1, state: "ready", rowCount: 0,
          isCurrent: true, updatedAt: frozen.observedAt,
        })),
      };
    } },
  });
  assert.deepEqual(calls, [[cwd, workUnitId, { limit: 100 }]]);
  assert.equal(report.status, "available");
  assert.ok(report.assurance);
  assert.equal(report.assurance.observation.evidenceKind, "live_execution");
  assert.equal(report.assurance.observation.assessment, "not_assessed");
  assert.deepEqual(report.assurance.lineage, collected.lineage);
  assert.ok(report.limitations.includes("no_execution_authority"));
  assert.ok(!JSON.stringify(report).includes("fencingToken"));
  assert.ok(!JSON.stringify(report).includes("inputDigests"));
  assert.ok(!JSON.stringify(report).includes(cwd));
  envelope.observation.artifacts[0].sha256 = "a".repeat(64);
  envelope.lineage.runId = "other-run";
  assert.equal(collected.lineage.runId, runId);
  assert.deepEqual(collected.observation.artifacts, source().artifacts.map(item => ({ role: item.role, sha256: item.contentSha256 })));
});

for (const field of ["runId", "workUnitId", "attemptId", "runtimeInstanceId"] as const) {
  test(`diagnostic adaptation rejects a different ${field}`, async () => {
    const collected = await collect();
    collected.lineage[field] = `other-${field}`;
    assert.throws(() => adaptLiveExecutionEvidenceForDiagnostics(collected), errorCode("evidence_lineage_mismatch"));
  });
}

const mismatches: [string, string, (value: Collected) => void][] = [
  ["observation time", "evidence_snapshot_changed", value => { value.observedAt = "2026-11-11T00:00:00.000Z"; }],
  ["assessment", "evidence_assessment_invalid", value => { value.observation.assessment = "pass"; }],
  ["evidence kind", "evidence_assessment_invalid", value => { value.observation.evidenceKind = "fixture_replay"; }],
  ["execution status", "evidence_state_mismatch", value => { value.observation.executionStatus = "failed"; }],
  ["effect status", "evidence_state_mismatch", value => { value.observation.effectStatus = "unknown"; }],
  ["stop reason", "evidence_state_mismatch", value => { value.observation.stopReason = "other_reason"; }],
  ["comparison", "evidence_input_mismatch", value => { value.observation.comparison.model = "other-model"; }],
  ["artifact bytes", "evidence_artifact_digest_mismatch", value => { value.observation.artifacts[0].sha256 = "a".repeat(64); }],
  ["artifact role", "evidence_artifact_digest_mismatch", value => { value.observation.artifacts[0].role = "other-role"; }],
  ["missing artifact", "invalid_manifest", value => { value.observation.artifacts = []; }],
  ["source limitation", "evidence_state_mismatch", value => {
    value.observation.limitations = value.observation.limitations.filter((item: string) => item !== "attempt_artifact_binding_unavailable");
  }],
  ["grade limitation", "evidence_state_mismatch", value => {
    value.observation.limitations = value.observation.limitations.filter((item: string) => item !== "no_evaluation_grade");
  }],
  ["claimed timing", "evidence_state_mismatch", value => { value.observation.timings.executionMs = 1; }],
  ["claimed usage", "evidence_state_mismatch", value => {
    value.observation.usage = [{ requestId: "request-diagnostics", scope: "task", status: "known", amount: 1, currency: "USD", source: "caller" }];
  }],
  ["private source field", "invalid_manifest", value => { Object.assign(value.source, { claimToken: "PRIVATE_CLAIM" }); }],
  ["extra envelope field", "invalid_manifest", value => { Object.assign(value, { authority: true }); }],
];
for (const [name, code, mutate] of mismatches) {
  test(`diagnostic adaptation rejects mismatched ${name}`, async () => {
    const collected = await collect();
    mutate(collected);
    assert.throws(() => adaptLiveExecutionEvidenceForDiagnostics(collected), errorCode(code));
  });
}

test("F4 keeps its independent Run and WorkUnit join checks after adaptation", async () => {
  const envelope = adaptLiveExecutionEvidenceForDiagnostics(await collect());
  for (const scope of [{ runId: "other-run", workUnitId }, { runId, workUnitId: "other-work-unit" }]) {
    assert.throws(() => linkAssuranceReport(envelope, scope), errorCode("diagnostics_lineage_mismatch"));
  }
});

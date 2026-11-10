import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { adaptExecutionEvidence, loadExecutionEvidence, parseExecutionEvidenceBinding } from "./execution-evidence.mjs";
import { readHarnessDiagnosticsReport } from "./diagnostics.mjs";
import { parseJson } from "./manifest.mjs";

const fixtureRoot = fileURLToPath(new URL("../../fixtures/framework-assurance/execution-evidence/", import.meta.url));
const assurance = adaptExecutionEvidence(
  loadExecutionEvidence(await readFile(`${fixtureRoot}valid.json`)),
  { binding: parseExecutionEvidenceBinding(parseJson(await readFile(`${fixtureRoot}trusted-binding.json`), "trusted execution binding fixture")) },
);
const cwd = "/tmp/ling-diagnostics-fixture";
const runId = "run-fixture-001";
const workUnitId = "work-unit-fixture-001";
const firstObservedAt = "2026-11-09T08:00:00.000Z";
const secondObservedAt = "2026-11-09T08:00:01.000Z";
const clone = value => structuredClone(value);
const errorCode = code => error => error?.code === code;

function checkpoint(domain, updatedAt = firstObservedAt) {
  return { domain, generation: 2, sourceEpoch: 4, builtEpoch: 4, state: "ready", rowCount: 3, isCurrent: true, updatedAt };
}

function record(id, createdAt = firstObservedAt, overrides = {}) {
  return {
    id, runId, workUnitId, revision: 1, createdAt, updatedAt: createdAt,
    kind: "tool_execution", state: "succeeded", attemptId: "attempt-fixture-001",
    toolCallId: `call-${id}`, toolName: "bash", executorKind: "bash",
    policySnapshotArtifactId: "artifact-policy-001", sandboxProfileId: "workspace-write",
    ...overrides,
  };
}

function observation(row, overrides = {}) {
  return {
    record: row,
    leaseStatus: "terminal_retained",
    attempts: [{
      id: row.attemptId,
      status: "observed",
      workUnitId,
      runtimeInstanceId: "runtime-fixture-001",
      fencingToken: "fence-fixture-001",
      attemptStatus: "succeeded",
    }],
    ...overrides,
  };
}

function response(items, {
  observedAt = firstObservedAt,
  nextCursor,
  status = "available",
  responseRunId = runId,
  omitRunId = false,
  includePrivateFields = false,
} = {}) {
  const body = {
    schemaVersion: 1, cwd, workUnitId, status, observedAt,
    ...(omitRunId ? {} : { runId: responseRunId }),
    items,
    projectionCheckpoints: status === "available" ? ["continuation", "tool_execution", "evaluation", "delegation"].map(domain => checkpoint(domain, observedAt)) : [],
    ...(nextCursor ? { nextCursor } : {}),
  };
  if (includePrivateFields) body.items[0].record.claimToken = "PRIVATE_CLAIM";
  return body;
}

test("reads paginated diagnostics, preserves per-page observation times, and joins one F3 lineage", async () => {
  const first = observation(record("diag-001"));
  const second = observation(record("diag-002", "2026-11-09T07:59:59.000Z"));
  const calls = [];
  const read = async (requestedCwd, requestedWorkUnitId, query) => {
    calls.push({ requestedCwd, requestedWorkUnitId, query });
    if (calls.length === 1) {
      return response([first], { nextCursor: { runId, workUnitId, createdAt: first.record.createdAt, kind: first.record.kind, id: first.record.id } });
    }
    return response([second], { observedAt: secondObservedAt });
  };
  const report = await readHarnessDiagnosticsReport({ cwd, workUnitId, runId, limit: 1, read, assurance });
  assert.equal(report.kind, "harness_diagnostics_report");
  assert.equal(report.status, "available");
  assert.equal(report.pageCount, 2);
  assert.equal(report.items.length, 2);
  assert.deepEqual(calls, [
    { requestedCwd: cwd, requestedWorkUnitId: workUnitId, query: { limit: 1 } },
    {
      requestedCwd: cwd,
      requestedWorkUnitId: workUnitId,
      query: { limit: 1, cursor: { runId, workUnitId, createdAt: first.record.createdAt, kind: first.record.kind, id: first.record.id } },
    },
  ]);
  assert.deepEqual(report.pages.map(page => page.observedAt), [firstObservedAt, secondObservedAt]);
  assert.equal(report.observedAt, secondObservedAt);
  assert.equal(report.assurance.lineage.runId, runId);
  assert.equal(report.assurance.observation.assessment, "not_assessed");
  assert.equal(report.cwdSha256.length, 64);
  assert.ok(!JSON.stringify(report).includes(cwd));
  assert.ok(!JSON.stringify(report).includes("claimToken"));
  assert.ok(report.limitations.includes("per_page_observation_only"));
});

for (const status of ["run_unlinked", "run_missing", "lineage_mismatch"]) {
  test(`cold or broken lineage status ${status} is reported without another read`, async () => {
    let calls = 0;
    const report = await readHarnessDiagnosticsReport({
      cwd, workUnitId, runId,
      read: async () => {
        calls += 1;
        return response([], { status, omitRunId: status === "run_unlinked" });
      },
    });
    assert.equal(calls, 1);
    assert.equal(report.status, status);
    assert.equal(report.items.length, 0);
    assert.equal(report.pageCount, 1);
    assert.equal(report.projectionCheckpoints.length, 0);
    assert.ok(report.limitations.includes("diagnostics_unavailable"));
  });
}

test("lineage mismatch in the F3 report is rejected before it is attached", async () => {
  const wrong = clone(assurance);
  wrong.lineage.runId = "run-sibling-001";
  await assert.rejects(readHarnessDiagnosticsReport({
    cwd, workUnitId, runId,
    read: async () => response([]),
    assurance: wrong,
  }), errorCode("diagnostics_lineage_mismatch"));
});

test("cold workspace and client errors become safe unavailable reports without retry or Store initialization", async () => {
  const calls = [];
  const report = await readHarnessDiagnosticsReport({
    cwd, workUnitId, runId,
    now: () => firstObservedAt,
    read: async () => {
      calls.push("read");
      const error = new Error("PRIVATE_WORKSPACE_PATH");
      error.code = "harness_workspace_uninitialized";
      throw error;
    },
  });
  assert.deepEqual(calls, ["read"]);
  assert.equal(report.status, "workspace_uninitialized");
  assert.equal(report.runId, runId);
  assert.equal(report.pageCount, 0);
  assert.equal(report.items.length, 0);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_WORKSPACE_PATH"));

  const missing = await readHarnessDiagnosticsReport({
    cwd, workUnitId, runId,
    now: () => secondObservedAt,
    read: async () => { const error = new Error("private"); error.code = "work_unit_not_found"; throw error; },
  });
  assert.equal(missing.status, "not_found");
});

test("duplicate pages, stalled cursors and foreign rows cannot become a report", async () => {
  const row = observation(record("diag-duplicate"));
  await assert.rejects(readHarnessDiagnosticsReport({
    cwd, workUnitId, runId,
    read: async () => response([row], { nextCursor: { runId, workUnitId, createdAt: row.record.createdAt, kind: row.record.kind, id: row.record.id } }),
    maxPages: 2,
  }), errorCode("diagnostics_pagination_stalled"));

  let page = 0;
  await assert.rejects(readHarnessDiagnosticsReport({
    cwd, workUnitId, runId,
    read: async () => {
      page += 1;
      return response([row], { nextCursor: page === 1 ? { runId, workUnitId, createdAt: row.record.createdAt, kind: row.record.kind, id: row.record.id } : undefined });
    },
  }), errorCode("diagnostics_duplicate_record"));

  const foreign = observation(record("diag-foreign"));
  foreign.record.runId = "run-sibling-001";
  await assert.rejects(readHarnessDiagnosticsReport({ cwd, workUnitId, runId, read: async () => response([foreign]) }), errorCode("diagnostics_scope_mismatch"));
});

test("unexpected sensitive fields are rejected instead of copied into a public report", async () => {
  await assert.rejects(readHarnessDiagnosticsReport({
    cwd, workUnitId, runId,
    read: async () => response([observation(record("diag-private"))], { includePrivateFields: true }),
  }), errorCode("diagnostics_invalid_response"));
});

test("invalid page size and incomplete checkpoint data fail closed", async () => {
  await assert.rejects(readHarnessDiagnosticsReport({ cwd, workUnitId, runId, limit: 0, read: async () => response([]) }), errorCode("diagnostics_invalid_query"));
  await assert.rejects(readHarnessDiagnosticsReport({
    cwd, workUnitId, runId,
    read: async () => ({ ...response([]), projectionCheckpoints: [] }),
  }), errorCode("diagnostics_invalid_response"));
});

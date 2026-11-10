import assert from "node:assert/strict";
import test from "node:test";
import { terminalReportVerificationExpectation as classify } from "../dist/features/channels/terminal-report-verification-expectation.js";
import { projectTerminalReportDto } from "../dist/features/channels/terminal-report-routes.js";

const snapshot = { id: "snapshot", evidenceFingerprint: "hash", workspaceId: "workspace", turnId: "turn", source: { kind: "run", id: "run" }, checks: [] };
const report = { evidenceSnapshotId: "snapshot", evidenceFingerprint: "hash", workspaceId: "workspace", source: snapshot.source };
const declaration = { id: "not-run", title: "Testing", status: "not_run", sourceRefs: [{ kind: "turn", id: "turn", visibility: "conversation" }] };

test("Host marks own-request non-execution as informational without reading model prose", () => {
  const check = { ...declaration };
  Object.defineProperty(check, "summary", { get() { throw Error("Prose must not determine expectation"); } });
  assert.equal(classify(check, report, snapshot), "informational");
});
test("missing planned checks retain evidence-backed attention even beside a declaration", () => {
  const check = { ...declaration, sourceRefs: [{ kind: "check", id: "required", visibility: "conversation" }] };
  assert.equal(classify(check, report, { ...snapshot, checks: [{ id: "required", status: "not_run" }] }), "evidence_backed");
  assert.equal(classify(declaration, report, { ...snapshot, checks: [{ id: "required", status: "not_run" }] }), "informational");
});
test("unbound, mismatched, foreign, command-bearing or ambiguous declarations stay unknown", () => {
  assert.equal(classify(declaration, report), "unknown");
  for (const overrides of [{ id: "foreign" }, { evidenceFingerprint: "wrong" }, { workspaceId: "other" }, { source: { kind: "run", id: "other" } }])
    assert.equal(classify(declaration, report, { ...snapshot, ...overrides }), "unknown");
  for (const overrides of [{ status: "failed" }, { status: "unknown" }, { command: "node --test" }, { sourceRefs: [] }, { sourceRefs: [{ kind: "turn", id: "foreign" }] }])
    assert.equal(classify({ ...declaration, ...overrides }, report, snapshot), "unknown");
});
test("DTO overwrites a model-supplied expectation and does not mutate history", () => {
  const input = { ...report, outcome: { sourceRefs: [], corrections: [] }, changes: [], verification: [{ ...declaration, expectation: "informational", command: "node --test" }], participants: [], artifacts: [], risks: [], references: [], synthesis: {} };
  assert.equal(projectTerminalReportDto(input, snapshot).verification[0].expectation, "unknown");
  assert.equal(input.verification[0].expectation, "informational");
});

import assert from "node:assert/strict";
import test from "node:test";
import { digestRunEvaluationValue } from "@ling-stack/core";
import type { AssuranceEvaluationAssociationResult, AssuranceEvaluationReadPorts, FrozenInputKey }
  from "../src/features/harness/evaluations/assurance-association-contract.js";
import { projectAssuranceEvaluationAssociation } from "../dist/features/harness/evaluations/assurance-association.js";
import { assuranceAssociationFixture, associationNow, associationSha256 } from "./support/assurance-evaluation-association-fixture.ts";

type Fixture = ReturnType<typeof assuranceAssociationFixture>;
const codes = (result: AssuranceEvaluationAssociationResult) => result.diagnostics.map(item => item.code);
function authority(result: AssuranceEvaluationAssociationResult): void {
  assert.equal(result.authority, "report-only");
  assert.equal(result.assessment, "not_assessed");
  assert.equal(result.enforcementAuthorized, false);
  assert.deepEqual(result.attemptBinding, { status: "unavailable", code: "association.attempt_binding_unavailable" });
  assert.ok(codes(result).includes("association.attempt_binding_unavailable"));
}
function refused(f: Fixture, code: string, ports: AssuranceEvaluationReadPorts = f.ports): AssuranceEvaluationAssociationResult {
  const result = projectAssuranceEvaluationAssociation(ports, f.request);
  authority(result);
  assert.notEqual(result.status, "matched");
  assert.ok(codes(result).includes(code as typeof result.diagnostics[number]["code"]), JSON.stringify(result));
  assert.deepEqual(result.grades, []);
  assert.deepEqual(result.binding, { run: "unavailable", frozenInputs: "unavailable", candidateArtifact: "unavailable" });
  return result;
}

test("matches exact evaluation and grade pins using independent frozen bytes and Host facts", () => {
  const f = assuranceAssociationFixture(), before = JSON.stringify(f);
  const evaluationReads: string[] = [], gradeReads: string[] = [];
  const result = projectAssuranceEvaluationAssociation({ ...f.ports,
    getRunEvaluation(id) { evaluationReads.push(id); return f.ports.getRunEvaluation(id); },
    getRunEvaluationGrade(id) { gradeReads.push(id); return f.ports.getRunEvaluationGrade(id); },
  }, f.request);
  authority(result);
  assert.equal(result.status, "matched", JSON.stringify(result));
  assert.deepEqual(result.binding, { run: "matched", frozenInputs: "matched", candidateArtifact: "matched" });
  assert.equal(result.evaluation?.id, f.evaluation.id);
  assert.equal(result.grades[0]?.gradeId, f.grade.id);
  assert.equal(result.grades[0]?.verdict, "pass");
  assert.ok(evaluationReads.length >= 2 && evaluationReads.every(id => id === f.request.evaluationId));
  assert.ok(gradeReads.length >= 2 && gradeReads.every(id => id === f.request.gradePins[0].gradeId));
  assert.equal(JSON.stringify(f), before, "reading does not change inputs or stored declarations");
  for (const privateValue of ["PRIVATE_CANDIDATE_BODY", "sealedPayload", "claimToken", "fencingToken", ".json"])
    assert.ok(!JSON.stringify(result).includes(privateValue));
});

for (const verdict of ["pass", "fail", "abstain", "error"] as const) {
  test(`a completed evaluation preserves ${verdict} without grading or authorizing the observation`, () => {
    const f = assuranceAssociationFixture();
    Object.assign(f.grade, { verdict }); f.repinGrade();
    const result = projectAssuranceEvaluationAssociation(f.ports, f.request);
    assert.equal(result.status, "matched", JSON.stringify(result));
    assert.equal(result.grades[0]?.verdict, verdict); authority(result);
  });
}
for (const state of ["queued", "claimed", "grading", "failed", "cancelled"] as const) {
  test(`evaluation state ${state} stays incomplete and never triggers recovery`, () => {
    const f = assuranceAssociationFixture();
    Object.assign(f.evaluation, { state, completedAt: undefined });
    const result = refused(f, "association.evaluation_incomplete");
    assert.equal(result.status, "incomplete"); assert.equal(result.evaluation?.state, state);
  });
}

test("empty grade selection stays explicit and does not discover a replacement", () => {
  const f = assuranceAssociationFixture(); Object.assign(f.request, { gradePins: [] });
  const result = projectAssuranceEvaluationAssociation({ ...f.ports, getRunEvaluationGrade() { assert.fail("grade was not selected"); } }, f.request);
  assert.equal(result.status, "matched", JSON.stringify(result));
  assert.deepEqual(result.grades, []); assert.ok(codes(result).includes("association.grades_not_selected")); authority(result);
});

const mutations: [string, string, (f: Fixture) => void][] = [
  ["mapping digest", "association.mapping_mismatch", f => { Object.assign(f.request, { mappingDigest: "a".repeat(64) }); }],
  ["evaluation key", "association.evaluation_identity_mismatch", f => { Object.assign(f.request, { evaluationKey: `run-evaluation:${"a".repeat(64)}` }); }],
  ["Run identity", "association.lineage_mismatch", f => { Object.assign(f.host.execution, { runId: "foreign" }); }],
  ["WorkUnit identity", "association.lineage_mismatch", f => { Object.assign(f.host.execution, { workUnitId: "foreign" }); }],
  ["request Run status", "association.invalid_request", f => { Object.assign(f.request.source.execution, { runStatus: "waiting_for_input" }); }],
  ["Host Run status", "association.host_source_unavailable", f => { Object.assign(f.host.execution, { runStatus: "waiting_for_input" }); }],
  ...["attemptId", "runtimeInstanceId", "fencingToken"].map(field => [field, "association.stale_attempt", (f: Fixture) => {
    Object.assign(f.host.execution, { [field]: "stale" });
  }] as [string, string, (f: Fixture) => void]),
  ...["run", "workUnit", "attempt"].flatMap(field => ["revision", "sha256"].map(key => [
    `${field} ${key}`, "association.snapshot_changed", (f: Fixture) => {
      Object.assign(f.host.snapshots[field as keyof typeof f.host.snapshots], { [key]: key === "revision" ? 2 : "a".repeat(64) });
    },
  ] as [string, string, (f: Fixture) => void])),
  ["root lineage", "association.lineage_mismatch", f => { f.runs.set(f.identity.rootRunId, { id: f.identity.rootRunId, status: "succeeded", parentRunId: f.identity.runId }); }],
  ["missing parent", "association.lineage_mismatch", f => { f.runs.delete(f.identity.rootRunId); }],
  ["nonterminal Run", "association.lineage_mismatch", f => { Object.assign(f.runs.get(f.identity.runId)!, { status: "running" }); }],
  ["evaluation Run", "association.evaluation_identity_mismatch", f => { Object.assign(f.evaluation, { runId: "foreign" }); }],
  ["case version", "association.evaluation_identity_mismatch", f => { Object.assign(f.evaluation, { caseVersion: "other" }); }],
  ["baseline version", "association.evaluation_identity_mismatch", f => { Object.assign(f.evaluation, { baselineVersion: "other" }); }],
  ["candidate owner", "association.artifact_invalid", f => { Object.assign(f.artifacts.get(f.identity.candidateArtifactId)!, { runId: f.identity.rootRunId }); }],
  ["candidate body", "association.artifact_invalid", f => { Object.assign(f.artifacts.get(f.identity.candidateArtifactId)!, { sealedPayload: { replacement: true } }); }],
  ["candidate digest", "association.artifact_invalid", f => { Object.assign(f.artifacts.get(f.identity.candidateArtifactId)!, { contentSha256: "a".repeat(64) }); }],
  ["candidate pruned", "association.artifact_missing", f => { Object.assign(f.artifacts.get(f.identity.candidateArtifactId)!, { sealedPayloadState: "pruned" }); }],
  ["candidate missing", "association.artifact_missing", f => { f.artifacts.delete(f.identity.candidateArtifactId); }],
  ["private Host artifact", "association.artifact_invalid", f => { Object.assign(f.artifacts.get(f.identity.candidateArtifactId)!, { contentType: "application/vnd.ling.native-file-mutation-completion+json" }); }],
  ["external owner", "association.artifact_invalid", f => { Object.assign(f.artifacts.get(f.identity.candidateArtifactId)!, { externalWorkId: "external" }); }],
  ["foreign grade", "association.grade_invalid", f => { Object.assign(f.grade, { evaluationId: "foreign" }); }],
  ["grade version", "association.grade_invalid", f => { Object.assign(f.grade, { graderVersion: "other" }); }],
  ["grade digest", "association.grade_invalid", f => { Object.assign(f.grade, { verdict: "fail" }); }],
  ["grade cost", "association.grade_invalid", f => { Object.assign(f.grade, { costAmountMicros: -1 }); f.repinGrade(); }],
  ["unfrozen grade output", "association.grade_invalid", f => { Object.assign(f.grade, { rawOutputArtifactId: "raw" }); f.repinGrade(); }],
  ["raw whitespace", "association.frozen_input_mismatch", f => { f.bundle.ruleBytes = Buffer.concat([f.bundle.ruleBytes, Buffer.from("\n")]); }],
];
for (const [name, code, mutate] of mutations) {
  test(`refuses mismatched ${name}`, () => { const f = assuranceAssociationFixture(); mutate(f); refused(f, code); });
}

test("raw file and sealed JSON digests remain different domains", () => {
  const f = assuranceAssociationFixture(), original = f.artifacts.get(f.identity.caseArtifactId)!;
  const body = original.sealedPayload as Record<string, unknown>;
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal(digestRunEvaluationValue(body), digestRunEvaluationValue(reordered));
  assert.notEqual(associationSha256(JSON.stringify(body)), associationSha256(JSON.stringify(reordered)));
  Object.assign(original, { sealedPayload: reordered }); refused(f, "association.artifact_invalid");
});

test("checks selected grade output byte pins without exposing its body", () => {
  const f = assuranceAssociationFixture(), raw = f.artifact("raw", { details: "PRIVATE_GRADE_BODY" });
  Object.assign(f.grade, { rawOutputArtifactId: raw.id }); f.repinGrade();
  Object.assign(f.request.gradePins[0], { rawOutputArtifact: { artifactId: raw.id, contentSha256: raw.contentSha256! } });
  const result = projectAssuranceEvaluationAssociation(f.ports, f.request);
  assert.equal(result.status, "matched", JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_GRADE_BODY")); authority(result);
});

test("rejects accessor requests before reading a port or invoking the accessor", () => {
  const f = assuranceAssociationFixture(); let getters = 0, reads = 0;
  Object.defineProperty(f.request, "evaluationId", { enumerable: true, get() { getters++; return f.evaluation.id; } });
  refused(f, "association.invalid_request", { ...f.ports, getCurrentHostSource() { reads++; return f.host; }, getFrozenInput() { reads++; return undefined; } });
  assert.equal(getters, 0); assert.equal(reads, 0);
});
test("rejects a Store artifact accessor without invoking it", () => {
  const f = assuranceAssociationFixture(); let calls = 0;
  Object.defineProperty(f.artifacts.get(f.identity.candidateArtifactId)!, "sealedPayload", { enumerable: true, get() { calls++; return {}; } });
  refused(f, "association.artifact_invalid"); assert.equal(calls, 0);
});
test("requires every independent frozen byte input", () => {
  for (const key of Object.keys(assuranceAssociationFixture().bundle) as FrozenInputKey[]) {
    const f = assuranceAssociationFixture();
    refused(f, "association.frozen_input_missing", { ...f.ports, getFrozenInput: requested => requested === key ? undefined : f.bundle[requested] });
  }
});

for (const kind of ["Host", "Run", "evaluation", "grade", "artifact"] as const) {
  test(`clears all matches when ${kind} facts change during the read`, () => {
    const f = assuranceAssociationFixture(); let sourceReads = 0;
    const ports = { ...f.ports, getCurrentHostSource() {
      if (++sourceReads === 2) {
        if (kind === "Host") Object.assign(f.host.snapshots.attempt, { revision: 2 });
        if (kind === "Run") Object.assign(f.runs.get(f.identity.runId)!, { parentRunId: "foreign" });
        if (kind === "evaluation") Object.assign(f.evaluation, { revision: 4 });
        if (kind === "grade") Object.assign(f.grade, { createdAt: "2026-11-11T00:00:01.000Z" });
        if (kind === "artifact") Object.assign(f.artifacts.get(f.identity.candidateArtifactId)!, { sealedPayload: { replacement: true } });
      }
      return f.host;
    } };
    refused(f, "association.snapshot_changed", ports);
  });
}

test("getter errors remain private and never produce partial grade success", () => {
  const f = assuranceAssociationFixture();
  const result = refused(f, "association.read_failed", { ...f.ports, getArtifact() { throw new Error("PRIVATE_SQL_BODY /private/task db failure"); } });
  assert.ok(!JSON.stringify(result).includes("PRIVATE_SQL_BODY"));
  assert.ok(!JSON.stringify(result).includes("/private/task"));
});

test("missing exact evaluation and grade rows stay unavailable", () => {
  const f = assuranceAssociationFixture();
  assert.equal(refused(f, "association.evaluation_missing", { ...f.ports, getRunEvaluation: () => undefined }).status, "unavailable");
  assert.equal(refused(f, "association.grade_missing", { ...f.ports, getRunEvaluationGrade: () => undefined }).status, "unavailable");
  assert.equal(f.evaluation.completedAt, associationNow);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { codeAssessmentHunkLines, parseCodeAssessmentModelOutput, parseCodeAssessmentTarget, parseCodeAssessmentThreatModel, parseCreateCodeAssessment } from "../dist/code-assessments.js";

const snapshot = { id: "snapshot_1", digest: "digest", capturedAt: "2026-11-16T00:00:00Z", target: { type: "working_tree" as const }, files: [{ path: "src/a.ts", kind: "modified" as const, diff: "@@ -1,2 +1,2 @@\n old\n-old\n+new\n", contentDigest: "x", redacted: false }], totalFileCount: 1, coverage: "complete" as const, exclusions: [] };

test("bounded threat models require exact snapshot binding and a strict finite schema", () => {
  const model = { snapshotDigest: snapshot.digest, summary: "Only the shown Diff is available.", assets: ["Caller result"], trustBoundaries: [], attackerControls: [], assumptions: ["Caller context is unavailable."] };
  assert.deepEqual(parseCodeAssessmentThreatModel(JSON.stringify(model), snapshot), model);
  for (const change of [
    { snapshotDigest: "another" }, { summary: "" }, { assets: "result" }, { attackerControls: Array(13).fill("input") },
    { trustBoundaries: ["x".repeat(1001)] }, { assumptions: [42] }, { tools: ["exec"] }, { findings: [] },
  ]) assert.throws(() => parseCodeAssessmentThreatModel(JSON.stringify({ ...model, ...change }), snapshot));
  assert.throws(() => parseCodeAssessmentThreatModel(" ".repeat(64 * 1024 + 1), snapshot), /budget/u);
});

test("assessment target and hunk validation preserve the immutable evidence boundary", () => {
  assert.deepEqual(parseCodeAssessmentTarget({ type: "branch", baseRef: "origin/main" }), { type: "branch", baseRef: "origin/main" });
  assert.deepEqual([...codeAssessmentHunkLines(snapshot.files[0]!.diff, "new")], [1, 2]);
  const parsed = parseCodeAssessmentModelOutput(JSON.stringify({ snapshotDigest: "digest", summary: "Review complete", findings: [{ title: "Changed behavior", body: "The new line changes the result.", severity: "medium", confidence: "high", path: "src/a.ts", side: "new", startLine: 2, endLine: 2, evidence: "new" }] }), snapshot);
  assert.equal(parsed.findings[0]?.path, "src/a.ts");
  assert.throws(() => parseCodeAssessmentModelOutput(JSON.stringify({ snapshotDigest: "other", summary: "x", findings: [] }), snapshot), /snapshot/u);
  assert.throws(() => parseCodeAssessmentModelOutput(JSON.stringify({ snapshotDigest: "digest", summary: "x", findings: [{ title: "x", body: "x", severity: "high", confidence: "high", path: "../secret", side: "new", startLine: 1, endLine: 1, evidence: "x" }] }), snapshot), /outside/u);
});

const finding = { title: "Changed behavior", body: "The new line changes the result.", severity: "medium", confidence: "high", path: "src/a.ts", side: "new", startLine: 2, endLine: 2, evidence: "new" };
const report = (findings: unknown[]) => JSON.stringify({ snapshotDigest: snapshot.digest, summary: "Review complete", findings });

test("findings must quote the selected side and cannot claim uncaptured lines", () => {
  const old = parseCodeAssessmentModelOutput(report([{ ...finding, side: "old", evidence: "old" }]), snapshot);
  assert.equal(old.findings[0]?.side, "old");
  assert.equal(parseCodeAssessmentModelOutput(report([{ ...finding, severity: "info" }]), snapshot).findings[0]?.severity, "info");
  for (const invalid of [
    { evidence: "invented code" },
    { evidence: "+new" },
    { side: "old", evidence: "new" },
    { startLine: 3, endLine: 3 },
    { startLine: 0 },
    { endLine: 23 },
    { severity: "urgent" },
    { confidence: "certain" },
    { cwe: "CWE-not-a-number" },
    { toolCall: "read" },
  ]) {
    assert.throws(() => parseCodeAssessmentModelOutput(report([{ ...finding, ...invalid }]), snapshot));
  }
});

test("report and request budgets reject oversized or extra authority fields", () => {
  assert.throws(() => parseCodeAssessmentModelOutput(report(Array.from({ length: 51 }, () => finding)), snapshot), /50/u);
  assert.throws(() => parseCodeAssessmentModelOutput(" ".repeat(256 * 1024 + 1), snapshot), /budget/u);
  assert.throws(() => parseCodeAssessmentModelOutput(report([{ ...finding, body: "x".repeat(6001) }]), snapshot), /body/u);
  assert.deepEqual(parseCodeAssessmentModelOutput(`\u0060\u0060\u0060json\n${report([])}\n\u0060\u0060\u0060`, snapshot).findings, []);
  assert.throws(() => parseCreateCodeAssessment({ kind: "review", target: { type: "working_tree" }, providerPresetId: "model", tools: ["exec"] }), /Unexpected/u);
  assert.throws(() => parseCodeAssessmentTarget({ type: "working_tree", baseRef: "main" }), /Unexpected/u);
  for (const baseRef of ["--output=bad", "main:secret", "main\nHEAD", "main;cat"]) {
    assert.throws(() => parseCodeAssessmentTarget({ type: "branch", baseRef }));
  }
});

test("commit targets require a full SHA and accept only an optional validated base revision", () => {
  const commitSha = "0123456789ABCDEF0123456789ABCDEF01234567";
  assert.deepEqual(parseCodeAssessmentTarget({ type: "commit", commitSha }), { type: "commit", commitSha: commitSha.toLowerCase() });
  assert.deepEqual(parseCreateCodeAssessment({ kind: "security", target: { type: "commit", commitSha, baseRef: "main~2" }, providerPresetId: "model" }).target,
    { type: "commit", commitSha: commitSha.toLowerCase(), baseRef: "main~2" });
  for (const invalid of [undefined, "", "HEAD", "abc1234", "0".repeat(39), "0".repeat(41), "g".repeat(40), ` ${commitSha}`]) {
    assert.throws(() => parseCodeAssessmentTarget({ type: "commit", commitSha: invalid }), /commitSha/u);
  }
  for (const baseRef of ["", "--output=bad", "main:secret", "main\nHEAD", "main;cat", null]) {
    assert.throws(() => parseCodeAssessmentTarget({ type: "commit", commitSha, baseRef }), /baseRef/u);
  }
  assert.throws(() => parseCodeAssessmentTarget({ type: "commit", commitSha, headSha: commitSha }), /Unexpected/u);
});

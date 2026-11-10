import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDeterministicTerminalReport,
  buildDeterministicTerminalReportContent,
  computeTerminalReportEvidenceFingerprint,
  validateTerminalReportContent,
  validateTerminalReportEvidenceSnapshot,
} from "../dist/index.js";

test("terminal report fallback preserves attempted model provenance without changing evidence", () => {
  const snapshot = buildSnapshot();
  const report = buildDeterministicTerminalReport(snapshot, {
    providerPresetId: "provider_report",
    model: "report-model",
    attemptCount: 2,
    validationCodes: ["terminal_report_schema_invalid"],
  });
  assert.equal(report.status, "fallback");
  assert.equal(report.synthesis.mode, "deterministic_fallback");
  assert.equal(report.synthesis.attemptCount, 2);
  assert.equal(report.synthesis.providerPresetId, "provider_report");
  assert.equal(report.synthesis.model, "report-model");
  assert.deepEqual(report.synthesis.validationCodes, ["terminal_report_schema_invalid"]);
  assert.deepEqual(report.outcome, buildDeterministicTerminalReportContent(snapshot).outcome);
  assert.equal(report.evidenceFingerprint, snapshot.evidenceFingerprint);
  const unattempted = buildDeterministicTerminalReport(snapshot);
  assert.equal(unattempted.synthesis.attemptCount, 0);
  assert.equal(unattempted.synthesis.providerPresetId, undefined);
  assert.equal(unattempted.synthesis.model, undefined);
});

test("terminal report fallback aggregates workflow evidence", () => {
  const snapshot = buildSnapshot();
  const content = buildDeterministicTerminalReportContent(snapshot);

  assert.equal(content.outcome.status, "succeeded");
  assert.equal(content.changes.length, 2);
  assert.deepEqual(content.changes.map((change) => change.paths[0]), ["docs/result.md", "src/index.ts"]);
  assert.equal(content.verification[0]?.status, "passed");
  assert.equal(content.participants.length, 2);
  assert.equal(content.artifacts.length, 2);
  assert.equal(validateTerminalReportContent(content, snapshot).ok, true);
});

test("model synthesis cannot omit or weaken a Host unknown-effect warning", () => {
  const snapshot = buildSnapshot();
  snapshot.terminalState = "failed";
  snapshot.risks = [{ id: "execution-unconfirmed:run_qa:unfinished", severity: "critical", status: "unverified",
    summary: "Process stop and effects are unconfirmed.", sourceRefs: [workflowRef()] }];
  const content = buildDeterministicTerminalReportContent(snapshot);
  assert.equal(validateTerminalReportContent(content, snapshot).ok, true);
  const hostRisk = content.risks[0];
  const reorderedRisk = { sourceRefs: hostRisk.sourceRefs, summary: hostRisk.summary, status: hostRisk.status, severity: hostRisk.severity, id: hostRisk.id };
  assert.equal(validateTerminalReportContent({ ...content, risks: [reorderedRisk] }, snapshot).ok, true);
  for (const risks of [[], [{ ...content.risks[0], status: "mitigated" }], [{ ...content.risks[0], summary: "Definitely stopped." }]]) {
    assert.equal(validateTerminalReportContent({ ...content, risks }, snapshot).ok, false);
  }
});

test("terminal report fallback does not treat artifact storage paths as workspace changes", () => {
  const snapshot = buildSnapshot();
  const content = buildDeterministicTerminalReportContent({
    ...snapshot,
    artifacts: [
      ...snapshot.artifacts,
      {
        id: "artifact_read_content",
        kind: "document",
        title: "read content",
        path: "run_demo/001-read-content.md",
        changedPaths: [],
        sourceRefs: [ref("artifact", "artifact_read_content", "read content")],
      },
    ],
  });

  assert.deepEqual(content.changes.map((change) => change.paths[0]), ["docs/result.md", "src/index.ts"]);
});

test("terminal report validation rejects unsupported verification and participants", () => {
  const snapshot = buildSnapshot();
  const content = buildDeterministicTerminalReportContent(snapshot);
  const invalid = {
    ...content,
    verification: [{
      id: "invented-check",
      title: "Production smoke test",
      status: "passed",
      sourceRefs: [workflowRef()],
    }],
    participants: [{
      agentId: "security",
      displayName: "Security",
      status: "completed",
      contribution: "Reviewed the release.",
      sourceRefs: [workflowRef()],
    }],
  };

  const result = validateTerminalReportContent(invalid, snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "terminal_report_unverified_success_claim"));
  assert.ok(result.issues.some((item) => item.code === "terminal_report_participant_without_activity"));
});

test("terminal report validation rejects a successful checked snapshot without verification", () => {
  const snapshot = buildSnapshot();
  const content = buildDeterministicTerminalReportContent(snapshot);
  const result = validateTerminalReportContent({ ...content, verification: [] }, snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "terminal_report_unverified_success_claim"));
});

test("terminal report validation rejects a model downgrading a passed Host check to unknown", () => {
  const snapshot = buildSnapshot();
  const content = buildDeterministicTerminalReportContent(snapshot);
  const invalid = {
    ...content,
    verification: content.verification.map((item) => ({ ...item, status: "unknown" })),
  };

  const result = validateTerminalReportContent(invalid, snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "terminal_report_unverified_success_claim"));
});

test("terminal report validation requires each visible Host check, not an unrelated unknown row", () => {
  const snapshot = buildSnapshot();
  const content = buildDeterministicTerminalReportContent(snapshot);
  const invalid = {
    ...content,
    verification: [{
      id: "unrelated-command",
      title: "Count command",
      status: "unknown",
      sourceRefs: [snapshot.references.find((ref) => ref.kind === "run" && ref.id === "run_qa")],
    }],
  };

  const result = validateTerminalReportContent(invalid, snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "terminal_report_unverified_success_claim"));
});

test("terminal report validation rejects file refs borrowed from another artifact", () => {
  const snapshot = buildSnapshot();
  const content = buildDeterministicTerminalReportContent(snapshot);
  const docsFileRef = snapshot.artifacts.find((artifact) => artifact.id === "artifact_docs")?.sourceRefs.find((ref) => ref.kind === "file");
  assert.ok(docsFileRef);
  const invalid = {
    ...content,
    artifacts: content.artifacts.map((artifact) => artifact.id === "artifact_code"
      ? { ...artifact, sourceRefs: [...artifact.sourceRefs, docsFileRef] }
      : artifact),
  };

  const result = validateTerminalReportContent(invalid, snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) =>
    item.code === "terminal_report_source_ref_missing" && item.path === "artifacts.0.sourceRefs"
  ));
});

test("terminal report evidence fingerprint detects snapshot mutation", () => {
  const snapshot = buildSnapshot();
  assert.equal(validateTerminalReportEvidenceSnapshot(snapshot).ok, true);

  const mutated = {
    ...snapshot,
    objective: "Changed after fingerprint",
  };
  const result = validateTerminalReportEvidenceSnapshot(mutated);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "terminal_report_fingerprint_mismatch"));
});

test("terminal report evidence fingerprint ignores observation identity and timestamp", () => {
  const snapshot = buildSnapshot();
  const repeatedObservation = {
    ...snapshot,
    id: "snapshot_recollected_after_reconnect",
    generatedAt: "2026-07-11T00:20:01.000Z",
  };

  assert.equal(
    computeTerminalReportEvidenceFingerprint(repeatedObservation),
    snapshot.evidenceFingerprint,
  );
  assert.equal(validateTerminalReportEvidenceSnapshot(repeatedObservation).ok, true);
});

test("terminal report fallback builds a complete validated report envelope", () => {
  const snapshot = buildSnapshot();
  const report = buildDeterministicTerminalReport(snapshot, {
    id: "terminal_report_fallback_test",
    committedAt: "2026-07-11T00:10:01.000Z",
  });
  assert.equal(report.status, "fallback");
  assert.equal(report.synthesis.mode, "deterministic_fallback");
  assert.equal(validateTerminalReportContent(report, snapshot).ok, true);
});

test("terminal report fallback compacts harness-wrapped objectives for the visible title", () => {
  const snapshot = buildSnapshot();
  const report = buildDeterministicTerminalReport({
    ...snapshot,
    objective: "**这条用户消息是一个多参与者可执行 workflow。 原始请求: @Engineer @QA 完成 retry 小项目；Engineer 创建 retry-once.cjs。 Requested objective from current message objective: full harness transcript No literal file content was supplied.**",
  });

  assert.equal(report.outcome.title, "@Engineer @QA 完成 retry 小项目；Engineer 创建 retry-once.cjs。");
  assert.doesNotMatch(report.outcome.title, /Requested objective|No literal file content|workflow transcript/u);
});

function buildSnapshot() {
  const workflow = workflowRef();
  const runEngineer = ref("run", "run_engineer", "Engineer run");
  const runQa = ref("run", "run_qa", "QA run");
  const check = ref("check", "check_typecheck", "Typecheck");
  const artifactCode = ref("artifact", "artifact_code", "src/index.ts");
  const artifactDocs = ref("artifact", "artifact_docs", "docs/result.md");
  const fileCode = ref("file", "src/index.ts", "src/index.ts");
  const fileDocs = ref("file", "docs/result.md", "docs/result.md");
  const base = {
    schemaVersion: 1,
    id: "snapshot_demo",
    workspaceId: "workspace_default",
    surface: "channel",
    channelId: "channel_demo",
    sourceMessageId: "message_demo",
    source: { kind: "workflow", id: "workflow_demo" },
    objective: "Implement terminal reports",
    language: "en-US",
    terminalState: "succeeded",
    terminalAt: "2026-07-11T00:10:00.000Z",
    steps: [
      {
        id: "step_engineer",
        title: "Implement",
        status: "succeeded",
        teammateId: "engineer",
        runId: "run_engineer",
        resultSummary: "Implemented the report contract.",
        changedPaths: ["src/index.ts", "docs/result.md"],
        artifactIds: ["artifact_code", "artifact_docs"],
        sourceRefs: [workflow, runEngineer, artifactCode, artifactDocs],
      },
      {
        id: "step_qa",
        title: "Verify",
        status: "succeeded",
        teammateId: "qa",
        runId: "run_qa",
        resultSummary: "Typecheck passed.",
        changedPaths: [],
        artifactIds: [],
        sourceRefs: [workflow, runQa, check],
      },
    ],
    operations: [{
      id: "operation_edit",
      kind: "edit",
      title: "Edit terminal report files",
      status: "succeeded",
      runId: "run_engineer",
      teammateId: "engineer",
      changedPaths: ["src/index.ts", "docs/result.md"],
      sourceRefs: [runEngineer, artifactCode, artifactDocs, fileCode, fileDocs],
    }],
    checks: [{
      id: "check_typecheck",
      title: "Typecheck",
      status: "passed",
      command: "pnpm typecheck",
      runId: "run_qa",
      sourceRefs: [runQa, check],
    }],
    participants: [
      {
        agentId: "engineer",
        displayName: "Engineer",
        status: "completed",
        workflowStepIds: ["step_engineer"],
        runIds: ["run_engineer"],
        contributionSummaries: ["Implemented the report contract."],
        sourceRefs: [runEngineer],
      },
      {
        agentId: "qa",
        displayName: "QA",
        status: "completed",
        workflowStepIds: ["step_qa"],
        runIds: ["run_qa"],
        contributionSummaries: ["Verified typecheck."],
        sourceRefs: [runQa, check],
      },
    ],
    artifacts: [
      {
        id: "artifact_code",
        kind: "file",
        title: "src/index.ts",
        path: "src/index.ts",
        changedPaths: ["src/index.ts"],
        sourceRefs: [runEngineer, artifactCode, fileCode],
      },
      {
        id: "artifact_docs",
        kind: "document",
        title: "docs/result.md",
        path: "docs/result.md",
        changedPaths: ["docs/result.md"],
        sourceRefs: [runEngineer, artifactDocs, fileDocs],
      },
    ],
    approvals: [],
    risks: [],
    references: [workflow, runEngineer, runQa, check, artifactCode, artifactDocs, fileCode, fileDocs],
    generatedAt: "2026-07-11T00:10:01.000Z",
  };
  return {
    ...base,
    evidenceFingerprint: computeTerminalReportEvidenceFingerprint(base),
  };
}

function workflowRef() {
  return ref("workflow", "workflow_demo", "Terminal report workflow");
}

function ref(kind, id, label) {
  return { kind, id, label, visibility: "folded_evidence", sensitivity: "normal" };
}

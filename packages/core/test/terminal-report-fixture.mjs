import {
  buildDeterministicTerminalReportContent,
  computeTerminalReportEvidenceFingerprint,
} from "../dist/index.js";

export function buildTerminalReportSnapshot(overrides = {}) {
  const sourceId = overrides.sourceId ?? "run_terminal_report_test";
  const runRef = ref("run", sourceId, "Terminal report test run");
  const checkRef = ref("check", "check_typecheck", "Typecheck");
  const fileRef = ref("file", "src/report.ts", "src/report.ts");
  const base = {
    schemaVersion: 1,
    id: overrides.id ?? "terminal_report_snapshot_test",
    workspaceId: overrides.workspaceId ?? "workspace_default",
    surface: overrides.surface ?? "normal_conversation",
    channelId: overrides.channelId,
    threadId: overrides.threadId,
    turnId: overrides.turnId,
    sourceMessageId: overrides.sourceMessageId,
    source: { kind: overrides.sourceKind ?? "run", id: sourceId },
    objective: overrides.objective ?? "Persist a terminal report",
    language: overrides.language ?? "en-US",
    terminalState: overrides.terminalState ?? "succeeded",
    terminalAt: overrides.terminalAt ?? "2026-07-11T01:05:00.000Z",
    steps: overrides.steps ?? [],
    operations: overrides.operations ?? [{
      id: "operation_edit",
      kind: "edit",
      title: "Edit terminal report store",
      status: "succeeded",
      runId: sourceId,
      teammateId: "engineer",
      changedPaths: ["src/report.ts"],
      sourceRefs: [runRef, fileRef],
    }],
    checks: overrides.checks ?? [{
      id: "check_typecheck",
      title: "Typecheck",
      status: "passed",
      command: "pnpm typecheck",
      summary: "Typecheck passed.",
      runId: sourceId,
      sourceRefs: [runRef, checkRef],
    }],
    participants: overrides.participants ?? [{
      agentId: "engineer",
      displayName: "Engineer",
      roleKey: "engineer",
      status: "completed",
      workflowStepIds: [],
      runIds: [sourceId],
      contributionSummaries: ["Implemented terminal report persistence."],
      sourceRefs: [runRef],
    }],
    artifacts: overrides.artifacts ?? [{
      id: "artifact_report",
      kind: "file",
      title: "src/report.ts",
      path: "src/report.ts",
      changedPaths: ["src/report.ts"],
      status: "updated",
      sourceRefs: [runRef, fileRef],
    }],
    approvals: overrides.approvals ?? [],
    risks: overrides.risks ?? [],
    references: overrides.references ?? [runRef, checkRef, fileRef],
    generatedAt: overrides.generatedAt ?? "2026-07-11T01:05:01.000Z",
  };
  return {
    ...base,
    evidenceFingerprint: computeTerminalReportEvidenceFingerprint(base),
  };
}

export function buildTerminalReport(snapshot, overrides = {}) {
  const status = overrides.status ?? "committed";
  const mode = overrides.mode ?? (status === "fallback" ? "deterministic_fallback" : "model");
  const promptVersion = overrides.promptVersion ?? "terminal-report-v1";
  const attemptCount = overrides.attemptCount ?? 1;
  return {
    schemaVersion: 1,
    id: overrides.id ?? "terminal_report_test",
    workspaceId: snapshot.workspaceId,
    channelId: snapshot.channelId,
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    sourceMessageId: snapshot.sourceMessageId,
    source: snapshot.source,
    status,
    language: snapshot.language,
    evidenceSnapshotId: snapshot.id,
    evidenceFingerprint: snapshot.evidenceFingerprint,
    synthesis: {
      mode,
      promptVersion,
      attemptCount,
      validationCodes: overrides.validationCodes ?? [],
    },
    ...buildDeterministicTerminalReportContent(snapshot),
    createdAt: overrides.createdAt ?? "2026-07-11T01:05:01.000Z",
    committedAt: overrides.committedAt ?? "2026-07-11T01:05:02.000Z",
  };
}

function ref(kind, id, label) {
  return { kind, id, label, visibility: "conversation", sensitivity: "normal" };
}

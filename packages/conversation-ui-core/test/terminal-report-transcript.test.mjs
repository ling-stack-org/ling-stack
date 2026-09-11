import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintConversationTimeline, projectCanonicalConversationTimeline } from "../dist/index.js";

const scope = { surface: "normal", threadId: "thread-1", workspaceId: "workspace-1", depth: 0 };
const report = (id, generation, resultItemId, summary = `summary ${generation}`) => ({
  generation,
  resultItemId,
  report: {
    id,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    turnId: "turn-1",
    source: { kind: "run", id: "run-1" },
    status: "committed",
    evidenceFingerprint: `fp-${generation}`,
    outcome: { status: "succeeded", title: `Done ${generation}`, summary, corrections: [] },
    changes: [], verification: [], participants: [], artifacts: [], risks: [],
    references: [],
  },
});

test("terminal result preserves detailed sections and source lineage", () => {
  const detailed = report("report-details", 1, "result-details", "All checks passed");
  detailed.report.outcome.corrections = [{
    id: "correction-1",
    originalAssumption: "The file was unchanged",
    correctedFact: "The parser was updated",
    confidence: "high",
    sourceRefs: [{ kind: "run_event", id: "event-1" }],
  }];
  detailed.report.changes = [{
    id: "change-1",
    kind: "code",
    title: "Updated parser",
    summary: "Added typed transcript parsing",
    paths: ["src/parser.ts"],
    sourceRefs: [{ kind: "operation", id: "action-1" }],
  }];
  detailed.report.verification = [{
    id: "verify-1",
    title: "Unit tests",
    status: "passed",
    command: "pnpm test",
    sourceRefs: [{ kind: "run_event", id: "event-2" }],
  }];
  detailed.report.participants = [{
    agentId: "agent-1",
    displayName: "Engineer",
    status: "completed",
    contribution: "Implemented the parser",
    sourceRefs: [{ kind: "run", id: "run-1" }],
  }];
  detailed.report.artifacts = [{
    id: "artifact-1",
    kind: "diff",
    title: "Parser diff",
    path: "artifacts/parser.diff",
    sourceRefs: [{ kind: "artifact", id: "artifact-1" }],
  }];
  detailed.report.risks = [{
    id: "risk-1",
    severity: "info",
    status: "mitigated",
    summary: "No remaining risk",
    sourceRefs: [],
  }];
  detailed.report.references = [{ kind: "run", id: "run-1", label: "Primary run" }];
  const projection = projectCanonicalConversationTimeline({
    scope, sourceSequence: 1, sourceRevision: "details",
    items: [item("result-details", 1, "terminal_report", { reportId: "report-details", generation: 1, sourceKind: "run", sourceId: "run-1", evidenceFingerprint: "fp-1", outcomeStatus: "succeeded" })],
    actions: [], turnRuns: [], terminalReports: [detailed],
  });
  const result = projection.items[0];
  assert.equal(result.kind, "terminalReport");
  assert.equal(result.corrections[0].correctedFact, "The parser was updated");
  assert.equal(result.changes[0].paths[0], "src/parser.ts");
  assert.equal(result.verification[0].command, "pnpm test");
  assert.equal(result.participants[0].displayName, "Engineer");
  assert.equal(result.artifacts[0].kind, "diff");
  assert.equal(result.risks[0].status, "mitigated");
  assert.equal(result.references.length, 0);
  assert.equal(result.sourceRefs.some((reference) => reference.kind === "run" && reference.id === "run-1"), true);
});

test("terminal result hides internal artifacts and their conversation references", () => {
  const detailed = report("report-visible-artifacts", 1, "result-visible-artifacts", "Visible result only");
  detailed.report.artifacts = [
    {
      id: "artifact-user-file",
      kind: "file",
      title: "result.ts",
      path: "src/result.ts",
      sourceRefs: [{ kind: "file", id: "src/result.ts", label: "result.ts", path: "src/result.ts", visibility: "conversation" }],
    },
    {
      id: "artifact-metadata",
      kind: "other",
      title: "Generated file metadata: result.ts",
      path: "run-1/generated-file-metadata.txt",
      sourceRefs: [],
    },
    {
      id: "artifact-action-preview",
      kind: "other",
      title: "Action preview: bash",
      path: "run-1/actions/approval-1/preview.json",
      sourceRefs: [],
    },
  ];
  detailed.report.references = [
    { kind: "run", id: "run-1", label: "Ling Agent run", visibility: "conversation" },
    { kind: "artifact", id: "artifact-user-file", label: "result.ts", path: "src/result.ts", visibility: "conversation" },
    { kind: "artifact", id: "artifact-metadata", label: "Generated file metadata: result.ts", visibility: "conversation" },
    { kind: "artifact", id: "artifact-action-preview", label: "Action preview: bash", visibility: "conversation" },
  ];

  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "visible-artifacts",
    items: [item("result-visible-artifacts", 1, "terminal_report", {
      reportId: "report-visible-artifacts",
      generation: 1,
      sourceKind: "run",
      sourceId: "run-1",
      evidenceFingerprint: "fp-1",
      outcomeStatus: "succeeded",
    })],
    actions: [],
    turnRuns: [],
    terminalReports: [detailed],
  });

  const result = projection.items[0];
  assert.equal(result.kind, "terminalReport");
  assert.equal(result.artifactCount, 1);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.id), ["artifact-user-file"]);
  assert.deepEqual(result.references.map((reference) => reference.id), ["artifact-user-file"]);
  assert.equal(result.sourceRefs.some((reference) => reference.kind === "run" && reference.id === "run-1"), true);
});

test("terminal result hides internal run artifact paths from visible changes", () => {
  const detailed = report("report-visible-changes", 1, "result-visible-changes", "Visible workspace changes only");
  detailed.report.changes = [
    {
      id: "change-mixed",
      kind: "code",
      title: "Updated parser",
      summary: "Changed the workspace file and captured internal evidence",
      paths: ["src/parser.ts", "run-1/001-read-content.md"],
      sourceRefs: [{ kind: "run", id: "run-1", visibility: "folded_evidence" }],
    },
    {
      id: "change-internal-only",
      kind: "other",
      title: "Captured execution output",
      summary: "Internal evidence storage only",
      paths: ["run-1/unified-exec-stdout.txt"],
      sourceRefs: [{ kind: "run", id: "run-1", visibility: "folded_evidence" }],
    },
  ];

  const projection = projectCanonicalConversationTimeline({
    scope,
    sourceSequence: 1,
    sourceRevision: "visible-changes",
    items: [item("result-visible-changes", 1, "terminal_report", {
      reportId: "report-visible-changes",
      generation: 1,
      sourceKind: "run",
      sourceId: "run-1",
      evidenceFingerprint: "fp-1",
      outcomeStatus: "succeeded",
    })],
    actions: [],
    turnRuns: [],
    terminalReports: [detailed],
  });

  const result = projection.items[0];
  assert.equal(result.kind, "terminalReport");
  assert.equal(result.changeCount, 1);
  assert.deepEqual(result.changes.map((change) => change.id), ["change-mixed"]);
  assert.deepEqual(result.changes[0].paths, ["src/parser.ts"]);
});
const item = (id, sequence, kind, payload) => ({
  id, workspaceId: "workspace-1", threadId: "thread-1", turnId: "turn-1", sequence,
  kind, status: "committed", actorType: kind === "terminal_report" ? "system" : "ling_agent",
  revision: 0, payload, domainRefs: [],
});

test("terminal result ref normalization never downgrades duplicate privacy markers", () => {
  const privateRef = { kind: "file", id: "src/shared.ts", path: "src/shared.ts", visibility: "folded_evidence", sensitivity: "private" };
  const publicRef = { ...privateRef, visibility: "conversation", sensitivity: "normal" };
  for (const refs of [[privateRef, publicRef], [publicRef, privateRef]]) {
    const detailed = report("report-policy", 1, "result-policy");
    detailed.report.references = refs;
    const projection = projectCanonicalConversationTimeline({
      scope, sourceSequence: 1, sourceRevision: "privacy", actions: [], turnRuns: [],
      items: [item("result-policy", 1, "terminal_report", { reportId: "report-policy", generation: 1,
        sourceKind: "run", sourceId: "run-1", evidenceFingerprint: "fp-1", outcomeStatus: "succeeded" })],
      terminalReports: [detailed],
    });
    const ref = projection.items[0].references.find((entry) => entry.id === privateRef.id);
    assert.equal(ref.visibility, "folded_evidence");
    assert.equal(ref.sensitivity, "private");
  }
});

test("execute turn keeps the agent final and appends one terminal fact result", () => {
  const projection = projectCanonicalConversationTimeline({
    scope, sourceSequence: 4, sourceRevision: "r1",
    items: [
      item("user-1", 1, "user_message", { body: "run it", format: "markdown" }),
      item("summary-1", 2, "assistant_message", { body: "I finished it", format: "markdown", streaming: false, deliveryStatus: "ready", presentationRole: "reply_result" }),
      item("result-1", 3, "terminal_report", { reportId: "report-1", generation: 1, sourceKind: "run", sourceId: "run-1", evidenceFingerprint: "fp-1", outcomeStatus: "succeeded" }),
    ],
    actions: [], turnRuns: [], terminalReports: [report("report-1", 1, "result-1")],
  });
  assert.deepEqual(projection.items.map((entry) => entry.kind), ["userMessage", "agentMessage", "terminalReport"]);
  assert.equal(projection.items[2].resultItemId, "result-1");
  assert.deepEqual(fingerprintConversationTimeline(projection.items).rendererKeys, ["message.document", "message.document", "result.terminal"]);
});

test("only highest committed generation is visible", () => {
  const projection = projectCanonicalConversationTimeline({
    scope, sourceSequence: 3, sourceRevision: "r2",
    items: [
      item("user-1", 1, "user_message", { body: "retry", format: "markdown" }),
      item("result-2", 2, "terminal_report", { reportId: "report-2", generation: 2, sourceKind: "run", sourceId: "run-1", evidenceFingerprint: "fp-2", outcomeStatus: "succeeded" }),
    ],
    actions: [], turnRuns: [], terminalReports: [report("report-1", 1, "result-1"), report("report-2", 2, "result-2")],
  });
  assert.deepEqual(projection.items.map((entry) => entry.kind), ["userMessage", "terminalReport"]);
  assert.equal(projection.items[1].generation, 2);
  assert.equal(projection.diagnostics.length, 0);
});

test("highest generation without its exact result Item fails closed", () => {
  const projection = projectCanonicalConversationTimeline({
    scope, sourceSequence: 1, sourceRevision: "r3",
    items: [item("user-1", 1, "user_message", { body: "run", format: "markdown" })],
    actions: [], turnRuns: [], terminalReports: [report("report-3", 3, "missing-result")],
  });
  assert.deepEqual(projection.items.map((entry) => entry.kind), ["userMessage"]);
  assert.equal(projection.diagnostics.some((diagnostic) => diagnostic.code === "missing_anchor"), true);
});

test("run artifacts attach to their owning atomic action as dedicated Host refs", () => {
  const projection = projectCanonicalConversationTimeline({
    scope, sourceSequence: 1, sourceRevision: "artifact-ref",
    items: [item("tool-1", 1, "tool_call", { toolName: "dynamic_tool", inputSummary: "Generate report" })],
    actions: [{
      id: "action-1",
      revision: 1,
      workspaceId: "workspace-1",
      threadId: "thread-1",
      turnId: "turn-1",
      runId: "run-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      participantId: "agent-1",
      workflowStepId: null,
      actionType: "dynamic_tool",
      status: "succeeded",
      title: "Generated report",
      sourceRefs: [
        { kind: "conversation_item", id: "tool-1" },
        { kind: "run_event", id: "event-1" },
      ],
      resultArtifactIds: ["artifact-1"],
    }],
    artifacts: [{
      id: "artifact-1",
      revision: 1,
      workspaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      actionId: "action-1",
      anchorItemId: "tool-1",
      type: "markdown",
      path: "reports/result.md",
      title: "Result report",
      sourceRefs: [{ kind: "run_event", id: "event-2" }],
    }],
    turnRuns: [{ runId: "run-1", turnId: "turn-1", attemptNumber: 1, role: "primary" }],
  });
  const action = projection.items.find((entry) => entry.id === "action:action-1");
  assert.equal(action.kind, "dynamicToolCall");
  assert.deepEqual(action.sourceRefs.find((ref) => ref.id === "artifact-1"), {
    kind: "artifact",
    id: "artifact-1",
    label: "Result report",
    path: "reports/result.md",
    hostTarget: "open_artifact",
    workspaceId: "workspace-1",
  });
});

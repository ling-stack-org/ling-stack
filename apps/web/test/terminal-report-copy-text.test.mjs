import assert from "node:assert/strict";
import test from "node:test";
import { terminalReportCopyText } from "../src/shared/conversation/timeline/terminal-report-copy-text.ts";

function report(overrides = {}) {
  return {
    id: "INTERNAL_ITEM_ID", kind: "terminalReport", reportId: "INTERNAL_REPORT_ID",
    resultItemId: "INTERNAL_RESULT_ID", generation: 7, revision: 3,
    threadSequence: 4, partIndex: 0, status: "succeeded", outcomeStatus: "succeeded",
    turnId: "INTERNAL_TURN_ID", runId: "INTERNAL_RUN_ID", attemptId: "INTERNAL_ATTEMPT_ID",
    participantId: "INTERNAL_PARTICIPANT_ID", title: "Delivery complete", summary: "The final result.",
    changeCount: 0, verificationCount: 0, participantCount: 0, artifactCount: 0, riskCount: 0,
    corrections: [], changes: [], verification: [], participants: [], artifacts: [], risks: [],
    references: [{ kind: "file", id: "PRIVATE_REFERENCE_ID", label: "PRIVATE_REFERENCE_LABEL" }],
    sourceRefs: [{ kind: "run", id: "PRIVATE_SOURCE_ID" }],
    ...overrides,
  };
}

function forbidReads(value, keys) {
  for (const key of keys) Object.defineProperty(value, key, {
    configurable: true,
    get() { throw new Error(`Forbidden read: ${key}`); },
  });
  return value;
}

test("copy omits restricted content in every report section, including mixed refs", () => {
  for (const policy of [
    { visibility: "developer_only" }, { visibility: "audit" }, { visibility: "private" },
    { visibility: "folded_evidence", sensitivity: "secret_adjacent" },
  ]) {
    const sourceRefs = [
      { kind: "file", id: "public", visibility: "conversation" },
      { kind: "file", id: "restricted", ...policy },
    ];
    const sentinel = "PRIVACY_SENTINEL";
    const text = terminalReportCopyText(report({
      corrections: [{ correctedFact: sentinel, originalAssumption: sentinel, confidence: "high", sourceRefs }],
      changes: [{ title: sentinel, summary: sentinel, paths: [sentinel], kind: "code", sourceRefs }],
      verification: [{ title: sentinel, summary: sentinel, command: sentinel, status: "passed", sourceRefs }],
      participants: [{ displayName: sentinel, contribution: sentinel, status: "blocked", sourceRefs }],
      artifacts: [{ id: "artifact", title: sentinel, path: sentinel, summary: sentinel, kind: "file", sourceRefs }],
      risks: [{ summary: sentinel, nextAction: sentinel, severity: "warning", status: "unresolved", sourceRefs }],
    }));
    assert.match(text, /The final result/u);
    assert.doesNotMatch(text, /PRIVACY_SENTINEL/u);
  }
});

test("only terminal reports can produce copy text, including partial and failed outcomes", () => {
  for (const status of [undefined, "pending", "running", "waiting"]) {
    const item = forbidReads(report({ status }), ["title", "summary", "changes"]);
    assert.equal(terminalReportCopyText(item), "");
  }
  for (const status of ["succeeded", "failed", "cancelled", "blocked"]) {
    assert.match(terminalReportCopyText(report({ status })), /The final result\./u);
  }
  assert.match(terminalReportCopyText(report({ status: "blocked", outcomeStatus: "partially_succeeded" })), /The final result\./u);
});

test("copy contains every visible report section without source ids or duplicate outcome prose", () => {
  const item = report({
    corrections: [{ id: "CORRECTION_ID", correctedFact: "Uses SQLite", originalAssumption: "Expected MySQL", confidence: "high", sourceRefs: [] }],
    changes: [{ id: "CHANGE_ID", kind: "code", title: "Fix ownership", summary: "Only the current owner is included.", paths: ["src/owner.ts", "test/owner.test.mjs"], addedLines: 4, deletedLines: 2, sourceRefs: [] }],
    verification: [{ id: "CHECK_ID", title: "Owner test", status: "passed", summary: "All assertions passed.", command: "node --test test/owner.test.mjs", durationMs: 1250, sourceRefs: [] }],
    participants: [
      { agentId: "AGENT_A_ID", displayName: "Engineer", roleKey: "implementation", status: "completed", contribution: "Implemented the change.", sourceRefs: [] },
      { agentId: "AGENT_B_ID", displayName: "QA", roleKey: "verification", status: "completed", contribution: "Verified the result.", sourceRefs: [] },
    ],
    artifacts: [{ id: "ARTIFACT_ID", kind: "document", title: "Usage notes", summary: "Updated instructions.", path: "docs/usage.md", href: "https://not-displayed.invalid/INTERNAL_URL", addedLines: 3, deletedLines: 0, sourceRefs: [] }],
    risks: [{ id: "RISK_ID", severity: "warning", status: "unresolved", summary: "Production not verified", nextAction: "Run the production smoke test.", approvalDecision: "pending", sourceRefs: [] }],
  });
  const text = terminalReportCopyText(item);
  for (const value of ["Delivery complete", "The final result.", "Corrections", "Uses SQLite", "Previously: Expected MySQL", "high", "Changes", "Fix ownership", "Only the current owner is included.", "src/owner.ts", "test/owner.test.mjs", "code · +4 · -2", "Verification", "Owner test", "passed · 1.3s", "All assertions passed.", "node --test test/owner.test.mjs", "Agents", "Engineer", "implementation · completed", "Implemented the change.", "QA", "Verified the result.", "Artifacts", "Usage notes", "Updated instructions.", "docs/usage.md", "document · +3 · -0", "Risks", "Production not verified", "warning · unresolved · pending", "Run the production smoke test."]) {
    assert.ok(text.includes(value), `Missing visible value: ${value}`);
  }
  assert.equal(text.split("The final result.").length - 1, 1);
  assert.doesNotMatch(text, /(?:INTERNAL|PRIVATE|CORRECTION_ID|CHANGE_ID|CHECK_ID|AGENT_[AB]_ID|ARTIFACT_ID|RISK_ID|generation|Sources)/u);
});

test("copy preserves complete Markdown paragraphs and safely fences visible commands", () => {
  const summary = "First paragraph.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\nLast paragraph.";
  const command = "printf '```'\nnode --test";
  const text = terminalReportCopyText(report({ summary, verification: [{ id: "check", title: "Script", status: "passed", command, sourceRefs: [] }] }));
  assert.ok(text.includes(summary));
  assert.ok(text.includes(`\n\n\`\`\`\`sh\n${command}\n\`\`\`\``));
  assert.equal(terminalReportCopyText(report({ title: "", summary, })), summary);
});

test("participant copy follows the renderer visibility rule", () => {
  const participant = { agentId: "INTERNAL_AGENT", displayName: "Sole agent", status: "completed", contribution: "HIDDEN_COMPLETED_CONTRIBUTION", sourceRefs: [] };
  assert.doesNotMatch(terminalReportCopyText(report({ participants: [participant] })), /Agents|Sole agent|HIDDEN_COMPLETED_CONTRIBUTION/u);
  for (const status of ["failed", "blocked", "cancelled"]) {
    assert.match(terminalReportCopyText(report({ participants: [{ ...participant, status, contribution: "Needs attention" }] })), /Sole agent/u);
  }
});

test("copy omits internal artifacts and never invents content from ids or counts", () => {
  const text = terminalReportCopyText(report({
    title: "", summary: "", changeCount: 99, artifactCount: 99,
    artifacts: [
      { id: "ARTIFACT_ID", title: "Unified exec stdout", kind: "other", summary: "RAW_OUTPUT", path: "logs/output.txt", sourceRefs: [] },
      { id: "ARTIFACT_ID", title: "Generated file metadata: file.txt", kind: "other", summary: "INTERNAL_METADATA", sourceRefs: [] },
    ],
  }));
  assert.equal(text, "");
});

test("copy checks reference privacy but never reads response identity, other turns or raw evidence", () => {
  const entry = forbidReads({ title: "Visible check", status: "passed", summary: "Visible summary", command: "node --test", sourceRefs: [] }, ["id", "rawOutput", "outputTail"]);
  const withoutRefs = (value) => Object.freeze(forbidReads({ ...value, sourceRefs: [] }, ["id", "agentId"]));
  const item = forbidReads(report({
    verification: Object.freeze([Object.freeze(entry)]),
    corrections: Object.freeze([withoutRefs({ correctedFact: "Visible correction", originalAssumption: "Old assumption", confidence: "high" })]),
    changes: Object.freeze([withoutRefs({ title: "Visible change", summary: "Changed behavior", kind: "code", paths: Object.freeze(["src/file.ts"]) })]),
    participants: Object.freeze([withoutRefs({ displayName: "Visible agent", status: "blocked", contribution: "Waiting for review" })]),
    artifacts: Object.freeze([withoutRefs({ title: "Visible artifact", kind: "document", path: "docs/result.md", summary: "Result document" })]),
    risks: Object.freeze([withoutRefs({ severity: "warning", status: "unverified", summary: "Visible risk", nextAction: "Verify" })]),
  }), [
    "id", "reportId", "resultItemId", "generation", "revision", "threadId", "turnId", "runId", "attemptId", "participantId", "workflowStepId", "sourceRefs", "childItems", "items", "messages", "rawLog", "reasoning", "description", "meta",
  ]);
  Object.freeze(item);
  const first = terminalReportCopyText(item);
  assert.match(first, /Visible check/u);
  assert.equal(terminalReportCopyText(item), first);
});

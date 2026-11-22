import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationOperationSourceRef } from "../dist/index.js";
import { projectVisibleTerminalReportContent, terminalReportSourceRefs, visibleTerminalReportTimelineItem } from "../dist/index.js";

type ReportContent = Parameters<typeof projectVisibleTerminalReportContent>[0];
type Section = { sourceRefs: readonly ConversationOperationSourceRef[] };

type TerminalReportRow = Parameters<typeof visibleTerminalReportTimelineItem>[0];
type LegacyArtifact = Omit<TerminalReportRow["artifacts"][number], "kind">;

function report(): {
  language: NonNullable<ReportContent["language"]>;
  evidenceFingerprint: string;
  outcome: {
    title: string;
    summary: string;
    status: ReportContent["outcome"]["status"];
    corrections: (Section & { correctedFact: string })[];
    sourceRefs: Section["sourceRefs"];
  };
  changes: (Section & { title: string; paths: string[] })[];
  verification: (Section & { command: string })[];
  participants: (Section & { contribution: string })[];
  artifacts: (Section & { id: string; title: string; path: string })[];
  risks: (Section & { summary: string })[];
  references: ConversationOperationSourceRef[];
} {
  return {
    language: "en-US", evidenceFingerprint: "unchanged",
    outcome: { title: "Safe title", summary: "Safe summary", status: "succeeded", corrections: [], sourceRefs: [] },
    changes: [], verification: [], participants: [], artifacts: [], risks: [], references: [],
  };
}

test("one report source adapter preserves policy without minting a capability", () => {
  const ref: ConversationOperationSourceRef = { kind: "file", id: "file", label: "File", visibility: "folded_evidence", sensitivity: "private", hostTarget: "open_file", capabilityId: "untrusted" };
  assert.deepEqual(terminalReportSourceRefs([ref]), [{ kind: "file", id: "file", label: "File", visibility: "folded_evidence", sensitivity: "private" }]);
});

test("all sections and duplicate identities follow the most restrictive privacy marker", () => {
  for (const policy of [{ visibility: "developer_only" }, { visibility: "private" }, { visibility: "audit" }, { sensitivity: "secret_adjacent" }] as const) {
    const input = report();
    const publicRef: ConversationOperationSourceRef = { kind: "file", id: "restricted.txt", visibility: "conversation" };
    const privateRef = { ...publicRef, ...policy };
    input.references = [privateRef, publicRef];
    const section = { sourceRefs: [publicRef] };
    input.outcome.corrections = [{ ...section, correctedFact: "PRIVACY_SENTINEL" }];
    input.changes = [{ ...section, title: "PRIVACY_SENTINEL", paths: ["restricted.txt"] }];
    input.verification = [{ ...section, command: "PRIVACY_SENTINEL" }];
    input.participants = [{ ...section, contribution: "PRIVACY_SENTINEL" }];
    input.artifacts = [{ ...section, id: "artifact", title: "PRIVACY_SENTINEL", path: "restricted.txt" }];
    input.risks = [{ ...section, summary: "PRIVACY_SENTINEL" }];
    const untouched = JSON.stringify(input);
    const projected = projectVisibleTerminalReportContent(input);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVACY_SENTINEL|restricted\.txt/u);
    assert.equal(projected.outcome.summary, "Safe summary");
    assert.equal(projected.evidenceFingerprint, "unchanged");
    assert.equal(JSON.stringify(input), untouched);
    assert.deepEqual(projectVisibleTerminalReportContent(projected), projected);
  }
});

test("private path fields cannot bypass policy by omitting their section refs", () => {
  const input = report();
  input.references = [{ kind: "file", id: "src/private.ts", visibility: "developer_only" }];
  input.changes = [{ title: "Private change", paths: ["src/public.ts", "./src/private.ts"], sourceRefs: [] }];
  input.artifacts = [{ id: "artifact", title: "Private artifact", path: "src/private.ts", sourceRefs: [] }];
  const visible = projectVisibleTerminalReportContent(input);
  assert.deepEqual(visible.changes, []);
  assert.deepEqual(visible.artifacts, []);
});

test("restricted outcomes use only the localized Host status and preserve terminal identity", () => {
  const input = report();
  input.language = "zh-CN";
  input.outcome.title = "PRIVACY_SENTINEL";
  input.outcome.summary = "PRIVACY_SENTINEL";
  input.outcome.sourceRefs = [{ kind: "memory", id: "private", visibility: "developer_only" }];
  const visible = projectVisibleTerminalReportContent(input);
  assert.doesNotMatch(JSON.stringify(visible), /PRIVACY_SENTINEL/u);
  assert.equal(visible.outcome.status, "succeeded");
  assert.match(visible.outcome.title, /完成/u);
  assert.equal(visible.outcome.summary, "");
});

test("typed channel and child rows filter content and refresh visible counts", () => {
  const source = report();
  const sourceRefs: ConversationOperationSourceRef[] = [{ kind: "artifact", id: "hidden", sensitivity: "secret_adjacent" }];
  const row: TerminalReportRow = { id: "row", kind: "terminalReport", reportId: "report", generation: 2, resultItemId: "result",
    revision: 7, threadSequence: 2, partIndex: 0, status: "succeeded", outcomeStatus: "succeeded",
    title: source.outcome.title, summary: source.outcome.summary, sourceRefs: [],
    corrections: [], changes: [], verification: [], participants: [], risks: [], references: [],
    // A legacy artifact can have no kind and still needs privacy filtering.
    artifacts: [{ id: "hidden", title: "PRIVACY_SENTINEL", sourceRefs } satisfies LegacyArtifact as unknown as TerminalReportRow["artifacts"][number]],
    changeCount: 0, verificationCount: 0, participantCount: 0, riskCount: 0, artifactCount: 1 };
  const projected = visibleTerminalReportTimelineItem(row);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVACY_SENTINEL/u);
  assert.equal(projected.artifactCount, 0);
  assert.deepEqual([projected.reportId, projected.resultItemId, projected.generation, projected.status], ["report", "result", 2, "succeeded"]);
});

test("legacy run-storage artifacts do not appear as deliverables or duplicate sources", () => {
  const input = report();
  const runRef: ConversationOperationSourceRef = { kind: "run", id: "run_legacy", visibility: "conversation" };
  const toolRef: ConversationOperationSourceRef = { kind: "artifact", id: "tool-content", label: "find content", visibility: "conversation" };
  const patchRef: ConversationOperationSourceRef = { kind: "artifact", id: "patch-plan", label: "Workspace forward patch plan", visibility: "conversation" };
  const fileRef: ConversationOperationSourceRef = { kind: "file", id: "docs/output.md", visibility: "conversation" };
  input.changes = [{ title: "docs/output.md", paths: ["docs/output.md"], sourceRefs: [fileRef, toolRef] }];
  input.artifacts = [
    { id: "tool-content", title: "find content", path: "run_legacy/002-find-content.md", sourceRefs: [runRef, toolRef] },
    { id: "patch-plan", title: "Workspace forward patch plan", path: ".ling-stack/provenance/run_legacy/forward-plan.json", sourceRefs: [runRef, patchRef] },
  ];
  input.references = [toolRef, patchRef, fileRef];
  const projected = projectVisibleTerminalReportContent(input);
  assert.deepEqual(projected.artifacts, []);
  assert.equal(projected.changes.length, 1);
  assert.deepEqual(projected.changes[0].sourceRefs, [fileRef]);
  assert.deepEqual(projected.references, [fileRef]);
});

test("automation and external-work inputs stay private while generated media remains visible", () => {
  const input = report();
  input.artifacts = [
    { id: "automation-input", title: "Automation context", path: "automation-context/run-1-automation-1.md", sourceRefs: [] },
    { id: "external-input", title: "Rendered workflow prompt", path: "external-work/work-1/rendered-prompt.md", sourceRefs: [] },
    { id: "image-output", title: "Generated image", path: "media_jobs/job-1/output.png", sourceRefs: [] },
  ];
  const projected = projectVisibleTerminalReportContent(input);
  assert.deepEqual(projected.artifacts.map((artifact) => artifact.id), ["image-output"]);
});

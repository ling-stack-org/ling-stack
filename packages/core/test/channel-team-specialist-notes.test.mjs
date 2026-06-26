import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSpecialistNoteEvidenceInput,
  foldChannelTeamEvidenceForTurn,
} from "../dist/index.js";

test("specialist note evidence input stores summaries without hidden reasoning", () => {
  const input = buildSpecialistNoteEvidenceInput({
    id: "specialist_note_security",
    channelId: "channel_demo",
    turnId: "turn_demo",
    agentId: "teammate_builtin_security",
    evidenceGrade: "verified",
    summary: "Security reviewed the proposed filesystem mutation.",
    concerns: ["The command touches protected paths."],
    recommendations: ["Use the existing approval policy before mutation."],
    confidence: 0.91,
    sourceRefs: [{ type: "message", id: "msg_demo" }],
    now: "2026-06-26T00:00:00.000Z",
  });

  assert.equal(input.id, "specialist_note_security");
  assert.equal(input.kind, "specialist_note");
  assert.equal(input.status, "completed");
  assert.equal(input.visibility, "folded_evidence");
  assert.equal(input.expiresAt, "2026-07-26T00:00:00.000Z");
  assert.deepEqual(input.payload, {
    noteType: "specialist_note",
    hiddenReasoningStored: false,
  });
});

test("folded expert evidence read model groups late notes by turn", () => {
  const readModel = foldChannelTeamEvidenceForTurn({
    channelId: "channel_demo",
    turnId: "turn_demo",
    now: "2026-06-26T00:10:00.000Z",
    evidence: [
      evidence({
        id: "note_security",
        agentId: "teammate_builtin_security",
        kind: "specialist_note",
        status: "completed",
        evidenceGrade: "verified",
        summary: "Security note completed.",
        updatedAt: "2026-06-26T00:03:00.000Z",
      }),
      evidence({
        id: "note_qa_late",
        agentId: "teammate_builtin_qa",
        kind: "specialist_note",
        status: "completed",
        evidenceGrade: "reproduced",
        summary: "QA reproduced the issue after the main reply.",
        updatedAt: "2026-06-26T00:09:00.000Z",
      }),
      evidence({
        id: "card_architecture",
        agentId: "teammate_builtin_architect",
        kind: "agent_relevance_card",
        status: "pending",
        summary: "Architecture reviewer is still checking.",
        updatedAt: "2026-06-26T00:04:00.000Z",
      }),
      evidence({
        id: "expired_note",
        agentId: "teammate_builtin_docs",
        kind: "specialist_note",
        status: "completed",
        summary: "Expired note.",
        expiresAt: "2026-06-26T00:01:00.000Z",
        updatedAt: "2026-06-26T00:02:00.000Z",
      }),
      evidence({
        id: "other_turn",
        turnId: "turn_other",
        agentId: "teammate_builtin_security",
        kind: "specialist_note",
        status: "completed",
        summary: "Wrong turn.",
        updatedAt: "2026-06-26T00:08:00.000Z",
      }),
    ],
  });

  assert.equal(readModel.totalCount, 3);
  assert.equal(readModel.activeCount, 1);
  assert.equal(readModel.completedCount, 2);
  assert.equal(readModel.delayedCount, 0);
  assert.equal(readModel.latestUpdatedAt, "2026-06-26T00:09:00.000Z");
  assert.deepEqual(readModel.statusCounts, { completed: 2, pending: 1 });
  assert.deepEqual(readModel.entries.map((entry) => entry.id), [
    "note_qa_late",
    "card_architecture",
    "note_security",
  ]);
  assert.deepEqual(readModel.chips.map((chip) => [chip.agentId, chip.evidenceCount, chip.evidenceGrade]), [
    ["teammate_builtin_qa", 1, "reproduced"],
    ["teammate_builtin_architect", 1, undefined],
    ["teammate_builtin_security", 1, "verified"],
  ]);
});

function evidence(overrides = {}) {
  return {
    id: overrides.id ?? "evidence_demo",
    workspaceId: "workspace_default",
    channelId: overrides.channelId ?? "channel_demo",
    turnId: overrides.turnId ?? "turn_demo",
    agentId: overrides.agentId,
    kind: overrides.kind ?? "specialist_note",
    status: overrides.status ?? "completed",
    visibility: overrides.visibility ?? "folded_evidence",
    evidenceGrade: overrides.evidenceGrade,
    summary: overrides.summary ?? "Evidence summary.",
    concerns: overrides.concerns ?? [],
    recommendations: overrides.recommendations ?? [],
    confidence: overrides.confidence,
    sourceRefs: overrides.sourceRefs ?? [],
    payload: overrides.payload ?? {},
    expiresAt: overrides.expiresAt,
    createdAt: overrides.createdAt ?? "2026-06-26T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-26T00:00:00.000Z",
  };
}

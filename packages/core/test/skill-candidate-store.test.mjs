import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-06-20T00:00:00.000Z";

function candidateInput(overrides = {}) {
  const id = overrides.id ?? "skill_candidate_test";
  return {
    id,
    workspaceId: overrides.workspaceId,
    origin: overrides.origin ?? "manual-draft",
    targetSkillId: overrides.targetSkillId,
    proposedAction: overrides.proposedAction ?? "create",
    status: overrides.status,
    title: overrides.title ?? "Review reusable deploy handoff",
    summary: overrides.summary ?? "Capture the deploy handoff as a reviewed candidate skill.",
    definition: {
      workflowPhase: overrides.workflowPhase ?? "operate",
      positiveTriggers: overrides.positiveTriggers ?? ["repeated deploy handoff"],
      negativeTriggers: overrides.negativeTriggers ?? ["one-off deploy note"],
      procedureSteps: overrides.procedureSteps ?? [{ title: "Collect deploy evidence", instruction: "Read the run summary and linked approval." }],
      validationSteps: overrides.validationSteps ?? [{ title: "Run health check", commandOrCheck: "GET /skills/health", expectedResult: "No critical findings." }],
      requiredTools: overrides.requiredTools ?? ["read"],
      requiredProviderCapabilities: overrides.requiredProviderCapabilities ?? ["chat"],
      skillDefinition: overrides.skillDefinition,
    },
    duplicateAnalysis: overrides.duplicateAnalysis ?? {
      decision: "no_overlap",
      similarityScore: 0,
      matchedSkillIds: [],
      matchedCandidateIds: [],
      triggerOverlap: [],
      conflictingFields: [],
      rationale: "No matching published skill.",
    },
    safetyFindings: overrides.safetyFindings ?? [],
    sourceRefs: overrides.sourceRefs ?? [{ type: "manual", id: "manual_note_1", label: "Manual review note" }],
    reviewNotes: overrides.reviewNotes,
    expiresAt: overrides.expiresAt,
    supersededBy: overrides.supersededBy,
  };
}

async function withStore(prefix, fn) {
  const cwd = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      await fn(store, cwd);
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("sqlite skill candidates create, list, get, and survive migration idempotency", async () => {
  await withStore("ling-stack-skill-candidate-store-", async (store, cwd) => {
    const candidate = store.createSkillCandidate(candidateInput({ id: "skill_candidate_one" }), now);

    assert.equal(candidate.status, "pending");
    assert.equal(candidate.workspaceId, "workspace_default");
    assert.equal(store.getSkillCandidate(candidate.id)?.title, "Review reusable deploy handoff");
    assert.deepEqual(store.listSkillCandidates({ status: "pending" }).map((item) => item.id), [candidate.id]);
    assert.deepEqual(store.listSkillCandidates({ origin: "recording" }), []);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getSkillCandidate(candidate.id)?.id, candidate.id);
      assert.equal(reopened.listSkillCandidates({ limit: 10 }).length, 1);
    } finally {
      reopened.close();
    }
  });
});

test("sqlite skill candidate review approves eligible candidates and records audit action", async () => {
  await withStore("ling-stack-skill-candidate-review-", async (store) => {
    const candidate = store.createSkillCandidate(candidateInput({ id: "skill_candidate_approve" }), now);
    const reviewed = store.applySkillCandidateReviewAction({
      candidateId: candidate.id,
      action: "approve_for_draft",
      actor: "user",
      reason: "Validation and negative triggers are present.",
    }, "2026-06-20T00:01:00.000Z");

    assert.equal(reviewed.candidate.status, "approved_for_draft");
    assert.equal(reviewed.action.previousStatus, "pending");
    assert.equal(reviewed.action.nextStatus, "approved_for_draft");
    assert.equal(reviewed.action.reason, "Validation and negative triggers are present.");
    const records = store.listSkillCandidateReviewRecords(candidate.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "approve_for_draft");
  });
});

test("sqlite skill candidate review blocks draft approval without governance gates", async () => {
  await withStore("ling-stack-skill-candidate-gates-", async (store) => {
    const missingNegativeTriggers = store.createSkillCandidate(candidateInput({
      id: "skill_candidate_missing_negative",
      negativeTriggers: [],
    }), now);
    assert.throws(() => store.applySkillCandidateReviewAction({
      candidateId: missingNegativeTriggers.id,
      action: "approve_for_draft",
      actor: "user",
    }, "2026-06-20T00:01:00.000Z"), /negative triggers/);

    const missingValidation = store.createSkillCandidate(candidateInput({
      id: "skill_candidate_missing_validation",
      validationSteps: [],
    }), now);
    assert.throws(() => store.applySkillCandidateReviewAction({
      candidateId: missingValidation.id,
      action: "approve_for_draft",
      actor: "user",
    }, "2026-06-20T00:01:00.000Z"), /validation steps/);

    const criticalFinding = store.createSkillCandidate(candidateInput({
      id: "skill_candidate_critical",
      safetyFindings: [{
        id: "finding_critical",
        kind: "conflicting_triggers",
        severity: "critical",
        skillIds: [],
        candidateIds: ["skill_candidate_critical"],
        title: "Critical permission conflict",
        message: "Candidate claims authority expansion.",
        recommendation: "Reject or quarantine the candidate.",
        recommendedAction: "reject_candidate",
      }],
    }), now);
    assert.throws(() => store.applySkillCandidateReviewAction({
      candidateId: criticalFinding.id,
      action: "approve_for_draft",
      actor: "user",
    }, "2026-06-20T00:01:00.000Z"), /critical safety findings/);

    assert.equal(store.listSkillCandidateReviewRecords(missingNegativeTriggers.id).length, 0);
    assert.equal(store.getSkillCandidate(missingValidation.id)?.status, "pending");
  });
});

test("sqlite skill candidate review rejects terminal repeats and invalid supersession", async () => {
  await withStore("ling-stack-skill-candidate-terminal-", async (store) => {
    const rejected = store.createSkillCandidate(candidateInput({ id: "skill_candidate_reject" }), now);
    store.applySkillCandidateReviewAction({
      candidateId: rejected.id,
      action: "reject",
      actor: "user",
      reason: "Duplicate with existing docs.",
    }, "2026-06-20T00:01:00.000Z");
    assert.equal(store.getSkillCandidate(rejected.id)?.status, "rejected");
    assert.throws(() => store.applySkillCandidateReviewAction({
      candidateId: rejected.id,
      action: "keep_pending",
      actor: "user",
    }, "2026-06-20T00:02:00.000Z"), /terminal skill candidate/);

    const pending = store.createSkillCandidate(candidateInput({ id: "skill_candidate_supersede" }), now);
    assert.throws(() => store.applySkillCandidateReviewAction({
      candidateId: pending.id,
      action: "supersede",
      actor: "user",
    }, "2026-06-20T00:01:00.000Z"), /requires supersededBy/);
    assert.throws(() => store.applySkillCandidateReviewAction({
      candidateId: pending.id,
      action: "supersede",
      actor: "user",
      supersededBy: pending.id,
    }, "2026-06-20T00:01:00.000Z"), /cannot supersede itself/);
  });
});

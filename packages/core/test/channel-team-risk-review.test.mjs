import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChannelTeamRiskReviewDecision } from "../dist/index.js";

test("channel team risk review is not required for ordinary medium-risk file edits", () => {
  const decision = buildChannelTeamRiskReviewDecision({
    actionType: "edit",
    risk: "medium",
    payload: {
      type: "file_edit",
      path: "src/app.ts",
      diffPreview: "-old\n+new",
    },
  });

  assert.equal(decision.status, "not_required");
  assert.deepEqual(decision.triggerCodes, []);
});

test("channel team risk review is not required for ordinary branch pushes", () => {
  const decision = buildChannelTeamRiskReviewDecision({
    actionType: "git_push",
    risk: "high",
    payload: {
      type: "bash",
      cwd: "/workspace/demo",
      command: "git push origin feature/team-runtime-governor",
      riskFlags: [],
    },
  });

  assert.equal(decision.status, "not_required");
  assert.deepEqual(decision.triggerCodes, []);
});

test("channel team risk review catches protected branch pushes", () => {
  const decision = buildChannelTeamRiskReviewDecision({
    actionType: "git_push",
    risk: "high",
    payload: {
      type: "bash",
      cwd: "/workspace/demo",
      command: "git push origin main",
      riskFlags: [],
    },
  });

  assert.equal(decision.status, "required");
  assert.equal(decision.risk, "high");
  assert.deepEqual(decision.triggerCodes, ["protected_branch_push"]);
});

test("channel team risk review catches destructive and remote-history shell actions", () => {
  const decision = buildChannelTeamRiskReviewDecision({
    actionType: "git_push",
    risk: "critical",
    payload: {
      type: "bash",
      cwd: "/workspace/demo",
      command: "git push origin main --force-with-lease",
      riskFlags: ["git_force_push"],
    },
  });

  assert.equal(decision.status, "required");
  assert.equal(decision.risk, "critical");
  assert.deepEqual(decision.triggerCodes, ["critical_risk", "git_force_push", "protected_branch_push"]);
  assert.match(decision.reasons.join(" "), /Force push/);
});

test("channel team risk review flags runtime permission expansion without a second approval engine", () => {
  const decision = buildChannelTeamRiskReviewDecision({
    actionType: "runtime_permission_request",
    risk: "medium",
    payload: {
      type: "runtime_permission_request",
      requestKind: "write_scope",
      requestedByRunId: "run_demo",
      reason: "Need to edit generated files.",
      requestedScope: {
        kind: "write_scope",
        paths: ["."],
        operation: "update",
      },
      currentScope: {
        tools: ["read"],
        allowedWritePaths: [],
        mcpToolRefs: [],
        runnerId: "pi",
      },
      proposedContinuation: {
        mode: "queue_followup",
        writePathDelta: ["."],
        reason: "Apply to a continuation.",
      },
    },
  });

  assert.equal(decision.status, "required");
  assert.equal(decision.risk, "high");
  assert.deepEqual(decision.triggerCodes, ["runtime_permission_expansion"]);
});

test("channel team risk review can fail closed when reviewer availability is explicitly unavailable", () => {
  const decision = buildChannelTeamRiskReviewDecision({
    actionType: "deploy",
    risk: "critical",
    reviewerAvailable: false,
    unavailableReviewerBehavior: "block",
    payload: {
      type: "deploy",
      target: "production",
      environment: "production",
    },
  });

  assert.equal(decision.status, "blocked");
  assert.equal(decision.risk, "critical");
  assert.equal(decision.triggerCodes.includes("deploy_or_production_mutation"), true);
  assert.match(decision.reasons.join(" "), /unavailable/);
});

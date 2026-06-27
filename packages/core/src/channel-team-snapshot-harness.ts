import { channelTeamShadowArtifactGuardrails } from "./channel-team-types.js";
import type {
  ChannelTeamEvaluationCase,
  ChannelTeamEvaluationRun,
  ChannelTeamPattern,
  ChannelTeamSnapshot,
  ChannelTeamSnapshotDiff,
  ChannelTeamSnapshotDiffEntry,
  ChannelTeamSnapshotState,
  CreateChannelTeamEvaluationRunInput,
} from "./channel-team-types.js";
import { buildChannelTeamAttentionPlan } from "./channel-team-attention.js";
import { buildChannelTeamRiskReviewDecision } from "./channel-team-risk-review.js";

export function diffChannelTeamSnapshots(
  base: ChannelTeamSnapshot,
  target: ChannelTeamSnapshot,
): ChannelTeamSnapshotDiff {
  return {
    baseSnapshotId: base.id,
    targetSnapshotId: target.id,
    entries: [
      ...diffValue("protocol", base.state.protocol, target.state.protocol),
      ...diffValue("activeProvisionalRuleIds", ruleIds(base.state.activeProvisionalRules), ruleIds(target.state.activeProvisionalRules)),
      ...diffValue("patternIds", ruleIds(base.state.patterns), ruleIds(target.state.patterns)),
      ...diffValue("reliabilityIncidentIds", base.state.reliabilityIncidentIds, target.state.reliabilityIncidentIds),
      ...diffValue("availabilityIncidentIds", base.state.availabilityIncidentIds, target.state.availabilityIncidentIds),
      ...diffValue("messageCount", base.state.messageCount, target.state.messageCount),
    ],
    guardrails: channelTeamShadowArtifactGuardrails,
    restoreRequiresExplicitApply: true,
  };
}

export function buildChannelTeamEvaluationRunInput(input: {
  readonly channelId: string;
  readonly snapshotId?: string;
  readonly cases: readonly ChannelTeamEvaluationCase[];
  readonly now: string;
}): CreateChannelTeamEvaluationRunInput {
  const results = input.cases.map((testCase) => evaluateCase(input.channelId, testCase, input.now));
  return {
    channelId: input.channelId,
    snapshotId: input.snapshotId,
    cases: input.cases,
    results,
    summary: {
      passedCount: results.filter((result) => result.passed).length,
      failedCount: results.filter((result) => !result.passed).length,
      totalCount: results.length,
    },
  };
}

export function summarizeSnapshotState(state: ChannelTeamSnapshotState): Record<string, unknown> {
  return {
    protocolVersion: state.protocol?.version,
    activeProvisionalRuleCount: state.activeProvisionalRules.length,
    patternCount: state.patterns.length,
    reliabilityIncidentCount: state.reliabilityIncidentIds.length,
    availabilityIncidentCount: state.availabilityIncidentIds.length,
    messageCount: state.messageCount,
    latestMessageAt: state.latestMessageAt,
  };
}

function evaluateCase(
  channelId: string,
  testCase: ChannelTeamEvaluationCase,
  now: string,
): ChannelTeamEvaluationRun["results"][number] {
  const inferred = inferRiskReview(testCase.input);
  const riskDecision = buildChannelTeamRiskReviewDecision(inferred);
  const attentionPlan = buildChannelTeamAttentionPlan({
    channelId,
    turnId: `evaluation:${testCase.id}`,
    turnMode: riskDecision.status === "not_required" ? "quick_answer" : "safe_action",
    candidates: [],
    signals: [],
    now,
    flags: { attentionPlanEnabled: true },
  });
  const riskMatches = testCase.expectedRiskReviewStatus === undefined ||
    testCase.expectedRiskReviewStatus === riskDecision.status;
  const observerMatches = testCase.maxObserverCount === undefined ||
    attentionPlan.observers.length <= testCase.maxObserverCount;
  return {
    caseId: testCase.id,
    passed: riskMatches && observerMatches,
    observedRiskReviewStatus: riskDecision.status,
    observedObserverCount: attentionPlan.observers.length,
    reasons: [
      ...riskDecision.reasons,
      ...(riskMatches ? [] : [`expected_risk_review:${testCase.expectedRiskReviewStatus}`]),
      ...(observerMatches ? [] : [`max_observers:${testCase.maxObserverCount}`]),
    ],
  };
}

function inferRiskReview(input: string): Parameters<typeof buildChannelTeamRiskReviewDecision>[0] {
  const lower = input.toLowerCase();
  if (/git\s+push/.test(lower) && /--force|main|master/.test(lower)) {
    return {
      actionType: "git_push",
      risk: "critical",
      payload: {
        type: "bash",
        cwd: "/evaluation",
        command: input,
        riskFlags: ["git_force_push"],
      },
    };
  }
  if (/(delete|drop|remove).*(production|database|db)|rm\s+-rf|reset\s+--hard/.test(lower)) {
    return {
      actionType: "bash",
      risk: "critical",
      payload: {
        type: "bash",
        cwd: "/evaluation",
        command: input,
        riskFlags: ["destructive_remove"],
      },
    };
  }
  return {
    actionType: "read",
    risk: "low",
  };
}

function diffValue(path: string, before: unknown, after: unknown): readonly ChannelTeamSnapshotDiffEntry[] {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }
  if (before === undefined) {
    return [{ path, before, after, kind: "added" }];
  }
  if (after === undefined) {
    return [{ path, before, after, kind: "removed" }];
  }
  return [{ path, before, after, kind: "changed" }];
}

function ruleIds(patterns: readonly ChannelTeamPattern[]): readonly string[] {
  return patterns.map((pattern) => pattern.id).sort();
}

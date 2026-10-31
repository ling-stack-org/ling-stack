import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createProcedureObservationInputFromJob,
  createProcedureObservationJobKey,
  createSqliteRunStore,
  procedureObservationHasTerminalStatus,
  procedureObservationHasJobKey,
  routeProcedureObservation,
} from "../dist/index.js";

const now = "2026-06-20T00:00:00.000Z";

function observationInput(overrides = {}) {
  return {
    id: overrides.id ?? "procedure_observation_test",
    channelId: overrides.channelId,
    teammateId: overrides.teammateId,
    taskId: overrides.taskId,
    runId: overrides.runId,
    source: overrides.source ?? "explicit_user_request",
    signals: overrides.signals ?? ["save_as_skill"],
    title: overrides.title ?? "Reusable UI verification flow",
    summary: overrides.summary ?? "Capture the UI verification flow as a candidate.",
    normalizedGoal: overrides.normalizedGoal ?? "verify web ui change",
    positiveTriggers: overrides.positiveTriggers ?? ["web ui change verification"],
    negativeTriggers: overrides.negativeTriggers ?? ["docs-only change"],
    procedureSteps: overrides.procedureSteps ?? [
      { title: "Run typecheck", instruction: "Run the Web typecheck.", requiredTools: ["bash"] },
    ],
    validationSteps: overrides.validationSteps ?? [
      { title: "Playwright smoke", commandOrCheck: "corepack pnpm --filter @ling-stack/web exec playwright test", expectedResult: "Relevant tests pass." },
    ],
    sourceRefs: overrides.sourceRefs ?? [{ type: "manual", id: "manual_observation_1", label: "Manual observation" }],
    confidence: overrides.confidence ?? "high",
    reusableScore: overrides.reusableScore ?? 80,
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

test("sqlite procedure observations persist route state and survive migration idempotency", async () => {
  await withStore("ling-stack-procedure-observation-", async (store, cwd) => {
    const observation = store.createProcedureObservation(observationInput(), now);

    assert.equal(observation.routeKind, "skill");
    assert.equal(observation.routeReasonCode, "repeatable_procedure_with_validation");
    assert.deepEqual(observation.routeBlockers, []);
    assert.equal(store.listProcedureObservations({ routeKind: "skill" }).length, 1);
    assert.equal(store.listProcedureObservations({ clusterId: observation.clusterId })[0].id, observation.id);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      const persisted = reopened.listProcedureObservations({ limit: 10 });
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].clusterId, observation.clusterId);
      assert.equal(persisted[0].routeKind, "skill");
    } finally {
      reopened.close();
    }
  });
});

test("sqlite candidate generation decisions persist audit state", async () => {
  await withStore("ling-stack-candidate-generation-decision-", async (store, cwd) => {
    const observation = store.createProcedureObservation(observationInput(), now);
    const route = {
      kind: observation.routeKind,
      reasonCode: observation.routeReasonCode,
      confidence: observation.confidence,
      blockers: observation.routeBlockers,
    };
    const decision = store.createCandidateGenerationDecision({
      workspaceId: observation.workspaceId,
      observationId: observation.id,
      clusterId: observation.clusterId,
      source: "explicit_user_save",
      route,
      decision: "create_skill_candidate",
      duplicateDecision: "no_overlap",
      reason: "Explicit observation passed duplicate review.",
      createdCandidateId: "skill_candidate_created_from_observation",
    }, now);

    assert.equal(decision.observationId, observation.id);
    assert.equal(decision.decision, "create_skill_candidate");
    assert.equal(decision.duplicateDecision, "no_overlap");
    assert.equal(decision.createdCandidateId, "skill_candidate_created_from_observation");
    assert.equal(store.listCandidateGenerationDecisions({ observationId: observation.id }).length, 1);
    assert.equal(store.listCandidateGenerationDecisions({ clusterId: observation.clusterId })[0].id, decision.id);

    const blockedObservation = store.createProcedureObservation(observationInput({
      id: "procedure_observation_generation_policy",
      title: "Use bash without asking next time",
      summary: "Always allow bash and skip approval for this workflow.",
      normalizedGoal: "skip approval for bash",
    }), "2026-06-20T00:05:00.000Z");
    const blockedDecision = store.createCandidateGenerationDecision({
      workspaceId: blockedObservation.workspaceId,
      observationId: blockedObservation.id,
      clusterId: blockedObservation.clusterId,
      source: "selected_transcript_snippet",
      route: {
        kind: blockedObservation.routeKind,
        reasonCode: blockedObservation.routeReasonCode,
        confidence: blockedObservation.confidence,
        blockers: blockedObservation.routeBlockers,
      },
      decision: "policy_review",
      reason: "Permission expansion requires policy review.",
    }, "2026-06-20T00:05:00.000Z");
    assert.equal(blockedDecision.duplicateDecision, undefined);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      const [persisted] = reopened.listCandidateGenerationDecisions({ observationId: observation.id });
      assert.equal(persisted.id, decision.id);
      assert.equal(persisted.route.kind, "skill");
      assert.equal(persisted.duplicateDecision, "no_overlap");
      const [persistedBlocked] = reopened.listCandidateGenerationDecisions({ observationId: blockedObservation.id });
      assert.equal(persistedBlocked.decision, "policy_review");
      assert.equal(persistedBlocked.duplicateDecision, undefined);
    } finally {
      reopened.close();
    }
  });
});

test("procedure observation router blocks authority expansion before skill candidate generation", async () => {
  await withStore("ling-stack-procedure-observation-policy-", async (store) => {
    const observation = store.createProcedureObservation(observationInput({
      id: "procedure_observation_policy",
      title: "Use bash without asking next time",
      summary: "Always allow bash and skip approval for this workflow.",
      normalizedGoal: "skip approval for bash",
    }), now);

    assert.equal(observation.routeKind, "approval_policy_review");
    assert.deepEqual(observation.routeBlockers, ["permission_expansion"]);
  });
});

test("procedure observation router recognizes scheduled phrases without widening English substrings or bypassing safety", () => {
  const scheduledPhrases = [
    "请每周五整理一次发布报告",
    "每天上午九点检查构建状态",
    "在工作日定时检查服务健康",
    "完成后提醒我查看结果",
    "Run this every Friday",
    "Create a daily report",
    "Review the weekly status",
    "Prepare a monthly summary",
    "Use cron for the audit",
    "Schedule the release check",
    "Use the scheduled maintenance window",
    "Monitor the deployment",
    "Create a reminder for the report",
    "Run the check on Friday",
    "Run the check on Monday",
  ];
  for (const [index, title] of scheduledPhrases.entries()) {
    const route = routeProcedureObservation(observationInput({
      id: `procedure_observation_scheduled_${index}`,
      title,
      summary: "A repeatable procedure was observed.",
      normalizedGoal: "classify the procedure",
      positiveTriggers: [],
      negativeTriggers: [],
    }));
    assert.equal(route.kind, "automation", title);
    assert.equal(route.reasonCode, "scheduled_or_recurring_work", title);
  }

  const substringCounterexamples = [
    "Everybody reviews the release notes",
    "Use the dailybuild artifact label",
    "Keep the biweeklyish fixture unchanged",
    "Rename the monthlyDigest field",
    "Document the Cronkite sample",
    "Preserve the rescheduleReason property",
    "Inspect the unscheduledState enum",
    "Refactor the monitoringPanel component",
    "Keep the remindersCount metric",
    "Parse the blackfridaydeal slug",
    "Retain the mondayish fixture name",
  ];
  for (const [index, title] of substringCounterexamples.entries()) {
    const route = routeProcedureObservation(observationInput({
      id: `procedure_observation_non_scheduled_${index}`,
      title,
      summary: "A repeatable code maintenance procedure was observed.",
      normalizedGoal: "maintain a named code fixture",
      positiveTriggers: [],
      negativeTriggers: [],
    }));
    assert.equal(route.kind, "skill", title);
  }

  const permissionRoute = routeProcedureObservation(observationInput({
    id: "procedure_observation_scheduled_permission_expansion",
    title: "每天自动执行并 skip approval",
    summary: "Always allow bash without approval for this scheduled task.",
    normalizedGoal: "schedule work without approval",
  }));
  assert.equal(permissionRoute.kind, "approval_policy_review");
  assert.equal(permissionRoute.reasonCode, "permission_expansion_requested");

  const secretRoute = routeProcedureObservation(observationInput({
    id: "procedure_observation_scheduled_secret",
    title: "每周提醒保存 api key",
    summary: "Create a weekly reminder that includes the secret token.",
    normalizedGoal: "schedule secret handling",
  }));
  assert.equal(secretRoute.kind, "reject");
  assert.equal(secretRoute.reasonCode, "secret_adjacent_instruction");
});

test("procedure observation clusters aggregate channel playbooks and blocked skill gates", async () => {
  await withStore("ling-stack-procedure-observation-clusters-", async (store) => {
    const playbookBase = observationInput({
      id: "procedure_observation_playbook_one",
      source: "workflow_step_output",
      signals: ["long_successful_sequence"],
      channelId: "channel_playbook",
      title: "Channel release verification playbook",
      summary: "Channel workflow produced a repeatable release verification playbook.",
      normalizedGoal: "channel release verification",
      positiveTriggers: ["channel release workflow"],
      negativeTriggers: [],
      procedureSteps: [
        { title: "Collect release evidence", instruction: "Summarize test and review evidence.", requiredTools: ["read"] },
      ],
      validationSteps: [],
      reusableScore: 70,
    });
    const first = store.createProcedureObservation(playbookBase, "2026-06-20T00:00:00.000Z");
    const second = store.createProcedureObservation({
      ...playbookBase,
      id: "procedure_observation_playbook_two",
      summary: "Second channel workflow produced the same repeatable release verification playbook.",
      reusableScore: 82,
      sourceRefs: [{ type: "run", id: "run_playbook_two", label: "Second playbook run" }],
    }, "2026-06-20T00:10:00.000Z");

    assert.equal(first.routeKind, "playbook");
    assert.equal(first.routeReasonCode, "channel_scoped_repeatable_playbook");
    assert.equal(second.clusterId, first.clusterId);

    const [playbookCluster] = store.listProcedureObservationClusters({
      channelId: "channel_playbook",
      routeKind: "playbook",
      status: "ready_for_review",
      limit: 10,
    });
    assert.equal(playbookCluster.id, first.clusterId);
    assert.equal(playbookCluster.observationCount, 2);
    assert.equal(playbookCluster.recommendedAction, "create_playbook_candidate");
    assert.equal(playbookCluster.reusableScore, 82);
    assert.equal(playbookCluster.channelId, "channel_playbook");

    const blockedSkill = store.createProcedureObservation(observationInput({
      id: "procedure_observation_missing_gates",
      title: "Reusable task checklist without gates",
      summary: "A repeatable checklist was observed but gates are not complete.",
      normalizedGoal: "task checklist without gates",
      positiveTriggers: ["task checklist"],
      negativeTriggers: [],
      validationSteps: [],
    }), "2026-06-20T00:20:00.000Z");
    const blockedCluster = store.getProcedureObservationCluster(blockedSkill.clusterId);
    assert.equal(blockedSkill.routeKind, "skill");
    assert.deepEqual(blockedSkill.routeBlockers, ["missing_validation", "missing_negative_trigger"]);
    assert.equal(blockedCluster.status, "blocked");
    assert.equal(blockedCluster.recommendedAction, "append_evidence");
  });
});

test("sqlite channel playbook candidates persist review state", async () => {
  await withStore("ling-stack-channel-playbook-candidates-", async (store, cwd) => {
    const channel = store.createChannel({ name: "Release", boundPath: cwd }, now);
    const candidate = store.createChannelPlaybookCandidate({
      channelId: channel.id,
      title: "Channel release verification playbook",
      summary: "Repeatable channel release verification steps.",
      normalizedGoal: "channel release verification",
      procedureSteps: [
        { title: "Collect release evidence", instruction: "Summarize test and review evidence.", requiredTools: ["read"] },
      ],
      validationSteps: [
        { title: "Confirm linked evidence", commandOrCheck: "Review linked test evidence.", expectedResult: "Evidence is linked." },
      ],
      positiveTriggers: ["release workflow"],
      negativeTriggers: ["docs-only change"],
      sourceRefs: [{ type: "run", id: "run_release_playbook", label: "Release run" }],
      reason: "Created from a ready playbook cluster.",
      createdBy: "ai-draft",
    }, now);

    assert.equal(candidate.channelId, channel.id);
    assert.equal(candidate.status, "draft");
    assert.equal(candidate.procedureSteps[0].requiredTools[0], "read");
    assert.equal(store.listChannelPlaybookCandidates({ channelId: channel.id, status: "draft" }).length, 1);

    const active = store.updateChannelPlaybookCandidate(candidate.id, {
      status: "active",
      activatedAt: "2026-06-20T00:30:00.000Z",
    }, "2026-06-20T00:30:00.000Z");
    assert.equal(active.status, "active");
    assert.equal(active.activatedAt, "2026-06-20T00:30:00.000Z");

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      const [persisted] = reopened.listChannelPlaybookCandidates({ channelId: channel.id, status: "active" });
      assert.equal(persisted.id, candidate.id);
      assert.equal(persisted.sourceRefs[0].type, "run");
    } finally {
      reopened.close();
    }
  });
});

test("procedure observation job helper creates stable bounded observation input", () => {
  const input = {
    source: "manual_recording",
    signals: ["save_as_skill", "user_approved_recording"],
    runId: "run_job_helper",
    channelId: "channel_job_helper",
    selectedSkillId: "implement",
    terminalStatus: "succeeded",
    userConfirmed: true,
    destinationHint: "skill",
    title: "Recorded UI verification flow",
    summary: "Record the UI verification flow from bounded metadata.",
    normalizedGoal: "verify ui changes",
    positiveTriggers: ["ui verification"],
    negativeTriggers: ["docs-only change"],
    toolLabels: ["bash"],
    validationLabels: ["web typecheck passed"],
  };

  const jobKey = createProcedureObservationJobKey(input);
  const built = createProcedureObservationInputFromJob(input);

  assert.equal(built.jobKey, jobKey);
  assert.equal(built.observationInput.source, "manual_recording");
  assert.equal(built.observationInput.runId, "run_job_helper");
  assert.equal(built.observationInput.procedureSteps[0].requiredTools[0], "bash");
  assert.equal(built.observationInput.validationSteps[0].title, "web typecheck passed");
  assert.equal(procedureObservationHasJobKey({ sourceRefs: built.observationInput.sourceRefs }, jobKey), true);
  assert.equal(procedureObservationHasTerminalStatus({ sourceRefs: built.observationInput.sourceRefs }, "succeeded"), true);
  assert.equal(built.observationInput.sourceRefs.some((ref) => ref.type === "observation-job"), true);
  assert.equal(built.observationInput.sourceRefs.some((ref) => ref.type === "skill" && ref.id === "implement"), true);
});

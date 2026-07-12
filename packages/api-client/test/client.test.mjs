import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError, daemonBaseUrlFromEnv } from "../dist/index.js";

function createFetchMock(responseBody = { ok: true }) {
  const calls = [];
  const responses = Array.isArray(responseBody) ? [...responseBody] : undefined;
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
    return jsonResponse(responses ? responses.shift() : responseBody);
  };
  return { calls, fetch };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "Content-Type": "application/json" },
  });
}

test("daemonBaseUrlFromEnv trims configured URL and falls back to local daemon", () => {
  assert.equal(daemonBaseUrlFromEnv({ VITE_LING_STACK_DAEMON_URL: "http://127.0.0.1:9999/" }), "http://127.0.0.1:9999");
  assert.equal(daemonBaseUrlFromEnv({}), "http://127.0.0.1:17891");
});

test("binds global fetch to globalThis when no custom fetch is provided", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async function (url, init = {}) {
      assert.equal(this, globalThis);
      assert.equal(String(url), "http://daemon.test/runs?cwd=%2Frepo&limit=50");
      assert.equal(init.method, "GET");
      return jsonResponse({ cwd: "/repo", runs: [] });
    };

    const client = new LingDaemonClient({ baseUrl: "http://daemon.test" });
    await client.listRuns("/repo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("builds URL query parameters for list endpoints", async () => {
  const mock = createFetchMock({ cwd: "/repo", runs: [] });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.listRuns("/repo path", 25);
  await client.listChannelMessages("/repo", "channel 1", { limit: 15 });
  await client.listChannelAttachments("/repo", "channel 1", 16);
  await client.listChannelLinkPreviews("/repo", "channel 1", 17);
  await client.getChannelBrief("/repo", "channel 1");
  await client.listChannelDecisions("/repo", "channel 1", { status: "active", limit: 18 });
  await client.listChannelHandoffs("/repo", "channel 1", { status: "proposed", limit: 19 });
  await client.listChannelContextSummaries("/repo", "channel 1", { targetType: "task", targetId: "task 1", limit: 20 });
  await client.listChannelWorkflows("/repo", "channel 1", { status: "running", limit: 21 });
  await client.listChannelWorkflowSteps("/repo", "workflow 1", { status: "queued", limit: 22 });
  await client.listTasks("/repo", { channelId: "ch 1", status: "todo", limit: 5 });
  await client.listApprovals("/repo", { status: "pending", runId: "run 1", mediaJobId: "media 1", limit: 7 });
  await client.listStateTransitions("/repo", { entityType: "task", entityId: "task 1", limit: 9 });
  await client.listResourceLeases("/repo", { status: "active", ownerId: "run 1", limit: 11 });
  await client.listGitHubExternalWorkCiTriage("/repo", { externalWorkId: "external work 1", channelId: "channel 1", status: "task_created", limit: 12 });
  await client.getGitHubExternalWorkCiTriage("/repo", "triage 1");
  await client.getSecretStatus("keychain:provider 1", "provider_api_key");
  await client.getEffectiveConfig("/repo path");
  await client.getStartupStatus("/repo path");
  await client.refreshStartupStatus("/repo path");
  await client.getSkillHealth("/repo path", { limit: 13 });
  await client.listSkillUsageEvents("/repo path", { skillId: "skill 1", candidateId: "candidate 1", runId: "run 1", kind: "failed", limit: 15 });
  await client.listSkillUsageStats("/repo path", { skillId: "skill 1" });
  await client.suggestSkillInvocations("/repo path", { teammateId: "teammate 1", title: "Review PR", prompt: "Find bugs", limit: 3 });
  await client.recordSkillCorrection("/repo path", "skill 1", { reason: "Wrong behavior.", runId: "run 1" });
  await client.listCandidateGenerationDecisions("/repo path", { observationId: "observation 1", clusterId: "cluster 1", decision: "append_evidence", limit: 4 });
  await client.listSkillCandidates("/repo path", { status: "pending", origin: "manual-draft", limit: 14 });
  await client.getSkillCandidate("/repo path", "candidate 1");
  await client.createSkillCandidate("/repo path", { title: "Candidate", summary: "Candidate summary", definition: {}, sourceRefs: [] });
  await client.reviewSkillCandidate("/repo path", "candidate 1", { action: "reject", reason: "Duplicate." });
  await client.createSkillCandidateDraft("/repo path", "candidate 1");
  await client.listChannelProtocolCandidates("/repo path", "channel 1", { status: "draft", limit: 6 });
  await client.createChannelProtocolCandidate("/repo path", "channel 1", {
    proposedPatch: { reviewRules: ["Require QA evidence."] },
    reason: "Repeated review rule.",
  });
  await client.createChannelProtocolCandidateFromCluster("/repo path", "channel 1", "cluster 1", {
    proposedPatch: { reviewRules: ["Keep handoffs reviewed."] },
    reason: "Cluster is ready.",
  });
  await client.reviewChannelProtocolCandidate("/repo path", "channel 1", "candidate 1", { action: "reject", reason: "Not reusable." });
  await client.listChannelPlaybookCandidates("/repo path", "channel 1", { status: "draft", limit: 5 });
  await client.createChannelPlaybookCandidateFromCluster("/repo path", "channel 1", "cluster 2", {
    reason: "Cluster is ready for playbook review.",
  });
  await client.reviewChannelPlaybookCandidate("/repo path", "channel 1", "candidate 2", { action: "approve", reason: "Promote to active playbook." });
  await client.getChannelProtocolCanvas("/repo path", "channel 1", { limit: 7 });
  await client.listProcedureObservations("/repo path", { clusterId: "cluster 1", channelId: "channel 1", routeKind: "skill", limit: 8 });
  await client.listProcedureObservationClusters("/repo path", {
    channelId: "channel 1",
    routeKind: "playbook",
    status: "ready_for_review",
    limit: 9,
  });
  await client.getProcedureObservationCluster("/repo path", "cluster 1");
  await client.createProcedureObservation("/repo path", {
    source: "explicit_user_request",
    signals: ["save_as_skill"],
    title: "Manual observation",
    summary: "Manual observation summary",
    normalizedGoal: "manual observation",
    sourceRefs: [{ type: "manual", id: "manual 0" }],
  });
  await client.createProcedureObservationJob("/repo path", {
    source: "manual_recording",
    signals: ["save_as_skill", "user_approved_recording"],
    runId: "run 1",
    userConfirmed: true,
    title: "Recorded observation",
    summary: "Recorded observation summary",
    normalizedGoal: "recorded observation",
  });
  await client.recordSkillRecording("/repo path", {
    runId: "run 2",
    title: "Recorded skill",
    summary: "Recorded skill summary",
    normalizedGoal: "recorded skill",
  });
  await client.observeSkillCandidate("/repo path", {
    source: "explicit_user_request",
    signals: ["save_as_skill"],
    title: "Candidate from observation",
    summary: "Observation summary",
    normalizedGoal: "candidate from observation",
    sourceRefs: [{ type: "manual", id: "manual 1" }],
  });
  await client.selectWorkspaceDirectory("/repo path");
  await client.getWorkspaceTerminalProfile("/repo path");
  await client.runWorkspaceTerminalCommand("/repo path", { command: "pwd" });

  assert.equal(mock.calls[0].url, "http://daemon.test/runs?cwd=%2Frepo+path&limit=25");
  assert.equal(mock.calls[1].url, "http://daemon.test/channels/channel%201/messages?cwd=%2Frepo&limit=15");
  assert.equal(mock.calls[2].url, "http://daemon.test/channels/channel%201/attachments?cwd=%2Frepo&limit=16");
  assert.equal(mock.calls[3].url, "http://daemon.test/channels/channel%201/link-previews?cwd=%2Frepo&limit=17");
  assert.equal(mock.calls[4].url, "http://daemon.test/channels/channel%201/brief?cwd=%2Frepo");
  assert.equal(mock.calls[5].url, "http://daemon.test/channels/channel%201/decisions?cwd=%2Frepo&status=active&limit=18");
  assert.equal(mock.calls[6].url, "http://daemon.test/channels/channel%201/handoffs?cwd=%2Frepo&status=proposed&limit=19");
  assert.equal(mock.calls[7].url, "http://daemon.test/channels/channel%201/context-summaries?cwd=%2Frepo&targetType=task&targetId=task+1&limit=20");
  assert.equal(mock.calls[8].url, "http://daemon.test/channels/channel%201/workflows?cwd=%2Frepo&status=running&limit=21");
  assert.equal(mock.calls[9].url, "http://daemon.test/workflows/workflow%201/steps?cwd=%2Frepo&status=queued&limit=22");
  assert.equal(mock.calls[10].url, "http://daemon.test/tasks?cwd=%2Frepo&channelId=ch+1&status=todo&limit=5");
  assert.equal(mock.calls[11].url, "http://daemon.test/approvals?cwd=%2Frepo&status=pending&runId=run+1&mediaJobId=media+1&limit=7");
  assert.equal(mock.calls[12].url, "http://daemon.test/state-transitions?cwd=%2Frepo&entityType=task&entityId=task+1&limit=9");
  assert.equal(mock.calls[13].url, "http://daemon.test/runtime/leases?cwd=%2Frepo&status=active&ownerId=run+1&limit=11");
  assert.equal(mock.calls[14].url, "http://daemon.test/external-work/github/ci/triage?cwd=%2Frepo&externalWorkId=external+work+1&channelId=channel+1&status=task_created&limit=12");
  assert.equal(mock.calls[15].url, "http://daemon.test/external-work/github/ci/triage/triage%201?cwd=%2Frepo");
  assert.equal(mock.calls[16].url, "http://daemon.test/secrets/status?ref=keychain%3Aprovider+1&purpose=provider_api_key");
  assert.equal(mock.calls[17].url, "http://daemon.test/config/effective?cwd=%2Frepo+path");
  assert.equal(mock.calls[18].url, "http://daemon.test/startup/status?cwd=%2Frepo+path");
  assert.equal(mock.calls[19].url, "http://daemon.test/startup/refresh?cwd=%2Frepo+path");
  assert.equal(mock.calls[19].method, "POST");
  assert.equal(mock.calls[20].url, "http://daemon.test/skills/health?cwd=%2Frepo+path&limit=13");
  assert.equal(mock.calls[21].url, "http://daemon.test/skills/usage-events?cwd=%2Frepo+path&skillId=skill+1&candidateId=candidate+1&runId=run+1&kind=failed&limit=15");
  assert.equal(mock.calls[22].url, "http://daemon.test/skills/usage-stats?cwd=%2Frepo+path&skillId=skill+1");
  assert.equal(mock.calls[23].url, "http://daemon.test/skills/suggestions?cwd=%2Frepo+path");
  assert.equal(mock.calls[23].method, "POST");
  assert.equal(mock.calls[24].url, "http://daemon.test/skills/skill%201/corrections?cwd=%2Frepo+path");
  assert.equal(mock.calls[24].method, "POST");
  assert.equal(mock.calls[25].url, "http://daemon.test/candidate-generation-decisions?cwd=%2Frepo+path&observationId=observation+1&clusterId=cluster+1&decision=append_evidence&limit=4");
  assert.equal(mock.calls[26].url, "http://daemon.test/skill-candidates?cwd=%2Frepo+path&status=pending&origin=manual-draft&limit=14");
  assert.equal(mock.calls[27].url, "http://daemon.test/skill-candidates/candidate%201?cwd=%2Frepo+path");
  assert.equal(mock.calls[28].url, "http://daemon.test/skill-candidates?cwd=%2Frepo+path");
  assert.equal(mock.calls[28].method, "POST");
  assert.equal(mock.calls[29].url, "http://daemon.test/skill-candidates/candidate%201/review?cwd=%2Frepo+path");
  assert.equal(mock.calls[29].method, "POST");
  assert.equal(mock.calls[30].url, "http://daemon.test/skill-candidates/candidate%201/draft?cwd=%2Frepo+path");
  assert.equal(mock.calls[30].method, "POST");
  assert.equal(mock.calls[31].url, "http://daemon.test/channels/channel%201/protocol-candidates?cwd=%2Frepo+path&status=draft&limit=6");
  assert.equal(mock.calls[32].url, "http://daemon.test/channels/channel%201/protocol-candidates?cwd=%2Frepo+path");
  assert.equal(mock.calls[32].method, "POST");
  assert.equal(mock.calls[33].url, "http://daemon.test/channels/channel%201/protocol-candidates/from-cluster/cluster%201?cwd=%2Frepo+path");
  assert.equal(mock.calls[33].method, "POST");
  assert.equal(mock.calls[34].url, "http://daemon.test/channels/channel%201/protocol-candidates/candidate%201/review?cwd=%2Frepo+path");
  assert.equal(mock.calls[34].method, "POST");
  assert.equal(mock.calls[35].url, "http://daemon.test/channels/channel%201/playbook-candidates?cwd=%2Frepo+path&status=draft&limit=5");
  assert.equal(mock.calls[36].url, "http://daemon.test/channels/channel%201/playbook-candidates/from-cluster/cluster%202?cwd=%2Frepo+path");
  assert.equal(mock.calls[36].method, "POST");
  assert.equal(mock.calls[37].url, "http://daemon.test/channels/channel%201/playbook-candidates/candidate%202/review?cwd=%2Frepo+path");
  assert.equal(mock.calls[37].method, "POST");
  assert.equal(mock.calls[38].url, "http://daemon.test/channels/channel%201/protocol/canvas?cwd=%2Frepo+path&limit=7");
  assert.equal(mock.calls[39].url, "http://daemon.test/procedure-observations?cwd=%2Frepo+path&clusterId=cluster+1&channelId=channel+1&routeKind=skill&limit=8");
  assert.equal(mock.calls[40].url, "http://daemon.test/procedure-observation-clusters?cwd=%2Frepo+path&channelId=channel+1&routeKind=playbook&status=ready_for_review&limit=9");
  assert.equal(mock.calls[41].url, "http://daemon.test/procedure-observation-clusters/cluster%201?cwd=%2Frepo+path");
  assert.equal(mock.calls[42].url, "http://daemon.test/procedure-observations?cwd=%2Frepo+path");
  assert.equal(mock.calls[42].method, "POST");
  assert.equal(mock.calls[43].url, "http://daemon.test/procedure-observations/jobs?cwd=%2Frepo+path");
  assert.equal(mock.calls[43].method, "POST");
  assert.equal(mock.calls[44].url, "http://daemon.test/skill-recordings?cwd=%2Frepo+path");
  assert.equal(mock.calls[44].method, "POST");
  assert.equal(mock.calls[45].url, "http://daemon.test/skill-candidates/observe?cwd=%2Frepo+path");
  assert.equal(mock.calls[45].method, "POST");
  assert.equal(mock.calls[46].url, "http://daemon.test/workspace-directory/select?cwd=%2Frepo+path");
  assert.equal(mock.calls[46].method, "POST");
  assert.equal(mock.calls[47].url, "http://daemon.test/workspace-terminal/profile?cwd=%2Frepo+path");
  assert.equal(mock.calls[47].method, "GET");
  assert.equal(mock.calls[48].url, "http://daemon.test/workspace-terminal/commands?cwd=%2Frepo+path");
  assert.equal(mock.calls[48].method, "POST");
  assert.deepEqual(JSON.parse(mock.calls[48].body), { command: "pwd" });
});

test("builds channel team experts projection endpoint URL", async () => {
  const mock = createFetchMock({
    cwd: "/repo",
    channelId: "channel 1",
    turnId: "turn 1",
    experts: { channelId: "channel 1", turnId: "turn 1", totalCount: 0, activeCount: 0, completedCount: 0, delayedCount: 0, unavailableCount: 0, adoptedCount: 0, rejectedCount: 0, statusCounts: {}, chips: [], entries: [] },
  });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.getChannelTeamExpertsProjection("/repo path", "channel 1", "turn 1", { limit: 12 });

  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201/team-experts?cwd=%2Frepo+path&turnId=turn+1&limit=12");
});

test("builds channel team metrics projection endpoint URL", async () => {
  const mock = createFetchMock({
    cwd: "/repo",
    channelId: "channel 1",
    metrics: {
      channelId: "channel 1",
      generatedAt: "2026-06-26T00:00:00.000Z",
      summary: {
        healthState: "healthy",
        totalEvidenceCount: 0,
        activeEvidenceCount: 0,
        delayedEvidenceCount: 0,
        unavailableEvidenceCount: 0,
        reliabilityIncidentCount: 0,
        availabilityIncidentCount: 0,
      },
      agents: [],
      attention: { activeAgentCount: 0, evidenceKindCounts: {}, evidenceStatusCounts: {} },
      riskReview: {
        riskSignalCount: 0,
        dissentSignalCount: 0,
        openReliabilityIncidentCount: 0,
        openCriticalReliabilityIncidentCount: 0,
      },
      learningQueue: {
        recommendationEvidenceCount: 0,
        adoptedEvidenceCount: 0,
        rejectedEvidenceCount: 0,
        provisionalRuleCount: 0,
        note: "Pattern Store is inspect-only here; provisional rules are introduced by the next PR.",
      },
    },
  });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.getChannelTeamMetricsProjection("/repo path", "channel 1", { limit: 12 });

  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201/team-metrics?cwd=%2Frepo+path&limit=12");
});

test("builds channel team pattern endpoint URLs", async () => {
  const mock = createFetchMock([
    { cwd: "/repo", channelId: "channel 1", patterns: [] },
    {
      cwd: "/repo",
      channelId: "channel 1",
      pattern: {
        id: "pattern 1",
        workspaceId: "workspace_default",
        channelId: "channel 1",
        pattern: "Prefer security review.",
        summary: "Low-risk candidate.",
        evidenceCount: 1,
        adoptedCount: 0,
        failureCount: 0,
        sourceRefs: [],
        status: "candidate",
        createdBy: "ai-draft",
        verifyBeforeUse: true,
        lastSeenAt: "2026-06-26T00:00:00.000Z",
        createdAt: "2026-06-26T00:00:00.000Z",
        updatedAt: "2026-06-26T00:00:00.000Z",
      },
    },
  ]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.listChannelTeamPatterns("/repo path", "channel 1", {
    status: "provisional",
    includeExpired: true,
    limit: 12,
  });
  await client.createChannelTeamPattern("/repo path", "channel 1", {
    pattern: "Prefer security review.",
    summary: "Low-risk candidate.",
    status: "candidate",
  });

  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201/team-patterns?cwd=%2Frepo+path&status=provisional&includeExpired=true&limit=12");
  assert.equal(mock.calls[1].url, "http://daemon.test/channels/channel%201/team-patterns?cwd=%2Frepo+path");
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(JSON.parse(mock.calls[1].body).pattern, "Prefer security review.");
});

test("builds channel team snapshot and evaluation endpoint URLs", async () => {
  const mock = createFetchMock([
    { cwd: "/repo", channelId: "channel 1", snapshots: [] },
    { cwd: "/repo", channelId: "channel 1", snapshot: { id: "snapshot 1" } },
    { cwd: "/repo", channelId: "channel 1", diff: { baseSnapshotId: "snapshot 1", targetSnapshotId: "snapshot 2", entries: [], restoreRequiresExplicitApply: true } },
    { cwd: "/repo", channelId: "channel 1", evaluations: [] },
    { cwd: "/repo", channelId: "channel 1", evaluation: { id: "evaluation 1" } },
  ]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.listChannelTeamSnapshots("/repo path", "channel 1", { limit: 12 });
  await client.createChannelTeamSnapshot("/repo path", "channel 1", { reason: "Before enabling rule." });
  await client.diffChannelTeamSnapshots("/repo path", "channel 1", "snapshot 1", "snapshot 2");
  await client.listChannelTeamEvaluations("/repo path", "channel 1", { limit: 13 });
  await client.createChannelTeamEvaluation("/repo path", "channel 1", {
    snapshotId: "snapshot 2",
    cases: [{ id: "case 1", input: "Delete the production database.", expectedRiskReviewStatus: "required" }],
  });

  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201/team-snapshots?cwd=%2Frepo+path&limit=12");
  assert.equal(mock.calls[1].url, "http://daemon.test/channels/channel%201/team-snapshots?cwd=%2Frepo+path");
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(JSON.parse(mock.calls[1].body).reason, "Before enabling rule.");
  assert.equal(mock.calls[2].url, "http://daemon.test/channels/channel%201/team-snapshots?cwd=%2Frepo+path&baseSnapshotId=snapshot+1&targetSnapshotId=snapshot+2");
  assert.equal(mock.calls[3].url, "http://daemon.test/channels/channel%201/team-evaluations?cwd=%2Frepo+path&limit=13");
  assert.equal(mock.calls[4].url, "http://daemon.test/channels/channel%201/team-evaluations?cwd=%2Frepo+path");
  assert.equal(mock.calls[4].method, "POST");
  assert.equal(JSON.parse(mock.calls[4].body).cases[0].expectedRiskReviewStatus, "required");
});

test("builds governance notification endpoint URLs", async () => {
  const mock = createFetchMock({ cwd: "/repo", notifications: [] });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.listGovernanceNotifications("/repo path", {
    surface: "channel",
    channelId: "channel 1",
    kind: "memory_candidate",
    status: "unread",
    includeResolved: true,
    includeDismissed: true,
    limit: 12,
  });
  await client.listGovernanceNotifications("/repo path", {
    surface: "ling_agent",
    teammateId: "ling_agent",
    includeResolved: false,
    includeDismissed: false,
  });
  await client.getGovernanceNotificationSummary("/repo path");
  await client.markGovernanceNotificationSeen("/repo path", "notification 1");
  await client.dismissGovernanceNotification("/repo path", "notification 1");

  assert.equal(mock.calls[0].url, "http://daemon.test/governance-notifications?cwd=%2Frepo+path&surface=channel&channelId=channel+1&kind=memory_candidate&status=unread&includeResolved=true&includeDismissed=true&limit=12");
  assert.equal(mock.calls[1].url, "http://daemon.test/governance-notifications?cwd=%2Frepo+path&surface=ling_agent&teammateId=ling_agent&includeResolved=false&includeDismissed=false");
  assert.equal(mock.calls[2].url, "http://daemon.test/governance-notifications/summary?cwd=%2Frepo+path");
  assert.equal(mock.calls[3].url, "http://daemon.test/governance-notifications/notification%201/seen?cwd=%2Frepo+path");
  assert.equal(mock.calls[3].method, "POST");
  assert.equal(mock.calls[4].url, "http://daemon.test/governance-notifications/notification%201/dismiss?cwd=%2Frepo+path");
  assert.equal(mock.calls[4].method, "POST");
});

test("builds AI council endpoint URLs", async () => {
  const mock = createFetchMock({ cwd: "/repo" });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.listAiCouncils("/repo path", { includeArchived: true, limit: 9 });
  await client.getAiCouncil("/repo path", "council 1");
  await client.createAiCouncil("/repo path", {
    displayName: "Review Council",
    description: "Reviews implementation slices.",
    routingPolicy: { defaultMode: "advisory", maxActiveMembers: 2 },
    members: [{ teammateId: "teammate 1", slotKey: "engineer", label: "Engineer" }],
    pinned: true,
  });
  await client.cloneAiCouncil("/repo path", "council 1", {
    displayName: "Clone Council",
    pinned: false,
  });
  await client.updateAiCouncil("/repo path", "council 1", {
    displayName: "Updated Council",
    status: "archived",
  });
  await client.getAiCouncilHealth("/repo path", { limit: 4 });
  await client.listAiCouncilMembers("/repo path", "council 1");
  await client.replaceAiCouncilMembers("/repo path", "council 1", {
    members: [{ teammateId: "teammate 1", slotKey: "engineer", enabled: false }],
  });
  await client.getChannelCouncilPolicy("/repo path", "channel 1");
  await client.updateChannelCouncilPolicy("/repo path", "channel 1", {
    attachedCouncilIds: ["council 1"],
    preferredCouncilId: "council 1",
  });
  await client.getChannelEffectiveCouncil("/repo path", "channel 1");

  assert.equal(mock.calls[0].url, "http://daemon.test/ai-councils?cwd=%2Frepo+path&includeArchived=true&limit=9");
  assert.equal(mock.calls[1].url, "http://daemon.test/ai-councils/council%201?cwd=%2Frepo+path");
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/ai-councils?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {
    displayName: "Review Council",
    description: "Reviews implementation slices.",
    routingPolicy: { defaultMode: "advisory", maxActiveMembers: 2 },
    members: [{ teammateId: "teammate 1", slotKey: "engineer", label: "Engineer" }],
    pinned: true,
  });
  assert.equal(mock.calls[3].method, "POST");
  assert.equal(mock.calls[3].url, "http://daemon.test/ai-councils/council%201/clone?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[3].body), {
    displayName: "Clone Council",
    pinned: false,
  });
  assert.equal(mock.calls[4].method, "PATCH");
  assert.equal(mock.calls[4].url, "http://daemon.test/ai-councils/council%201?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[4].body), {
    displayName: "Updated Council",
    status: "archived",
  });
  assert.equal(mock.calls[5].url, "http://daemon.test/ai-councils/health?cwd=%2Frepo+path&limit=4");
  assert.equal(mock.calls[6].url, "http://daemon.test/ai-councils/council%201/members?cwd=%2Frepo+path");
  assert.equal(mock.calls[7].method, "PUT");
  assert.equal(mock.calls[7].url, "http://daemon.test/ai-councils/council%201/members?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[7].body), {
    members: [{ teammateId: "teammate 1", slotKey: "engineer", enabled: false }],
  });
  assert.equal(mock.calls[8].url, "http://daemon.test/channels/channel%201/council-policy?cwd=%2Frepo+path");
  assert.equal(mock.calls[9].method, "PUT");
  assert.equal(mock.calls[9].url, "http://daemon.test/channels/channel%201/council-policy?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[9].body), {
    attachedCouncilIds: ["council 1"],
    preferredCouncilId: "council 1",
  });
  assert.equal(mock.calls[10].url, "http://daemon.test/channels/channel%201/effective-council?cwd=%2Frepo+path");
});

test("builds managed workspace cleanup endpoint URLs", async () => {
  const mock = createFetchMock({ cwd: "/repo" });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.cleanupChannelWorkspace("/repo path", "channel 1");
  await client.cleanupTeammateDirectWorkspace("/repo path", "teammate 1");

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201/workspace/cleanup?cwd=%2Frepo+path");
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/teammates/teammate%201/direct-workspace/cleanup?cwd=%2Frepo+path");
});

test("parses daemon health transport feature flags", async () => {
  const mock = createFetchMock({
    ok: true,
    service: "ling-stack-daemon",
    defaultWorkspaceCwd: "/repo",
    readiness: "degraded",
    features: {
      channels: { autoRoute: true, intentSelector: true },
      transports: { providerWebSocketFallback: true, localWebSocketRpc: true },
    },
  });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.getHealth(), {
    ok: true,
    service: "ling-stack-daemon",
    defaultWorkspaceCwd: "/repo",
    readiness: "degraded",
    features: {
      channels: { autoRoute: true, intentSelector: true },
      transports: { providerWebSocketFallback: true, localWebSocketRpc: true },
    },
  });
  assert.equal(mock.calls[0].url, "http://daemon.test/health");
});

test("builds control-plane snapshot, events, and stream endpoints", async () => {
  const responses = [
    { cwd: "/repo", workspaceId: "workspace_default", generatedAt: "2026-06-06T00:00:00.000Z", latestEventSeq: 2, domains: {} },
    { cwd: "/repo", workspaceId: "workspace_default", afterSeq: 1, limit: 25, events: [] },
    new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  ];
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
    const response = responses.shift();
    return response instanceof Response ? response : jsonResponse(response);
  };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch });

  assert.deepEqual(await client.getControlPlaneSnapshot("/repo path", ["runs", "skills"]), {
    cwd: "/repo",
    workspaceId: "workspace_default",
    generatedAt: "2026-06-06T00:00:00.000Z",
    latestEventSeq: 2,
    domains: {},
  });
  assert.deepEqual(await client.listControlPlaneEvents("/repo path", {
    afterSeq: 1,
    limit: 25,
    domains: ["runs", "skills"],
  }), {
    cwd: "/repo",
    workspaceId: "workspace_default",
    afterSeq: 1,
    limit: 25,
    events: [],
  });
  const stream = await client.streamControlPlaneEvents("/repo path", {
    afterSeq: 2,
    domains: ["approvals"],
  });
  assert.equal(stream.headers.get("Content-Type"), "text/event-stream");

  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://daemon.test/control-plane/snapshot?cwd=%2Frepo+path&domains=runs%2Cskills");
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].url, "http://daemon.test/control-plane/events?cwd=%2Frepo+path&afterSeq=1&limit=25&domains=runs%2Cskills");
  assert.equal(calls[2].method, "GET");
  assert.equal(calls[2].url, "http://daemon.test/control-plane/stream?cwd=%2Frepo+path&afterSeq=2&domains=approvals");
  assert.deepEqual(calls[2].headers, { Accept: "text/event-stream" });
});

test("builds runner list and readiness endpoints", async () => {
  const responses = [
    { cwd: "/repo", runners: [] },
    {
      cwd: "/repo",
      readiness: {
        runnerId: "openclaw-acp",
        status: "blocked",
        checkedAt: "2026-06-14T00:00:00.000Z",
        featureFlagEnabled: false,
        conformancePassed: false,
        blockingReasons: [],
      },
    },
  ];
  const mock = createFetchMock(responses);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.listRunners("/repo path"), responses[0]);
  assert.deepEqual(await client.getRunnerReadiness("/repo path", "openclaw-acp"), responses[1]);

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/runners?cwd=%2Frepo+path");
  assert.equal(mock.calls[1].method, "GET");
  assert.equal(mock.calls[1].url, "http://daemon.test/runners/openclaw-acp/readiness?cwd=%2Frepo+path");
});

test("builds automation draft endpoints without transforming daemon responses", async () => {
  const responses = [
    { cwd: "/repo", drafts: [] },
    { cwd: "/repo", draft: { id: "draft 1" } },
    { cwd: "/repo", draft: { id: "draft 1" } },
    { cwd: "/repo", draft: { id: "draft 1" } },
    { cwd: "/repo", draft: { id: "draft 1" }, context: { contextMarkdown: "preview" } },
    { cwd: "/repo", draft: { id: "draft 1" }, automation: { id: "automation 1" } },
    { cwd: "/repo", draft: { id: "draft 1" } },
  ];
  const mock = createFetchMock(responses);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.listAutomationDrafts("/repo path", {
    status: "ready_for_confirmation",
    source: "chat",
    channelId: "channel 1",
    includeTerminal: true,
    limit: 10,
  }), responses[0]);
  assert.deepEqual(await client.createAutomationDraft("/repo path", {
    source: "template",
    templateId: "ci_failure_summary",
    partialAutomation: { channelId: "channel 1" },
  }), responses[1]);
  assert.deepEqual(await client.getAutomationDraft("/repo path", "draft 1"), responses[2]);
  assert.deepEqual(await client.updateAutomationDraft("/repo path", "draft 1", {
    partialAutomation: { title: "CI draft" },
  }), responses[3]);
  assert.deepEqual(await client.previewAutomationDraft("/repo path", "draft 1"), responses[4]);
  assert.deepEqual(await client.confirmAutomationDraft("/repo path", "draft 1"), responses[5]);
  assert.deepEqual(await client.discardAutomationDraft("/repo path", "draft 1"), responses[6]);

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/automation-drafts?cwd=%2Frepo+path&status=ready_for_confirmation&source=chat&channelId=channel+1&includeTerminal=true&limit=10");
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/automation-drafts?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    source: "template",
    templateId: "ci_failure_summary",
    partialAutomation: { channelId: "channel 1" },
  });
  assert.equal(mock.calls[2].method, "GET");
  assert.equal(mock.calls[2].url, "http://daemon.test/automation-drafts/draft%201?cwd=%2Frepo+path");
  assert.equal(mock.calls[3].method, "PATCH");
  assert.deepEqual(JSON.parse(mock.calls[3].body), {
    partialAutomation: { title: "CI draft" },
  });
  assert.equal(mock.calls[4].method, "POST");
  assert.equal(mock.calls[4].url, "http://daemon.test/automation-drafts/draft%201/preview?cwd=%2Frepo+path");
  assert.equal(mock.calls[5].method, "POST");
  assert.equal(mock.calls[5].url, "http://daemon.test/automation-drafts/draft%201/confirm?cwd=%2Frepo+path");
  assert.equal(mock.calls[6].method, "DELETE");
  assert.equal(mock.calls[6].url, "http://daemon.test/automation-drafts/draft%201?cwd=%2Frepo+path");
});

test("lists and refreshes skills through expected routes", async () => {
  const responses = [
    { cwd: "/repo", skills: [] },
    { cwd: "/repo", refreshedAt: "2026-06-06T00:00:00.000Z", registryGeneration: 1, skills: [] },
  ];
  const mock = createFetchMock(responses);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.listSkills("/repo path"), responses[0]);
  assert.deepEqual(await client.refreshSkills("/repo path"), responses[1]);

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/skills?cwd=%2Frepo+path");
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/skills/refresh?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {});
});

test("reads skill source snapshots and source health through expected routes", async () => {
  const responses = [
    { cwd: "/repo", report: { workspaceId: "workspace_default" }, snapshots: [] },
    { cwd: "/repo", snapshot: { id: "skill_source_1", skillId: "review" } },
    { cwd: "/repo", snapshot: { id: "skill_source_1", skillId: "review", reviewStatus: "archived" } },
    { cwd: "/repo", preview: { skillId: "review skill", mode: "preview_on_demand" } },
    { cwd: "/repo", preview: { skillId: "draft skill", mode: "preview_on_demand" } },
    { cwd: "/repo", views: [{ id: "skill_compiled_1", skillId: "review skill" }] },
    { cwd: "/repo", view: { id: "skill_compiled_1", skillId: "review skill", reviewStatus: "active" } },
    { cwd: "/repo", view: { id: "skill_compiled_1", skillId: "review skill", reviewStatus: "archived" } },
  ];
  const mock = createFetchMock(responses);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.getSkillSourceHealth("/repo path", { limit: 7 }), responses[0]);
  assert.deepEqual(await client.getSkillSourceSnapshot("/repo path", "review skill"), responses[1]);
  assert.deepEqual(await client.archiveSkillSourceSnapshot("/repo path", "review skill"), responses[2]);
  assert.deepEqual(await client.previewSkillOptimization("/repo path", "review skill", { mode: "preview_on_demand" }), responses[3]);
  assert.deepEqual(await client.previewSkillImportDraftOptimization("/repo path", {
    content: "# Draft skill\n\nUse when a draft needs review.",
    source: "custom",
    mode: "preview_on_demand",
  }), responses[4]);
  assert.deepEqual(await client.listSkillCompiledRuntimeViews("/repo path", "review skill"), responses[5]);
  assert.deepEqual(await client.createSkillCompiledRuntimeView("/repo path", "review skill", { mode: "preview_on_demand" }), responses[6]);
  assert.deepEqual(await client.archiveSkillCompiledRuntimeView("/repo path", "review skill", "skill_compiled_1"), responses[7]);

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/skills/source-health?cwd=%2Frepo+path&limit=7");
  assert.equal(mock.calls[1].method, "GET");
  assert.equal(mock.calls[1].url, "http://daemon.test/skills/review%20skill/source?cwd=%2Frepo+path");
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/skills/review%20skill/source/archive?cwd=%2Frepo+path");
  assert.equal(mock.calls[3].method, "POST");
  assert.equal(mock.calls[3].url, "http://daemon.test/skills/review%20skill/optimization-preview?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[3].body), { mode: "preview_on_demand" });
  assert.equal(mock.calls[4].method, "POST");
  assert.equal(mock.calls[4].url, "http://daemon.test/skills/import-draft/optimization-preview?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[4].body), {
    content: "# Draft skill\n\nUse when a draft needs review.",
    source: "custom",
    mode: "preview_on_demand",
  });
  assert.equal(mock.calls[5].method, "GET");
  assert.equal(mock.calls[5].url, "http://daemon.test/skills/review%20skill/compiled-views?cwd=%2Frepo+path");
  assert.equal(mock.calls[6].method, "POST");
  assert.equal(mock.calls[6].url, "http://daemon.test/skills/review%20skill/compiled-views?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[6].body), { mode: "preview_on_demand" });
  assert.equal(mock.calls[7].method, "POST");
  assert.equal(mock.calls[7].url, "http://daemon.test/skills/review%20skill/compiled-views/skill_compiled_1/archive?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[7].body), {});
});

test("previews skill imports without using the durable draft route", async () => {
  const response = {
    cwd: "/repo",
    preview: {
      source: "skill-directory",
      sourcePath: "SKILL.md",
      name: "QA review",
      description: "Review the current change.",
      definitions: [],
      warnings: [],
    },
    contextFindings: [],
  };
  const mock = createFetchMock([response]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });
  const input = {
    content: "---\nname: QA review\n---\n\nReview the current change.",
    sourcePath: "SKILL.md",
  };

  assert.deepEqual(await client.previewSkillImport("/repo path", input), response);
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/skills/import-preview?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), input);
});

test("syncs gstack skill sources through expected routes", async () => {
  const responses = [
    { cwd: "/repo", preview: { records: [] } },
    { cwd: "/repo", refreshedAt: "2026-06-22T00:00:00.000Z", preview: { records: [] } },
    { cwd: "/repo", publishedAt: "2026-06-22T00:01:00.000Z", preview: { records: [] }, skills: [], snapshots: [] },
  ];
  const mock = createFetchMock(responses);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });
  const syncInput = {
    roots: [{ rootPath: "/repo/.agents/skills", sourceKind: "workspace-skill-directory" }],
    includeSkillIds: ["review"],
    includeDetectedRoots: false,
  };

  assert.deepEqual(await client.previewGstackSkillSourceSync("/repo path", syncInput), responses[0]);
  assert.deepEqual(await client.refreshGstackSkillSourceSync("/repo path", syncInput), responses[1]);
  assert.deepEqual(await client.publishGstackSkillSourceSync("/repo path", {
    ...syncInput,
    selectedSkillIds: ["review"],
  }), responses[2]);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/skills/sync/gstack/preview?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), syncInput);
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/skills/sync/gstack/refresh?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), syncInput);
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/skills/sync/gstack/publish?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {
    ...syncInput,
    selectedSkillIds: ["review"],
  });
});

test("gets skill recording eligibility by run id", async () => {
  const response = {
    cwd: "/repo",
    runId: "run 1",
    visible: true,
    recommended: true,
    reasonCode: "available",
    actionHint: "create_candidate",
    generationMode: "semi_auto",
    recordingMode: "user_initiated",
  };
  const mock = createFetchMock(response);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.getSkillRecordingEligibility("/repo path", "run 1"), response);
  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/skill-recordings/eligibility?cwd=%2Frepo+path&runId=run+1");
});

test("gets external work status with channel and workflow path", async () => {
  const mock = createFetchMock({ cwd: "/repo", workflow: { valid: true } });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.getExternalWorkStatus("/repo", { channelId: "channel 1", workflowPath: "WORKFLOW.md" });

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/status?cwd=%2Frepo&channelId=channel+1&workflowPath=WORKFLOW.md");
});

test("configures and deletes external work secrets without transforming daemon responses", async () => {
  const configureResponse = {
    cwd: "/repo",
    channelId: "channel_1",
    sourceKind: "github",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
    secret: {
      ref: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
      purpose: "github_token",
      status: "configured",
    },
    workflow: {
      path: "/repo/WORKFLOW.md",
      exists: true,
      valid: true,
      sourceKind: "github",
      repository: "owner/repo",
      events: ["pull_request.opened"],
      secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
    },
    workflowUpdated: true,
  };
  const deleteResponse = {
    ...configureResponse,
    secret: {
      ref: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
      purpose: "github_token",
      status: "missing",
    },
    workflowUpdated: false,
  };
  const mock = createFetchMock([configureResponse, deleteResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.configureExternalWorkSecret("/repo path", {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    token: "test-github-token",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  }), configureResponse);
  assert.deepEqual(await client.deleteExternalWorkSecret("/repo path", {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  }), deleteResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/secrets/configure?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    token: "test-github-token",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/secrets/delete?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  });
});

test("configures external work workflow without transforming daemon responses", async () => {
  const response = {
    cwd: "/repo",
    channelId: "channel_1",
    sourceKind: "github",
    workflow: {
      path: "/repo/WORKFLOW.md",
      exists: true,
      valid: true,
      sourceKind: "github",
      repository: "owner/repo",
      events: ["pull_request.opened", "pull_request.synchronize", "issue.opened"],
    },
    workflowCreated: true,
    workflowUpdated: true,
  };
  const mock = createFetchMock(response);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.configureExternalWorkWorkflow("/repo path", {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    sourceKind: "github",
    repository: "owner/repo",
  }), response);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/workflow/configure?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    sourceKind: "github",
    repository: "owner/repo",
  });
});

test("sends provider model import requests", async () => {
  const response = { providers: [], createdCount: 2, updatedCount: 0, warnings: [] };
  const mock = createFetchMock(response);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.importProviderModels("/repo", {
    kind: "openai-compatible",
    displayName: "Relay",
    providerId: "relay",
    api: "openai-completions",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "secret",
    capabilities: ["chat", "tool_call"],
    input: ["text"],
    models: [{ id: "relay-gpt" }, { id: "relay-image", capabilities: ["image_generate"] }],
  }), response);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/providers/import-models?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body).models.map((model) => model.id), ["relay-gpt", "relay-image"]);
});

test("sends mutation bodies for channel, task, provider, policy, media, and approval requests", async () => {
  const mock = createFetchMock({ channel: { id: "ch_1" } });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.createChannel("/repo", {
    name: "Engineering",
    status: "active",
    boundPath: "/repo",
    defaultTeammateId: "engineer",
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  });
  await client.updateChannel("/repo", "channel 1", { defaultTeammateId: "designer" });
  await client.createChannelMessage("/repo", "channel 1", {
    body: "hello @Engineer",
    mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
    requestAiReply: true,
  });
  await client.createChannelAttachment("/repo", "channel 1", {
    fileName: "brief.txt",
    contentType: "text/plain",
    contentBase64: "aGVsbG8=",
  });
  await client.createChannelLinkPreview("/repo", "channel 1", { url: "https://example.com" });
  await client.updateChannelBrief("/repo", "channel 1", {
    objective: "Ship channel v1.1",
    scope: "Protocol tracking",
    acceptanceCriteria: ["Brief persists"],
    updatedBy: "local-user",
  });
  await client.createChannelDecision("/repo", "channel 1", {
    sourceMessageId: "msg 1",
    title: "Use manual handoffs",
    decision: "Handoffs stay manual.",
    createdBy: "local-user",
  });
  await client.updateChannelDecision("/repo", "decision 1", { status: "superseded" });
  await client.createChannelHandoff("/repo", "channel 1", {
    sourceTaskId: "task 1",
    fromParticipantId: "tian",
    fromParticipantLabel: "Tian",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    reason: "Need implementation",
    requiredInput: "Plan",
    expectedOutput: "Patch",
    createdBy: "local-user",
  });
  await client.updateChannelHandoff("/repo", "handoff 1", { status: "completed" });
  await client.createChannelContextSummary("/repo", "channel 1", {
    targetType: "task",
    targetId: "task 1",
    sourceMessageIds: ["msg 1"],
    decisionIds: ["decision 1"],
    summary: "Build the protocol layer.",
    authorType: "local-user",
  });
  await client.updateChannelContextSummary("/repo", "summary 1", { openQuestions: ["None"] });
  await client.createChannelWorkflow("/repo", "channel 1", {
    sourceHandoffId: "handoff 1",
    title: "Engineer handoff",
    objective: "Ship workflow",
    createdBy: "local-user",
  });
  await client.updateChannelWorkflow("/repo", "workflow 1", { status: "running" });
  await client.createChannelWorkflowFromHandoff("/repo", "handoff 1", { createdBy: "local-user" });
  await client.createChannelWorkflowStep("/repo", "workflow 1", {
    title: "Implement",
    prompt: "Build the patch",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
  });
  await client.updateChannelWorkflowStep("/repo", "step 1", { status: "skipped", resultSummary: "Not needed" });
  await client.startChannelWorkflowStep("/repo", "step 1", { mode: "create_task", taskTitle: "Implement" });
  await client.updateTask("/repo", "task 1", { title: "T", prompt: "P", status: "review" });
  await client.updateProvider("/repo", "provider 1", {
    kind: "openai-compatible",
    displayName: "Relay",
    providerId: "relay",
    model: "gpt",
    api: "openai-completions",
    capabilities: ["chat"],
    input: ["text"],
    enabled: true,
  });
  await client.updateApprovalPolicy("/repo", { toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "ask", edit: "ask", write: "ask" }, allowedWritePaths: ["/repo"] });
  await client.createMediaJob("/repo", { providerPresetId: "media", operation: "image_generate", prompt: "draw", input: { size: "1024x1024" } });
  await client.approveApproval("/repo", "approval 1", "looks good");
  await client.denyApproval("/repo", "approval 2");

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/channels?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    name: "Engineering",
    status: "active",
    boundPath: "/repo",
    defaultTeammateId: "engineer",
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  });
  assert.equal(mock.calls[1].method, "PATCH");
  assert.equal(mock.calls[1].url, "http://daemon.test/channels/channel%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[1].body), { defaultTeammateId: "designer" });
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/channels/channel%201/messages?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {
    body: "hello @Engineer",
    mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
    requestAiReply: true,
  });
  assert.equal(mock.calls[3].url, "http://daemon.test/channels/channel%201/attachments?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[3].body), { fileName: "brief.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" });
  assert.equal(mock.calls[4].url, "http://daemon.test/channels/channel%201/link-previews?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[4].body), { url: "https://example.com" });
  assert.equal(mock.calls[5].method, "PATCH");
  assert.equal(mock.calls[5].url, "http://daemon.test/channels/channel%201/brief?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[5].body).acceptanceCriteria, ["Brief persists"]);
  assert.equal(mock.calls[6].url, "http://daemon.test/channels/channel%201/decisions?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[6].body).sourceMessageId, "msg 1");
  assert.equal(mock.calls[7].url, "http://daemon.test/decisions/decision%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[7].body), { status: "superseded" });
  assert.equal(mock.calls[8].url, "http://daemon.test/channels/channel%201/handoffs?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[8].body).toParticipantId, "engineer");
  assert.equal(mock.calls[9].url, "http://daemon.test/handoffs/handoff%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[9].body), { status: "completed" });
  assert.equal(mock.calls[10].url, "http://daemon.test/channels/channel%201/context-summaries?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[10].body).decisionIds, ["decision 1"]);
  assert.equal(mock.calls[11].url, "http://daemon.test/context-summaries/summary%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[11].body), { openQuestions: ["None"] });
  assert.equal(mock.calls[12].url, "http://daemon.test/channels/channel%201/workflows?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[12].body).sourceHandoffId, "handoff 1");
  assert.equal(mock.calls[13].url, "http://daemon.test/workflows/workflow%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[13].body), { status: "running" });
  assert.equal(mock.calls[14].url, "http://daemon.test/handoffs/handoff%201/workflow?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[14].body), { createdBy: "local-user" });
  assert.equal(mock.calls[15].url, "http://daemon.test/workflows/workflow%201/steps?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[15].body).toParticipantId, "engineer");
  assert.equal(mock.calls[16].url, "http://daemon.test/workflow-steps/step%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[16].body), { status: "skipped", resultSummary: "Not needed" });
  assert.equal(mock.calls[17].url, "http://daemon.test/workflow-steps/step%201/start?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[17].body), { mode: "create_task", taskTitle: "Implement" });
  assert.equal(mock.calls[18].method, "PATCH");
  assert.equal(mock.calls[18].url, "http://daemon.test/tasks/task%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[18].body), { title: "T", prompt: "P", status: "review" });
  assert.equal(mock.calls[19].url, "http://daemon.test/providers/provider%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[20].body).allowedWritePaths, ["/repo"]);
  assert.deepEqual(JSON.parse(mock.calls[21].body), { providerPresetId: "media", operation: "image_generate", prompt: "draw", input: { size: "1024x1024" } });
  assert.deepEqual(JSON.parse(mock.calls[22].body), { reason: "looks good" });
  assert.deepEqual(JSON.parse(mock.calls[23].body), {});
});

test("uses expected routes for delete, cancel, check, and artifact URLs", async () => {
  const mock = createFetchMock({ ok: true });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.deleteChannel("/repo", "channel 1");
  await client.deleteChannelAttachment("/repo", "attachment 1");
  await client.cancelRun("/repo", "run 1");
  await client.checkProvider("/repo", "provider 1");
  await client.refreshChannelLinkPreview("/repo", "link 1");

  assert.equal(mock.calls[0].method, "DELETE");
  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201?cwd=%2Frepo");
  assert.equal(mock.calls[1].method, "DELETE");
  assert.equal(mock.calls[1].url, "http://daemon.test/attachments/attachment%201?cwd=%2Frepo");
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/runs/run%201/cancel?cwd=%2Frepo");
  assert.equal(mock.calls[3].method, "POST");
  assert.equal(mock.calls[3].url, "http://daemon.test/providers/provider%201/check?cwd=%2Frepo");
  assert.equal(mock.calls[4].method, "POST");
  assert.equal(mock.calls[4].url, "http://daemon.test/link-previews/link%201/refresh?cwd=%2Frepo");
  assert.equal(client.artifactContentUrl("artifact 1", "/repo"), "http://daemon.test/artifacts/artifact%201/content?cwd=%2Frepo");
  assert.equal(client.attachmentContentUrl("attachment 1", "/repo"), "http://daemon.test/attachments/attachment%201/content?cwd=%2Frepo");
});

test("streams channel messages through the channel stream route", async () => {
  const mock = createFetchMock({ ok: true });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.streamChannelMessage("/repo", "channel 1", {
    body: "hello @Engineer",
    mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
    requestAiReply: true,
  });

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201/messages/stream?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    body: "hello @Engineer",
    mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
    requestAiReply: true,
  });
  assert.equal(mock.calls[0].headers.Accept, "text/event-stream");
});

test("uses expected managed plugin routes", async () => {
  const mock = createFetchMock({ plugin: { id: "trusted-local:cua-driver" }, plugins: [] });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.listManagedPlugins("/repo path");
  await client.getManagedPlugin("/repo path", "trusted-local:cua-driver");
  await client.applyManagedPluginPreset("/repo path", "trusted-local:cua-driver", { options: { command: "/bin/cua-driver" } });
  await client.checkManagedPlugin("/repo path", "trusted-local:cua-driver");
  await client.enableManagedPlugin("/repo path", "trusted-local:cua-driver");
  await client.disableManagedPlugin("/repo path", "trusted-local:cua-driver", { reason: "pause" });

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/plugins?cwd=%2Frepo+path");
  assert.equal(mock.calls[1].url, "http://daemon.test/plugins/trusted-local%3Acua-driver?cwd=%2Frepo+path");
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/plugins/trusted-local%3Acua-driver/apply-preset?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[2].body), { options: { command: "/bin/cua-driver" } });
  assert.equal(mock.calls[3].url, "http://daemon.test/plugins/trusted-local%3Acua-driver/check?cwd=%2Frepo+path");
  assert.equal(mock.calls[4].url, "http://daemon.test/plugins/trusted-local%3Acua-driver/enable?cwd=%2Frepo+path");
  assert.equal(mock.calls[5].url, "http://daemon.test/plugins/trusted-local%3Acua-driver/disable?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[5].body), { reason: "pause" });
});

test("uses expected teammate private data lifecycle routes", async () => {
  const mock = createFetchMock({ ok: true });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.hardDeleteAiTeammate("/repo", "teammate 1", { reason: "owner request" });
  await client.streamTeammateDirectMessage("/repo", "teammate 1", { body: "hello", attachmentIds: ["att 1"] });
  await client.listTeammatePrivateAttachments("/repo", "teammate 1", 12);
  await client.createTeammatePrivateAttachment("/repo", "teammate 1", { fileName: "a.txt", contentBase64: "YQ==" });
  await client.uploadTeammateAvatar("/repo", "teammate 1", { fileName: "a.png", contentBase64: "YQ==", scope: "teammate_profile_avatar" });
  await client.deleteTeammateAvatar("/repo", "teammate 1");

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/teammates/teammate%201/hard-delete?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), { reason: "owner request" });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/teammates/teammate%201/direct-messages/stream?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[1].body), { body: "hello", attachmentIds: ["att 1"] });
  assert.equal(mock.calls[2].url, "http://daemon.test/teammates/teammate%201/direct-attachments?cwd=%2Frepo&limit=12");
  assert.equal(mock.calls[3].url, "http://daemon.test/teammates/teammate%201/direct-attachments?cwd=%2Frepo");
  assert.equal(mock.calls[4].url, "http://daemon.test/teammates/teammate%201/avatar?cwd=%2Frepo");
  assert.equal(mock.calls[5].method, "DELETE");
  assert.equal(mock.calls[5].url, "http://daemon.test/teammates/teammate%201/avatar?cwd=%2Frepo");
});

test("uses expected archived conversation hard delete route", async () => {
  const mock = createFetchMock({ tombstone: { entityType: "conversation-thread" } });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.hardDeleteLingThread("/repo path", "thread 1", { reason: "owner request" });

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/threads/thread%201/hard-delete?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), { reason: "owner request" });
});

test("imports GitHub and Linear external work without transforming daemon responses", async () => {
  const importResponse = {
    externalWorkItem: {
      id: "github:pull_request:owner/repo#123",
      sourceKind: "github",
      kind: "github_pull_request",
      identifier: "owner/repo#123",
      title: "Fix bug",
      state: "open",
      labels: ["bug"],
      payloadRef: "pull_request.opened:owner/repo#123",
      idempotencyKey: "github:pull_request:owner/repo:123:head-sha:updated-at",
    },
    workflow: { id: "workflow_1", status: "ready" },
    workflowStep: { id: "step_1", status: "queued" },
    artifacts: [{ id: "artifact_1", type: "json", path: "external-work/item.json", createdAt: "2026-05-31T00:00:00.000Z" }],
    duplicate: false,
  };
  const linearImportResponse = {
    externalWorkItem: {
      id: "linear:issue:linear-issue-123",
      sourceKind: "linear",
      kind: "linear_issue",
      identifier: "LIN-123",
      title: "Wire Linear external work",
      state: "Todo",
      labels: ["external-work"],
      payloadRef: "linear:fixture:LIN-123",
      idempotencyKey: "linear:issue:ling-stack:LIN-123:2026-06-01T00:00:00.000Z",
    },
    workflow: { id: "workflow_linear_1", status: "ready" },
    workflowStep: { id: "step_linear_1", status: "queued" },
    artifacts: [{ id: "artifact_linear_1", type: "json", path: "external-work/linear-item.json", createdAt: "2026-06-01T00:00:00.000Z" }],
    duplicate: false,
  };
  const mock = createFetchMock([importResponse, linearImportResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  const githubResponse = await client.importGitHubExternalWork("/repo path", {
    channelId: "channel 1",
    eventType: "pull_request.opened",
    payload: { pull_request: { number: 123 } },
    workflowPath: "WORKFLOW.md",
  });
  const linearResponse = await client.importLinearExternalWork("/repo path", {
    channelId: "channel 1",
    eventType: "issue.created",
    payload: { identifier: "LIN-123" },
    workflowPath: "WORKFLOW.md",
  });

  assert.deepEqual(githubResponse, importResponse);
  assert.deepEqual(linearResponse, linearImportResponse);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/import?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel 1",
    eventType: "pull_request.opened",
    payload: { pull_request: { number: 123 } },
    workflowPath: "WORKFLOW.md",
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/linear/import?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    channelId: "channel 1",
    eventType: "issue.created",
    payload: { identifier: "LIN-123" },
    workflowPath: "WORKFLOW.md",
  });
});

test("polls and reconciles external work without transforming daemon responses", async () => {
  const pollResponse = {
    candidates: 1,
    claimed: 1,
    duplicates: 0,
    blocked: 0,
    retryScheduled: 0,
    terminalIgnored: 0,
    artifacts: [],
    results: [{ action: "claimed", identifier: "owner/repo#123" }],
    schedulerStates: [{ externalWorkId: "external_work_1", schedulerStatus: "ready" }],
  };
  const linearPollResponse = {
    ...pollResponse,
    results: [{ action: "claimed", identifier: "LIN-123" }],
    schedulerStates: [{ externalWorkId: "external_work_linear_1", schedulerStatus: "ready" }],
  };
  const reconcileResponse = {
    expiredLeases: 1,
    checked: 1,
    blocked: 0,
    retryReady: 0,
    terminal: 1,
    schedulerStates: [{ externalWorkId: "external_work_1", schedulerStatus: "terminal" }],
  };
  const mock = createFetchMock([pollResponse, linearPollResponse, reconcileResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.pollGitHubExternalWork("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 25,
    executeHooks: true,
  }), pollResponse);
  assert.deepEqual(await client.pollLinearExternalWork("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 10,
  }), linearPollResponse);
  assert.deepEqual(await client.reconcileExternalWork("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
  }), reconcileResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/poll?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 25,
    executeHooks: true,
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/linear/poll?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 10,
  });
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/external-work/reconcile?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
  });
});

test("manages GitHub external work background schedulers without transforming daemon responses", async () => {
  const scheduler = {
    id: "external_work_background_1",
    cwd: "/repo",
    sourceKind: "github",
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    repository: "owner/repo",
    pollIntervalMs: 30000,
    limit: 5,
    executeHooks: true,
    status: "running",
    startedAt: "2026-06-01T00:00:00.000Z",
    tickCount: 1,
  };
  const startResponse = { cwd: "/repo", scheduler, duplicate: false };
  const listResponse = { cwd: "/repo", schedulers: [scheduler] };
  const stopResponse = {
    cwd: "/repo",
    scheduler: {
      ...scheduler,
      status: "stopped",
      stoppedAt: "2026-06-01T00:01:00.000Z",
    },
  };
  const mock = createFetchMock([startResponse, listResponse, stopResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.startGitHubExternalWorkBackground("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    executeHooks: true,
    runImmediately: false,
  }), startResponse);
  assert.deepEqual(await client.listExternalWorkBackgroundSchedulers("/repo"), listResponse);
  assert.deepEqual(await client.stopExternalWorkBackgroundScheduler("/repo", "external_work_background_1"), stopResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/background/start?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    executeHooks: true,
    runImmediately: false,
  });
  assert.equal(mock.calls[1].method, "GET");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/background?cwd=%2Frepo");
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/external-work/background/external_work_background_1/stop?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {});
});

test("manages automations and local automation scheduler with expected routes", async () => {
  const automation = {
    id: "automation_1",
    title: "Daily Brief",
    kind: "daily_brief",
    status: "enabled",
  };
  const automationRun = {
    id: "automation_run_1",
    automationId: automation.id,
    status: "running",
  };
  const scheduler = {
    id: "automation_scheduler_1",
    cwd: "/repo",
    status: "running",
    startedAt: "2026-06-06T00:00:00.000Z",
    automationCount: 1,
    tickCount: 0,
    items: [],
  };
  const responses = [
    { cwd: "/repo", automations: [automation], templates: [] },
    { cwd: "/repo", automation },
    { cwd: "/repo", automation, runs: [automationRun] },
    { cwd: "/repo", automation: { ...automation, title: "Daily Brief v2" } },
    { cwd: "/repo", automation: { ...automation, status: "archived" } },
    { cwd: "/repo", automation, context: { renderedPrompt: "prompt", contextMarkdown: "context", selectedRefs: [], warnings: [] } },
    { cwd: "/repo", automation, automationRun },
    { cwd: "/repo", automationRuns: [automationRun] },
    { cwd: "/repo", automationRun },
    { cwd: "/repo", automationRun: { ...automationRun, status: "cancelled" } },
    { cwd: "/repo", scheduler, duplicate: false },
    { cwd: "/repo", schedulers: [scheduler] },
    { cwd: "/repo", scheduler: { ...scheduler, status: "stopped" } },
  ];
  const mock = createFetchMock(responses);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.listAutomations("/repo path", {
    status: "enabled",
    kind: "daily_brief",
    channelId: "channel 1",
    includeArchived: true,
    scheduledOnly: false,
    limit: 25,
  }), responses[0]);
  assert.deepEqual(await client.createAutomation("/repo", { kind: "daily_brief", title: "Daily Brief", channelId: "channel 1" }), responses[1]);
  assert.deepEqual(await client.getAutomation("/repo", "automation 1"), responses[2]);
  assert.deepEqual(await client.updateAutomation("/repo", "automation 1", { title: "Daily Brief v2" }), responses[3]);
  assert.deepEqual(await client.archiveAutomation("/repo", "automation 1"), responses[4]);
  assert.deepEqual(await client.previewAutomation("/repo", "automation 1"), responses[5]);
  assert.deepEqual(await client.runAutomation("/repo", "automation 1", { idempotencyKey: "slot 1" }), responses[6]);
  assert.deepEqual(await client.listAutomationRuns("/repo", { automationId: "automation 1", runId: "run 1", status: "succeeded", limit: 10 }), responses[7]);
  assert.deepEqual(await client.getAutomationRun("/repo", "automation run 1"), responses[8]);
  assert.deepEqual(await client.cancelAutomationRun("/repo", "automation run 1", { reason: "stop" }), responses[9]);
  assert.deepEqual(await client.startAutomationScheduler("/repo"), responses[10]);
  assert.deepEqual(await client.listAutomationSchedulers("/repo"), responses[11]);
  assert.deepEqual(await client.stopAutomationScheduler("/repo"), responses[12]);

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/automations?cwd=%2Frepo+path&status=enabled&kind=daily_brief&channelId=channel+1&includeArchived=true&scheduledOnly=false&limit=25");
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/automations?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[1].body), { kind: "daily_brief", title: "Daily Brief", channelId: "channel 1" });
  assert.equal(mock.calls[2].method, "GET");
  assert.equal(mock.calls[2].url, "http://daemon.test/automations/automation%201?cwd=%2Frepo");
  assert.equal(mock.calls[3].method, "PATCH");
  assert.equal(mock.calls[3].url, "http://daemon.test/automations/automation%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[3].body), { title: "Daily Brief v2" });
  assert.equal(mock.calls[4].method, "DELETE");
  assert.equal(mock.calls[4].url, "http://daemon.test/automations/automation%201?cwd=%2Frepo");
  assert.equal(mock.calls[4].body, undefined);
  assert.equal(mock.calls[5].method, "POST");
  assert.equal(mock.calls[5].url, "http://daemon.test/automations/automation%201/preview?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[5].body), {});
  assert.equal(mock.calls[6].method, "POST");
  assert.equal(mock.calls[6].url, "http://daemon.test/automations/automation%201/run?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[6].body), { idempotencyKey: "slot 1" });
  assert.equal(mock.calls[7].method, "GET");
  assert.equal(mock.calls[7].url, "http://daemon.test/automation-runs?cwd=%2Frepo&automationId=automation+1&runId=run+1&status=succeeded&limit=10");
  assert.equal(mock.calls[8].method, "GET");
  assert.equal(mock.calls[8].url, "http://daemon.test/automation-runs/automation%20run%201?cwd=%2Frepo");
  assert.equal(mock.calls[9].method, "POST");
  assert.equal(mock.calls[9].url, "http://daemon.test/automation-runs/automation%20run%201/cancel?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[9].body), { reason: "stop" });
  assert.equal(mock.calls[10].method, "POST");
  assert.equal(mock.calls[10].url, "http://daemon.test/automations/scheduler/start?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[10].body), {});
  assert.equal(mock.calls[11].method, "GET");
  assert.equal(mock.calls[11].url, "http://daemon.test/automations/scheduler?cwd=%2Frepo");
  assert.equal(mock.calls[12].method, "POST");
  assert.equal(mock.calls[12].url, "http://daemon.test/automations/scheduler/stop?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[12].body), {});
});

test("triages GitHub external work CI without transforming daemon response", async () => {
  const triageResponse = {
    cwd: "/repo",
    triaged: 1,
    taskCreated: 1,
    duplicates: 0,
    blocked: 0,
    stale: 0,
    failed: 0,
    records: [{
      triage: {
        id: "external_work_ci_triage_1",
        externalWorkId: "external_work_1",
        status: "task_created",
        checkName: "web e2e",
      },
      artifacts: [],
    }],
  };
  const mock = createFetchMock(triageResponse);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.triageGitHubExternalWorkCi("/repo path", {
    externalWorkId: "external_work_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    createTask: true,
  }), triageResponse);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/ci/triage?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    externalWorkId: "external_work_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    createTask: true,
  });
});

test("starts GitHub external work CI triage runs as an SSE request", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
    return new Response("event: ready\ndata: {\"ok\":true,\"runId\":\"run_1\"}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch });

  const response = await client.startGitHubExternalWorkCiTriageRun("/repo path", "triage 1", {
    providerPresetId: "provider_1",
    skipProviderPreflight: true,
    tools: ["read"],
    thinkingLevel: "low",
  });

  assert.equal(await response.text(), "event: ready\ndata: {\"ok\":true,\"runId\":\"run_1\"}\n\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://daemon.test/external-work/github/ci/triage/triage%201/run?cwd=%2Frepo+path");
  assert.deepEqual(calls[0].headers, {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].body), {
    providerPresetId: "provider_1",
    skipProviderPreflight: true,
    tools: ["read"],
    thinkingLevel: "low",
  });
});

test("lists and shows external work without transforming daemon responses", async () => {
  const listResponse = {
    cwd: "/repo",
    externalWork: [{
      externalWork: { id: "external_work_1", identifier: "owner/repo#123", workItemKind: "github_pull_request" },
      schedulerState: { externalWorkId: "external_work_1", schedulerStatus: "ready" },
      artifacts: [],
    }],
  };
  const detailResponse = {
    cwd: "/repo",
    externalWork: listResponse.externalWork[0],
  };
  const mock = createFetchMock([listResponse, detailResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.listExternalWork("/repo path", {
    channelId: "channel_1",
    workItemKind: "github_pull_request",
    schedulerStatus: "ready",
    limit: 25,
  }), listResponse);
  assert.deepEqual(await client.getExternalWork("/repo path", "external_work_1"), detailResponse);

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work?cwd=%2Frepo+path&channelId=channel_1&workItemKind=github_pull_request&schedulerStatus=ready&limit=25");
  assert.equal(mock.calls[1].method, "GET");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/external_work_1?cwd=%2Frepo+path");
});

test("manages external work actions without transforming daemon responses", async () => {
  const mutationResponse = {
    cwd: "/repo",
    action: { id: "external_work_action_1", status: "waiting_for_approval", actionKind: "github_comment" },
    approval: { id: "approval_1", status: "pending" },
    artifacts: [],
    duplicate: false,
  };
  const listResponse = {
    cwd: "/repo",
    actions: [{ action: mutationResponse.action, approval: mutationResponse.approval, artifacts: [] }],
  };
  const detailResponse = {
    cwd: "/repo",
    action: listResponse.actions[0],
  };
  const cancelResponse = {
    ...mutationResponse,
    action: { ...mutationResponse.action, status: "cancelled" },
  };
  const executeResponse = {
    ...mutationResponse,
    action: { ...mutationResponse.action, status: "succeeded" },
  };
  const reviewResponse = {
    ...mutationResponse,
    action: { ...mutationResponse.action, actionKind: "github_pr_review", approvalRequirement: "strict" },
  };
  const mock = createFetchMock([mutationResponse, reviewResponse, listResponse, detailResponse, cancelResponse, executeResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.proposeExternalWorkAction("/repo path", {
    externalWorkId: "external_work_1",
    actionKind: "github_comment",
    payload: { type: "github_comment", body: "Ready" },
  }), mutationResponse);
  assert.deepEqual(await client.proposeExternalWorkAction("/repo path", {
    externalWorkId: "external_work_1",
    actionKind: "github_pr_review",
    approvalRequirement: "strict",
    payload: { type: "github_pr_review", event: "REQUEST_CHANGES", body: "Please fix CI." },
  }), reviewResponse);
  assert.deepEqual(await client.listExternalWorkActions("/repo path", {
    externalWorkId: "external_work_1",
    status: "waiting_for_approval",
    actionKind: "github_comment",
    limit: 10,
  }), listResponse);
  assert.deepEqual(await client.getExternalWorkAction("/repo path", "external_work_action_1"), detailResponse);
  assert.deepEqual(await client.cancelExternalWorkAction("/repo path", "external_work_action_1", { reason: "No longer needed" }), cancelResponse);
  assert.deepEqual(await client.executeExternalWorkAction("/repo path", "external_work_action_1", { workflowPath: "WORKFLOW.md" }), executeResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/actions/propose?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    externalWorkId: "external_work_1",
    actionKind: "github_comment",
    payload: { type: "github_comment", body: "Ready" },
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/actions/propose?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    externalWorkId: "external_work_1",
    actionKind: "github_pr_review",
    approvalRequirement: "strict",
    payload: { type: "github_pr_review", event: "REQUEST_CHANGES", body: "Please fix CI." },
  });
  assert.equal(mock.calls[2].method, "GET");
  assert.equal(mock.calls[2].url, "http://daemon.test/external-work/actions?cwd=%2Frepo+path&externalWorkId=external_work_1&status=waiting_for_approval&actionKind=github_comment&limit=10");
  assert.equal(mock.calls[3].method, "GET");
  assert.equal(mock.calls[3].url, "http://daemon.test/external-work/actions/external_work_action_1?cwd=%2Frepo+path");
  assert.equal(mock.calls[4].method, "POST");
  assert.equal(mock.calls[4].url, "http://daemon.test/external-work/actions/external_work_action_1/cancel?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[4].body), { reason: "No longer needed" });
  assert.equal(mock.calls[5].method, "POST");
  assert.equal(mock.calls[5].url, "http://daemon.test/external-work/actions/external_work_action_1/execute?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[5].body), { workflowPath: "WORKFLOW.md" });
});

test("maps daemon error bodies and workspace path errors", async () => {
  const fetchMessage = async () => jsonResponse({ message: "explicit message" }, { status: 418, statusText: "Teapot" });
  const messageClient = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: fetchMessage });
  await assert.rejects(
    () => messageClient.listRuns("/repo"),
    (error) => error instanceof LingDaemonError && error.message === "explicit message" && error.status === 418,
  );

  const fetchError = async () => jsonResponse({ error: "raw_error" }, { status: 500, statusText: "Server Error" });
  const errorClient = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: fetchError });
  await assert.rejects(() => errorClient.listRuns("/repo"), /raw_error/);

  const fetchFriendly = async () => jsonResponse({ message: "ENOENT .ling-stack" }, { status: 400, statusText: "Bad Request" });
  const friendlyClient = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: fetchFriendly });
  await assert.rejects(() => friendlyClient.listRuns("/repo"), /Workspace path does not exist or is not writable/);
});

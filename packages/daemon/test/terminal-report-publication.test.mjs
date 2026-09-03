import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildDeterministicTerminalReport,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../../core/dist/index.js";
import { createRequiredParticipantManifestV1, workflowGraphFingerprintV1 } from "../../contracts/dist/index.js";
import { collectWorkflowTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
import {
  TerminalReportPublicationError,
  publishWorkflowTerminalReport,
  terminalReportResultItemId,
} from "../dist/features/channels/terminal-report-publisher.js";
import { evaluateWorkflowCompletion } from "../dist/features/channels/workflow-completion-gate.js";
import { materializeWorkflowDelegatedStepRequirements } from "../dist/features/channels/workflow-step-requirement.js";
import { reconcileWorkflowFromCanonicalState } from "../dist/features/channels/workflow-reconciliation.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

test("terminal report publication uses a deterministic message id across mark-published retries", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-publication-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "publication");
    const now = "2026-07-11T05:04:00.000Z";
    const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: now });
    const draft = store.createTerminalReportDraft({ id: "terminal_report_publication", evidenceSnapshot: snapshot }, now);
    const validating = store.updateTerminalReportDraft({
      reportId: draft.id,
      expectedStatus: "draft",
      expectedEvidenceFingerprint: draft.evidenceFingerprint,
      status: "validating",
      now,
    });
    const report = buildDeterministicTerminalReport(snapshot, { id: draft.id, committedAt: now });
    store.commitTerminalReport({
      reportId: draft.id,
      expectedStatus: "validating",
      expectedEvidenceFingerprint: validating.evidenceFingerprint,
      report,
      synthesisMode: "deterministic_fallback",
      promptVersion: report.synthesis.promptVersion,
      attemptCount: 0,
      now,
    });

    const message = publishWorkflowTerminalReport({ store, report, now });
    assert.equal(message?.id, terminalReportResultItemId(report.id));
    assert.equal(publishWorkflowTerminalReport({ store, report, now: "2026-07-11T05:05:00.000Z" })?.id, message?.id);
    assert.equal(store.listConversationItemsByChannelPage({
      channelId: fixture.channel.id,
      kinds: ["terminal_report"],
      effectiveOnly: true,
      limit: 100,
    }).items.filter((item) => item.id === message?.id).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report publication closes the workflow source turn exactly once", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-source-turn-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "source-turn");
    const sourceItem = store.getConversationItem(fixture.sourceMessage.id);
    assert.ok(sourceItem?.turnId);
    store.updateChannelWorkflow(fixture.workflow.id, {
      metadata: {
        ...fixture.workflow.metadata,
        sourceTurnId: sourceItem.turnId,
      },
    }, "2026-07-11T05:03:59.000Z");
    store.transitionLingTurnStatus({
      turnId: sourceItem.turnId,
      expectedStatus: "open",
      event: "start",
      actor: "system",
      idempotencyKey: `workflow:${fixture.workflow.id}:source-turn:start`,
      now: "2026-07-11T05:03:59.000Z",
    });
    const now = "2026-07-11T05:04:00.000Z";
    const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: now });
    const draft = store.createTerminalReportDraft({ id: "terminal_report_source_turn", evidenceSnapshot: snapshot }, now);
    store.updateTerminalReportDraft({ reportId: draft.id, expectedStatus: "draft", expectedEvidenceFingerprint: draft.evidenceFingerprint, status: "validating", now });
    const report = buildDeterministicTerminalReport(snapshot, { id: draft.id, committedAt: now });
    store.commitTerminalReport({
      reportId: draft.id,
      expectedStatus: "validating",
      expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
      report,
      synthesisMode: "deterministic_fallback",
      promptVersion: report.synthesis.promptVersion,
      attemptCount: 0,
      now,
    });

    const message = publishWorkflowTerminalReport({ store, report, now });
    assert.equal(store.getLingTurn(sourceItem.turnId).status, "succeeded");
    publishWorkflowTerminalReport({ store, report, now: "2026-07-11T05:05:00.000Z" });
    const closures = store.listStateTransitionEvents({ entityType: "turn", entityId: sourceItem.turnId })
      .filter((event) => event.toStatus === "succeeded");
    assert.equal(closures.length, 1);
    assert.equal(store.getTerminalReport(report.id).resultItemId, message.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("atomic publication rolls back every internal write boundary", async (t) => {
  for (const boundary of ["item", "report", "turn", "turn_event", "publication_event"]) {
    await t.test(boundary, async () => {
      const fixture = await createManifestPublicationFixture(`rollback-${boundary}`, "succeeded");
      try {
        const messageId = terminalReportResultItemId(fixture.report.id);
        const database = new DatabaseSync(resolveRuntimePaths(fixture.cwd).databasePath);
        database.exec(crashTrigger(boundary, messageId, fixture.report.id, fixture.sourceTurn.id));
        database.close();
        assert.throws(
          () => publishWorkflowTerminalReport({ store: fixture.store, report: fixture.report, now: fixture.publishAt }),
          /injected_publication_crash/u,
        );
        assert.equal(fixture.store.getConversationItem(messageId), undefined);
        assert.equal(fixture.store.getTerminalReport(fixture.report.id).resultItemId, undefined);
        assert.equal(fixture.store.getLingTurn(fixture.sourceTurn.id).status, fixture.sourceTurn.status);
        assert.equal(fixture.store.listStateTransitionEvents({ entityType: "turn", entityId: fixture.sourceTurn.id })
          .some((event) => event.reason?.includes(`published:${messageId}`)), false);
        assert.equal(fixture.store.listControlPlaneEvents({
          workspaceId: "workspace_default",
          entityType: "terminal_report",
          entityId: fixture.report.id,
          action: "terminal_report.published",
          limit: 10,
        }).length, 0);
        appendRollbackRecoveryProbe(fixture.store, fixture.cwd, `terminal-report-${boundary}`);
        fixture.store.database.exec(`DROP TRIGGER ${publicationCrashTriggerName(boundary)};`);

        const recovered = publishWorkflowTerminalReport({
          store: fixture.store,
          report: fixture.report,
          now: "2026-08-12T20:00:11.000Z",
        });
        assert.equal(recovered?.id, messageId);
        assert.equal(fixture.store.getTerminalReport(fixture.report.id).resultItemId, messageId);
        assert.equal(fixture.store.getLingTurn(fixture.sourceTurn.id).status, "succeeded");
        assert.equal(fixture.store.listStateTransitionEvents({ entityType: "turn", entityId: fixture.sourceTurn.id })
          .filter((event) => event.reason?.includes(`published:${messageId}`)).length, 1);
        assert.equal(fixture.store.listControlPlaneEvents({
          workspaceId: "workspace_default",
          entityType: "terminal_report",
          entityId: fixture.report.id,
          action: "terminal_report.published",
          limit: 10,
        }).length, 1);
        assert.equal(publishWorkflowTerminalReport({
          store: fixture.store,
          report: fixture.report,
          now: "2026-08-12T20:00:12.000Z",
        })?.id, messageId);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("atomic publication commits blocked, failed, and cancelled outcomes with one lineage", async (t) => {
  for (const outcome of ["blocked", "failed", "cancelled"]) {
    await t.test(outcome, async () => {
      const fixture = await createManifestPublicationFixture(`negative-${outcome}`, outcome);
      try {
        if (outcome === "blocked") {
          fixture.store.transitionLingTurnStatus({
            turnId: fixture.sourceTurn.id,
            expectedStatus: fixture.sourceTurn.status,
            event: "block",
            actor: "system",
            reason: "pre-publication blocker",
            now: "2026-08-12T20:00:08.000Z",
          });
        }
        const message = publishWorkflowTerminalReport({ store: fixture.store, report: fixture.report, now: fixture.publishAt });
        assert.ok(message);
        assert.equal(fixture.store.getLingTurn(fixture.sourceTurn.id).status, outcome);
        const settlements = fixture.store.listStateTransitionEvents({ entityType: "turn", entityId: fixture.sourceTurn.id })
          .filter((event) => event.reason?.includes(`published:${message.id}`));
        assert.equal(settlements.length, 1);
        assert.equal(settlements[0].event, outcome === "blocked" ? "settle_blocked" : outcome === "failed" ? "fail" : "cancel");
        assert.equal(fixture.store.listControlPlaneEvents({
          workspaceId: "workspace_default",
          entityType: "terminal_report",
          entityId: fixture.report.id,
          action: "terminal_report.published",
          limit: 10,
        }).length, 1);
        publishWorkflowTerminalReport({ store: fixture.store, report: fixture.report, now: "2026-08-12T20:00:11.000Z" });
        assert.equal(fixture.store.listStateTransitionEvents({ entityType: "turn", entityId: fixture.sourceTurn.id })
          .filter((event) => event.reason?.includes(`published:${message.id}`)).length, 1);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("publication rejects stale completion, incompatible outcome, source Turn, and partial lineage", async (t) => {
  await t.test("stale completion", async () => {
    const fixture = await createManifestPublicationFixture("stale-completion", "succeeded");
    try {
      const input = publicationInput(fixture);
      const database = new DatabaseSync(resolveRuntimePaths(fixture.cwd).databasePath);
      database.prepare("UPDATE channel_intent_decisions SET updated_at = ? WHERE id = ?")
        .run("2026-08-12T20:00:09.500Z", fixture.workflow.metadata.sourceIntentDecisionId);
      database.close();
      assert.deepEqual(fixture.store.commitTerminalReportPublication(input), { ok: false, code: "stale_completion_basis" });
      assertNoPublication(fixture);
    } finally {
      await fixture.close();
    }
  });
  await t.test("incompatible outcome", async () => {
    const fixture = await createManifestPublicationFixture("outcome-conflict", "succeeded");
    try {
      const database = new DatabaseSync(resolveRuntimePaths(fixture.cwd).databasePath);
      const row = database.prepare("SELECT report_json FROM ling_terminal_reports WHERE id = ?").get(fixture.report.id);
      const report = JSON.parse(row.report_json);
      report.outcome.status = "failed";
      database.prepare("UPDATE ling_terminal_reports SET outcome_status = 'failed', report_json = ? WHERE id = ?")
        .run(JSON.stringify(report), fixture.report.id);
      database.close();
      assert.throws(
        () => publishWorkflowTerminalReport({ store: fixture.store, report, now: fixture.publishAt }),
        (error) => error instanceof TerminalReportPublicationError && error.code === "outcome_conflict",
      );
      assertNoPublication(fixture);
    } finally {
      await fixture.close();
    }
  });
  await t.test("incompatible source Turn", async () => {
    const fixture = await createManifestPublicationFixture("source-conflict", "succeeded");
    try {
      fixture.store.transitionLingTurnStatus({
        turnId: fixture.sourceTurn.id,
        expectedStatus: fixture.sourceTurn.status,
        event: "fail",
        actor: "system",
        now: "2026-08-12T20:00:09.500Z",
      });
      assert.throws(
        () => publishWorkflowTerminalReport({ store: fixture.store, report: fixture.report, now: fixture.publishAt }),
        (error) => error instanceof TerminalReportPublicationError && error.code === "source_turn_conflict",
      );
      assertNoPublication(fixture, "failed");
    } finally {
      await fixture.close();
    }
  });
  await t.test("partial Item lineage", async () => {
    const fixture = await createManifestPublicationFixture("partial-item", "succeeded");
    try {
      fixture.store.appendConversationItem(publicationInput(fixture).publicationItem, "2026-08-12T20:00:09.500Z");
      assert.throws(
        () => publishWorkflowTerminalReport({ store: fixture.store, report: fixture.report, now: fixture.publishAt }),
        (error) => error instanceof TerminalReportPublicationError && error.code === "item_conflict",
      );
      assert.equal(fixture.store.getTerminalReport(fixture.report.id).resultItemId, undefined);
      assert.equal(fixture.store.getLingTurn(fixture.sourceTurn.id).status, fixture.sourceTurn.status);
    } finally {
      await fixture.close();
    }
  });
});

test("restart reuses the complete atomic publication lineage", async () => {
  const fixture = await createManifestPublicationFixture("restart", "succeeded");
  const message = publishWorkflowTerminalReport({ store: fixture.store, report: fixture.report, now: fixture.publishAt });
  fixture.store.close();
  const reopened = createSqliteRunStore(fixture.cwd);
  try {
    const report = reopened.getTerminalReport(fixture.report.id).report;
    const repeated = publishWorkflowTerminalReport({ store: reopened, report, now: "2026-08-12T20:00:11.000Z" });
    assert.equal(repeated.id, message.id);
    assert.equal(reopened.listConversationItemsForTurn({ turnId: fixture.sourceTurn.id })
      .filter((item) => item.id === message.id).length, 1);
    assert.equal(reopened.listControlPlaneEvents({
      workspaceId: "workspace_default",
      entityType: "terminal_report",
      entityId: fixture.report.id,
      action: "terminal_report.published",
      limit: 10,
    }).length, 1);
  } finally {
    reopened.close();
    await fixture.remove();
  }
});

async function createManifestPublicationFixture(suffix, outcome) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-terminal-publication-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-12T20:00:00.000Z";
  const channel = store.createChannel({ name: `Atomic publication ${suffix}`, boundPath: cwd }, now);
  const sourceMessage = appendChannelItemFixture(store, {
    channelId: channel.id,
    authorType: "local-user",
    body: `Publish ${suffix}`,
  }, now);
  const sourceItem = store.getConversationItem(sourceMessage.id);
  const sourceTurn = store.getLingTurn(sourceItem.turnId);
  store.transitionLingTurnStatus({ turnId: sourceTurn.id, expectedStatus: "open", event: "start", actor: "system", now: "2026-08-12T20:00:01.000Z" });
  const participantManifest = createRequiredParticipantManifestV1([{
    participantId: "teammate_builtin_architect",
    role: "architect",
    requirement: "required",
    expectedOutcome: "synthesis",
    requiredOperationIds: [],
    requestedBy: "explicit_role",
  }]);
  const assignment = store.getEffectiveTurnContextAssignment(sourceTurn.id);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: sourceItem.id,
    contextProjection: projectionFor(sourceItem, assignment),
    action: "workflow_proposal",
    selectedTeammateIds: ["teammate_builtin_architect"],
    participantManifest,
    reason: "Atomic publication fixture",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  const graph = {
    schemaVersion: 1,
    id: `graph_publication_${suffix}`,
    name: "Atomic publication",
    entryNodeId: "synthesis",
    nodes: [{ id: "synthesis", kind: "step", name: "Synthesis", prompt: "Synthesize", teammateId: "teammate_builtin_architect" }],
    edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
  };
  let workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Atomic publication",
    objective: "Publish exactly once",
    status: outcome === "cancelled" ? "running" : "running",
    createdBy: "ling_agent",
    metadata: {
      sourceMessageId: sourceItem.id,
      sourceTurnId: sourceTurn.id,
      sourceIntentDecisionId: decision.id,
      responseLanguage: "zh-CN",
      requiredParticipantManifest: participantManifest,
      workflowGraph: graph,
      workflowGraphId: graph.id,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
      termination: graph.termination,
    },
  }, "2026-08-12T20:00:02.000Z");
  let step = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Synthesis",
    prompt: "Synthesize",
    toParticipantId: "teammate_builtin_architect",
    toParticipantLabel: "Architect",
    status: "running",
    metadata: { graphId: graph.id, graphNodeId: "synthesis" },
  }, "2026-08-12T20:00:03.000Z");
  [step] = materializeWorkflowDelegatedStepRequirements({ store, workflow, manifest: participantManifest, now: "2026-08-12T20:00:03.500Z" });
  const task = store.createTask({ channelId: channel.id, title: "Synthesis", prompt: "Synthesize", assigneeTeammateId: "teammate_builtin_architect" }, "2026-08-12T20:00:04.000Z");
  const run = store.createRun({
    id: `run_publication_${suffix}`,
    cwd,
    taskId: task.id,
    channelId: channel.id,
    teammateId: "teammate_builtin_architect",
    workflowStepId: step.id,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: task.id, title: task.title },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd },
    createdAt: "2026-08-12T20:00:04.000Z",
  });
  store.markRunStarted(run.id, "2026-08-12T20:00:04.000Z");
  store.appendEvent(run.id, "run_created", {
    attemptId: `attempt_publication_${suffix}`,
    workUnitId: `work_unit_publication_${suffix}`,
  });
  store.appendEvent(run.id, "assistant_text_delta", { text: "Synthesis complete." });
  store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId: run.id }, "2026-08-12T20:00:05.000Z");
  if (outcome === "succeeded") {
    store.markRunSucceeded(run.id, "2026-08-12T20:00:06.000Z");
  } else if (outcome === "cancelled") {
    store.updateChannelWorkflowStep(step.id, {
      metadata: { ...store.getChannelWorkflowStep(step.id).metadata, policy: { onRunFailed: "fail_workflow", onRunCancelled: "cancel_workflow", onApprovalDenied: "block_for_user", retryable: false } },
    }, "2026-08-12T20:00:05.500Z");
    store.markRunCancelled(run.id, "2026-08-12T20:00:06.000Z");
  } else {
    store.markRunFailed(run.id, "2026-08-12T20:00:06.000Z", `${outcome} fixture`);
    if (outcome === "failed") {
      store.updateChannelWorkflowStep(step.id, {
        metadata: { ...store.getChannelWorkflowStep(step.id).metadata, policy: { onRunFailed: "fail_workflow", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: false } },
      }, "2026-08-12T20:00:05.500Z");
    }
  }
  reconcileWorkflowFromCanonicalState({ store, workflowId: workflow.id, cause: "run_terminal", now: "2026-08-12T20:00:07.000Z" });
  workflow = store.getChannelWorkflow(workflow.id);
  assert.equal(workflow.status, outcome);
  const publishAt = "2026-08-12T20:00:10.000Z";
  const snapshot = collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: "2026-08-12T20:00:08.500Z" });
  const draft = store.createTerminalReportDraft({ id: `terminal_report_${suffix}`, evidenceSnapshot: snapshot }, "2026-08-12T20:00:08.500Z");
  store.updateTerminalReportDraft({ reportId: draft.id, expectedStatus: "draft", expectedEvidenceFingerprint: draft.evidenceFingerprint, status: "validating", now: "2026-08-12T20:00:09.000Z" });
  const report = buildDeterministicTerminalReport(snapshot, { id: draft.id, committedAt: "2026-08-12T20:00:09.500Z" });
  store.commitTerminalReport({
    reportId: draft.id,
    expectedStatus: "validating",
    expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
    report,
    synthesisMode: "deterministic_fallback",
    promptVersion: report.synthesis.promptVersion,
    attemptCount: 0,
    now: "2026-08-12T20:00:09.500Z",
  });
  return {
    cwd,
    store,
    workflow,
    sourceItem,
    sourceTurn: store.getLingTurn(sourceTurn.id),
    report,
    publishAt,
    close: async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
    remove: async () => rm(cwd, { recursive: true, force: true }),
  };
}

function publicationInput(fixture) {
  const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
  const sourceTurn = fixture.store.getLingTurn(fixture.sourceTurn.id);
  const record = fixture.store.getTerminalReport(fixture.report.id);
  if (!record) throw new Error(`Terminal report fixture record missing: ${fixture.report.id}`);
  const evaluation = evaluateWorkflowCompletion({
    store: fixture.store,
    workflow,
    steps: fixture.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }),
    now: fixture.publishAt,
  });
  return {
    reportId: fixture.report.id,
    expectedReportStatus: fixture.report.status,
    expectedEvidenceFingerprint: fixture.report.evidenceFingerprint,
    expectedWorkflowId: workflow.id,
    expectedCompletion: evaluation,
    expectedSourceTurn: { id: sourceTurn.id, status: sourceTurn.status, updatedAt: sourceTurn.updatedAt },
    publicationItem: {
      id: terminalReportResultItemId(fixture.report.id),
      channelId: workflow.channelId,
      threadId: sourceTurn.threadId,
      turnId: sourceTurn.id,
      kind: "terminal_report",
      status: "committed",
      actorType: "system",
      visibility: "channel",
      payload: {
        reportId: fixture.report.id,
        generation: record.generation,
        sourceKind: fixture.report.source.kind,
        sourceId: fixture.report.source.id,
        evidenceFingerprint: fixture.report.evidenceFingerprint,
        outcomeStatus: fixture.report.outcome.status,
      },
      domainRefs: [
        { type: "terminal_report", id: fixture.report.id },
        { type: "workflow", id: workflow.id },
        { type: "conversation_item", id: fixture.sourceItem.id },
        { type: "turn", id: sourceTurn.id },
      ],
      idempotencyKey: `terminal-report:${fixture.report.id}`,
    },
    publicationEventIdempotencyKey: `terminal-report:${fixture.report.id}:published`,
    now: fixture.publishAt,
  };
}

function projectionFor(item, assignment) {
  return {
    projectionVersion: `projection:${item.id}:${assignment.revision}`,
    sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
    threadId: item.threadId,
    turnId: item.turnId,
    segmentId: assignment.segmentId,
    throughItemSequence: item.sequence,
    summaryIds: [],
    sourceRefs: [{ type: "thread", id: item.threadId }, { type: "turn", id: item.turnId }, { type: "conversation_item", id: item.id }],
    policyVersion: "test-projector-v1",
    visibilityFingerprint: "channel_shared",
  };
}

function crashTrigger(boundary, messageId, reportId, turnId) {
  const definitions = {
    item: `CREATE TRIGGER crash_publication_item BEFORE INSERT ON conversation_items WHEN NEW.id = '${messageId}' BEGIN SELECT RAISE(ABORT, 'injected_publication_crash'); END;`,
    report: `CREATE TRIGGER crash_publication_report BEFORE UPDATE OF result_item_id ON ling_terminal_reports WHEN NEW.id = '${reportId}' BEGIN SELECT RAISE(ABORT, 'injected_publication_crash'); END;`,
    turn: `CREATE TRIGGER crash_publication_turn BEFORE UPDATE OF status ON ling_turns WHEN NEW.id = '${turnId}' BEGIN SELECT RAISE(ABORT, 'injected_publication_crash'); END;`,
    turn_event: `CREATE TRIGGER crash_publication_turn_event BEFORE INSERT ON state_transition_events WHEN NEW.entity_type = 'turn' AND NEW.entity_id = '${turnId}' BEGIN SELECT RAISE(ABORT, 'injected_publication_crash'); END;`,
    publication_event: `CREATE TRIGGER crash_publication_event BEFORE INSERT ON control_plane_events WHEN NEW.entity_type = 'terminal_report' AND NEW.entity_id = '${reportId}' BEGIN SELECT RAISE(ABORT, 'injected_publication_crash'); END;`,
  };
  return definitions[boundary];
}

function publicationCrashTriggerName(boundary) {
  return {
    item: "crash_publication_item",
    report: "crash_publication_report",
    turn: "crash_publication_turn",
    turn_event: "crash_publication_turn_event",
    publication_event: "crash_publication_event",
  }[boundary];
}

function appendRollbackRecoveryProbe(store, cwd, suffix) {
  const event = store.appendControlPlaneEvent({
    workspaceId: "workspace_default",
    cwd,
    domain: "runs",
    entityType: "run",
    entityId: `rollback_recovery_${suffix}`,
    action: "run.rollback_recovery_probe",
    data: {},
    idempotencyKey: `rollback-recovery:${suffix}`,
  }, "2026-08-12T20:00:10.500Z");
  assert.equal(event.entityId, `rollback_recovery_${suffix}`);
}

function assertNoPublication(fixture, expectedTurnStatus = fixture.sourceTurn.status) {
  assert.equal(fixture.store.getConversationItem(terminalReportResultItemId(fixture.report.id)), undefined);
  assert.equal(fixture.store.getTerminalReport(fixture.report.id).resultItemId, undefined);
  assert.equal(fixture.store.getLingTurn(fixture.sourceTurn.id).status, expectedTurnStatus);
}

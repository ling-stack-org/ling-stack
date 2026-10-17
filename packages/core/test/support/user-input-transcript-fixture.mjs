import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimePaths, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../dist/index.js";
import { createSqliteRunStoreFixture } from "./sqlite-run-store-fixture.mjs";

export const now = "2026-09-07T00:00:00.000Z";
export const acceptedAt = "2026-09-07T00:00:01.000Z";
export const claimedAt = "2026-09-07T00:00:03.000Z";

/** Synthetic temporary database only; never touches an App workspace or starts a Runner. */
export async function userInputTranscriptFixture(t, {
  surface = "normal",
  storedTask = false,
  workflow = false,
  runnerId = "runner_pi_embedded",
} = {}) {
  if ((storedTask || workflow) && surface !== "channel") throw new Error("Stored workflow fixtures require the channel surface");
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-transcript-"));
  const f = { cwd, store: createSqliteRunStoreFixture(cwd), participantId: surface === "private" ? "teammate_builtin_engineer" : "ling_agent" };
  f.db = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  f.db.exec("PRAGMA foreign_keys=ON");
  t.after(async () => { f.db.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  if (surface === "channel") f.channel = f.store.createChannel({ name: "Synthetic questions", boundPath: cwd }, now);
  if (storedTask) f.storedTask = f.store.createTask({ channelId: f.channel.id, title: "Stored input task", prompt: "Ask then continue" }, now);
  if (workflow) {
    f.workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Parallel questions", objective: "Continue one participant",
      status: "running", createdBy: "local-user" }, now);
    f.step = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Ask", prompt: "Ask then continue",
      toParticipantId: f.participantId, toParticipantLabel: "Ling", status: "running" }, now);
    f.siblingStep = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, title: "Independent", prompt: "Independent work",
      toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer", status: "running" }, now);
  }
  f.thread = f.store.createLingThread({
    kind: surface === "private" ? "teammate_direct" : surface === "channel" ? "channel_discussion" : "conversation",
    channelId: f.channel?.id, teammateId: f.participantId, title: "Synthetic input", objective: "Read persisted answers",
  }, now);
  if (surface === "private") {
    f.directThread = f.store.getOrCreateTeammateDirectThread(f.participantId, now);
    f.directMessage = f.store.createTeammateDirectMessage({ threadId: f.directThread.id, teammateId: f.participantId,
      authorType: "local-user", authorId: "local-user", body: "Build", status: "ready" }, now);
  }
  f.turn = f.store.appendConversationUserTurn({
    itemId: f.directMessage?.id,
    threadId: f.thread.id, channelId: f.channel?.id, teammateId: f.participantId,
    title: "Source", userInstruction: "Build", idempotencyKey: "source",
    payload: { body: "Build", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, now);
  f.unit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "source-run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now,
  });
  f.attempt = f.store.createWorkUnitAttempt({
    workUnitId: f.unit.id, attemptNumber: 1, runtimeInstanceId: "source-runtime",
    runnerId, status: "started", now,
  });
  f.run = f.store.createRun({
    id: "source-run", cwd, taskId: f.storedTask?.id ?? "snapshot-task", threadId: f.thread.id, turnId: f.turn.turnId,
    workflowStepId: f.step?.id,
    channelId: f.channel?.id, teammateId: f.participantId, workUnitId: f.unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now });
  f.store.linkRunToWorkUnit(f.run.id, f.unit.id, now);
  if (storedTask) {
    f.store.transitionTaskStatus({ taskId: f.storedTask.id, expectedStatus: "todo", event: "claim", actor: "system", now });
    f.store.transitionTaskStatus({ taskId: f.storedTask.id, expectedStatus: "claimed", event: "start_run", actor: "system", currentRunId: f.run.id, now });
  }
  if (workflow) f.store.updateChannelWorkflowStep(f.step.id, { runId: f.run.id, taskId: f.storedTask?.id }, now);
  f.request = f.store.createUserInputRequest({
    sourceRunId: f.run.id, sourceItemId: f.turn.item.id, sourceFence: toRuntimeAttemptFence(f.attempt),
    toolCallId: "question", idempotencyKey: "question",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "theme", prompt: "选择主题\n保留换行", required: true, allowFreeText: true,
        options: [{ optionId: "dark", label: "深色" }, { optionId: "light", label: "浅色" }] },
    ] },
  }, now).request;
  f.submit = (answers = [{ questionId: "theme", kind: "option", optionId: "dark" }]) => {
    f.receipt = f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: {
      schemaVersion: 1, requestId: f.request.requestId, expectedVersion: 1, expectedStatusRevision: 1,
      idempotencyKey: "answer", answers,
    } }, acceptedAt);
    return f.receipt;
  };
  f.claim = () => {
    f.store.commitUserInputYield({
      threadId: f.thread.id, requestId: f.request.requestId, expectedRequestVersion: 1,
      sourceFence: toRuntimeAttemptFence(f.attempt),
      quiescence: { kind: "runner_quiesced", runnerId: f.attempt.runnerId, stoppedAt: acceptedAt, lastRunEventSeq: 0 },
    }, "2026-09-07T00:00:02.000Z");
    return f.store.claimUserInputDelivery({
      threadId: f.thread.id, deliveryId: f.receipt.deliveryId, expectedRevision: 1, ownerId: "host-worker", leaseMs: 1000,
    }, claimedAt);
  };
  f.read = (itemIds = [f.request.itemId, ...(f.receipt ? [f.receipt.answerItemId] : [])]) =>
    f.store.readUserInputTranscript({ threadId: f.thread.id, itemIds });
  return f;
}

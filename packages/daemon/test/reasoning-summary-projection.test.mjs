import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, LING_AGENT_ID } from "@ling-stack/core";
import { buildConversationDetail } from "../dist/features/conversations/routes.js";

const now = "2026-09-12T02:00:00.000Z";

test("reasoning summaries rebuild beyond the first RunEvent page without exposing raw thinking", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-reasoning-summary-"));
  let store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({
      kind: "conversation",
      teammateId: LING_AGENT_ID,
      title: "Reasoning summary",
      objective: "Project only safe provider summaries",
    }, now);
    const accepted = store.appendConversationUserTurn({
      itemId: "reasoning-user",
      turnId: "reasoning-turn",
      threadId: thread.id,
      title: "Inspect safely",
      userInstruction: "Inspect safely",
      actorId: "local-user",
      payload: { body: "Inspect safely", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: "reasoning-user",
    }, now);
    const runId = "reasoning-run";
    const unit = store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "run",
      ownerId: runId,
      idempotencyKey: runId,
      status: "running",
      createdByActor: "system",
      request: {},
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      workUnitId: unit.id,
      attemptNumber: 1,
      runtimeInstanceId: "reasoning-runtime",
      runnerId: "runner_pi_embedded",
      status: "started",
      now,
    });
    store.createRun({
      id: runId,
      cwd,
      taskId: "reasoning-task",
      threadId: thread.id,
      turnId: accepted.turnId,
      workUnitId: unit.id,
      teammateId: LING_AGENT_ID,
      providerName: "openai",
      providerModel: "gpt-test",
      taskSnapshot: { id: "reasoning-task", title: "Inspect safely", prompt: "Inspect safely" },
      providerSnapshot: { provider: "openai", model: "gpt-test" },
      requestSnapshot: {},
      createdAt: now,
    });
    store.linkRunToWorkUnit(runId, unit.id, now);
    for (let index = 0; index < 1_000; index += 1) {
      store.appendEvent(runId, "assistant_thinking_delta", { text: `RAW_PRIVATE_REASONING_${index}` });
    }
    const summaryEvent = store.appendEvent(runId, "assistant_reasoning_summary", {
      text: "Checked the durable boundaries.",
      parts: ["Checked the durable boundaries."],
      semantic: "safe_summary",
      source: "openai_responses",
      truncated: false,
      attemptId: attempt.id,
    });
    assert.ok(summaryEvent.seq > 1_000);
    const assistant = store.appendConversationItem({
      id: "reasoning-assistant",
      threadId: thread.id,
      turnId: accepted.turnId,
      kind: "assistant_message",
      actorType: "ling_agent",
      actorId: LING_AGENT_ID,
      visibility: "thread_participants",
      payload: { body: "Finished safely.", format: "markdown", streaming: false, deliveryStatus: "ready" },
      domainRefs: [{ type: "turn", id: accepted.turnId }, { type: "run", id: runId }],
    }, now);

    const beforeRestart = buildConversationDetail(store, cwd, thread).reasoningSummaries;
    assert.equal(beforeRestart.length, 1);
    assert.deepEqual(beforeRestart[0], {
      id: `reasoning-summary:${summaryEvent.id}`,
      revision: summaryEvent.seq,
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      turnId: accepted.turnId,
      runId,
      attemptId: attempt.id,
      participantId: LING_AGENT_ID,
      workUnitId: unit.id,
      anchorItemId: assistant.id,
      eventId: summaryEvent.id,
      eventSequence: summaryEvent.seq,
      text: "Checked the durable boundaries.",
      parts: ["Checked the durable boundaries."],
      semantic: "safe_summary",
      source: "openai_responses",
      truncated: false,
      sourceRefs: [
        { kind: "conversation_item", id: assistant.id },
        { kind: "thread", id: thread.id },
        { kind: "turn", id: accepted.turnId },
        { kind: "run", id: runId },
        { kind: "run_event", id: summaryEvent.id },
        { kind: "attempt", id: attempt.id },
        { kind: "work_unit", id: unit.id },
        { kind: "participant", id: LING_AGENT_ID },
      ],
      createdAt: summaryEvent.ts,
    });
    assert.equal(JSON.stringify(beforeRestart).includes("RAW_PRIVATE_REASONING"), false);

    const compactStart = store.appendEvent(runId, "context_compaction_start", {
      attemptId: attempt.id, reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1",
    });
    const compacting = buildConversationDetail(store, cwd, thread).contextCompactions;
    assert.equal(compacting[0].status, "running");
    store.appendEvent(runId, "context_compaction_end", {
      attemptId: attempt.id, reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1",
      outcome: "sdk_installed", willRetry: false, tokensBefore: 60000, estimatedTokensAfter: 14000,
    });
    const compacted = buildConversationDetail(store, cwd, thread).contextCompactions;
    assert.equal(compacted[0].status, "succeeded");
    assert.equal(compacted[0].eventId, compactStart.id);
    assert.equal(compacted[0].id, compacting[0].id);
    store.close();
    store = createSqliteRunStore(cwd);
    const restoredThread = store.getLingThread(thread.id);
    assert.ok(restoredThread);
    const afterRestart = buildConversationDetail(store, cwd, restoredThread).reasoningSummaries;
    assert.deepEqual(afterRestart, beforeRestart);
    assert.deepEqual(buildConversationDetail(store, cwd, restoredThread).contextCompactions, compacted);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

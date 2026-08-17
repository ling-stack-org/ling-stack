import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { ChannelTurnDispatchWorkerRegistry } from "../dist/index.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

test("channel dispatch worker does not acquire a runtime for an empty queue", async (t) => {
  const fixture = await createFixture(t, 0, false);
  const originalGetRuntime = fixture.supervisor.getRuntime.bind(fixture.supervisor);
  let runtimeAcquisitions = 0;
  fixture.supervisor.getRuntime = (...args) => {
    runtimeAcquisitions += 1;
    return originalGetRuntime(...args);
  };
  const worker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async () => ({ result: {} }));

  worker.start(fixture.store);
  await worker.close();

  assert.equal(runtimeAcquisitions, 0);
});

test("channel dispatch worker coalesces wakes claims oldest first and creates one attempt", async (t) => {
  const fixture = await createFixture(t);
  const order = [];
  const worker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async ({ request }) => {
    order.push(request.sourceItemId);
    return { result: {} };
  });
  worker.start(fixture.store);
  const firstPromise = worker.dispatchAcceptedTurn({ store: fixture.store, message: fixture.first.message });
  const secondPromise = worker.dispatchAcceptedTurn({ store: fixture.store, message: fixture.second.message });
  worker.wake(fixture.store);
  await Promise.all([firstPromise, secondPromise]);

  assert.deepEqual(order, [fixture.first.message.id, fixture.second.message.id]);
  for (const accepted of [fixture.first, fixture.second]) {
    const unit = fixture.store.getWorkUnit(accepted.workUnitId);
    assert.equal(unit.status, "succeeded");
    assert.equal(fixture.store.listWorkUnitAttempts(unit.id).length, 1);
  }
  await worker.close();
});

test("SSE-style observer detachment does not cancel accepted dispatch", async (t) => {
  const fixture = await createFixture(t, 1);
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const events = [];
  const worker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async ({ observer }) => {
    observer.onReplyPending?.({ sourceMessageId: fixture.first.message.id, targetTeammateId: "ling_agent", startedAt: new Date().toISOString() });
    await gate;
    return { result: {} };
  });
  const completion = worker.dispatchAcceptedTurn({
    store: fixture.store,
    message: fixture.first.message,
    observer: { onReplyPending: () => events.push("pending") },
  });
  worker.start(fixture.store);
  await waitUntil(() => events.length === 1);
  release();
  await completion;
  assert.equal(fixture.store.getWorkUnit(fixture.first.workUnitId).status, "succeeded");
  await worker.close();
});

test("dispatch request validator rejects unavailable participant ids not bound to the accepted item", async (t) => {
  const fixture = await createFixture(t, 1, false, {
    unavailableRequestedParticipantIds: ["teammate_unbound"],
  });
  const worker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async () => {
    assert.fail("invalid unavailable participant lineage must not reach the executor");
  });
  const pending = worker.dispatchAcceptedTurn({ store: fixture.store, message: fixture.first.message });
  worker.start(fixture.store);
  await assert.rejects(
    pending,
    /unavailable participant is not bound to the source item/,
  );
  assert.equal(fixture.store.getWorkUnit(fixture.first.workUnitId).status, "failed");
  await worker.close();
});

test("startup requeues an old active dispatch and the worker resumes it once", async (t) => {
  const fixture = await createFixture(t, 1, false);
  const unit = fixture.store.getWorkUnit(fixture.first.workUnitId);
  const claimed = fixture.store.transitionWorkUnitStatus({
    workUnitId: unit.id,
    expectedStatus: "queued",
    event: "claim",
    actor: "system",
    now: "2026-08-13T02:00:00.000Z",
  });
  assert.equal(claimed.ok, true);
  const attempt = fixture.store.createWorkUnitAttempt({
    workUnitId: unit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime_old",
    runnerId: "daemon",
    effectiveRunnerId: "daemon",
    status: "started",
    now: "2026-08-13T02:00:00.000Z",
  });
  assert.equal(fixture.store.transitionWorkUnitStatus({
    workUnitId: unit.id,
    expectedStatus: "claimed",
    event: "runner_started",
    actor: "system",
    activeAttemptId: attempt.id,
    now: "2026-08-13T02:00:00.000Z",
  }).ok, true);

  let executions = 0;
  const worker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async () => {
    executions += 1;
    return { result: {} };
  });
  worker.start(fixture.store);
  await waitUntil(() => fixture.store.getWorkUnit(unit.id)?.status === "succeeded");
  assert.equal(executions, 1);
  assert.equal(fixture.store.listWorkUnitAttempts(unit.id).length, 2);
  assert.equal(fixture.store.listWorkUnitAttempts(unit.id)[0].status, "lost");
  await worker.close();
});

test("restart after reply handoff resumes the dispatch and ignores the old attempt callback", async (t) => {
  const fixture = await createFixture(t, 1);
  let settleOld;
  const oldSettled = new Promise((resolveOld) => { settleOld = resolveOld; });
  const firstWorker = new ChannelTurnDispatchWorkerRegistry(fixture.supervisor, async () => ({
    result: {},
    settled: oldSettled,
  }));
  firstWorker.start(fixture.store);
  await firstWorker.dispatchAcceptedTurn({ store: fixture.store, message: fixture.first.message });
  await waitUntil(() => fixture.store.getWorkUnit(fixture.first.workUnitId)?.status === "running");

  fixture.supervisor.releaseAll();
  const restartedSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  let resumed = 0;
  const restartedWorker = new ChannelTurnDispatchWorkerRegistry(restartedSupervisor, async () => {
    resumed += 1;
    return { result: {} };
  });
  restartedWorker.start(fixture.store);
  await waitUntil(() => fixture.store.getWorkUnit(fixture.first.workUnitId)?.status === "succeeded");
  assert.equal(resumed, 1);
  assert.equal(fixture.store.listWorkUnitAttempts(fixture.first.workUnitId).length, 2);
  assert.equal(fixture.store.listWorkUnitAttempts(fixture.first.workUnitId)[0].status, "lost");

  settleOld();
  await firstWorker.close();
  assert.equal(fixture.store.getWorkUnit(fixture.first.workUnitId).status, "succeeded");
  assert.equal(fixture.store.listWorkUnitAttempts(fixture.first.workUnitId)[1].status, "succeeded");
  await restartedWorker.close();
  restartedSupervisor.releaseAll();
});

async function createFixture(t, count = 2, initializeRuntime = true, dispatchOverrides = {}, sourceMentionIds = []) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-channel-dispatch-worker-"));
  const store = createSqliteRunStore(cwd);
  const supervisor = new RuntimeSupervisor(runtimeConfig(cwd));
  t.after(async () => {
    supervisor.releaseAll();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = "2026-08-13T01:00:00.000Z";
  const channel = store.createChannel({ name: "Dispatch worker", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Dispatch worker",
    objective: "Verify recovery",
  }, now).thread;
  const accepted = Array.from({ length: count }, (_, index) => {
    const result = store.appendConversationUserTurn({
      channelId: channel.id,
      threadId: thread.id,
      title: `turn ${index}`,
      userInstruction: `turn ${index}`,
      payload: {
        body: `turn ${index}`,
        format: "plain_text",
        mentions: sourceMentionIds.map((id) => ({
          id,
          label: id,
          kind: "ai_teammate",
        })),
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
      },
      idempotencyKey: `dispatch-worker:${index}`,
      dispatch: { schemaVersion: 1, requestAiReply: false, ...dispatchOverrides },
    }, new Date(Date.parse(now) + index * 1000).toISOString());
    return {
      message: {
        id: result.item.id,
        workspaceId: result.item.workspaceId,
        channelId: channel.id,
        threadId: thread.id,
        authorType: "local-user",
        body: result.item.payload.body,
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
        kind: "message",
        intent: "discuss",
        status: "ready",
        createdAt: result.item.createdAt,
        updatedAt: result.item.updatedAt,
      },
      workUnitId: result.dispatchWorkUnitId,
    };
  });
  if (initializeRuntime) supervisor.getRuntime(cwd, store);
  return { cwd, store, supervisor, first: accepted[0], second: accepted[1], channel, thread };
}

function runtimeConfig(cwd) {
  return {
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true },
    channels: {},
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail("Timed out waiting for dispatch state.");
}

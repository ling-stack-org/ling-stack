import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { PassThrough, type Duplex, type Readable, type Writable } from "node:stream";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parseUserInputAnswerCommandV1 } from "@ling-stack/contracts";
import type {
  LingAppServerCandidateReference,
  LingAppServerContextInspectResult,
  LingAppServerExternalAgentRegisterResult,
  LingAppServerExternalAgentTaskReconnectResult,
  LingAppServerExternalAgentTaskStartResult,
  LingAppServerInputRespondParams,
  LingAppServerInputRespondResult,
  LingAppServerVerifyOperation,
  LingAppServerVerifyPlanResult,
  LingAppServerVerifyStatusResult,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemControlResult,
  LingAppServerWorkItemResult,
  LingAppServerWorkItemSnapshot,
  LingAppServerReviewStartResult,
  LingAppServerReviewStatusResult,
  LingAppServerReviewFindingUpdateResult,
  LingAppServerSimplifyStartResult,
  LingAppServerSimplifyStatusResult,
  LingAppServerThreadSnapshotResult,
  LingAppServerTurnResumeResult,
  ControlPlaneEventsResponse,
} from "@ling-stack/contracts";
import { LingAppServerClient, type LingAppServerSocket, type LingDaemonClient } from "@ling-stack/api-client";
import { createSqliteRunStore, resolveStoragePaths, toRuntimeAttemptFence, type LingThreadGoal, type RunIntervention, type SqliteRunStore } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer, createDefaultRunnerRegistry, listenLingAppServerSocket, probeLingAppServer, runLingAppServerMcp, runLingAppServerStdio, type DaemonConfig } from "../dist/index.js";
import { prepareConversationSubmission } from "../dist/features/conversations/conversation-submission.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createRunnerRegistry, type RunnerRegistrationInput } from "../dist/runtime/runners.js";
import { createCodexAppServerAdapter } from "../dist/runtime/adapters/codex-app-server.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";
import { startFakeCodexAppServer } from "./test-support/fake-codex-app-server.ts";

test("App Server executes an allowlisted check once and restores its outcome and Work Item events", { timeout: 30_000 }, async t => {
  const fixture = await releaseFixture(t);
  const marker = join(fixture.root, "test-executions");
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\nnode_modules/\npnpm-lock.yaml\n");
  await writeFile(join(fixture.cwd, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
  await writeFile(join(fixture.cwd, "check.cjs"), `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "checked\\n");\n`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".gitignore", "package.json", "check.cjs");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Verification input");
  const client = await fixture.connect();
  const peer = await fixture.connect();
  const { workItem } = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/create", {
    sourceId: "verify-acceptance", title: "Verify the current candidate",
  });
  const subscription = await peer.call<{ cursor: string }>("workItem/subscribe", { workItemId: workItem.workItemId });
  const { candidate, coverage } = await client.call<{ candidate: LingAppServerCandidateReference; coverage: string }>("changes/capture");
  assert.equal(coverage, "complete");
  const plan = await client.call<LingAppServerVerifyPlanResult>("verify/plan", {
    candidate, workItemId: workItem.workItemId, requestedChecks: ["test", "browser-missing-recipe"],
  });
  const input = { planId: plan.planId, planRevision: plan.planRevision, candidateDigest: candidate.candidateDigest, idempotencyKey: "verify-receipt" };
  const first = await client.call<LingAppServerVerifyOperation>("verify/start", input);
  assert.equal((await client.call<LingAppServerVerifyOperation>("verify/start", input)).operationId, first.operationId);
  const finished = await waitFor(async () => {
    const { operation } = await client.call<LingAppServerVerifyStatusResult>("verify/status", { operationId: first.operationId });
    return operation.completedAt ? operation : undefined;
  });
  assert.equal(finished.status, "blocked");
  assert.deepEqual(finished.checks.map(check => check.status), ["passed", "blocked"]);
  const finalEvent = await waitFor(() => peer.notices.find(notice =>
    notice.method === "verification/updated" && notice.params?.event?.entityId === finished.operationId
    && notice.params?.revision === finished.revision));
  assert.equal(finalEvent.params?.subject?.workItemId, workItem.workItemId);
  const events = peer.notices.filter(notice => notice.method === "verification/updated").map(notice => notice.params?.eventId);
  assert.ok(events.length >= 3);
  assert.equal(new Set(events).size, events.length);
  assert.equal(await readFile(marker, "utf8"), "checked\n");
  await fixture.restart();
  const restored = await fixture.connect();
  await restored.call("workItem/subscribe", { workItemId: workItem.workItemId, cursor: subscription.cursor });
  await waitFor(() => restored.notices.find(notice => notice.method === "workItem/replay/ready"));
  assert.deepEqual(await restored.call("verify/start", input), finished);
  assert.deepEqual(restored.notices.filter(notice => notice.method === "verification/updated")
    .map(notice => notice.params?.eventId), events);
  assert.equal(await readFile(marker, "utf8"), "checked\n");
});

test("App Server submits a durable Turn through the configured Pi Runner and replays it after reconnect", { timeout: 30_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "Runner accepted the task" }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  await mkdir(join(fixture.cwd, "feature"));
  await writeFile(join(fixture.cwd, "AGENTS.md"), "Root verification instructions\n");
  await writeFile(join(fixture.cwd, "feature/AGENTS.md"), "Unused fallback instructions\n");
  await writeFile(join(fixture.cwd, "feature/AGENTS.override.md"), "Feature-specific verification instructions\n");
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const first = await fixture.connect();
  const started = await first.call<{ thread: { id: string }; turn: { id: string; status: string }; run: { id: string } }>("thread/start", {
    title: "Runner thread", objective: "Exercise the configured Pi Runner", kind: "conversation", threadId: "release-runner-thread",
  });
  const observer = await fixture.connect();
  const subscription = await observer.call<{ cursor: string }>("thread/subscribe", { threadId: started.thread.id });
  const acceptanceCriteria = [{ id: "run", kind: "run_succeeded", description: "The requested Run succeeds" }];
  const goalInput = { threadId: started.thread.id, objective: "Check the accepted Turn", acceptanceCriteria,
    supervisionPolicy: { autoContinue: false } };
  const { goal } = await first.call<{ goal: LingThreadGoal }>("thread/goal/set", goalInput);
  assert.deepEqual(goal.acceptanceCriteria, acceptanceCriteria);
  assert.equal(goal.supervisionPolicy?.autoContinue, false);
  await assert.rejects(first.call("thread/goal/set", { ...goalInput, objective: "Unaccepted scope change" }), { code: "goal_replace_required" });
  const request = {
    threadId: started.thread.id, message: "Run the configured provider once", providerPresetId: preset.id,
    execute: true, idempotencyKey: "release-runner-turn", fileRefs: [{ path: "feature/index.ts", source: "explicit_text" }],
  };
  const result = await first.call<typeof started & { replayed?: boolean }>("turn/start", request);
  assert.ok(result.run.id);
  const delta = await waitFor(() => observer.notices.find(notice => notice.method === "item/delta"));
  assert.equal(delta.params?.subject?.turnId, result.turn.id);
  assert.equal(delta.params?.runId, result.run.id);
  assert.equal(delta.params?.text, "Runner accepted the task");
  assert.ok(delta.params?.offset && delta.params.streamEpoch);
  assert.equal(delta.params?.eventId, undefined);
  const turnCompleted = await waitFor(() => observer.notices.find(notice => notice.method === "turn/completed"));
  assert.equal(turnCompleted.params?.subject?.turnId, result.turn.id);
  const finalItem = await waitFor(() => observer.notices.find(notice => notice.method === "item/completed"));
  assert.equal(finalItem.params?.itemId, delta.params?.itemId);
  const { item } = await observer.call<{ item: { payload: { body: string } } }>("item/read", {
    threadId: started.thread.id, itemId: finalItem.params?.itemId,
  });
  assert.equal(item.payload.body, "Runner accepted the task");
  await waitFor(() => store.getRun(result.run.id)?.status === "succeeded" ? true : undefined);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /Root verification instructions/u);
  assert.match(JSON.stringify(provider.requests[0]), /Feature-specific verification instructions/u);
  assert.doesNotMatch(JSON.stringify(provider.requests[0]), /Unused fallback instructions/u);
  const query = { threadId: request.threadId, turnId: result.turn.id };
  const context = await first.call<LingAppServerContextInspectResult>("context/inspect", query);
  assert.deepEqual(context.projectInstructions?.sources.map(source => source.path), ["AGENTS.md", "feature/AGENTS.override.md"]);
  await writeFile(join(fixture.cwd, "AGENTS.md"), "Changed after dispatch\n");
  first.close();
  const second = await fixture.connect();
  await second.call("thread/subscribe", { threadId: started.thread.id, cursor: subscription.cursor });
  await waitFor(() => second.notices.find(notice => notice.method === "thread/replay/ready"));
  assert.ok(second.notices.some(notice => notice.method === "item/completed" && notice.params?.eventId === finalItem.params?.eventId));
  assert.equal(second.notices.some(notice => notice.method === "item/delta"), false);
  assert.deepEqual(await second.call("context/inspect", query), context);
  const snapshot = await second.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: request.threadId });
  assert.equal(snapshot.turn?.id, result.turn.id);
  assert.equal(snapshot.run?.id, result.run.id);
  assert.equal(snapshot.run?.status, "succeeded");
  assert.ok(Number(snapshot.cursor) > 0);
  const receipt = await second.call<{ status: string; turnId: string }>("submission/read", {
    threadId: started.thread.id, idempotencyKey: request.idempotencyKey,
  });
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.turnId, result.turn.id);
  const replay = await second.call<typeof result>("turn/start", request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, result.run.id);
  assert.equal(provider.requests.length, 1);
  const resumed = await second.call<{ turn: { id: string }; run: { id: string } }>("turn/resume", { turnId: result.turn.id });
  assert.equal(resumed.turn.id, result.turn.id);
  assert.equal(resumed.run.id, result.run.id);
  const completion = { threadId: request.threadId, actor: "ling-agent", completionVerificationSummary: "Pi completed the accepted Turn." };
  await assert.rejects(second.call("thread/goal/complete", completion), { code: "goal_completion_evidence_required" });
  const now = new Date().toISOString();
  const unrelatedThread = store.createLingThread({ kind: "conversation", title: "Other Thread", objective: "Unrelated evidence" }, now);
  const unrelatedRun = store.createRun({
    id: "unrelated-goal-run", threadId: unrelatedThread.id, cwd: fixture.cwd, taskId: "unrelated-task",
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  store.markRunStarted(unrelatedRun.id, now);
  store.markRunSucceeded(unrelatedRun.id, now);
  const withEvidence = (id: string) => {
    const evidence = { kind: "run", id };
    return { ...completion, evidenceRefs: [evidence], acceptanceEvidence: [{ criterionId: "run", evidence }] };
  };
  await assert.rejects(second.call("thread/goal/complete", withEvidence(unrelatedRun.id)), { code: "goal_completion_evidence_invalid" });
  await second.call("thread/subscribe", { threadId: request.threadId, cursor: snapshot.cursor });
  const { goal: completed } = await second.call<{ goal: LingThreadGoal }>("thread/goal/complete", withEvidence(result.run.id));
  assert.equal(completed.id, goal.id);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.acceptanceEvidence, withEvidence(result.run.id).acceptanceEvidence);
  await waitFor(() => second.notices.find(notice => notice.method === "thread/goal/updated"
    && notice.params?.subject?.threadId === request.threadId));
});

test("thread resume attaches without dispatch and turn resume recovers a prepared request exactly once after restart", { timeout: 30_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "Recovered the prepared request." }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  await writeFile(join(fixture.cwd, "AGENTS.md"), "Use the saved project instructions.\n");
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", title: "Prepared Turn", objective: "Recover after preparation" }, now);
  const { turn } = await prepareConversationSubmission({
    store, runnerRegistry: createDefaultRunnerRegistry(), workspaceCwd: fixture.cwd,
    now, resolveThread: () => thread, input: { threadId: thread.id, message: "Recover my prepared input.",
      idempotencyKey: "prepared-turn", providerPresetId: preset.id },
  });
  await writeFile(join(fixture.cwd, "AGENTS.md"), "These instructions were edited after preparation.\n");
  await fixture.restart();
  const client = await fixture.connect();
  const state = await client.call<LingAppServerThreadSnapshotResult>("thread/resume", { threadId: thread.id });
  assert.equal(state.turn?.id, turn.id);
  assert.equal(state.run, null);
  assert.equal(provider.requests.length, 0);
  await client.call("thread/subscribe", { threadId: thread.id, cursor: state.cursor });
  const recovery = { threadId: thread.id, turnId: turn.id, expectedTurnRevision: state.turn!.updatedAt };
  await assert.rejects(client.call("turn/resume", { ...recovery, expectedTurnRevision: "outdated" }), { code: "stale_revision" });
  const peer = await fixture.connect();
  const results = await Promise.all([client.call<LingAppServerTurnResumeResult>("turn/resume", recovery),
    peer.call<LingAppServerTurnResumeResult>("turn/resume", recovery)]);
  const runId = results[0].run?.id;
  assert.ok(runId);
  assert.equal(results[1].run?.id, runId);
  await waitFor(() => fixture.getStore().getRun(runId)?.status === "succeeded" ? true : undefined);
  assert.equal((await client.call<LingAppServerTurnResumeResult>("turn/resume", recovery)).disposition, "existing");
  await waitFor(() => client.notices.find(notice => notice.method === "turn/started"));
  assert.equal(client.notices.filter(notice => notice.method === "turn/started").length, 1);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /saved project instructions/u);
  assert.doesNotMatch(JSON.stringify(provider.requests[0]), /edited after preparation/u);
});

test("a stopped Turn continues with the same recovery receipt across peers and restart", { timeout: 30_000 }, async t => {
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponse = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await firstResponse;
    return { text: "Fixture response." };
  });
  t.after(async () => {
    releaseFirstResponse();
    await provider.close();
  });
  const fixture = await releaseFixture(t, { harness: { toolBroker: { mode: "enforce" } } });
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Stopped Turn recovery" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const started = await client.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Start the project check.", providerPresetId: preset.id, idempotencyKey: "resume-stopped-source",
  });
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  await client.call("turn/interrupt", { turnId: started.turn.id });
  releaseFirstResponse();
  const store = fixture.getStore();
  const run = store.getRun(started.run.id)!;
  const attempt = store.listWorkUnitAttempts(run.workUnitId!)[0]!;
  await waitFor(() => store.getHostAttemptCompletion({ runId: run.id, ...toRuntimeAttemptFence(attempt) })?.effectCoverage ? true : undefined);
  const { turn } = await client.call<LingAppServerThreadSnapshotResult>("thread/resume", { threadId: thread.id });
  assert.equal(turn?.status, "cancelled");
  const recovery = { threadId: thread.id, turnId: started.turn.id, sourceRunId: run.id, expectedTurnRevision: turn.updatedAt,
    idempotencyKey: "resume-stopped-target", instruction: "Continue from the saved project check." };
  assert.equal((await client.call<LingAppServerTurnResumeResult>("turn/resume", { turnId: turn.id })).disposition, "existing");
  const resumed = await client.call<LingAppServerTurnResumeResult>("turn/resume", recovery);
  assert.equal(resumed.disposition, "continued");
  assert.equal(resumed.resumedFromTurnId, turn.id);
  assert.equal(resumed.turn.sourceTurnId, turn.id);
  assert.ok(resumed.run && resumed.run.id !== run.id);
  const peer = await fixture.connect();
  assert.equal((await peer.call<LingAppServerTurnResumeResult>("turn/resume", recovery)).run?.id, resumed.run.id);
  await assert.rejects(peer.call("turn/resume", { ...recovery, instruction: "Different input." }), { code: "idempotency_conflict" });
  await waitFor(() => store.getRun(resumed.run!.id)?.status === "succeeded" ? true : undefined);
  await fixture.restart();
  const restored = await fixture.connect();
  assert.equal((await restored.call<LingAppServerTurnResumeResult>("turn/resume", recovery)).run?.id, resumed.run.id);
  assert.equal(provider.requests.length, 2);
});

test("a queued Turn reaches Pi once after the source Run finishes and keeps its receipt", { timeout: 30_000 }, async t => {
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponse = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await firstResponse;
    return { text: count === 1 ? "First Turn finished" : "Follow-up finished" };
  });
  t.after(async () => {
    releaseFirstResponse();
    await provider.close();
  });
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Follow-up test" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const started = await client.call<{ run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Wait before finishing the source Turn", providerPresetId: preset.id, idempotencyKey: "queue-source",
  });
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  const { turn, cursor } = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  assert.ok(turn);
  const request = { threadId: thread.id, expectedTurnId: turn.id, expectedTurnRevision: turn.updatedAt,
    message: "Check the follow-up candidate", idempotencyKey: "queue-next" };
  await assert.rejects(client.call("turn/queue", { ...request, expectedTurnRevision: "stale" }), { code: "stale_revision" });
  const current = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  request.expectedTurnRevision = current.turn!.updatedAt;
  type QueueReceipt = { intervention: RunIntervention; replayed: boolean };
  const queued = await client.call<QueueReceipt>("turn/queue", request);
  assert.equal(queued.replayed, false);
  assert.equal(queued.intervention.sourceRunId, started.run.id);
  assert.equal(queued.intervention.status, "queued");
  assert.equal(provider.requests.length, 1);
  client.close();
  const peer = await fixture.connect();
  const replay = await peer.call<QueueReceipt>("turn/queue", request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intervention.id, queued.intervention.id);
  await assert.rejects(peer.call("turn/queue", { ...request, message: "Different follow-up" }), { code: "idempotency_conflict" });

  const store = fixture.getStore();
  let reachedClaim = false;
  store.claimNextRunIntervention = () => {
    reachedClaim = true;
    return undefined;
  };
  releaseFirstResponse();
  await waitFor(() => reachedClaim ? true : undefined);
  assert.equal(store.getRun(started.run.id)?.status, "succeeded");
  assert.equal(store.getRunIntervention(queued.intervention.id)?.status, "queued");
  assert.equal(provider.requests.length, 1);
  await fixture.restart();
  const restored = await fixture.connect();
  await restored.call("thread/subscribe", { threadId: thread.id, cursor });
  const recoveredStore = fixture.getStore();
  const delivered = await waitFor(() => {
    const receipt = recoveredStore.getRunIntervention(queued.intervention.id);
    return receipt?.completedAt && receipt.continuationRunId && recoveredStore.getRun(receipt.continuationRunId)?.status === "succeeded" ? receipt : undefined;
  });
  const followUp = recoveredStore.getLingTurnForRun(delivered.continuationRunId!);
  assert.equal(followUp?.kind, "queued_followup");
  assert.equal(followUp?.sourceTurnId, turn.id);
  await waitFor(() => restored.notices.find(notice => notice.method === "turn/completed"
    && notice.params?.subject?.turnId === followUp.id));
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /Check the follow-up candidate/u);
  const events = await restored.call<ControlPlaneEventsResponse>("thread/events/read", { threadId: thread.id, cursor });
  assert.deepEqual(events.events.filter(event => event.entityId === delivered.continuationRunId && event.action === "run.completed")
    .map(event => event.data.status), ["succeeded"]);
  await assert.rejects(restored.call("turn/queue", { ...request, idempotencyKey: "late-follow-up" }), { code: "stale_revision" });
  const result = await restored.call<QueueReceipt>("turn/queue", request);
  assert.equal(result.intervention.id, delivered.id);
  assert.equal(result.intervention.continuationRunId, delivered.continuationRunId);
  assert.equal(provider.requests.length, 2);
});

test("interrupt with a message cancels the source and delivers one redirect continuation", { timeout: 30_000 }, async t => {
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponse = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await firstResponse;
    return { text: count === 1 ? "Source Turn finished" : "Redirect finished" };
  });
  t.after(async () => {
    releaseFirstResponse();
    await provider.close();
  });
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Redirect test" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const started = await client.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Start a long-running Turn", providerPresetId: preset.id, idempotencyKey: "steer-source",
  });
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  const snapshot = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  assert.equal(snapshot.turn?.id, started.turn.id);
  const request = {
    threadId: thread.id, expectedTurnId: snapshot.turn!.id, expectedTurnRevision: snapshot.turn!.updatedAt,
    message: "Stop the current approach and use the safer implementation", idempotencyKey: "steer-redirect",
  };
  await assert.rejects(client.call("turn/steer", request), { code: "steer_unsupported" });
  assert.equal(fixture.getStore().getRun(started.run.id)?.status, "running");
  const redirected = await client.call<{ intervention: RunIntervention; replayed: boolean }>("turn/interrupt", request);
  assert.equal(redirected.replayed, false);
  assert.equal(redirected.intervention.mode, "interrupt_redirect");
  const replay = await client.call<{ intervention: RunIntervention; replayed: boolean }>("turn/interrupt", request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intervention.id, redirected.intervention.id);
  releaseFirstResponse();
  const delivered = await waitFor(() => {
    const receipt = fixture.getStore().getRunIntervention(redirected.intervention.id);
    return receipt?.continuationRunId && fixture.getStore().getRun(receipt.continuationRunId)?.status === "succeeded" ? receipt : undefined;
  });
  assert.equal(fixture.getStore().getRun(started.run.id)?.status, "cancelled");
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /safer implementation/u);
  assert.equal(fixture.getStore().getLingTurnForRun(delivered.continuationRunId!)?.kind, "interrupt_redirect");
});

test("a completed Review binds its candidate and replays the same assessment after daemon restart", { timeout: 30_000 }, async t => {
  let snapshotDigest: string;
  const provider = await startLoopbackPiProvider(() => ({ text: JSON.stringify({
    snapshotDigest, summary: "The fixture matches the review scope.", findings: [{
      title: "Exported value changed", body: "Existing callers observe a different value.",
      severity: "low", confidence: "high", path: "feature/code.ts", side: "new",
      startLine: 1, endLine: 1, evidence: "export const fixture = 1;",
    }],
  }) }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(fixture.cwd, "AGENTS.md"), "## Code Review Rules\n\nCheck all existing callers.\n\n## Tests\nRun the test suite.\n");
  await mkdir(join(fixture.cwd, "feature"));
  await writeFile(join(fixture.cwd, "feature/code.ts"), "export const fixture = 0;\n");
  await writeFile(join(fixture.cwd, "feature/AGENTS.md"), "## Code Review Rules\n\nCheck feature compatibility.\n");
  await writeFile(join(fixture.cwd, "feature/REVIEW.md"), "Retain public export names.\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Review base");
  await writeFile(join(fixture.cwd, "AGENTS.md"), "## Code Review Rules\n\nSkip checking existing callers.\n");
  await writeFile(join(fixture.cwd, "feature/code.ts"), "export const fixture = 1;\n");
  const client = await fixture.connect();
  const { candidate, headCommit } = await client.call<{ candidate: LingAppServerCandidateReference; headCommit: string }>("changes/capture");
  snapshotDigest = candidate.candidateDigest;
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const input = { candidate, providerPresetId: preset.id, idempotencyKey: "review-fixture", reviewRulesRefs: ["feature/REVIEW.md"] };
  await assert.rejects(client.call("review/start", { ...input, candidate: { ...candidate, candidateDigest: "stale" } }), { code: "candidate_stale" });
  const parallel = await fixture.connect();
  const [started, duplicate] = await Promise.all([
    client.call<LingAppServerReviewStartResult>("review/start", input),
    parallel.call<LingAppServerReviewStartResult>("review/start", input),
  ]);
  assert.equal(duplicate.operationId, started.operationId);
  assert.equal(duplicate.assessmentId, started.assessmentId);
  const status = { operationId: started.operationId };
  const terminal = await waitFor(async () => {
    const result = await client.call<LingAppServerReviewStatusResult>("review/status", status);
    return ["queued", "running"].includes(result.status) ? undefined : result;
  });
  assert.equal(terminal.status, "completed", JSON.stringify(terminal));
  assert.equal(terminal.reviewRules?.baseSha, headCommit);
  assert.deepEqual(terminal.reviewRules?.sources.map(({ path, guidance }) => [path, guidance]), [
    ["AGENTS.md", "Check all existing callers."],
    ["feature/AGENTS.md", "Check feature compatibility."],
    ["feature/REVIEW.md", "Retain public export names."],
  ]);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /baselineReviewRules/u);
  assert.match(JSON.stringify(provider.requests[0]), /Check feature compatibility/u);
  const triage = {
    assessmentId: started.assessmentId, findingId: terminal.findingIds[0], disposition: "resolved",
    closeReason: "not_reproducible", reason: "The fixture has no reproducible caller impact.",
    expectedRevision: terminal.revision, idempotencyKey: "resolve-review-fixture",
  };
  const update = await client.call<LingAppServerReviewFindingUpdateResult>("review/finding/update", triage);
  assert.equal(update.disposition, "resolved");
  assert.notEqual(update.revision, terminal.revision);
  assert.equal(fixture.getStore().getCodeAssessment(started.assessmentId)?.assessment.freshness?.state, "current");
  await assert.rejects(client.call("review/finding/update", { ...triage, idempotencyKey: "stale-finding" }), { code: "stale_revision" });
  await fixture.restart();
  const second = await fixture.connect();
  const restored = fixture.getStore().getCodeAssessment(started.assessmentId);
  assert.equal(restored?.assessment.freshness?.state, "current");
  assert.equal(restored?.findings[0]?.disposition, "resolved");
  assert.equal(restored?.findings[0]?.freshnessState, "current");
  assert.deepEqual(await second.call("review/status", status), { ...terminal, revision: update.revision });
  assert.deepEqual(await second.call("review/start", input), { ...started, status: "completed" });
  await assert.rejects(second.call("review/start", { ...input, baseInstructions: "Different request" }), { code: "idempotency_conflict" });
  assert.deepEqual(await second.call("review/finding/update", triage), update);
  await assert.rejects(second.call("review/finding/update", { ...triage, reason: "Different finding outcome" }), { code: "idempotency_conflict" });
  assert.equal(provider.requests.length, 1);
});

test("App Server simplification runs against the captured diff and retains the suggestion artifact", { timeout: 30_000 }, async t => {
  let snapshotDigest: string;
  const redundantLine = "export const flags = (ready: boolean) => ready ? true : false;";
  const provider = await startLoopbackPiProvider(() => ({ text: JSON.stringify({
    snapshotDigest, summary: "One boolean expression can be simplified.",
    findings: [{
      title: "Return the boolean directly", body: "Return ready directly to preserve the boolean result.",
      severity: "info", confidence: "high", path: "flags.ts", side: "new",
      startLine: 1, endLine: 1, evidence: redundantLine,
    }],
  }) }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".gitignore");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Simplification base");
  await writeFile(join(fixture.cwd, "flags.ts"), redundantLine + "\n");
  const client = await fixture.connect();
  const { candidate } = await client.call<{ candidate: LingAppServerCandidateReference }>("changes/capture");
  snapshotDigest = candidate.candidateDigest;
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const input = { candidate, providerPresetId: preset.id, idempotencyKey: "simplify-fixture" };
  const { methods } = await client.call<{ methods: string[] }>("server/capabilities");
  assert.ok(methods.includes("simplify/start"));
  assert.ok(methods.includes("simplify/status"));
  await assert.rejects(client.call("simplify/start", { ...input, candidate: { ...candidate, candidateDigest: "stale" } }), { code: "candidate_stale" });
  const peer = await fixture.connect();
  const [started, retry] = await Promise.all([
    client.call<LingAppServerSimplifyStartResult>("simplify/start", input),
    peer.call<LingAppServerSimplifyStartResult>("simplify/start", input),
  ]);
  assert.equal(retry.operationId, started.operationId);
  const lookup = { operationId: started.operationId };
  const finished = await waitFor(async () => {
    const status = await client.call<LingAppServerSimplifyStatusResult>("simplify/status", lookup);
    return ["queued", "running"].includes(status.status) ? undefined : status;
  });
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.equal(finished.candidateDigest, snapshotDigest);
  assert.ok(finished.suggestionArtifactId);
  assert.equal(finished.suggestions[0]?.title, "Return the boolean directly");
  assert.equal(finished.suggestions[0]?.evidence, redundantLine);
  assert.deepEqual((await client.call<LingAppServerSimplifyStatusResult>("simplify/status", { ...lookup, offset: 1 })).suggestions, []);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /behavior-preserving simplifications/u);
  assert.equal(await readFile(join(fixture.cwd, "flags.ts"), "utf8"), redundantLine + "\n");
  await fixture.restart();
  const restored = await fixture.connect();
  assert.deepEqual(await restored.call("simplify/status", lookup), finished);
  assert.equal((await restored.call<LingAppServerSimplifyStartResult>("simplify/start", input)).suggestionArtifactId, finished.suggestionArtifactId);
  const artifact = fixture.getStore().getArtifact(finished.suggestionArtifactId);
  const report = artifact?.sealedPayload as { snapshotDigest: string; findings: { title: string }[] };
  assert.equal(report?.snapshotDigest, snapshotDigest);
  assert.equal(report?.findings[0]?.title, "Return the boolean directly");
  assert.equal(provider.requests.length, 1);
});

const codexExecutable = process.env.LING_APP_SERVER_CODEX_EXECUTABLE;
test("installed Codex calls the CLI MCP bridge while a Ling subscription receives the same Turn", {
  skip: !codexExecutable, timeout: 45_000,
}, async t => {
  let finishSource: () => void = () => undefined;
  const sourceCanFinish = new Promise<void>(resolve => { finishSource = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await sourceCanFinish;
    return { text: "Codex submission reached Ling" };
  });
  let closeCodex: () => Promise<void> = async () => undefined;
  t.after(async () => {
    finishSource();
    await closeCodex();
    await provider.close();
  });
  const fixture = await releaseFixture(t);
  const ling = await fixture.connect();
  const { daemonUrl, authToken } = fixture.transportOptions();
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const args = [cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl, "app-server", "mcp"];
  const config = `mcp_servers={ ling={ command=${JSON.stringify(process.execPath)}, args=${JSON.stringify(args)}, env_vars=["LING_STACK_AUTH_TOKEN"], required=true } }`;
  const codexHome = join(fixture.root, "codex-config");
  await mkdir(codexHome, { mode: 0o700 });
  const codex = spawn(codexExecutable!, ["app-server", "--stdio", "-c", config, "-c", "analytics.enabled=false"], {
    cwd: fixture.cwd, stdio: "pipe", env: { PATH: process.env.PATH, CODEX_HOME: codexHome, LING_STACK_AUTH_TOKEN: authToken },
  });
  const closed = once(codex, "close");
  void closed.catch(() => undefined);
  closeCodex = async () => {
    codex.stdin.end();
    const deadline = setTimeout(() => codex.kill("SIGKILL"), 2_000);
    try { await closed; } finally { clearTimeout(deadline); }
  };
  codex.stdin.on("error", () => undefined);
  let stderr = "";
  codex.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  const host = jsonLines(codex.stdin, codex.stdout);
  try {
    await host.call("initialize", { clientInfo: { name: "ling-acceptance", version: "1" }, capabilities: { experimentalApi: true } });
    host.send("initialized", {});
    const { thread: codexThread } = await host.call<ThreadRead>("thread/start", { cwd: fixture.cwd, ephemeral: true });
    const call = async <T>(tool: string, args: object): Promise<T> => {
      const reply = await host.call<{ isError?: boolean; content: Array<{ text: string }> }>("mcpServer/tool/call", {
        server: "ling", threadId: codexThread.id, tool, arguments: args,
      });
      assert.ok(!reply.isError, reply.content[0]?.text);
      return JSON.parse(reply.content[0]!.text) as T;
    };
    const { thread } = await call<ThreadRead>("ling_thread_start", { title: "Codex acceptance", idempotencyKey: "real-codex-thread" });
    const subscription = await ling.call<{ cursor: string }>("thread/subscribe", { threadId: thread.id });
    const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
    const request = { threadId: thread.id, message: "Test the installed Codex MCP bridge", providerPresetId: preset.id, idempotencyKey: "real-codex-turn" };
    const accepted = await call<{ turn: { id: string }; run: { id: string } }>("ling_turn_start", request);
    await waitFor(() => ling.notices.find(notice => notice.method === "turn/started" && notice.params?.subject?.threadId === thread.id));
    await waitFor(() => provider.requests.length === 1 ? true : undefined);
    const snapshot = await call<Pick<LingAppServerThreadSnapshotResult, "turn">>("ling_thread_snapshot", { threadId: thread.id });
    assert.equal(snapshot.turn?.id, accepted.turn.id);
    const queuedInput = { threadId: thread.id, expectedTurnId: accepted.turn.id, expectedTurnRevision: snapshot.turn!.updatedAt,
      message: "Codex sent the next instruction", idempotencyKey: "real-codex-followup" };
    const queued = await call<{ intervention: RunIntervention }>("ling_turn_queue", queuedInput);
    assert.equal(queued.intervention.status, "queued");
    assert.equal((await call<typeof queued>("ling_turn_queue", queuedInput)).intervention.id, queued.intervention.id);
    finishSource();
    const store = fixture.getStore();
    const followUp = await waitFor(() => {
      const receipt = store.getRunIntervention(queued.intervention.id);
      return receipt?.completedAt && receipt.continuationRunId ? store.getLingTurnForRun(receipt.continuationRunId) : undefined;
    });
    assert.equal(followUp.status, "succeeded");
    await waitFor(() => ling.notices.find(notice => notice.method === "turn/completed"
      && notice.params?.subject?.turnId === followUp.id));
    assert.equal((await call<typeof accepted>("ling_turn_start", request)).run.id, accepted.run.id);
    const attached = await call<LingAppServerTurnResumeResult>("ling_turn_resume", {
      threadId: thread.id, turnId: followUp.id, expectedTurnRevision: followUp.updatedAt,
      sourceRunId: queued.intervention.continuationRunId ?? followUp.lastRunId, idempotencyKey: "real-codex-recovery",
    });
    assert.equal(attached.disposition, "existing");
    assert.equal(attached.turn.id, followUp.id);
    assert.equal(provider.requests.length, 2);
    assert.match(JSON.stringify(provider.requests[1]), /Codex sent the next instruction/u);
    let cursor = subscription.cursor;
    let seen = false;
    for (let page = 0; page < 30 && !seen; page++) {
      const result = await call<ControlPlaneEventsResponse>("ling_thread_events", { threadId: thread.id, cursor });
      seen = result.events.some(event => event.action === "turn.started" && event.entityId === accepted.turn.id);
      if (String(result.window.nextAfterSeq) === cursor) break;
      cursor = String(result.window.nextAfterSeq);
    }
    assert.ok(seen, "Codex could not recover the Turn event from the subscription cursor.");
  } catch (error) {
    throw new Error(`Installed Codex MCP acceptance failed. ${stderr.replaceAll(authToken, "[redacted]")}`, { cause: error });
  }
});

test("External Agent dispatch calls the configured Codex adapter transport once and restores its completion", { timeout: 30_000 }, async t => {
  const adapterPeer = await startFakeCodexAppServer();
  t.after(() => adapterPeer.close());
  const adapterRevision = "codex-adapter-acceptance/1";
  const toolExecutionConformance = readOnlyExternalConformance(adapterRevision);
  const fixture = await releaseFixture(t, { runner: {
    id: "codex-app-server", displayName: "Configured Codex Adapter", status: "enabled",
    executionBoundary: "external", adapterRevision, toolExecutionConformance,
    adapter: createCodexAppServerAdapter({ baseUrl: adapterPeer.baseUrl, adapterRevision, toolExecutionConformance, timeoutMs: 5_000 }),
  } });
  const client = await fixture.connect();
  const created = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/create", {
    sourceId: "codex-adapter-acceptance", title: "Inspect the project",
  });
  const { workItem } = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/accept", {
    workItemId: created.workItem.workItemId, expectedWorkItemRevision: Number(created.workItem.revision),
    idempotencyKey: "codex-adapter-work-item",
  });
  const { registrationId } = await client.call<LingAppServerExternalAgentRegisterResult>("externalAgent/register", {
    idempotencyKey: "codex-adapter-registration",
    registration: {
      agentId: "configured-codex-adapter", adapterKind: "codex-app-server", protocolVersion: "ling-codex-app-server/0.1",
      displayName: "Configured Codex Adapter", capabilities: ["task.start", "task.reconnect"],
      workspaceScopes: [workItem.workspaceId], toolScopes: ["read"], approvalModes: ["host"], source: "local", version: "1",
    },
  });
  const input = { registrationId, submission: {
    workItemId: workItem.workItemId, workItemRevision: workItem.revision, workspaceId: workItem.workspaceId,
    objective: "Read the project contract", acceptanceSnapshot: { provider: { provider: "fixture", model: "fixture" } },
    instructionManifestDigest: "fixture-manifest", idempotencyKey: "codex-adapter-task",
  } };
  const { task } = await client.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input);
  const reconnect = { registrationId, taskId: task.taskId, submissionId: task.submissionId, eventCursor: "external-agent:0" };
  const completed = await waitFor(async () => {
    const result = await client.call<LingAppServerExternalAgentTaskReconnectResult>("externalAgent/task/reconnect", reconnect);
    return result.task.status === "completed" ? result : undefined;
  });
  const requests = adapterPeer.requests as { method: string; params: { cwd: string; task: { id: string }; tools: string[] } }[];
  assert.deepEqual(requests.map(request => request.method), ["initialize", "session/run"]);
  assert.equal(requests[1]?.params.cwd, fixture.cwd);
  assert.equal(requests[1]?.params.task.id, task.taskId);
  assert.deepEqual(requests[1]?.params.tools, ["read"]);
  assert.ok(completed.events?.some(event => (event.payload as { text?: string } | undefined)?.text === "Codex app-server fake response."));
  assert.equal(completed.events?.at(-1)?.type, "task_status");
  await fixture.restart();
  const restored = await fixture.connect();
  assert.deepEqual(await restored.call("externalAgent/task/reconnect", reconnect), completed);
  assert.deepEqual(await restored.call("externalAgent/task/start", input), { task: completed.task, replayed: true });
  assert.equal(requests.length, 2);
});

test("a second App Server connection cancels the same external dispatch and recovers its receipt after restart", { timeout: 30_000 }, async t => {
  const starts: string[] = [];
  let signal: AbortSignal | undefined;
  let finish: () => void = () => assert.fail("Adapter was not called.");
  const adapterRevision = "owned-fixture-adapter/1";
  const runner: RunnerRegistrationInput = {
    id: "codex-app-server",
    displayName: "Bound test runner",
    status: "enabled",
    executionBoundary: "external",
    adapterRevision,
    toolExecutionConformance: readOnlyExternalConformance(adapterRevision),
    adapter: {
      async runTask(input) {
        starts.push(input.task.id);
        signal = input.signal;
        input.onEvent?.({ type: "assistant_text_delta", text: "working" });
        await new Promise<void>(resolve => {
          const deadline = setTimeout(resolve, 5_000);
          finish = () => { clearTimeout(deadline); resolve(); };
        });
        return { taskId: input.task.id, events: [], messages: [] };
      },
    },
  };
  const fixture = await releaseFixture(t, { runner });
  const first = await fixture.connect();
  const peer = await fixture.connect();
  const created = await first.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/create", { sourceId: "federation", title: "Inspect project" });
  const acceptanceInput = {
    workItemId: created.workItem.workItemId, expectedWorkItemRevision: Number(created.workItem.revision), idempotencyKey: "test-acceptance",
  };
  const accepted = await first.call<{ workItem: LingAppServerWorkItemSnapshot; acceptance: { id: string } }>("workItem/accept", acceptanceInput);
  const registration = await first.call<LingAppServerExternalAgentRegisterResult>("externalAgent/register", {
    idempotencyKey: "test-registration",
    registration: {
      agentId: "test-federation-agent", adapterKind: "codex-app-server", protocolVersion: "test/1", displayName: "Test Runner",
      capabilities: ["task.start", "task.reconnect", "task.cancel", "workItem.dispatch", "workItem.task.start"], workspaceScopes: [created.workItem.workspaceId],
      toolScopes: ["read"], approvalModes: ["host"], source: "local", version: "test",
    },
  });
  const input = {
    registrationId: registration.registrationId,
    submission: {
      workItemId: accepted.workItem.workItemId, workItemRevision: accepted.workItem.revision,
      objective: "Read the fixture", acceptanceSnapshot: { provider: { provider: "fixture", model: "fixture" } },
      workspaceId: accepted.workItem.workspaceId, instructionManifestDigest: "fixture-manifest", idempotencyKey: "test-start",
    },
  };
  const blockedInput = { ...input, submission: { ...input.submission, acceptanceSnapshot: {}, idempotencyKey: "test-blocked" } };
  const blocked = await first.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", blockedInput);
  assert.equal(blocked.task.status, "unknown");
  assert.equal(blocked.task.outcomeReason, "dispatch_provider_unavailable");
  assert.deepEqual(starts, []);
  const start = await first.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input);
  assert.equal(start.task.status, "running");
  const replay = await peer.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(starts, [start.task.taskId]);
  first.close();

  const result = await peer.call<{ status: string }>("externalAgent/task/cancel", {
    registrationId: registration.registrationId, taskId: start.task.taskId, idempotencyKey: "test-cancel",
  });
  assert.equal(result.status, "unknown");
  assert.equal(signal?.aborted, true);
  finish();
  await fixture.restart();
  const restored = await fixture.connect();
  const blockedReplay = await restored.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", blockedInput);
  assert.deepEqual(blockedReplay, { task: blocked.task, replayed: true });
  const reconnected = await restored.call<LingAppServerExternalAgentTaskReconnectResult>("externalAgent/task/reconnect", {
    registrationId: registration.registrationId, taskId: start.task.taskId, submissionId: start.task.submissionId,
    eventCursor: start.task.eventCursor,
  });
  assert.equal(reconnected.task.status, "unknown");
  assert.ok(reconnected.events?.some(event => event.type === "task_unknown"));
  assert.equal((await restored.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input)).replayed, true);
  const recovered = await restored.call<typeof accepted>("workItem/accept", acceptanceInput);
  assert.deepEqual(recovered.acceptance, accepted.acceptance);
  assert.deepEqual(starts, [start.task.taskId]);
});

test("Work Item creation, acceptance, evidence and collaboration retries keep one event per committed revision", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const peer = await fixture.connect();
  const workItemId = "idempotent-events";
  await peer.call("workItem/subscribe", { workItemId });
  const notices = (method: string) => peer.notices.filter(notice => notice.method === method && notice.params?.subject?.workItemId === workItemId);
  const creation = { sourceId: "app-server-evidence", workItemId, title: "Record task evidence", idempotencyKey: "create-once" };
  await assert.rejects(client.call("workItem/create", { ...creation, cwd: fixture.root }), { code: "workspace_binding_invalid" });
  const [created, replayed] = await Promise.all([
    client.call<LingAppServerWorkItemResult>("workItem/create", creation),
    peer.call<LingAppServerWorkItemResult>("workItem/create", creation),
  ]);
  const { workItem } = created;
  assert.deepEqual(replayed, created);
  assert.equal(workItem.workItemId, workItemId);
  assert.equal(workItem.revision, "1");
  await waitFor(() => notices("workItem/created")[0]);
  assert.deepEqual(await peer.call("workItem/create", { ...creation, idempotencyKey: "same-source-another-entry" }), created);
  await assert.rejects(client.call("workItem/create", { ...creation, sourceId: "different-source" }), { code: "idempotency_conflict" });
  const acceptance = { workItemId, expectedWorkItemRevision: Number(workItem.revision), idempotencyKey: "accept-once" };
  const accepted = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/accept", acceptance);
  await waitFor(() => notices("workItem/status/changed").length > 0 ? true : undefined);
  assert.equal((await client.call<{ replayed: boolean }>("workItem/accept", acceptance)).replayed, true);
  const evidence = {
    workItemId, expectedWorkItemRevision: Number(accepted.workItem.revision), expectedEvidenceRevision: 0,
    subjectRevision: accepted.workItem.revision, actorId: "local-user", kind: "observation",
    content: "Evidence recorded once", idempotencyKey: "append-once",
  };
  type EvidenceResult = { status: string; entry: { id: string }; workItemRevision: number };
  const appended = await client.call<EvidenceResult>("workItem/evidence/append", evidence);
  assert.equal(appended.status, "appended");
  await waitFor(() => notices("workItem/evidence/updated").length > 0 ? true : undefined);
  const replay = await client.call<EvidenceResult>("workItem/evidence/append", evidence);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.entry.id, appended.entry.id);
  await assert.rejects(client.call("workItem/evidence/append", { ...evidence, content: "Conflicting evidence" }), { code: "idempotency_conflict" });
  const secondEvidence = await client.call<EvidenceResult>("workItem/evidence/append", {
    ...evidence, expectedWorkItemRevision: appended.workItemRevision, expectedEvidenceRevision: 1, idempotencyKey: "append-next",
  });
  await waitFor(() => notices("workItem/evidence/updated").length >= 2 ? true : undefined);
  const messageInput = {
    workItemId, expectedWorkItemRevision: secondEvidence.workItemRevision, expectedCollaborationRevision: 2,
    actorId: "local-user", idempotencyKey: "message-once", payload: { text: "Send after the evidence is committed" },
  };
  const message = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/message/send", messageInput);
  const collaborationNotice = await waitFor(() => notices("workItem/collaboration/updated")[0]);
  const directNotice = await waitFor(() => client.notices.find(notice => notice.method === "workItem/message/updated"));
  assert.ok(collaborationNotice.params?.eventId);
  assert.equal(directNotice.params?.eventId, collaborationNotice.params.eventId);
  const messageReplay = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/message/send", messageInput);
  assert.equal(messageReplay.status, "replayed");
  assert.equal(messageReplay.record.id, message.record.id);
  await assert.rejects(client.call("workItem/message/send", { ...messageInput, payload: { text: "Conflicting message" } }), { code: "idempotency_conflict" });
  assert.equal(client.notices.filter(notice => notice.method === "workItem/message/updated").length, 1);
  assert.equal(notices("workItem/created").length, 1);
  assert.equal(notices("workItem/status/changed").length, 1);
  assert.equal(notices("workItem/evidence/updated").length, 2);
  const persisted = fixture.getStore().listControlPlaneEvents({ workspaceId: workItem.workspaceId, entityId: workItemId });
  assert.deepEqual(persisted.map(event => event.action), [
    "work_item.created", "work_item.accepted", "work_item.evidence.updated", "work_item.evidence.updated", "work_item.collaboration.message.created",
  ]);
  await fixture.restart();
  const restored = await fixture.connect();
  const restoredItem = await restored.call<typeof created>("workItem/read", { workItemId });
  assert.deepEqual(await restored.call("workItem/create", creation), restoredItem);
  await assert.rejects(restored.call("workItem/create", { ...creation, title: "Changed intent" }), { code: "idempotency_conflict" });
  await restored.call("workItem/subscribe", { workItemId, cursor: String(persisted.at(-2)!.seq) });
  const restoredNotice = await waitFor(() => restored.notices.find(notice => notice.method === "workItem/collaboration/updated"));
  assert.equal(restoredNotice.params?.eventId, directNotice.params?.eventId);

  const { daemonUrl, authToken } = fixture.transportOptions();
  const url = new URL("/app-server/rpc", daemonUrl);
  url.protocol = "ws:";
  url.searchParams.set("cwd", fixture.cwd);
  const sdk = new LingAppServerClient({
    url: url.href, clientInfo: { name: "work-item-acceptance", version: "1" }, autoReconnect: false,
    createSocket: address => new WebSocket(address, { headers: { Authorization: `Bearer ${authToken}` } }) as unknown as LingAppServerSocket,
  });
  t.after(() => sdk.close());
  const current = await sdk.readWorkItem(workItem.workspaceId, workItemId);
  assert.equal(current.workItemId, workItemId);
  assert.equal(current.revision, String(message.workItemRevision));
  const control = { workspaceId: workItem.workspaceId, workItemId, actorId: "local-user" };
  const paused = await sdk.controlWorkItem("pause", { ...control, idempotencyKey: "sdk-pause",
    expectedWorkItemRevision: Number(current.revision), expectedControlGeneration: Number(current.control.generation) });
  assert.equal(paused.control.state, "paused");
  const resumed = await sdk.controlWorkItem("resume", { ...control, idempotencyKey: "sdk-resume",
    expectedWorkItemRevision: Number(paused.revision), expectedControlGeneration: Number(paused.control.generation) });
  assert.equal(resumed.control.state, "active");
  assert.equal((await sdk.readWorkItem(workItem.workspaceId, workItemId)).revision, resumed.revision);
});

test("Work Item controls commit state, receipt and event together and replay after a later control", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const created = await client.call<LingAppServerWorkItemResult>("workItem/create", {
    sourceId: "atomic-control", title: "Recover Work Item controls",
  });
  const { workItemId, workspaceId } = created.workItem;
  const peer = await fixture.connect();
  const { cursor } = await peer.call<{ cursor: string }>("workItem/subscribe", { workItemId });
  const input = {
    workItemId, actorId: "local-user", expectedWorkItemRevision: 1, expectedControlGeneration: 0, idempotencyKey: "atomic-pause",
  };
  const store = fixture.getStore();
  const database = new DatabaseSync(store.paths.databasePath);
  try {
    database.exec("CREATE TRIGGER fail_pause_event BEFORE INSERT ON control_plane_events WHEN NEW.action = 'work_item.control.pause' BEGIN SELECT RAISE(ABORT, 'fixture pause event rejected'); END");
    await assert.rejects(client.call("workItem/pause", input), /fixture pause event rejected/u);
    assert.deepEqual(await client.call("workItem/read", { workItemId }), created);
    assert.equal(store.listAppServerState("work_item_control").length, 0);
    database.exec("DROP TRIGGER fail_pause_event");
  } finally {
    database.close();
  }
  const paused = await client.call<LingAppServerWorkItemControlResult>("workItem/pause", input);
  assert.equal(paused.workItem.control.state, "paused");
  assert.equal(paused.replayed, false);
  const resumed = await peer.call<LingAppServerWorkItemControlResult>("workItem/resume", {
    ...input, expectedWorkItemRevision: 2, expectedControlGeneration: 1, idempotencyKey: "atomic-resume",
  });
  assert.equal(resumed.workItem.control.state, "active");
  const events = () => fixture.getStore().listControlPlaneEvents({ workspaceId, entityId: workItemId, afterSeq: Number(cursor) });
  assert.deepEqual(events().map(event => event.data.receiptId), [paused.controlReceipt.id, resumed.controlReceipt.id]);
  await fixture.restart();
  const restored = await fixture.connect();
  await restored.call("workItem/subscribe", { workItemId, cursor });
  await waitFor(() => restored.notices.find(notice => notice.method === "workItem/replay/ready"));
  const controls = restored.notices.filter(notice => notice.method === "workItem/control/updated");
  assert.deepEqual(controls.map(notice => notice.params?.event?.action), ["work_item.control.pause", "work_item.control.resume"]);
  const retry = await restored.call<LingAppServerWorkItemControlResult>("workItem/pause", input);
  assert.deepEqual(retry, { ...resumed, replayed: true, controlReceipt: paused.controlReceipt });
  await assert.rejects(restored.call("workItem/pause", { ...input, reason: "Different pause" }), { code: "idempotency_conflict" });
  assert.equal(events().length, 2);
});

test("a Pi question is pushed live, accepts the current Host authority once and replays its resolution", { timeout: 30_000 }, async t => {
  const answerText = "Use the repository contract.";
  const provider = await startLoopbackPiProvider((_: unknown, count: number) => count === 1 ? {
    tool: "request_user_input",
    input: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "scope", prompt: "Which contract should I use?", required: true, allowFreeText: true, options: [] },
    ] },
  } : { text: "Used the selected contract." });
  t.after(() => provider.close());
  const fixture = await releaseFixture(t, { harness: { toolBroker: { mode: "enforce" } } });
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Host question" });
  const { cursor } = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  await client.call("thread/subscribe", { threadId: thread.id, cursor });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { run, turn } = await client.call<{ run: { id: string }; turn: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Ask which contract applies.", idempotencyKey: "question-turn", providerPresetId: preset.id,
  });
  const request = await waitFor(() => client.notices.find(notice => notice.method === "input/requestAnswer"));
  assert.match(JSON.stringify(request), /Which contract should I use\?/u);
  assert.doesNotMatch(JSON.stringify(request), /answerAuthority/u);
  await waitFor(() => fixture.getStore().getRun(run.id)?.status === "yielded" ? true : undefined);
  const state = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  const authority = state.pendingInputs[0]?.answerAuthority;
  assert.ok(authority);
  assert.equal(authority.runId, run.id);
  assert.equal(request.params?.requestId, authority.requestId);
  assert.equal(state.pendingInputs[0]?.source.turnId, turn.id);
  await fixture.restart();
  const resumed = await fixture.connect();
  await resumed.call("thread/subscribe", { threadId: thread.id, cursor });
  await waitFor(() => resumed.notices.find(notice => notice.method === "input/requestAnswer"));
  const command: LingAppServerInputRespondParams = {
    schemaVersion: 1, authority, idempotencyKey: "question-answer",
    answers: [{ questionId: "scope", kind: "text", text: answerText }],
  };
  const parsed = parseUserInputAnswerCommandV1(command);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.error));
  await assert.rejects(resumed.call("input/respond", { ...command, cwd: fixture.root }), { code: "workspace_binding_invalid" });
  await assert.rejects(resumed.call("input/respond", { ...command, authority: { ...authority, statusRevision: authority.statusRevision + 1 } }),
    { code: "stale_revision" });
  await assert.rejects(resumed.call("input/respond", { ...command, authority: { ...authority, runId: "different-run" } }), { code: "stale_revision" });
  const accepted = await resumed.call<LingAppServerInputRespondResult>("input/respond", command);
  assert.equal(accepted.receipt.replayed, false);
  assert.equal(accepted.receipt.requestId, authority.requestId);
  const resolution = await waitFor(() => resumed.notices.find(notice =>
    notice.method === "serverRequest/resolved" && notice.params?.event?.entityId === authority.requestId));
  assert.equal(resolution.params?.event?.action, "answered");
  assert.doesNotMatch(JSON.stringify(resolution), new RegExp(answerText, "u"));
  const replay = await resumed.call<LingAppServerInputRespondResult>("input/respond", command);
  assert.deepEqual(replay.receipt, { ...accepted.receipt, replayed: true });
  await assert.rejects(resumed.call("input/respond", { ...command, idempotencyKey: "different-answer" }), { code: "idempotency_conflict" });
  await waitFor(() => fixture.getStore().getUserInputDelivery(thread.id, accepted.receipt.deliveryId)?.status === "applied" ? true : undefined);
  await waitFor(() => fixture.getStore().getLingTurn(turn.id)?.status === "succeeded" ? true : undefined);
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /Use the repository contract/u);
  const observer = await fixture.connect();
  await observer.call("thread/subscribe", { threadId: thread.id, cursor });
  await waitFor(() => observer.notices.find(notice => notice.method === "thread/replay/ready"));
  assert.equal(observer.notices.some(notice => notice.method === "input/requestAnswer"), false);
  assert.deepEqual(observer.notices.filter(notice => notice.method === "serverRequest/resolved"
    && notice.params?.event?.entityId === authority.requestId).map(notice => notice.params?.eventId), [resolution.params?.eventId]);
});

test("an authenticated connection can decide its Run approval and rejects a different workspace binding", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const taskId = "approval-fixture-task";
  const run = store.createRun({
    id: "approval-fixture-run", cwd: fixture.cwd, taskId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  store.markRunStarted(run.id, now);
  const approval = store.createApprovalRequest({
    runId: run.id, taskId, toolCallId: "fixture-tool", actionType: "bash", risk: "high",
    title: "Fixture only", description: "Test approval disposition", payload: {
      type: "bash", cwd: fixture.cwd, command: "true", riskFlags: [],
    },
  }, now);
  const params = { approvalId: approval.id, runId: run.id, decision: "deny" };
  await assert.rejects(client.call("approval/respond", { ...params, cwd: fixture.root }), { code: "workspace_binding_invalid" });
  assert.equal(store.getApprovalRequest(approval.id)?.status, "pending");
  await client.call("approval/respond", params);
  assert.equal(store.getApprovalRequest(approval.id)?.status, "denied");
  await assert.rejects(client.call("approval/respond", params), { code: "request_already_resolved" });
});

test("stdio and the private Unix socket deliver the same App Server Thread events", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const options = fixture.transportOptions();
  assert.equal((await probeLingAppServer(options)).protocolVersion, "ling-app-server/1");
  const input = new PassThrough(), output = new PassThrough();
  const stdio = runLingAppServerStdio(options, input, output);
  t.after(async () => { input.end(); await stdio; });
  const host = jsonLines(input, output);
  await host.call("initialize", { protocolVersions: ["ling-app-server/1"] });
  const { thread } = await host.call<{ thread: { id: string } }>("thread/start", { title: "Stdio Thread" });
  await host.call("thread/subscribe", { threadId: thread.id });
  await host.call("turn/start", { threadId: thread.id, message: "Keep this durable" });
  const notice = await waitFor(() => host.notices.find(value => value.method === "turn/started"));
  assert.equal(notice.params?.subject?.threadId, thread.id);

  const controller = new AbortController();
  const path = join(fixture.root, "a.sock");
  const listener = listenLingAppServerSocket(options, path, controller.signal);
  t.after(async () => { controller.abort(); await listener; });
  await waitFor(async () => {
    const mode = (await lstat(path).catch(() => undefined))?.mode;
    return mode !== undefined && (mode & 0o777) === 0o600 ? true : undefined;
  });
  const socket: Duplex = createConnection(path);
  await once(socket, "connect");
  t.after(() => socket.destroy());
  const peer = jsonLines(socket, socket);
  await peer.call("initialize", { protocolVersions: ["ling-app-server/1"] });
  assert.equal((await peer.call<ThreadRead>("thread/read", { threadId: thread.id })).thread.id, thread.id);
  controller.abort();
  await listener;
  await assert.rejects(lstat(path), { code: "ENOENT" });
  const restart = new AbortController();
  const restarted = listenLingAppServerSocket(options, path, restart.signal);
  t.after(async () => { restart.abort(); await restarted; });
  await waitFor(async () => (await lstat(path).catch(() => undefined))?.isSocket() ? true : undefined);
  await unlink(path);
  await writeFile(path, "replacement");
  restart.abort();
  await restarted;
  assert.equal(await readFile(path, "utf8"), "replacement");
});

test("private Unix socket listener removes a stale published path before rebinding", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const path = join(fixture.root, "stale.sock");
  const bindPath = join(fixture.root, "stale-binding.sock");
  const stale = createServer();
  stale.listen(bindPath);
  await once(stale, "listening");
  await chmod(bindPath, 0o660);
  await link(bindPath, path);
  await new Promise<void>(resolve => stale.close(() => resolve()));
  assert.equal((await lstat(path)).isSocket(), true);

  const controller = new AbortController();
  const listener = listenLingAppServerSocket(fixture.transportOptions(), path, controller.signal);
  t.after(async () => { controller.abort(); await listener; });
  await waitFor(async () => {
    const current = await lstat(path).catch(() => undefined);
    return current?.isSocket() && (current.mode & 0o777) === 0o600 ? true : undefined;
  });
  const socket = createConnection(path);
  await once(socket, "connect");
  socket.destroy();
  controller.abort();
  await listener;
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

type ThreadRead = { thread: { id: string } };

function readOnlyExternalConformance(adapterRevision: string) {
  return {
    adapterRevision, curatedTools: ["read"], toolSideEffects: { read: "workspace_read" },
    allowedSideEffects: ["none", "workspace_read"], nativeSideEffectMode: "disabled",
    toolSurfaceCurated: true, approvalBridgeVerified: true, sandboxBindingVerified: true,
    evidenceCommitVerified: true, abortPropagationVerified: true, attemptFencingVerified: true,
    workspaceBoundaryVerified: true, artifactImportVerified: true,
  } as const;
}

function addLoopbackPreset(store: SqliteRunStore, baseUrl: string) {
  const now = new Date().toISOString();
  const preset = store.createProviderPreset({
    kind: "openai-compatible", displayName: "Release Pi fixture", providerId: "release-pi-fixture", model: "static-tools",
    api: "openai-completions", baseUrl, authHeader: false, reasoning: false, capabilities: ["chat"], enabled: true,
  }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Loopback fixture", checkedAt: now });
  return preset;
}

test("the MCP bridge calls the bound App Server and replays the same Thread on retry", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const input = new PassThrough(), output = new PassThrough();
  const running = runLingAppServerMcp(fixture.transportOptions(), input, output);
  t.after(async () => { input.end(); await running; });
  const host = jsonLines(input, output);
  await host.call("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, clientInfo: { name: "Fixture", version: "1" }, capabilities: {} });
  host.send("notifications/initialized", {});
  const { tools } = await host.call<{ tools: Array<{ name: string }> }>("tools/list");
  assert.ok(tools.some(tool => tool.name === "ling_turn_start"));
  assert.ok(tools.every(tool => !tool.name.includes("approval")));
  const call = async (name: string, args: object) => {
    const reply = await host.call<{ isError?: boolean; content: Array<{ text: string }> }>("tools/call", { name, arguments: args });
    assert.ok(!reply.isError, reply.content[0]?.text);
    return JSON.parse(reply.content[0]!.text) as ThreadRead;
  };
  const request = { title: "MCP Thread", idempotencyKey: "identity" };
  const first = await call("ling_thread_start", request);
  assert.equal((await call("ling_thread_start", request)).thread.id, first.thread.id);
  assert.equal((await call("ling_thread_read", { threadId: first.thread.id })).thread.id, first.thread.id);
});

const previousBuild = process.env.LING_APP_SERVER_PREVIOUS_BUILD;
test("candidate App Server recovers v0.6.1 Thread state and preserves legacy clients", {
  skip: !previousBuild, timeout: 30_000,
}, async t => {
  const previousModule = (path: string) => pathToFileURL(join(previousBuild!, "packages", path)).href;
  const [daemon, core, sdk] = await Promise.all([
    import(previousModule("daemon/dist/index.js")) as Promise<Pick<ReleaseRuntime, "createDaemonServer">>,
    import(previousModule("core/dist/index.js")) as Promise<Omit<ReleaseRuntime, "createDaemonServer">>,
    import(previousModule("api-client/dist/index.js")) as Promise<{ LingDaemonClient: typeof LingDaemonClient }>,
  ]);
  const fixture = await releaseFixture(t, { initialRuntime: { ...core, ...daemon } });
  const legacyClient = () => {
    const { daemonUrl, authToken } = fixture.transportOptions();
    return new sdk.LingDaemonClient({ baseUrl: daemonUrl, fetch(input, init) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${authToken}`);
      return fetch(input, { ...init, headers });
    } });
  };
  const currentClient = (path: string) => {
    const { daemonUrl, authToken } = fixture.transportOptions();
    const url = new URL(path, daemonUrl);
    url.protocol = "ws:";
    url.searchParams.set("cwd", fixture.cwd);
    const client = new LingAppServerClient({
      url: url.href, clientInfo: { name: "release-compatibility", version: "1" }, autoReconnect: false,
      createSocket: url => new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }) as unknown as LingAppServerSocket,
      requestTimeoutMs: 3_000,
    });
    t.after(() => client.close());
    return client;
  };

  // A legacy client opens this workspace before the candidate migrates its database.
  await legacyClient().listApprovals(fixture.cwd);
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", title: "Legacy delivery", objective: "Preserve the pending approval" }, now);
  const taskId = "legacy-task";
  const run = store.createRun({
    id: "legacy-run", threadId: thread.id, cwd: fixture.cwd, taskId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  const turn = store.createLingTurn({
    threadId: thread.id, kind: "initial_request", title: "Legacy run", userInstruction: "Check the fixture", lastRunId: run.id,
  }, now);
  store.markRunStarted(run.id, now);
  const approval = store.createApprovalRequest({
    runId: run.id, taskId, toolCallId: "legacy-tool", actionType: "bash", risk: "high",
    title: "Fixture approval", description: "Verify approval survival across versions",
    payload: { type: "bash", cwd: fixture.cwd, command: "true", riskFlags: [] },
  }, now);
  const cursor = String(store.getLatestControlPlaneEventSeq(thread.workspaceId));
  const event = store.appendControlPlaneEvent({
    workspaceId: thread.workspaceId, cwd: fixture.cwd, domain: "approvals", entityType: "approval",
    entityId: approval.id, action: "approval.requested", data: { runId: run.id, threadId: thread.id },
  }, now);
  assert.equal((await legacyClient().getApproval(fixture.cwd, approval.id)).approval.status, "pending");
  const incompatible = currentClient("/rpc/stream");
  await assert.rejects(incompatible.startThread({ title: "Must not start", threadId: "refused-on-legacy" }), { code: "protocol_version_unsupported" });
  incompatible.close();
  assert.equal(store.getLingThread("refused-on-legacy"), undefined);

  await fixture.restart();
  const current = currentClient("/app-server/rpc");
  const snapshot = await current.readThreadSnapshot({ threadId: thread.id });
  assert.equal(snapshot.turn?.id, turn.id);
  assert.equal(snapshot.run?.id, run.id);
  assert.equal(snapshot.pendingApprovals.find(item => item.id === approval.id)?.status, "pending");
  const replay = await current.readThreadEvents({ threadId: thread.id, cursor });
  assert.ok(replay.events.some(item => item.seq === event.seq && item.entityId === approval.id));
  assert.equal((await legacyClient().getLingThread(fixture.cwd, thread.id)).thread.id, thread.id);
  await current.respondApproval({ approvalId: approval.id, runId: run.id, decision: "deny" });
  assert.equal((await legacyClient().getApproval(fixture.cwd, approval.id)).approval.status, "denied");

  const { daemonUrl, authToken } = fixture.transportOptions();
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [
    cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl, "app-server", "probe",
  ], { env: { ...process.env, LING_STACK_AUTH_TOKEN: authToken }, timeout: 8_000 });
  assert.equal(JSON.parse(stdout).ok, true);
});

type JsonLine = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
  params?: { eventId?: string; requestId?: string; revision?: string; event?: { entityId: string; action: string };
    itemId?: string; runId?: string; streamEpoch?: string; offset?: number; text?: string;
    subject?: { threadId?: string; turnId?: string; workItemId?: string } };
};

function jsonLines(input: Writable, output: Readable) {
  const messages = new Map<number, JsonLine>();
  const notices: JsonLine[] = [];
  let next = 0;
  let pending = "";
  output.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const message = JSON.parse(pending.slice(0, end)) as JsonLine;
      pending = pending.slice(end + 1);
      if (typeof message.id === "number") messages.set(message.id, message);
      else notices.push(message);
    }
  });
  const send = (method: string, params: object, id?: number) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return { send, notices, async call<T>(method: string, params: object = {}) {
    const id = ++next;
    send(method, params, id);
    const response = await waitFor(() => messages.get(id));
    messages.delete(id);
    if (response.error) throw new Error(response.error.message);
    return response.result as T;
  } };
}

type ReleaseRuntime = {
  createDaemonServer: typeof createDaemonServer;
  createSqliteRunStore: typeof createSqliteRunStore;
  resolveStoragePaths: typeof resolveStoragePaths;
};
const candidateRuntime: ReleaseRuntime = { createDaemonServer, createSqliteRunStore, resolveStoragePaths };

async function releaseFixture(t: TestContext, {
  runner, initialRuntime = candidateRuntime, harness,
}: { runner?: RunnerRegistrationInput; initialRuntime?: ReleaseRuntime; harness?: DaemonConfig["harness"] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-as-")));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const authToken = randomUUID();
  const priorLingHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "fixture-home");
  const stores = new Map<string, SqliteRunStore>();
  const clients = new Set<WebSocket>();
  const makeDaemon = (runtime: ReleaseRuntime) => runtime.createDaemonServer({
    host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd, authToken, harness,
  }, {
    ...(runner ? { runnerRegistry: createRunnerRegistry([runner]) } : {}),
    chromeBrowserNativeMessagingEnabled: false,
    remoteReplyDispatcher: null,
    storeFactory(workspace) {
      const store = runtime.createSqliteRunStore(workspace, runtime.resolveStoragePaths(workspace, {
        homeDir: join(root, "fixture-home"), env: {}, workspaceStateLocation: "repo-local",
      }).workspace);
      stores.set(workspace, store);
      return store;
    },
  });
  let daemon = makeDaemon(initialRuntime);
  async function stop() {
    for (const socket of clients) socket.terminate();
    clients.clear();
    await daemon.stop();
  }
  t.after(async () => {
    try { await stop(); } finally {
      if (priorLingHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = priorLingHome;
      await rm(root, { recursive: true, force: true });
    }
  });
  await daemon.start();
  return {
    root,
    cwd,
    transportOptions() {
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      return { daemonUrl: `http://127.0.0.1:${address.port}`, cwd, authToken };
    },
    getStore() {
      const store = stores.get(cwd);
      assert.ok(store);
      return store;
    },
    async restart() {
      await stop();
      stores.clear();
      daemon = makeDaemon(candidateRuntime);
      await daemon.start();
    },
    async connect() {
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      clients.add(socket);
      await once(socket, "open");
      let next = 0;
      const messages = new Map<number, { result?: unknown; error?: { data: { code: string }; message: string } }>();
      const notices: JsonLine[] = [];
      socket.on("message", data => {
        const value = JSON.parse(data.toString());
        if (typeof value.id === "number") messages.set(value.id, value);
        else notices.push(value);
      });
      const call = async <T>(method: string, params: object = {}): Promise<T> => {
        const id = ++next;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        const response = await waitFor(() => messages.get(id));
        messages.delete(id);
        if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.data.code });
        return response.result as T;
      };
      await call("initialize", { protocolVersions: ["ling-app-server/1"] });
      await call("workItem/list", {});
      return { call, notices, close: () => socket.terminate() };
    },
  };
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for the App Server fixture.");
}

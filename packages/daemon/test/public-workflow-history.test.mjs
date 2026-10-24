import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { handleLingThreadItem, handleLingThreadsCollection } from "../dist/features/runs/thread-routes.js";
import { listChannelConversationItems } from "../dist/features/channels/channel-conversation-api.js";
import { handleGetRun } from "../dist/features/runs/routes.js";
import { projectPublicConversationItem, projectPublicLingThread, projectPublicLingTurn,
  projectPublicRunSession, projectPublicWorkUnit } from "../dist/features/runs/public-execution-snapshots.js";

const at = "2026-10-24T00:00:00.000Z";
const canary = "PRIVATE_ROLE_MEMORY_HISTORICAL_INPUT_CANARY";
const publicBody = "User follow-up, keep literal prompt/systemPrompt keys unchanged";
const payload = body => ({ body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] });

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-public-history-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Public history fixture", boundPath: cwd }, at);
  const task = store.createTask({ channelId: channel.id, title: "Workflow task", prompt: canary }, at);
  const thread = store.createLingThread({ kind: "workflow_step", channelId: channel.id,
    title: "Workflow task", objective: canary }, at);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "workflow_step", title: task.title,
    userInstruction: canary, channelId: channel.id, taskId: task.id, createdByActor: "system" }, at);
  const item = store.appendConversationItem({ threadId: thread.id, turnId: turn.id, channelId: channel.id,
    kind: "user_message", status: "committed", actorType: "system", actorId: "workflow-dispatch",
    visibility: "channel", payload: payload(canary), domainRefs: [] }, at);
  const followup = store.createLingTurn({ threadId: thread.id, kind: "manual_followup", title: "Follow-up",
    userInstruction: publicBody, createdByActor: "local-user", channelId: channel.id }, at);
  const userItem = store.appendConversationItem({ threadId: thread.id, turnId: followup.id, channelId: channel.id,
    kind: "user_message", status: "committed", actorType: "local_user", visibility: "channel",
    payload: payload(publicBody), domainRefs: [] }, at);
  // Historical generic resume could lose workflowStepId but kept the owning workflow Thread.
  const run = store.createRun({ id: "historical_unmarked_run", cwd, taskId: task.id, threadId: thread.id,
    turnId: turn.id, providerName: "fixture", providerModel: "fixture", providerPresetId: "fixture",
    taskSnapshot: { id: task.id, title: task.title, prompt: canary }, providerSnapshot: {},
    requestSnapshot: { cwd, threadId: thread.id, providerPresetId: "fixture", task: { id: task.id, title: task.title, prompt: canary } },
    createdAt: at });
  store.markRunSucceeded(run.id, at);
  let starts = 0;
  const registry = { getStore: () => store, findStoreForRun: () => store };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (url.pathname === "/threads") await handleLingThreadsCollection(request, response, url, registry, 100_000);
      else if (url.pathname === "/items") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(listChannelConversationItems({ store, cwd, channel, thread })));
      } else if (url.pathname === "/run") handleGetRun(response, url, registry, run.id);
      else await handleLingThreadItem(request, response, url, registry,
        { kind: url.pathname.slice(1) || "detail", threadId: thread.id },
        { maxBodyBytes: 100_000, startResumeRun: async () => { starts++; return run.id; },
          startForkRun: async () => { starts++; return run.id; } });
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}`,
      body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  return { store, thread, turn, item, userItem, followup, run, request, starts: () => starts };
}

test("historical workflow HTTP thread/turn/item/Run DTOs hide private dispatch input without rewriting facts", async t => {
  const f = await fixture(t);
  const before = [f.store.getLingThread(f.thread.id), f.store.getLingTurn(f.turn.id),
    f.store.getConversationItem(f.item.id), f.store.getRun(f.run.id)];
  for (const path of ["/detail", "/threads", "/turns", "/items", "/run", "/evidence"]) {
    const result = await f.request(path);
    assert.equal(result.status, 200, result.text);
    assert.doesNotMatch(result.text, new RegExp(canary, "u"), path);
    if (path === "/turns" || path === "/items") assert.ok(result.text.includes(publicBody), path);
  }
  assert.deepEqual([f.store.getLingThread(f.thread.id), f.store.getLingTurn(f.turn.id),
    f.store.getConversationItem(f.item.id), f.store.getRun(f.run.id)], before);
});

test("workflow search cannot disclose private input via match snippets or private-only matches", async t => {
  const f = await fixture(t);
  const result = await f.request(`/threads?q=${canary}`);
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body.threads, []);
  assert.deepEqual(result.body.matches, []);
  const publicSearch = await f.request("/threads?q=Workflow");
  assert.equal(publicSearch.status, 200, publicSearch.text);
  assert.equal(publicSearch.body.threads.length, 1);
  assert.doesNotMatch(publicSearch.text, new RegExp(canary, "u"));
});

test("workflow resume preview is public and generic resume cannot rehydrate private workflow input", async t => {
  const f = await fixture(t);
  const body = { sourceRunId: f.run.id, turnId: f.turn.id, instruction: "Continue safely" };
  const preview = await f.request("/resume-preview", body);
  assert.equal(preview.status, 200, preview.text);
  assert.doesNotMatch(preview.text, new RegExp(canary, "u"));
  assert.ok(preview.body.context.contextText.includes("Continue safely"));
  const resume = await f.request("/resume", body);
  assert.equal(resume.status, 409, resume.text);
  assert.equal(resume.body.error, "workflow_step_resume_required");
  assert.equal(f.starts(), 0);
});

test("workflow fork and fork-run source and child DTOs never reuse historical private input", async t => {
  const f = await fixture(t);
  const body = { sourceRunId: f.run.id, turnId: f.turn.id, instruction: "New user objective", idempotencyKey: "public-fork" };
  const fork = await f.request("/fork", body);
  assert.equal(fork.status, 201, fork.text);
  assert.doesNotMatch(fork.text, new RegExp(canary, "u"));
  const forkRun = await f.request("/fork-run", { ...body, idempotencyKey: "public-fork-run" });
  assert.equal(forkRun.status, 202, forkRun.text);
  assert.doesNotMatch(forkRun.text, new RegExp(canary, "u"));
  assert.equal(f.starts(), 1);
});

test("trusted workflow Thread ownership protects unmarked Run-owned WorkUnits and leaves ordinary inputs intact", async t => {
  const f = await fixture(t);
  for (const kind of ["task_run", "conversation_run", "channel_ai_reply", "teammate_direct_reply"]) {
    for (const lineage of [{ linkedRunId: f.run.id }, {}]) {
      const workUnit = { id: `work_${kind}`, kind, ...lineage, request: f.run.requestSnapshot };
      const before = structuredClone(workUnit);
      assert.doesNotMatch(JSON.stringify(projectPublicWorkUnit(workUnit, f.store)), new RegExp(canary, "u"));
      assert.deepEqual(workUnit, before);
    }
  }
  const thread = f.store.createLingThread({ kind: "conversation", title: "Ordinary", objective: publicBody }, at);
  const turn = { ...f.followup, threadId: thread.id };
  const run = { ...f.run, threadId: thread.id, taskSnapshot: { prompt: publicBody }, requestSnapshot: { task: { prompt: publicBody } } };
  assert.deepEqual(projectPublicRunSession(run, f.store).taskSnapshot, run.taskSnapshot);
  assert.deepEqual(projectPublicRunSession(run, f.store).requestSnapshot, run.requestSnapshot);
  assert.equal(projectPublicLingThread(thread), thread);
  assert.equal(projectPublicLingTurn(turn, thread), turn);
  assert.equal(projectPublicConversationItem(f.userItem, f.thread, f.followup), f.userItem);
  for (const kind of ["user_input_request", "user_input_answer", "tool_call", "tool_result", "assistant_message"]) {
    const item = { ...f.item, kind, payload: { body: publicBody, systemPrompt: "User domain value" } };
    assert.equal(projectPublicConversationItem(item, f.thread, f.turn), item, kind);
  }
  // Missing historical Turn provenance must not restore a dispatch body.
  const projected = projectPublicConversationItem({ ...f.item, turnId: undefined }, f.thread);
  assert.doesNotMatch(JSON.stringify(projected), new RegExp(canary, "u"));
});

test("search uses referenced Run/Turn workflow ownership even under an ordinary Thread", async t => {
  const thread = { id: "task_thread", kind: "task", title: "Ordinary task", objective: "Public objective" };
  const turn = { id: "workflow_turn", threadId: thread.id, kind: "workflow_step", createdByActor: "system",
    workflowStepId: "step", userInstruction: canary };
  const run = { id: "workflow_run", threadId: thread.id, workflowStepId: "step",
    taskSnapshot: { prompt: canary }, requestSnapshot: { task: { prompt: canary } } };
  const ordinaryTurn = { ...turn, id: "user_turn", kind: "manual_followup", workflowStepId: undefined,
    createdByActor: "local-user", userInstruction: publicBody };
  const ordinaryRun = { ...run, id: "user_run", workflowStepId: undefined,
    taskSnapshot: { prompt: publicBody }, requestSnapshot: { task: { prompt: publicBody } } };
  const store = {
    getLingThread: () => thread,
    getLingTurn: id => id === turn.id ? turn : id === ordinaryTurn.id ? ordinaryTurn : undefined,
    getRun: id => id === run.id ? run : id === ordinaryRun.id ? ordinaryRun : undefined,
    searchLingThreads: () => ({ threads: [thread], matches: [
      { threadId: thread.id, turnId: turn.id, field: "turn_instruction", snippet: canary },
      { threadId: thread.id, runId: run.id, field: "task_prompt", snippet: canary },
      { threadId: thread.id, turnId: ordinaryTurn.id, field: "turn_instruction", snippet: publicBody },
      { threadId: thread.id, runId: ordinaryRun.id, field: "task_prompt", snippet: publicBody },
    ] }),
  };
  const server = createServer((request, response) => void handleLingThreadsCollection(request, response,
    new URL(request.url, "http://localhost"), { getStore: () => store }, 100_000));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/threads?cwd=fixture&q=private`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.doesNotMatch(text, new RegExp(canary, "u"));
  assert.deepEqual(JSON.parse(text).matches.map(match => match.turnId ?? match.runId), [ordinaryTurn.id, ordinaryRun.id]);
});

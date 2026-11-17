import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, type LingThread, type LingTurn, type RunSession, type RunStore } from "@ling-stack/core";
import type { ThreadWorkspaceChangeSummaryResponse } from "@ling-stack/contracts";
import { applyPatchActionDraft, createPatchActionDraft } from "../dist/features/runs/patch-actions.js";
import { buildThreadWorkspaceChangeSummary } from "../dist/features/runs/thread-workspace-change-summary.js";
import { handleLingThreadItem } from "../dist/features/runs/thread-routes.js";
import { parseLingThreadRoute } from "../dist/server/routes.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-thread-change-summary-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "conversation", title: "Review", objective: "File changes" }, at(0));
  const turn = (minute: number, owner: LingThread = thread) => store.createLingTurn({
    threadId: owner.id, kind: "manual_followup", title: "Edit", userInstruction: "Edit files", status: "running",
  }, at(minute));
  const run = (id: string, turn: LingTurn) => {
    const run = store.createRun({ id, cwd, taskId: `task_${id}`, threadId: turn.threadId, turnId: turn.id,
      providerName: "fixture", providerModel: "fixture", taskSnapshot: { id: `task_${id}`, title: "Edit" },
      providerSnapshot: {}, requestSnapshot: { cwd }, createdAt: turn.createdAt });
    if (!store.listLingTurnRuns(turn.id).some((link) => link.runId === id)) store.linkRunToLingTurn({ turnId: turn.id, runId: id, now: turn.createdAt });
    return run;
  };
  const apply = async (run: RunSession, text: string) => {
    const patchText = `*** Begin Patch\n${text}\n*** End Patch`;
    const draft = createPatchActionDraft({ request: { toolName: "edit", toolCallId: `edit_${run.id}`, task: { id: run.taskId, title: "Edit", prompt: "Edit" }, cwd, input: { patchText } }, patchText, allowedWritePaths: [cwd] });
    const result = await applyPatchActionDraft({ draft, cwd, allowedWritePaths: [cwd], provenance: { store, run } });
    assert.notEqual(result.handledResult.isError, true, JSON.stringify(result.handledResult));
  };
  return { cwd, store, thread, turn, run, apply,
    summary: (owner = thread, source: RunStore = store) => buildThreadWorkspaceChangeSummary(source, cwd, owner) };
}

test("latest creation-ordered Turn replaces older work and never mixes sibling threads", async (t) => {
  const f = await fixture(t);
  const old = f.turn(1); const latest = f.turn(2);
  const oldRun = f.run("old", old); const latestRun = f.run("latest", latest);
  await f.apply(latestRun, "*** Add File: latest.txt\n+latest");
  // An old Turn can be updated after the newest Turn has already started.
  await f.apply(oldRun, "*** Add File: old.txt\n+old");
  const sibling = f.store.createLingThread({ kind: "conversation", title: "Sibling", objective: "Separate" }, at(3));
  await f.apply(f.run("sibling", f.turn(4, sibling)), "*** Add File: sibling.txt\n+sibling");
  const summary = f.summary();
  assert.equal(summary.threadId, f.thread.id);
  assert.equal(summary.turn?.id, latest.id);
  assert.equal(summary.review?.scope.id, latest.id);
  assert.deepEqual(summary.review?.files.map((file) => file.path), ["latest.txt"]);
  assert.equal(summary.review?.additions, 1);
  assert.equal("diff" in summary.review!.files[0]!, false);
  const next = f.turn(5);
  assert.equal(f.summary().turn?.id, next.id);
  assert.equal(f.summary().review, undefined, "empty newest Turn must not fall back to an older review");
});

test("net summary composes repeat edits across linked Runs and removes restored files", async (t) => {
  const f = await fixture(t); const turn = f.turn(1); const first = f.run("first", turn);
  await writeFile(join(f.cwd, "app.txt"), "base\n");
  await f.apply(first, "*** Update File: app.txt\n@@\n-base\n+middle");
  const resumed = f.run("resumed", turn);
  await f.apply(resumed, "*** Update File: app.txt\n@@\n-middle\n+final");
  const summary = f.summary();
  assert.equal(summary.review?.state, "exact");
  assert.equal(summary.review?.additions, 1); assert.equal(summary.review?.deletions, 1);
  const records = f.store.listWorkspaceMutationRecords({ turnId: turn.id });
  await writeFile(join(f.cwd, "app.txt"), "external WIP\n");
  assert.deepEqual(f.summary(), summary, "summary must read immutable snapshots, not the live file");
  assert.deepEqual(f.store.listWorkspaceMutationRecords({ turnId: turn.id }), records);
  await writeFile(join(f.cwd, "app.txt"), "final\n");
  await f.apply(resumed, "*** Update File: app.txt\n@@\n-final\n+base");
  assert.deepEqual(f.summary().review?.files, []);
  assert.equal(f.summary().review?.additions, 0);
});

test("missing evidence preserves known paths but cannot invent complete totals", async (t) => {
  const f = await fixture(t); const run = f.run("partial", f.turn(1));
  await f.apply(run, "*** Add File: exact.txt\n+one");
  await f.apply(run, "*** Add File: unavailable.txt\n+two");
  const source = new Proxy(f.store, { get(target, key) {
    if (key === "listWorkspaceMutationRecords") return (options: Parameters<RunStore["listWorkspaceMutationRecords"]>[0]) =>
      target.listWorkspaceMutationRecords(options).map((record) => record.path === "unavailable.txt" ? { ...record, forwardPatchArtifactId: undefined } : record);
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const summary = f.summary(f.thread, source);
  assert.equal(summary.review?.state, "partial");
  assert.equal(summary.review?.additions, undefined); assert.equal(summary.review?.deletions, undefined);
  assert.deepEqual(summary.review?.files.map((file) => [file.path, file.state]), [["exact.txt", "exact"], ["unavailable.txt", "unavailable"]]);
  assert.equal(summary.review?.files[1]?.additions, undefined);
});

test("private workflow Turn does not expose summary or fall back to public history", async (t) => {
  const f = await fixture(t);
  await f.apply(f.run("public", f.turn(1)), "*** Add File: public.txt\n+public");
  f.store.createLingTurn({ threadId: f.thread.id, kind: "workflow_step", createdByActor: "system",
    title: "Private execution", userInstruction: "private dispatch context" }, at(2));
  assert.deepEqual(f.summary(), { cwd: f.cwd, threadId: f.thread.id });
});

test("thread summary HTTP route enforces method, cwd and thread identity", async (t) => {
  const f = await fixture(t);
  let opens = 0;
  const registry = new RunStoreRegistry(() => { opens += 1; return f.store; }, { recoverOnOpen: false, trustedWorkspaceRoots: [f.cwd] });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const route = parseLingThreadRoute(url.pathname);
    assert.ok(route);
    void Promise.resolve(handleLingThreadItem(request, response, url, registry, route));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const path = `http://127.0.0.1:${address.port}/threads/${f.thread.id}/workspace-change-summary`;
  const url = `${path}?${new URLSearchParams({ cwd: f.cwd })}`;
  assert.equal((await fetch(path)).status, 400);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await fetch(url)).status, 404);
  assert.equal(opens, 0, "an observation cannot initialize or recover a workspace");
  registry.getStore(f.cwd);
  assert.equal((await fetch(url.replace(f.thread.id, "missing"))).status, 404);
  const response = await fetch(url); assert.equal(response.status, 200);
  const body = await response.json() as ThreadWorkspaceChangeSummaryResponse;
  assert.deepEqual(body, { cwd: f.cwd, threadId: f.thread.id });
});

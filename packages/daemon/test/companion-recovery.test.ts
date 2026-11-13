import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, type CompanionMessageResponse } from "../../core/dist/index.js";
import { resolveConfig } from "../dist/config.js";
import {
  handleCompanionMessagesCollection, handleCompanionMessageStream,
  type CreateCompanionReply,
} from "../dist/features/companions/dialogue.js";
import { CompanionSchedulerRegistry } from "../dist/features/companions/scheduler.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

const teammateId = "teammate_builtin_engineer";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-companion-recovery-"));
  let store = createSqliteRunStore(cwd);
  const registryForStore = () => new RunStoreRegistry(() => store, { trustedWorkspaceRoots: [cwd] });
  let registry = registryForStore();
  registry.getStore(cwd);
  const companion = store.createCompanion({ teammateId, displayName: "Recovery companion",
    behaviorPolicy: { proactiveEnabled: true, cooldownMs: 0 } }, new Date().toISOString());
  t.after(async () => {
    registry.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd, companion,
    get store() { return store; },
    get registry() { return registry; },
    reopen() {
      registry.closeAll();
      store = createSqliteRunStore(cwd);
      registry = registryForStore();
      registry.getStore(cwd);
    },
  };
}

async function serveMessages(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, createReply: CreateCompanionReply) {
  const config = resolveConfig({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd });
  const server = createServer((request, response) => {
    const handler = request.url?.split("?")[0].endsWith("/stream")
      ? handleCompanionMessageStream : handleCompanionMessagesCollection;
    void handler(request, response, config, f.registry, f.companion.id, createReply).catch(error => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const close = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  };
  t.after(close);
  return { url: `http://127.0.0.1:${address.port}?cwd=${encodeURIComponent(f.cwd)}`, close };
}

async function send(url: string, streaming: boolean) {
  const parsed = new URL(url);
  parsed.pathname = streaming ? "/messages/stream" : "/messages";
  const response = await fetch(parsed, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "Please retry this message.", idempotencyKey: "retry-message" }),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await response.text();
  type Reply = Pick<CompanionMessageResponse, "message" | "aiReply">;
  const result = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n\n").find(event => event.startsWith("event: done\n"))?.split("\ndata: ")[1]
    : response.ok ? raw : undefined;
  return { status: response.status, raw, reply: result ? JSON.parse(result) as Reply : undefined };
}

for (const streaming of [false, true]) {
  test(`${streaming ? "streaming" : "JSON"} companion messages retry a startup failure after reopening storage`, async t => {
    const f = await fixture(t);
    let calls = 0;
    const createReply: CreateCompanionReply = async input => {
      if (++calls === 1) throw new Error("provider startup unavailable");
      return input.store.createTeammateDirectMessage({
        id: input.replyMessageId, teammateId, threadId: input.thread.id,
        authorType: "ai-teammate", authorId: teammateId, body: "Recovered.", status: "ready",
      }, new Date().toISOString());
    };
    const first = await serveMessages(t, f, createReply);
    const failed = await send(first.url, streaming);
    assert.equal(failed.reply, undefined);
    assert.match(failed.raw, /provider startup unavailable/u);
    const original = f.store.listTeammateDirectMessages({ teammateId })[0];
    assert.ok(original);
    await first.close();
    f.reopen();

    const restarted = await serveMessages(t, f, createReply);
    const retried = await send(restarted.url, !streaming);
    assert.equal(retried.status, 200, retried.raw);
    assert.ok(retried.reply?.aiReply);
    assert.equal(retried.reply?.message.id, original.id);
    assert.equal(retried.reply.aiReply.body, "Recovered.");
    const replayed = await send(restarted.url, streaming);
    assert.equal(replayed.reply?.aiReply?.id, retried.reply.aiReply.id);
    assert.equal(calls, 2);
    assert.equal(f.store.listTeammateDirectMessages({ teammateId }).length, 2);
    assert.equal(f.store.listCompanionEvents({ companionId: f.companion.id })
      .filter(event => event.type === "message" && event.payload.direction === "user").length, 1);
  });
}

test("a persisted pending reply is not dispatched again after a transport failure", async t => {
  const f = await fixture(t);
  let calls = 0;
  const createReply: CreateCompanionReply = async input => {
    calls++;
    input.store.createTeammateDirectMessage({ id: input.replyMessageId,
      teammateId, threadId: input.thread.id, authorType: "ai-teammate",
      authorId: teammateId, body: "", status: "pending" }, new Date().toISOString());
    throw new Error("transport disconnected");
  };
  const server = await serveMessages(t, f, createReply);
  assert.equal((await send(server.url, false)).status, 400);
  const retry = await send(server.url, true);
  assert.equal(retry.status, 409);
  assert.match(retry.raw, /companion_message_in_progress/u);
  assert.equal(calls, 1);
});

for (const legacyMarker of [false, true]) {
  test(`proactive failures retry after restart${legacyMarker ? " with an incomplete persisted marker" : ""}`, async t => {
    const f = await fixture(t);
    let calls = 0;
    const createReply: CreateCompanionReply = async input => {
      if (++calls === 1) throw new Error("provider startup unavailable");
      return input.store.createTeammateDirectMessage({ id: input.replyMessageId,
        teammateId, threadId: input.thread.id, authorType: "ai-teammate",
        authorId: teammateId, body: "Recovered proactive reply.", status: "ready" }, new Date().toISOString());
    };
    const scheduler = () => new CompanionSchedulerRegistry({ storeRegistry: f.registry, replyService: { createReply } });
    const options = { idempotencyKey: "proactive-retry" };
    await assert.rejects(scheduler().trigger(f.cwd, f.companion.id, options), /provider startup unavailable/u);
    assert.equal(f.store.getCompanionState(f.companion.id)?.phase, "error");
    assert.equal(f.store.listCompanionEvents({ companionId: f.companion.id })
      .filter(event => event.type === "proactive_prompt").length, 0);
    if (legacyMarker) {
      f.store.recordCompanionEvent({ companionId: f.companion.id, type: "proactive_prompt", payload: {
        idempotencyKey: options.idempotencyKey,
        messageId: f.store.listTeammateDirectMessages({ teammateId })[0].id,
      } }, new Date().toISOString());
    }
    f.reopen();
    const restarted = scheduler();
    const results = await Promise.all([
      restarted.trigger(f.cwd, f.companion.id, options),
      restarted.trigger(f.cwd, f.companion.id, options),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), ["duplicate", "started"]);
    for (const result of results) assert.equal(result.response?.aiReply?.body, "Recovered proactive reply.");
    const replayed = await restarted.trigger(f.cwd, f.companion.id, options);
    assert.equal(replayed.status, "duplicate");
    assert.equal(replayed.response?.aiReply?.id, results[0].response?.aiReply?.id);
    assert.equal(calls, 2);
    assert.equal(f.store.listTeammateDirectMessages({ teammateId }).length, 2);
  });
}

test("proactive cooldown applies during execution while the same request joins its reply", async t => {
  const f = await fixture(t);
  f.store.updateCompanion(f.companion.id, { behaviorPolicy: {
    ...f.companion.behaviorPolicy, cooldownMs: 60_000,
  } }, new Date().toISOString());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const createReply: CreateCompanionReply = async input => {
    entered();
    await gate;
    return input.store.createTeammateDirectMessage({ id: input.replyMessageId,
      teammateId, threadId: input.thread.id, authorType: "ai-teammate",
      authorId: teammateId, body: "One proactive reply.", status: "ready" }, new Date().toISOString());
  };
  const scheduler = new CompanionSchedulerRegistry({ storeRegistry: f.registry, replyService: { createReply } });
  const first = scheduler.trigger(f.cwd, f.companion.id, { idempotencyKey: "first" });
  const pending = [first];
  try {
    await started;
    const other = await scheduler.trigger(f.cwd, f.companion.id, { idempotencyKey: "other" });
    assert.equal(other.status, "skipped");
    assert.equal(other.reason, "cooldown");
    pending.push(scheduler.trigger(f.cwd, f.companion.id, { idempotencyKey: "first" }));
    release();
    const [result, duplicate] = await Promise.all(pending);
    assert.equal(result.status, "started");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.response?.aiReply?.body, "One proactive reply.");
    assert.equal(duplicate.response?.aiReply?.id, result.response?.aiReply?.id);
  } finally {
    release();
    await Promise.allSettled(pending);
  }
});

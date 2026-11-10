import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { createLingTraceId, createSqliteRunStore, resolveStoragePaths } from "../../../core/dist/index.js";
import { RunStoreRegistry } from "../../dist/runtime/store-registry.js";
import { routeRequest } from "../../dist/server/router.js";

/** Real SQLite, Registry and router over owned loopback HTTP; no runner, Provider, App or external fetch. */
export async function runtimeTraceFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b012-trace-")));
  const cwd = join(root, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  assert.ok(paths.artifactsDir.startsWith(`${root}/`));
  const store = createSqliteRunStore(cwd, paths);
  const registry = new RunStoreRegistry(requestedCwd => {
    assert.equal(requestedCwd, cwd, "no default or sibling Store may be opened");
    return store;
  }, { trustedWorkspaceRoots: [cwd] });
  let server;
  t.after(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    registry.closeAll();
    if (store.database.isOpen) store.close();
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b012-trace-`));
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(registry.getStore(cwd), store, "initialize real recovery before seeding live fixture Runs");
  await fs.writeFile(join(cwd, "owned.txt"), "B012 owned local read evidence\n");
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "B012 isolated trace", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "B012 trace source", prompt: "Read owned evidence" }, now);
  const thread = store.createLingThread({ kind: "task", taskId: task.id, channelId: channel.id,
    title: task.title, objective: task.prompt }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, channelId: channel.id,
    title: task.title, userInstruction: task.prompt, idempotencyKey: "b012-source",
    payload: { body: task.prompt, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);

  // Namespace pre-dispatch ports do not own these GET trace requests. Keep
  // their scope explicit without replacing the selected production trace route.
  // The actual router, Registry, event ingress, Store and action projection are not substituted.
  const context = { config: { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd, maxBodyBytes: 32_768 },
    engineManagement: { async handle(request) {
      assert.equal(request.method, "GET");
      assert.match(request.url ?? "", /^\/traces(?:\/|\?|$)/u);
      return false;
    } },
    storeRegistry: registry, remoteAccess: { async handleManagementRequest() { return false; } } };
  server = createServer((request, response) => {
    if (request.method !== "GET" || !/^\/traces(?:\/|\?|$)/u.test(request.url ?? "")) {
      response.writeHead(500); response.end(JSON.stringify({ fixtureError: "B012 refuses unrelated routes" })); return;
    }
    void routeRequest(request, response, context).catch(error => {
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ fixtureError: error.message }));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.address === "127.0.0.1");

  function createRun(id) {
    const createdAt = new Date().toISOString();
    store.createRun({ id, cwd, taskId: task.id, channelId: channel.id, threadId: thread.id, turnId: turn.turnId,
      providerName: "b012-owned-fixture", providerModel: "no-network", taskSnapshot: task,
      providerSnapshot: {}, requestSnapshot: {}, createdAt });
    store.markRunStarted(id, createdAt);
    registry.rememberRun(id, store);
    return store.getRun(id);
  }

  function startRead(runId, toolCallId, path = "owned.txt") {
    return store.appendEvent(runId, "tool_start", { toolCallId, toolName: "read", args: { path } });
  }

  async function endRead(runId, toolCallId, path = "owned.txt") {
    let text, isError = false;
    try { text = await fs.readFile(join(cwd, path), "utf8"); }
    catch (error) { assert.equal(error.code, "ENOENT"); text = error.message; isError = true; }
    return store.appendEvent(runId, "tool_end", { toolCallId, toolName: "read", isError,
      result: { content: [{ type: "text", text }] } });
  }

  function finishRun(runId, status) {
    assert.ok(["succeeded", "failed", "cancelled"].includes(status));
    const terminal = status === "succeeded" ? store.appendEvent(runId, "run_end", { taskId: task.id, messageCount: 0 })
      : status === "failed" ? store.appendEvent(runId, "run_error", { message: "B012 fixture Run failed without a tool receipt" })
        : store.appendEvent(runId, "run_cancelled", { reason: "B012 user cancellation", active: true });
    const endedAt = new Date().toISOString();
    const result = store.transitionRunStatus({ runId, expectedStatus: "running", actor: "runner",
      event: status === "succeeded" ? "runner_succeeded" : status === "failed" ? "runner_failed" : "cancel",
      now: endedAt, endedAt });
    assert.equal(result.ok, true, JSON.stringify(result));
    return { terminal, run: store.getRun(runId) };
  }

  async function get(path) {
    const result = await requestJson(address.port, path);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }

  async function trace(subjectKind, subjectId) {
    const traceId = createLingTraceId(subjectKind, subjectId);
    const prefix = `/traces/${encodeURIComponent(traceId)}`;
    const query = `?cwd=${encodeURIComponent(cwd)}`;
    const detail = await get(`${prefix}${query}`);
    const listing = await get(`${prefix}/spans${query}`);
    assert.equal(detail.trace.id, traceId);
    assert.equal(listing.traceId, traceId);
    assert.deepEqual(listing.spans, detail.spans, "new HTTP connections must project identical durable spans");
    return detail;
  }

  return { cwd, paths, store, registry, channel, task, thread, turn, createRun, startRead, endRead, finishRun, get, trace };
}

async function requestJson(port, path) {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: "GET", path, agent: false }, response => {
      const chunks = [];
      response.on("error", reject); response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("B012 owned trace router did not respond")));
    request.on("error", reject); request.end();
  });
}

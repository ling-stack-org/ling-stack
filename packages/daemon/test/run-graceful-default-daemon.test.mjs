import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { resolveStoragePaths } from "@ling-stack/core";
import { readTrackedToolCoverage } from "../../core/dist/storage/sqlite/host-attempt-tracked-coverage.js";
import { createDaemonServer } from "../dist/index.js";
import { createA21LoopbackTransport, createA21RealPiRunner } from "./support/noncompacted-recovery-crash-worker.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise, ms, description) {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: controller.signal }).then(() => {
      throw new Error(`Timed out: ${description}`);
    })]);
  } finally { controller.abort(); }
}

// Actual HTTP entry + default startup-owned Store factory. The existing Runner
// dependency changes only provider transport, never suspension/completion facts.
test("default Daemon with delegations off gracefully stops its real SDK source and persists 183 closure before closing SQLite", { timeout: 20_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-graceful-default-daemon-"));
  const priorLingHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "owned-user-home");
  const reachedBoundary = deferred(), releaseBoundary = deferred();
  let daemon, transport, observer, stopWork, response, responseText, captured, actualDirective, boundaryError;
  t.after(async () => {
    releaseBoundary.resolve();
    await within(stopWork ?? daemon?.stop() ?? Promise.resolve(), 3_000, "owned default Daemon cleanup").catch(() => undefined);
    await response?.body?.cancel().catch(() => undefined);
    observer?.close(); await transport?.close();
    if (priorLingHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = priorLingHome;
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, "fixture.txt"), "read once through the default Daemon\n");
  transport = await createA21LoopbackTransport(count => count === 1
    ? { tool_calls: [{ index: 0, id: "default-daemon-read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] }
    : { content: "No provider request may escape after the actual shutdown request." });
  const runner = createA21RealPiRunner(transport), realRunTask = runner.runTask.bind(runner);
  runner.runTask = options => realRunTask({ ...options, onTaskContinuationBoundary: async (boundary, modelView) => {
    if (boundary === "before_provider_request"
      && modelView?.some(message => message.role === "toolResult" && message.toolCallId === "default-daemon-read")) {
      assert.equal(captured, undefined, "the original source must not replay its read round");
      captured = { runId: options.runId, attemptId: options.runnerAttemptId, modelView: structuredClone(modelView), signal: options.signal };
      reachedBoundary.resolve(captured);
      await releaseBoundary.promise;
      try { actualDirective = await options.onTaskContinuationBoundary(boundary, modelView); return actualDirective; }
      catch (error) { boundaryError = error; throw error; }
    }
    return options.onTaskContinuationBoundary?.(boundary, modelView);
  } });
  // In particular, there is no storeFactory, RunStoreRegistry, composition,
  // direct executeRunRequest or ActiveRunRegistry supplied by this test.
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false }, harness: {
      continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
      evaluations: { mode: "off" }, delegations: { mode: "off" },
    } }, { runner, secretResolver: {
      status: ref => ({ ref, kind: "env", configured: false }),
      resolve: ref => ({ ref, configured: false, status: { ref, kind: "env", configured: false } }),
    },
    chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null });
  await daemon.start();
  assert.equal(daemon.config.harness.continuations.mode, "enforce");
  assert.equal(daemon.config.harness.delegations.mode, "off");
  const databasePath = resolveStoragePaths(cwd).workspace.databasePath;
  assert.ok(databasePath.startsWith(cwd), "all persisted facts must belong to the temporary workspace");
  observer = new DatabaseSync(databasePath, { readOnly: true });
  response = await fetch(`http://127.0.0.1:${daemon.server.address().port}/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      cwd, workspaceCwd: cwd, task: { id: "default-graceful-source", title: "Default Daemon read", prompt: "Read fixture.txt exactly once." },
      provider: { provider: "default-graceful-fixture", model: "fixture-model", api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false },
      tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write", thinkingLevel: "off",
      idempotencyKey: "default-graceful-source", createdByActor: "local-user",
    }),
  });
  responseText = response.text(); void responseText.catch(() => undefined);
  assert.equal(response.status, 200);
  try {
    await within(Promise.race([reachedBoundary.promise, responseText.then(text => {
      throw new Error(`HTTP Run returned before its actual read boundary: ${text}`);
    })]), 8_000, "actual default Daemon SDK read boundary");
    assert.equal(transport.requests.length, 1);
    assert.equal(captured.signal.aborted, false);
    stopWork = daemon.stop(); void stopWork.catch(() => undefined);
    // Daemon shutdown is asynchronous. Observe its actual private request in
    // read-only SQLite before releasing SDK admission, instead of reaching
    // into ActiveRuns or inventing a suspension directive from this fixture.
    const requested = await within((async () => {
      for (;;) {
        const row = observer.prepare("SELECT * FROM run_suspensions WHERE attempt_id=?").get(captured.attemptId);
        if (row) return row;
        await delay(5);
      }
    })(), 3_000, "default shutdown's persisted original suspension request");
    assert.equal(requested.run_id, captured.runId); assert.equal(requested.state, "requested");
    assert.equal(captured.signal.aborted, false, "the actual Daemon must seal rather than deliver its former immediate abort");
    releaseBoundary.resolve();
    const [, wireText] = await within(Promise.all([stopWork, responseText]), 8_000, "default Daemon SDK/durable/resource shutdown");
    assert.equal(daemon.server.listening, false);
    assert.equal(boundaryError, undefined);
    assert.equal(actualDirective?.kind, "runtime_suspension");
    assert.equal(actualDirective.runId, captured.runId); assert.equal(actualDirective.attemptId, captured.attemptId);
    assert.equal(captured.signal.aborted, false); assert.equal(transport.requests.length, 1);
    assert.doesNotMatch(wireText, /"error"\s*:\s*"(?:suspension\.|runtime_shutdown|harness_shutdown)/u);
    const run = observer.prepare("SELECT * FROM run_sessions WHERE id=?").get(captured.runId);
    const unit = observer.prepare("SELECT * FROM work_units WHERE id=?").get(run.work_unit_id);
    const attempt = observer.prepare("SELECT * FROM work_unit_attempts WHERE id=?").get(captured.attemptId);
    assert.equal(run.status, "running"); assert.equal(run.ended_at, null);
    assert.equal(unit.status, "stale"); assert.equal(attempt.status, "lost");
    assert.equal(attempt.error_code, "runtime_graceful_suspend");
    assert.equal(observer.prepare("SELECT COUNT(*) n FROM work_unit_attempts WHERE work_unit_id=?").get(unit.id).n, 1);
    const requestSnapshot = JSON.parse(run.request_snapshot_json);
    assert.equal(requestSnapshot.harnessFeatureSnapshot.continuations, "enforce");
    assert.equal(requestSnapshot.harnessFeatureSnapshot.delegations, "off");
    const suspension = observer.prepare("SELECT * FROM run_suspensions WHERE id=?").get(actualDirective.suspensionId);
    const stopped = observer.prepare("SELECT * FROM run_suspension_stops WHERE suspension_id=?").get(suspension.id);
    assert.equal(suspension.state, "sealed"); assert.equal(stopped.state, "stopped");
    const readArtifact = (id, expectedDigest) => {
      const artifact = observer.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
      assert.equal(artifact.content_sha256, expectedDigest);
      assert.equal(createHash("sha256").update(artifact.sealed_payload_json).digest("hex"), expectedDigest);
      return JSON.parse(artifact.sealed_payload_json);
    };
    const request = readArtifact(suspension.request_artifact_id, suspension.request_digest);
    const seal = readArtifact(suspension.seal_artifact_id, suspension.seal_digest);
    const begin = readArtifact(stopped.begin_artifact_id, stopped.begin_digest);
    const receipt = readArtifact(stopped.receipt_artifact_id, stopped.receipt_digest);
    assert.equal(request.cause, "daemon_restart"); assert.equal(begin.source.kind, "root");
    assert.equal(receipt.kind, "run.suspension_stopped.v1"); assert.deepEqual(receipt.sourceFence, begin.sourceFence);
    assert.equal(receipt.beginDigest, stopped.begin_digest); assert.equal(receipt.sealDigest, suspension.seal_digest);
    assert.equal(seal.witness.checkpoint.checkpointId, actualDirective.checkpointId);
    assert.equal(seal.witness.checkpoint.modelViewSha256, actualDirective.checkpointSha256);
    assert.deepEqual(receipt.descendants, []);
    const completion = observer.prepare("SELECT * FROM host_attempt_completions WHERE run_id=? AND attempt_id=?").get(run.id, attempt.id);
    assert.ok(completion?.drained_at); assert.equal(receipt.drainedAt, completion.drained_at);
    const source = { runId: run.id, ...begin.sourceFence };
    assert.equal(readTrackedToolCoverage(observer, source, completion.tracked_tool_calls_json, new Date().toISOString()), true,
      "the production read-only verifier must confirm the actual original SDK read coverage");
    const events = (await readFile(run.event_log_path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === "default-daemon-read").length, 1);
    assert.equal(events.some(event => ["run_end", "run_error", "run_cancelled"].includes(event.type)), false);
    const pair = captured.modelView.filter(message => message.role === "toolResult" && message.toolCallId === "default-daemon-read");
    assert.equal(pair.length, 1); assert.equal(pair[0].isError, false);
    assert.match(JSON.stringify(pair[0].content), /read once through the default Daemon/u);
    assert.equal(observer.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=183").get().n, 1);
    assert.equal(observer.prepare("SELECT COUNT(*) n FROM run_suspension_stops WHERE state='stopped'").get().n, 1);
    t.diagnostic(JSON.stringify({ entry: "HTTP /runs → default Store factory → daemon.stop", delegations: "off",
      sdkSources: 1, providerRequests: transport.requests.length, originalReads: 1, stopped183: 1,
      originalCompletionDrained: Boolean(completion.drained_at), trackedCoverageVerified: true }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ runId: captured?.runId, attemptId: captured?.attemptId, providerRequests: transport.requests.length,
      directive: actualDirective, boundaryError: boundaryError?.stack,
      stops: observer.prepare("SELECT * FROM run_suspension_stops").all(),
      runs: observer.prepare("SELECT id,status,error_message FROM run_sessions").all(),
      completions: observer.prepare("SELECT * FROM host_attempt_completions").all() }));
    throw error;
  }
});

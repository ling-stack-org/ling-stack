import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { stream } from "../../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { resolveConfig } from "../../dist/config.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";
import { RunStoreRegistry } from "../../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";

/** Own one deterministic loopback transport; never patch process-global fetch. */
export async function createA21LoopbackTransport(responseForRequest) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const recorded = { body, path: request.url };
      requests.push(recorded);
      const { usage, ...delta } = await responseForRequest(requests.length, recorded);
      const finish = delta.tool_calls ? "tool_calls" : "stop";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`
        + (usage ? `data: ${JSON.stringify({ choices: [], usage })}\n\n` : "")
        + "data: [DONE]\n\n");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => { server.off("error", rejectListen); resolveListen(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    },
  };
}

/** Exercise the real adapter, SDK parser and Host callbacks with only its provider replaced. */
export function createA21RealPiRunner(transport, { afterHostBoundary } = {}) {
  return new class extends PiRunnerAdapter {
    contexts = [];
    dispatches = [];
    async prepareTaskInput(options) {
      return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "a21-fixture-no-network" } });
    }
    async runTask(options) {
      this.dispatches.push({ runId: options.runId, attemptId: options.runnerAttemptId });
      const hostBoundary = options.onTaskContinuationBoundary;
      return super.runTask({ ...options, provider: { ...options.provider, apiKey: "a21-fixture-no-network" },
        ...(afterHostBoundary ? { onTaskContinuationBoundary: async (boundary, modelView) => {
          // Always execute the original Host callback first. A future test-local
          // checkpoint commit fault must be injected into its actual Core port,
          // not by skipping this callback or declaring an artifact committed.
          let directive;
          let hostError;
          let hostFailed = false;
          try { directive = await hostBoundary?.(boundary, modelView); }
          catch (error) { hostFailed = true; hostError = error; }
          await afterHostBoundary({ boundary, modelView, directive, hostFailed, hostError, options });
          if (hostFailed) throw hostError;
          return directive;
        } } : {}),
      });
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => {
          this.contexts.push(structuredClone(context.messages));
          return stream(model, context, { ...options, fetch: (_input, init) => fetch(transport.url, init) });
        },
      });
    }
  }();
}

/** Read only genuine dedicated-journal settlement plus the paired canonical SDK end. */
export function readA21SettledCommand(store, runId, toolCallId) {
  return store.readSnapshot(() => {
    const events = store.listEvents(runId, { limit: 1000 });
    const prepared = events.find((event) => event.type === "host_command_prepared" && event.data.toolCallId === toolCallId);
    const settled = prepared && events.find((event) => event.type === "host_command_settled"
      && event.data.executionId === prepared.data.executionId);
    const end = events.find((event) => event.type === "tool_end" && event.data.toolCallId === toolCallId);
    if (!prepared || settled?.data.outcome !== "completed" || settled.data.ownerCurrent !== true
      || !end || end.data.isError || settled.seq >= end.seq) return undefined;
    return { prepared, settled, end, sourceEventSeq: events.at(-1).seq };
  });
}

/** Assert real SDK and wire evidence; this does not certify checkpoint authority. */
export function assertA21ExactRecoveredToolProgress(source, contextMessages, requestBody) {
  const blocks = (messages) => messages.filter((message) => message.role === "assistant")
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === "toolCall");
  const originalCall = blocks(source.modelView).find((block) => block.id === source.toolCallId);
  const originalResult = source.modelView.find((message) => message.role === "toolResult"
    && message.toolCallId === source.toolCallId);
  assert.ok(originalCall && originalResult, "the source must be the actual SDK call/result pair");
  assert.equal(blocks(source.modelView).filter(block => block.id === source.toolCallId).length, 1);
  assert.equal(source.modelView.filter(message => message.role === "toolResult" && message.toolCallId === source.toolCallId).length, 1);
  assert.equal(blocks(contextMessages).filter(block => block.id === source.toolCallId).length, 1,
    "the recovered SDK view must contain exactly one original tool call");
  assert.equal(contextMessages.filter(message => message.role === "toolResult" && message.toolCallId === source.toolCallId).length, 1,
    "the recovered SDK view must contain exactly one original tool result");
  assert.deepEqual(blocks(contextMessages).find((block) => block.id === source.toolCallId), originalCall);
  const recoveredResult = contextMessages.find((message) => message.role === "toolResult"
    && message.toolCallId === source.toolCallId);
  assert.ok(recoveredResult);
  assert.deepEqual(recoveredResult.content, originalResult.content);
  assert.equal(recoveredResult.isError, originalResult.isError);
  const sourceTaskMessage = source.modelView.find((message) => message.role === "user");
  assert.ok(sourceTaskMessage);
  assert.deepEqual(contextMessages.find((message) => message.role === "user")?.content, sourceTaskMessage.content);
  const wireCalls = requestBody.messages.filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? []).filter((call) => call.id === source.toolCallId);
  assert.equal(wireCalls.length, 1, "the provider wire must contain exactly one original tool call");
  const wireCall = wireCalls[0];
  assert.equal(wireCall?.function?.name, "bash");
  assert.deepEqual(JSON.parse(wireCall.function.arguments), originalCall.arguments);
  const wireResults = requestBody.messages.filter((message) => message.role === "tool"
    && message.tool_call_id === source.toolCallId);
  assert.equal(wireResults.length, 1, "the provider wire must contain exactly one original tool result");
  const wireResult = wireResults[0];
  assert.ok(wireResult);
  const resultText = originalResult.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const wireText = typeof wireResult.content === "string" ? wireResult.content
    : wireResult.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.equal(wireText, resultText);
}

async function sendOwnedWorkerMessage(message) {
  assert.equal(typeof process.send, "function", "the crash worker requires its parent's owned IPC channel");
  await new Promise((resolveSend, rejectSend) => process.send(message, (error) => error ? rejectSend(error) : resolveSend()));
}

async function runA21CrashWorker(input) {
  const { cwd, markerPath, nonce, toolCallId, checkpointFault } = input;
  assert.ok(cwd && markerPath && nonce && toolCallId);
  assert.ok(checkpointFault === undefined || checkpointFault === "head_insert");
  assert.equal(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, cwd);
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const store = stores.getStore(cwd);
  if (checkpointFault === "head_insert") {
    // Only this fixture-owned DB is modified. The production Host callback and
    // Core writer remain intact; failure at the final authority insert must
    // roll back its earlier artifact and immutable-checkpoint inserts together.
    const faultDatabase = new DatabaseSync(store.paths.databasePath);
    try {
      faultDatabase.exec(`CREATE TRIGGER a21_checkpoint_head_fault
        BEFORE INSERT ON run_progress_checkpoint_heads
        BEGIN SELECT RAISE(ABORT, 'a21 owned checkpoint commit fault'); END;`);
    } finally { faultDatabase.close(); }
  }
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } } }));
  const activeRuns = new ActiveRunRegistry();
  const errors = [];
  const shellPath = `'${markerPath.replaceAll("'", "'\\''")}'`;
  const command = `printf 'a21-effect\\n' >> ${shellPath}`;
  const transport = await createA21LoopbackTransport((count) => count === 1
    ? { tool_calls: [{ index: 0, id: toolCallId, type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
    : { content: "Unexpected source continuation: the crash boundary did not hold." });
  let paused = false;
  const runner = createA21RealPiRunner(transport, { afterHostBoundary: async ({ boundary, modelView, directive, hostFailed, hostError, options }) => {
    if (boundary !== "before_provider_request" || paused) return;
    const settlement = readA21SettledCommand(store, options.runId, toolCallId);
    if (!settlement) return;
    paused = true;
    assert.equal(directive, undefined);
    assert.ok(Array.isArray(modelView), "the real SDK must supply its exact model view");
    const run = store.getRun(options.runId);
    const attempt = store.getWorkUnitAttempt(options.runnerAttemptId);
    assert.equal(run.status, "running");
    assert.equal(attempt.status, "started");
    assert.equal(settlement.prepared.data.source.attemptId, attempt.id);
    assert.equal(settlement.end.data.attemptId, attempt.id);
    assert.equal(store.listHostCommandWriteBlockers(cwd).length, 0);
    assert.equal(store.listEvents(run.id).some((event) => event.type.startsWith("context_compaction_")), false);
    assert.equal(transport.requests.length, 1, "the next provider request must still be unissued");
    assert.equal(await readFile(markerPath, "utf8"), "a21-effect\n");
    await sendOwnedWorkerMessage({ kind: "a21_settled_before_provider_request", nonce, cwd, pid: process.pid,
      scriptPath: fileURLToPath(import.meta.url), runId: run.id, workUnitId: run.workUnitId, attemptId: attempt.id,
      markerPath, command, toolCallId, settlement, modelView: structuredClone(modelView),
      preparedInput: structuredClone(options.preparedInput), requestSnapshot: structuredClone(run.requestSnapshot),
      workspaceProvenanceWatermark: store.getLatestWorkspaceProvenanceWatermark(),
      checkpointFault,
      artifacts: store.listArtifacts(run.id), contexts: runner.contexts, requests: transport.requests,
      hostFailed,
      hostError: hostError ? { code: hostError.code, message: hostError.message } : undefined });
    // Keep the real SDK/Host operation suspended at the admission boundary.
    // The parent owns this process and must SIGKILL it; no cancel/terminal path.
    await new Promise(() => {});
  } });
  const now = new Date().toISOString();
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "A21 owned provider",
    providerId: "a21-noncompacted-fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false,
    capabilities: ["chat", "tool_call"], enabled: true }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const channel = store.createChannel({ name: "A21 owned recovery", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "A21 real settled command",
    prompt: `Run the authorized command once, then report its result: ${command}` }, now);
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id,
    title: task.title, objective: task.prompt }, now);
  await sendOwnedWorkerMessage({ kind: "a21_worker_started", nonce, cwd, pid: process.pid,
    scriptPath: fileURLToPath(import.meta.url) });
  await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, providerPresetId: preset.id,
    task: { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt }, tools: ["bash"],
    // This deterministic owned command fixture is not a sandbox-isolation test.
    // workspace_write still asks for bash approval; select the existing explicit
    // always/full_access pair instead of bypassing the production approval gate.
    authorizationMode: "always", workspaceAccessMode: "full_access",
    permissionConfirmation: { mode: "full_access", confirmed: true, confirmedAt: now,
      reason: "Authorized deterministic QA marker command in the fixture-owned temporary workspace." },
    idempotencyKey: `a21-source-${nonce}`, createdByActor: "local-user" },
  { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
  createRunnerRegistry([{ id: "pi", displayName: "A21 real SDK fixture", status: "enabled", adapter: runner }]),
  stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {});
  throw new Error(`The source Run returned instead of reaching the owned crash boundary: ${JSON.stringify(errors)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runA21CrashWorker(JSON.parse(process.argv[2] ?? "null")).catch(async (error) => {
    try { await sendOwnedWorkerMessage({ kind: "a21_fixture_error", pid: process.pid,
      error: error instanceof Error ? error.stack : String(error) }); }
    finally { process.exitCode = 1; }
  });
}

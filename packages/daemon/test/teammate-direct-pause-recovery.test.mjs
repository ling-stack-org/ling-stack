import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CASE_ENV = "LING_A28_DIRECT_RECOVERY_CASE";
const TEAMMATE = "teammate_builtin_engineer";
const TOOL_CALL = "a28-owned-bash-recovery";
const MARKER = "a28-owned-host-marker.txt";
const COMMAND = `printf x >> ${MARKER}`;
const NARRATION = "A28 private recovery: the owned command requires your confirmation.";
const FINAL = "A28 private recovery finished from the Host's durable command evidence.";
const FAILURE = "A28_OWNED_CONTINUATION_RUNNER_FAILURE";
const cases = {
  "bash-approve-same-message-ready": f => recoveredTerminal(f, "ready"),
  "closed-sse-bash-approve-same-message-ready": f => recoveredTerminal(f, "ready", true),
  "bash-approve-continuation-failed": f => recoveredTerminal(f, "failed"),
  "bash-deny-same-message-failed": deniedTerminal,
  "resume-pre-dispatch-shutdown": preDispatchShutdown,
  "terminal-commit-message-gap": terminalMessageGap,
  "shutdown-request-before-approval-commit-blocked": shutdownBeforeApproval,
  "shutdown-missing-approval-checkpoint-blocked": f => shutdownInvalidApproval(f, "missing"),
  "shutdown-foreign-approval-basis-blocked": f => shutdownInvalidApproval(f, "foreign"),
  "shutdown-delegated-owner-blocked": f => shutdownInvalidApproval(f, "delegated"),
  "shutdown-real-local-writer-drains-before-suspension": shutdownWithLocalWriter,
  "shutdown-local-writer-checkpoint-change-blocked": f => shutdownWithLocalWriter(f, "checkpoint"),
  "shutdown-local-writer-owner-change-blocked": f => shutdownWithLocalWriter(f, "owner"),
  "shutdown-local-writer-throwing-live-listener": f => shutdownWithLocalWriter(f, undefined, true),
};
const selected = process.env[CASE_ENV];
if (selected) assert.ok(Object.hasOwn(cases, selected), "only a named disposable child case may run");
for (const [label, exercise] of Object.entries(cases)) {
  if (!selected || selected === label) {
    test(`A28 private recovery ${label}`, { timeout: 75_000 }, t => ownedCase(t, label, exercise));
  }
}

/** Import product modules only after replacing the inherited credential/home context. */
async function ownedCase(t, label, exercise) {
  if (selected) {
    const home = process.env.LING_STACK_HOME, cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    for (const path of [home, cwd]) {
      assert.ok(path && isAbsolute(path) && path === resolve(path) && path !== "/" && path !== process.cwd());
      assert.equal((await stat(path)).isDirectory(), true);
    }
    assert.equal(dirname(home), dirname(cwd));
    assert.ok(basename(dirname(cwd)).startsWith(`ling-a28-recovery-${label}-`));
    assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
    const homeHook = t.mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    const originalFetch = globalThis.fetch;
    let origin, fixture, exerciseError;
    const cleanupErrors = [];
    const unownedRequests = [];
    globalThis.fetch = async function (input, init) {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (!origin || url.origin !== origin) {
        unownedRequests.push(`${url.origin}${url.pathname}`);
        throw new Error("A28 recovery forbids all non-owned HTTP requests");
      }
      return originalFetch.call(this, input, init);
    };
    try {
      const core = await import("../../core/dist/index.js");
      const { createDaemonServer } = await import("../dist/index.js");
      const { createRunnerRegistry } = await import("../dist/runtime/runners.js");
      const { RunStoreRegistry } = await import("../dist/runtime/store-registry.js");
      const { ControlPlaneEventHub } = await import("../dist/features/control-plane/events.js");
      const { PiRunnerAdapter } = await import("../../runner-pi/dist/index.js");
      const { AttemptLocalWriterGroup } = await import("../dist/runtime/attempt-local-writers.js");
      const writerGroups = new Map();
      const originalReserve = AttemptLocalWriterGroup.prototype.reserve;
      // Observe the original group only. Never substitute its ticket, drain
      // promise, membership or result with caller-supplied completion facts.
      t.mock.method(AttemptLocalWriterGroup.prototype, "reserve", function (...args) {
        const ticket = Reflect.apply(originalReserve, this, args);
        writerGroups.set(this.source.runId, this);
        return ticket;
      });
      const { prepareFixtureTaskInput } = await import("./support/prepared-input-fixture.mjs");
      fixture = createFixture({ t, cwd, core, createDaemonServer, createRunnerRegistry, RunStoreRegistry, ControlPlaneEventHub,
        PiRunnerAdapter, prepareFixtureTaskInput, writerGroups, setOrigin: value => { origin = value; } });
      await fixture.start();
      console.log(`A28 entered owned real recovery case: ${label}`);
      await exercise(fixture);
      assert.deepEqual(unownedRequests, [], "neither Provider nor public web transport may run");
    } catch (error) {
      exerciseError = error;
    } finally {
      fixture?.releaseOriginalApproval();
      try { await fixture?.stop(); }
      catch (error) { cleanupErrors.push(error); }
      try { await fixture?.disposeBlockedFixture(); }
      catch (error) { cleanupErrors.push(error); }
      finally {
        globalThis.fetch = originalFetch;
        homeHook.mock.restore();
        syncBuiltinESMExports();
      }
    }
    if (exerciseError && cleanupErrors.length) throw new AggregateError([exerciseError, ...cleanupErrors],
      "A28 exercise failed before isolated fixture cleanup", { cause: exerciseError });
    if (exerciseError) throw exerciseError;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "A28 isolated fixture cleanup failed");
    return;
  }
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryRoot, `ling-a28-recovery-${label}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace"), temporary = join(root, "temporary");
  await mkdir(home);
  await mkdir(cwd);
  await mkdir(temporary);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", TMPDIR: temporary,
        LING_STACK_HOME: home, LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [CASE_ENV]: label },
      stdio: ["ignore", "pipe", "pipe"], timeout: 65_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    console.log(`A28 ${label} recovery child exit: ${JSON.stringify(exit)}`);
    assert.ok(stdout.includes(`A28 entered owned real recovery case: ${label}`), "a load/setup failure is not behavioral RED");
    assert.equal(exit.signal, null, "the fixture must drain its real index lifecycle, not time out");
    assert.equal(exit.code, 0, `${label} must satisfy the real private recovery contract`);
  } finally {
    assert.equal(dirname(root), temporaryRoot);
    assert.ok(basename(root).startsWith(`ling-a28-recovery-${label}-`));
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The synthetic Runner supplies approval intent/narration only. The real index,
 * HTTP approval route, resume coordinator, continuation dispatcher, Host bash,
 * terminal transaction and SQLite remain production implementations.
 */
function createFixture({ t, cwd, core, createDaemonServer, createRunnerRegistry, RunStoreRegistry, ControlPlaneEventHub,
  PiRunnerAdapter, prepareFixtureTaskInput, writerGroups, setOrigin }) {
  const secretResolver = core.createCompositeSecretResolver({ env: {} });
  const databasePath = join(cwd, ".ling-stack", "ling-stack.sqlite");
  const calls = [], claims = [], terminals = [], suspensions = [];
  const approvalCommitted = deferred(), resumeClaimed = deferred(), terminalCommitted = deferred();
  const beforeApproval = deferred(), allowApproval = deferred();
  const responseFacts = { closed: false, writesAfterClose: 0 };
  const responseClosed = deferred();
  let daemon, stopping, blockedDaemon, store, provider, generation = 0, terminalMode = "ready", stopOnResumeClaim = false;
  let pauseBeforeApproval = false;
  let controlPlaneHub;
  let claimStop;
  class OwnedRecoveryRunner extends PiRunnerAdapter {
    prepareTaskInput(options) { return prepareFixtureTaskInput(options); }
    async runTask(options) {
      calls.push({ generation, options });
      assert.equal(options.cwd, cwd);
      if (options.approvedToolContinuation) {
        const evidence = options.approvedToolContinuation;
        assert.equal(evidence.toolName, "bash");
        assert.equal(evidence.toolCallId, TOOL_CALL);
        assert.equal(evidence.args.command, COMMAND);
        assert.equal(evidence.args.cwd, cwd);
        assert.equal(evidence.result.isError, false, JSON.stringify(evidence.result));
        assert.equal(await readFile(join(cwd, MARKER), "utf8"), "x",
          "the Host, never this Runner, must have executed the owned command first");
        if (terminalMode === "failed") throw new Error(FAILURE);
        options.onEvent?.({ type: "assistant_text_delta", text: FINAL });
        options.onEvent?.({ type: "message_end", role: "assistant", text: FINAL });
        return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: FINAL }] };
      }
      assert.equal(calls.filter(call => !call.options.approvedToolContinuation).length, 1,
        "recovery must not replay the original private prompt as a fresh Run");
      options.onEvent?.({ type: "assistant_text_delta", text: NARRATION });
      options.onEvent?.({ type: "message_end", role: "assistant", text: NARRATION });
      if (pauseBeforeApproval) {
        beforeApproval.resolve();
        await allowApproval.promise;
      }
      await options.onApprovalRequired({ toolCallId: TOOL_CALL, toolName: "bash", cwd,
        task: options.task, input: { command: COMMAND, cwd } });
      options.signal.throwIfAborted();
      assert.fail("the original Runner must stop at the unanswered approval, not execute its command");
    }
  }
  const runnerRegistry = createRunnerRegistry([{
    id: "pi", displayName: "A28 owned no-model recovery Runner", status: "enabled",
    adapter: new OwnedRecoveryRunner(), resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] },
  }]);
  const f = {
    core, cwd, databasePath, calls, claims, terminals, suspensions, approvalCommitted, resumeClaimed,
    terminalCommitted, responseFacts, responseClosed, beforeApproval,
    get store() { return store; },
    get generation() { return generation; },
    get claimStop() { return claimStop; },
    setTerminalMode(value) { terminalMode = value; },
    stopAfterNextResumeClaim() { stopOnResumeClaim = true; },
    pauseOriginalBeforeApproval() { pauseBeforeApproval = true; },
    releaseOriginalApproval() { allowApproval.resolve(); },
    subscribeThrowingSuspensionListener(source) {
      assert.ok(controlPlaneHub, "observe the original index Hub before subscribing a real listener");
      const delivered = [];
      const subscription = controlPlaneHub.subscribeListener({ workspaceId: source.work.workspaceId, cwd,
        onEvent(event) {
          if (!event.action.endsWith("_suspended")) return;
          delivered.push(event);
          throw new Error("A28_OWNED_ACTIVE_LISTENER_FAILURE");
        } });
      subscription.activate([]);
      return { delivered, close: () => subscription.close() };
    },
    holdLocalWriter(runId) {
      const group = writerGroups.get(runId);
      assert.ok(group, "the real original captured group must already own its Runner callbacks");
      const gate = deferred();
      const completion = group.wrapAsync("a28-controlled-actual-local-writer", () => gate.promise)();
      return { release: gate.resolve, completion };
    },
    async start() {
      if (stopping) await stopping;
      assert.equal(daemon, undefined);
      store = undefined;
      controlPlaneHub = undefined;
      generation++;
      daemon = createDaemonServer({
        host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
        harness: { continuations: { mode: "enforce" }, toolBroker: { mode: "off" } },
        channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
        cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
      }, {
        runnerRegistry, secretResolver,
        externalSecretStore: { ...secretResolver,
          setSecret() { throw new Error("A28 recovery forbids external secret writes"); },
          deleteSecret() { throw new Error("A28 recovery forbids external secret deletes"); } },
        chromeBrowserNativeMessagingEnabled: false,
      });
      daemon.server.prependListener("request", (request, response) => {
        if (!request.url?.startsWith(`/teammates/${TEAMMATE}/direct-messages/stream?`)) return;
        responseFacts.closed = false;
        response.on("close", () => { responseFacts.closed = true; responseClosed.resolve(); });
        const write = response.write;
        response.write = function (...args) {
          if (responseFacts.closed || response.destroyed) responseFacts.writesAfterClose++;
          return Reflect.apply(write, this, args);
        };
      });
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      f.origin = `http://127.0.0.1:${address.port}`;
      setOrigin(f.origin);
      assert.ok(store);
    },
    async stop() {
      if (!daemon) { if (stopping) await stopping; return; }
      const closing = daemon;
      daemon = undefined;
      const completion = closing.stop();
      stopping = completion;
      try { await completion; }
      catch (error) { blockedDaemon = closing; throw error; }
      finally { if (stopping === completion) stopping = undefined; }
    },
    async disposeBlockedFixture() {
      if (!blockedDaemon) return;
      // Only after asserting the real failed shutdown: dispose this child's
      // owned test listener/DB. This is not a product stop or drain receipt.
      const closing = blockedDaemon;
      blockedDaemon = undefined;
      closing.server.closeAllConnections();
      if (closing.server.listening) {
        await new Promise((done, reject) => closing.server.close(error => error ? reject(error) : done()));
      }
      store.close();
    },
    request(path, method = "GET", body) {
      const url = new URL(path, f.origin);
      url.searchParams.set("cwd", cwd);
      return fetch(url, { method, ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), signal: AbortSignal.timeout(15_000) });
    },
    async beginStream() {
      const response = await f.request(`/teammates/${TEAMMATE}/direct-messages/stream`, "POST", {
        body: "A28 execute the owned marker once, then finish this same private reply.",
        providerPresetId: provider.id, requestAiReply: true, permissionPreset: "custom",
        authorizationMode: "ask", workspaceAccessMode: "workspace_write",
      });
      assert.equal(response.status, 200);
      return consumeSse(response);
    },
    async decide(approvalId, action = "approve", tolerateClosedTransport = false) {
      try {
        const response = await f.request(`/approvals/${encodeURIComponent(approvalId)}/${action}`, "POST",
          action === "approve" ? { decisionKind: "approve_once", reason: "A28 owned recovery" } : { reason: "A28 explicit deny" });
        const body = await response.json();
        const repeatAlreadyResolved = response.status === 400 && body.error === "approval_not_pending";
        assert.ok([200, 409].includes(response.status) || repeatAlreadyResolved,
          `unexpected approval response ${response.status}: ${JSON.stringify(body)}`);
        return { status: response.status, body };
      } catch (error) {
        // Only the pre-dispatch stop intentionally destroys an in-flight
        // approval response. The committed decision is checked from reopened DB.
        if (!tolerateClosedTransport || !(error instanceof TypeError)) throw error;
        return { transportClosed: true, error: error.message };
      }
    },
    async messages() {
      const response = await f.request(`/teammates/${TEAMMATE}/direct-messages`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    },
    reopen(read) {
      const reopened = core.createSqliteRunStore(cwd);
      try { return read(reopened); } finally { reopened.close(); }
    },
    sql(read, writable = false) {
      const db = new DatabaseSync(databasePath);
      try {
        if (!writable) db.exec("PRAGMA query_only=ON");
        return read(db);
      } finally { db.close(); }
    },
    rawMessage(messageId) {
      return f.sql(db => ({ ...db.prepare("SELECT * FROM teammate_direct_messages WHERE id = ?").get(messageId) }));
    },
    async marker() {
      try { return await readFile(join(cwd, MARKER), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    },
  };
  const originalPublish = ControlPlaneEventHub.prototype.publish;
  // Observe the real index Hub and retain its original publish behavior. The
  // failing consumer below uses real subscribeListener + activate, not a
  // replacement publish result or fabricated delivery receipt.
  t.mock.method(ControlPlaneEventHub.prototype, "publish", function (...args) {
    if (args[0].cwd === cwd) {
      if (controlPlaneHub) assert.equal(this, controlPlaneHub);
      controlPlaneHub = this;
    }
    return Reflect.apply(originalPublish, this, args);
  });
  const originalGetStore = RunStoreRegistry.prototype.getStore;
  // Retain index's default constructor and its original Supervisor custody.
  // Observe only the exact owned cwd and the original getStore return value;
  // this observer never supplies, substitutes or re-enrolls a Store.
  t.mock.method(RunStoreRegistry.prototype, "getStore", function (...args) {
    const original = Reflect.apply(originalGetStore, this, args);
    assert.equal(resolve(args[0]), cwd);
    assert.equal(original.paths.databasePath, databasePath);
    if (store) { assert.equal(original, store); return original; }
    store = original;
    if (!provider) {
      const now = new Date().toISOString();
      provider = store.createProviderPreset({ kind: "openai-compatible", displayName: "A28 no-model fixture",
        providerId: "a28-owned-fixture", model: "a28-owned-fixture", api: "openai-completions",
        authHeader: false, baseUrl: "https://fixture.invalid/v1", capabilities: ["chat"], input: ["text"],
        enabled: true, contextWindow: 128_000, maxTokens: 4096 }, now);
      store.recordProviderCheckResult(provider.id, { ok: true, code: "static_check",
        message: "Owned static fixture only; never a model request", checkedAt: now });
      assert.ok(store.updateAiTeammate(TEAMMATE, { providerPresetId: provider.id,
        allowedTools: ["bash"], approvalProfile: { mode: "standard", requiredForTools: ["bash"] } }, now));
      const thread = store.getOrCreateTeammateDirectThread(TEAMMATE, now);
      store.updateTeammateDirectThreadWorkspace(thread.id, { mode: "local", status: "ready", executionPath: cwd,
        createdAt: now, checkedAt: now, updatedAt: now }, now);
      store.updateApprovalPolicy({ toolDecisions: { bash: "ask" } }, now);
    }
    const appendExecutionEvent = store.appendExecutionEvent;
    t.mock.method(store, "appendExecutionEvent", function (...eventArgs) {
      const envelope = Reflect.apply(appendExecutionEvent, this, eventArgs);
      if (envelope.type === "approval_requested") approvalCommitted.resolve(envelope);
      return envelope;
    });
    const commitClaim = store.commitApprovalResumeClaim;
    t.mock.method(store, "commitApprovalResumeClaim", function (...claimArgs) {
      const result = Reflect.apply(commitClaim, this, claimArgs);
      if (result.ok) {
        claims.push(result);
        resumeClaimed.resolve(result);
        if (stopOnResumeClaim) {
          stopOnResumeClaim = false;
          // The real index stop follows the actual claim commit. Registration
          // may follow later, but its original shutdown intent is retained.
          claimStop = f.stop();
          claimStop.catch(() => undefined);
        }
      }
      return result;
    });
    const commitTerminal = store.commitApprovalResumeTerminal;
    t.mock.method(store, "commitApprovalResumeTerminal", function (...terminalArgs) {
      const result = Reflect.apply(commitTerminal, this, terminalArgs);
      if (result.ok) { terminals.push(result); terminalCommitted.resolve(result); }
      return result;
    });
    const commitSuspension = store.commitApprovalResumeSuspension;
    t.mock.method(store, "commitApprovalResumeSuspension", function (...suspensionArgs) {
      const result = Reflect.apply(commitSuspension, this, suspensionArgs);
      suspensions.push({ input: suspensionArgs[0], result });
      return result;
    });
    return original;
  });
  return f;
}

/** Produce the original wait by real HTTP/Runner approval and real index shutdown. */
async function pausedSource(f, closeStreamFirst = false) {
  const stream = await f.beginStream();
  const linked = await bounded(stream.linked.promise, "the original private stream never linked a real Run");
  const envelope = await bounded(Promise.race([f.approvalCommitted.promise, stream.done.then(result => {
    throw new Error(`A28 recovery stream ended before approval commit: ${result.text}`);
  })]), "the original private Runner never persisted its approval");
  assert.equal(envelope.runId, linked.data.linkedRunId);
  const source = facts(f.store, linked.data.linkedRunId, linked.data.messageId);
  assert.equal(source.run.status, "waiting_for_approval");
  assert.equal(source.work.status, "waiting_for_approval");
  assert.equal(source.checkpoint.status, "pending");
  assert.equal(source.approval.payload.type, "bash");
  assert.equal(source.approval.payload.command, COMMAND);
  assert.equal(source.checkpoint.resumeBasis.toolCallId, TOOL_CALL);
  assert.equal(await f.marker(), undefined, "intent cannot execute before approval");
  if (closeStreamFirst) { await stream.cancel(); await f.responseClosed.promise; }
  await f.stop();
  const result = await stream.done;
  const suspended = f.reopen(store => facts(store, source.run.id, source.message.id));
  assert.equal(suspended.run.status, "waiting_for_approval");
  assert.equal(suspended.work.status, "waiting_for_approval");
  assert.equal(suspended.attempts[0].status, "lost");
  assert.equal(suspended.attempts[0].errorCode, "runtime_suspend");
  assert.ok(suspended.attempts[0].endedAt);
  assert.equal(suspended.checkpoint.revision, source.checkpoint.revision + 1);
  assert.equal(suspended.checkpoint.resumeBasis.priorAttemptId, source.attempts[0].id);
  assertSuspensionAudit(suspended, source.attempts[0]);
  assert.equal(suspended.turn.id, source.turn.id);
  assert.equal(f.calls.length, 1);
  console.log(`A28 real bash approval suspension: ${JSON.stringify({ runId: source.run.id, messageId: source.message.id,
    turnId: source.turn.id, checkpointRevision: suspended.checkpoint.revision, messageStatus: suspended.message.status })}`);
  await f.start();
  // Defer the already-covered pause-message assertions until after exercising
  // recovery, so its initial RED cannot hide another broken terminal chain.
  return { source, suspended, streamResult: result };
}

/** A real in-flight tool reaches approval after shutdown already chose ordinary suspension. */
async function shutdownBeforeApproval(f) {
  f.pauseOriginalBeforeApproval();
  const stream = await f.beginStream();
  const linked = await bounded(stream.linked.promise, "the original private stream never linked a real Run");
  await bounded(f.beforeApproval.promise, "the original Runner never reached its fixture-owned tool gate");
  const runId = linked.data.linkedRunId;
  const original = f.store.getRun(runId);
  const unit = f.store.getWorkUnit(original.workUnitId);
  const attempt = f.store.getWorkUnitAttempt(unit.activeAttemptId);
  const source = { runId, workUnitId: unit.id, attemptId: attempt.id,
    runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
  assert.equal(original.status, "running");
  assert.equal(unit.status, "running");
  assert.equal(f.store.listApprovalRequests({ runId, limit: 10 }).length, 0);
  const stopped = f.stop().then(() => { throw new Error("an unsealed ordinary request cannot close the Host"); }, error => error);
  // Observe the real Core request, not a controller mock or sleep ordering.
  await waitFor(() => f.store.hasPendingRunSuspension(source), "shutdown never persisted its ordinary suspension request");
  f.releaseOriginalApproval();
  await bounded(f.approvalCommitted.promise, "the real approval handler never committed after the shutdown request");
  await bounded(stream.done, "the original approval polling callback did not actually stop");
  const failure = await bounded(stopped, "blocked approval shutdown deadlocked instead of reporting its unknown boundary");
  const messages = flattenErrors(failure);
  assert.ok(messages.includes("harness_shutdown_incomplete_stores_retained"), messages.join(" | "));
  assert.ok(messages.includes("runtime_shutdown_unverified"), messages.join(" | "));
  assert.ok(messages.includes("suspension.boundary_unavailable"), messages.join(" | "));
  const retained = facts(f.store, runId, linked.data.messageId);
  assert.equal(retained.run.status, "waiting_for_approval");
  assert.equal(retained.work.status, "waiting_for_approval");
  assert.equal(retained.work.activeAttemptId, attempt.id);
  assert.equal(retained.attempts.length, 1);
  assert.equal(retained.attempts[0].status, "waiting_for_approval");
  assert.equal(retained.attempts[0].endedAt, undefined);
  assert.equal(retained.checkpoint.status, "pending");
  assert.equal(retained.approval.status, "pending");
  assert.equal(f.store.hasPendingRunSuspension(source), true);
  assert.equal(retained.runtimeEvents.some(event => event.type === "work_unit_stale"
    && event.data?.reason === "runtime_suspend" && event.data?.recoverable === true), false);
  assert.equal(retained.events.some(event => ["run_error", "run_cancelled", "run_end"].includes(event.type)), false);
  assert.equal(await f.marker(), undefined);
  assert.equal(f.calls.length, 1);
  console.log(`A28 shutdown-before-approval real blocked evidence: ${JSON.stringify({ runId,
    attemptId: attempt.id, checkpointId: retained.checkpoint.id, failureCodes: messages })}`);
}

function flattenErrors(error) {
  return [error?.message ?? String(error), ...(Array.isArray(error?.errors) ? error.errors.flatMap(flattenErrors) : [])];
}

async function liveApprovalSource(f) {
  const stream = await f.beginStream();
  const linked = await bounded(stream.linked.promise, "the original stream never linked");
  await bounded(f.approvalCommitted.promise, "the real approval never committed");
  return { stream, source: facts(f.store, linked.data.linkedRunId, linked.data.messageId) };
}

function resourceIds(f, workUnitId) {
  return {
    leases: f.store.listResourceLeases({ status: "active", workUnitId }).map(row => row.id).sort(),
    slots: f.store.listRuntimeSemaphoreSlots({ status: "active", workUnitId }).map(row => row.id).sort(),
  };
}

function assertRetainedApproval(f, source, resources) {
  const attempt = f.store.getWorkUnitAttempt(source.attempts[0].id);
  assert.equal(f.store.getRun(source.run.id).status, "waiting_for_approval");
  assert.equal(f.store.getWorkUnit(source.work.id).status, "waiting_for_approval");
  assert.equal(f.store.getWorkUnit(source.work.id).activeAttemptId, attempt.id);
  assert.equal(attempt.status, source.attempts[0].status, "blocking must not change the original waiting Attempt");
  assert.equal(attempt.endedAt, undefined);
  assert.equal(f.store.isCurrentRunExecutionOwner(source.run.id, f.core.toRuntimeAttemptFence(attempt)), true);
  assert.deepEqual(resourceIds(f, source.work.id), resources, "unknown stop cannot release original leases or slots");
  assert.equal(f.store.listRuntimeEvents(source.work.id, { limit: 1000 }).some(event => event.type === "work_unit_stale"
    && event.data?.reason === "runtime_suspend" && event.data?.recoverable === true), false);
  assert.equal(f.store.listEvents(source.run.id, { limit: 1000 }).some(event =>
    ["run_error", "run_cancelled", "run_end"].includes(event.type)), false);
}

/** Corrupt only this owned disposable DB, then exercise the real shutdown guard. */
async function shutdownInvalidApproval(f, corruption) {
  const { stream, source } = await liveApprovalSource(f);
  const resources = resourceIds(f, source.work.id);
  assert.ok(resources.leases.length || resources.slots.length, "the real source must own resources to test non-release");
  if (corruption === "missing") {
    f.sql(db => db.prepare("DELETE FROM approval_checkpoints WHERE id=?").run(source.checkpoint.id), true);
  } else if (corruption === "foreign") {
    const { schemaVersion, fingerprint, ...basisInput } = source.checkpoint.resumeBasis;
    const foreignBasis = f.core.createApprovalResumeBasisV1({ ...basisInput,
      priorAttemptId: "a28_foreign_attempt_not_the_original_source" });
    assert.equal(f.core.isApprovalResumeBasisV1(foreignBasis), true,
      "the foreign source must have a valid self-fingerprint, not merely malformed JSON");
    f.sql(db => db.prepare("UPDATE approval_checkpoints SET resume_basis_json=? WHERE id=?")
      .run(JSON.stringify(foreignBasis), source.checkpoint.id), true);
  } else {
    // This is a foreign-owner rejection, not an E2E dynamic-child execution.
    f.sql(db => db.prepare("UPDATE work_units SET owner_type='delegation_step',owner_id=? WHERE id=?")
      .run("a28_foreign_delegation_step", source.work.id), true);
  }
  const failure = await bounded(f.stop().then(() => {
    throw new Error("invalid approval ownership must not be accepted as a stopped checkpoint");
  }, error => error), "invalid approval source kept polling forever instead of reporting blocked");
  await bounded(stream.done, "the rejected original approval callback never stopped");
  const messages = flattenErrors(failure);
  assert.ok(messages.includes("runtime_shutdown_unverified"), messages.join(" | "));
  assert.ok(messages.includes(corruption === "delegated" ? "suspension.source_stale" : "suspension.witness_mismatch"), messages.join(" | "));
  assertRetainedApproval(f, source, resources);
  assert.equal(await f.marker(), undefined);
  assert.equal(f.calls.length, 1);
  console.log(`A28 ${corruption} approval actual shutdown blocked: ${JSON.stringify({ runId: source.run.id,
    attemptId: source.attempts[0].id, resources, failureCodes: messages })}`);
}

/** Actual local-writer mechanism regression; not a claimed MCP end-to-end test. */
async function shutdownWithLocalWriter(f, change, throwingListener = false) {
  const { stream, source } = await liveApprovalSource(f);
  const resources = resourceIds(f, source.work.id);
  assert.ok(resources.leases.length || resources.slots.length);
  const writer = f.holdLocalWriter(source.run.id);
  const listener = throwingListener ? f.subscribeThrowingSuspensionListener(source) : undefined;
  let stopSettled = false;
  const stopped = f.stop().then(() => { stopSettled = true; return { ok: true }; },
    error => { stopSettled = true; return { ok: false, error }; });
  try {
    // The production bounded observer has timed out, but its original writer
    // still exists. The whole Host must not produce a close receipt yet.
    await bounded(stream.done, "the local-writer observation never reported its blocked result");
    assert.equal(stopSettled, false, "shutdown must await the real writer, not the observation timeout");
    assertRetainedApproval(f, source, resources);
    assert.equal(f.store.getApprovalCheckpoint(source.checkpoint.id).revision, source.checkpoint.revision);
    assert.equal(await f.marker(), undefined);
    if (change === "checkpoint") {
      // A newer checkpoint must not be recaptured as permission for the old
      // deferred close, even when the tool/basis shape remains identical.
      f.sql(db => db.prepare("UPDATE approval_checkpoints SET revision=revision+1 WHERE id=?")
        .run(source.checkpoint.id), true);
    } else if (change === "owner") {
      f.sql(db => db.prepare("UPDATE work_units SET owner_type='delegation_step',owner_id=? WHERE id=?")
        .run("a28_foreign_delegation_during_actual_drain", source.work.id), true);
    }
  } finally {
    writer.release();
    await writer.completion;
  }
  const stoppedResult = await bounded(stopped, "the real released writer did not drain its original Host lifetime");
  if (change) {
    assert.equal(stoppedResult.ok, false, "real local drain cannot authorize a changed approval source");
    const messages = flattenErrors(stoppedResult.error);
    assert.ok(messages.includes("runtime_shutdown_unverified"), messages.join(" | "));
    assert.ok(messages.includes(change === "owner" ? "suspension.source_stale" : "suspension.witness_mismatch"),
      messages.join(" | "));
    assertRetainedApproval(f, source, resources);
    console.log(`A28 actual local-writer ${change} change blocked: ${JSON.stringify({ runId: source.run.id,
      attemptId: source.attempts[0].id, resources, failureCodes: messages })}`);
  } else {
    if (listener) {
      assert.equal(f.suspensions.length, 1, "the actual Core suspension CAS must have committed once");
      assert.equal(f.suspensions[0].result.ok, true);
      assert.equal(f.suspensions[0].result.attempt.status, "lost");
      assert.equal(f.suspensions[0].result.checkpoint.revision, source.checkpoint.revision + 1);
      assert.ok(listener.delivered.length > 0, "the real active Hub consumer must have been called");
      if (!stoppedResult.ok) {
        const failureCodes = flattenErrors(stoppedResult.error);
        assert.ok(failureCodes.includes("A28_OWNED_ACTIVE_LISTENER_FAILURE"), failureCodes.join(" | "));
        console.log(`A28 actual committed CAS followed by throwing live listener: ${JSON.stringify({
          runId: source.run.id, attemptId: source.attempts[0].id, checkpointRevision: source.checkpoint.revision + 1,
          committedCasCount: f.suspensions.length, actualListenerCalls: listener.delivered.length, failureCodes })}`);
      }
    }
    assert.equal(stoppedResult.ok, true,
      `committed approval cleanup must survive notification failure: ${stoppedResult.error?.stack}`);
    const drained = f.reopen(store => ({ value: facts(store, source.run.id, source.message.id),
      leases: store.listResourceLeases({ status: "active", workUnitId: source.work.id }),
      slots: store.listRuntimeSemaphoreSlots({ status: "active", workUnitId: source.work.id }) }));
    assert.equal(drained.value.run.status, "waiting_for_approval");
    assert.equal(drained.value.work.status, "waiting_for_approval");
    assert.equal(drained.value.attempts.length, 1);
    assert.equal(drained.value.attempts[0].id, source.attempts[0].id);
    assert.equal(drained.value.attempts[0].status, "lost");
    assert.equal(drained.value.attempts[0].errorCode, "runtime_suspend");
    assert.equal(drained.value.checkpoint.status, "pending");
    assert.equal(drained.value.checkpoint.revision, source.checkpoint.revision + 1);
    assert.deepEqual(drained.leases, []);
    assert.deepEqual(drained.slots, []);
    assert.deepEqual(drained.value.events, source.events, "late drain is cleanup, not a business Run event");
    assertSuspensionAudit(drained.value, drained.value.attempts[0]);
    if (listener) {
      assert.equal(f.suspensions.length, 1, "a failed notification cannot repeat the Core CAS");
      assert.equal(f.suspensions[0].result.ok, true);
      assert.equal(listener.delivered.length, 3, "each real invalidation is attempted after another listener delivery throws");
      assert.deepEqual(listener.delivered.map(event => event.action), ["run.approval_resume_suspended",
        "work_unit.approval_resume_suspended", "approval.resume_suspended"]);
      assert.equal(drained.value.runtimeEvents.filter(event => event.type === "work_unit_stale"
        && event.data?.reason === "runtime_suspend" && event.attemptId === source.attempts[0].id).length, 1);
      listener.close();
    }
    console.log(`A28 actual local-writer real drain committed original approval suspension: ${JSON.stringify({
      runId: source.run.id, attemptId: source.attempts[0].id, checkpointId: source.checkpoint.id })}`);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(await f.marker(), undefined);
}

async function recoveredTerminal(f, status, closeStreamFirst = false) {
  f.setTerminalMode(status);
  const paused = await pausedSource(f, closeStreamFirst);
  const decision = await f.decide(paused.source.approval.id);
  assert.equal(decision.status, 200, "the first manual decision must be durably accepted");
  await waitFor(() => ["succeeded", "failed"].includes(f.store.getRun(paused.source.run.id)?.status),
    "real continuation did not commit terminal state");
  const expectedRun = status === "ready" ? "succeeded" : "failed";
  const terminal = facts(f.store, paused.source.run.id, paused.source.message.id);
  assert.equal(terminal.run.status, expectedRun);
  assert.equal(terminal.work.status, expectedRun);
  assert.equal(terminal.attempts.at(-1).status, expectedRun);
  assert.equal(terminal.checkpoint.status, status === "ready" ? "resumed" : "resume_failed");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.approvedToolContinuation.approvalId, paused.source.approval.id);
  assert.equal(await f.marker(), "x");
  await waitFor(() => f.store.getTeammateDirectMessage(terminal.message.id)?.status === status,
    "the real Host terminal hook did not finish the original private message");
  await assertTerminalView(f, paused.source, status);
  await assertRepeatedRecovery(f, paused.source, status, "x");
  assertOriginalPause(paused, f);
}

async function deniedTerminal(f) {
  const paused = await pausedSource(f);
  const decision = await f.decide(paused.source.approval.id, "deny");
  assert.equal(decision.status, 200);
  await waitFor(() => f.store.getRun(paused.source.run.id)?.status === "failed", "real suspended denial did not terminalize");
  await waitFor(() => f.store.getTeammateDirectMessage(paused.source.message.id)?.status === "failed",
    "suspended-denial terminal hook did not finish the original message");
  const terminal = facts(f.store, paused.source.run.id, paused.source.message.id);
  assert.equal(terminal.approval.status, "denied");
  assert.equal(terminal.work.status, "failed");
  assert.equal(terminal.events.some(event => event.type === "tool_start" && event.data?.toolCallId === TOOL_CALL), false);
  assert.equal(f.calls.length, 1, "denial must not invoke a continuation Runner");
  assert.equal(await f.marker(), undefined);
  await assertTerminalView(f, paused.source, "failed");
  await assertRepeatedRecovery(f, paused.source, "failed", undefined, "deny");
  assertOriginalPause(paused, f);
}

async function preDispatchShutdown(f) {
  const paused = await pausedSource(f);
  f.stopAfterNextResumeClaim();
  const response = f.decide(paused.source.approval.id, "approve", true);
  const claim = await bounded(f.resumeClaimed.promise, "real coordinator did not reach the resume claim barrier");
  await response;
  assert.ok(f.claimStop, "the claim observer must invoke the real index stop");
  await f.claimStop;
  const stopped = f.reopen(store => facts(store, paused.source.run.id, paused.source.message.id));
  assert.equal(claim.run.status, "running");
  assert.equal(stopped.run.status, "running");
  assert.equal(stopped.work.status, "running");
  assert.equal(stopped.approval.status, "approved");
  assert.equal(stopped.checkpoint.status, "resume_pending");
  const handleAttempt = stopped.attempts.find(attempt => attempt.id === stopped.checkpoint.runnerResumeHandle?.attemptId);
  assert.equal(handleAttempt?.id, claim.attempt.id, "pre-dispatch proof must refer to the claimed handle, not original basis Attempt");
  assert.notEqual(handleAttempt.id, stopped.checkpoint.resumeBasis.priorAttemptId);
  assert.equal(handleAttempt.status, "lost");
  assert.equal(handleAttempt.errorCode, "runtime_suspend");
  assert.ok(handleAttempt.endedAt);
  assert.ok(stopped.checkpoint.revision > claim.checkpoint.revision);
  assertSuspensionAudit(stopped, handleAttempt);
  assert.equal(stopped.events.some(event => event.type === "tool_start" && event.data?.toolCallId === TOOL_CALL), false);
  assert.equal(await f.marker(), undefined);
  assert.equal(stopped.message.status, "pending", "running-shaped resume_pre_dispatch is still this logical private reply");
  assert.equal(stopped.message.errorMessage, undefined);
  await f.start();
  await waitFor(() => f.store.getRun(paused.source.run.id)?.status === "succeeded", "real pre-dispatch restart did not recover");
  await waitFor(() => f.store.getTeammateDirectMessage(paused.source.message.id)?.status === "ready",
    "pre-dispatch recovery failed to reconcile the original private message");
  assert.equal(await f.marker(), "x");
  assert.equal(f.calls.length, 2, "the suspended dispatch never entered the Runner");
  await assertTerminalView(f, paused.source, "ready");
  await assertRepeatedRecovery(f, paused.source, "ready", "x");
  assertOriginalPause(paused, f);
}

async function terminalMessageGap(f) {
  const paused = await pausedSource(f);
  const id = paused.source.message.id;
  // A persistent trigger in this disposable DB creates the exact projection
  // failure window regardless of the new guarded Core writer's method name.
  // The real terminal transaction is NOT mocked, and no status is seeded.
  const quotedId = `'${id.replaceAll("'", "''")}'`;
  f.sql(db => db.exec(`CREATE TRIGGER a28_owned_private_terminal_gap
    BEFORE UPDATE ON teammate_direct_messages
    WHEN OLD.id = ${quotedId} AND NEW.status IN ('ready', 'failed', 'cancelled')
    BEGIN SELECT RAISE(ABORT, 'A28_OWNED_PRIVATE_TERMINAL_WRITE_GAP'); END`), true);
  try {
    const decision = await f.decide(paused.source.approval.id);
    assert.equal(decision.status, 200);
    const committed = await bounded(f.terminalCommitted.promise, "the actual Host terminal transaction was never committed");
    assert.equal(committed.run.id, paused.source.run.id);
    assert.equal(committed.run.status, "succeeded");
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    const terminal = facts(f.store, paused.source.run.id, id);
    assert.equal(terminal.run.status, "succeeded");
    assert.equal(terminal.work.status, "succeeded");
    assert.equal(terminal.attempts.at(-1).status, "succeeded");
    assert.equal(terminal.checkpoint.status, "resumed");
    const before = f.rawMessage(id);
    assert.equal(before.status, "pending", "only the private projection, never the Host terminal commit, is interrupted");
    assert.equal(await f.marker(), "x");
    const callCount = f.calls.length;
    await assertTerminalView(f, paused.source, "ready");
    await assertTerminalView(f, paused.source, "ready");
    assert.deepEqual(f.rawMessage(id), before, "GET projection must be read-only even across the terminal-message gap");
    assert.equal(f.calls.length, callCount, "GET must not dispatch recovery or replay the approved tool");
    await f.stop();
    const reopened = f.reopen(store => facts(store, paused.source.run.id, id));
    assert.equal(reopened.run.status, "succeeded");
    assert.equal(reopened.message.status, "pending");
  } finally {
    // Exact test-owned trigger only; this is not a schema migration or user DB.
    f.sql(db => db.exec("DROP TRIGGER IF EXISTS a28_owned_private_terminal_gap"), true);
  }
  await f.start();
  await waitFor(() => f.store.getTeammateDirectMessage(id)?.status === "ready",
    "startup did not reconcile the committed terminal Run into its linked pending private message");
  await assertTerminalView(f, paused.source, "ready");
  await assertRepeatedRecovery(f, paused.source, "ready", "x");
  assertOriginalPause(paused, f);
}

/** Repeated HTTP decisions and real index scans must not create new execution. */
async function assertRepeatedRecovery(f, source, status, marker, action = "approve") {
  const before = facts(f.store, source.run.id, source.message.id);
  const beforeRow = f.rawMessage(source.message.id);
  const callCount = f.calls.length;
  for (let index = 0; index < 2; index++) {
    await f.decide(source.approval.id, action);
    await assertTerminalView(f, source, status);
    assert.deepEqual(f.rawMessage(source.message.id), beforeRow, "idempotent decisions/reads must not touch body or updatedAt");
    await f.stop();
    await f.start();
    await assertTerminalView(f, source, status);
    assert.deepEqual(f.rawMessage(source.message.id), beforeRow, "repeat startup reconciliation must be an unchanged-row no-op");
  }
  const after = facts(f.store, source.run.id, source.message.id);
  assert.equal(f.calls.length, callCount);
  assert.equal(await f.marker(), marker);
  assert.deepEqual(after.attempts.map(attempt => attempt.id), before.attempts.map(attempt => attempt.id));
  assert.equal(after.checkpoint.revision, before.checkpoint.revision);
  assert.deepEqual(after.events.filter(isOwnedToolEvent).map(event => event.id), before.events.filter(isOwnedToolEvent).map(event => event.id));
  assert.equal(after.events.filter(event => isOwnedToolEvent(event) && event.type === "tool_start").length, marker ? 1 : 0);
  assert.equal(after.events.filter(event => isOwnedToolEvent(event) && event.type === "tool_end").length, marker ? 1 : 0);
  // A late original Attempt callback cannot overwrite a terminal successor.
  const old = f.calls[0].options;
  assert.doesNotThrow(() => old.onEvent?.({ type: "assistant_text_delta", text: "A28_FORBIDDEN_OLD_CALLBACK" }));
  assert.deepEqual(f.rawMessage(source.message.id), beforeRow);
}

async function assertTerminalView(f, source, status) {
  const body = await f.messages();
  const message = body.messages.find(item => item.id === source.message.id);
  assert.ok(message, "the original private reply remains addressable");
  assert.equal(message.status, status);
  assert.equal(message.linkedRunId, source.run.id);
  assert.equal(message.threadId, source.message.threadId);
  assert.equal(message.teammateId, TEAMMATE);
  assert.equal(body.messages.filter(item => item.authorType === "ai-teammate" && item.linkedRunId === source.run.id).length, 1);
  assert.equal(body.timeline.turns.find(turn => turn.id === source.turn.id)?.teammateId, TEAMMATE);
  assert.equal(f.store.getLingTurnForRun(source.run.id)?.id, source.turn.id);
  assert.deepEqual(f.store.listLingTurnRuns(source.turn.id).map(link => link.runId), [source.run.id]);
  if (status === "ready") {
    assert.ok(message.body.includes(FINAL), JSON.stringify(message));
    assert.equal(message.body.split(FINAL).length - 1, 1, "final narration must not duplicate across recovery");
    assert.equal(message.errorMessage, undefined);
  } else {
    assert.ok(message.errorMessage?.length > 0, "real failure retains a user-visible diagnostic");
    assert.equal(message.body.includes(FINAL), false);
  }
  assert.doesNotMatch(JSON.stringify(message), /A28_FORBIDDEN_OLD_CALLBACK/u);
  return message;
}

function assertOriginalPause(paused, f) {
  assert.equal(paused.suspended.message.status, "pending", "a real committed approval wait is not a failed reply");
  assert.equal(paused.suspended.message.errorMessage, undefined);
  assert.equal(paused.suspended.message.body, NARRATION);
  assert.equal(paused.streamResult.events.some(event => ["done", "error", "blocked"].includes(event.event)), false,
    "closing the original transport cannot announce a business terminal result");
  assert.equal(f.responseFacts.writesAfterClose, 0);
}

function facts(store, runId, messageId) {
  const run = store.getRun(runId);
  assert.ok(run);
  const work = store.getWorkUnit(run.workUnitId);
  const approval = store.listApprovalRequests({ runId, limit: 10 }).find(item => item.toolCallId === TOOL_CALL);
  assert.ok(work);
  assert.ok(approval, "the proof must originate in the real original approval callback");
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  const turn = store.getLingTurnForRun(runId);
  const message = store.getTeammateDirectMessage(messageId);
  assert.ok(checkpoint?.resumeBasis);
  assert.ok(turn);
  assert.ok(message);
  assert.equal(message.linkedRunId, run.id);
  return { run, work, approval, checkpoint, turn, message, attempts: store.listWorkUnitAttempts(work.id),
    runtimeEvents: store.listRuntimeEvents(work.id, { limit: 1000 }),
    events: store.listEvents(runId, { limit: 1000 }) };
}

function assertSuspensionAudit(snapshot, attempt) {
  assert.equal(snapshot.runtimeEvents.some(event => event.type === "work_unit_stale"
    && event.attemptId === attempt.id && event.runtimeInstanceId === attempt.runtimeInstanceId
    && event.fencingToken === attempt.fencingToken && event.data?.reason === "runtime_suspend"
    && event.data?.recoverable === true && event.data?.checkpointId === snapshot.checkpoint.id), true,
  "the pause must include the actual transaction's fenced suspension audit, not just a status or error string");
}

function isOwnedToolEvent(event) {
  return ["tool_start", "tool_end"].includes(event.type) && event.data?.toolCallId === TOOL_CALL;
}

function consumeSse(response) {
  const linked = deferred();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const done = (async () => {
    let text = "", error;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        text += decoder.decode(part.value, { stream: true });
        const event = parseSse(text).find(item => item.event === "run_linked");
        if (event) linked.resolve(event);
      }
      text += decoder.decode();
    } catch (failure) { error = failure; }
    finally { reader.releaseLock(); }
    const events = parseSse(text);
    if (!events.some(event => event.event === "run_linked")) linked.reject(new Error(`A28 recovery stream never linked: ${text}`));
    return { text, events, error };
  })();
  linked.promise.catch(() => undefined);
  return { linked, done, cancel: () => reader.cancel() };
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/u).flatMap(frame => {
    const event = /^event: (.+)$/mu.exec(frame)?.[1], data = /^data: (.+)$/mu.exec(frame)?.[1];
    if (!event || !data) return [];
    try { return [{ event, data: JSON.parse(data) }]; } catch { return []; }
  });
}

async function waitFor(read, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise(resolvePoll => setTimeout(resolvePoll, 10));
  }
  assert.fail(message);
}

async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

function deferred() {
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolvePromiseValue, rejectPromiseValue) => {
    resolvePromise = resolvePromiseValue;
    rejectPromise = rejectPromiseValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

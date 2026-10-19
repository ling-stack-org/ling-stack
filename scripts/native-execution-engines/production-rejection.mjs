import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createCompositeSecretResolver, resolveStoragePaths, SqliteRunStore,
  toRuntimeAttemptFence } from "../../packages/core/dist/index.js";

const message = "LING_NATIVE_PRODUCTION_REJECTION_INPUT";
const rejection = "native_execution_verification_missing";
const rejectionMessage = "Current execution verification is required.";
const receiptName = "codex-production-rejection.json";
const hash = value => createHash("sha256").update(value).digest("hex");
const requireFact = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const inside = (root, path) => { const part = relative(root, path); return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const terminal = new Set(["succeeded", "failed", "cancelled", "stale", "lost"]);

// Read only public RunStore APIs. The daemon's original factory remains untouched.
// Open before startup or after daemon.stop(), never replace the serving Store.
function snapshot(cwd) {
  const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace });
  try {
    return store.readSnapshot(() => {
      const runs = store.listRuns({ limit: 1000 });
      const workUnits = store.listWorkUnits({ limit: 1000 });
      const threads = store.listLingThreads({ includeArchived: true, limit: 1000 });
      requireFact([runs, workUnits, threads].every(rows => rows.length < 1000), "production_rejection_snapshot_limit");
      const attempts = workUnits.flatMap(unit => store.listWorkUnitAttempts(unit.id));
      const submissions = new Map(store.listUnresolvedNativeSubmissions(1000).map(row => [row.id, row]));
      requireFact(submissions.size < 1000, "production_rejection_snapshot_limit");
      for (const run of runs) for (const attempt of attempts.filter(value => value.workUnitId === run.workUnitId)) {
        for (const row of store.listNativeAttemptSubmissions({ runId: run.id, ...toRuntimeAttemptFence(attempt) })) submissions.set(row.id, row);
      }
      const canonical = threads.flatMap(thread => {
        const turns = store.listLingTurns({ threadId: thread.id, limit: 1000 });
        requireFact(turns.length < 1000, "production_rejection_snapshot_limit");
        return turns.filter(turn => turn.userInstruction === message).map(turn => {
          const source = turn.sourceItemId && store.getConversationItem(turn.sourceItemId);
          const accepted = source && store.getConversationAcceptedInputSnapshot(source.id);
          const prepared = source && store.getConversationPreparedInput(source.id, "request");
          const request = prepared?.payload?.request;
          return { threadId: thread.id, threadStatus: thread.status, turnId: turn.id, turnStatus: turn.status,
            activeRunId: thread.activeRunId ?? null, turnActiveRunId: turn.activeRunId ?? null,
            userInstruction: turn.userInstruction, sourceItemId: source?.id, sourceBody: source?.payload?.body,
            acceptedSnapshotId: accepted?.id, acceptedFingerprint: accepted?.fingerprint,
            preparedSnapshotId: prepared?.id, preparedAcceptedSnapshotId: prepared?.acceptedSnapshotId,
            preparedParentFingerprint: prepared?.parentFingerprint,
            preparedRequestAcceptedSnapshotId: request?.normalConversationAcceptedSnapshotId,
            executionBinding: request?.executionBinding, authorizationMode: request?.authorizationMode,
            workspaceAccessMode: request?.workspaceAccessMode, permissionMode: request?.permissionMode, tools: request?.tools,
            preparedThreadId: request?.threadId, preparedTurnId: request?.turnId,
            preparedSourceItemId: request?.normalConversationContext?.hydration?.source?.itemId,
            preparedPromptIncludesInput: request?.task?.prompt?.includes(message) === true,
            preparedPromptSha256: typeof request?.task?.prompt === "string" ? hash(request.task.prompt) : null,
            linkedRunIds: store.listLingTurnRuns(turn.id).map(row => row.runId) };
        });
      });
      const describe = row => ({ id: row.id, status: row.status });
      return { runs: runs.map(describe), workUnits: workUnits.map(describe), attempts: attempts.map(describe),
        nativeSubmissions: [...submissions.values()].map(describe),
        nativeSubmissionCoverage: "all persisted Run/Attempt fences plus unresolved submissions through public RunStore APIs",
        providerPresetCount: store.listProviderPresets().length, canonical,
        threadCount: threads.length };
    });
  } finally { store.close(); }
}

function settleWithin(promise, milliseconds, signal) {
  const observed = Promise.resolve(promise).then(value => ({ state: "fulfilled", value }), () => ({ state: "rejected" }));
  return new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(result);
    };
    const abort = () => finish({ state: "aborted" });
    const timer = setTimeout(() => finish({ state: "timed_out" }), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    observed.then(finish);
    if (signal?.aborted) abort();
  });
}

// A rejected SSE send may leave its HTTP response open. Consume the complete
// terminal error event, close our client, and observe both client close events.
function localRequest(url, { method = "GET", headers, body, signal, terminalError = false } = {}) {
  return new Promise((resolve, reject) => {
    let response, responseClosed = false, requestClosed = false, ended = false, terminalCaptured = false;
    let failure, size = 0; const chunks = [];
    const request = httpRequest(url, { method, headers, agent: false });
    const stop = code => {
      failure ??= code;
      response?.destroy(); request.destroy();
    };
    const abort = () => stop("production_rejection_aborted");
    const timer = setTimeout(() => stop("production_rejection_http_timeout"), 20_000);
    const finish = () => {
      if (!requestClosed || response && !responseClosed) return;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(Object.assign(new Error(failure), { code: failure }));
      else resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8"),
        responseEnded: ended, clientClosedAfterTerminalError: terminalCaptured, clientClosed: true });
    };
    request.on("response", value => {
      response = value;
      value.on("data", bytes => {
        size += bytes.length;
        if (size > 512 * 1024) { stop("production_rejection_response_limit"); return; }
        chunks.push(bytes);
        if (terminalError && /(?:^|\n\n)event: error\r?\n(?:[^\n]*\n)*?\r?\n/.test(Buffer.concat(chunks).toString("utf8"))) {
          terminalCaptured = true; value.destroy(); request.destroy();
        }
      });
      value.on("end", () => { ended = true; });
      value.on("error", () => { if (!terminalCaptured) failure ??= "production_rejection_http_failed"; });
      value.on("close", () => { responseClosed = true; finish(); });
    });
    request.on("error", () => { if (!terminalCaptured) failure ??= "production_rejection_http_failed"; });
    request.on("close", () => { requestClosed = true; finish(); });
    signal?.addEventListener("abort", abort, { once: true });
    if (body !== undefined) request.write(body);
    request.end();
    if (signal?.aborted) abort();
  });
}

function sseFacts(text) {
  const events = text.split(/\r?\n\r?\n/).filter(block => block.split(/\r?\n/).some(line => line && !line.startsWith(":"))).map(block => {
    const lines = block.split(/\r?\n/);
    const type = lines.find(line => line.startsWith("event: "))?.slice(7);
    const data = JSON.parse(lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n"));
    requireFact(typeof type === "string" && /^[a-z_]+$/.test(type), "production_rejection_invalid_sse");
    return { type, data };
  });
  const errors = events.filter(event => event.type === "error");
  return { eventTypes: events.map(event => event.type), errorCount: errors.length,
    error: errors[0]?.data?.error === rejectionMessage ? rejectionMessage : "unexpected_or_missing_error",
    errorCode: "not_exposed_by_public_sse",
    readyRunIds: events.filter(event => event.type === "ready" && typeof event.data?.runId === "string").map(event => event.data.runId),
    assistantStatuses: errors.map(event => event.data?.assistantMessage?.status),
    responseSha256: hash(text) };
}

/** Negative gate evidence only. This never publishes acceptance or sends a model request. */
export async function runProductionRejection({ root, paths, profile, model, provider, signal, record,
  assertCurrentAuthority = () => {} }) {
  const facts = { evidenceScope: "isolated embedded startup + production HTTP admission rejection",
    fullDefaultStartup: "not_run", productionAdmission: "not_run", resourceAdmission: "not_run",
    productionCertification: false, published: false,
    instantaneousProcessObservation: "not_performed",
    isolation: { secretResolver: "createCompositeSecretResolver({env:{}})", browserBrokerEnabled: false,
      hostDependencyOverrides: ["secretResolver", "chromeBrowserNativeMessagingEnabled"] },
    configurationLimitation: { ownedCandidateProvider: provider, productionModelProvider: "openai",
      productionConfigurationEquivalence: "not_established", fullAcceptanceIdentity: "not_generated_or_published" },
    cleanup: { daemonStopped: false, listenerClosed: false } };
  let daemon, workspace, before, after, canonicalHome, startPromise, stopPromise, drainCompletion;
  let lifecycleOpened = false, startSettled = false, drained = true;
  const previousHome = process.env.LING_STACK_HOME;
  const restoreEnvironment = () => {
    if (process.env.LING_STACK_HOME !== canonicalHome) return;
    if (previousHome === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = previousHome;
  };
  try {
    signal?.throwIfAborted(); assertCurrentAuthority();
    const canonicalRoot = await realpath(root); canonicalHome = await realpath(paths.rootDir);
    requireFact(inside(canonicalRoot, canonicalHome), "production_rejection_isolation_required");
    requireFact(profile.configuration.engineId === "codex-app-server" && !profile.configuration.secretRef,
      "production_rejection_uncredentialed_profile_required");
    workspace = join(canonicalRoot, "production-rejection-workspace");
    await mkdir(workspace, { mode: 0o700 });
    process.env.LING_STACK_HOME = canonicalHome;
    facts.workspace = workspace;
    facts.profile = { id: profile.id, revision: profile.revision, configurationFingerprint: profile.configurationFingerprint,
      hasSecretRef: false, nativeModelId: model };
    before = snapshot(workspace);
    facts.before = before;
    requireFact(before.providerPresetCount === 0, "production_rejection_provider_isolation_required");
    const { createDaemonServer } = await import("../../packages/daemon/dist/index.js");
    lifecycleOpened = true; drained = false;
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: workspace }, {
      secretResolver: createCompositeSecretResolver({ env: {} }), chromeBrowserNativeMessagingEnabled: false,
    });
    facts.lastStage = "starting";
    startPromise = Promise.resolve().then(() => daemon.start());
    const startupResult = await settleWithin(startPromise, 15_000, signal);
    startSettled = startupResult.state === "fulfilled" || startupResult.state === "rejected";
    facts.cleanup.startResult = startupResult.state;
    requireFact(startupResult.state === "fulfilled", `production_rejection_start_${startupResult.state}`);
    const startup = daemon.startupState.snapshot(workspace);
    facts.isolation.secretResolverPhase = startup?.phases.secret_resolver;
    facts.isolation.startupState = startup?.state;
    facts.isolation.startupDiagnosticCodes = startup?.diagnostics.map(row => row.code);
    requireFact(startup?.phases.secret_resolver === "degraded", "production_rejection_startup_scope_changed");
    const address = daemon.server.address();
    requireFact(address && typeof address !== "string" && address.address === "127.0.0.1", "production_rejection_listener_not_isolated");
    facts.listener = { address: address.address, port: address.port };
    const request = async (path, options = {}) => {
      signal?.throwIfAborted(); assertCurrentAuthority();
      const url = new URL(path, `http://127.0.0.1:${address.port}`);
      url.searchParams.set("cwd", workspace);
      facts.lastStage = url.pathname;
      return localRequest(url, { ...options, signal });
    };
    const initial = await request("/runtime/settings");
    requireFact(initial.status === 200, "production_rejection_settings_unavailable");
    const binding = { kind: "native_profile", engineId: "codex-app-server", profileId: profile.id,
      profileRevision: profile.revision, nativeModelId: model };
    const patch = { schemaVersion: 2, confirmNativeMigration: true,
      expectedUpdatedAt: JSON.parse(initial.text).settings.updatedAt, allowedRunnerIds: ["pi", "codex-app-server"],
      defaultRunnerId: "codex-app-server", defaultExecutionBinding: binding };
    const saved = await request("/runtime/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    requireFact(saved.status === 200, "production_rejection_authorization_failed");
    const settings = JSON.parse(saved.text).settings;
    facts.authorization = { request: patch, persisted: { schemaVersion: settings.schemaVersion, allowedRunnerIds: settings.allowedRunnerIds,
      defaultRunnerId: settings.defaultRunnerId, defaultExecutionBinding: settings.defaultExecutionBinding, updatedAt: settings.updatedAt } };
    requireFact(settings.schemaVersion === 2 && settings.allowedRunnerIds.includes("codex-app-server")
      && isDeepStrictEqual(settings.defaultExecutionBinding, binding), "production_rejection_authorization_mismatch");
    const availability = await request("/runtime/conversation-execution?authorizationMode=smart&workspaceAccessMode=read_only&permissionMode=custom");
    const selected = JSON.parse(availability.text);
    facts.availability = { httpStatus: availability.status, status: selected.status, reason: selected.reason,
      executionBinding: selected.executionBinding };
    requireFact(availability.status === 200 && facts.availability.status === "blocked" && facts.availability.reason === rejection,
      "production_rejection_availability_not_blocked");
    facts.input = { message, executionBinding: binding, tools: [], authorizationMode: "smart", workspaceAccessMode: "read_only",
      permissionMode: "custom", responseLanguage: "en", idempotencyKey: "candidate-production-rejection" };
    const stream = await request("/conversations/stream", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(facts.input), terminalError: true });
    facts.stream = { httpStatus: stream.status, responseEnded: stream.responseEnded,
      clientClosedAfterTerminalError: stream.clientClosedAfterTerminalError, clientClosed: stream.clientClosed, ...sseFacts(stream.text) };
    requireFact(stream.status === 200 && facts.stream.errorCount === 1 && facts.stream.error === rejectionMessage
      && facts.stream.assistantStatuses.every(status => status === "failed") && facts.stream.readyRunIds.length === 0
      && !facts.stream.eventTypes.includes("done"), "production_rejection_stream_not_blocked");
  } catch (error) {
    facts.failure = typeof error?.code === "string" && error.code.startsWith("production_rejection_") ? error.code
      : signal?.aborted ? "production_rejection_aborted" : "production_rejection_failed";
  } finally {
    if (daemon) {
      if (startSettled) {
        stopPromise = Promise.resolve().then(() => daemon.stop());
        const stopped = await settleWithin(stopPromise, 10_000);
        facts.cleanup.stopResult = stopped.state;
        if (stopped.state === "fulfilled") {
          drained = true; facts.cleanup.daemonStopped = true; facts.cleanup.listenerClosed = !daemon.server.listening;
        } else {
          facts.failure = `production_rejection_stop_${stopped.state}`;
          drainCompletion = stopPromise.then(() => { restoreEnvironment(); return true; }, () => false);
        }
      } else {
        // Startup may still own callbacks and Stores. Do not race them with
        // close/snapshot/removal; retain handlers and keep the isolated home.
        facts.cleanup.stopResult = "deferred_until_startup_settles";
        drainCompletion = startPromise.then(() => daemon.stop(), () => daemon.stop())
          .then(() => { restoreEnvironment(); return true; }, () => false);
      }
    }
    if (workspace && drained) {
      try { after = snapshot(workspace); facts.after = after; }
      catch { facts.failure = "production_rejection_snapshot_failed"; }
    }
    if (drained) restoreEnvironment();
  }
  if (before && after) {
    const added = key => after[key].filter(row => !before[key].some(previous => previous.id === row.id));
    facts.canonical = after.canonical;
    facts.execution = { newNativeSubmissions: added("nativeSubmissions"),
      newNonterminalExecutions: ["runs", "workUnits", "attempts"].flatMap(kind => added(kind).filter(row => !terminal.has(row.status)).map(row => ({ kind, ...row }))),
      newSuccessfulRuns: added("runs").filter(row => row.status === "succeeded"),
      countsBefore: Object.fromEntries(["runs", "workUnits", "attempts", "nativeSubmissions"].map(key => [key, before[key].length])),
      countsAfter: Object.fromEntries(["runs", "workUnits", "attempts", "nativeSubmissions"].map(key => [key, after[key].length])) };
    const input = facts.canonical[0];
    if (facts.canonical.length !== 1 || input.threadStatus !== "failed" || input.activeRunId || input.turnActiveRunId || input.linkedRunIds.length
      || input.sourceBody !== message || !input.acceptedSnapshotId || !input.preparedSnapshotId
      || input.acceptedSnapshotId !== input.preparedAcceptedSnapshotId || input.acceptedSnapshotId !== input.preparedRequestAcceptedSnapshotId
      || input.acceptedFingerprint !== input.preparedParentFingerprint || input.threadId !== input.preparedThreadId
      || input.turnId !== input.preparedTurnId || input.sourceItemId !== input.preparedSourceItemId || !input.preparedPromptIncludesInput
      || !isDeepStrictEqual(input.executionBinding, facts.input?.executionBinding) || !isDeepStrictEqual(input.tools, [])
      || input.authorizationMode !== "smart" || input.workspaceAccessMode !== "read_only" || input.permissionMode !== "custom"
      || facts.execution.newNativeSubmissions.length || facts.execution.newNonterminalExecutions.length || facts.execution.newSuccessfulRuns.length) {
      facts.failure ??= "production_rejection_durable_facts_mismatch";
    }
  } else facts.failure ??= "production_rejection_snapshot_missing";
  if (lifecycleOpened && (!drained || !facts.cleanup.listenerClosed)) facts.failure ??= "production_rejection_shutdown_unconfirmed";
  facts.cleanup.isolatedEnvironmentRetained = !drained;
  facts.status = facts.failure ? "failed" : "passed";
  await record(receiptName, facts);
  return { observation: { status: facts.status,
    reason: facts.failure ?? "isolated_embedded_startup_production_http_admission_rejected", evidence: [receiptName] },
    allLifetimesDrained: drained, allChildrenClosed: drained && (!lifecycleOpened || facts.cleanup.listenerClosed),
    environmentRestorationDeferred: !drained,
    drainCompletion,
    unresolvedSubmissionCount: after?.nativeSubmissions.filter(row => ["reserved", "submission_pending", "accepted", "unknown"].includes(row.status)).length ?? null };
}

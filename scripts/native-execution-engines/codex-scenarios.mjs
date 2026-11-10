import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../packages/core/dist/index.js";
import { probeEngineConnection } from "../../packages/daemon/dist/features/execution-engines/connection-probe.js";
import { executeOwnedCodexTurn } from "../../packages/daemon/dist/runtime/adapters/codex/owned-execution.js";
import { codexConfigurationFingerprint } from "../../packages/daemon/dist/runtime/adapters/codex/journaled-lifecycle.js";
import { codexOutputTools } from "../../packages/daemon/dist/runtime/adapters/codex/tool-output.js";

const { parse } = createRequire(new URL("../../packages/daemon/package.json", import.meta.url))("shell-quote");
const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const observation = (status, reason, evidence = []) => ({ status, reason, evidence });
const names = ["connection", "conversation", "recovery", "cancellation", "permissions", "artifacts", "workspace"];
const terminal = new Set(["completed", "failed", "cancelled", "rejected", "not_submitted"]);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

/** A candidate runner only. It never writes RunnerAcceptanceStore or certifies production. */
export async function runCodexScenarios(input) {
  const { root, paths, profiles, profile, executablePath, executableDigest, model, provider, signal, record,
    assertCurrentAuthority = () => {}, extraSecrets = [] } = input;
  const observations = Object.fromEntries(names.map(name => [name, observation("not_run", "candidate_not_run")]));
  observations.workspace = observation("not_run", "cross_workspace_execution_not_exercised");
  const stages = [], children = [], closed = [], lifetimes = [];
  let store, activeStage, counter = 0, unresolvedSubmissionCount = 0;
  const resolver = { resolve: () => ({ configured: false }) };
  const workspace = await realpath(input.workspace);
  const home = await realpath(profiles.getAuthProfileDirectory(profile));
  const actualRoot = await realpath(root);
  for (const directory of [workspace, home, await realpath(paths.rootDir)]) {
    const child = relative(actualRoot, directory);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("candidate_isolation_invalid");
  }
  const approvedTarget = join(workspace, "candidate-approved.txt");
  const deniedTarget = join(workspace, "candidate-denied.txt");
  const artifactName = "candidate-native-artifact.txt";
  const artifactTarget = join(workspace, artifactName);
  const artifactText = "LING_NATIVE_ARTIFACT_OK\n";
  const approvedCommand = `/usr/bin/touch ${quote(approvedTarget)}`;
  const deniedCommand = `/usr/bin/touch ${quote(deniedTarget)}`;
  if ([approvedTarget, deniedTarget, artifactTarget].some(path => !absent(path))) throw new Error("candidate_target_exists");
  const configuration = { cwd: workspace, model, modelProvider: provider, approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false } };
  const selection = { engineId: "codex-app-server", profileId: profile.id, profileRevision: profile.revision,
    profileFingerprint: profile.configurationFingerprint, modelId: model,
    configurationFingerprint: codexConfigurationFingerprint(configuration) };

  const launch = (file, args, options) => {
    const stage = activeStage;
    const child = spawn(file, args, options);
    const state = { stage: stage?.name ?? "connection", pid: child.pid ?? null, closed: false };
    children.push(state);
    closed.push(new Promise(resolveClosed => {
      child.once("close", (code, childSignal) => {
        Object.assign(state, { closed: true, code, signal: childSignal });
        resolveClosed();
      });
      child.once("error", () => { state.spawnFailed = true; });
    }));
    if (!stage) return child;
    let pending = "";
    child.stdout?.on("data", bytes => {
      pending += bytes.toString("utf8");
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try { observeProtocol(stage, JSON.parse(line)); } catch { /* Never persist raw peer output. */ }
      }
      if (pending.length > 36 * 1024 * 1024) { pending = ""; stage.protocolOverflow = true; stage.abort.abort(); }
    });
    return child;
  };

  const observeProtocol = (stage, message) => {
    const params = message.params;
    if (message.id !== undefined && typeof message.method === "string") {
      stage.requests.set(JSON.stringify(message.id), { method: message.method, params });
    }
    if (["item/started", "item/completed", "item/fileChange/patchUpdated"].includes(message.method)) {
      const item = params?.item ?? (message.method === "item/fileChange/patchUpdated" ? { type: "fileChange",
        id: params.itemId, changes: params.changes, status: "preview" } : undefined);
      if (codexOutputTools.has(item?.type)) {
        stage.toolItems.add(item.id);
        const expectedCommand = stage.name === "approval" ? approvedTarget : stage.name === "denial" ? deniedTarget : undefined;
        const permitted = item.type === "commandExecution" && expectedCommand
          ? exactTouch(item.command, expectedCommand) && item.cwd === workspace
          : item.type === "fileChange" && stage.name === "artifact"
            && exactArtifactChange(item.changes, artifactName, artifactTarget, artifactText);
        if (!permitted || stage.toolItems.size !== 1) { stage.unexpectedTool = true; stage.abort.abort(); }
      }
      if (item?.type === "fileChange") {
        stage.fileContext.set(JSON.stringify([params.threadId, params.turnId, item.id]), item);
        stage.protocol.push({ method: message.method, kind: "fileChange", itemId: item.id, status: item.status,
          exactArtifactChange: exactArtifactChange(item.changes, artifactName, artifactTarget, artifactText) });
      } else if (item?.type === "commandExecution") {
        stage.protocol.push({ method: message.method, kind: "commandExecution", itemId: item.id, status: item.status,
          exactApprovedCommand: exactTouch(item.command, approvedTarget), exactDeniedCommand: exactTouch(item.command, deniedTarget),
          cwdMatches: item.cwd === workspace, exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : null });
        const expected = stage.name === "approval" ? approvedTarget : stage.name === "denial" ? deniedTarget : undefined;
        if (!expected || !exactTouch(item.command, expected)) { stage.unexpectedTool = true; stage.abort.abort(); }
      }
    }
  };

  async function run(name, prompt, { sentinel, cancel = false } = {}) {
    const evidenceName = `codex-${name}.json`;
    if (signal.aborted || children.some(child => !child.closed) || lifetimes.some(value => !value.settled)) {
      await record(evidenceName, { name, notRun: true, reason: "candidate_aborted_or_prior_execution_not_drained" });
      stages.push({ name, status: "not_run", evidence: evidenceName });
      return { name, evidenceName, notRun: true };
    }
    const abort = new AbortController();
    const stage = { name, abort, requests: new Map(), fileContext: new Map(), toolItems: new Set(), protocol: [],
      approvals: [], eventTypes: [], eventIds: [], approved: 0, denied: 0, unexpectedTool: false };
    activeStage = stage;
    const id = `candidate-${name}-${++counter}`;
    const task = store.createTask({ channelId: channel.id, title: `Native candidate ${name}`, prompt }, now());
    store.createRun({ id, cwd: workspace, taskId: task.id, threadId: thread.id, channelId: channel.id,
      providerName: "native", providerModel: model, taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
    const work = store.createWorkUnit({ id: `wu-${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, linkedRunId: id, runnerId: "codex-app-server", idempotencyKey: id,
      createdByActor: "user", request: {}, now: now() });
    const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1,
      runnerId: "codex-app-server", runtimeInstanceId: "native-candidate", now: now() });
    const fence = toRuntimeAttemptFence(attempt);
    store.linkRunToWorkUnit(id, work.id, now());
    store.transitionRunStatus({ runId: id, event: "runner_started", actor: "system", now: now() });
    for (const event of ["claim", "runner_started"]) store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now: now() });
    store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now: now() });
    const deadline = setTimeout(() => { stage.deadlineReached = true; abort.abort(); }, 90_000);
    let assistantText = "", execution, failed = false;
    const childStart = children.length;
    try {
      execution = await executeOwnedCodexTurn({ store, reservation: { runId: id, generation: 1, selection, fence },
        configuration, input: { input: [{ type: "text", text: prompt, text_elements: [] }], effort: "low" },
        process: { executablePath, executableDigest, codexHome: home },
        authentication: { store: profiles, profile, secretResolver: resolver },
        approvalPolicy: { policy: { toolDecisions: { bash: "ask", write: "ask", edit: "ask" }, allowedWritePaths: [workspace] } },
        output: { requireAssistantText: !cancel, extraSecrets }, signal: AbortSignal.any([signal, abort.signal]), launch,
        assertCurrentAuthority,
        requestTimeoutMs: 15_000, onLocalLifetime: lifetime => {
          const state = { settled: false };
          state.promise = Promise.resolve(lifetime).then(() => { state.settled = true; }, () => { state.settled = true; });
          lifetimes.push(state);
        },
        onEvent: event => {
          assertCurrentAuthority();
          stage.eventTypes.push(event.type); stage.eventIds.push(event.id);
          if (event.type === "assistant_text_delta" && typeof event.data.text === "string") assistantText += event.data.text;
          if (event.type === "tool_start") {
            const expected = ["approval", "denial"].includes(name) ? "bash" : name === "artifact" ? "apply_patch" : undefined;
            if (!expected || event.data.toolName !== expected || stage.toolItems.size !== 1) { stage.unexpectedTool = true; abort.abort(); }
          }
          if (cancel && event.type === "turn_start") { stage.cancelTriggeredAtTurnStart = true; abort.abort(); }
          if (event.type !== "approval_requested") return;
          const approvalId = event.data.approvalId;
          const approval = store.getApprovalRequest(approvalId);
          const correlation = store.getNativeApprovalCorrelation(approvalId);
          const request = stage.requests.get(JSON.stringify(correlation?.requestId));
          const params = request?.params, payload = approval?.payload;
          const boundedScope = params && (params.environmentId == null || params.environmentId === "local")
            && params.permissions == null && params.grantRoot == null
            && params.additionalPermissions == null && params.networkApprovalContext == null;
          const command = request?.method === "item/commandExecution/requestApproval"
            && payload?.type === "bash" && payload.cwd === workspace && params?.cwd === workspace
            && boundedScope
            && exactTouch(payload.command, approvedTarget) && exactTouch(params.command, approvedTarget);
          const context = stage.fileContext.get(JSON.stringify([params?.threadId, params?.turnId, params?.itemId]));
          const file = request?.method === "item/fileChange/requestApproval" && boundedScope
            && exactArtifactChange(context?.changes, artifactName, artifactTarget, artifactText)
            && payload?.type === "file_edit" && [artifactName, artifactTarget].includes(payload.path)
            && payload.touchedPaths?.length === 1 && [artifactName, artifactTarget].includes(payload.touchedPaths[0])
            && payload.diffPreview === context.changes.map(change => `${change.kind.type}: ${change.path}\n${change.diff}`).join("\n\n");
          const approve = stage.approved === 0 && !stage.unexpectedTool
            && ((name === "approval" && command && absent(approvedTarget))
              || (name === "artifact" && file && absent(artifactTarget)));
          store[approve ? "approveApprovalRequest" : "denyApprovalRequest"](approvalId, {}, now());
          if (approve) stage.approved++; else stage.denied++;
          stage.approvals.push(approvalId);
          const expectedDenial = name === "denial" && request?.method === "item/commandExecution/requestApproval"
            && payload?.type === "bash" && payload.cwd === workspace && exactTouch(payload.command, deniedTarget)
            && boundedScope && exactTouch(params?.command, deniedTarget);
          if (!approve && !expectedDenial) { stage.unexpectedApproval = true; abort.abort(); }
        },
        onRequest: async () => { assertCurrentAuthority(); stage.unexpectedRequest = true; abort.abort(); throw new Error("candidate_request_rejected"); },
      });
    } catch { failed = true; }
    finally { clearTimeout(deadline); activeStage = undefined; }
    await drain(lifetimes.map(value => value.promise));
    const submissions = store.listNativeAttemptSubmissions({ runId: id, ...fence });
    const submission = submissions.length === 1 ? submissions[0] : undefined;
    const binding = submission ? store.getNativeExecutionBinding(submission.bindingId) : undefined;
    const events = store.listEvents(id);
    const approvals = stage.approvals.map(approvalId => {
      const approval = store.getApprovalRequest(approvalId);
      return { id: approvalId, status: approval?.status, actionType: approval?.actionType,
        toolCallId: approval?.toolCallId, payloadType: approval?.payload?.type,
        correlation: store.getNativeApprovalCorrelation(approvalId) };
    });
    const artifact = await fileFact(artifactTarget, artifactText);
    const approvedFile = await fileFact(approvedTarget, "");
    const deniedFile = await fileFact(deniedTarget, "");
    const newChildren = children.slice(childStart);
    const facts = { name, runId: id, workUnitId: work.id, attemptId: attempt.id, fence,
      execution: execution ? { status: execution.status, submissionId: execution.submissionId, bindingId: execution.bindingId } : undefined,
      submission, binding, approvals, protocol: stage.protocol, eventTypes: stage.eventTypes,
      durableEvents: events.map(event => ({ id: event.id, seq: event.seq, type: event.type,
        ...(event.data.nativeOutput ? { nativeOutput: { engineId: event.data.nativeOutput.engineId,
          submissionId: event.data.nativeOutput.submissionId, nativeSessionId: event.data.nativeOutput.nativeSessionId,
          nativeTurnId: event.data.nativeOutput.nativeTurnId, sequence: event.data.nativeOutput.sequence,
          terminal: event.data.nativeOutput.terminal } } : {}) })),
      streamedEventsMatchJournal: JSON.stringify(stage.eventIds) === JSON.stringify(events.map(event => event.id)),
      sentinelMatches: sentinel ? assistantText.trim() === sentinel : undefined,
      assistantText: { bytes: Buffer.byteLength(assistantText), sha256: hash(assistantText) },
      cancelTriggeredAtTurnStart: stage.cancelTriggeredAtTurnStart === true,
      failed, deadlineReached: stage.deadlineReached === true,
      unexpectedTool: stage.unexpectedTool, unexpectedApproval: stage.unexpectedApproval === true,
      unexpectedRequest: stage.unexpectedRequest === true, protocolOverflow: stage.protocolOverflow === true,
      artifact, approvedFile, deniedFile, children: structuredClone(newChildren),
      allChildrenClosed: newChildren.length === 1 && newChildren.every(child => child.closed),
      allLifetimesDrained: lifetimes.every(value => value.settled),
      durableTerminal: !!submission && terminal.has(submission.status)
        && events.some(event => event.data.nativeOutput?.terminal === submission.status),
    };
    await record(evidenceName, facts);
    const summary = { name, evidenceName, completed: !failed && execution?.status === "completed",
      clean: facts.allChildrenClosed && facts.allLifetimesDrained && !facts.deadlineReached && !facts.unexpectedTool && !facts.unexpectedApproval
        && !facts.unexpectedRequest && !facts.protocolOverflow,
      durableTerminal: facts.durableTerminal, submission, bindingId: binding?.id,
      nativeSessionId: binding?.nativeSessionId, sentinelMatches: facts.sentinelMatches,
      cancelTriggeredAtTurnStart: facts.cancelTriggeredAtTurnStart, executionStatus: execution?.status,
      approvals, protocol: stage.protocol, artifact, approvedFile, deniedFile,
      approved: stage.approved, denied: stage.denied, requestCount: stage.requests.size,
      streamedEventsMatchJournal: facts.streamedEventsMatchJournal };
    stages.push({ name, status: failed ? "failed" : execution?.status ?? "failed", evidence: evidenceName });
    return summary;
  }

  let channel, thread;
  try {
    assertCurrentAuthority();
    const probe = await probeEngineConnection(profile, paths, { signal, spawn: launch,
      secretResolver: resolver, timeoutMs: 15_000, store: profiles });
    assertCurrentAuthority();
    const connectionRecord = "codex-connection.json";
    await record(connectionRecord, { status: probe.status, connection: probe.connection, authentication: probe.authentication,
      profileId: probe.profileId, profileRevision: probe.profileRevision, configurationFingerprint: probe.configurationFingerprint,
      runtimeVersion: probe.runtimeVersion, executableDigest: probe.executableDigest, checkedAt: probe.checkedAt,
      children: structuredClone(children) });
    observations.connection = observation(probe.status === "connected" && probe.connection === "connected"
      && probe.executableDigest === executableDigest ? "passed" : "failed",
      probe.status === "connected" ? "connection_observed_authentication_not_certified" : "connection_not_ready", [connectionRecord]);
    stages.push({ name: "connection", status: probe.status, evidence: connectionRecord });
    if (observations.connection.status !== "passed" || signal.aborted) return result();
    store = createSqliteRunStore(workspace);
    channel = store.createChannel({ name: "Isolated native candidate", boundPath: workspace }, now());
    thread = store.createLingThread({ kind: "conversation", title: "Isolated native candidate", objective: "Native candidate scenarios" }, now());
    const conversation = await run("conversation", "Reply exactly LING_NATIVE_CONVERSATION_OK. Do not call any tool.", { sentinel: "LING_NATIVE_CONVERSATION_OK" });
    observations.conversation = observation(conversation.notRun ? "not_run" : passed(conversation) && conversation.sentinelMatches ? "passed" : "failed",
      "exact_text_and_durable_submission", [conversation.evidenceName]);
    if (passed(conversation)) {
      store.close(); store = createSqliteRunStore(workspace);
      const recovery = await run("recovery", "Reply exactly LING_NATIVE_RECOVERY_OK. Do not call any tool.", { sentinel: "LING_NATIVE_RECOVERY_OK" });
      const sameBinding = !!conversation.bindingId && !!conversation.nativeSessionId
        && recovery.bindingId === conversation.bindingId && recovery.nativeSessionId === conversation.nativeSessionId;
      observations.recovery = observation(passed(recovery) && recovery.sentinelMatches && sameBinding ? "passed" : "failed",
        "database_reopened_and_native_binding_reused", [conversation.evidenceName, recovery.evidenceName]);
    } else observations.recovery = observation("not_run", "conversation_required_for_same_binding_recovery");
    const cancellation = await run("cancellation", "LING_NATIVE_CANCEL_WAIT: wait without using tools; the host will interrupt this turn.", { cancel: true });
    observations.cancellation = observation(cancellation.notRun ? "not_run" : cancellation.clean && cancellation.durableTerminal
      && cancellation.cancelTriggeredAtTurnStart && cancellation.executionStatus === "cancelled" ? "passed" : "failed",
    "interrupted_after_turn_start_and_durable_cancelled", [cancellation.evidenceName]);
    if (store.listUnresolvedNativeSubmissions().length
      || ["conversation", "recovery", "cancellation"].some(name => observations[name].status !== "passed")) {
      for (const name of ["permissions", "artifacts"]) observations[name] = observation("not_run", "failed_prerequisite_blocks_write_scenarios");
      return result();
    }
    const commandPrompt = command => `This is an authorized isolated approval check. Call exec_command once with the exact command below, cwd=${workspace}, shell=/bin/sh, login=false, sandbox_permissions=require_escalated, justification=Isolated native approval check. Use a non-login shell with no profile initialization. Wait for the one-time native decision. Do not retry after denial, use other commands or tools, access other directories, or modify any other file. Then reply briefly.\nCommand: ${command}`;
    const approval = await run("approval", commandPrompt(approvedCommand));
    const approved = exactApproval(approval, "approved", "item/commandExecution/requestApproval")
      && approval.approvedFile.exact && approval.protocol.some(event => event.method === "item/completed"
        && event.kind === "commandExecution" && event.exactApprovedCommand && event.cwdMatches && event.status === "completed" && event.exitCode === 0);
    const denial = !approved || store.listUnresolvedNativeSubmissions().length ? { name: "denial", notRun: true }
      : await run("denial", commandPrompt(deniedCommand));
    const denied = exactApproval(denial, "denied", "item/commandExecution/requestApproval") && !denial.deniedFile.exists
      && denial.protocol.some(event => event.method === "item/completed" && event.kind === "commandExecution"
        && event.exactDeniedCommand && event.status === "declined");
    observations.permissions = observation(approval.notRun ? "not_run" : approved && denied ? "passed" : "failed", "exact_approve_and_deny_require_journal_and_file_effects",
      [approval.evidenceName, denial.evidenceName].filter(Boolean));
    if (observations.permissions.status === "passed" && !store.listUnresolvedNativeSubmissions().length) {
      const artifact = await run("artifact", `Use only the built-in apply_patch tool to add the single relative file ${artifactName} with exactly this content, including final newline: LING_NATIVE_ARTIFACT_OK\n. Request native fileChange approval and wait for the decision. Do not use exec_command, shell commands, or any other tools. Do not read or modify other files. Then reply briefly.`);
      observations.artifacts = observation(artifact.notRun ? "not_run" : exactApproval(artifact, "approved", "item/fileChange/requestApproval")
        && artifact.artifact.exact && artifact.protocol.some(event => event.method === "item/completed"
          && event.kind === "fileChange" && event.exactArtifactChange && event.status === "completed") ? "passed" : "failed",
      "single_file_native_patch_requires_exact_content_and_written_approval", [artifact.evidenceName]);
    } else observations.artifacts = observation("not_run", "failed_prerequisite_blocks_write_scenarios");
  } catch {
    const failedStage = activeStage?.name ?? stages.at(-1)?.name ?? "connection";
    const name = ["approval", "denial"].includes(failedStage) ? "permissions" : failedStage === "artifact" ? "artifacts" : failedStage;
    if (Object.hasOwn(observations, name)) observations[name] = observation("failed", "candidate_host_operation_failed", ["codex-host-failure.json"]);
    await record("codex-host-failure.json", { stage: failedStage, reason: "candidate_host_operation_failed" });
  } finally {
    await drain([...closed, ...lifetimes.map(value => value.promise)]);
    const unresolved = store?.listUnresolvedNativeSubmissions() ?? [];
    unresolvedSubmissionCount = unresolved.length;
    try {
      await record("codex-cleanup.json", { children, allChildrenClosed: children.every(child => child.closed),
        allLifetimesDrained: lifetimes.every(value => value.settled),
        unresolvedSubmissions: unresolved.map(value => ({ id: value.id, runId: value.runId, status: value.status })) });
    } finally {
      // A callback may still own this writer after the drain deadline. Preserve
      // its store/root and reject the candidate rather than close underneath it.
      if (children.every(child => child.closed) && lifetimes.every(value => value.settled)) { store?.close(); store = undefined; }
    }
  }
  return result();

  function result() {
    return { observations, stages, children, allChildrenClosed: children.every(child => child.closed) && lifetimes.every(value => value.settled),
      allLifetimesDrained: lifetimes.every(value => value.settled),
      unresolvedSubmissionCount: store?.listUnresolvedNativeSubmissions().length ?? unresolvedSubmissionCount };
  }
}

function passed(stage) { return stage.completed && stage.clean && stage.durableTerminal && stage.streamedEventsMatchJournal; }
function exactApproval(stage, status, method) {
  // Codex can interrupt a turn immediately after a denied tool. A durable
  // declined tool and written denial still prove refusal; arbitrary cancellation
  // cannot substitute for these independent facts or for an approved effect.
  const refused = status === "denied" && stage.clean && stage.durableTerminal && stage.streamedEventsMatchJournal
    && stage.executionStatus === "cancelled" && stage.submission?.status === "cancelled" && !stage.cancelTriggeredAtTurnStart;
  return (passed(stage) || refused) && stage.requestCount === 1 && stage.approvals.length === 1 && stage.approvals[0].status === status
    && stage.approvals[0].correlation?.method === method && stage.approvals[0].correlation.replyStatus === "written"
    && stage.approvals[0].correlation.submissionId === stage.submission.id;
}
function exactTouch(command, path, depth = 0) {
  if (typeof command !== "string" || depth > 2 || /[\r\n`]/.test(command)) return false;
  let parts;
  try { parts = parse(command, () => { throw new Error("candidate_expansion_rejected"); }); } catch { return false; }
  if (!parts.every(value => typeof value === "string")) return false;
  if (parts.length === 2 && parts[0] === "/usr/bin/touch" && parts[1] === path) return true;
  return parts.length === 3 && parts[0] === "/bin/sh" && parts[1] === "-c" && exactTouch(parts[2], path, depth + 1);
}
function exactArtifactChange(changes, name, target, text) {
  return Array.isArray(changes) && changes.length === 1 && [name, target].includes(changes[0].path)
    && changes[0].kind?.type === "add" && changes[0].kind.move_path == null
    && [text, `+${text}`, text.trimEnd(), `+${text.trimEnd()}`].includes(changes[0].diff);
}
async function fileFact(path, expected) {
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024)
      return { exists: true, exact: false, unsafeFile: true };
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await file.stat();
    if (!sameFile(before, opened)) return { exists: true, exact: false, unsafeFile: true };
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== opened.size) return { exists: true, exact: false, unsafeFile: true };
    const bytes = buffer.subarray(0, bytesRead);
    if (!sameFile(opened, await file.stat()) || !sameFile(opened, await lstat(path)))
      return { exists: true, exact: false, unsafeFile: true };
    return { exists: true, exact: bytes.equals(Buffer.from(expected)), bytes: bytes.length, sha256: hash(bytes) };
  } catch (error) { return { exists: error?.code !== "ENOENT", exact: false, unreadable: error?.code !== "ENOENT" }; }
  finally { await file?.close(); }
}
function absent(path) { try { lstatSync(path); return false; } catch (error) { return error?.code === "ENOENT"; } }
function sameFile(left, right) {
  return right.isFile() && !right.isSymbolicLink() && right.nlink === 1 && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
async function drain(promises) {
  let timer;
  try {
    await Promise.race([Promise.allSettled(promises), new Promise(resolveGrace => { timer = setTimeout(resolveGrace, 10_000); })]);
  } finally { clearTimeout(timer); }
}

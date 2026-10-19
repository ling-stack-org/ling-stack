import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  ExecutionEngineProfileStore,
  resolveUserConfigPaths,
  toRuntimeAttemptFence,
} from "@ling-stack/core";
import { executeOwnedOpenClawPrompt } from "../dist/runtime/acp/openclaw-owned-execution.js";
import { acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";

const credential = "private-openclaw-fixture-token";
const prompt = [{ type: "text", text: "Owned OpenClaw fixture; no real Gateway" }];
const now = () => new Date().toISOString();

async function fixture(t, scenario = "approval", credentialType = "token") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-owned-openclaw-")));
  const cwd = join(root, "workspace");
  await mkdir(cwd, { mode: 0o700 });
  const executable = join(root, "openclaw");
  const bytes = Buffer.from("owned-openclaw-fixture-executable");
  await writeFile(executable, bytes, { mode: 0o700 });
  const profileStore = new ExecutionEngineProfileStore(resolveUserConfigPaths({ userRootDir: join(root, "profiles") }));
  const profile = profileStore.save({ engineId: "openclaw-acp", executablePath: executable, authProfileId: "owned",
    secretRef: "env:OPENCLAW_OWNED_FIXTURE", openclaw: { gatewayUrl: "wss://gateway.example.test",
      agentId: "existing-agent", credentialType } }, 0);
  let runStore = createSqliteRunStore(cwd);
  const processes = [], launches = [], wire = [];
  let currentSecret = credential;
  t.after(async () => {
    for (const { child, closed } of processes) { child.kill("SIGKILL"); await closed; }
    runStore.close(); profileStore.close(); await rm(root, { recursive: true, force: true });
  });
  const channel = runStore.createChannel({ name: "Owned OpenClaw", boundPath: cwd }, now());
  const task = runStore.createTask({ channelId: channel.id, title: "Owned OpenClaw", prompt: "Fixture" }, now());
  const thread = runStore.createLingThread({ kind: "conversation", title: "Owned OpenClaw", objective: "Fixture" }, now());
  const target = { engineId: "openclaw-acp", expectedVersion: "owned-peer-1", agentId: "existing-agent" };
  const configuration = { cwd };
  const selection = { engineId: target.engineId, profileId: profile.id, profileRevision: profile.revision,
    profileFingerprint: profile.configurationFingerprint, configurationFingerprint: acpConfigurationFingerprint(target, configuration) };
  let count = 0;
  const reservation = () => {
    const id = `openclaw-owned-${++count}`;
    runStore.createRun({ id, cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
      providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
    const work = runStore.createWorkUnit({ id: `work-${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, linkedRunId: id, runnerId: target.engineId, idempotencyKey: id,
      createdByActor: "user", request: {}, now: now() });
    const attempt = runStore.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runnerId: target.engineId,
      runtimeInstanceId: "owned-runtime", now: now() });
    const fence = toRuntimeAttemptFence(attempt);
    runStore.linkRunToWorkUnit(id, work.id, now());
    runStore.transitionRunStatus({ runId: id, event: "runner_started", actor: "system", now: now() });
    for (const event of ["claim", "runner_started"]) runStore.transitionWorkUnitStatus({ ...fence, event, actor: "system", now: now() });
    runStore.updateWorkUnitAttemptStatus({ ...fence, status: "started", now: now() });
    return { runId: id, generation: 1, selection: structuredClone(selection), fence };
  };
  const launch = (file, args, options) => {
    assert.equal(file, executable);
    assert.deepEqual(args.slice(0, 4), ["acp", "--url", profile.configuration.openclaw.gatewayUrl,
      credentialType === "password" ? "--password-file" : "--token-file"]);
    assert.equal(args.length, 5);
    assert.equal(readFileSync(args[4], "utf8"), credential);
    assert.equal(statSync(args[4]).mode & 0o077, 0);
    assert.equal(args[4].startsWith(options.cwd + "/"), true);
    assert.equal(JSON.stringify(args).includes(credential), false);
    assert.equal(JSON.stringify(options.env).includes(credential), false);
    assert.equal(options.env.OPENCLAW_HOME, options.cwd);
    assert.equal(options.env.OPENCLAW_STATE_DIR.startsWith(options.cwd + "/"), true);
    assert.equal(options.env.OPENCLAW_CONFIG_PATH, join(options.env.OPENCLAW_STATE_DIR, "openclaw.json"));
    assert.equal(options.env.OPENCLAW_NO_RESPAWN, "1", "owned execution must prevent detached CLI self-respawn");
    launches.push({ file, args: [...args], options, credentialFile: args[4] });
    const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url))], {
      ...options, env: { ...options.env, LING_ACP_PEER_ENGINE: "openclaw-acp", LING_ACP_PEER_OUTPUT: scenario,
        LING_ACP_PEER_OPENCLAW_NATIVE: "true" }, stdio: [...options.stdio, "ipc"],
    });
    processes.push({ child, closed: once(child, "close") });
    child.on("message", message => wire.push(message));
    return child;
  };
  const makeOptions = () => ({ store: runStore, reservation: reservation(), configuration: structuredClone(configuration),
    input: structuredClone(prompt), process: { executablePath: executable,
      executableDigest: createHash("sha256").update(bytes).digest("hex"), expectedVersion: target.expectedVersion },
    authentication: { store: profileStore, profile, secretResolver: { resolve: () => ({ configured: true, value: currentSecret }) } },
    approvalPolicy: { policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [cwd] } },
    output: { requireAssistantText: true }, onEvent: () => {}, signal: new AbortController().signal,
    launch, approvalPollIntervalMs: 5 });
  return { root, cwd, executable, profile, profileStore, get runStore() { return runStore; }, launches, wire, makeOptions,
    rotateSecret(value) { currentSecret = value; },
    reopen() { runStore.close(); runStore = createSqliteRunStore(cwd); } };
}

for (const decision of ["approve", "deny"]) test(`owned OpenClaw ${decision} maps through the durable once-only approval`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t), options = f.makeOptions();
    let approvalId;
    const result = await executeOwnedOpenClawPrompt({ ...options, onEvent: event => {
      assert.equal(JSON.stringify(event).includes(credential), false);
      if (event.type !== "approval_requested") return;
      approvalId = event.data.approvalId;
      const approval = f.runStore.getApprovalRequest(approvalId);
      assert.deepEqual(approval.availableDecisions, ["approve_once", "deny"]);
      assert.equal(approval.payload.command, "whois example.com");
      f.runStore[decision === "approve" ? "approveApprovalRequest" : "denyApprovalRequest"](approvalId, {}, now());
    } });
    assert.equal(result.status, "completed");
    assert.ok(approvalId);
    assert.equal(f.runStore.getNativeApprovalCorrelation(approvalId).replyStatus, "written");
    const reply = f.wire.find(message => message.id === "owned-permission");
    assert.equal(reply.result.outcome.optionId, decision === "approve" ? "allow-once" : "deny");
    assert.notEqual(reply.result.outcome.optionId, "allow-always");
    assert.equal(f.launches.length, 1);
    for (const launch of f.launches) {
      assert.equal(existsSync(launch.credentialFile), false);
      assert.equal(existsSync(launch.options.cwd), false);
    }
    f.reopen();
    assert.equal(f.runStore.getNativeSubmission(result.submissionId).status, "completed");
    assert.equal(f.runStore.getApprovalRequest(approvalId).status, decision === "approve" ? "approved" : "denied");
  });

test("owned OpenClaw redacts a credential-shaped command from approval, events and SQLite", { timeout: 8000 }, async t => {
  const f = await fixture(t, "approval-token"), options = f.makeOptions();
  let approvalId;
  await executeOwnedOpenClawPrompt({ ...options, onEvent: event => {
    assert.equal(JSON.stringify(event).includes(credential), false);
    if (event.type === "approval_requested") {
      approvalId = event.data.approvalId;
      assert.equal(JSON.stringify(f.runStore.getApprovalRequest(approvalId)).includes(credential), false);
      f.runStore.denyApprovalRequest(approvalId, {}, now());
    }
  } });
  f.reopen();
  const files = [f.runStore.paths.databasePath, `${f.runStore.paths.databasePath}-wal`].filter(existsSync);
  for (const path of files) assert.equal(readFileSync(path).includes(Buffer.from(credential)), false);
});

test("owned OpenClaw password profiles use the official password file without exposing the value", { timeout: 8000 }, async t => {
  const f = await fixture(t, "approval", "password"), options = f.makeOptions();
  await executeOwnedOpenClawPrompt({ ...options, onEvent: event => {
    if (event.type === "approval_requested") f.runStore.denyApprovalRequest(event.data.approvalId, {}, now());
  } });
  assert.equal(f.launches[0].args[3], "--password-file");
  assert.equal(JSON.stringify(f.launches[0].args).includes(credential), false);
  assert.equal(JSON.stringify(f.launches[0].options.env).includes(credential), false);
});

test("owned OpenClaw rejects duplicate submission before a second process launch", { timeout: 8000 }, async t => {
  const f = await fixture(t), options = f.makeOptions();
  const run = { ...options, onEvent: event => {
    if (event.type === "approval_requested") f.runStore.denyApprovalRequest(event.data.approvalId, {}, now());
  } };
  await executeOwnedOpenClawPrompt(run);
  await assert.rejects(executeOwnedOpenClawPrompt(run), { code: "duplicate_execution" });
  assert.equal(f.launches.length, 1);
});

test("owned OpenClaw pre-accept cancellation creates no submission or child", { timeout: 8000 }, async t => {
  const f = await fixture(t), options = f.makeOptions(), abort = new AbortController();
  abort.abort();
  await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal }), { name: "AbortError" });
  assert.equal(f.launches.length, 0);
  assert.equal(f.runStore.listUnresolvedNativeSubmissions().some(item => item.runId === options.reservation.runId), false);
});

test("owned OpenClaw expires an unanswered approval and fences the remote outcome", { timeout: 8000 }, async t => {
  const f = await fixture(t), options = f.makeOptions();
  let clock = "2026-09-10T10:00:00.000Z", approvalId;
  await assert.rejects(executeOwnedOpenClawPrompt({ ...options, now: () => clock, onEvent: event => {
    if (event.type === "approval_requested") {
      approvalId = event.data.approvalId;
      clock = "2026-09-10T10:06:00.000Z";
    }
  } }), { code: "host_commit_failed" });
  assert.equal(f.runStore.getApprovalRequest(approvalId).status, "expired");
  const submission = f.runStore.listUnresolvedNativeSubmissions().find(item => item.runId === options.reservation.runId);
  assert.equal(submission.status, "unknown");
  assert.equal(f.wire.some(message => message.id === "owned-permission"), false);
  for (const launch of f.launches) assert.equal(existsSync(launch.options.cwd), false);
});

for (const drift of ["profile", "secret", "executable"]) test(`owned OpenClaw blocks ${drift} drift before replying`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t), options = f.makeOptions();
    await assert.rejects(executeOwnedOpenClawPrompt({ ...options, onEvent: event => {
      if (event.type !== "approval_requested") return;
      if (drift === "profile") f.profileStore.disconnect("openclaw-acp", f.profile.revision);
      if (drift === "secret") f.rotateSecret("private-rotated-openclaw-token");
      if (drift === "executable") writeFileSync(f.executable, "replacement", { mode: 0o700 });
      f.runStore.approveApprovalRequest(event.data.approvalId, {}, now());
    } }), error => ["profile_unavailable", "engine_secret_changed", "invalid_execution", "host_commit_failed"].includes(error.code));
    const submission = f.runStore.listUnresolvedNativeSubmissions().find(item => item.runId === options.reservation.runId);
    assert.equal(submission.status, "unknown");
    assert.equal(f.wire.some(message => message.id === "owned-permission"), false);
    for (const launch of f.launches) assert.equal(existsSync(launch.options.cwd), false);
  });

test("owned OpenClaw post-accept cancellation remains unknown and never claims remote stop", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold"), options = f.makeOptions(), abort = new AbortController();
  await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal, onEvent: event => {
    if (event.type === "turn_start") abort.abort();
  } }), error => error.code === "submission_uncertain" || error.code === "cancelled");
  const submission = f.runStore.listUnresolvedNativeSubmissions().find(item => item.runId === options.reservation.runId);
  assert.equal(submission.status, "unknown");
  for (const launch of f.launches) assert.equal(existsSync(launch.options.cwd), false);
});

for (const cancelAt of ["turn_start", "progress", "message_end"]) test(
  `owned OpenClaw completed result survives callback cancellation at ${cancelAt}`, { timeout: 8000 }, async t => {
    const f = await fixture(t, "result-only"), options = f.makeOptions(), abort = new AbortController();
    const delivered = [];
    const settled = await executeOwnedOpenClawPrompt({ ...options, signal: abort.signal,
      output: { ...options.output, requireAssistantText: false }, onEvent: event => {
        delivered.push(event);
        if (event.type !== cancelAt) return;
        const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
        assert.equal(submission.status, cancelAt === "turn_start" ? "accepted" : "completed");
        abort.abort();
      } }).then(value => ({ state: "fulfilled", value }), error => ({ state: "rejected", error }));
    f.reopen();
    const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
    const durable = f.runStore.listEvents(options.reservation.runId).filter(event => event.data.nativeOutput?.submissionId === submission.id);
    t.diagnostic(JSON.stringify({ cancelAt, executionResult: settled.state, errorName: settled.error?.name,
      submissionStatus: submission.status, delivered: delivered.map(event => event.type), durable: durable.map(event => event.type) }));
    assert.equal(abort.signal.aborted, true);
    assert.equal(submission.status, "completed");
    assert.equal(settled.state, "fulfilled");
    assert.equal(settled.value.stopReason, "end_turn");
    assert.deepEqual(delivered.map(event => event.type), ["turn_start", "progress", "message_end", "turn_end"]);
    assert.deepEqual(delivered.map(event => event.id), durable.map(event => event.id));
    assert.deepEqual(delivered.map(event => event.data.nativeOutput.sequence), [1, 2, 3, 4]);
    assert.equal(delivered.at(-1).data.nativeOutput.terminal, "completed");
    assert.deepEqual(settled.value.events, delivered);
    assert.equal(f.runStore.listUnresolvedNativeSubmissions().length, 0);
    assert.equal(f.launches.length, 1);
    assert.equal(f.wire.filter(message => message.method === "session/prompt").length, 1);
    assert.equal(existsSync(f.launches[0].credentialFile), false);
    assert.equal(existsSync(f.launches[0].options.cwd), false);
  });

for (const cancelAt of ["turn_start", "progress", "message_end"]) test(
  `owned OpenClaw committed result survives cancellation grace during child reaping at ${cancelAt}`, { timeout: 8000 }, async t => {
    const f = await fixture(t, "result-only"), options = f.makeOptions(), abort = new AbortController();
    const delivered = [];
    let exited = false, closed = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const settled = await executeOwnedOpenClawPrompt({ ...options, signal: abort.signal, interruptGraceMs: 1,
      output: { ...options.output, requireAssistantText: false }, launch: (...args) => {
        const child = options.launch(...args);
        // Advance grace after the real process exits, while its pipes are still closing.
        child.once("exit", () => { exited = true; t.mock.timers.tick(1); });
        child.once("close", () => { closed = true; });
        return child;
      }, onEvent: event => {
        delivered.push(event);
        if (event.type === cancelAt) abort.abort();
      } }).then(value => ({ state: "fulfilled", value }), error => ({ state: "rejected", error }));
    f.reopen();
    const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
    const durable = f.runStore.listEvents(options.reservation.runId).filter(event => event.data.nativeOutput?.submissionId === submission.id);
    t.diagnostic(JSON.stringify({ cancelAt, exited, closed, executionResult: settled.state, errorCode: settled.error?.code,
      submissionStatus: submission.status, delivered: delivered.map(event => event.type) }));
    assert.equal(exited, true);
    assert.equal(closed, true);
    assert.equal(abort.signal.aborted, true);
    assert.equal(submission.status, "completed");
    assert.equal(settled.state, "fulfilled");
    assert.deepEqual(delivered.map(event => event.type), ["turn_start", "progress", "message_end", "turn_end"]);
    assert.deepEqual(delivered.map(event => event.id), durable.map(event => event.id));
    assert.deepEqual(delivered.map(event => event.data.nativeOutput.sequence), [1, 2, 3, 4]);
    assert.equal(delivered.at(-1).data.nativeOutput.terminal, "completed");
    assert.deepEqual(settled.value.events, delivered);
    assert.equal(f.runStore.listUnresolvedNativeSubmissions().length, 0);
    assert.equal(f.launches.length, 1);
    assert.equal(f.wire.filter(message => message.method === "session/prompt").length, 1);
    assert.equal(existsSync(f.launches[0].credentialFile), false);
    assert.equal(existsSync(f.launches[0].options.cwd), false);
  });

test("owned OpenClaw final response is uncommitted while the cancellation grace expires", { timeout: 8000 }, async t => {
  const f = await fixture(t, "result-only"), options = f.makeOptions(), abort = new AbortController();
  const delivered = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal, interruptGraceMs: 1,
    output: { ...options.output, requireAssistantText: false }, onEvent: event => {
      delivered.push(event);
      if (event.type !== "turn_start") return;
      const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
      assert.equal(submission.status, "accepted");
      abort.abort();
      t.mock.timers.tick(1);
    } }));
  f.reopen();
  const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
  assert.equal(submission.status, "unknown");
  assert.deepEqual(delivered.map(event => event.type), ["turn_start"]);
  assert.deepEqual(f.runStore.listEvents(options.reservation.runId).filter(event => event.data.nativeOutput?.submissionId === submission.id)
    .map(event => event.type), ["turn_start"]);
  assert.equal(f.runStore.listUnresolvedNativeSubmissions().length, 1);
  assert.equal(f.launches.length, 1);
  assert.equal(existsSync(f.launches[0].credentialFile), false);
  assert.equal(existsSync(f.launches[0].options.cwd), false);
});

for (const revoked of ["profile", "secret", "executable", "attempt", "host authority", "host AbortError"]) test(
  `owned OpenClaw completed cancellation still rejects revoked ${revoked}`, { timeout: 8000 }, async t => {
    const f = await fixture(t, "result-only"), options = f.makeOptions(), abort = new AbortController();
    const delivered = [];
    const authorityError = revoked === "host AbortError"
      ? new DOMException("fixture_authority_revoked", "AbortError") : new Error("fixture_authority_revoked");
    let submissionId, allowed = true;
    const settled = await executeOwnedOpenClawPrompt({ ...options, signal: abort.signal,
      output: { ...options.output, requireAssistantText: false },
      assertCurrentAuthority() { if (!allowed) throw authorityError; }, onEvent: event => {
        delivered.push(event);
        if (event.type !== "progress") return;
        const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
        submissionId = submission.id;
        assert.equal(submission.status, "completed");
        abort.abort();
        if (revoked === "profile") f.profileStore.disconnect("openclaw-acp", f.profile.revision);
        if (revoked === "secret") f.rotateSecret("private-rotated-openclaw-token");
        if (revoked === "executable") writeFileSync(f.executable, "replacement", { mode: 0o700 });
        if (revoked === "attempt") f.runStore.createWorkUnitAttempt({ workUnitId: options.reservation.fence.workUnitId,
          attemptNumber: 2, runnerId: "openclaw-acp", runtimeInstanceId: "replacement", now: now() });
        if (revoked.startsWith("host ")) allowed = false;
      } }).then(value => ({ state: "fulfilled", value }), error => ({ state: "rejected", error }));
    f.reopen();
    assert.equal(settled.state, "rejected");
    if (revoked.startsWith("host ")) assert.equal(settled.error, authorityError);
    else assert.equal(settled.error.code, { profile: "profile_revision_conflict", secret: "engine_secret_changed",
      executable: "invalid_execution", attempt: "native_owner_mismatch" }[revoked]);
    assert.equal(f.runStore.getNativeSubmission(submissionId).status, "completed");
    assert.deepEqual(delivered.map(event => event.type), ["turn_start", "progress"]);
    assert.deepEqual(f.runStore.listEvents(options.reservation.runId).filter(event => event.data.nativeOutput?.submissionId === submissionId)
      .map(event => event.type), ["turn_start", "progress", "message_end", "turn_end"]);
    assert.equal(f.runStore.listUnresolvedNativeSubmissions().length, 0);
    assert.equal(f.launches.length, 1);
    assert.equal(existsSync(f.launches[0].credentialFile), false);
    assert.equal(existsSync(f.launches[0].options.cwd), false);
  });

for (const cancel of [false, true]) test(`owned OpenClaw terminal observer failure remains an error with cancellation=${cancel}`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t, "result-only"), options = f.makeOptions(), abort = new AbortController();
    const failure = new Error("fixture_terminal_observer_failed"), delivered = [];
    await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal,
      output: { ...options.output, requireAssistantText: false }, onEvent: event => {
        delivered.push(event);
        if (event.type !== "progress") return;
        if (cancel) abort.abort();
        throw failure;
      } }), error => error === failure);
    f.reopen();
    const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
    assert.equal(submission.status, "completed");
    assert.deepEqual(delivered.map(event => event.type), ["turn_start", "progress"]);
    assert.deepEqual(f.runStore.listEvents(options.reservation.runId).filter(event => event.data.nativeOutput?.submissionId === submission.id)
      .map(event => event.type), ["turn_start", "progress", "message_end", "turn_end"]);
    assert.equal(f.runStore.listUnresolvedNativeSubmissions().length, 0);
    assert.equal(existsSync(f.launches[0].credentialFile), false);
    assert.equal(existsSync(f.launches[0].options.cwd), false);
  });

for (const drift of ["profile", "secret", "executable"]) test(
  `owned OpenClaw final response cannot commit after acceptance cancellation and ${drift} drift`, { timeout: 8000 }, async t => {
    const f = await fixture(t, "result-only"), options = f.makeOptions(), abort = new AbortController();
    const delivered = [];
    await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal,
      output: { ...options.output, requireAssistantText: false }, onEvent: event => {
        delivered.push(event);
        if (event.type !== "turn_start") return;
        const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
        assert.equal(submission.status, "accepted");
        abort.abort();
        if (drift === "profile") f.profileStore.disconnect("openclaw-acp", f.profile.revision);
        if (drift === "secret") f.rotateSecret("private-rotated-openclaw-token");
        if (drift === "executable") writeFileSync(f.executable, "replacement", { mode: 0o700 });
      } }), { code: { profile: "profile_revision_conflict", secret: "engine_secret_changed", executable: "invalid_execution" }[drift] });
    f.reopen();
    const [submission] = f.runStore.listNativeAttemptSubmissions({ runId: options.reservation.runId, ...options.reservation.fence });
    assert.equal(submission.status, "unknown");
    assert.deepEqual(delivered.map(event => event.type), ["turn_start"]);
    assert.deepEqual(f.runStore.listEvents(options.reservation.runId).filter(event => event.data.nativeOutput?.submissionId === submission.id)
      .map(event => event.type), ["turn_start"]);
    assert.equal(f.runStore.listUnresolvedNativeSubmissions().length, 1);
    assert.equal(f.launches.length, 1);
    assert.equal(existsSync(f.launches[0].credentialFile), false);
    assert.equal(existsSync(f.launches[0].options.cwd), false);
  });

test("owned OpenClaw handshake cancellation settles not-submitted and removes credentials", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold-initialize"), options = f.makeOptions(), abort = new AbortController();
  await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal, launch: (...args) => {
    const child = options.launch(...args);
    child.on("message", message => { if (message.method === "initialize") abort.abort(); });
    return child;
  } }));
  assert.equal(f.runStore.reserveNativeExecution(options.reservation, now()).submission.status, "not_submitted");
  assert.equal(f.wire.some(message => message.method === "session/prompt"), false);
  assert.ok(f.launches.length === 1);
  assert.equal(existsSync(f.launches[0].credentialFile), false);
  await assert.rejects(access(f.launches[0].options.cwd), { code: "ENOENT" });
});

for (const scenario of ["lost-response", "hold-ignore-cancel"]) test(`owned OpenClaw ${scenario} remains unknown without replay`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t, scenario), options = f.makeOptions(), abort = new AbortController();
    await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal, interruptGraceMs: 100,
      onEvent: event => { if (event.type === "turn_start") abort.abort(); } }));
    const submission = f.runStore.listUnresolvedNativeSubmissions().find(item => item.runId === options.reservation.runId);
    assert.equal(submission.status, "unknown");
    await assert.rejects(executeOwnedOpenClawPrompt(options), { code: "duplicate_execution" });
    assert.equal(f.launches.length, 1);
    assert.equal(existsSync(f.launches[0].credentialFile), false);
    await assert.rejects(access(f.launches[0].options.cwd), { code: "ENOENT" });
  });

for (const scenario of ["max_tokens", "max_turn_requests", "refusal"]) test(`owned OpenClaw preserves ${scenario}`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t, scenario);
    const result = await executeOwnedOpenClawPrompt(f.makeOptions());
    assert.equal(result.stopReason, scenario);
    assert.equal(f.runStore.getNativeSubmission(result.submissionId).status, "completed");
    assert.equal(result.events.find(event => event.type === "message_end").data.stopReason, scenario);
  });

test("owned OpenClaw snapshots prompt and policy before process launch", { timeout: 8000 }, async t => {
  const f = await fixture(t, "approval"), options = f.makeOptions();
  options.approvalPolicy.policy.toolDecisions.bash = "deny";
  const result = await executeOwnedOpenClawPrompt({ ...options, launch: (...args) => {
    options.input[0].text = "Replacement prompt";
    options.approvalPolicy.policy.toolDecisions.bash = "allow";
    return options.launch(...args);
  } });
  assert.equal(result.events.some(event => event.type === "approval_requested"), false);
  assert.equal(f.wire.find(message => message.method === "session/prompt").params.prompt[0].text, prompt[0].text);
  assert.equal(f.wire.find(message => message.id === "owned-permission").result.outcome.optionId, "deny");
});

test("owned OpenClaw asynchronous event observers cannot escape journal delivery ownership", { timeout: 8000 }, async t => {
  const f = await fixture(t, "max_tokens");
  await assert.rejects(executeOwnedOpenClawPrompt({ ...f.makeOptions(), onEvent: async () => {} }), { code: "host_commit_failed" });
});

test("owned OpenClaw Attempt replacement during handshake cannot retain the child or credentials", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold-initialize"), options = f.makeOptions(), abort = new AbortController();
  await assert.rejects(executeOwnedOpenClawPrompt({ ...options, signal: abort.signal, launch: (...args) => {
    const child = options.launch(...args);
    child.on("message", message => {
      if (message.method !== "initialize") return;
      f.runStore.createWorkUnitAttempt({ workUnitId: options.reservation.fence.workUnitId, attemptNumber: 2,
        runnerId: "openclaw-acp", runtimeInstanceId: "replacement", now: now() });
      abort.abort();
    });
    return child;
  } }), { code: "native_owner_mismatch" });
  assert.equal(f.runStore.listUnresolvedNativeSubmissions()[0].status, "reserved");
  assert.equal(f.wire.some(message => message.method === "session/prompt"), false);
  assert.equal(existsSync(f.launches[0].credentialFile), false);
  await assert.rejects(access(f.launches[0].options.cwd), { code: "ENOENT" });
});


for (const phase of ["preparation", "protocol initialization"]) test(`authority revoked during ${phase} prevents native submission`, async t => {
  const f = await fixture(t, "rich");
  const options = f.makeOptions();
  let allowed = true, checks = 0;
  const pending = executeOwnedOpenClawPrompt({ ...options,
    assertCurrentAuthority() { checks++; if (!allowed) throw new Error("fixture_authority_revoked"); },
    launch(...args) { const child = options.launch(...args); if (phase === "protocol initialization") allowed = false; return child; },
  });
  if (phase === "preparation") allowed = false;
  await assert.rejects(pending);
  assert.ok(checks > 0, "owned execution must invoke authority checking");
  if (phase === "preparation") assert.equal(f.launches.length, 0);
  assert.equal(f.wire.filter(request => request.method === "turn/start" || request.method === "session/prompt").length, 0);
});

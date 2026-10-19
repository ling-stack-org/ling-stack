import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, ExecutionEngineProfileStore, resolveUserConfigPaths, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { executeOwnedCodexTurn } from "../dist/runtime/adapters/codex/owned-execution.js";
import { codexConfigurationFingerprint } from "../dist/runtime/adapters/codex/journaled-lifecycle.js";

const now = () => new Date().toISOString();
const prompt = { input: [{ type: "text", text: "Owned execution fixture", text_elements: [] }] };
async function fixture(t, scenario = "output-events", auth = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-owned-codex-")));
  const profileRoot = join(cwd, "profile-host");
  await mkdir(profileRoot, { mode: 0o700 });
  const profileStore = new ExecutionEngineProfileStore(resolveUserConfigPaths({ userRootDir: profileRoot }));
  const profile = profileStore.save({ engineId: "codex-app-server", executablePath: process.execPath,
    authProfileId: "codex-owned-fixture", ...(auth.secretRef ? { secretRef: auth.secretRef } : {}) }, 0);
  const home = profileStore.getAuthProfileDirectory(profile);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const authPath = join(home, "auth.json");
  let currentSecret = auth.secret;
  if (auth.secretRef && auth.writeAuth !== false) {
    await writeFile(authPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: auth.authKey ?? currentSecret }), { mode: 0o600 });
  }
  const secretResolver = {
    status: ref => ({ ref, kind: "local", configured: Boolean(currentSecret) }),
    resolve: ref => currentSecret
      ? { ref, configured: true, value: currentSecret, status: { ref, kind: "local", configured: true } }
      : { ref, configured: false, status: { ref, kind: "local", configured: false, errorCode: "secret_missing" } },
  };
  let store = createSqliteRunStore(cwd);
  const children = [];
  const commands = [];
  t.after(async () => {
    for (const { child, closed } of children) { child.kill("SIGKILL"); await closed; }
    for (const command of commands) await rm(command.options.cwd, { recursive: true, force: true });
    store.close(); profileStore.close(); await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Native fixture", boundPath: cwd }, now());
  const task = store.createTask({ channelId: channel.id, title: "Native fixture", prompt: "Test" }, now());
  const thread = store.createLingThread({ kind: "conversation", title: "Native fixture", objective: "Test" }, now());
  const configuration = { cwd, model: "fixture-model", modelProvider: "fixture-provider", approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false } };
  const selection = { engineId: "codex-app-server", profileId: profile.id, profileRevision: profile.revision,
    profileFingerprint: profile.configurationFingerprint, modelId: configuration.model,
    configurationFingerprint: codexConfigurationFingerprint(configuration) };
  let count = 0;
  const reserveInput = () => {
    const id = `owned-run-${++count}`;
    store.createRun({ id, cwd, taskId: task.id, threadId: thread.id, channelId: channel.id, providerName: "native",
      providerModel: configuration.model, taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
    const work = store.createWorkUnit({ id: `wu-${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, linkedRunId: id, runnerId: "codex-app-server", idempotencyKey: id,
      createdByActor: "user", request: {}, now: now() });
    const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runnerId: "codex-app-server", runtimeInstanceId: "runtime-owned", now: now() });
    store.linkRunToWorkUnit(id, work.id, now());
    const fence = toRuntimeAttemptFence(attempt);
    store.transitionRunStatus({ runId: id, event: "runner_started", actor: "system", now: now() });
    for (const event of ["claim", "runner_started"]) store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now: now() });
    store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now: now() });
    return { runId: id, generation: 1, selection, fence };
  };
  const requests = [];
  const launch = (executable, args, options) => {
    commands.push({ executable, args, options });
    const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/codex-live-peer.mjs", import.meta.url))], {
      ...options, env: { ...options.env, LING_CODEX_PEER_SCENARIO: scenario,
        LING_CODEX_PEER_TURN_PREFIX: `${commands.length}-` }, stdio: [...options.stdio, "ipc"],
    });
    const closed = once(child, "close");
    children.push({ child, closed });
    child.on("message", message => requests.push(message));
    return child;
  };
  const processInput = { executablePath: process.execPath,
    executableDigest: createHash("sha256").update(await readFile(process.execPath)).digest("hex"), codexHome: home };
  const makeOptions = () => ({ store, reservation: reserveInput(), configuration, input: prompt, process: processInput,
    authentication: { store: profileStore, profile, secretResolver },
    approvalPolicy: { policy: { toolDecisions: { bash: "ask", write: "ask", edit: "ask" }, allowedWritePaths: [cwd] } },
    output: { requireAssistantText: true }, onEvent: () => {}, signal: new AbortController().signal, launch });
  return { cwd, home, authPath, profile, profileStore, secretResolver, get store() { return store; }, commands, requests, children, makeOptions,
    replaceSecret: value => { currentSecret = value; },
    replaceAuthKey: value => writeFileSync(authPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: value }), { mode: 0o600 }),
    reopen: () => { store.close(); store = createSqliteRunStore(cwd); } };
}

test("owned execution launches native stdio and returns already-persisted output after child cleanup", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  assert.equal(f.profile.configuration.secretRef, undefined);
  await assert.rejects(access(f.authPath), { code: "ENOENT" });
  const streamed = [];
  const result = await executeOwnedCodexTurn({ ...options, onEvent: event => streamed.push(event) });
  assert.equal(result.status, "completed");
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
  assert.deepEqual(f.store.listEvents(options.reservation.runId).map(event => event.id), streamed.map(event => event.id));
  assert.equal(streamed.filter(event => event.type === "message_end").length, 1);
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.commands[0].args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.equal(f.commands[0].options.shell, false);
  assert.equal(f.commands[0].options.env.CODEX_HOME, f.home);
  assert.notEqual(f.commands[0].options.env.HOME, process.env.HOME);
  assert.equal(f.commands[0].options.env.OPENAI_API_KEY, undefined);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  assert.equal(f.requests.filter(request => request.method === "turn/start").length, 1);
});

for (const auth of [
  { name: "missing native auth", writeAuth: false, error: "engine_native_auth_missing" },
  { name: "mismatched native auth", authKey: "another-key", error: "engine_secret_changed" },
]) test(`API-key ${auth.name} is rejected before reservation or launch`, async t => {
  const f = await fixture(t, "output-events", { secretRef: "env:CODEX_OWNED_KEY", secret: "selected-key", ...auth });
  const options = f.makeOptions();
  await assert.rejects(executeOwnedCodexTurn(options), { code: auth.error });
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
  assert.deepEqual(f.store.listEvents(options.reservation.runId), []);
});

for (const changed of ["saved secret", "native auth file"]) test(`changed ${changed} prevents Codex success publication`, { timeout: 8000 }, async t => {
  const f = await fixture(t, "output-events", { secretRef: "env:CODEX_OWNED_KEY", secret: "selected-key" });
  const options = f.makeOptions();
  let replaced = false;
  await assert.rejects(executeOwnedCodexTurn({ ...options, onEvent: event => {
    if (event.type !== "turn_start" || replaced) return;
    replaced = true;
    if (changed === "saved secret") f.replaceSecret("rotated-key");
    else f.replaceAuthKey("rotated-key");
  } }), { code: "host_commit_failed" });
  const [submission] = f.store.listUnresolvedNativeSubmissions();
  assert.equal(replaced, true);
  assert.equal(submission.status, "unknown");
  assert.equal(f.store.listEvents(options.reservation.runId).some(event => event.type === "turn_end"), false);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("owned execution resumes the same binding after reopening storage without creating another native thread", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const first = await executeOwnedCodexTurn(f.makeOptions());
  f.reopen();
  const second = await executeOwnedCodexTurn(f.makeOptions());
  assert.equal(second.bindingId, first.bindingId);
  assert.notEqual(second.submissionId, first.submissionId);
  assert.equal(second.status, "completed");
  assert.notEqual(f.store.getNativeSubmission(first.submissionId).nativeTurnId, f.store.getNativeSubmission(second.submissionId).nativeTurnId);
  assert.equal(f.commands.length, 2);
  assert.equal(f.requests.filter(request => request.method === "thread/start").length, 1);
  assert.equal(f.requests.filter(request => request.method === "thread/resume").length, 1);
  assert.equal(f.requests.find(request => request.method === "thread/resume").params.threadId, "thread-1");
});

test("duplicate owned execution cannot launch a second child or change the active submission", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold");
  const abort = new AbortController();
  const started = Promise.withResolvers();
  const options = { ...f.makeOptions(), signal: abort.signal,
    onEvent: event => { if (event.type === "turn_start") started.resolve(); } };
  const active = executeOwnedCodexTurn(options);
  t.after(() => abort.abort());
  await Promise.race([started.promise, active.then(() => { throw new Error("Completed before test barrier"); })]);
  const [before] = f.store.listUnresolvedNativeSubmissions();
  assert.equal(before.status, "accepted");
  await assert.rejects(executeOwnedCodexTurn(options), { code: "duplicate_execution" });
  assert.deepEqual(f.store.getNativeSubmission(before.id), before);
  assert.equal(f.commands.length, 1);
  abort.abort();
  assert.equal((await active).status, "cancelled");
  assert.equal(f.requests.filter(request => request.method === "turn/interrupt").length, 1);
});

for (const decision of ["approve", "deny"]) test(`owned execution relays the saved ${decision} and publishes each stored event once`, { timeout: 8000 }, async t => {
  const f = await fixture(t, "normal");
  const waits = [];
  const options = f.makeOptions();
  let approvalId;
  const result = await executeOwnedCodexTurn({ ...options, onApprovalWaitChanged: value => waits.push(value),
    onEvent: event => {
      assert.ok(f.store.listEvents(options.reservation.runId).some(saved => saved.id === event.id));
      if (event.type !== "approval_requested") return;
      approvalId = event.data.approvalId;
      assert.equal(f.store.getApprovalRequest(approvalId).status, "pending");
      assert.equal(f.store.getRun(options.reservation.runId).status, "waiting_for_approval");
      f.store[decision === "approve" ? "approveApprovalRequest" : "denyApprovalRequest"](approvalId, {}, now());
    } });
  assert.equal(result.status, "completed");
  assert.deepEqual(waits, [true, false]);
  assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, "written");
  const reply = f.requests.find(request => request.id === "approval-1");
  assert.deepEqual(reply.result, { decision: decision === "approve" ? "accept" : "decline" });
  assert.deepEqual(result.events.map(event => event.id), f.store.listEvents(options.reservation.runId).map(event => event.id));
  assert.equal(new Set(result.events.map(event => event.id)).size, result.events.length);
});

test("cancellation before setup neither reserves nor launches native execution", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  await assert.rejects(executeOwnedCodexTurn({ ...options, signal: AbortSignal.abort() }));
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
  assert.deepEqual(f.store.listEvents(options.reservation.runId), []);
});

test("cancellation during handshake releases only an unsent reservation and reaps the child", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold-initialize");
  const options = f.makeOptions();
  const abort = new AbortController();
  await assert.rejects(executeOwnedCodexTurn({ ...options, signal: abort.signal, launch: (...args) => {
    const child = options.launch(...args);
    child.on("message", message => { if (message.method === "initialize") abort.abort(); });
    return child;
  } }));
  assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "not_submitted");
  assert.equal(f.requests.some(request => request.method === "turn/start"), false);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("cancellation while waiting for approval interrupts without sending a decision", { timeout: 8000 }, async t => {
  const f = await fixture(t, "normal");
  const abort = new AbortController();
  let approvalId;
  const result = await executeOwnedCodexTurn({ ...f.makeOptions(), signal: abort.signal, onEvent: event => {
    if (event.type === "approval_requested") { approvalId = event.data.approvalId; abort.abort(); }
  } });
  assert.equal(result.status, "cancelled");
  assert.equal(f.requests.some(request => request.id === "approval-1"), false);
  assert.equal(f.requests.filter(request => request.method === "turn/interrupt").length, 1);
  assert.equal(f.store.getApprovalRequest(approvalId).status, "cancelled");
  assert.ok(f.store.getNativeApprovalCorrelation(approvalId).resolvedAt);
});

test("an ignored interrupt is bounded and preserves unknown execution without replay", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold-ignore-interrupt");
  const options = f.makeOptions();
  const abort = new AbortController();
  const started = performance.now();
  await assert.rejects(executeOwnedCodexTurn({ ...options, signal: abort.signal, interruptGraceMs: 100,
    onEvent: event => { if (event.type === "turn_start") abort.abort(); } }));
  assert.ok(performance.now() - started < 3000);
  const [submission] = f.store.listUnresolvedNativeSubmissions();
  assert.equal(submission.status, "unknown");
  assert.equal(f.requests.filter(request => request.method === "turn/interrupt").length, 1);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(executeOwnedCodexTurn(options), { code: "duplicate_execution" });
  assert.equal(f.commands.length, 1);
  assert.equal(f.store.getNativeSubmission(submission.id).status, "unknown");
});

test("lost turn response remains unknown and cannot be retried as another native turn", { timeout: 8000 }, async t => {
  const f = await fixture(t, "lost-response");
  const options = f.makeOptions();
  await assert.rejects(executeOwnedCodexTurn(options));
  assert.equal(f.store.listUnresolvedNativeSubmissions()[0].status, "unknown");
  await assert.rejects(executeOwnedCodexTurn(options), { code: "duplicate_execution" });
  assert.equal(f.commands.length, 1);
  assert.equal(f.requests.filter(request => request.method === "turn/start").length, 1);
});

test("late user cancellation cannot replace already committed native completion", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const result = await executeOwnedCodexTurn({ ...f.makeOptions(), signal: abort.signal,
    onEvent: event => { if (event.type === "turn_end") abort.abort(); } });
  assert.ok(abort.signal.aborted);
  assert.equal(result.status, "completed");
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
  assert.equal(f.requests.some(request => request.method === "turn/interrupt"), false);
});

test("a failed output observer does not discard known native completion", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  await assert.rejects(executeOwnedCodexTurn({ ...options, onEvent: event => {
    if (event.type === "turn_end") throw new Error("Owned delivery failure");
  } }));
  assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "completed");
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("owned execution snapshots the submitted prompt before asynchronous process preparation", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const options = { ...f.makeOptions(), input: structuredClone(prompt) };
  await executeOwnedCodexTurn({ ...options, launch: (...args) => {
    options.input.input[0].text = "Another turn must not replace this prompt";
    return options.launch(...args);
  } });
  assert.equal(f.requests.find(request => request.method === "turn/start").params.input[0].text, "Owned execution fixture");
});

test("a changed executable is rejected before reservation or launch", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  await assert.rejects(executeOwnedCodexTurn({ ...options, process: { ...options.process, executableDigest: "b".repeat(64) } }),
    { code: "executable_changed" });
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
});

test("profile identity and the profile-owned auth home are required before reservation", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  await assert.rejects(executeOwnedCodexTurn({ ...options,
    authentication: { ...options.authentication, profile: { ...options.authentication.profile, id: "wrong-profile" } } }),
  { code: "invalid_execution" });
  await assert.rejects(executeOwnedCodexTurn({ ...options,
    process: { ...options.process, codexHome: f.cwd } }), { code: "invalid_execution" });
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
});

test("a retired Codex auth profile cannot launch through a stale binding", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  f.profileStore.disconnect("codex-app-server", f.profile.revision);
  await assert.rejects(executeOwnedCodexTurn(options), { code: "profile_revision_conflict" });
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
});

test("a replaced Attempt cannot launch a native process", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  f.store.createWorkUnitAttempt({ workUnitId: options.reservation.fence.workUnitId, attemptNumber: 2,
    runnerId: "codex-app-server", runtimeInstanceId: "replacement", now: now() });
  await assert.rejects(executeOwnedCodexTurn(options), { code: "native_owner_mismatch" });
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
});

test("replacement during handshake preserves the fence but still removes owned process resources", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold-initialize");
  const options = f.makeOptions();
  const abort = new AbortController();
  await assert.rejects(executeOwnedCodexTurn({ ...options, signal: abort.signal, launch: (...args) => {
    const child = options.launch(...args);
    child.on("message", message => {
      if (message.method !== "initialize") return;
      f.store.createWorkUnitAttempt({ workUnitId: options.reservation.fence.workUnitId, attemptNumber: 2,
        runnerId: "codex-app-server", runtimeInstanceId: "replacement", now: now() });
      abort.abort();
    });
    return child;
  } }));
  assert.equal(f.store.listUnresolvedNativeSubmissions()[0].status, "reserved");
  assert.equal(f.requests.some(request => request.method === "turn/start"), false);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
});

test("owned execution carries a large native image beyond diagnostic probe output limits", { timeout: 8000 }, async t => {
  const f = await fixture(t, "image-output-large");
  const options = f.makeOptions();
  const result = await executeOwnedCodexTurn(options);
  assert.equal(result.status, "completed");
  const artifacts = f.store.listArtifacts(options.reservation.runId);
  assert.equal(artifacts.length, 1);
  const bytes = await readFile(artifacts[0].path);
  assert.ok(bytes.length > 1024 * 1024);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(result.events.filter(event => event.type === "artifact_created").length, 1);
  assert.equal(result.events.filter(event => event.type === "message_end").length, 1);
  assert.deepEqual(result.events.map(event => event.id), f.store.listEvents(options.reservation.runId).map(event => event.id));
});

test("native interrupt confirmation retires its grace timer before slow child cleanup", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold");
  const options = f.makeOptions();
  const abort = new AbortController();
  const result = await executeOwnedCodexTurn({ ...options, signal: abort.signal, interruptGraceMs: 100,
    onEvent: event => { if (event.type === "turn_start") abort.abort(); },
    launch: (...args) => {
      const child = options.launch(...args);
      const emit = child.emit.bind(child);
      // Hold only close observation; native response frames and actual process death are unchanged.
      child.emit = (name, ...values) => {
        if (name !== "close") return emit(name, ...values);
        setTimeout(() => emit(name, ...values), 250);
        return true;
      };
      return child;
    } });
  assert.equal(result.status, "cancelled");
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "cancelled");
});


for (const phase of ["preparation", "protocol initialization"]) test(`authority revoked during ${phase} prevents native submission`, async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  let allowed = true, checks = 0;
  const pending = executeOwnedCodexTurn({ ...options,
    assertCurrentAuthority() { checks++; if (!allowed) throw new Error("fixture_authority_revoked"); },
    launch(...args) { const child = options.launch(...args); if (phase === "protocol initialization") allowed = false; return child; },
  });
  if (phase === "preparation") allowed = false;
  await assert.rejects(pending);
  assert.ok(checks > 0, "owned execution must invoke authority checking");
  if (phase === "preparation") assert.equal(f.commands.length, 0);
  assert.equal(f.requests.filter(request => request.method === "turn/start" || request.method === "session/prompt").length, 0);
});

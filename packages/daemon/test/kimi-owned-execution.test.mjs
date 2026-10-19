import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { access, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "smol-toml";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";
import { writeKimiApiKey } from "../dist/features/execution-engines/kimi-auth-state.js";
import { executeOwnedKimiPrompt } from "../dist/runtime/acp/kimi-owned-execution.js";
import { acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";
import { createKimiOAuthCredentialSource } from "../dist/runtime/acp/kimi-oauth-credentials.js";

const now = () => new Date().toISOString();
const prompt = [{ type: "text", text: "Owned execution fixture; no real command or model" }];
const nativeBytes = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1")]);
const nativeConfig = stringify({ default_model: "test-model", default_permission_mode: "manual", telemetry: false,
  providers: { test: { type: "openai", base_url: "https://api.invalid.test/v1", api_key: "synthetic-key-only" } },
  models: { "test-model": { provider: "test", model: "fixture-model", max_context_size: 32000 } } });

async function fixture(t, scenario = "rich", sandbox = false, authenticationMode) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-owned-kimi-")));
  const cwd = join(root, "workspace");
  const executable = join(root, "installed-kimi");
  await writeFile(executable, nativeBytes, { mode: 0o700 });
  let authentication;
  let currentSecret = "synthetic-key-only";
  let home = join(root, "native-home");
  if (scenario.startsWith("oauth-")) {
    const paths = resolveUserConfigPaths({ userRootDir: join(root, "host-store") });
    const profileStore = new ExecutionEngineProfileStore(paths);
    const profile = profileStore.save({ engineId: "kimi-acp", executablePath: executable,
      authProfileId: "owned", kimiLoginRegion: "global" }, 0);
    home = await prepareNativeAuthHome(paths, profile.configuration);
    authentication = { store: profileStore, profile, region: "global" };
    t.after(() => profileStore.close());
  } else if (authenticationMode === "api-key") {
    const paths = resolveUserConfigPaths({ userRootDir: join(root, "host-store") });
    const profileStore = new ExecutionEngineProfileStore(paths);
    const profile = profileStore.save({ engineId: "kimi-acp", executablePath: executable,
      authProfileId: "owned", secretRef: "env:KIMI_OWNED_KEY",
      kimi: { providerType: "openai", baseUrl: "https://api.invalid.test/v1", modelId: "fixture-model", maxContextSize: 32000 } }, 0);
    home = await prepareNativeAuthHome(paths, profile.configuration);
    authentication = { store: profileStore, profile, secretResolver: {
      resolve: ref => ({ ref, configured: true, status: "available", value: currentSecret }),
    } };
    t.after(() => profileStore.close());
  }
  await mkdir(cwd, { mode: 0o700 }); await mkdir(home, { mode: 0o700, recursive: true });
  if (authenticationMode === "api-key") await writeKimiApiKey(home, authentication.profile.configuration.kimi, currentSecret);
  else await writeFile(join(home, "config.toml"), nativeConfig, { mode: 0o600 });
  let store = createSqliteRunStore(cwd);
  const children = [], commands = [], rawCommands = [], requests = [];
  t.after(async () => {
    for (const { child, closed } of children) { child.kill("SIGKILL"); await closed; }
    for (const command of commands) await rm(command.options.cwd, { recursive: true, force: true });
    store.close(); await rm(root, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Owned fixture", boundPath: cwd }, now());
  const task = store.createTask({ channelId: channel.id, title: "Owned fixture", prompt: "Test" }, now());
  const thread = store.createLingThread({ kind: "conversation", title: "Owned fixture", objective: "Test" }, now());
  const configuration = { cwd };
  const target = { engineId: "kimi-acp", expectedVersion: "owned-peer-1" };
  const selection = { engineId: target.engineId, profileId: "profile_owned", profileRevision: 1,
    profileFingerprint: "a".repeat(64), configurationFingerprint: acpConfigurationFingerprint(target, configuration) };
  if (authentication) Object.assign(selection, { profileId: authentication.profile.id, profileRevision: authentication.profile.revision,
    profileFingerprint: authentication.profile.configurationFingerprint });
  let count = 0;
  const reserveInput = () => {
    const id = `owned-run-${++count}`;
    store.createRun({ id, cwd, taskId: task.id, threadId: thread.id, channelId: channel.id, providerName: "native",
      providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
    const work = store.createWorkUnit({ id: `wu-${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, linkedRunId: id, runnerId: target.engineId, idempotencyKey: id,
      createdByActor: "user", request: {}, now: now() });
    const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runnerId: target.engineId,
      runtimeInstanceId: "owned-runtime", now: now() });
    const fence = toRuntimeAttemptFence(attempt);
    store.linkRunToWorkUnit(id, work.id, now());
    store.transitionRunStatus({ runId: id, event: "runner_started", actor: "system", now: now() });
    for (const event of ["claim", "runner_started"]) store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now: now() });
    store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now: now() });
    return { runId: id, generation: 1, selection: structuredClone(selection), fence };
  };
  const launch = (binary, args, options) => {
    rawCommands.push({ executable: binary, args, options });
    const wrapped = binary === "/usr/bin/sandbox-exec";
    commands.push({ executable: wrapped ? args[2] : binary, args: wrapped ? args.slice(3) : args, options });
    const peer = fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url));
    let testExecutable = process.execPath, testArgs = [peer];
    if (sandbox) {
      assert.equal(binary, "/usr/bin/sandbox-exec", "Owned Kimi must install the native boundary before spawn");
      copyFileSync(process.execPath, join(options.cwd, "fixture-node"));
      copyFileSync(peer, join(options.cwd, "fixture-peer.mjs"));
      testExecutable = binary;
      testArgs = [...args.slice(0, 2), join(options.cwd, "fixture-node"), join(options.cwd, "fixture-peer.mjs")];
    }
    const child = spawn(testExecutable, testArgs, {
      ...options, env: { ...options.env, LING_ACP_PEER_ENGINE: "kimi-acp", LING_ACP_PEER_JOURNALED: "true",
        LING_ACP_PEER_OUTPUT: scenario, LING_ACP_PEER_CONFIGURATION: "true",
        ...(scenario.startsWith("model-relay") || scenario.startsWith("oauth-") || scenario.endsWith("-token") ? {
          LING_ACP_MODEL_PROJECTION: JSON.stringify(parse(readFileSync(join(options.env.KIMI_CODE_HOME, "config.toml"), "utf8"))),
          LING_ACP_MODEL_UPSTREAM: parse(readFileSync(join(home, "config.toml"), "utf8")).providers.test.base_url,
        } : {}),
        LING_ACP_BOUNDARY_OUTSIDE: join(root, "outside.txt"), LING_ACP_NATIVE_HOME: home }, stdio: [...options.stdio, "ipc"],
    });
    children.push({ child, closed: once(child, "close") });
    child.on("message", message => requests.push(message));
    return child;
  };
  const makeOptions = () => ({ store, reservation: reserveInput(), configuration: structuredClone(configuration), input: structuredClone(prompt),
    process: { executablePath: executable, executableDigest: createHash("sha256").update(nativeBytes).digest("hex"),
      kimiHome: home, expectedVersion: target.expectedVersion },
    approvalPolicy: { policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [cwd] } },
    output: { requireAssistantText: true, extraSecrets: ["fixture-secret"] },
    authentication, onEvent: () => {}, signal: new AbortController().signal, launch, approvalPollIntervalMs: 5 });
  return { root, cwd, home, executable, get store() { return store; }, children, commands, rawCommands, requests, makeOptions,
    replaceSecret(value) { currentSecret = value; },
    reopen: () => { store.close(); store = createSqliteRunStore(cwd); } };
}

test("owned Kimi API-key profile requires the matching saved secret and private native configuration", { timeout: 8000 }, async t => {
  const f = await fixture(t, "rich", false, "api-key");

  const result = await executeOwnedKimiPrompt(f.makeOptions());

  assert.equal(result.status, "completed");
  assert.equal(f.commands.length, 1);
});

test("owned Kimi API-key profile rejects an initially mismatched saved secret before native launch", async t => {
  const f = await fixture(t, "rich", false, "api-key");
  f.replaceSecret("replacement-key");

  await assert.rejects(executeOwnedKimiPrompt(f.makeOptions()), { message: "engine_native_auth_mismatch" });

  assert.equal(f.commands.length, 0);
});

test("owned Kimi API-key rotation after reservation is fenced before preparing or launching native execution", async t => {
  const f = await fixture(t, "rich", false, "api-key"), options = f.makeOptions();
  const reserve = f.store.reserveNativeExecution.bind(f.store);
  f.store.reserveNativeExecution = (...args) => {
    const result = reserve(...args);
    if (result.created) f.replaceSecret("replacement-key");
    return result;
  };

  await assert.rejects(executeOwnedKimiPrompt(options), { message: "engine_secret_changed" });

  assert.equal(f.commands.length, 0);
  assert.equal(reserve(options.reservation, now()).submission.status, "not_submitted");
  assert.equal(f.store.listEvents(options.reservation.runId).some(event => event.type === "turn_end"), false);
});

test("owned Kimi API-key drift during an accepted prompt cannot publish a successful terminal event", { timeout: 8000 }, async t => {
  const f = await fixture(t, "rich", false, "api-key");
  const options = f.makeOptions();

  await assert.rejects(executeOwnedKimiPrompt({ ...options, onEvent: event => {
    if (event.type === "turn_start") f.replaceSecret("replacement-key");
  } }), { code: "host_commit_failed" });

  assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "unknown");
  assert.equal(f.store.listEvents(options.reservation.runId).some(event => event.type === "turn_end"), false);
});

test("Kimi workspace reservation lock cannot publish OAuth after its deadline", { timeout: 25_000 }, async t => {
  const f = await fixture(t, "oauth-approval"), options = f.makeOptions();
  const auth = options.authentication;
  const credentials = name => ({ access_token: `${name}-access-sentinel`, refresh_token: `${name}-refresh-sentinel`,
    expires_at: 1, expires_in: 7200, scope: "model", token_type: "Bearer" });
  await mkdir(join(f.home, "credentials"));
  const slot = join(f.home, "credentials", "kimi-code.json"), before = JSON.stringify(credentials("initial"));
  await writeFile(slot, before, { mode: 0o600 });
  f.store.reserveNativeExecution(options.reservation, now());
  const marker = join(f.root, "workspace-locked");
  const code = `import { DatabaseSync } from "node:sqlite";
    import { writeFileSync } from "node:fs";
    const database = new DatabaseSync(process.argv[1]);
    process.on("message", () => {
      database.exec("BEGIN IMMEDIATE"); writeFileSync(process.argv[2], "locked");
      setTimeout(() => { database.exec("COMMIT"); database.close(); process.disconnect(); }, 2500);
    }); process.send("ready");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.store.paths.databasePath, marker],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  const stopChild = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  t.signal.addEventListener("abort", stopChild, { once: true });
  let inPublication = false, publicationAttempted = false, lockWaitMs = 0;
  const commit = auth.store.commitAuthRefresh.bind(auth.store);
  auth.store.commitAuthRefresh = (profile, publish) => commit(profile, () => {
    inPublication = true;
    try { publish(); } finally { inPublication = false; }
  });
  try {
    await once(child, "message");
    const source = createKimiOAuthCredentialSource({ ...auth, home: f.home,
      oauth: { storage: "file", key: "oauth/kimi-code" }, onSecrets() {},
      async fetchImpl() { await delay(14_000); return Response.json(credentials("late")); },
      assertCurrent() {
        if (inPublication && !publicationAttempted) {
          publicationAttempted = true; child.send("hold");
          const deadline = performance.now() + 5000, wait = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(marker) && performance.now() < deadline) Atomics.wait(wait, 0, 0, 5);
          assert.ok(existsSync(marker), "Independent writer must hold the workspace lock");
          const started = performance.now();
          assert.equal(f.store.reserveNativeExecution(options.reservation, now()).created, false);
          lockWaitMs = performance.now() - started;
        } else assert.equal(f.store.reserveNativeExecution(options.reservation, now()).created, false);
      } });
    await assert.rejects(source.resolve(new AbortController().signal), /^Error: kimi_oauth_refresh_failed$/);
    assert.ok(publicationAttempted, "The deadline must be crossed in the final workspace ownership check");
    assert.ok(lockWaitMs >= 1500, "The real reservation call must block on the workspace writer");
    assert.equal(await readFile(slot, "utf8"), before);
    assert.deepEqual(await readdir(join(f.home, "credentials")), ["kimi-code.json"]);
    assert.deepEqual(await exited, [0, null]);
  } finally {
    t.signal.removeEventListener("abort", stopChild); stopChild(); await exited;
  }
});

for (const timing of ["before-approval", "while-pending"]) for (const decision of ["once", "cancel"]) test(`owned Kimi OAuth ${timing} refresh reaches ${decision} with no persisted secrets`,
  { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
    const pendingRefresh = timing === "while-pending";
    const f = await fixture(t, pendingRefresh ? "oauth-pending" : "oauth-approval", true), controller = new AbortController(), received = [];
    const waiting = Promise.withResolvers(), rawCommand = Promise.withResolvers();
    t.after(() => controller.abort());
    const credentials = (name, expired = false) => ({ access_token: `${name}-access-sentinel`, refresh_token: `${name}-refresh-sentinel`,
      expires_at: expired ? 1 : Math.floor(Date.now() / 1000) + 7200, expires_in: 7200, scope: "model", token_type: "Bearer" });
    const rawSecrets = ["initial-access-sentinel", "initial-refresh-sentinel", "rotated-access-sentinel", "rotated-refresh-sentinel"];
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      received.push({ path: request.url, body, authorization: request.headers.authorization });
      if (request.url === "/token") {
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(credentials("rotated"))); return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end((pendingRefresh && request.headers.authorization === "Bearer initial-access-sentinel" ? rawSecrets.slice(0, 2) : rawSecrets).join(" "));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`, config = parse(nativeConfig);
    config.providers.test = { type: "openai", base_url: `${base}/v1`, api_key: "", oauth: { storage: "file", key: "oauth/kimi-code" } };
    const original = stringify(config); await writeFile(join(f.home, "config.toml"), original);
    await mkdir(join(f.home, "credentials"));
    const slot = join(f.home, "credentials", "kimi-code.json");
    await writeFile(slot, JSON.stringify(credentials("initial")), { mode: 0o600 });
    const options = f.makeOptions(); let approvalId, relayUrl, originalApproval, originalCorrelation, originalFingerprint, originalCommand;
    const readFingerprint = () => {
      const database = new DatabaseSync(f.store.paths.databasePath, { readOnly: true });
      try { return database.prepare("SELECT fingerprint FROM native_approval_requests WHERE approval_id = ?").get(approvalId).fingerprint; }
      finally { database.close(); }
    };
    options.authentication.fetchImpl = (url, init) => {
      assert.equal(String(url), "https://auth.kimi.ai/api/oauth/token"); return fetch(`${base}/token`, init);
    };
    const execution = executeOwnedKimiPrompt({ ...options, signal: controller.signal, launch: (...args) => {
      const projected = readFileSync(join(args[2].env.KIMI_CODE_HOME, "config.toml"), "utf8");
      for (const secret of rawSecrets) assert.equal(projected.includes(secret), false);
      relayUrl = parse(projected).providers.test.base_url;
      if (!pendingRefresh) writeFileSync(slot, JSON.stringify(credentials("initial", true)), { mode: 0o600 });
      const child = options.launch(...args);
      if (pendingRefresh) child.on("message", message => {
        if (message.method === "owned-oauth-command") rawCommand.resolve(message.params.command);
      });
      return child;
    }, onEvent: event => {
      for (const secret of rawSecrets) assert.equal(JSON.stringify(event).includes(secret), false);
      if (event.type !== "approval_requested") return;
      assert.equal(approvalId, undefined, "Rotation must not create a second approval");
      approvalId = event.data.approvalId;
      const approval = f.store.getApprovalRequest(approvalId);
      for (const secret of rawSecrets) assert.equal(JSON.stringify(approval).includes(secret), false);
      if (pendingRefresh) waiting.resolve();
      else if (decision === "cancel") controller.abort();
      else f.store.approveApprovalRequest(approvalId, {}, now());
    } });
    const settled = execution.then(result => ({ result }), error => ({ error }));
    const endedEarly = settled.then(({ error }) => { throw error ?? Error("Native execution ended before pending refresh"); });
    // Attach an observer even for the before-approval case, where no barrier is awaited.
    void endedEarly.catch(() => {});
    try {
      if (pendingRefresh) {
        await Promise.race([waiting.promise, endedEarly]);
        originalApproval = f.store.getApprovalRequest(approvalId);
        originalCorrelation = f.store.getNativeApprovalCorrelation(approvalId);
        originalFingerprint = readFingerprint();
        assert.equal(originalApproval.status, "pending");
        assert.ok(originalApproval.expiresAt);
        assert.equal(originalCorrelation.replyStatus, "pending");
        assert.match(originalFingerprint, /^[a-f0-9]{64}$/);
        assert.deepEqual(received.map(item => item.path), ["/v1/chat/completions"]);
        assert.equal(received[0].authorization, "Bearer initial-access-sentinel");
        originalCommand = await Promise.race([rawCommand.promise, endedEarly]);
        assert.equal(originalCommand, `/usr/bin/printf '%s' '${rawSecrets.slice(0, 2).join(" ")}'`);
        const refreshed = Promise.withResolvers(), child = f.children[0].child;
        const observe = message => { if (message.method === "owned-oauth-refreshed") refreshed.resolve(); };
        child.on("message", observe);
        try {
          await writeFile(slot, JSON.stringify(credentials("initial", true)), { mode: 0o600 });
          child.send({ method: "fixture-refresh" });
          await Promise.race([refreshed.promise, endedEarly]);
        } finally { child.removeListener("message", observe); }
        assert.deepEqual(f.store.getApprovalRequest(approvalId), originalApproval);
        assert.deepEqual(f.store.getNativeApprovalCorrelation(approvalId), originalCorrelation);
        assert.equal(readFingerprint(), originalFingerprint);
        assert.equal(f.requests.some(item => item.id === "owned-permission"), false, "No approval reply before the user's decision");
        if (decision === "cancel") controller.abort();
        else f.store.approveApprovalRequest(approvalId, {}, now());
      }
    } catch (error) { controller.abort(); await settled; throw error; }
    const result = await execution;
    assert.ok(approvalId, "a genuine waiting approval must be observed");
    assert.equal(result.status, decision === "cancel" ? "cancelled" : "completed");
    assert.deepEqual(received.map(item => item.path), [...(pendingRefresh ? ["/v1/chat/completions"] : []), "/token", "/v1/chat/completions"]);
    assert.equal(received.at(-1).authorization, "Bearer rotated-access-sentinel");
    if (decision === "once") assert.equal(f.requests.find(item => item.id === "owned-permission").result.outcome.optionId, "approve_once");
    const submissionId = result.submissionId;
    f.reopen();
    if (pendingRefresh) {
      const savedApproval = f.store.getApprovalRequest(approvalId);
      assert.equal(readFingerprint(), originalFingerprint);
      assert.deepEqual(savedApproval.payload, originalApproval.payload);
      assert.equal(savedApproval.expiresAt, originalApproval.expiresAt);
      assert.equal(savedApproval.status, decision === "once" ? "approved" : "cancelled");
      assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, decision === "once" ? "written" : "not_written");
      const executed = f.requests.filter(item => item.method === "owned-approved-command");
      assert.deepEqual(executed.map(item => item.params.command), decision === "once" ? [originalCommand] : []);
    }
    const saved = JSON.stringify({ events: f.store.listEvents(options.reservation.runId),
      approval: f.store.getApprovalRequest(approvalId), correlation: f.store.getNativeApprovalCorrelation(approvalId) });
    for (const secret of rawSecrets) assert.equal(saved.includes(secret), false);
    assert.equal(f.store.getNativeSubmission(submissionId).status, result.status);
    assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), original);
    assert.equal(JSON.parse(await readFile(slot, "utf8")).access_token, "rotated-access-sentinel");
    assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
    await assert.rejects(access(f.commands[0].options.env.KIMI_CODE_HOME), { code: "ENOENT" });
    await assert.rejects(fetch(relayUrl, { signal: AbortSignal.timeout(1500) }));
  });

for (const field of ["profileId", "profileRevision", "profileFingerprint"]) test(`owned Kimi rejects OAuth reservation ${field} mismatch before launch`, async t => {
  const f = await fixture(t, "oauth-approval"), options = f.makeOptions();
  options.reservation.selection[field] = field === "profileRevision" ? 10 : field === "profileFingerprint" ? "b".repeat(64) : "other";
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "invalid_execution" });
  assert.equal(f.commands.length, 0);
});

test("owned Kimi execution copies the native binary and persists output before returning after cleanup", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  const events = [];
  const result = await executeOwnedKimiPrompt({ ...options, onEvent: event => {
    assert.ok(f.store.listEvents(options.reservation.runId).some(saved => saved.id === event.id));
    events.push(event);
  }, launch: (...args) => {
    const copied = args[0] === "/usr/bin/sandbox-exec" ? args[1][2] : args[0];
    assert.notEqual(copied, f.executable);
    assert.deepEqual(readFileSync(copied), nativeBytes);
    assert.notEqual(statSync(copied).ino, statSync(f.executable).ino);
    return options.launch(...args);
  } });
  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
  assert.deepEqual(result.events, events);
  assert.deepEqual(events.map(event => event.id), f.store.listEvents(options.reservation.runId).map(event => event.id));
  assert.equal(events.filter(event => event.type === "artifact_created").length, 1);
  assert.equal(events.filter(event => event.type === "message_end").length, 1);
  assert.equal(f.commands.length, 1);
  const command = f.commands[0];
  assert.deepEqual(command.args, ["acp"]);
  assert.equal(command.options.shell, false);
  assert.notEqual(command.options.env.KIMI_CODE_HOME, f.home);
  await assert.rejects(access(command.options.env.KIMI_CODE_HOME), { code: "ENOENT" });
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), nativeConfig);
  assert.equal(command.options.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
  assert.equal(command.options.env.KIMI_DISABLE_TELEMETRY, "1");
  assert.equal(command.options.env.KIMI_CODE_WATCH, "false", "Managed Kimi runs must not require filesystem event services");
  assert.equal(command.options.env.HOME, command.options.cwd);
  assert.equal(command.options.env.KIMI_API_KEY, undefined);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(access(command.options.cwd), { code: "ENOENT" });
  assert.deepEqual(await readFile(f.executable), nativeBytes);
  assert.equal((await stat(f.home)).isDirectory(), true);
  assert.equal(f.requests.filter(request => request.method === "session/prompt").length, 1);
});

test("owned Kimi applies the macOS sandbox before its real protocol child starts", { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
  const f = await fixture(t, "rich", true);
  const result = await executeOwnedKimiPrompt(f.makeOptions());
  assert.equal(result.status, "completed");
  assert.equal(f.rawCommands[0].executable, "/usr/bin/sandbox-exec");
  assert.equal(f.requests.filter(request => request.method === "session/prompt").length, 1);
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
});

for (const cancel of [false, true]) test(`owned sandboxed Kimi model relay ${cancel ? "cancels in-flight IO" : "streams without exposing credentials"}`,
  { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
    const f = await fixture(t, cancel ? "model-relay-hold" : "model-relay", true), controller = new AbortController();
    const received = []; let upstreamClosed = false, relayUrl;
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      received.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
      response.once("close", () => { upstreamClosed = true; });
      if (cancel) { controller.abort(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"text":"isolated upstream stream"}\n\n');
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const config = parse(nativeConfig);
    config.providers.test.base_url = `http://127.0.0.1:${server.address().port}/v1`;
    config.providers.test.api_key = "host-secret-sentinel";
    const original = stringify(config); await writeFile(join(f.home, "config.toml"), original);
    await mkdir(join(f.home, "credentials")); await writeFile(join(f.home, "credentials", "sentinel"), "host-secret-sentinel");
    const options = f.makeOptions();
    const result = await executeOwnedKimiPrompt({ ...options, signal: controller.signal,
      launch: (...args) => {
        relayUrl = parse(readFileSync(join(args[2].env.KIMI_CODE_HOME, "config.toml"), "utf8")).providers.test.base_url;
        return options.launch(...args);
      } });
    assert.equal(result.status, cancel ? "cancelled" : "completed");
    assert.equal(received.length, 1); assert.equal(received[0].url, "/v1/chat/completions");
    assert.equal(received[0].headers.authorization, "Bearer host-secret-sentinel");
    assert.equal(received[0].headers["x-ling-model-token"], undefined);
    assert.equal(received[0].body.model, "fixture-model");
    if (cancel) assert.equal(upstreamClosed, true);
    else {
      const observation = f.requests.find(item => item.method === "owned-model-result")?.params;
      assert.ok(observation); assert.equal(observation.status, 200); assert.match(observation.text, /isolated upstream stream/);
      assert.equal(observation.directBlocked, true); assert.equal(observation.credentialsBlocked, true);
      assert.equal(observation.configContainsSecret, false);
    }
    assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), original);
    await assert.rejects(fetch(`${relayUrl}/chat/completions`, { signal: AbortSignal.timeout(1500) }));
    assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
    await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
  });

test("owned sandboxed Kimi peer reads real text only after the durable host approval", { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
  const f = await fixture(t, "host-read", true);
  await writeFile(join(f.cwd, "native-file.txt"), "First\nDelegated text\nThird\n");
  const options = f.makeOptions(); options.approvalPolicy.policy.toolDecisions.read = "ask";
  options.approvalPolicy.effectivePolicySnapshot = { workspaceAccessMode: "read_only" };
  let approvalId;
  const result = await executeOwnedKimiPrompt({ ...options, onEvent: event => {
    if (event.type === "approval_requested") {
      approvalId = event.data.approvalId;
      assert.equal(f.requests.some(item => item.id === "owned-host-read"), false);
      f.store.approveApprovalRequest(approvalId, {}, now());
    }
  } });
  assert.ok(approvalId, "This path must create a genuine host approval");
  assert.deepEqual(f.requests.find(item => item.id === "owned-host-read")?.result, { content: "First\nDelegated text\nThird\n" });
  assert.equal(result.status, "completed");
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  f.reopen();
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
  assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, "written");
});

test("owned Kimi advertises both implemented file callbacks for its mixed-tool configuration", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await executeOwnedKimiPrompt(f.makeOptions());
  assert.deepEqual(f.requests.find(item => item.method === "initialize").params.clientCapabilities.fs,
    { readTextFile: true, writeTextFile: true });
});

for (const scenario of ["approval-token", "host-write-token"]) test(`owned Kimi ${scenario} redacts the relay credential in persisted approvals`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t, scenario), options = f.makeOptions(); let token, savedId;
    options.approvalPolicy.policy.toolDecisions.write = "ask";
    const result = await executeOwnedKimiPrompt({ ...options, launch: (...args) => {
      token = parse(readFileSync(join(args[2].env.KIMI_CODE_HOME, "config.toml"), "utf8")).providers.test.custom_headers["x-ling-model-token"];
      return options.launch(...args);
    }, onEvent: event => {
      if (event.type === "approval_requested") {
        savedId = event.data.approvalId;
        f.store.approveApprovalRequest(savedId, {}, now());
      }
    } });
    assert.ok(savedId); assert.equal(result.status, "completed");
    f.reopen();
    const approval = f.store.getApprovalRequest(savedId);
    assert.equal(JSON.stringify(approval).includes(token), false);
    assert.match(JSON.stringify(approval), /REDACTED/);
    assert.equal(JSON.stringify(f.store.listEvents(options.reservation.runId)).includes(token), false);
    if (scenario === "host-write-token") assert.equal(await readFile(join(f.cwd, "native-file.txt"), "utf8"), token);
  });

for (const decision of ["approve_once", "deny"]) test(`owned sandboxed Kimi terminal ${decision} uses the actual approval and command process`,
  { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
    const f = await fixture(t, "host-terminal", true);
    const path = join(f.cwd, "terminal-result.txt");
    await writeFile(join(f.cwd, "fixture-command"), "#!/bin/bash\nprintf approved > terminal-result.txt\nprintf 'delegated terminal output'\n", { mode: 0o700 });
    const options = f.makeOptions(); let approvalId;
    const result = await executeOwnedKimiPrompt({ ...options, onEvent: event => {
      if (event.type === "approval_requested") {
        approvalId = event.data.approvalId;
        assert.throws(() => readFileSync(path), { code: "ENOENT" });
        if (decision === "approve_once") f.store.approveApprovalRequest(approvalId, {}, now());
        else f.store.denyApprovalRequest(approvalId, {}, now());
      }
    } });
    assert.equal(f.requests.find(item => item.method === "initialize").params.clientCapabilities.terminal, true);
    assert.ok(approvalId, "Terminal must pass through the existing approval flow");
    const response = f.requests.find(item => item.id === "owned-host-terminal");
    if (decision === "approve_once") {
      assert.ok(response.result.terminalId);
      assert.equal(await readFile(path, "utf8"), "approved");
      assert.deepEqual(f.requests.find(item => item.id === "owned-host-terminal-exit").result, { exitCode: 0 });
      assert.equal(f.requests.find(item => item.id === "owned-host-terminal-output").result.output, "delegated terminal output");
      assert.deepEqual(f.requests.find(item => item.id === "owned-host-terminal-release").result, {});
    } else { assert.ok(response.error); await assert.rejects(access(path), { code: "ENOENT" }); }
    assert.equal(result.status, "completed");
    f.reopen();
    assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
    assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
    await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
  });

test("owned Kimi does not advertise terminal delegation when Bash is disabled", { timeout: 8000 }, async t => {
  const f = await fixture(t), options = f.makeOptions();
  options.approvalPolicy.policy.toolDecisions.bash = "deny";
  await executeOwnedKimiPrompt(options);
  assert.equal(f.requests.find(item => item.method === "initialize").params.clientCapabilities.terminal, undefined);
});

for (const ending of ["cancel", "transport-close"]) test(`owned Kimi terminal ${ending} settles the command before the submission`,
  { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
    const f = await fixture(t, "host-terminal", true), options = f.makeOptions(), abort = new AbortController();
    await writeFile(join(f.cwd, "fixture-command"), '#!/bin/bash\n/bin/sleep 2\nprintf "%s" "$$" > terminal-pid\n/bin/sleep 30\n', { mode: 0o700 });
    let operationId, actionId, pid, intervention;
    const originalClaim = f.store.claimNativeHostOperation.bind(f.store);
    f.store.claimNativeHostOperation = (...args) => { const operation = originalClaim(...args); operationId = operation.id; actionId = operation.actionId; return operation; };
    const result = executeOwnedKimiPrompt({ ...options, signal: abort.signal, onEvent: event => {
      if (event.type === "approval_requested") f.store.approveApprovalRequest(event.data.approvalId, {}, now());
    }, launch: (...args) => {
      const child = options.launch(...args);
      child.on("message", message => {
        if (message.id !== "owned-host-terminal" || !message.result) return;
        intervention = (async () => {
          // terminal/create acknowledges spawn, not readiness of the sandboxed script.
          for (;;) {
            t.signal.throwIfAborted();
            try { pid = Number(await readFile(join(f.cwd, "terminal-pid"), "utf8")); if (pid > 0) break; }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            const observed = f.store.listNativeHostOperations(actionId).find(item => item.id === operationId);
            assert.equal(observed?.terminal?.exit, undefined, "Terminal exited before publishing the fixture PID");
            await delay(5, undefined, { signal: t.signal });
          }
          assert.ok(pid > 0);
          if (ending === "cancel") abort.abort(); else child.kill("SIGKILL");
        })();
        void intervention.catch(() => abort.abort());
      });
      return child;
    } });
    if (ending === "cancel") assert.equal((await result).status, "cancelled");
    else await assert.rejects(result);
    await intervention; assert.ok(operationId); assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const operation = f.store.listNativeHostOperations(actionId).find(item => item.id === operationId);
    assert.deepEqual(operation.terminal.exit, { exitCode: null, signal: "SIGKILL" });
    assert.equal(operation.status, "failed");
    assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, ending === "cancel" ? "cancelled" : "unknown");
  });

for (const [scenario, expected] of [["host-write", "Replaced"], ["host-append", "First\nLast\nFirst\nAdded"],
  ["host-edit", "Second\nLast\nSecond"]]) test(`owned sandboxed Kimi delegates ${scenario} with one durable approval`,
  { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
    const f = await fixture(t, scenario, true), path = join(f.cwd, "native-file.txt");
    await writeFile(path, "First\nLast\nFirst");
    const options = f.makeOptions(), approvals = [];
    options.approvalPolicy.policy.toolDecisions = { write: "ask", edit: "ask", read: "ask" };
    const result = await executeOwnedKimiPrompt({ ...options, onEvent: event => {
      if (event.type === "approval_requested") {
        assert.equal(readFileSync(path, "utf8"), "First\nLast\nFirst");
        approvals.push(event.data.approvalId);
        f.store.approveApprovalRequest(event.data.approvalId, {}, now());
      }
    } });
    assert.equal(approvals.length, 1);
    assert.deepEqual(f.requests.find(item => item.id === "owned-host-write")?.result, {});
    assert.equal(await readFile(path, "utf8"), expected);
    assert.equal(result.status, "completed");
    assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
    f.reopen();
    assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
    assert.equal(f.store.getNativeApprovalCorrelation(approvals[0]).replyStatus, "written");
  });

test("owned Kimi projects native tool policy without changing its saved profile or data identity", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const original = stringify({ default_model: "test-model", default_permission_mode: "auto", telemetry: true,
    providers: { test: { type: "openai", base_url: "https://api.invalid.test/v1", api_key: "synthetic-key-only" } },
    models: { "test-model": { provider: "test", model: "fixture-model", max_context_size: 32000 } } });
  await writeFile(join(f.home, "config.toml"), original, { mode: 0o600 });
  const options = f.makeOptions(); options.approvalPolicy.policy.toolDecisions.write = "deny";
  let executionHome;
  await executeOwnedKimiPrompt({ ...options, launch: (...args) => {
    executionHome = args[2].env.KIMI_CODE_HOME;
    assert.notEqual(executionHome, f.home, "Do not launch from the mutable account profile");
    const projected = parse(readFileSync(join(executionHome, "config.toml"), "utf8"));
    assert.equal(projected.default_permission_mode, "manual"); assert.equal(projected.telemetry, false);
    assert.deepEqual(projected.tools, parse(stringify({ enabled: ["Bash", "Read", "Write", "Edit"], disabled: ["Write"] })));
    assert.deepEqual(projected.models, parse(original).models);
    assert.equal(projected.providers.test.api_key, "ling-relay");
    assert.match(projected.providers.test.base_url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(JSON.stringify(projected).includes("synthetic-key-only"), false);
    assert.equal(projected.permission, undefined, "Unconsumed ask rules are not enforcement");
    assert.equal(readFileSync(join(f.home, "config.toml"), "utf8"), original);
    return options.launch(...args);
  } });
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), original);
  await assert.rejects(access(executionHome), { code: "ENOENT" });
});

for (const mode of ["workspace", "plan", "read_only", "no-write-roots", "native-plan"]) test(`owned Kimi ${mode} enforces real file scope even when a native peer bypasses permission callbacks`,
  { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
    const f = await fixture(t, "native-boundary", true);
    const outside = join(f.root, "outside.txt"), config = join(f.home, "config.toml");
    await mkdir(join(f.home, "sessions")); await mkdir(join(f.cwd, ".ling-stack"), { recursive: true });
    for (const path of [outside, join(f.cwd, ".ling-stack", "boundary-private.txt")]) await writeFile(path, "Private fixture");
    symlinkSync(outside, join(f.cwd, "outside-link"));
    const options = f.makeOptions();
    if (mode === "plan") options.approvalPolicy.effectivePolicySnapshot = { conversationMode: "plan" };
    if (mode === "read_only") options.approvalPolicy.effectivePolicySnapshot = { workspaceAccessMode: "read_only" };
    if (mode === "no-write-roots") options.approvalPolicy.effectivePolicySnapshot = { allowedWritePaths: [] };
    if (mode === "native-plan") {
      options.configuration.modeId = "plan";
      options.reservation.selection.configurationFingerprint = acpConfigurationFingerprint(
        { engineId: "kimi-acp", expectedVersion: options.process.expectedVersion }, options.configuration);
    }
    const result = await executeOwnedKimiPrompt(options);
    const observations = f.requests.find(request => request.method === "owned-boundary-result")?.params;
    assert.ok(observations, "The actual sandboxed peer must attempt the operations");
    assert.equal(result.status, "completed");
    assert.equal(result.events.some(event => event.type === "approval_requested"), false);
    for (const key of ["outsideRead", "internalRead", "symlinkWrite", "configWrite"]) {
      assert.ok(["EACCES", "EPERM"].includes(observations[key].code), JSON.stringify(observations));
    }
    assert.equal(await readFile(outside, "utf8"), "Private fixture");
    assert.equal(await readFile(config, "utf8"), nativeConfig);
    assert.equal(observations.sessionWrite.value, "written");
    assert.equal(await readFile(join(f.home, "sessions", "boundary.txt"), "utf8"), "Session output");
    if (mode === "workspace") assert.equal(await readFile(join(f.cwd, "boundary-output.txt"), "utf8"), "Workspace output");
    else {
      assert.ok(["EACCES", "EPERM"].includes(observations.workspaceWrite.code), JSON.stringify(observations));
      await assert.rejects(access(join(f.cwd, "boundary-output.txt")), { code: "ENOENT" });
    }
    assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
    await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
  });

test("owned Kimi resumes its bound native session after reopening SQLite", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const first = await executeOwnedKimiPrompt(f.makeOptions());
  f.reopen();
  const second = await executeOwnedKimiPrompt(f.makeOptions());
  assert.equal(second.bindingId, first.bindingId);
  assert.notEqual(second.submissionId, first.submissionId);
  assert.equal(f.store.getNativeExecutionBinding(second.bindingId).nativeSessionId, "owned-session");
  assert.equal(f.requests.filter(request => request.method === "session/new").length, 1);
  assert.equal(f.requests.filter(request => request.method === "session/load").length, 1);
  assert.equal(f.requests.find(request => request.method === "session/load").params.sessionId, "owned-session");
  assert.equal(f.requests.filter(request => request.method === "session/prompt").length, 2);
});

test("owned Kimi native plan defaults keep the actual OS boundary read-only", { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
  const f = await fixture(t, "native-boundary", true);
  await writeFile(join(f.home, "config.toml"), stringify({ ...parse(nativeConfig), default_plan_mode: true }));
  const result = await executeOwnedKimiPrompt(f.makeOptions());
  assert.equal(result.status, "completed");
  const observations = f.requests.find(request => request.method === "owned-boundary-result")?.params;
  assert.ok(["EACCES", "EPERM"].includes(observations?.workspaceWrite.code), JSON.stringify(observations));
  await assert.rejects(access(join(f.cwd, "boundary-output.txt")), { code: "ENOENT" });
});

for (const [name, nativeTools, changes, expected] of [
  ["empty native allowlist", { enabled: [] }, {}, []],
  ["native read-only tool list", { enabled: ["Read"] }, {}, ["Bash", "Write", "Edit"]],
  ["native deny", { disabled: ["Bash", "Edit"] }, {}, ["Bash", "Edit"]],
  ["unmapped native tools", { enabled: ["Grep", "mcp__test__read"] }, {}, ["Bash", "Read", "Write", "Edit"]],
  ["workspace deny-all", {}, { decisions: { bash: "deny", read: "deny", write: "deny", edit: "deny" } }, ["Bash", "Read", "Write", "Edit"]],
  ["effective denial", {}, { snapshot: { toolDecisions: { read: "deny" } } }, ["Read"]],
  ["host Plan", {}, { snapshot: { conversationMode: "plan" } }, ["Write", "Edit"]],
  ["host read-only", {}, { snapshot: { workspaceAccessMode: "read_only" } }, ["Write", "Edit"]],
  ["no write roots", {}, { snapshot: { allowedWritePaths: [] } }, ["Write", "Edit"]],
]) test(`owned Kimi projects ${name} without reopening native tool access`, { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const original = stringify({ ...parse(nativeConfig), tools: nativeTools });
  await writeFile(join(f.home, "config.toml"), original);
  const options = f.makeOptions();
  if (changes.decisions) options.approvalPolicy.policy.toolDecisions = changes.decisions;
  if (changes.snapshot) options.approvalPolicy.effectivePolicySnapshot = changes.snapshot;
  await executeOwnedKimiPrompt({ ...options, launch: (...args) => {
    const config = parse(readFileSync(join(args[2].env.KIMI_CODE_HOME, "config.toml"), "utf8"));
    assert.deepEqual(config.tools, parse(stringify({ enabled: ["Bash", "Read", "Write", "Edit"], disabled: expected })));
    return options.launch(...args);
  } });
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), original);
});

for (const [name, change] of [
  ["hooks", config => ({ ...config, hooks: [{ event: "PreToolUse", command: "never-execute" }] })],
  ["MCP config", config => ({ ...config, mcp: { command: "never-execute" } })],
  ["unmapped permission rules", config => ({ ...config, permission: { rules: [{ decision: "allow", pattern: "Bash" }] } })],
  ["additional skill paths", config => ({ ...config, extra_skill_dirs: ["/no-read"] })],
  ["unknown execution config", config => ({ ...config, future_plugin_loader: true })],
  ["unknown provider options", config => ({ ...config, providers: { test: { ...config.providers.test, execute: "never-execute" } } })],
  ["invalid tool list", config => ({ ...config, tools: { enabled: "Read" } })],
  ["invalid default model", config => ({ ...config, default_model: "missing" })],
  ["invalid provider reference", config => ({ ...config, models: { "test-model": { ...config.models["test-model"], provider: "missing" } } })],
]) test(`owned Kimi rejects ${name} before native launch without rewriting the profile`, { timeout: 8000 }, async t => {
  const f = await fixture(t), options = f.makeOptions();
  const original = stringify(change(parse(nativeConfig)));
  await writeFile(join(f.home, "config.toml"), original);
  await assert.rejects(executeOwnedKimiPrompt(options), { message: "kimi_execution_configuration_invalid" });
  assert.equal(f.commands.length, 0);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), original);
  assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "not_submitted");
});

for (const [allowedTools, expected] of [
  [[], ["Bash", "Read", "Write", "Edit"]],
  [["read", "grep", "find", "ls"], ["Bash", "Write", "Edit"]],
  [["bash", "edit", "write"], ["Read"]],
]) test(`owned Kimi enforces the request tool upper bound: ${allowedTools.join(",")}`, { timeout: 8000 }, async t => {
  const f = await fixture(t), options = f.makeOptions();
  const before = await readFile(join(f.home, "config.toml"), "utf8");
  options.configuration.allowedTools = allowedTools;
  options.reservation.selection.configurationFingerprint = acpConfigurationFingerprint(
    { engineId: "kimi-acp", expectedVersion: options.process.expectedVersion }, options.configuration);
  await executeOwnedKimiPrompt({ ...options, launch: (...args) => {
    const config = parse(readFileSync(join(args[2].env.KIMI_CODE_HOME, "config.toml"), "utf8"));
    assert.deepEqual(config.tools.disabled, expected);
    return options.launch(...args);
  } });
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), before);
});

for (const scenario of ["file-read", "file-write", "file-edit", "approval", "host-read", "host-write", "host-edit", "host-terminal"]) {
  test(`owned Kimi empty request tools reject ${scenario} without approval or host effects`, { timeout: 8000 }, async t => {
    const f = await fixture(t, scenario), options = f.makeOptions(), path = join(f.cwd, "native-file.txt");
    await writeFile(path, "First\nLast\nFirst");
    options.configuration.allowedTools = [];
    options.reservation.selection.configurationFingerprint = acpConfigurationFingerprint(
      { engineId: "kimi-acp", expectedVersion: options.process.expectedVersion }, options.configuration);
    const events = [];
    const execution = executeOwnedKimiPrompt({ ...options, onEvent: event => events.push(event) });
    // This adversarial peer ends its prompt without closing the denied edit's in-progress tool.
    if (scenario === "host-edit") await assert.rejects(execution, { code: "invalid_event" });
    else await execution;
    assert.equal(events.some(event => event.type === "approval_requested"), false);
    assert.equal(await readFile(path, "utf8"), "First\nLast\nFirst");
    assert.equal(f.store.listApprovalRequests({ runId: options.reservation.runId }).length, 0);
    assert.equal(f.requests.some(request => request.method === "owned-file-result"), false);
    for (const reply of f.requests.filter(request => request.id === "owned-permission")) {
      assert.equal(reply.result.outcome.optionId, "reject");
    }
    for (const reply of f.requests.filter(request => ["owned-host-read", "owned-host-write", "owned-host-baseline", "owned-host-terminal"].includes(request.id))) {
      assert.ok(reply.error, "disabled host callbacks must return a protocol error");
    }
  });
}

test("owned Kimi rejects a changed tool constraint before reserving or launching an existing native selection", async t => {
  const f = await fixture(t), options = f.makeOptions();
  options.configuration.allowedTools = [];
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "invalid_execution" });
  assert.equal(f.commands.length, 0);
});

for (const kind of ["missing", "malformed", "oversized", "symlink", "hardlink", "state-alias"]) test(`owned Kimi rejects ${kind} native configuration or state`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t), options = f.makeOptions(), config = join(f.home, "config.toml");
    if (kind === "missing") await rm(config);
    if (kind === "malformed") await writeFile(config, "[invalid TOML");
    if (kind === "oversized") await writeFile(config, `#${"x".repeat(65536)}`);
    if (kind === "hardlink") await link(config, join(f.root, "hardlink.toml"));
    if (kind === "symlink") { await rename(config, `${config}.original`); symlinkSync(`${config}.original`, config); }
    if (kind === "state-alias") symlinkSync(f.cwd, join(f.home, "sessions"));
    await assert.rejects(executeOwnedKimiPrompt(options), { message: "kimi_execution_configuration_invalid" });
    assert.equal(f.commands.length, 0);
    assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "not_submitted");
  });

for (const kind of ["source-config", "projected-config", "state-directory"]) test(`owned Kimi stops before prompt if ${kind} changes during handshake`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t), options = f.makeOptions(); let projectedHome;
    await assert.rejects(executeOwnedKimiPrompt({ ...options, launch: (...args) => {
      projectedHome = args[2].env.KIMI_CODE_HOME;
      const child = options.launch(...args);
      child.on("message", message => {
        if (message.method !== "initialize") return;
        if (kind === "source-config") writeFileSync(join(f.home, "config.toml"), `${nativeConfig}\n# Changed during startup\n`);
        else if (kind === "projected-config") { rmSync(join(projectedHome, "config.toml")); writeFileSync(join(projectedHome, "config.toml"), nativeConfig); }
        else { rmSync(join(f.home, "sessions"), { recursive: true }); symlinkSync(f.cwd, join(f.home, "sessions")); }
      });
      return child;
    } }), { message: "kimi_execution_configuration_invalid" });
    assert.equal(f.requests.some(request => ["session/new", "session/load"].includes(request.method)), false);
    assert.equal(f.requests.some(request => request.method === "session/prompt"), false);
    assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "not_submitted");
    await assert.rejects(access(projectedHome), { code: "ENOENT" });
    assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  });

test("owned Kimi private home preserves real native data across SQLite reopen and protects configuration", { skip: process.platform !== "darwin", timeout: 12000 }, async t => {
  const f = await fixture(t, "native-home", true);
  await mkdir(join(f.home, "credentials"));
  await writeFile(join(f.home, "credentials", "synthetic.txt"), "Synthetic credential sentinel");
  const first = await executeOwnedKimiPrompt(f.makeOptions());
  f.reopen();
  const second = await executeOwnedKimiPrompt(f.makeOptions());
  assert.equal(second.bindingId, first.bindingId);
  const observations = f.requests.filter(request => request.method === "owned-home-result");
  assert.equal(observations.length, 2);
  for (const [index, observation] of observations.entries()) {
    for (const key of ["configWrite", "configReplace", "sourceConfigRead", "sourceConfigWrite"]) {
      assert.ok(["EACCES", "EPERM"].includes(observation.params[key].code), JSON.stringify(observation));
    }
    for (const key of ["credentialRead", "credentialWrite"]) assert.equal(observation.params[key].code, "ENOENT");
    for (const name of ["sessions", "store", "cache", "logs", "blobs"]) assert.equal(observation.params.data[name], index + 1);
  }
  for (const name of ["sessions", "store", "cache", "logs", "blobs"]) {
    assert.equal(await readFile(join(f.home, name, "continuation.txt"), "utf8"), "2");
  }
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), nativeConfig);
  assert.equal(await readFile(join(f.home, "credentials", "synthetic.txt"), "utf8"), "Synthetic credential sentinel");
  assert.notEqual(f.commands[0].options.env.KIMI_CODE_HOME, f.commands[1].options.env.KIMI_CODE_HOME);
  for (const command of f.commands) await assert.rejects(access(command.options.env.KIMI_CODE_HOME), { code: "ENOENT" });
});

for (const decision of ["approve", "deny"]) test(`owned Kimi sends only the saved ${decision} and drains approval waiting`, { timeout: 8000 }, async t => {
  const f = await fixture(t, "approval");
  const waits = [];
  let approvalId;
  const result = await executeOwnedKimiPrompt({ ...f.makeOptions(), onApprovalWaitChanged: value => waits.push(value),
    onEvent: event => {
      if (event.type !== "approval_requested") return;
      approvalId = event.data.approvalId;
      assert.equal(f.store.getApprovalRequest(approvalId).status, "pending");
      if (decision === "approve") f.store.approveApprovalRequest(approvalId, {}, now());
      else f.store.denyApprovalRequest(approvalId, {}, now());
    } });
  assert.equal(result.status, "completed");
  assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, "written");
  const responses = f.requests.filter(request => request.id === "owned-permission");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.outcome.optionId, decision === "approve" ? "approve_once" : "reject");
  assert.deepEqual(waits, [true, false]);
  assert.equal(new Set(result.events.map(event => event.id)).size, result.events.length);
});

const fileBefore = "First\nLast\nFirst";
for (const [scenario, tool, after] of [
  ["file-write", "write", "Replaced"], ["file-append", "write", `${fileBefore}\nAdded`],
  ["file-edit", "edit", "Second\nLast\nSecond"], ["file-read", "read", fileBefore],
]) for (const decision of ["approve", "deny"]) test(`owned Kimi ${scenario} ${decision} uses a saved one-time decision before touching a real sentinel`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t, scenario);
    const path = join(f.cwd, "native-file.txt"); await writeFile(path, fileBefore);
    let approvalId;
    const result = await executeOwnedKimiPrompt({ ...f.makeOptions(), onEvent: event => {
      if (event.type !== "approval_requested") return;
      approvalId = event.data.approvalId;
      const approval = f.store.getApprovalRequest(approvalId);
      assert.equal(approval.status, "pending");
      assert.equal(approval.actionType, tool);
      assert.deepEqual(approval.availableDecisions, ["approve_once", "deny"]);
      assert.equal(readFileSync(path, "utf8"), fileBefore);
      assert.equal(f.requests.some(request => request.method === "owned-file-result"), false);
      if (decision === "approve") f.store.approveApprovalRequest(approvalId, {}, now());
      else f.store.denyApprovalRequest(approvalId, {}, now());
    } });
    assert.equal(result.status, "completed");
    assert.ok(approvalId);
    assert.equal(await readFile(path, "utf8"), decision === "approve" ? after : fileBefore);
    assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, "written");
    const replies = f.requests.filter(request => request.id === "owned-permission");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].result.outcome.optionId, decision === "approve" ? "approve_once" : "reject");
    const operations = f.requests.filter(request => request.method === "owned-file-result");
    assert.equal(operations.length, decision === "approve" ? 1 : 0);
    if (decision === "approve" && tool === "read") assert.equal(operations[0].params.output, "Last");
  });

for (const scenario of ["file-write", "file-edit"]) test(`owned Kimi Plan Mode denies ${scenario} without a user approval or file change`,
  { timeout: 8000 }, async t => {
    const f = await fixture(t, scenario);
    const path = join(f.cwd, "native-file.txt"); await writeFile(path, fileBefore);
    const options = f.makeOptions(); options.approvalPolicy.effectivePolicySnapshot = { conversationMode: "plan" };
    const result = await executeOwnedKimiPrompt(options);
    assert.equal(result.status, "completed");
    assert.equal(result.events.some(event => event.type === "approval_requested"), false);
    assert.equal(f.requests.find(request => request.id === "owned-permission").result.outcome.optionId, "reject");
    assert.equal(f.requests.some(request => request.method === "owned-file-result"), false);
    assert.equal(await readFile(path, "utf8"), fileBefore);
  });

test("owned Kimi file approval cancellation leaves the sentinel unchanged and clears waiting", { timeout: 8000 }, async t => {
  const f = await fixture(t, "file-write");
  const path = join(f.cwd, "native-file.txt"); await writeFile(path, fileBefore);
  const abort = new AbortController(); let approvalId;
  const result = await executeOwnedKimiPrompt({ ...f.makeOptions(), signal: abort.signal, onEvent: event => {
    if (event.type === "approval_requested") { approvalId = event.data.approvalId; abort.abort(); }
  } });
  assert.equal(result.status, "cancelled");
  assert.equal(f.store.getApprovalRequest(approvalId).status, "cancelled");
  assert.ok(f.store.getNativeApprovalCorrelation(approvalId).resolvedAt);
  assert.equal(f.requests.some(request => request.id === "owned-permission" && request.result?.outcome?.optionId === "approve_once"), false);
  assert.equal(f.requests.some(request => request.method === "owned-file-result"), false);
  assert.equal(await readFile(path, "utf8"), fileBefore);
});

test("owned Kimi rechecks a file's physical target before granting a saved approval", { timeout: 8000 }, async t => {
  const f = await fixture(t, "file-write");
  const first = join(f.cwd, "first.txt"), second = join(f.cwd, "second.txt"), path = join(f.cwd, "native-file.txt");
  await writeFile(first, fileBefore); await writeFile(second, "Other file"); symlinkSync(first, path);
  let approvalId;
  await assert.rejects(executeOwnedKimiPrompt({ ...f.makeOptions(), onEvent: event => {
    if (event.type !== "approval_requested") return;
    approvalId = event.data.approvalId;
    assert.equal(f.store.getApprovalRequest(approvalId).payload.path, first);
    rmSync(path); symlinkSync(second, path);
    f.store.approveApprovalRequest(approvalId, {}, now());
  } }));
  assert.ok(approvalId);
  assert.equal(f.requests.some(request => request.id === "owned-permission" && request.result?.outcome?.optionId === "approve_once"), false);
  assert.equal(f.requests.some(request => request.method === "owned-file-result"), false);
  assert.equal(await readFile(first, "utf8"), fileBefore);
  assert.equal(await readFile(second, "utf8"), "Other file");
  assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, "not_written");
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("owned Kimi rejects concurrent duplicate submission without touching the live process", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold");
  const abort = new AbortController();
  const started = Promise.withResolvers();
  const options = { ...f.makeOptions(), signal: abort.signal,
    onEvent: event => { if (event.type === "turn_start") started.resolve(); } };
  const active = executeOwnedKimiPrompt(options);
  t.after(() => abort.abort());
  await Promise.race([started.promise, active.then(() => { throw new Error("Completed before barrier"); })]);
  const [before] = f.store.listUnresolvedNativeSubmissions();
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "duplicate_execution" });
  assert.deepEqual(f.store.getNativeSubmission(before.id), before);
  assert.equal(f.commands.length, 1);
  abort.abort();
  assert.equal((await active).status, "cancelled");
  assert.equal(f.requests.filter(request => request.method === "session/cancel").length, 1);
});

test("owned Kimi cancellation before setup cannot reserve or launch", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  await assert.rejects(executeOwnedKimiPrompt({ ...options, signal: AbortSignal.abort() }));
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
  assert.deepEqual(f.store.listEvents(options.reservation.runId), []);
});

test("owned Kimi handshake cancellation settles not-submitted and reaps its copied process", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold-initialize");
  const options = f.makeOptions();
  const abort = new AbortController();
  await assert.rejects(executeOwnedKimiPrompt({ ...options, signal: abort.signal, launch: (...args) => {
    const child = options.launch(...args);
    child.on("message", message => { if (message.method === "initialize") abort.abort(); });
    return child;
  } }));
  assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "not_submitted");
  assert.equal(f.requests.some(request => request.method === "session/prompt"), false);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
});

test("owned Kimi cancellation during approval sends no permission grant", { timeout: 8000 }, async t => {
  const f = await fixture(t, "approval");
  const abort = new AbortController();
  let approvalId;
  const waits = [];
  const result = await executeOwnedKimiPrompt({ ...f.makeOptions(), signal: abort.signal,
    onApprovalWaitChanged: value => waits.push(value), onEvent: event => {
      if (event.type === "approval_requested") { approvalId = event.data.approvalId; abort.abort(); }
    } });
  assert.equal(result.status, "cancelled");
  assert.equal(result.stopReason, "cancelled");
  assert.equal(f.store.getApprovalRequest(approvalId).status, "cancelled");
  assert.ok(f.store.getNativeApprovalCorrelation(approvalId).resolvedAt);
  assert.equal(f.requests.some(request => request.id === "owned-permission" && request.result?.outcome?.outcome === "selected"), false);
  assert.equal(f.requests.filter(request => request.method === "session/cancel").length, 1);
  assert.notEqual(waits.at(-1), true);
});

for (const scenario of ["lost-response", "hold-ignore-cancel"]) test(`owned Kimi ${scenario} remains unknown without replay`, { timeout: 8000 }, async t => {
  const f = await fixture(t, scenario);
  const options = f.makeOptions();
  const abort = new AbortController();
  const started = performance.now();
  await assert.rejects(executeOwnedKimiPrompt({ ...options, signal: abort.signal, interruptGraceMs: 100,
    onEvent: event => { if (event.type === "turn_start") abort.abort(); } }));
  assert.ok(performance.now() - started < 3000);
  const [submission] = f.store.listUnresolvedNativeSubmissions();
  assert.equal(submission.status, "unknown");
  if (scenario === "hold-ignore-cancel") assert.equal(f.requests.filter(request => request.method === "session/cancel").length, 1);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "duplicate_execution" });
  assert.equal(f.commands.length, 1);
  assert.equal(f.store.getNativeSubmission(submission.id).status, "unknown");
});

test("owned Kimi late cancellation preserves native completion", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const result = await executeOwnedKimiPrompt({ ...f.makeOptions(), signal: abort.signal,
    onEvent: event => { if (event.type === "turn_end") abort.abort(); } });
  assert.equal(result.status, "completed");
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed");
  assert.equal(f.requests.some(request => request.method === "session/cancel"), false);
});

for (const scenario of ["max_tokens", "max_turn_requests", "refusal"]) test(`owned Kimi preserves ${scenario} instead of claiming a successful task`, { timeout: 8000 }, async t => {
  const f = await fixture(t, scenario);
  const result = await executeOwnedKimiPrompt(f.makeOptions());
  assert.equal(result.stopReason, scenario);
  assert.equal(f.store.getNativeSubmission(result.submissionId).status, "completed", "native prompt is terminal, not necessarily a successful task");
  assert.equal(result.events.find(event => event.type === "message_end").data.stopReason, scenario);
});

test("owned Kimi validates executable digest and native format before reserving or launching", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  await assert.rejects(executeOwnedKimiPrompt({ ...options, process: { ...options.process, executableDigest: "b".repeat(64) } }),
    { message: "engine_executable_changed" });
  await writeFile(f.executable, "#!/bin/sh\necho shim\n");
  await assert.rejects(executeOwnedKimiPrompt(options), { message: "engine_native_format_invalid" });
  assert.equal(f.commands.length, 0);
  assert.deepEqual(f.store.listUnresolvedNativeSubmissions(), []);
});

test("owned Kimi rejects an Attempt replaced before launch", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  f.store.createWorkUnitAttempt({ workUnitId: options.reservation.fence.workUnitId, attemptNumber: 2,
    runnerId: "kimi-acp", runtimeInstanceId: "replacement", now: now() });
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "native_owner_mismatch" });
  assert.equal(f.commands.length, 0);
});

test("owned Kimi snapshots prompt and policy before asynchronous process preparation", { timeout: 8000 }, async t => {
  const f = await fixture(t, "approval");
  const options = f.makeOptions();
  options.approvalPolicy.policy.toolDecisions.bash = "deny";
  const result = await executeOwnedKimiPrompt({ ...options, launch: (...args) => {
    options.input[0].text = "Replacement prompt";
    options.approvalPolicy.policy.toolDecisions.bash = "allow";
    return options.launch(...args);
  } });
  assert.equal(result.status, "completed");
  assert.equal(result.events.some(event => event.type === "approval_requested"), false);
  assert.equal(f.requests.find(request => request.method === "session/prompt").params.prompt[0].text, prompt[0].text);
  assert.equal(f.requests.find(request => request.id === "owned-permission").result.outcome.optionId, "reject");
});

test("owned Kimi asynchronous event observers cannot escape journal delivery ownership", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(executeOwnedKimiPrompt({ ...f.makeOptions(), onEvent: async () => {} }), { code: "host_commit_failed" });
});

test("owned Kimi validates the selected configuration and negotiates it before the prompt", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const config = parse(nativeConfig);
  config.models["model-b"] = { ...config.models["test-model"], model: "selected-fixture-model" };
  await writeFile(join(f.home, "config.toml"), stringify(config));
  const options = f.makeOptions();
  options.configuration = { cwd: f.cwd, modelId: "model-b", modeId: "plan", thoughtLevel: "high" };
  options.reservation.selection.modelId = "model-b";
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "invalid_execution" });
  assert.equal(f.commands.length, 0);
  options.reservation.selection.configurationFingerprint = acpConfigurationFingerprint(
    { engineId: "kimi-acp", expectedVersion: options.process.expectedVersion }, options.configuration);
  await executeOwnedKimiPrompt(options);
  const changes = f.requests.filter(request => request.method === "session/set_config_option");
  assert.deepEqual(changes.map(request => [request.params.configId, request.params.value]),
    [["mode", "plan"], ["model", "model-b"], ["thinking", "high"]]);
  assert.ok(f.requests.indexOf(changes.at(-1)) < f.requests.findIndex(request => request.method === "session/prompt"));
});

test("owned Kimi cannot launch another target or substitute the Run's working directory", async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  options.reservation.selection.engineId = "openclaw-acp";
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "invalid_execution" });
  options.reservation.selection.engineId = "kimi-acp";
  options.configuration.cwd = f.home;
  options.reservation.selection.configurationFingerprint = acpConfigurationFingerprint(
    { engineId: "kimi-acp", expectedVersion: options.process.expectedVersion }, options.configuration);
  await assert.rejects(executeOwnedKimiPrompt(options), { code: "invalid_execution" });
  assert.equal(f.commands.length, 0);
  assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "not_submitted");
});

test("owned Kimi delivery failure preserves a known native terminal result and cleans resources", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  await assert.rejects(executeOwnedKimiPrompt({ ...options, onEvent: event => {
    if (event.type === "turn_end") throw new Error("Synthetic delivery failure");
  } }));
  assert.equal(f.store.reserveNativeExecution(options.reservation, now()).submission.status, "completed");
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
});

test("owned Kimi native cancellation clears its deadline before delayed close observation", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold");
  const options = f.makeOptions();
  const abort = new AbortController();
  const result = await executeOwnedKimiPrompt({ ...options, signal: abort.signal, interruptGraceMs: 100,
    onEvent: event => { if (event.type === "turn_start") abort.abort(); }, launch: (...args) => {
      const child = options.launch(...args);
      const emit = child.emit.bind(child);
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

test("owned Kimi Attempt replacement during handshake cannot keep the child or copy alive", { timeout: 8000 }, async t => {
  const f = await fixture(t, "hold-initialize");
  const options = f.makeOptions();
  const abort = new AbortController();
  await assert.rejects(executeOwnedKimiPrompt({ ...options, signal: abort.signal, launch: (...args) => {
    const child = options.launch(...args);
    child.on("message", message => {
      if (message.method !== "initialize") return;
      f.store.createWorkUnitAttempt({ workUnitId: options.reservation.fence.workUnitId, attemptNumber: 2,
        runnerId: "kimi-acp", runtimeInstanceId: "replacement", now: now() });
      abort.abort();
    });
    return child;
  } }));
  assert.equal(f.store.listUnresolvedNativeSubmissions()[0].status, "reserved", "old owner cannot settle the replacement's fence");
  assert.equal(f.requests.some(request => request.method === "session/prompt"), false);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
  await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
});

test("owned Kimi waits for host worker settlement even when close loses its Attempt", { timeout: 8000 }, async t => {
  const f = await fixture(t, "host-write", true);
  await writeFile(join(f.cwd, "native-file.txt"), "Before");
  const options = f.makeOptions(), abort = new AbortController();
  options.approvalPolicy.policy.toolDecisions = { write: "allow" };
  const originalSpawn = childProcess.spawn;
  let workerClosed = false, workerStarted = false;
  const closed = Promise.withResolvers();
  const mock = t.mock.method(childProcess, "spawn", (...args) => {
    const child = originalSpawn(...args);
    if (!args[1]?.some(value => typeof value === "string" && value.endsWith("/host-text-write-worker.js"))) return child;
    workerStarted = true;
    const emit = child.emit.bind(child);
    child.emit = (name, ...values) => {
      if (name !== "close") return emit(name, ...values);
      setTimeout(() => { workerClosed = true; emit(name, ...values); closed.resolve(); }, 300);
      return true;
    };
    child.once("spawn", () => {
      f.store.createWorkUnitAttempt({ workUnitId: options.reservation.fence.workUnitId, attemptNumber: 2,
        runnerId: "kimi-acp", runtimeInstanceId: "replacement", now: now() });
      abort.abort();
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(executeOwnedKimiPrompt({ ...options, signal: abort.signal, interruptGraceMs: 100 }), { code: "native_owner_mismatch" });
    assert.equal(workerStarted, true);
    assert.equal(workerClosed, true, "Owned cleanup must await host work despite a synchronous close error");
    await assert.rejects(access(f.commands[0].options.cwd), { code: "ENOENT" });
  } finally {
    if (workerStarted) await closed.promise;
    mock.mock.restore(); syncBuiltinESMExports();
  }
});


for (const phase of ["preparation", "protocol initialization"]) test(`authority revoked during ${phase} prevents native submission`, async t => {
  const f = await fixture(t);
  const options = f.makeOptions();
  let allowed = true, checks = 0;
  const pending = executeOwnedKimiPrompt({ ...options,
    assertCurrentAuthority() { checks++; if (!allowed) throw new Error("fixture_authority_revoked"); },
    launch(...args) { const child = options.launch(...args); if (phase === "protocol initialization") allowed = false; return child; },
  });
  if (phase === "preparation") allowed = false;
  await assert.rejects(pending);
  assert.ok(checks > 0, "owned execution must invoke authority checking");
  if (phase === "preparation") assert.equal(f.commands.length, 0);
  assert.equal(f.requests.filter(request => request.method === "turn/start" || request.method === "session/prompt").length, 0);
});

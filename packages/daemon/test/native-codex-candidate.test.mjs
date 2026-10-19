import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "../../core/dist/index.js";

// The POSIX shebang peer and /usr/bin/touch scenes cannot certify Windows.
// Windows requires separate real target-supervisor acceptance.
const peerTestOptions = { timeout: 35_000,
  skip: process.platform === "win32" ? "requires POSIX shebang peer; Windows real supervisor acceptance remains unverified" : false };

// This process is a deterministic protocol peer, never real engine acceptance.
const peerSource = String.raw`
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { parse } from "shell-quote";
if (process.argv.includes("--version")) { console.log("codex-cli 0.158.0"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let selection, turnId, pending;
const threadId = "candidate-protocol-peer-session";
const turn = status => ({ id: turnId, items: [], itemsView: "full", status,
  error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: null });
const complete = status => send({ method: "turn/completed", params: { threadId, turn: turn(status) } });
const answer = text => {
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "answer", delta: text } });
  send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "answer", text } } });
  complete("completed");
};
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { userAgent: "candidate-owned-peer", codexHome: process.env.CODEX_HOME,
    platformFamily: "unix", platformOs: process.platform } });
  else if (method === "account/read") send({ id, result: { requiresOpenaiAuth: true, account: { type: "apiKey" } } });
  else if (method === "thread/start" || method === "thread/resume") {
    selection = params;
    send({ id, result: { thread: { id: threadId, cwd: params.cwd, model: params.model,
      modelProvider: params.modelProvider, turns: [], status: { type: "idle" } }, model: params.model,
      modelProvider: params.modelProvider, cwd: params.cwd, approvalPolicy: params.approvalPolicy,
      approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } } });
  } else if (method === "turn/start") {
    turnId = "candidate-peer-turn-" + process.pid;
    const prompt = params.input.find(value => value.type === "text").text;
    send({ id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId, turn: turn("inProgress") } });
    if (prompt.includes("LING_NATIVE_CANCEL_WAIT")) continue;
    if (prompt.includes("LING_NATIVE_CONVERSATION_OK")) { answer("LING_NATIVE_CONVERSATION_OK"); continue; }
    if (prompt.includes("LING_NATIVE_RECOVERY_OK")) { answer("LING_NATIVE_RECOVERY_OK"); continue; }
    const command = prompt.match(/^Command: (.+)$/m)?.[1];
    const itemId = "candidate-peer-item";
    if (command && __EXTRA_FILE_CHANGE__) {
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "fileChange", id: "unexpected-file",
        status: "completed", changes: [{ path: "unexpected.txt", kind: { type: "add", move_path: null }, diff: "+unexpected\n" }] } } });
    }
    if (command) {
      const parts = parse(command);
      pending = { kind: "command", target: parts[1], command, itemId };
      send({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: itemId,
        command, cwd: selection.cwd, status: "inProgress", exitCode: null, aggregatedOutput: null, durationMs: null } } });
      send({ id: "candidate-approval", method: "item/commandExecution/requestApproval", params: {
        threadId, turnId, itemId, kind: "command", environmentId: null, command, cwd: selection.cwd } });
    } else {
      const path = "candidate-native-artifact.txt", diff = "+LING_NATIVE_ARTIFACT_OK\n";
      pending = { kind: "file", target: selection.cwd + "/" + path, itemId,
        changes: [{ path, kind: { type: "add", move_path: null }, diff }] };
      send({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: itemId,
        status: "inProgress", changes: pending.changes } } });
      send({ id: "candidate-approval", method: "item/fileChange/requestApproval", params: {
        threadId, turnId, itemId, environmentId: null, grantRoot: null } });
    }
  } else if (method === "turn/interrupt") { send({ id, result: {} }); complete("interrupted"); }
  else if (!method && id === "candidate-approval") {
    const accepted = result?.decision === "accept";
    if ((accepted && !__OMIT_EFFECT__) || (!accepted && __FORCE_DENIED_EFFECT__))
      writeFileSync(pending.target, pending.kind === "file" ? "LING_NATIVE_ARTIFACT_OK\n" : "");
    const item = pending.kind === "file" ? { type: "fileChange", id: pending.itemId, changes: pending.changes,
      status: accepted ? "completed" : "declined" } : { type: "commandExecution", id: pending.itemId,
      command: pending.command, cwd: selection.cwd, status: accepted ? "completed" : "declined",
      exitCode: accepted ? 0 : null, aggregatedOutput: "", durationMs: 1 };
    send({ method: "item/completed", params: { threadId, turnId, item } });
    if (!accepted && __INTERRUPT_AFTER_DENIAL__) complete("interrupted");
    else answer("LING_NATIVE_ACTION_FINISHED");
  }
}
`;

async function fixture(t, { omitEffect = false, forceDeniedEffect = false, extraFileChange = false, interruptAfterDenial = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-codex-candidate-test-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host") });
  const profiles = new ExecutionEngineProfileStore(paths);
  t.after(async () => { profiles.close(); await rm(root, { recursive: true, force: true }); });
  // Resolve through the daemon's existing dependencies; no dependency is installed.
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../package.json", import.meta.url));
  const source = peerSource.replace('from "shell-quote"', `from ${JSON.stringify(pathToFileURL(require.resolve("shell-quote")).href)}`)
    .replace("__OMIT_EFFECT__", String(omitEffect)).replace("__FORCE_DENIED_EFFECT__", String(forceDeniedEffect))
    .replace("__EXTRA_FILE_CHANGE__", String(extraFileChange)).replace("__INTERRUPT_AFTER_DENIAL__", String(interruptAfterDenial));
  const executablePath = join(root, "codex-peer.mjs");
  await writeFile(executablePath, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await chmod(executablePath, 0o700);
  const profile = profiles.save({ engineId: "codex-app-server", executablePath,
    authProfileId: "candidate-protocol-peer" }, 0);
  await mkdir(profiles.getAuthProfileDirectory(profile), { recursive: true, mode: 0o700 });
  const records = new Map();
  const input = { root, workspace, paths, profiles, profile, executablePath,
    executableDigest: createHash("sha256").update(await readFile(executablePath)).digest("hex"),
    model: "synthetic-candidate-model", provider: "synthetic-candidate-provider",
    signal: AbortSignal.timeout(30_000), record: async (name, value) => {
      assert.equal(records.has(name), false, "candidate records cannot overwrite earlier evidence");
      records.set(name, structuredClone(value));
    } };
  return { root, workspace, records, input };
}

test("candidate scenes prove exact approval and denial effects through the owned protocol and journal", peerTestOptions, async t => {
  const f = await fixture(t);
  const { runCodexScenarios } = await import("../../../scripts/native-execution-engines/codex-scenarios.mjs");
  const result = await runCodexScenarios(f.input);
  assert.equal(result.observations.permissions.status, "passed");
  assert.equal(await readFile(join(f.workspace, "candidate-approved.txt"), "utf8"), "");
  await assert.rejects(readFile(join(f.workspace, "candidate-denied.txt")), { code: "ENOENT" });
  assert.equal(result.observations.recovery.status, "passed");
  assert.equal(result.observations.cancellation.status, "passed");
  assert.equal(result.observations.artifacts.status, "passed");
  assert.equal(result.observations.workspace.status, "not_run");
  assert.equal(result.allChildrenClosed, true);
  assert.equal(result.unresolvedSubmissionCount, 0);
  assert.ok(result.children.length >= 7);
  for (const name of result.observations.permissions.evidence) {
    const record = f.records.get(name);
    assert.ok(record.submission.nativeTurnId);
    assert.equal(record.submission.status, "completed");
    assert.equal(record.approvals[0].correlation.replyStatus, "written");
    assert.equal(record.approvals[0].correlation.submissionId, record.submission.id);
  }
});

test("a completed peer and written approval cannot pass without the approved file effect", peerTestOptions, async t => {
  const f = await fixture(t, { omitEffect: true });
  const { runCodexScenarios } = await import("../../../scripts/native-execution-engines/codex-scenarios.mjs");
  const result = await runCodexScenarios(f.input);
  assert.equal(result.observations.permissions.status, "failed");
  assert.equal(result.observations.artifacts.status, "not_run");
  assert.equal(f.records.get("codex-approval.json").submission.status, "completed");
  assert.equal(f.records.get("codex-approval.json").approvals[0].correlation.replyStatus, "written");
  assert.equal(result.allChildrenClosed, true);
  assert.equal(result.unresolvedSubmissionCount, 0);
  assert.equal(result.observations.workspace.status, "not_run");
});

test("a native denial is not successful when the denied temporary file still appears", peerTestOptions, async t => {
  const f = await fixture(t, { forceDeniedEffect: true });
  const { runCodexScenarios } = await import("../../../scripts/native-execution-engines/codex-scenarios.mjs");
  const result = await runCodexScenarios(f.input);
  assert.equal(result.observations.permissions.status, "failed");
  assert.equal(f.records.get("codex-denial.json").approvals[0].status, "denied");
  assert.equal(f.records.get("codex-denial.json").deniedFile.exists, true);
  assert.equal(result.observations.artifacts.status, "not_run");
  assert.equal(result.allChildrenClosed, true);
});

test("authority drift before native spawn prevents candidate execution and later writes without leaking the error", peerTestOptions, async t => {
  const f = await fixture(t);
  const { runCodexScenarios } = await import("../../../scripts/native-execution-engines/codex-scenarios.mjs");
  let reads = 0;
  const result = await runCodexScenarios({ ...f.input, assertCurrentAuthority: () => {
    if (++reads > 2) throw new Error("PRIVATE_CANDIDATE_ERROR_MUST_NOT_BE_PERSISTED");
  } });
  assert.equal(result.observations.conversation.status, "failed");
  assert.equal(result.observations.permissions.status, "not_run");
  assert.equal(result.observations.artifacts.status, "not_run");
  assert.equal(result.children.length, 2, "only installation and connection probe may launch");
  assert.equal(result.allChildrenClosed, true);
  assert.equal(result.unresolvedSubmissionCount, 0);
  assert.equal(JSON.stringify([...f.records]).includes("PRIVATE_CANDIDATE_ERROR_MUST_NOT_BE_PERSISTED"), false);
});

test("an unsolicited file change cannot be hidden behind a later correct approved command", peerTestOptions, async t => {
  const f = await fixture(t, { extraFileChange: true });
  const { runCodexScenarios } = await import("../../../scripts/native-execution-engines/codex-scenarios.mjs");
  const result = await runCodexScenarios(f.input);
  assert.equal(result.observations.permissions.status, "failed");
  assert.equal(result.observations.artifacts.status, "not_run");
  await assert.rejects(readFile(join(f.workspace, "candidate-approved.txt")), { code: "ENOENT" });
  assert.equal(result.allChildrenClosed, true);
});

test("a written denial with a declined tool and no file effect remains valid when Codex interrupts that turn", peerTestOptions, async t => {
  const f = await fixture(t, { interruptAfterDenial: true });
  const { runCodexScenarios } = await import("../../../scripts/native-execution-engines/codex-scenarios.mjs");
  const result = await runCodexScenarios(f.input);
  assert.equal(result.observations.permissions.status, "passed");
  const denial = f.records.get("codex-denial.json");
  assert.equal(denial.execution.status, "cancelled");
  assert.equal(denial.submission.status, "cancelled");
  assert.equal(denial.approvals[0].status, "denied");
  assert.equal(denial.deniedFile.exists, false);
  assert.equal(result.observations.artifacts.status, "passed");
  assert.equal(result.allChildrenClosed, true);
  assert.equal(result.unresolvedSubmissionCount, 0);
});

test("isolated embedded startup rejects unverified native conversation while preserving canonical input", peerTestOptions, async t => {
  const f = await fixture(t);
  const marker = join(f.root, "unexpected-native-submit.txt");
  await writeFile(f.input.executablePath, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\n`
    + `if (process.argv.length === 3 && process.argv[2] === "--version") console.log("codex-cli 0.158.0");\n`
    + `else { writeFileSync(${JSON.stringify(marker)}, "unexpected native execution"); process.exitCode = 1; }\n`, { mode: 0o700 });
  const { runProductionRejection } = await import("../../../scripts/native-execution-engines/production-rejection.mjs");
  const previousHome = process.env.LING_STACK_HOME;
  const result = await runProductionRejection(f.input);
  assert.equal(result.observation.status, "passed", JSON.stringify(f.records.get("codex-production-rejection.json")));
  const facts = f.records.get("codex-production-rejection.json");
  assert.equal(facts.evidenceScope, "isolated embedded startup + production HTTP admission rejection");
  assert.equal(facts.fullDefaultStartup, "not_run");
  assert.equal(facts.isolation.secretResolverPhase, "degraded");
  assert.equal(facts.isolation.browserBrokerEnabled, false);
  assert.equal(facts.availability.status, "blocked");
  assert.equal(facts.availability.reason, "native_execution_verification_missing");
  assert.equal(facts.stream.httpStatus, 200);
  assert.equal(facts.stream.error, "Current execution verification is required.");
  assert.equal(facts.stream.errorCode, "not_exposed_by_public_sse");
  assert.equal(facts.canonical.length, 1);
  const canonical = facts.canonical[0];
  assert.equal(canonical.userInstruction, "LING_NATIVE_PRODUCTION_REJECTION_INPUT");
  assert.equal(canonical.sourceBody, "LING_NATIVE_PRODUCTION_REJECTION_INPUT");
  assert.deepEqual(canonical.executionBinding, { kind: "native_profile", engineId: "codex-app-server",
    profileId: f.input.profile.id, profileRevision: f.input.profile.revision, nativeModelId: f.input.model });
  assert.equal(canonical.threadStatus, "failed");
  assert.equal(canonical.acceptedSnapshotId, canonical.preparedAcceptedSnapshotId);
  assert.equal(canonical.acceptedFingerprint, canonical.preparedParentFingerprint);
  assert.deepEqual(canonical.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.equal(canonical.authorizationMode, "smart");
  assert.equal(canonical.workspaceAccessMode, "read_only");
  assert.equal(facts.execution.newNativeSubmissions.length, 0);
  assert.equal(facts.execution.newNonterminalExecutions.length, 0);
  assert.equal(facts.execution.newSuccessfulRuns.length, 0);
  assert.equal(result.allLifetimesDrained, true);
  assert.equal(result.allChildrenClosed, true);
  assert.equal(result.environmentRestorationDeferred, false);
  assert.equal(process.env.LING_STACK_HOME, previousHome);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

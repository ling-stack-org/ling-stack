import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { PassThrough, type Duplex, type Readable, type Writable } from "node:stream";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parseUserInputAnswerCommandV1, validateLingAppServerNotificationParams } from "@ling-stack/contracts";
import type {
  LingAppServerCandidateReference,
  AutomationRun,
  LingAppServerApplyChangeTransferResult,
  LingAppServerCaptureChangesResult,
  LingAppServerChangeTransferPreview,
  LingAppServerContextInspectResult,
  LingAppServerExternalAgentRegisterResult,
  LingAppServerExternalAgentTaskReconnectResult,
  LingAppServerExternalAgentTaskStartResult,
  LingAppServerGitHubSubjectResult,
  LingAppServerGitHubIntakePollResult,
  LingAppServerGitHubIntakeReceipt,
  LingAppServerGitHubDeliveryResult,
  LingAppServerGitHubQueueResult,
  LingAppServerRecoveryResult,
  LingAppServerCoordinationSchedule,
  LingAppServerDeliberationDecideParams,
  LingAppServerWorkItemCollaborationAppendResult,
  LingAppServerWorkItemCollaborationReadResult,
  LingAppServerGrant,
  LingAppServerGrantScope,
  LingAppServerHandoffResult,
  LingAppServerHandoffResumeResult,
  LingAppServerInputRespondParams,
  LingAppServerInputRespondResult,
  LingAppServerVerifyOperation,
  LingAppServerVerifyPlanResult,
  LingAppServerVerifyStatusResult,
  LingAppServerWorkItemAcceptResult,
  LingAppServerWorkItemControlResult,
  LingAppServerWorkItemReadResult,
  LingAppServerWorkItemFeedbackResult,
  LingAppServerWorkItemPlanChangeResult,
  LingAppServerWorkItemResult,
  LingAppServerWorkItemWorkflowBindResult,
  LingAppServerWorkItemSnapshot,
  ProposedPlanActionResponse,
  LingAppServerWorktreeCleanupPreview,
  LingAppServerWorktreeCleanupResult,
  LingAppServerWorktreeResult,
  LingAppServerReviewStartResult,
  LingAppServerReviewStatusResult,
  LingAppServerReviewFindingUpdateResult,
  LingAppServerReadChangesResult,
  LingAppServerSimplifyStartResult,
  LingAppServerSimplifyStatusResult,
  LingAppServerThreadSnapshotResult,
  LingAppServerThreadEventsResult,
  LingAppServerInitializeResult,
  LingAppServerSubscriptionResult,
  LingAppServerTurnResumeResult,
  ControlPlaneEventsResponse,
} from "@ling-stack/contracts";
import { LingAppServerClient, type LingAppServerSocket, type LingDaemonClient } from "@ling-stack/api-client";
import { createEnvSecretResolver, createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveStoragePaths, toRuntimeAttemptFence, type LingThreadGoal, type RunIntervention, type SecretResolver, type SqliteRunStore } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer, createDefaultRunnerRegistry, listenLingAppServerSocket, probeLingAppServer, runLingAppServerMcp, runLingAppServerStdio, type DaemonConfig } from "../dist/index.js";
import { prepareConversationSubmission } from "../dist/features/conversations/conversation-submission.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createRunnerRegistry, type RunnerRegistrationInput } from "../dist/runtime/runners.js";
import { createCodexAppServerAdapter } from "../dist/runtime/adapters/codex-app-server.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";
import { startFakeCodexAppServer } from "./test-support/fake-codex-app-server.ts";

test("App Server deduplicates verification starts and restores completed checks, cancellation and Work Item events", { timeout: 30_000 }, async t => {
  const fixture = await releaseFixture(t);
  const marker = join(fixture.root, "test-executions");
  const hold = join(fixture.root, "hold-check");
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\nnode_modules/\npnpm-lock.yaml\n");
  await writeFile(join(fixture.cwd, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
  await writeFile(join(fixture.cwd, "check.cjs"), [
    'const fs = require("node:fs");',
    'console.log("verified fixture behavior");',
    `fs.appendFileSync(${JSON.stringify(marker)}, "checked\\n");`,
    `if (fs.existsSync(${JSON.stringify(hold)})) setTimeout(() => {}, 15000);`,
  ].join("\n"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".gitignore", "package.json", "check.cjs");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Verification input");
  const client = await fixture.connect();
  const peer = await fixture.connect();
  const { workItem } = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/create", {
    sourceId: "verify-acceptance", title: "Verify the current candidate",
  });
  const subscription = await peer.call<{ cursor: string }>("workItem/subscribe", { workItemId: workItem.workItemId });
  const { candidate, coverage } = await client.call<{ candidate: LingAppServerCandidateReference; coverage: string }>("changes/capture");
  assert.equal(coverage, "complete");
  const plan = await client.call<LingAppServerVerifyPlanResult>("verify/plan", {
    candidate, workItemId: workItem.workItemId, requestedChecks: ["test", "browser-missing-recipe"],
  });
  const input = { planId: plan.planId, planRevision: plan.planRevision, candidateDigest: candidate.candidateDigest, idempotencyKey: "verify-receipt" };
  const [first, duplicate] = await Promise.all([
    client.call<LingAppServerVerifyOperation>("verify/start", input),
    peer.call<LingAppServerVerifyOperation>("verify/start", input),
  ]);
  assert.equal(duplicate.operationId, first.operationId);
  const finished = await waitFor(async () => {
    const { operation } = await client.call<LingAppServerVerifyStatusResult>("verify/status", { operationId: first.operationId });
    return operation.completedAt ? operation : undefined;
  });
  assert.equal(finished.status, "blocked");
  assert.deepEqual(finished.checks.map(check => check.status), ["passed", "blocked"]);
  assert.equal(finished.checks[0]?.execution?.exitCode, 0);
  assert.match(finished.checks[0]?.execution?.output ?? "", /verified fixture behavior/u);
  assert.equal(finished.checks[0]?.execution?.timedOut, false);
  assert.equal(finished.checks[1]?.execution, undefined);
  const { daemonUrl, authToken } = fixture.transportOptions();
  const verificationResponse = await fetch(`${daemonUrl}/workspace/verification?cwd=${encodeURIComponent(fixture.cwd)}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  assert.equal(verificationResponse.status, 200);
  const verificationReport = await verificationResponse.json() as { operation: { operationId: string; status: string }; candidateState: string };
  assert.equal(verificationReport.operation.operationId, finished.operationId);
  assert.equal(verificationReport.operation.status, "blocked");
  assert.equal(verificationReport.candidateState, "current");
  const finalEvent = await waitFor(() => peer.notices.find(notice =>
    notice.method === "verification/updated" && notice.params?.event?.entityId === finished.operationId
    && notice.params?.revision === finished.revision));
  assert.equal(finalEvent.params?.subject?.workItemId, workItem.workItemId);
  const events = peer.notices.filter(notice => notice.method === "verification/updated").map(notice => notice.params?.eventId);
  assert.ok(events.length >= 3);
  assert.equal(new Set(events).size, events.length);
  assert.equal(await readFile(marker, "utf8"), "checked\n");
  await fixture.restart();
  const restored = await fixture.connect();
  await restored.call("workItem/subscribe", { workItemId: workItem.workItemId, cursor: subscription.cursor });
  await waitFor(() => restored.notices.find(notice => notice.method === "workItem/replay/ready"));
  assert.deepEqual(await restored.call("verify/start", input), finished);
  assert.deepEqual(restored.notices.filter(notice => notice.method === "verification/updated")
    .map(notice => notice.params?.eventId), events);
  assert.equal(await readFile(marker, "utf8"), "checked\n");

  await writeFile(hold, "Wait for the cancellation request.");
  const stopping = await restored.call<LingAppServerVerifyOperation>("verify/start", { ...input, idempotencyKey: "verify-stop" });
  await waitFor(async () => await readFile(marker, "utf8") === "checked\nchecked\n" ? true : undefined);
  const { operation: active } = await restored.call<LingAppServerVerifyStatusResult>("verify/status", { operationId: stopping.operationId });
  const cancel = { operationId: stopping.operationId, expectedRevision: active.revision, idempotencyKey: "cancel-live-check" };
  const receipt = await restored.call<{ status: string }>("verify/cancel", cancel);
  assert.equal(receipt.status, "cancel_requested");
  const cancelled = await waitFor(async () => {
    const { operation } = await restored.call<LingAppServerVerifyStatusResult>("verify/status", { operationId: stopping.operationId });
    return operation.completedAt ? operation : undefined;
  });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.checks.map(check => check.status), ["cancelled", "not_run"]);
  await fixture.restart();
  const afterCancellation = await fixture.connect();
  assert.deepEqual(await afterCancellation.call("verify/status", { operationId: stopping.operationId }), { operation: cancelled });
  assert.deepEqual(await afterCancellation.call("verify/cancel", cancel), receipt);
});

test("workspace verification replays the accepted candidate and respects the bound Work Item", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const file = join(fixture.cwd, "subject.txt");
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(file, "baseline\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".gitignore", "subject.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline");
  await writeFile(file, "first candidate\n");
  const client = await fixture.connect();
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", status: "open", title: "Verification", objective: "Verify" }, now);
  const { workItem } = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/create", {
    sourceId: "verify-bound-thread", title: "Verify the bound Work Item",
  });
  const accepted = store.acceptWorkItem(workItem.workItemId, { expectedRevision: Number(workItem.revision),
    actorId: "fixture", idempotencyKey: "accept-verification-work", dispatch: { threadId: thread.id, message: "Verify" } }, now);
  assert.ok(accepted);
  const { daemonUrl, authToken } = fixture.transportOptions();
  const start = (idempotencyKey: string, threadId: string) => fetch(`${daemonUrl}/workspace/verification?cwd=${encodeURIComponent(fixture.cwd)}`, {
    method: "POST", headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey, threadId }),
  });
  const response = await start("workspace-start", thread.id);
  assert.equal(response.status, 202, response.ok ? "Verification accepted" : await response.text());
  const { operation } = await response.json() as { operation: LingAppServerVerifyOperation };
  assert.equal(operation.workItemId, workItem.workItemId);
  await waitFor(async () => (await client.call<LingAppServerVerifyStatusResult>("verify/status", { operationId: operation.operationId })).operation.completedAt);
  await writeFile(file, "changed after verification\n");
  await client.call("workItem/pause", { workItemId: workItem.workItemId, expectedWorkItemRevision: accepted.workItem.revision,
    expectedControlGeneration: accepted.workItem.control.generation, actorId: "fixture", idempotencyKey: "pause-verification-work" });
  const replay = await start("workspace-start", thread.id);
  assert.equal(replay.status, 202);
  const report = await replay.json() as { operation: LingAppServerVerifyOperation; candidateState: string };
  assert.equal(report.operation.operationId, operation.operationId);
  assert.equal(report.candidateState, "changed");
  assert.equal((await start("workspace-start", "different-thread")).status, 409);
  const blocked = await start("workspace-next", thread.id);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json() as { error: string }).error, "resume_blocked");
});

test("Goal completion requires a current candidate and a Host-verified independent check", { timeout: 30_000 }, async t => {
  const verifier = 'const {readFileSync} = require("node:fs");\n'
    + 'if (readFileSync("subject.txt", "utf8") !== "accepted behavior\\n") process.exit(1);\n'
    + 'console.log("verified accepted behavior");\n';
  const fixture = await releaseFixture(t, {
    async verificationRecipes(root, cwd) {
      const source = join(root, "trusted-check.cjs");
      await writeFile(source, verifier);
      return [{
        id: "independent-check", label: "Independent check", kind: "test", workspaceRoot: cwd,
        argv: [process.execPath, source], paths: ["subject.txt"], required: true,
        verifier: {
          coverage: "Checks the accepted behavior of subject.txt",
          sources: [{ path: source, sha256: createHash("sha256").update(verifier).digest("hex") }],
        },
      }];
    },
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  const manifest = join(fixture.cwd, "package.json");
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\nnode_modules/\npnpm-lock.yaml\n");
  await writeFile(manifest, JSON.stringify({ scripts: { test: "node candidate-test.cjs" } }));
  await writeFile(join(fixture.cwd, "candidate-test.cjs"), "console.log('candidate tests');\n");
  await writeFile(join(fixture.cwd, "subject.txt"), "previous behavior\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Baseline");
  await writeFile(join(fixture.cwd, "subject.txt"), "accepted behavior\n");

  const client = await fixture.connect();
  const { thread } = await client.call<{ thread: { id: string } }>("thread/start", { title: "Independent verification" });
  const createPlan = async (requestedChecks?: string[]) => {
    const { candidate } = await client.call<{ candidate: LingAppServerCandidateReference }>("changes/capture");
    return client.call<LingAppServerVerifyPlanResult>("verify/plan", {
      candidate: { ...candidate, filePaths: ["unrelated/path"] }, threadId: thread.id, requestedChecks,
    });
  };
  const planned = await createPlan();
  assert.deepEqual(planned.checks.map(check => check.checkId), ["independent-check"]);
  const { verifierBasisRef, coverageDigest } = planned.checks[0];
  assert.ok(verifierBasisRef && coverageDigest);
  await client.call("thread/goal/set", {
    threadId: thread.id, objective: "Verify accepted behavior",
    acceptanceCriteria: [{ id: "assertion", description: "Independent behavioral check", kind: "verification_passed",
      verification: { checkId: "independent-check", verifierBasisRef, coverageDigest } }],
  });
  const runCheck = async (plan: LingAppServerVerifyPlanResult) => {
    const { operationId } = await client.call<LingAppServerVerifyOperation>("verify/start", {
      planId: plan.planId, planRevision: plan.planRevision, candidateDigest: plan.candidate.candidateDigest, idempotencyKey: randomUUID(),
    });
    return waitFor(async () => {
      const { operation } = await client.call<LingAppServerVerifyStatusResult>("verify/status", { operationId });
      return operation.completedAt ? operation : undefined;
    });
  };
  const complete = (connection: typeof client, operationId: string) => {
    const evidence = { kind: "verification", id: operationId };
    return connection.call<{ goal: { status: string } }>("thread/goal/complete", {
      threadId: thread.id, actor: "ling-agent", completionVerificationSummary: "Verified accepted behavior",
      evidenceRefs: [evidence], acceptanceEvidence: [{ criterionId: "assertion", evidence }],
    });
  };
  const original = await runCheck(planned);
  assert.equal(original.status, "passed");
  assert.equal(original.checks[0].verifierBasisRef, verifierBasisRef);
  assert.deepEqual(original.checks[0].producerRefs, planned.checks[0].producerRefs);
  assert.match(original.checks[0].execution?.output ?? "", /verified accepted behavior/u);

  await writeFile(join(fixture.cwd, "candidate-test.cjs"), "console.log('changed candidate tests');\n");
  await assert.rejects(complete(client, original.operationId), /goal_verification_candidate_stale/u);
  const ordinary = await runCheck(await createPlan(["test"]));
  assert.equal(ordinary.status, "passed");
  assert.deepEqual(ordinary.checks[0].producerRefs, []);
  await assert.rejects(complete(client, ordinary.operationId), /goal_verification_basis_mismatch/u);

  await writeFile(join(fixture.root, "trusted-check.cjs"), verifier + "\n");
  const drifted = await runCheck(await createPlan());
  assert.equal(drifted.status, "blocked");
  assert.deepEqual(drifted.checks[0].producerRefs, []);
  await writeFile(join(fixture.root, "trusted-check.cjs"), verifier);
  const verified = await runCheck(await createPlan());
  assert.equal(verified.status, "passed");
  await fixture.restart();
  const reconnected = await fixture.connect();
  assert.equal((await complete(reconnected, verified.operationId)).goal.status, "complete");
});

test("App Server manages an owned worktree and archives the reviewed candidate", { timeout: 30_000 }, async t => {
  const fixture = await releaseFixture(t);
  const source = join(fixture.cwd, "subject.txt");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(source, "base\n");
  git(fixture.cwd, "init", "-q", "-b", "main");
  git(fixture.cwd, "add", ".gitignore", "subject.txt");
  git(fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Baseline");
  await writeFile(source, "local work in progress\n");
  const client = await fixture.connect();
  const store = fixture.getStore();
  const channel = store.createChannel({ name: "Engineering", boundPath: fixture.cwd }, new Date().toISOString());
  const target = { ownerKind: "channel", ownerId: channel.id } as const;

  const { entry } = await client.call<LingAppServerWorktreeResult>("worktree/create", { ...target, baseBranch: "main" });
  assert.equal(entry.status, "ready");
  assert.equal(await readFile(join(entry.path, "subject.txt"), "utf8"), "base\n");
  assert.equal(await readFile(source, "utf8"), "local work in progress\n");
  const repeated = await client.call<LingAppServerWorktreeResult>("worktree/create", { ...target, baseBranch: "main" });
  assert.equal(repeated.entry.path, entry.path);

  const outside = join(fixture.root, "other-repository");
  await mkdir(outside);
  git(outside, "init", "-q");
  const external = store.createChannel({ name: "Other", boundPath: outside }, new Date().toISOString());
  await assert.rejects(client.call("worktree/create", { ...target, ownerId: external.id }), { code: "workspace_binding_invalid" });

  const subject = join(entry.path, "subject.txt");
  await writeFile(subject, "first candidate\n");
  const refreshed = await client.call<LingAppServerWorktreeResult>("worktree/refresh", target);
  assert.equal(refreshed.entry.isDirty, true);
  const preview = await client.call<LingAppServerWorktreeCleanupPreview>("worktree/cleanup/preview", target);
  await writeFile(subject, "second candidate\n");
  await assert.rejects(client.call("worktree/cleanup", { ...target, expectedRevision: preview.expectedRevision, confirmed: true }),
    { code: "stale_revision" });
  assert.equal(await readFile(subject, "utf8"), "second candidate\n");
  const current = await client.call<LingAppServerWorktreeCleanupPreview>("worktree/cleanup/preview", target);
  await assert.rejects(client.call("worktree/cleanup", { ...target, expectedRevision: current.expectedRevision }),
    { code: "worktree_confirmation_required" });
  const result = await client.call<LingAppServerWorktreeCleanupResult>("worktree/cleanup",
    { ...target, expectedRevision: current.expectedRevision, confirmed: true });
  assert.equal(result.entry.status, "not_created");
  assert.equal(await readFile(join(result.snapshot.snapshotPath, "subject.txt"), "utf8"), "second candidate\n");
  assert.equal(await readFile(source, "utf8"), "local work in progress\n");
  await assert.rejects(readFile(subject), { code: "ENOENT" });
  await fixture.restart();
  const resumed = await fixture.connect();
  const replay = await resumed.call<LingAppServerWorktreeCleanupResult>("worktree/cleanup",
    { ...target, expectedRevision: current.expectedRevision, confirmed: true });
  assert.equal(replay.snapshot.id, result.snapshot.id);
  assert.equal(replay.entry.status, "not_created");
});

test("App Server transfers reviewed hunks between owned worktrees and reconciles a lost receipt", { timeout: 30_000 }, async t => {
  const fixture = await releaseFixture(t);
  const baseline = ["first", ...Array.from({ length: 20 }, (_, index) => `line ${index}`), "last"].join("\n") + "\n";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(fixture.cwd, "subject.txt"), baseline);
  await writeFile(join(fixture.cwd, "obsolete.txt"), "obsolete content\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Transfer baseline");
  const store = fixture.getStore();
  const client = await fixture.connect();
  const makeWorktree = async (name: string) => {
    const owner = store.createChannel({ name, boundPath: fixture.cwd }, new Date().toISOString());
    const worktree = { ownerKind: "channel", ownerId: owner.id } as const;
    const { entry } = await client.call<LingAppServerWorktreeResult>("worktree/create", worktree);
    return { worktree, path: entry.path };
  };
  const source = await makeWorktree("Source");
  const target = await makeWorktree("Target");
  const changed = baseline.replace("first", "first updated").replace("last", "last updated");
  await writeFile(join(source.path, "subject.txt"), changed);
  await writeFile(join(source.path, "added.txt"), "a separate file\n");
  await unlink(join(source.path, "obsolete.txt"));
  await writeFile(join(target.path, "local.txt"), "preserve target work\n");
  const sourceWorktree = source.worktree;
  const { candidate } = await client.call<LingAppServerCaptureChangesResult>("changes/capture", { sourceWorktree });
  const { files } = await client.call<LingAppServerReadChangesResult>("changes/read", { sourceWorktree, candidateDigest: candidate.candidateDigest });
  const modified = files.find(file => file.path === "subject.txt")?.hunks;
  assert.equal(modified?.length, 2);
  const selected = [modified![1]!.id, ...files.filter(file => file.path !== "subject.txt").flatMap(file => file.hunks?.map(hunk => hunk.id) ?? [])];
  assert.equal(selected.length, 3);
  const request = { action: "apply", sourceWorktree, targetWorktree: target.worktree, candidateDigest: candidate.candidateDigest, hunkIds: selected };
  const preview = await client.call<LingAppServerChangeTransferPreview>("changes/apply/preview", request);
  assert.deepEqual(preview.selection.map(item => item.path).sort(), ["added.txt", "obsolete.txt", "subject.txt"]);
  assert.equal(await readFile(join(target.path, "subject.txt"), "utf8"), baseline);
  const apply = { ...request, expectedRevision: preview.expectedRevision, idempotencyKey: "transfer", confirmed: true };
  await writeFile(join(target.path, "local.txt"), "newer target work\n");
  await assert.rejects(client.call("changes/apply", apply), { code: "stale_revision" });
  await writeFile(join(target.path, "local.txt"), "preserve target work\n");

  const db = new DatabaseSync(store.paths.databasePath);
  try {
    db.exec(`CREATE TRIGGER fixture_lost_transfer_receipt BEFORE UPDATE ON app_server_state
      WHEN NEW.kind='change_transfer_request' AND json_extract(NEW.payload_json, '$.state')='applied'
      BEGIN SELECT RAISE(ABORT, 'fixture lost transfer receipt'); END`);
    await assert.rejects(client.call("changes/apply", apply));
    db.exec("DROP TRIGGER fixture_lost_transfer_receipt");
  } finally {
    db.close();
  }
  assert.equal(await readFile(join(target.path, "subject.txt"), "utf8"), baseline.replace("last", "last updated"));
  assert.equal(await readFile(join(target.path, "added.txt"), "utf8"), "a separate file\n");
  await assert.rejects(readFile(join(target.path, "obsolete.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(target.path, "local.txt"), "utf8"), "preserve target work\n");
  assert.equal(await readFile(join(source.path, "subject.txt"), "utf8"), changed);
  assert.equal(await readFile(join(fixture.cwd, "subject.txt"), "utf8"), baseline);
  await fixture.restart();
  const resumed = await fixture.connect();
  const settled = await resumed.call<LingAppServerApplyChangeTransferResult>("changes/apply", apply);
  assert.equal(settled.state, "applied");
  assert.deepEqual(await resumed.call("changes/apply", { ...apply, hunkIds: [...selected].reverse() }), settled);
  await assert.rejects(resumed.call("changes/apply", { ...apply, hunkIds: [modified![0]!.id] }), { code: "idempotency_conflict" });
  assert.equal(fixture.getStore().getWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID).ownerRequestId, undefined);
});

test("App Server submits a durable Turn through the configured Pi Runner and replays it after reconnect", { timeout: 30_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "Runner accepted the task" }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  await mkdir(join(fixture.cwd, "feature"));
  await writeFile(join(fixture.cwd, "AGENTS.md"), "Root verification instructions\n");
  await writeFile(join(fixture.cwd, "feature/AGENTS.md"), "Unused fallback instructions\n");
  await writeFile(join(fixture.cwd, "feature/AGENTS.override.md"), "Feature-specific verification instructions\n");
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const first = await fixture.connect();
  const started = await first.call<{ thread: { id: string }; turn: { id: string; status: string }; run: { id: string } }>("thread/start", {
    title: "Runner thread", objective: "Exercise the configured Pi Runner", kind: "conversation", threadId: "release-runner-thread",
  });
  const observer = await fixture.connect();
  const subscription = await observer.call<{ cursor: string }>("thread/subscribe", { threadId: started.thread.id });
  const acceptanceCriteria = [{ id: "run", kind: "run_succeeded", description: "The requested Run succeeds" }];
  const goalInput = { threadId: started.thread.id, objective: "Check the accepted Turn", acceptanceCriteria,
    supervisionPolicy: { autoContinue: false } };
  const { goal } = await first.call<{ goal: LingThreadGoal }>("thread/goal/set", goalInput);
  assert.deepEqual(goal.acceptanceCriteria, acceptanceCriteria);
  assert.equal(goal.supervisionPolicy?.autoContinue, false);
  await assert.rejects(first.call("thread/goal/set", { ...goalInput, objective: "Unaccepted scope change" }), { code: "goal_replace_required" });
  const request = {
    threadId: started.thread.id, message: "Run the configured provider once", providerPresetId: preset.id,
    execute: true, idempotencyKey: "release-runner-turn", fileRefs: [{ path: "feature/index.ts", source: "explicit_text" }],
  };
  const result = await first.call<typeof started & { replayed?: boolean }>("turn/start", request);
  assert.ok(result.run.id);
  const delta = await waitFor(() => observer.notices.find(notice => notice.method === "item/delta"));
  assert.equal(delta.params?.subject?.turnId, result.turn.id);
  assert.equal(delta.params?.runId, result.run.id);
  assert.equal(delta.params?.text, "Runner accepted the task");
  assert.ok(delta.params?.offset && delta.params.streamEpoch);
  assert.equal(delta.params?.eventId, undefined);
  const turnCompleted = await waitFor(() => observer.notices.find(notice => notice.method === "turn/completed"));
  assert.equal(turnCompleted.params?.subject?.turnId, result.turn.id);
  const finalItem = await waitFor(() => observer.notices.find(notice => notice.method === "item/completed"));
  assert.equal(finalItem.params?.itemId, delta.params?.itemId);
  const { item } = await observer.call<{ item: { payload: { body: string } } }>("item/read", {
    threadId: started.thread.id, itemId: finalItem.params?.itemId,
  });
  assert.equal(item.payload.body, "Runner accepted the task");
  await waitFor(() => store.getRun(result.run.id)?.status === "succeeded" ? true : undefined);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /Root verification instructions/u);
  assert.match(JSON.stringify(provider.requests[0]), /Feature-specific verification instructions/u);
  assert.doesNotMatch(JSON.stringify(provider.requests[0]), /Unused fallback instructions/u);
  const query = { threadId: request.threadId, turnId: result.turn.id };
  const context = await first.call<LingAppServerContextInspectResult>("context/inspect", query);
  assert.deepEqual(context.projectInstructions?.sources.map(source => source.path), ["AGENTS.md", "feature/AGENTS.override.md"]);
  await writeFile(join(fixture.cwd, "AGENTS.md"), "Changed after dispatch\n");
  first.close();
  const second = await fixture.connect();
  await second.call("thread/subscribe", { threadId: started.thread.id, cursor: subscription.cursor });
  await waitFor(() => second.notices.find(notice => notice.method === "thread/replay/ready"));
  assert.ok(second.notices.some(notice => notice.method === "item/completed" && notice.params?.eventId === finalItem.params?.eventId));
  assert.equal(second.notices.some(notice => notice.method === "item/delta"), false);
  assert.deepEqual(await second.call("context/inspect", query), context);
  const snapshot = await second.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: request.threadId });
  assert.equal(snapshot.turn?.id, result.turn.id);
  assert.equal(snapshot.run?.id, result.run.id);
  assert.equal(snapshot.run?.status, "succeeded");
  const receipt = await second.call<{ status: string; turnId: string }>("submission/read", {
    threadId: started.thread.id, idempotencyKey: request.idempotencyKey,
  });
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.turnId, result.turn.id);
  const replay = await second.call<typeof result>("turn/start", request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, result.run.id);
  assert.equal(provider.requests.length, 1);
  const resumed = await second.call<{ turn: { id: string }; run: { id: string } }>("turn/resume", { turnId: result.turn.id });
  assert.equal(resumed.turn.id, result.turn.id);
  assert.equal(resumed.run.id, result.run.id);
  const completion = { threadId: request.threadId, actor: "ling-agent", completionVerificationSummary: "Pi completed the accepted Turn." };
  await assert.rejects(second.call("thread/goal/complete", completion), { code: "goal_completion_evidence_required" });
  const now = new Date().toISOString();
  const unrelatedThread = store.createLingThread({ kind: "conversation", title: "Other Thread", objective: "Unrelated evidence" }, now);
  const unrelatedRun = store.createRun({
    id: "unrelated-goal-run", threadId: unrelatedThread.id, cwd: fixture.cwd, taskId: "unrelated-task",
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  store.markRunStarted(unrelatedRun.id, now);
  store.markRunSucceeded(unrelatedRun.id, now);
  const withEvidence = (id: string) => {
    const evidence = { kind: "run", id };
    return { ...completion, evidenceRefs: [evidence], acceptanceEvidence: [{ criterionId: "run", evidence }] };
  };
  await assert.rejects(second.call("thread/goal/complete", withEvidence(unrelatedRun.id)), { code: "goal_completion_evidence_invalid" });
  const resumedSubscription = await second.call<LingAppServerSubscriptionResult>("thread/subscribe", { threadId: request.threadId, cursor: snapshot.cursor });
  assert.equal(resumedSubscription.disposition, "complete");
  const { goal: completed } = await second.call<{ goal: LingThreadGoal }>("thread/goal/complete", withEvidence(result.run.id));
  assert.equal(completed.id, goal.id);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.acceptanceEvidence, withEvidence(result.run.id).acceptanceEvidence);
  await waitFor(() => second.notices.find(notice => notice.method === "thread/goal/updated"
    && notice.params?.subject?.threadId === request.threadId));
});

test("Pi receives scoped project instructions before editing a newly discovered directory", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const instructions = join(fixture.cwd, "feature/AGENTS.override.md");
  const target = join(fixture.cwd, "feature/status.txt");
  await mkdir(join(fixture.cwd, "feature"));
  await writeFile(join(fixture.cwd, "AGENTS.md"), "Run the root verification.\n");
  await writeFile(join(fixture.cwd, "feature/AGENTS.md"), "Unused local fallback.\n");
  await writeFile(instructions, "Feature status must read ready.\n");
  await writeFile(target, "pending\n");
  const provider = await startLoopbackPiProvider(async (body: unknown, count: number) => {
    const payload = JSON.stringify(body);
    const edit = (newText: string) => ({ tool: "edit", input: {
      path: "feature/status.txt", edits: [{ oldText: "pending", newText }],
    } });
    if (count === 1) {
      assert.doesNotMatch(payload, /Feature status must read ready/u);
      return edit("premature");
    }
    assert.match(payload, /Feature status must read ready/u);
    assert.doesNotMatch(payload, /Unused local fallback|Changed during execution/u);
    if (count === 2) {
      assert.match(payload, /project_instructions_pending/u);
      assert.equal(await readFile(target, "utf8"), "pending\n");
      await writeFile(instructions, "Changed during execution.\n");
      return edit("ready");
    }
    assert.equal(await readFile(target, "utf8"), "ready\n");
    return { text: "Feature status is ready." };
  });
  t.after(() => provider.close());
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Scoped project rules" });
  const { cursor } = await client.call<LingAppServerSubscriptionResult>("thread/subscribe", { threadId: thread.id });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { turn, run } = await client.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Prepare the status file", idempotencyKey: "scoped-project-rules",
    providerPresetId: preset.id, tools: ["edit"], authorizationMode: "always", workspaceAccessMode: "workspace_write",
  });
  const settled = await waitFor(() => {
    const current = fixture.getStore().getRun(run.id);
    return current?.endedAt ? current : undefined;
  });
  assert.equal(settled.status, "succeeded", settled.errorMessage ?? "The scoped edit should succeed after the model receives the rules.");
  assert.equal(provider.requests.length, 3);
  assert.equal(await readFile(target, "utf8"), "ready\n");
  const query = { threadId: thread.id, turnId: turn.id };
  const context = await client.call<LingAppServerContextInspectResult>("context/inspect", query);
  assert.deepEqual(context.projectInstructions?.sources.map(source => source.path), ["AGENTS.md"]);
  const [update] = context.projectInstructionUpdates ?? [];
  assert.equal(update?.runId, run.id);
  assert.equal(update?.presentedSourceCount, 1);
  assert.deepEqual(update?.manifest.sources.map(source => source.path), ["feature/AGENTS.override.md"]);
  assert.equal(update?.manifest.sources[0]?.digest, createHash("sha256").update("Feature status must read ready.\n").digest("hex"));
  assert.equal("prompt" in update!, false);

  await fixture.restart();
  const reconnected = await fixture.connect();
  await reconnected.call("thread/subscribe", { threadId: thread.id, cursor });
  await waitFor(() => reconnected.notices.find(notice => notice.method === "thread/replay/ready"));
  assert.deepEqual(await reconnected.call("context/inspect", query), context);
  assert.deepEqual(reconnected.notices.filter(notice => notice.method === "turn/projectInstructions/updated").map(notice => notice.params?.event?.action), [
    "turn.project_instructions.discovered", "turn.project_instructions.presented",
  ]);
});

test("an operator previews and recovers a Turn patch against the current candidate", { timeout: 30_000 }, async t => {
  const fixture = await releaseFixture(t);
  const statusFile = join(fixture.cwd, "status.txt");
  const extraFile = join(fixture.cwd, "local.txt");
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(statusFile, "pending\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Recovery baseline");
  const provider = await startLoopbackPiProvider((_body: unknown, count: number) => count === 1
    ? { tool: "edit", input: { path: "status.txt", edits: [{ oldText: "pending", newText: "ready" }] } }
    : { text: "Status updated." });
  t.after(() => provider.close());
  const startClient = () => {
    const { daemonUrl, authToken } = fixture.transportOptions();
    const client = new LingAppServerClient({
      url: daemonUrl.replace("http:", "ws:") + `/app-server/rpc?cwd=${encodeURIComponent(fixture.cwd)}`,
      createSocket: url => new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }) as unknown as LingAppServerSocket,
      clientInfo: { name: "patch-recovery-test", version: "1" },
    });
    t.after(() => client.close());
    return client;
  };
  const peer = await fixture.connect();
  const { thread } = await peer.call<ThreadRead>("thread/start", { title: "Recover reviewed status change" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { turn, run } = await peer.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Update the status", idempotencyKey: "change-status",
    providerPresetId: preset.id, tools: ["edit"], authorizationMode: "always", workspaceAccessMode: "workspace_write",
  });
  await waitFor(() => fixture.getStore().getRun(run.id)?.endedAt);
  assert.equal(await readFile(statusFile, "utf8"), "ready\n");
  const client = startClient();
  const scope = { threadId: thread.id, turnId: turn.id };
  const undo = { ...scope, action: "undo" } as const;
  const preview = await client.previewChangeRecovery(undo);
  assert.equal(preview.changes.review?.state, "exact");
  assert.match(preview.changes.review?.files[0]?.diff ?? "", /-pending\n\+ready/u);
  const captured = await client.captureChanges();
  const changes = await client.readChanges({ candidateDigest: captured.candidate.candidateDigest, limit: 1 });
  assert.equal(changes.files[0]?.path, "status.txt");
  assert.equal(changes.nextOffset, undefined);

  const confirm = { ...undo, expectedRevision: preview.expectedRevision, idempotencyKey: "undo-status", confirmed: true } as const;
  await writeFile(extraFile, "local work\n");
  await assert.rejects(client.readChanges({ candidateDigest: captured.candidate.candidateDigest }), { code: "stale_revision" });
  await assert.rejects(client.applyChanges(confirm), { code: "stale_revision" });
  assert.equal(await readFile(statusFile, "utf8"), "ready\n");
  const refreshed = await client.previewChangeRecovery(undo);
  const accepted = { ...confirm, expectedRevision: refreshed.expectedRevision };
  const [first, duplicate] = await Promise.all([client.applyChanges(accepted), client.applyChanges(accepted)]);
  assert.deepEqual(duplicate, first);
  assert.equal(first.state, "undone");
  assert.equal(await readFile(statusFile, "utf8"), "pending\n");
  assert.equal(await readFile(extraFile, "utf8"), "local work\n");
  await assert.rejects(client.applyChanges(confirm), { code: "idempotency_conflict" });

  client.close();
  await fixture.restart();
  const reconnected = startClient();
  assert.deepEqual(await reconnected.applyChanges(accepted), first);
  const reapply = { ...scope, action: "reapply" } as const;
  const redo = await reconnected.previewChangeRecovery(reapply);
  const recovered = await reconnected.applyChanges({ ...reapply, expectedRevision: redo.expectedRevision, idempotencyKey: "redo-status", confirmed: true });
  assert.equal(recovered.state, "applied");
  assert.equal(await readFile(statusFile, "utf8"), "ready\n");
  assert.equal(await readFile(extraFile, "utf8"), "local work\n");
});

test("configured Claude project rules are scoped, presented and sealed with the Turn", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const target = join(fixture.cwd, "feature/status.txt");
  await mkdir(join(fixture.cwd, "feature"));
  await mkdir(join(fixture.cwd, ".claude/rules"), { recursive: true });
  await writeFile(join(fixture.cwd, "CLAUDE.md"), "Use the workspace verification recipe.\n");
  await writeFile(join(fixture.cwd, ".claude/rules/feature.md"), [
    "---", "paths:", '  - "feature/**/*.txt"', "---", "Feature files must be marked ready.", "",
  ].join("\n"));
  await writeFile(target, "pending\n");
  const configured = ["CLAUDE.md", ".claude/rules/feature.md"];
  const { daemonUrl, authToken } = fixture.transportOptions();
  const configure = (claudeProjectRules: readonly string[]) => fetch(
    `${daemonUrl}/workspace-settings?cwd=${encodeURIComponent(fixture.cwd)}`, {
      method: "PATCH", body: JSON.stringify({ claudeProjectRules }),
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    },
  );
  const invalid = await configure([".claude/rules/../private.md"]);
  assert.equal(invalid.status, 400);
  const adopted = await configure(configured);
  assert.equal(adopted.status, 200, adopted.ok ? "Workspace rules adopted" : await adopted.text());
  const provider = await startLoopbackPiProvider(async (body: unknown, count: number) => {
    const payload = JSON.stringify(body);
    assert.match(payload, /Use the workspace verification recipe/u);
    const edit = (newText: string) => ({ tool: "edit", input: { path: "feature/status.txt", edits: [{ oldText: "pending", newText }] } });
    if (count === 1) {
      assert.doesNotMatch(payload, /Feature files must be marked ready/u);
      return edit("premature");
    }
    assert.match(payload, /Feature files must be marked ready/u);
    if (count === 2) {
      assert.match(payload, /project_instructions_pending/u);
      assert.equal(await readFile(target, "utf8"), "pending\n");
      return edit("ready");
    }
    return { text: "Status file updated." };
  });
  t.after(() => provider.close());
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Claude rules" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { turn, run } = await client.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Update the feature status", idempotencyKey: "claude-rule-turn",
    providerPresetId: preset.id, tools: ["edit"], authorizationMode: "always", workspaceAccessMode: "workspace_write",
  });
  const settled = await waitFor(() => {
    const current = fixture.getStore().getRun(run.id);
    return current?.endedAt ? current : undefined;
  });
  assert.equal(settled.status, "succeeded", settled.errorMessage ?? "The configured rules should allow the second edit.");
  assert.equal(provider.requests.length, 3);
  assert.equal(await readFile(target, "utf8"), "ready\n");
  const context = await client.call<LingAppServerContextInspectResult>("context/inspect", { threadId: thread.id, turnId: turn.id });
  assert.deepEqual(context.projectInstructions?.sources.map(source => [source.path, source.origin]), [["CLAUDE.md", "claude"]]);
  assert.deepEqual(context.projectInstructions?.claudeProjectRules, configured);
  const update = context.projectInstructionUpdates?.[0];
  assert.deepEqual(update?.manifest.sources[0]?.pathPatterns, ["feature/**/*.txt"]);
  assert.equal(update?.presentedSourceCount, 1);
});

test("a sealed Handoff transfers one Goal and resumes one conversation after restart", { timeout: 30_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "Work recorded." }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  const subject = join(fixture.cwd, "subject.txt");
  await writeFile(subject, "accepted candidate\n");
  git("init", "-q");
  git("add", ".gitignore", "subject.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Baseline");
  const origin = await fixture.connect();
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const { thread } = await origin.call<{ thread: { id: string } }>("thread/start", { title: "Development workflow" });
  const { goal } = await origin.call<{ goal: LingThreadGoal }>("thread/goal/set", {
    threadId: thread.id, objective: "Preserve the delivery contract", tokenBudget: 100_000, supervisionPolicy: { autoContinue: false },
  });
  store.updateLingThreadGoal(goal.id, { tokensUsed: 1200, timeUsedSeconds: 30 }, new Date().toISOString());
  const { turn, run } = await origin.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Write down the delivery contract.",
    providerPresetId: preset.id, idempotencyKey: "source",
  });
  await waitFor(async () => {
    const snapshot = await origin.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
    return snapshot.turn?.status === "succeeded" && snapshot.run?.status === "succeeded" ? true : undefined;
  });
  const capture = { threadId: thread.id, turnId: turn.id, nextInstruction: "Implement only the delivery contract.", idempotencyKey: "handoff" };
  const { handoff } = await origin.call<LingAppServerHandoffResult>("handoff/create", capture);
  assert.equal(handoff.sourceRunId, run.id);
  assert.equal(handoff.goal?.id, goal.id);
  assert.equal(handoff.goal?.objective, "Preserve the delivery contract");
  assert.equal(handoff.goal?.tokenBudget, 100_000);
  assert.ok(handoff.goal.tokensUsed >= 1200);
  assert.deepEqual(await origin.call("handoff/create", capture), { cwd: fixture.cwd, handoff });
  await assert.rejects(origin.call("handoff/create", { ...capture, nextInstruction: "Different task" }), { code: "idempotency_conflict" });

  await fixture.restart();
  const receiver = await fixture.connect();
  const resume = { handoffId: handoff.handoffId, providerPresetId: preset.id };
  assert.deepEqual(await receiver.call("handoff/read", { handoffId: handoff.handoffId }), { cwd: fixture.cwd, handoff });
  await writeFile(subject, "changed candidate\n");
  await assert.rejects(receiver.call("handoff/resume", resume), { code: "handoff_stale" });
  assert.equal(provider.requests.length, 1);
  await writeFile(subject, "accepted candidate\n");
  const databasePath = fixture.getStore().paths.databasePath;
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`CREATE TRIGGER stop_before_handoff_turn BEFORE INSERT ON ling_turns
      BEGIN SELECT RAISE(ABORT, 'fixture stopped before the successor Turn was accepted'); END`);
  } finally { db.close(); }
  await assert.rejects(receiver.call("handoff/resume", resume));
  const interruptedStore = fixture.getStore();
  const transfer = interruptedStore.getAppServerState("handoff_goal_transfer", handoff.handoffId)?.payload as
    LingAppServerHandoffResumeResult["goalTransfer"];
  assert.ok(transfer);
  assert.equal(interruptedStore.getLingThreadGoal(thread.id), undefined);
  assert.equal(interruptedStore.getLingThreadGoal(transfer.threadId)?.tokensUsed, handoff.goal.tokensUsed);
  assert.equal(provider.requests.length, 1);
  await fixture.restart({ beforeStart: async () => {
    const interrupted = new DatabaseSync(databasePath);
    try { interrupted.exec("DROP TRIGGER stop_before_handoff_turn"); } finally { interrupted.close(); }
  } });
  const resumed = await fixture.connect();
  const peer = await fixture.connect();
  const [first, duplicate] = await Promise.all([
    resumed.call<LingAppServerHandoffResumeResult>("handoff/resume", resume),
    peer.call<LingAppServerHandoffResumeResult>("handoff/resume", resume),
  ]);
  assert.equal(first.thread.parentThreadId, thread.id);
  assert.equal(first.thread.parentTurnId, turn.id);
  assert.ok(first.run?.id);
  assert.equal(duplicate.run?.id, first.run.id);
  assert.equal(duplicate.thread.id, first.thread.id);
  assert.deepEqual(first.goalTransfer, transfer);
  assert.deepEqual(duplicate.goalTransfer, transfer);
  assert.equal(fixture.getStore().getLingThreadGoal(first.thread.id)?.tokenBudget, 100_000);
  await waitFor(() => provider.requests.length === 2 ? true : undefined);
  assert.match(JSON.stringify(provider.requests[1]), /Implement only the delivery contract/u);
  assert.match(JSON.stringify(provider.requests[1]), /Preserve the delivery contract/u);
  assert.match(JSON.stringify(provider.requests[1]), /Write down the delivery contract/u);
});

test("thread resume attaches without dispatch and turn resume recovers a prepared request exactly once after restart", { timeout: 30_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "Recovered the prepared request." }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  await writeFile(join(fixture.cwd, "AGENTS.md"), "Use the saved project instructions.\n");
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", title: "Prepared Turn", objective: "Recover after preparation" }, now);
  const { turn } = await prepareConversationSubmission({
    store, runnerRegistry: createDefaultRunnerRegistry(), workspaceCwd: fixture.cwd,
    now, resolveThread: () => thread, input: { threadId: thread.id, message: "Recover my prepared input.",
      idempotencyKey: "prepared-turn", providerPresetId: preset.id },
  });
  await writeFile(join(fixture.cwd, "AGENTS.md"), "These instructions were edited after preparation.\n");
  await fixture.restart();
  const client = await fixture.connect();
  const state = await client.call<LingAppServerThreadSnapshotResult>("thread/resume", { threadId: thread.id });
  assert.equal(state.turn?.id, turn.id);
  assert.equal(state.run, null);
  assert.equal(provider.requests.length, 0);
  await client.call("thread/subscribe", { threadId: thread.id, cursor: state.cursor });
  const recovery = { threadId: thread.id, turnId: turn.id, expectedTurnRevision: state.turn!.updatedAt };
  await assert.rejects(client.call("turn/resume", { ...recovery, expectedTurnRevision: "outdated" }), { code: "stale_revision" });
  const peer = await fixture.connect();
  const results = await Promise.all([client.call<LingAppServerTurnResumeResult>("turn/resume", recovery),
    peer.call<LingAppServerTurnResumeResult>("turn/resume", recovery)]);
  const runId = results[0].run?.id;
  assert.ok(runId);
  assert.equal(results[1].run?.id, runId);
  await waitFor(() => fixture.getStore().getRun(runId)?.status === "succeeded" ? true : undefined);
  assert.equal((await client.call<LingAppServerTurnResumeResult>("turn/resume", recovery)).disposition, "existing");
  await waitFor(() => client.notices.find(notice => notice.method === "turn/started"));
  assert.equal(client.notices.filter(notice => notice.method === "turn/started").length, 1);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /saved project instructions/u);
  assert.doesNotMatch(JSON.stringify(provider.requests[0]), /edited after preparation/u);
});

test("a stopped Turn continues with the same recovery receipt across peers and restart", { timeout: 30_000 }, async t => {
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponse = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await firstResponse;
    return { text: "Fixture response." };
  });
  t.after(async () => {
    releaseFirstResponse();
    await provider.close();
  });
  const fixture = await releaseFixture(t, { harness: { toolBroker: { mode: "enforce" } } });
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Stopped Turn recovery" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const started = await client.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Start the project check.", providerPresetId: preset.id, idempotencyKey: "resume-stopped-source",
  });
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  await client.call("turn/interrupt", { turnId: started.turn.id });
  releaseFirstResponse();
  const store = fixture.getStore();
  const run = store.getRun(started.run.id)!;
  const attempt = store.listWorkUnitAttempts(run.workUnitId!)[0]!;
  await waitFor(() => store.getHostAttemptCompletion({ runId: run.id, ...toRuntimeAttemptFence(attempt) })?.effectCoverage ? true : undefined);
  const { turn } = await client.call<LingAppServerThreadSnapshotResult>("thread/resume", { threadId: thread.id });
  assert.equal(turn?.status, "cancelled");
  const recovery = { threadId: thread.id, turnId: started.turn.id, sourceRunId: run.id, expectedTurnRevision: turn.updatedAt,
    idempotencyKey: "resume-stopped-target", instruction: "Continue from the saved project check." };
  assert.equal((await client.call<LingAppServerTurnResumeResult>("turn/resume", { turnId: turn.id })).disposition, "existing");
  const resumed = await client.call<LingAppServerTurnResumeResult>("turn/resume", recovery);
  assert.equal(resumed.disposition, "continued");
  assert.equal(resumed.resumedFromTurnId, turn.id);
  assert.equal(resumed.turn.sourceTurnId, turn.id);
  assert.ok(resumed.run && resumed.run.id !== run.id);
  const peer = await fixture.connect();
  assert.equal((await peer.call<LingAppServerTurnResumeResult>("turn/resume", recovery)).run?.id, resumed.run.id);
  await assert.rejects(peer.call("turn/resume", { ...recovery, instruction: "Different input." }), { code: "idempotency_conflict" });
  await waitFor(() => store.getRun(resumed.run!.id)?.status === "succeeded" ? true : undefined);
  await fixture.restart();
  const restored = await fixture.connect();
  assert.equal((await restored.call<LingAppServerTurnResumeResult>("turn/resume", recovery)).run?.id, resumed.run.id);
  assert.equal(provider.requests.length, 2);
});

test("a queued Turn reaches Pi once after the source Run finishes and keeps its receipt", { timeout: 30_000 }, async t => {
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponse = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await firstResponse;
    return { text: count === 1 ? "First Turn finished" : "Follow-up finished" };
  });
  t.after(async () => {
    releaseFirstResponse();
    await provider.close();
  });
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Follow-up test" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const started = await client.call<{ run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Wait before finishing the source Turn", providerPresetId: preset.id, idempotencyKey: "queue-source",
  });
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  const { turn, cursor } = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  assert.ok(turn);
  const request = { threadId: thread.id, expectedTurnId: turn.id, expectedTurnRevision: turn.updatedAt,
    message: "Check the follow-up candidate", idempotencyKey: "queue-next" };
  for (const method of ["turn/queue", "turn/interrupt"]) {
    await assert.rejects(client.call(method, { ...request, idempotencyKey: " \t " }), { code: "invalid_params" });
  }
  assert.deepEqual(fixture.getStore().listRunInterventions({ sourceRunId: started.run.id }), []);
  await assert.rejects(client.call("turn/queue", { ...request, expectedTurnRevision: "stale" }), { code: "stale_revision" });
  const current = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  request.expectedTurnRevision = current.turn!.updatedAt;
  type QueueReceipt = { intervention: RunIntervention; replayed: boolean };
  const queued = await client.call<QueueReceipt>("turn/queue", request);
  assert.equal(queued.replayed, false);
  assert.equal(queued.intervention.sourceRunId, started.run.id);
  assert.equal(queued.intervention.status, "queued");
  assert.equal(provider.requests.length, 1);
  client.close();
  const peer = await fixture.connect();
  const replay = await peer.call<QueueReceipt>("turn/queue", request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intervention.id, queued.intervention.id);
  await assert.rejects(peer.call("turn/queue", { ...request, message: "Different follow-up" }), { code: "idempotency_conflict" });

  const store = fixture.getStore();
  let reachedClaim = false;
  store.claimNextRunIntervention = () => {
    reachedClaim = true;
    return undefined;
  };
  releaseFirstResponse();
  await waitFor(() => reachedClaim ? true : undefined);
  assert.equal(store.getRun(started.run.id)?.status, "succeeded");
  assert.equal(store.getRunIntervention(queued.intervention.id)?.status, "queued");
  assert.equal(provider.requests.length, 1);
  await fixture.restart();
  const restored = await fixture.connect();
  await restored.call("thread/subscribe", { threadId: thread.id, cursor });
  const recoveredStore = fixture.getStore();
  const delivered = await waitFor(() => {
    const receipt = recoveredStore.getRunIntervention(queued.intervention.id);
    return receipt?.completedAt && receipt.continuationRunId && recoveredStore.getRun(receipt.continuationRunId)?.status === "succeeded" ? receipt : undefined;
  });
  const followUp = recoveredStore.getLingTurnForRun(delivered.continuationRunId!);
  assert.equal(followUp?.kind, "queued_followup");
  assert.equal(followUp?.sourceTurnId, turn.id);
  await waitFor(() => restored.notices.find(notice => notice.method === "turn/completed"
    && notice.params?.subject?.turnId === followUp.id));
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /Check the follow-up candidate/u);
  const events = await restored.call<ControlPlaneEventsResponse>("thread/events/read", { threadId: thread.id, cursor });
  assert.deepEqual(events.events.filter(event => event.entityId === delivered.continuationRunId && event.action === "run.completed")
    .map(event => event.data.status), ["succeeded"]);
  await assert.rejects(restored.call("turn/queue", { ...request, idempotencyKey: "late-follow-up" }), { code: "stale_revision" });
  const result = await restored.call<QueueReceipt>("turn/queue", request);
  assert.equal(result.intervention.id, delivered.id);
  assert.equal(result.intervention.continuationRunId, delivered.continuationRunId);
  assert.equal(provider.requests.length, 2);
});

test("interrupt with a message cancels the source and delivers one redirect continuation", { timeout: 30_000 }, async t => {
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponse = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await firstResponse;
    return { text: count === 1 ? "Source Turn finished" : "Redirect finished" };
  });
  t.after(async () => {
    releaseFirstResponse();
    await provider.close();
  });
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Redirect test" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const started = await client.call<{ turn: { id: string }; run: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Start a long-running Turn", providerPresetId: preset.id, idempotencyKey: "steer-source",
  });
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  const snapshot = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  assert.equal(snapshot.turn?.id, started.turn.id);
  const request = {
    threadId: thread.id, expectedTurnId: snapshot.turn!.id, expectedTurnRevision: snapshot.turn!.updatedAt,
    message: "Stop the current approach and use the safer implementation", idempotencyKey: "steer-redirect",
  };
  await assert.rejects(client.call("turn/steer", request), { code: "steer_unsupported" });
  assert.equal(fixture.getStore().getRun(started.run.id)?.status, "running");
  const redirected = await client.call<{ intervention: RunIntervention; replayed: boolean }>("turn/interrupt", request);
  assert.equal(redirected.replayed, false);
  assert.equal(redirected.intervention.mode, "interrupt_redirect");
  const replay = await client.call<{ intervention: RunIntervention; replayed: boolean }>("turn/interrupt", request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intervention.id, redirected.intervention.id);
  releaseFirstResponse();
  const delivered = await waitFor(() => {
    const receipt = fixture.getStore().getRunIntervention(redirected.intervention.id);
    return receipt?.continuationRunId && fixture.getStore().getRun(receipt.continuationRunId)?.status === "succeeded" ? receipt : undefined;
  });
  assert.equal(fixture.getStore().getRun(started.run.id)?.status, "cancelled");
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /safer implementation/u);
  assert.equal(fixture.getStore().getLingTurnForRun(delivered.continuationRunId!)?.kind, "interrupt_redirect");
});

test("a completed Review binds its candidate and replays the same assessment after daemon restart", { timeout: 30_000 }, async t => {
  let snapshotDigest: string;
  const provider = await startLoopbackPiProvider(() => ({ text: JSON.stringify({
    snapshotDigest, summary: "The fixture matches the review scope.", findings: [{
      title: "Exported value changed", body: "Existing callers observe a different value.",
      severity: "low", confidence: "high", path: "feature/code.ts", side: "new",
      startLine: 1, endLine: 1, evidence: "export const fixture = 1;",
    }],
  }) }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(fixture.cwd, "AGENTS.md"), "## Code Review Rules\n\nCheck all existing callers.\n\n## Tests\nRun the test suite.\n");
  await mkdir(join(fixture.cwd, "feature"));
  await writeFile(join(fixture.cwd, "feature/code.ts"), "export const fixture = 0;\n");
  await writeFile(join(fixture.cwd, "feature/AGENTS.md"), "## Code Review Rules\n\nCheck feature compatibility.\n");
  await writeFile(join(fixture.cwd, "feature/REVIEW.md"), "Retain public export names.\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Review base");
  await writeFile(join(fixture.cwd, "AGENTS.md"), "## Code Review Rules\n\nSkip checking existing callers.\n");
  await writeFile(join(fixture.cwd, "feature/code.ts"), "export const fixture = 1;\n");
  const client = await fixture.connect();
  const { candidate, headCommit } = await client.call<{ candidate: LingAppServerCandidateReference; headCommit: string }>("changes/capture");
  snapshotDigest = candidate.candidateDigest;
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const input = { candidate, providerPresetId: preset.id, idempotencyKey: "review-fixture", reviewRulesRefs: ["feature/REVIEW.md"] };
  await assert.rejects(client.call("review/start", { ...input, candidate: { ...candidate, candidateDigest: "stale" } }), { code: "candidate_stale" });
  const parallel = await fixture.connect();
  const [started, duplicate] = await Promise.all([
    client.call<LingAppServerReviewStartResult>("review/start", input),
    parallel.call<LingAppServerReviewStartResult>("review/start", input),
  ]);
  assert.equal(duplicate.operationId, started.operationId);
  assert.equal(duplicate.assessmentId, started.assessmentId);
  const status = { operationId: started.operationId };
  const terminal = await waitFor(async () => {
    const result = await client.call<LingAppServerReviewStatusResult>("review/status", status);
    return ["queued", "running"].includes(result.status) ? undefined : result;
  });
  assert.equal(terminal.status, "completed", JSON.stringify(terminal));
  assert.equal(terminal.reviewRules?.baseSha, headCommit);
  assert.deepEqual(terminal.reviewRules?.sources.map(({ path, guidance }) => [path, guidance]), [
    ["AGENTS.md", "Check all existing callers."],
    ["feature/AGENTS.md", "Check feature compatibility."],
    ["feature/REVIEW.md", "Retain public export names."],
  ]);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /baselineReviewRules/u);
  assert.match(JSON.stringify(provider.requests[0]), /Check feature compatibility/u);
  const triage = {
    assessmentId: started.assessmentId, findingId: terminal.findingIds[0], disposition: "resolved",
    closeReason: "not_reproducible", reason: "The fixture has no reproducible caller impact.",
    expectedRevision: terminal.revision, idempotencyKey: "resolve-review-fixture",
  };
  const update = await client.call<LingAppServerReviewFindingUpdateResult>("review/finding/update", triage);
  assert.equal(update.disposition, "resolved");
  assert.notEqual(update.revision, terminal.revision);
  assert.equal(fixture.getStore().getCodeAssessment(started.assessmentId)?.assessment.freshness?.state, "current");
  await assert.rejects(client.call("review/finding/update", { ...triage, idempotencyKey: "stale-finding" }), { code: "stale_revision" });
  await fixture.restart();
  const second = await fixture.connect();
  const restored = fixture.getStore().getCodeAssessment(started.assessmentId);
  assert.equal(restored?.assessment.freshness?.state, "current");
  assert.equal(restored?.findings[0]?.disposition, "resolved");
  assert.equal(restored?.findings[0]?.freshnessState, "current");
  assert.deepEqual(await second.call("review/status", status), { ...terminal, revision: update.revision });
  assert.deepEqual(await second.call("review/start", input), { ...started, status: "completed" });
  await assert.rejects(second.call("review/start", { ...input, baseInstructions: "Different request" }), { code: "idempotency_conflict" });
  assert.deepEqual(await second.call("review/finding/update", triage), update);
  await assert.rejects(second.call("review/finding/update", { ...triage, reason: "Different finding outcome" }), { code: "idempotency_conflict" });
  assert.equal(provider.requests.length, 1);
});

test("App Server simplification runs against the captured diff and retains the suggestion artifact", { timeout: 30_000 }, async t => {
  let snapshotDigest: string;
  const redundantLine = "export const flags = (ready: boolean) => ready ? true : false;";
  const provider = await startLoopbackPiProvider(() => ({ text: JSON.stringify({
    snapshotDigest, summary: "One boolean expression can be simplified.",
    findings: [{
      title: "Return the boolean directly", body: "Return ready directly to preserve the boolean result.",
      severity: "info", confidence: "high", path: "flags.ts", side: "new",
      startLine: 1, endLine: 1, evidence: redundantLine,
    }],
  }) }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".gitignore");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Simplification base");
  await writeFile(join(fixture.cwd, "flags.ts"), redundantLine + "\n");
  const client = await fixture.connect();
  const { candidate } = await client.call<{ candidate: LingAppServerCandidateReference }>("changes/capture");
  snapshotDigest = candidate.candidateDigest;
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const input = { candidate, providerPresetId: preset.id, idempotencyKey: "simplify-fixture" };
  const { methods } = await client.call<{ methods: string[] }>("server/capabilities");
  assert.ok(methods.includes("simplify/start"));
  assert.ok(methods.includes("simplify/status"));
  await assert.rejects(client.call("simplify/start", { ...input, candidate: { ...candidate, candidateDigest: "stale" } }), { code: "candidate_stale" });
  const peer = await fixture.connect();
  const [started, retry] = await Promise.all([
    client.call<LingAppServerSimplifyStartResult>("simplify/start", input),
    peer.call<LingAppServerSimplifyStartResult>("simplify/start", input),
  ]);
  assert.equal(retry.operationId, started.operationId);
  const lookup = { operationId: started.operationId };
  const finished = await waitFor(async () => {
    const status = await client.call<LingAppServerSimplifyStatusResult>("simplify/status", lookup);
    return ["queued", "running"].includes(status.status) ? undefined : status;
  });
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.equal(finished.candidateDigest, snapshotDigest);
  assert.ok(finished.suggestionArtifactId);
  assert.equal(finished.suggestions[0]?.title, "Return the boolean directly");
  assert.equal(finished.suggestions[0]?.evidence, redundantLine);
  assert.deepEqual((await client.call<LingAppServerSimplifyStatusResult>("simplify/status", { ...lookup, offset: 1 })).suggestions, []);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /behavior-preserving simplifications/u);
  assert.equal(await readFile(join(fixture.cwd, "flags.ts"), "utf8"), redundantLine + "\n");
  await fixture.restart();
  const restored = await fixture.connect();
  assert.deepEqual(await restored.call("simplify/status", lookup), finished);
  assert.equal((await restored.call<LingAppServerSimplifyStartResult>("simplify/start", input)).suggestionArtifactId, finished.suggestionArtifactId);
  const artifact = fixture.getStore().getArtifact(finished.suggestionArtifactId);
  const report = artifact?.sealedPayload as { snapshotDigest: string; findings: { title: string }[] };
  assert.equal(report?.snapshotDigest, snapshotDigest);
  assert.equal(report?.findings[0]?.title, "Return the boolean directly");
  assert.equal(provider.requests.length, 1);
});

const codexExecutable = process.env.LING_APP_SERVER_CODEX_EXECUTABLE;

test("Codex control host streams Ling, accepts explicit controls, and replays cursors and delivery receipts", {
  timeout: 30_000, skip: process.platform === "win32",
}, async t => {
  const fixture = await releaseFixture(t);
  let release: () => void = () => undefined;
  const firstRequest = new Promise<void>(resolve => { release = resolve; });
  const provider = await startLoopbackPiProvider(async (_input: unknown, count: number) => {
    if (count === 1) await firstRequest;
    return { text: "Controlled delivery" };
  });
  t.after(async () => { release(); await provider.close(); });
  const statePath = join(fixture.root, "codex-host.sqlite");
  const existingState = new DatabaseSync(statePath);
  existingState.exec("CREATE TABLE deliveries (id TEXT PRIMARY KEY, status TEXT NOT NULL, remote_code INTEGER)");
  existingState.close();
  const codexFixture = join(fixture.root, "fixture-codex.cjs");
  const writes = join(fixture.root, "steer-written.txt");
  await writeFile(codexFixture, [
    "#!/usr/bin/env node",
    "const { createInterface } = require('node:readline');",
    "const { appendFileSync } = require('node:fs');",
    "if (process.env.LING_STACK_AUTH_TOKEN) process.exit(2);",
    "function send(frame) { process.stdout.write(JSON.stringify(frame) + '\\n'); }",
    "createInterface({ input: process.stdin }).on('line', line => {",
    "  const { id, method, params } = JSON.parse(line);",
    "  if (!id) return;",
    "  let result;",
    "  if (method === 'initialize') result = { userAgent: 'fixture' };",
    "  else if (method === 'thread/resume' || method === 'thread/read') result = { thread: { id: params.threadId, cwd: process.cwd() } };",
    "  else if (method === 'turn/start') result = { turn: { id: 'codex-live-turn' } };",
    "  else if (method === 'turn/steer') {",
    `    appendFileSync(${JSON.stringify(writes)}, JSON.stringify(params) + '\\n');`,
    "    if (params.expectedTurnId === 'disconnecting-turn') process.exit(0);",
    "    result = { turnId: params.expectedTurnId === 'malformed-reply-turn' ? 'a-different-turn' : params.expectedTurnId };",
    "  } else throw new Error('unexpected method: ' + method);",
    "  send({ id, result });",
    "});",
  ].join("\n"), { mode: 0o700 });
  const operator = await fixture.connect();
  const { thread } = await operator.call<ThreadRead>("thread/start", { title: "Dual control host" });
  const { daemonUrl, authToken } = fixture.transportOptions();
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const start = async () => {
    const child = spawn(process.execPath, [cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl,
      "app-server", "codex-host", "--thread", thread.id, "--state", statePath, "--codex", codexFixture,
      "--codex-thread", "codex-host-thread"], { env: { ...process.env, LING_STACK_AUTH_TOKEN: authToken }, stdio: "pipe" });
    const output = jsonLines(child.stdin, child.stdout);
    const finished = once(child, "close");
    let diagnostic = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await finished; });
    await Promise.race([waitFor(() => output.notices.find(notice => notice.method === "ready")),
      finished.then(() => { throw new Error(diagnostic.replaceAll(authToken, "[redacted]")); })]);
    return { ...output, async stop() {
      child.stdin.end();
      assert.equal((await finished)[0], 0, diagnostic.replaceAll(authToken, "[redacted]"));
    } };
  };
  const first = await start();
  assert.equal((await first.call<ThreadRead>("codex/snapshot")).thread.id, "codex-host-thread");
  await first.call("codex/turn/start", { message: "Follow the paired Ling task." });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const turn = await operator.call<{ turn: { id: string } }>("turn/start", {
    threadId: thread.id, providerPresetId: preset.id, idempotencyKey: "host-turn", message: "Run a paired task.",
  });
  const started = await waitFor(() => first.notices.find(notice => notice.method === "turn/started" && notice.params?.eventId));
  const steer = { eventId: started.params!.eventId!, expectedTurnId: "codex-live-turn" };
  assert.deepEqual(await first.call("codex/steer", steer), { status: "accepted" });
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  const snapshot = await first.call<LingAppServerThreadSnapshotResult>("ling/snapshot");
  assert.equal(snapshot.turn?.id, turn.turn.id);
  const queued = await first.call<{ intervention: RunIntervention }>("ling/queue", {
    expectedTurnId: turn.turn.id, expectedTurnRevision: snapshot.turn?.updatedAt,
    message: "Finish the verified follow-up.", idempotencyKey: "host-followup",
  });
  assert.equal(queued.intervention.status, "queued");
  await first.stop();
  release();
  await waitFor(() => provider.requests.length === 2 ? true : undefined);
  const second = await start();
  const finished = await waitFor(() => second.notices.find(notice => notice.method === "turn/completed" && notice.params?.eventId));
  assert.ok(finished.params?.eventId);
  assert.ok(!second.notices.some(notice => notice.params?.eventId === steer.eventId));
  assert.deepEqual(await second.call("codex/steer", steer), { status: "accepted", replayed: true });
  assert.equal((await readFile(writes, "utf8")).trim().split("\n").length, 1);
  const completedEventId = finished.params.eventId;
  const unexpected = { eventId: completedEventId, expectedTurnId: "malformed-reply-turn" };
  assert.deepEqual(await second.call("codex/steer", unexpected), { status: "unknown", failureCode: "unexpected_reply" });
  const lostReply = { eventId: completedEventId, expectedTurnId: "disconnecting-turn" };
  assert.deepEqual(await second.call("codex/steer", lostReply), { status: "unknown", failureCode: "transport_failed" });
  const unsent = { eventId: completedEventId, expectedTurnId: "codex-live-turn" };
  assert.deepEqual(await second.call("codex/steer", unsent), { status: "retryable", failureCode: "transport_failed" });
  assert.equal((await readFile(writes, "utf8")).trim().split("\n").length, 3);
  await second.stop();

  const view = spawn(process.execPath, [cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl,
    "app-server", "codex-host", "--thread", thread.id, "--state", statePath, "--codex", codexFixture, "--view"],
  { env: { ...process.env, LING_STACK_AUTH_TOKEN: authToken }, stdio: "pipe" });
  const closed = once(view, "close");
  t.after(async () => { if (view.exitCode === null && view.signalCode === null) view.kill(); await closed; });
  const lines = createInterface({ input: view.stdout });
  const firstLine = await Promise.race([once(lines, "line"), closed.then(() => { throw new Error("Codex browser view did not start."); })]);
  const privateUrl = new URL(String(firstLine[0]));
  assert.equal(privateUrl.hostname, "127.0.0.1");
  const viewOrigin = privateUrl.origin;
  const viewAuth = { Authorization: `Bearer ${privateUrl.hash.slice(1)}` };
  assert.equal((await fetch(`${viewOrigin}/events`)).status, 401);
  assert.equal((await fetch(`${viewOrigin}/command`, { method: "POST", headers: { ...viewAuth, Origin: "https://example.test" } })).status, 403);
  const hostPage = await fetch(viewOrigin);
  assert.equal(hostPage.status, 200);
  assert.match(hostPage.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  assert.match(await hostPage.text(), /Send event to Codex/u);
  const activityStream = await fetch(`${viewOrigin}/events`, { headers: viewAuth, signal: AbortSignal.timeout(5_000) });
  assert.equal(activityStream.status, 200);
  const reader = activityStream.body!.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let activity = "";
    while (!activity.includes('"method":"ready"')) {
      const next = await reader.read();
      assert.equal(next.done, false);
      activity += next.value;
    }
    assert.match(activity, /"source":"ling"/u);
    assert.match(activity, /"codexThreadId":"codex-host-thread"/u);
  } finally { await reader.cancel(); }
  const replayedView = await fetch(`${viewOrigin}/command`, { method: "POST",
    headers: { ...viewAuth, Origin: viewOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "codex/steer", params: steer }) });
  assert.equal(replayedView.status, 200);
  assert.deepEqual((await replayedView.json() as { result: unknown }).result, { status: "accepted", replayed: true });
  const steerInView = async (params: object) => {
    const response = await fetch(`${viewOrigin}/command`, { method: "POST",
      headers: { ...viewAuth, Origin: viewOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "codex/steer", params }) });
    assert.equal(response.status, 200);
    return (await response.json() as { result: unknown }).result;
  };
  assert.deepEqual(await steerInView(unexpected), { status: "unknown", failureCode: "unexpected_reply", replayed: true });
  assert.deepEqual(await steerInView(lostReply), { status: "unknown", failureCode: "transport_failed", replayed: true });
  assert.deepEqual(await steerInView(unsent), { status: "accepted" });
  assert.deepEqual(await steerInView(unsent), { status: "accepted", replayed: true });
  assert.equal((await readFile(writes, "utf8")).trim().split("\n").length, 4);
  view.kill("SIGINT");
  assert.deepEqual(await closed, [0, null]);
});

test("the reference control host steers installed Codex, queues a Ling intervention and replays after reconnect", {
  skip: !codexExecutable, timeout: 30_000,
}, async t => {
  let releaseSource: () => void = () => undefined;
  const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await sourceGate;
    return { text: count === 1 ? "Source complete" : "Follow-up complete" };
  });
  t.after(async () => { releaseSource(); await provider.close(); });
  const fixture = await releaseFixture(t);
  const ling = await fixture.connect();
  const { thread } = await ling.call<ThreadRead>("thread/start", { title: "Native Codex observation" });
  const { daemonUrl, authToken } = fixture.transportOptions();
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const statePath = join(fixture.root, "codex-host.sqlite");
  const codexHome = join(fixture.root, "codex-config");
  await mkdir(codexHome, { mode: 0o700 });
  let releaseCodex: () => void = () => undefined;
  const codexResponseGate = new Promise<void>(resolve => { releaseCodex = resolve; });
  const codexRequests: unknown[] = [];
  const responses = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    codexRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const attempt = codexRequests.length;
    const item = { id: `msg_fixture_${attempt}`, type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "Codex fixture completed.", annotations: [] }] };
    const completed = { id: `resp_fixture_${attempt}`, object: "response", created_at: 0, model: "gpt-5",
      status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } };
    const send = (event: Record<string, unknown>, sequence: number) =>
      response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    send({ type: "response.created", response: { ...completed, status: "in_progress", output: [] } }, 0);
    if (attempt === 1) await codexResponseGate;
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }, 1);
    send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0]!.text }, 2);
    send({ type: "response.output_item.done", output_index: 0, item }, 3);
    send({ type: "response.completed", response: completed }, 4);
    response.end();
  });
  responses.listen(0, "127.0.0.1");
  await once(responses, "listening");
  t.after(async () => {
    releaseCodex();
    const closed = once(responses, "close");
    responses.close();
    responses.closeAllConnections();
    await closed;
  });
  const address = responses.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(codexHome, "config.toml"), [
    'model = "gpt-5"', 'model_provider = "ling_fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[analytics]', 'enabled = false',
    '[model_providers.ling_fixture]', 'name = "Ling Test"', `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
    'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 10000',
  ].join("\n"));
  const start = async () => {
    const running = spawn(process.execPath, [cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl,
      "app-server", "codex-host", "--thread", thread.id, "--state", statePath, "--codex", codexExecutable!],
    { env: { ...process.env, CODEX_HOME: codexHome, LING_STACK_AUTH_TOKEN: authToken }, stdio: "pipe" });
    const peer = jsonLines(running.stdin, running.stdout);
    const stopped = once(running, "close");
    let diagnostics = "";
    running.stderr.setEncoding("utf8").on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    const stop = async () => {
      running.stdin.end();
      assert.equal((await stopped)[0], 0, diagnostics.replaceAll(authToken, "[redacted]"));
    };
    t.after(async () => { if (running.exitCode === null && running.signalCode === null) running.kill(); await stopped; });
    const ready = await Promise.race([waitFor(() => peer.notices.find(notice => notice.method === "ready")), stopped.then(() => {
      throw new Error(diagnostics.replaceAll(authToken, "[redacted]"));
    })]);
    assert.ok(ready.params?.codexUserAgent);
    return { ...peer, stop };
  };
  const first = await start();
  const codex = await first.call<{ threadId: string }>("codex/thread/start");
  const codexTurn = await first.call<{ turn: { id: string } }>("codex/turn/start", { message: "Track the paired Ling work." });
  await waitFor(() => codexRequests.length === 1 ? true : undefined);
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { turn } = await ling.call<{ turn: { id: string } }>("turn/start", {
    threadId: thread.id, providerPresetId: preset.id, idempotencyKey: "codex-host-source", message: "Observe the committed Turn.",
  });
  const started = await waitFor(() => first.notices.find(notice => notice.method === "turn/started" && notice.params?.event?.entityId === turn.id));
  assert.ok(started.params?.eventId);
  const steer = { eventId: started.params.eventId, expectedTurnId: codexTurn.turn.id };
  assert.deepEqual(await first.call("codex/steer", steer), { status: "accepted" });
  releaseCodex();
  await waitFor(() => codexRequests.slice(1).find(request => JSON.stringify(request).includes(steer.eventId)));
  await waitFor(() => first.notices.find(notice => notice.method === "turn/completed"
    && (notice.params as { threadId?: string } | undefined)?.threadId === codex.threadId));
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  const snapshot = await first.call<LingAppServerThreadSnapshotResult>("ling/snapshot");
  assert.equal(snapshot.turn?.id, turn.id);
  const intervention = { expectedTurnId: turn.id, expectedTurnRevision: snapshot.turn?.updatedAt,
    idempotencyKey: "native-codex-follow-up", message: "Verify the precise follow-up from the control host." };
  const queued = await first.call<{ intervention: RunIntervention }>("ling/queue", intervention);
  assert.equal(queued.intervention.status, "queued");
  await first.stop();
  releaseSource();
  await waitFor(() => provider.requests.length === 2 ? true : undefined);
  const second = await start();
  assert.equal((await second.call<ThreadRead>("codex/snapshot")).thread.id, codex.threadId);
  assert.deepEqual(await second.call("codex/steer", steer), { status: "accepted", replayed: true });
  const finished = await waitFor(() => second.notices.find(notice => notice.method === "turn/completed"
    && notice.params?.event?.data?.turnId === turn.id));
  assert.ok(finished.params?.eventId);
  assert.ok(!second.notices.some(notice => notice.params?.eventId === started.params?.eventId));
  const replayed = await second.call<{ intervention: RunIntervention; replayed: boolean }>("ling/queue", intervention);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.intervention.id, queued.intervention.id);
  assert.equal(provider.requests.length, 2);
  await second.stop();
});

test("installed Codex calls the CLI MCP bridge while a Ling subscription receives the same Turn", {
  skip: !codexExecutable, timeout: 45_000,
}, async t => {
  let finishSource: () => void = () => undefined;
  const sourceCanFinish = new Promise<void>(resolve => { finishSource = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, count: number) => {
    if (count === 1) await sourceCanFinish;
    return { text: "Codex submission reached Ling" };
  });
  let closeCodex: () => Promise<void> = async () => undefined;
  t.after(async () => {
    finishSource();
    await closeCodex();
    await provider.close();
  });
  const fixture = await releaseFixture(t);
  const ling = await fixture.connect();
  const { daemonUrl, authToken } = fixture.transportOptions();
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const args = [cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl, "app-server", "mcp"];
  const config = `mcp_servers={ ling={ command=${JSON.stringify(process.execPath)}, args=${JSON.stringify(args)}, env_vars=["LING_STACK_AUTH_TOKEN"], required=true } }`;
  const codexHome = join(fixture.root, "codex-config");
  await mkdir(codexHome, { mode: 0o700 });
  const codex = spawn(codexExecutable!, ["app-server", "--stdio", "-c", config, "-c", "analytics.enabled=false"], {
    cwd: fixture.cwd, stdio: "pipe", env: { PATH: process.env.PATH, CODEX_HOME: codexHome, LING_STACK_AUTH_TOKEN: authToken },
  });
  const closed = once(codex, "close");
  void closed.catch(() => undefined);
  closeCodex = async () => {
    codex.stdin.end();
    const deadline = setTimeout(() => codex.kill("SIGKILL"), 2_000);
    try { await closed; } finally { clearTimeout(deadline); }
  };
  codex.stdin.on("error", () => undefined);
  let stderr = "";
  codex.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  const host = jsonLines(codex.stdin, codex.stdout);
  try {
    await host.call("initialize", { clientInfo: { name: "ling-acceptance", version: "1" }, capabilities: { experimentalApi: true } });
    host.send("initialized", {});
    const { thread: codexThread } = await host.call<ThreadRead>("thread/start", { cwd: fixture.cwd, ephemeral: true });
    const call = async <T>(tool: string, args: object): Promise<T> => {
      const reply = await host.call<{ isError?: boolean; content: Array<{ text: string }> }>("mcpServer/tool/call", {
        server: "ling", threadId: codexThread.id, tool, arguments: args,
      });
      assert.ok(!reply.isError, reply.content[0]?.text);
      return JSON.parse(reply.content[0]!.text) as T;
    };
    const { thread } = await call<ThreadRead>("ling_thread_start", { title: "Codex acceptance", idempotencyKey: "real-codex-thread" });
    const subscription = await ling.call<{ cursor: string }>("thread/subscribe", { threadId: thread.id });
    const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
    const request = { threadId: thread.id, message: "Test the installed Codex MCP bridge", providerPresetId: preset.id, idempotencyKey: "real-codex-turn" };
    const accepted = await call<{ turn: { id: string }; run: { id: string } }>("ling_turn_start", request);
    await waitFor(() => ling.notices.find(notice => notice.method === "turn/started" && notice.params?.subject?.threadId === thread.id));
    await waitFor(() => provider.requests.length === 1 ? true : undefined);
    const snapshot = await call<Pick<LingAppServerThreadSnapshotResult, "turn">>("ling_thread_snapshot", { threadId: thread.id });
    assert.equal(snapshot.turn?.id, accepted.turn.id);
    const queuedInput = { threadId: thread.id, expectedTurnId: accepted.turn.id, expectedTurnRevision: snapshot.turn!.updatedAt,
      message: "Codex sent the next instruction", idempotencyKey: "real-codex-followup" };
    const queued = await call<{ intervention: RunIntervention }>("ling_turn_queue", queuedInput);
    assert.equal(queued.intervention.status, "queued");
    assert.equal((await call<typeof queued>("ling_turn_queue", queuedInput)).intervention.id, queued.intervention.id);
    finishSource();
    const store = fixture.getStore();
    const followUp = await waitFor(() => {
      const receipt = store.getRunIntervention(queued.intervention.id);
      return receipt?.completedAt && receipt.continuationRunId ? store.getLingTurnForRun(receipt.continuationRunId) : undefined;
    });
    assert.equal(followUp.status, "succeeded");
    await waitFor(() => ling.notices.find(notice => notice.method === "turn/completed"
      && notice.params?.subject?.turnId === followUp.id));
    assert.equal((await call<typeof accepted>("ling_turn_start", request)).run.id, accepted.run.id);
    const attached = await call<LingAppServerTurnResumeResult>("ling_turn_resume", {
      threadId: thread.id, turnId: followUp.id, expectedTurnRevision: followUp.updatedAt,
      sourceRunId: queued.intervention.continuationRunId ?? followUp.lastRunId, idempotencyKey: "real-codex-recovery",
    });
    assert.equal(attached.disposition, "existing");
    assert.equal(attached.turn.id, followUp.id);
    assert.equal(provider.requests.length, 2);
    assert.match(JSON.stringify(provider.requests[1]), /Codex sent the next instruction/u);
    let cursor = subscription.cursor;
    let seen = false;
    for (let page = 0; page < 30 && !seen; page++) {
      const result = await call<LingAppServerThreadEventsResult>("ling_thread_events", { threadId: thread.id, cursor });
      seen = result.events.some(event => event.action === "turn.started" && event.entityId === accepted.turn.id);
      if (!result.cursor || result.cursor === cursor) break;
      cursor = result.cursor;
    }
    assert.ok(seen, "Codex could not recover the Turn event from the subscription cursor.");
  } catch (error) {
    throw new Error(`Installed Codex MCP acceptance failed. ${stderr.replaceAll(authToken, "[redacted]")}`, { cause: error });
  }
});

test("External Agent dispatch calls the configured Codex adapter transport once and restores its completion", { timeout: 30_000 }, async t => {
  const adapterPeer = await startFakeCodexAppServer();
  t.after(() => adapterPeer.close());
  const adapterRevision = "codex-adapter-acceptance/1";
  const toolExecutionConformance = readOnlyExternalConformance(adapterRevision);
  const fixture = await releaseFixture(t, { recoveryJournal: true, runner: {
    id: "codex-app-server", displayName: "Configured Codex Adapter", status: "enabled",
    executionBoundary: "external", adapterRevision, toolExecutionConformance,
    adapter: createCodexAppServerAdapter({ baseUrl: adapterPeer.baseUrl, adapterRevision, toolExecutionConformance, timeoutMs: 5_000 }),
  } });
  const client = await fixture.connect();
  const created = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/create", {
    sourceId: "codex-adapter-acceptance", title: "Inspect the project",
  });
  const { workItem } = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/accept", {
    workItemId: created.workItem.workItemId, expectedWorkItemRevision: Number(created.workItem.revision),
    idempotencyKey: "codex-adapter-work-item",
  });
  const { registrationId } = await client.call<LingAppServerExternalAgentRegisterResult>("externalAgent/register", {
    idempotencyKey: "codex-adapter-registration",
    registration: {
      agentId: "configured-codex-adapter", adapterKind: "codex-app-server", protocolVersion: "ling-codex-app-server/0.1",
      displayName: "Configured Codex Adapter", capabilities: ["task.start", "task.reconnect"],
      workspaceScopes: [workItem.workspaceId], toolScopes: ["read"], approvalModes: ["host"], source: "local", version: "1",
    },
  });
  const input = { registrationId, submission: {
    workItemId: workItem.workItemId, workItemRevision: workItem.revision, workspaceId: workItem.workspaceId,
    objective: "Read the project contract", acceptanceSnapshot: { provider: { provider: "fixture", model: "fixture" } },
    instructionManifestDigest: "fixture-manifest", idempotencyKey: "codex-adapter-task",
  } };
  const backup = join(fixture.root, "before-external-dispatch.sqlite");
  const databasePath = fixture.getStore().paths.databasePath;
  backupSqlite(databasePath, backup);
  const { task } = await client.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input);
  const reconnect = { registrationId, taskId: task.taskId, submissionId: task.submissionId, eventCursor: "external-agent:0" };
  const completed = await waitFor(async () => {
    const result = await client.call<LingAppServerExternalAgentTaskReconnectResult>("externalAgent/task/reconnect", reconnect);
    return result.task.status === "completed" ? result : undefined;
  });
  const requests = adapterPeer.requests as { method: string; params: { cwd: string; task: { id: string }; tools: string[] } }[];
  assert.deepEqual(requests.map(request => request.method), ["initialize", "session/run"]);
  assert.equal(requests[1]?.params.cwd, fixture.cwd);
  assert.equal(requests[1]?.params.task.id, task.taskId);
  assert.deepEqual(requests[1]?.params.tools, ["read"]);
  assert.ok(completed.events?.some(event => (event.payload as { text?: string } | undefined)?.text === "Codex app-server fake response."));
  assert.equal(completed.events?.at(-1)?.type, "task_status");
  await fixture.restart();
  const restored = await fixture.connect();
  assert.deepEqual(await restored.call("externalAgent/task/reconnect", reconnect), completed);
  assert.deepEqual(await restored.call("externalAgent/task/start", input), { task: completed.task, replayed: true });
  assert.equal(requests.length, 2);

  const prepared = await restored.call<LingAppServerRecoveryResult>("server/recovery/prepare", { expectedRevision: 0,
    idempotencyKey: "restore-before-external-dispatch" });
  await fixture.restart({ beforeStart: () => restoreSqlite(databasePath, backup) });
  const recovered = await fixture.connect();
  const reconciled = await recovered.call<LingAppServerRecoveryResult>("server/recovery/reconcile", { expectedRevision: prepared.revision });
  assert.equal(reconciled.status, "ready");
  assert.ok(reconciled.entries.some(entry => entry.kind === "external_agent_dispatch" && entry.workItemId === workItem.workItemId
    && entry.taskId === task.taskId && entry.completedAt));
  await assert.rejects(recovered.call("externalAgent/task/start", input), { code: "unknown_outcome" });
  assert.equal(requests.length, 2);
});

test("a second App Server connection cancels the same external dispatch and recovers its receipt after restart", { timeout: 30_000 }, async t => {
  const starts: string[] = [];
  let signal: AbortSignal | undefined;
  let finish: () => void = () => assert.fail("Adapter was not called.");
  const adapterRevision = "owned-fixture-adapter/1";
  const runner: RunnerRegistrationInput = {
    id: "codex-app-server",
    displayName: "Bound test runner",
    status: "enabled",
    executionBoundary: "external",
    adapterRevision,
    toolExecutionConformance: readOnlyExternalConformance(adapterRevision),
    adapter: {
      async runTask(input) {
        starts.push(input.task.id);
        signal = input.signal;
        input.onEvent?.({ type: "assistant_text_delta", text: "working" });
        await new Promise<void>(resolve => {
          const deadline = setTimeout(resolve, 5_000);
          finish = () => { clearTimeout(deadline); resolve(); };
        });
        return { taskId: input.task.id, events: [], messages: [] };
      },
    },
  };
  const fixture = await releaseFixture(t, { runner });
  const first = await fixture.connect();
  const peer = await fixture.connect();
  const created = await first.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/create", { sourceId: "federation", title: "Inspect project" });
  const acceptanceInput = {
    workItemId: created.workItem.workItemId, expectedWorkItemRevision: Number(created.workItem.revision), idempotencyKey: "test-acceptance",
  };
  const accepted = await first.call<{ workItem: LingAppServerWorkItemSnapshot; acceptance: { id: string } }>("workItem/accept", acceptanceInput);
  const registration = await first.call<LingAppServerExternalAgentRegisterResult>("externalAgent/register", {
    idempotencyKey: "test-registration",
    registration: {
      agentId: "test-federation-agent", adapterKind: "codex-app-server", protocolVersion: "test/1", displayName: "Test Runner",
      capabilities: ["task.start", "task.reconnect", "task.cancel", "workItem.dispatch", "workItem.task.start"], workspaceScopes: [created.workItem.workspaceId],
      toolScopes: ["read"], approvalModes: ["host"], source: "local", version: "test",
    },
  });
  const input = {
    registrationId: registration.registrationId,
    submission: {
      workItemId: accepted.workItem.workItemId, workItemRevision: accepted.workItem.revision,
      objective: "Read the fixture", acceptanceSnapshot: { provider: { provider: "fixture", model: "fixture" } },
      workspaceId: accepted.workItem.workspaceId, instructionManifestDigest: "fixture-manifest", idempotencyKey: "test-start",
    },
  };
  const blockedInput = { ...input, submission: { ...input.submission, acceptanceSnapshot: {}, idempotencyKey: "test-blocked" } };
  const blocked = await first.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", blockedInput);
  assert.equal(blocked.task.status, "unknown");
  assert.equal(blocked.task.outcomeReason, "dispatch_provider_unavailable");
  assert.deepEqual(starts, []);
  const start = await first.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input);
  assert.equal(start.task.status, "running");
  const replay = await peer.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(starts, [start.task.taskId]);
  first.close();

  const result = await peer.call<{ status: string }>("externalAgent/task/cancel", {
    registrationId: registration.registrationId, taskId: start.task.taskId, idempotencyKey: "test-cancel",
  });
  assert.equal(result.status, "unknown");
  assert.equal(signal?.aborted, true);
  finish();
  await fixture.restart();
  const restored = await fixture.connect();
  const blockedReplay = await restored.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", blockedInput);
  assert.deepEqual(blockedReplay, { task: blocked.task, replayed: true });
  const reconnected = await restored.call<LingAppServerExternalAgentTaskReconnectResult>("externalAgent/task/reconnect", {
    registrationId: registration.registrationId, taskId: start.task.taskId, submissionId: start.task.submissionId,
    eventCursor: start.task.eventCursor,
  });
  assert.equal(reconnected.task.status, "unknown");
  assert.ok(reconnected.events?.some(event => event.type === "task_unknown"));
  assert.equal((await restored.call<LingAppServerExternalAgentTaskStartResult>("externalAgent/task/start", input)).replayed, true);
  const recovered = await restored.call<typeof accepted>("workItem/accept", acceptanceInput);
  assert.deepEqual(recovered.acceptance, accepted.acceptance);
  assert.deepEqual(starts, [start.task.taskId]);
});

test("authorized GitHub occurrences converge on one Work Item and retain their original receipts", { timeout: 20_000 }, async t => {
  let repositoryId = 73;
  const fixture = await releaseFixture(t, {
    githubSources: cwd => [{ workspaceRoot: cwd, repository: "example/ling", repositoryId: "73" }],
    externalWorkFetch: async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname === "/repos/example/ling") return Response.json({ id: repositoryId, full_name: "Example/Ling" });
      const number = Number(url.pathname.split("/").at(-1));
      assert.ok([7, 8].includes(number));
      return Response.json({ number, title: "Correct event replay", state: "open" });
    },
  });
  const [first, second] = await Promise.all([fixture.connect(), fixture.connect()]);
  const gitHubSubject = { repository: "Example/Ling", kind: "issue", number: 7 } as const;
  const { subject } = await first.call<LingAppServerGitHubSubjectResult>("github/subject/read", gitHubSubject);
  assert.equal(subject.repositoryId, "73");
  assert.equal(subject.repository, "example/ling");
  const request = { gitHubSubject, title: "Correct event replay" };
  const chat = { ...request, sourceId: "chat-input", idempotencyKey: "chat" };
  const codex = { ...request, sourceId: "codex-input", idempotencyKey: "codex" };
  const [chatResult, codexResult] = await Promise.all([
    first.call<LingAppServerWorkItemResult>("workItem/create", chat),
    second.call<LingAppServerWorkItemResult>("workItem/create", codex),
  ]);
  const { workItemId, workspaceId, revision } = chatResult.workItem;
  assert.deepEqual(codexResult.workItem, chatResult.workItem);
  assert.equal(chatResult.sourceReceipt?.sourceId, chat.sourceId);
  assert.equal(codexResult.sourceReceipt?.sourceId, codex.sourceId);
  assert.equal(chatResult.sourceReceipt?.targetKey, codexResult.sourceReceipt?.targetKey);
  const accept = { workItemId, expectedWorkItemRevision: Number(revision), idempotencyKey: "first-accept" };
  type Accepted = { acceptance: { id: string }; replayed: boolean };
  const accepted = await Promise.all([
    first.call<Accepted>("workItem/accept", accept),
    second.call<Accepted>("workItem/accept", accept),
  ]);
  assert.deepEqual(accepted[0].acceptance, accepted[1].acceptance);
  assert.equal(accepted.filter(result => !result.replayed).length, 1);
  await assert.rejects(first.call("workItem/create", {
    ...codex, idempotencyKey: "other-target", gitHubSubject: { ...gitHubSubject, number: 8 },
  }), { code: "workspace_binding_invalid" });
  await assert.rejects(first.call("workItem/create", {
    ...request, sourceId: "unregistered", gitHubSubject: { ...gitHubSubject, repository: "other/repo" },
  }), { code: "github_subject_unavailable" });
  repositoryId = 74;
  await assert.rejects(first.call("workItem/create", { ...request, sourceId: "transferred" }), {
    code: "github_subject_unavailable",
  });
  repositoryId = 73;
  assert.deepEqual(fixture.getStore().listControlPlaneEvents({ workspaceId, entityId: workItemId }).map(event => event.action),
    ["work_item.created", "work_item.source_linked", "work_item.accepted"]);
  await fixture.restart();
  const restored = await fixture.connect();
  const replay = await restored.call<LingAppServerWorkItemResult>("workItem/create", codex);
  assert.equal(replay.workItem.workItemId, workItemId);
  assert.deepEqual(replay.sourceReceipt, codexResult.sourceReceipt);
  const { gitHubSubject: _, idempotencyKey: __, ...bareSource } = codex;
  assert.deepEqual(await restored.call("workItem/create", bareSource), replay);
  assert.equal(fixture.getStore().listWorkItems().length, 1);
});

test("signed GitHub webhooks and polling converge on one work item across restart", { timeout: 30_000 }, async t => {
  const signingKey = randomUUID();
  const secretName = "LING_APP_SERVER_FIXTURE_GITHUB_INTAKE";
  process.env[secretName] = signingKey;
  t.after(() => { delete process.env[secretName]; });
  const repo = { id: 710, full_name: "example/ling" };
  const issue = { number: 12, title: "Review inbox behavior", state: "open", labels: [{ name: "triage" }],
    updated_at: new Date().toISOString() };
  const unlabelled = { ...issue, number: 13, labels: [] };
  let unavailable = true;
  const fixture = await releaseFixture(t, {
    githubSources: cwd => [{ workspaceRoot: cwd, repository: repo.full_name, repositoryId: String(repo.id),
      intake: { enabled: true, mode: "suggest", requiredLabel: "triage", webhookSourceId: "fixture-github", priority: "high" } }],
    externalWorkFetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/example/ling/issues/12") return unavailable
        ? new Response(null, { status: 502 }) : Response.json(issue);
      if (url.pathname === "/repos/example/ling/issues") return Response.json([issue, unlabelled]);
      if (url.pathname === "/repos/example/ling") return Response.json(repo);
      return new Response(null, { status: 404 });
    },
  });
  const client = await fixture.connect();
  const github = fixture.getStore().putAutomationEventSource({
    id: "fixture-github", label: "GitHub triage", adapter: "github", enabled: true,
    repository: repo.full_name, secretRefs: [`env:${secretName}`], rules: [],
  }, 0, new Date().toISOString());
  assert.equal(github.revision, 1);
  async function webhook(repository: typeof repo, deliveryId: string) {
    const { daemonUrl } = fixture.transportOptions();
    const body = JSON.stringify({ action: "opened", repository, issue });
    return await fetch(`${daemonUrl}/automation-event-sources/fixture-github/events?cwd=${encodeURIComponent(fixture.cwd)}`, {
      method: "POST", body,
      headers: { "X-GitHub-Event": "issues", "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", signingKey).update(body).digest("hex")}` },
    });
  }
  const rejected = await webhook({ ...repo, id: 711 }, "wrong-identity");
  assert.equal(rejected.status, 403);
  const accepted = await webhook(repo, "opened-issue");
  assert.equal(accepted.status, 202, accepted.ok ? "Webhook accepted" : await accepted.text());
  const acceptedBody = await accepted.json() as { eventId: string; intakeReceiptId: string };
  assert.ok(acceptedBody.intakeReceiptId);
  await waitFor(() => {
    const pending = fixture.getStore().getAppServerState("github_intake_pending", acceptedBody.eventId);
    return pending && pending.revision > 1 ? pending : undefined;
  });
  const poll = await client.call<LingAppServerGitHubIntakePollResult>("github/intake/poll", { repository: repo.full_name });
  assert.equal(poll.receipts[0]?.outcome, "suggested");
  assert.equal(poll.receipts[1]?.reasonCode, "required_label_missing");
  assert.ok(poll.receipts[0]?.workItemId);
  assert.equal(fixture.getStore().getWorkItem(poll.receipts[0].workItemId)?.priority, "high");
  await fixture.restart();
  unavailable = false;
  const after = await fixture.connect();
  const receipt = await waitFor(() => fixture.getStore().getAppServerState("github_intake_receipt", acceptedBody.intakeReceiptId));
  assert.ok(receipt);
  const observed = await after.call<{ receipt: LingAppServerGitHubIntakeReceipt }>("github/intake/read", { receiptId: acceptedBody.intakeReceiptId });
  assert.equal(observed.receipt.outcome, "deduplicated");
  assert.equal(observed.receipt.workItemId, poll.receipts[0].workItemId);
  const duplicate = await webhook(repo, "opened-issue");
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ...acceptedBody, duplicate: true });
  const repeatedPoll = await after.call<LingAppServerGitHubIntakePollResult>("github/intake/poll", { repository: repo.full_name });
  assert.deepEqual(repeatedPoll.receipts, poll.receipts);
  assert.equal(fixture.getStore().listWorkItems({ sourceType: "external_work" }).length, 1);
  assert.equal(fixture.getStore().listWorkItems({ sourceType: "external_work" })[0]?.status, "intake");
});

test("automatic GitHub intake resumes a scoped dispatch once and preserves admission limits", { timeout: 35_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "The task needs a scoped plan." }));
  t.after(() => provider.close());
  const repository = "example/ling";
  const quietRepository = "example/quiet";
  const revokedRepository = "example/revoked";
  let labelRevoked = false;
  let providerPresetId = "fixture-provider-unconfigured";
  const observedAt = new Date();
  const quietTime = (delta: number) => new Date(observedAt.getTime() + delta * 60_000).toISOString().slice(11, 16);
  const issue = (num: number) => ({ number: num, title: `Triage issue ${num}`, state: "open",
    labels: [{ name: "agent-ready" }], updated_at: observedAt.toISOString() });
  let current = [issue(21), issue(22)];
  const fixture = await releaseFixture(t, {
    githubSources: cwd => [
      { workspaceRoot: cwd, repository, repositoryId: "714",
        intake: { enabled: true, mode: "auto_start", requiredLabel: "agent-ready", providerPresetId,
          budget: { maxConcurrent: 1, maxStartsPerWindow: 2, windowMs: 60_000 } } },
      { workspaceRoot: cwd, repository: quietRepository, repositoryId: "715",
        intake: { enabled: true, mode: "auto_start", requiredLabel: "agent-ready", providerPresetId,
          budget: { maxConcurrent: 1, maxStartsPerWindow: 2, windowMs: 60_000 },
          quietHours: { timeZone: "UTC", start: quietTime(-30), end: quietTime(30) } } },
      { workspaceRoot: cwd, repository: revokedRepository, repositoryId: "716",
        intake: { enabled: true, mode: "auto_start", requiredLabel: "agent-ready", providerPresetId,
          budget: { maxConcurrent: 1, maxStartsPerWindow: 2, windowMs: 60_000 } } },
    ],
    externalWorkFetch: async input => {
      const { pathname } = new URL(String(input));
      if (pathname === `/repos/${repository}`) return Response.json({ id: 714, full_name: repository });
      if (pathname === `/repos/${quietRepository}`) return Response.json({ id: 715, full_name: quietRepository });
      if (pathname === `/repos/${repository}/issues`) return Response.json(current);
      if (pathname === `/repos/${repository}/issues/21`) return Response.json(issue(21));
      if (pathname === `/repos/${quietRepository}/issues`) return Response.json([issue(1)]);
      if (pathname === `/repos/${revokedRepository}`) return Response.json({ id: 716, full_name: revokedRepository });
      if (pathname === `/repos/${revokedRepository}/issues`) return Response.json([issue(1)]);
      if (pathname === `/repos/${revokedRepository}/issues/1`) {
        return Response.json({ ...issue(1), labels: labelRevoked ? [] : issue(1).labels });
      }
      return new Response(null, { status: 404 });
    },
  });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  providerPresetId = preset.id;
  fixture.getStore().updateProviderPreset(preset.id, { enabled: false }, new Date().toISOString());
  await fixture.restart();
  const [first, peer] = await Promise.all([fixture.connect(), fixture.connect()]);
  const [poll, duplicate] = await Promise.all([first, peer].map(client =>
    client.call<LingAppServerGitHubIntakePollResult>("github/intake/poll", { repository })));
  assert.deepEqual(poll, duplicate);
  const [accepted, suppressed] = poll.receipts;
  assert.ok(accepted?.workItemId);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(suppressed?.reasonCode, "concurrency_limit");
  const awaiting = fixture.getStore();
  const now = new Date().toISOString();
  const claimed = awaiting.claimWorkItem(accepted.workItemId, { ownerId: "competing-owner" }, now);
  assert.equal(claimed?.blocker?.code, "control_blocked");
  const quiet = await first.call<LingAppServerGitHubIntakePollResult>("github/intake/poll", { repository: quietRepository });
  assert.equal(quiet.receipts[0]?.reasonCode, "quiet_hours");
  const revoked = await first.call<LingAppServerGitHubIntakePollResult>("github/intake/poll", { repository: revokedRepository });
  assert.equal(revoked.receipts[0]?.outcome, "accepted");
  const revokedWorkItemId = revoked.receipts[0]?.workItemId;
  assert.ok(revokedWorkItemId);
  const stagedThread = awaiting.createLingThread({ kind: "conversation", status: "open", title: "Reserved triage", objective: "Triage issue 21" }, now);
  const staged = awaiting.acceptWorkItem(accepted.workItemId, {
    expectedRevision: claimed!.workItem.revision, actorId: "ling_agent", idempotencyKey: accepted.receiptId,
    dispatch: { threadId: stagedThread.id, providerPresetId: preset.id, message: "Triage issue 21" },
  }, now);
  assert.ok(staged?.receipt.dispatch);
  await assert.rejects(first.call("turn/start", { threadId: stagedThread.id, message: staged.receipt.dispatch.message,
    providerPresetId: preset.id, idempotencyKey: staged.receipt.dispatch.submissionKey }), { code: "work_item_dispatch_held" });
  assert.equal(provider.requests.length, 0);
  labelRevoked = true;
  await fixture.restart();
  fixture.getStore().updateProviderPreset(preset.id, { enabled: true }, new Date().toISOString());
  fixture.getStore().recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Loopback fixture", checkedAt: new Date().toISOString() });
  const restored = await fixture.connect();
  const finished = await waitFor(() => {
    const runId = fixture.getStore().getWorkItem(accepted.workItemId!)?.runId;
    const run = runId ? fixture.getStore().getRun(runId) : undefined;
    return run && ["succeeded", "failed", "cancelled"].includes(run.status) ? run : undefined;
  }).catch(async error => {
    const state = await restored.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: accepted.workItemId });
    throw new Error(JSON.stringify(state.intakeDispatch), { cause: error });
  });
  assert.equal(finished.status, "succeeded", finished.errorMessage ?? "The routed Run succeeded.");
  assert.equal(finished.threadId, stagedThread.id);
  const held = await waitFor(async () => {
    const result = await restored.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: revokedWorkItemId });
    return result.intakeDispatch?.status === "held" ? result.intakeDispatch : undefined;
  });
  assert.equal(held.reasonCode, "required_label_missing");
  assert.equal(fixture.getStore().getWorkItem(revokedWorkItemId)?.runId, undefined);
  assert.equal(provider.requests.length, 1);
  assert.equal(fixture.getStore().listRuns({ threadId: finished.threadId }).length, 1);
  assert.match(JSON.stringify(provider.requests[0]), /Triage issue 21/u);
  assert.deepEqual(await restored.call("github/intake/poll", { repository }), poll);
  current = [issue(23), issue(24)];
  const next = await restored.call<LingAppServerGitHubIntakePollResult>("github/intake/poll", { repository });
  assert.equal(next.receipts[0]?.outcome, "accepted");
  assert.equal(next.receipts[1]?.reasonCode, "start_budget_exhausted");
});

test("a reserved Work Item dispatch recovers once through the conversation owner and obeys pause and deletion fences", { timeout: 25_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "First assignment complete." }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  const first = await fixture.connect();
  const { thread } = await first.call<ThreadRead>("thread/start", { title: "Primary assignment" });
  const { thread: alternate } = await first.call<ThreadRead>("thread/start", { title: "Competing assignment" });
  const { workItem } = await first.call<LingAppServerWorkItemResult>("workItem/create", { sourceId: "dispatch", title: "Accept one assignment" });
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const dispatch = { threadId: thread.id, message: "Inspect primary assignment", providerPresetId: preset.id };
  const input = { workItemId: workItem.workItemId, expectedWorkItemRevision: Number(workItem.revision),
    actorId: "local-user", idempotencyKey: "accept-primary", dispatch };
  const before = await first.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: workItem.workItemId });
  const reserved = store.acceptWorkItem(workItem.workItemId, {
    expectedRevision: input.expectedWorkItemRevision, actorId: input.actorId, idempotencyKey: input.idempotencyKey, dispatch,
  }, new Date().toISOString());
  assert.ok(reserved?.receipt.dispatch);
  assert.equal(store.listRuns({ threadId: thread.id }).length, 0);
  await assert.rejects(first.call("turn/start", { ...dispatch, idempotencyKey: "different-execution" }), { code: "work_item_dispatch_intent_required" });
  const pause = await first.call<LingAppServerWorkItemControlResult>("workItem/pause", {
    workItemId: workItem.workItemId, expectedWorkItemRevision: reserved.workItem.revision, expectedControlGeneration: 0,
    idempotencyKey: "pause-primary", actorId: "local-user",
  });
  const held = await first.call<LingAppServerWorkItemAcceptResult>("workItem/accept", input);
  assert.equal(held.dispatch?.status, "held");
  assert.equal(held.acceptance.id, reserved.receipt.id);
  assert.equal(provider.requests.length, 0);
  await fixture.restart();
  const [restored, peer] = await Promise.all([fixture.connect(), fixture.connect()]);
  await peer.call("workItem/subscribe", { workItemId: workItem.workItemId, cursor: before.cursor });
  await waitFor(() => peer.notices.find(value => value.method === "workItem/thread/linked"));
  await restored.call("thread/subscribe", { threadId: thread.id });
  const overlap = await waitFor(() => restored.notices.find(value => value.method === "workItem/control/updated"
    && value.params?.event?.action === "work_item.control.pause"));
  const workItemNotice = await waitFor(() => peer.notices.find(value => value.method === "workItem/control/updated"
    && value.params?.event?.action === "work_item.control.pause"));
  assert.ok(overlap.params?.eventId);
  assert.equal(overlap.params.eventId, workItemNotice.params?.eventId);
  assert.ok(!restored.notices.some(value => value.method === "workItem/created" && value.params?.event?.entityId === workItem.workItemId));
  await restored.call("workItem/resume", {
    workItemId: workItem.workItemId, expectedWorkItemRevision: Number(pause.workItem.revision), expectedControlGeneration: 1,
    idempotencyKey: "resume-primary", actorId: "local-user",
  });
  const [primary, competing] = await Promise.all([
    restored.call<LingAppServerWorkItemAcceptResult>("workItem/accept", input),
    peer.call<LingAppServerWorkItemAcceptResult>("workItem/accept", {
      ...input, idempotencyKey: "accept-competing", dispatch: { ...dispatch, threadId: alternate.id },
    }),
  ]);
  assert.deepEqual(primary.acceptance, competing.acceptance);
  assert.equal(primary.acceptance.id, reserved.receipt.id);
  const runId = primary.dispatch?.runId;
  assert.ok(runId, `Expected an admitted primary run, got ${primary.dispatch?.status}: ${primary.dispatch?.blocker}`);
  assert.deepEqual(competing.dispatch, primary.dispatch);
  await waitFor(() => fixture.getStore().getRun(runId)?.status === "succeeded" ? true : undefined);
  await waitFor(() => peer.notices.find(value => value.params?.event?.action === "work_item.dispatch.admitted"));
  assert.equal(provider.requests.length, 1);
  assert.equal(fixture.getStore().listRuns({ threadId: thread.id }).length, 1);
  assert.equal(fixture.getStore().listRuns({ threadId: alternate.id }).length, 0);
  assert.equal(fixture.getStore().getWorkItem(workItem.workItemId)?.runId, runId);
  await restored.call("thread/archive", { threadId: thread.id });
  const preview = await restored.call<{ allowed: boolean; dependencies: { workItemIds: string[] } }>("thread/delete/preview", { threadId: thread.id });
  assert.equal(preview.allowed, false);
  assert.deepEqual(preview.dependencies.workItemIds, [workItem.workItemId]);
  assert.throws(() => fixture.getStore().hardDeleteLingThread(thread.id, {}, new Date().toISOString()), /thread_work_item_dependency/u);
});

test("GitHub delivery keeps head checks across base changes and completes a Goal only with current trusted merge evidence", { timeout: 30_000 }, async t => {
  const originalBase = "b".repeat(40);
  const newBase = "c".repeat(40);
  const originalIntegration = "d".repeat(40);
  const newIntegration = "e".repeat(40);
  const workflowPath = ".github/workflows/verify.yml";
  const workflow = "name: Trusted verification\n";
  const workflowSha256 = createHash("sha256").update(workflow).digest("hex");
  let head = "";
  let base = originalBase;
  let integration = originalIntegration;
  let wrongSource = true;
  let changedWorkflow = false;
  let latestAttempt = 1;
  let attemptChanges = false;
  let merged = false;
  let baseChanges = false;
  let integratedCheckAvailable = true;
  const fixture = await releaseFixture(t, {
    githubSources: cwd => [{
      workspaceRoot: cwd, repository: "example/ling", repositoryId: "73",
      deliveryPolicies: [{ baseRef: "main", requiredChecks: [
        { name: "unit", appId: 19, workflowId: 5, workflowPath, workflowSha256, basis: "head", coverageRefs: ["unit-contracts"] },
        { name: "integration", appId: 19, workflowId: 6, workflowPath, workflowSha256, basis: "integration", coverageRefs: ["workflow-integration"] },
      ] }],
    }],
    externalWorkFetch: async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      const prefix = "/repos/example/ling";
      assert.ok(url.pathname.startsWith(prefix));
      const path = url.pathname.slice(prefix.length);
      if (path === "") return Response.json({ id: 73, full_name: "example/ling" });
      if (path === "/pulls/12") return Response.json({
        number: 12, title: "Fix replay", state: merged ? "closed" : "open", merged,
        base: { sha: originalBase, ref: "main", repo: { id: 73 } }, head: { sha: head }, merge_commit_sha: integration,
      });
      if (path === "/git/ref/heads/main") return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: base } });
      if (path === `/git/commits/${integration}`) return Response.json({
        sha: integration, parents: [{ sha: integration === originalIntegration ? originalBase : newBase }, { sha: head }],
      });
      const subject = url.searchParams.get("head_sha");
      const run = subject === head ? { id: 15, workflow_id: 5, head_sha: head, name: "unit" }
        : { id: 16, workflow_id: 6, head_sha: integration, name: "integration" };
      if (path === `/actions/workflows/${run.workflow_id}/runs`) {
        if (baseChanges && subject === integration) base = newBase;
        const workflow_runs = subject === integration && !integratedCheckAvailable ? [] : [{
          ...run, created_at: "2026-11-22T00:00:00Z", run_attempt: latestAttempt, status: "completed",
          path: workflowPath, event: "push",
        }];
        return Response.json({ total_count: workflow_runs.length, workflow_runs });
      }
      if (path === `/contents/${workflowPath}`) return Response.json({
        type: "file", path: workflowPath, encoding: "base64",
        content: Buffer.from(changedWorkflow ? "name: Replaced verification\n" : workflow).toString("base64"),
      });
      const runId = path.includes("/15") || path.includes(head) ? 15 : 16;
      const testedCommit = runId === 15 ? head : integration;
      const name = runId === 15 ? "unit" : "integration";
      const checkRunId = 100 + runId;
      const checkRunUrl = `https://api.github.com${prefix}/check-runs/${checkRunId}`;
      if (path === `/actions/runs/${runId}/attempts/${latestAttempt}/jobs`) {
        return Response.json({ total_count: 1, jobs: [{
          id: 200 + runId, run_id: runId, head_sha: testedCommit, name, check_run_url: checkRunUrl,
          status: "completed", conclusion: "success",
        }] });
      }
      if (path === `/commits/${testedCommit}/check-runs`) return Response.json({ total_count: 1, check_runs: [{
        id: checkRunId, name, head_sha: testedCommit, status: "completed", conclusion: "success", url: checkRunUrl,
        app: { id: wrongSource && runId === 16 ? 27 : 19 },
      }] });
      if (path === `/actions/runs/${runId}`) return Response.json({ id: runId, run_attempt: attemptChanges ? latestAttempt + 1 : latestAttempt });
      return Response.json({}, { status: 404 });
    },
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, encoding: "utf8" }).trim();
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  git("init", "-q", "-b", "main");
  git("add", ".gitignore");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Baseline");
  const replayFile = join(fixture.cwd, "replay.txt");
  await writeFile(replayFile, "accepted replay\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Candidate");
  head = git("rev-parse", "HEAD");
  const client = await fixture.connect();
  const created = await client.call<LingAppServerWorkItemResult>("workItem/create", { sourceId: "delivery", title: "Fix replay" });
  const { workItemId } = created.workItem;
  const accepted = await client.call<LingAppServerWorkItemResult>("workItem/accept", {
    workItemId, expectedWorkItemRevision: Number(created.workItem.revision), idempotencyKey: "accept-delivery",
  });
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Fix replay" });
  const { candidate } = await client.call<LingAppServerCaptureChangesResult>("changes/capture");
  const input = { workItemId, threadId: thread.id, expectedWorkItemRevision: Number(accepted.workItem.revision),
    repository: "example/ling", pullRequestNumber: 12, candidateDigest: candidate.candidateDigest };
  const reconcile = async (connection = client) => (await connection.call<LingAppServerGitHubDeliveryResult>("github/delivery/reconcile", input)).delivery;

  assert.deepEqual((await reconcile()).checks.map(check => check.outcome), ["passed", "pending"]);
  wrongSource = false;
  changedWorkflow = true;
  assert.equal((await reconcile()).checks[0]?.reason, "workflow_source_changed");
  changedWorkflow = false;
  const initial = await reconcile();
  assert.equal(initial.status, "delivery_pending");
  assert.deepEqual(await reconcile(), initial);
  baseChanges = true;
  await assert.rejects(reconcile(), { code: "stale_revision" });
  baseChanges = false;
  const advanced = await reconcile();
  assert.equal(advanced.baseCommit, newBase);
  assert.deepEqual(advanced.checks.map(check => [check.outcome, check.testedCommit]), [["passed", head], ["unavailable", undefined]]);
  integration = newIntegration;
  integratedCheckAvailable = false;
  assert.equal((await reconcile()).status, "ci_pending");
  integratedCheckAvailable = true;
  attemptChanges = true;
  await assert.rejects(reconcile(), { code: "stale_revision" });
  attemptChanges = false;
  latestAttempt = 2;
  const current = await reconcile();
  assert.deepEqual(current.checks.map(check => [check.testedCommit, check.runAttempt]), [[head, 2], [newIntegration, 2]]);
  const { delivery: old } = await client.call<LingAppServerGitHubDeliveryResult>("delivery/read", {
    workItemId, deliveryId: initial.deliveryId,
  });
  assert.deepEqual(old, initial);

  await client.call("thread/goal/set", { threadId: thread.id, objective: "Deliver the verified fix",
    acceptanceCriteria: [{ id: "merged", description: "Trusted checks on the merged candidate", kind: "github_delivered",
      githubDelivery: { workItemId, policyRevision: current.policyRevision } }] });
  const complete = (connection: typeof client, deliveryId: string) => {
    const evidence = { kind: "github_delivery", id: deliveryId };
    return connection.call<{ goal: LingThreadGoal }>("thread/goal/complete", {
      threadId: thread.id, actor: "ling-agent", completionVerificationSummary: "Confirmed merge and required checks.",
      evidenceRefs: [evidence], acceptanceEvidence: [{ criterionId: "merged", evidence }],
    });
  };
  await assert.rejects(complete(client, current.deliveryId), { code: "goal_completion_evidence_invalid" });
  merged = true;
  await writeFile(replayFile, "subsequent local changes\n");
  const { candidate: dirty } = await client.call<LingAppServerCaptureChangesResult>("changes/capture");
  assert.notEqual(dirty.candidateDigest, candidate.candidateDigest);
  const committed = await client.call<LingAppServerCaptureChangesResult>("changes/capture", { scope: "head" });
  assert.equal(committed.headCommit, head);
  assert.equal(committed.candidate.candidateDigest, candidate.candidateDigest);
  await assert.rejects(client.call("github/delivery/reconcile", { ...input, candidateDigest: dirty.candidateDigest }), { code: "candidate_stale" });
  const delivered = await reconcile();
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.mergedCommit, newIntegration);
  await assert.rejects(complete(client, delivered.deliveryId), { code: "goal_completion_evidence_invalid" });
  assert.equal(await readFile(replayFile, "utf8"), "subsequent local changes\n");
  await writeFile(replayFile, "accepted replay\n");
  await fixture.restart();
  const restored = await fixture.connect();
  assert.deepEqual((await restored.call<LingAppServerGitHubDeliveryResult>("workItem/delivery/read", { workItemId })).delivery, delivered);
  latestAttempt = 3;
  await assert.rejects(complete(restored, delivered.deliveryId), { code: "goal_completion_evidence_invalid" });
  const fresh = await reconcile(restored);
  assert.equal((await complete(restored, fresh.deliveryId)).goal.status, "complete");
});

test("GitHub delivery requires current queue membership and a provider-attested merge group check", { timeout: 30_000 }, async t => {
  const workflowPath = ".github/workflows/verify.yml";
  const workflow = "name: Verify\non: merge_group\n";
  const check = { name: "queue-verification", appId: 19, workflowId: 5, workflowPath,
    workflowSha256: createHash("sha256").update(workflow).digest("hex"), basis: "merge_group" as const, coverageRefs: ["queue-integration"] };
  const repository = "example/ling";
  const credential = randomUUID();
  const requiredGate = { name: "trusted-queue-gate", appId: 71 };
  const originalBase = "b".repeat(40);
  const advancedBase = "c".repeat(40);
  const firstGroup = "d".repeat(40);
  const secondGroup = "e".repeat(40);
  const finalCommit = "f".repeat(40);
  const tree = "1".repeat(40);
  let head = "";
  let base = originalBase;
  let entryBase = originalBase;
  let group = firstGroup;
  let unrelatedHead = true;
  let selectionChanges = false;
  let checkedEvent = "push";
  let merged = false;
  let finalTree = "2".repeat(40);
  let guardPresent = false;
  let queuePresent = false;
  let queueStarts = 0;
  const fixture = await releaseFixture(t, {
    recoveryJournal: true,
    secretResolver: createEnvSecretResolver({ LING_QUEUE_FIXTURE_AUTH: credential }),
    githubSources: cwd => [{
      workspaceRoot: cwd, repository, repositoryId: "73", secretRef: "env:LING_QUEUE_FIXTURE_AUTH",
      deliveryPolicies: [{ baseRef: "main", requiredChecks: [check], mergeQueue: { requiredGate } }],
    }],
    externalWorkFetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname === "/graphql") {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer " + credential);
        const request = JSON.parse(String(init.body));
        if (request.query.startsWith("mutation LingEnqueue")) {
          assert.equal(request.variables.id, "pr-13");
          assert.equal(request.variables.head, head);
          assert.equal(queuePresent, false);
          queuePresent = true;
          queueStarts++;
          throw new Error("The fixture loses the response after the provider accepts.");
        }
        assert.deepEqual(request.variables, { owner: "example", name: "ling", number: 13 });
        assert.match(request.query, /mergeQueueEntry/);
        const pullRequest = { number: 13, headRefOid: head, baseRefName: "main" };
        const attributed = { ...pullRequest, headRefOid: unrelatedHead ? "9".repeat(40) : head };
        const observeEntry = request.query.startsWith("query LingQueueSubject") ? pullRequest : attributed;
        return Response.json({ data: { repository: { fullDatabaseId: "73", nameWithOwner: repository,
          pullRequest: { ...pullRequest, id: "pr-13", isInMergeQueue: queuePresent, closed: merged, merged, isDraft: false,
            isMergeQueueEnabled: true, stackEntry: null, mergeQueueEntry: queuePresent ? {
              id: "entry-13", baseCommit: { oid: entryBase }, headCommit: { oid: group, tree: { oid: tree } }, pullRequest: observeEntry,
            } : null } } } });
      }
      const prefix = "/repos/" + repository;
      assert.ok(url.pathname.startsWith(prefix));
      const path = url.pathname.slice(prefix.length);
      if (!path) return Response.json({ id: 73, full_name: repository });
      if (path === "/pulls/13") return Response.json({
        number: 13, title: "Queue changes", state: merged ? "closed" : "open", merged,
        base: { sha: base, ref: "main", repo: { id: 73 } }, head: { sha: head },
        ...(merged ? { merge_commit_sha: finalCommit } : {}),
      });
      if (path === "/git/ref/heads/main") return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: base } });
      if (path === "/rules/branches/main") return Response.json(guardPresent ? [
        { type: "merge_queue" }, { type: "required_status_checks", parameters: { required_status_checks: [
          { context: check.name, integration_id: check.appId }, { context: requiredGate.name, integration_id: requiredGate.appId },
        ] } },
      ] : []);
      if (path === `/git/commits/${finalCommit}`) return Response.json({ sha: finalCommit, parents: [{ sha: base }], tree: { sha: finalTree } });
      if (path === "/actions/workflows/5/runs") {
        const tested = url.searchParams.get("head_sha");
        assert.equal(tested, group);
        if (selectionChanges) group = secondGroup;
        return Response.json({ total_count: 1, workflow_runs: [{ id: 15, workflow_id: 5, head_sha: tested, created_at: "2026-11-22T00:00:00Z",
          run_attempt: 1, status: "completed", path: workflowPath, event: checkedEvent }] });
      }
      const checkUrl = `https://api.github.com${prefix}/check-runs/16`;
      if (path === `/contents/${workflowPath}`) return Response.json({
        type: "file", path: workflowPath, encoding: "base64", content: Buffer.from(workflow).toString("base64"),
      });
      if (path === "/actions/runs/15/attempts/1/jobs") return Response.json({ total_count: 1, jobs: [{
        id: 17, run_id: 15, head_sha: selectionChanges ? firstGroup : group,
        name: check.name, check_run_url: checkUrl, status: "completed", conclusion: "success",
      }] });
      if (path.startsWith("/commits/") && path.endsWith("/check-runs")) return Response.json({ total_count: 1, check_runs: [{
        id: 16, name: check.name, head_sha: path.split("/")[2], status: "completed", conclusion: "success", url: checkUrl, app: { id: 19 },
      }] });
      if (path === "/actions/runs/15") return Response.json({ id: 15, run_attempt: 1 });
      return Response.json({}, { status: 404 });
    },
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, encoding: "utf8" }).trim();
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Candidate");
  head = git("rev-parse", "HEAD");
  const client = await fixture.connect();
  const { workItem } = await client.call<LingAppServerWorkItemResult>("workItem/create", { sourceId: "queue", title: "Queue changes" });
  const accepted = await client.call<LingAppServerWorkItemResult>("workItem/accept", {
    workItemId: workItem.workItemId, expectedWorkItemRevision: Number(workItem.revision), idempotencyKey: "accept-queue",
  });
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Verify merge queue" });
  const { candidate } = await client.call<LingAppServerCaptureChangesResult>("changes/capture");
  const reconcile = async () => (await client.call<LingAppServerGitHubDeliveryResult>("github/delivery/reconcile", {
    workItemId: workItem.workItemId, threadId: thread.id, expectedWorkItemRevision: Number(accepted.workItem.revision),
    candidateDigest: candidate.candidateDigest, repository, pullRequestNumber: 13,
  })).delivery;
  const beforeQueue = await reconcile();
  assert.equal(beforeQueue.checks[0]?.reason, "merge_group_membership_unavailable");
  const enqueue = { workItemId: workItem.workItemId, deliveryId: beforeQueue.deliveryId,
    expectedWorkItemRevision: Number(accepted.workItem.revision), idempotencyKey: "enqueue-once", confirmed: true };
  await assert.rejects(client.call("github/delivery/enqueue", enqueue), { code: "github_queue_guard_unavailable" });
  assert.equal(queueStarts, 0);
  guardPresent = true;
  const uncommitted = join(fixture.cwd, "local-only.txt");
  await writeFile(uncommitted, "Uncommitted queue input\n");
  await assert.rejects(client.call("github/delivery/enqueue", enqueue), { code: "candidate_stale" });
  assert.equal(queueStarts, 0);
  await unlink(uncommitted);
  const first = await client.call<LingAppServerGitHubQueueResult>("github/delivery/enqueue", enqueue);
  assert.equal(first.receipt.status, "unknown");
  const queued = await client.call<LingAppServerGitHubQueueResult>("github/delivery/enqueue", enqueue);
  assert.equal(queued.receipt.status, "enqueued");
  assert.equal(queued.receipt.queueEntryId, "entry-13");
  assert.equal(queueStarts, 1);
  const { queueReceiptId } = queued.receipt;
  assert.ok(fixture.getStore().deleteAppServerState("github_queue_intent", queueReceiptId));
  assert.deepEqual(await client.call<LingAppServerGitHubQueueResult>("github/delivery/queue/read", {
    workItemId: workItem.workItemId, queueReceiptId,
  }), queued);
  assert.equal(queueStarts, 1);
  assert.equal((await reconcile()).checks[0]?.reason, "merge_group_membership_unavailable");
  unrelatedHead = false;
  assert.equal((await reconcile()).checks[0]?.reason, "applicable_check_missing");
  checkedEvent = "merge_group";
  const ready = await reconcile();
  assert.equal(ready.mergeGroup?.testedCommit, firstGroup);
  assert.equal(ready.checks[0]?.outcome, "passed");
  selectionChanges = true;
  await assert.rejects(reconcile(), { code: "stale_revision" });
  selectionChanges = false;
  base = advancedBase;
  assert.equal((await reconcile()).checks[0]?.reason, "merge_group_membership_unavailable");
  entryBase = advancedBase;
  const replacement = await reconcile();
  assert.equal(replacement.mergeGroup?.testedCommit, secondGroup);
  assert.notEqual(replacement.mergeGroup?.membershipProofRef, ready.mergeGroup?.membershipProofRef);
  merged = true;
  assert.equal((await reconcile()).status, "ci_pending");
  // Observe the current group again before testing the actual matching squash result.
  merged = false;
  await reconcile();
  merged = true;
  finalTree = tree;
  const delivered = await reconcile();
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.mergedCommit, finalCommit);
  assert.equal(delivered.checks[0]?.testedCommit, secondGroup);
});

test("Work Item creation, acceptance, evidence and collaboration retries keep one event per committed revision", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const peer = await fixture.connect();
  const workItemId = "idempotent-events";
  await peer.call("workItem/subscribe", { workItemId });
  const notices = (method: string) => peer.notices.filter(notice => notice.method === method && notice.params?.subject?.workItemId === workItemId);
  const creation = { sourceId: "app-server-evidence", workItemId, title: "Record task evidence", idempotencyKey: "create-once" };
  await assert.rejects(client.call("workItem/create", { ...creation, cwd: fixture.root }), { code: "workspace_binding_invalid" });
  const [created, replayed] = await Promise.all([
    client.call<LingAppServerWorkItemResult>("workItem/create", creation),
    peer.call<LingAppServerWorkItemResult>("workItem/create", creation),
  ]);
  const { workItem } = created;
  assert.deepEqual(replayed, created);
  assert.equal(workItem.workItemId, workItemId);
  assert.equal(workItem.revision, "1");
  await waitFor(() => notices("workItem/created")[0]);
  assert.deepEqual(await peer.call("workItem/create", { ...creation, idempotencyKey: "same-source-another-entry" }), created);
  await assert.rejects(client.call("workItem/create", { ...creation, sourceId: "different-source" }), { code: "idempotency_conflict" });
  const acceptance = { workItemId, expectedWorkItemRevision: Number(workItem.revision), idempotencyKey: "accept-once" };
  const accepted = await client.call<{ workItem: LingAppServerWorkItemSnapshot }>("workItem/accept", acceptance);
  await waitFor(() => notices("workItem/status/changed").length > 0 ? true : undefined);
  assert.equal((await client.call<{ replayed: boolean }>("workItem/accept", acceptance)).replayed, true);
  const evidence = {
    workItemId, expectedWorkItemRevision: Number(accepted.workItem.revision), expectedEvidenceRevision: 0,
    subjectRevision: accepted.workItem.revision, actorId: "local-user", kind: "observation",
    content: "Evidence recorded once", idempotencyKey: "append-once",
  };
  type EvidenceResult = { status: string; entry: { id: string }; workItemRevision: number };
  const appended = await client.call<EvidenceResult>("workItem/evidence/append", evidence);
  assert.equal(appended.status, "appended");
  await waitFor(() => notices("workItem/evidence/updated").length > 0 ? true : undefined);
  const replay = await client.call<EvidenceResult>("workItem/evidence/append", evidence);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.entry.id, appended.entry.id);
  await assert.rejects(client.call("workItem/evidence/append", { ...evidence, content: "Conflicting evidence" }), { code: "idempotency_conflict" });
  const secondEvidence = await client.call<EvidenceResult>("workItem/evidence/append", {
    ...evidence, expectedWorkItemRevision: appended.workItemRevision, expectedEvidenceRevision: 1, idempotencyKey: "append-next",
  });
  await waitFor(() => notices("workItem/evidence/updated").length >= 2 ? true : undefined);
  const { cursor: beforeMessage } = await peer.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  const messageInput = {
    workItemId, expectedWorkItemRevision: secondEvidence.workItemRevision, expectedCollaborationRevision: 2,
    actorId: "local-user", idempotencyKey: "message-once", payload: { text: "Send after the evidence is committed" },
  };
  const message = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/message/send", messageInput);
  const collaborationNotice = await waitFor(() => notices("workItem/collaboration/updated")[0]);
  const directNotice = await waitFor(() => client.notices.find(notice => notice.method === "workItem/message/updated"));
  assert.ok(collaborationNotice.params?.eventId);
  assert.equal(directNotice.params?.eventId, collaborationNotice.params.eventId);
  const messageReplay = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/message/send", messageInput);
  assert.equal(messageReplay.status, "replayed");
  assert.equal(messageReplay.record.id, message.record.id);
  await assert.rejects(client.call("workItem/message/send", { ...messageInput, payload: { text: "Conflicting message" } }), { code: "idempotency_conflict" });
  assert.equal(client.notices.filter(notice => notice.method === "workItem/message/updated").length, 1);
  assert.equal(notices("workItem/created").length, 1);
  assert.equal(notices("workItem/status/changed").length, 1);
  assert.equal(notices("workItem/evidence/updated").length, 2);
  const persisted = fixture.getStore().listControlPlaneEvents({ workspaceId: workItem.workspaceId, entityId: workItemId });
  assert.deepEqual(persisted.map(event => event.action), [
    "work_item.created", "work_item.accepted", "work_item.evidence.updated", "work_item.evidence.updated", "work_item.collaboration.message.created",
  ]);
  await fixture.restart();
  const restored = await fixture.connect();
  const { cwd, workItem: restoredItem } = await restored.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  assert.deepEqual(await restored.call("workItem/create", creation), { cwd, workItem: restoredItem });
  await assert.rejects(restored.call("workItem/create", { ...creation, title: "Changed intent" }), { code: "idempotency_conflict" });
  await restored.call("workItem/subscribe", { workItemId, cursor: beforeMessage });
  const restoredNotice = await waitFor(() => restored.notices.find(notice => notice.method === "workItem/collaboration/updated"));
  assert.equal(restoredNotice.params?.eventId, directNotice.params?.eventId);

  const { daemonUrl, authToken } = fixture.transportOptions();
  const url = new URL("/app-server/rpc", daemonUrl);
  url.protocol = "ws:";
  url.searchParams.set("cwd", fixture.cwd);
  const sdk = new LingAppServerClient({
    url: url.href, clientInfo: { name: "work-item-acceptance", version: "1" }, autoReconnect: false,
    createSocket: address => new WebSocket(address, { headers: { Authorization: `Bearer ${authToken}` } }) as unknown as LingAppServerSocket,
  });
  t.after(() => sdk.close());
  const current = await sdk.readWorkItem(workItem.workspaceId, workItemId);
  assert.equal(current.workItemId, workItemId);
  assert.equal(current.revision, String(message.workItemRevision));
  const control = { workspaceId: workItem.workspaceId, workItemId, actorId: "local-user" };
  const paused = await sdk.controlWorkItem("pause", { ...control, idempotencyKey: "sdk-pause",
    expectedWorkItemRevision: Number(current.revision), expectedControlGeneration: Number(current.control.generation) });
  assert.equal(paused.control.state, "paused");
  const resumed = await sdk.controlWorkItem("resume", { ...control, idempotencyKey: "sdk-resume",
    expectedWorkItemRevision: Number(paused.revision), expectedControlGeneration: Number(paused.control.generation) });
  assert.equal(resumed.control.state, "active");
  assert.equal((await sdk.readWorkItem(workItem.workspaceId, workItemId)).revision, resumed.revision);
});

test("existing channel and Automation executions link once without starting another Run", { timeout: 25_000 }, async t => {
  const provider = await startLoopbackPiProvider(async () => ({ text: "Original automation complete" }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  const [operator, peer] = await Promise.all([fixture.connect(), fixture.connect()]);
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "Existing work", boundPath: fixture.cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Original channel task", prompt: "Use the original task owner." }, now);
  const thread = store.createLingThread({ kind: "automation", title: "Original automation", objective: "Complete one check" }, now);
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const automation = store.createAutomationDefinition({
    threadId: thread.id, title: "Original automation", kind: "custom_prompt", trigger: { type: "manual" },
    target: { scope: "workspace", workspaceId: thread.workspaceId }, executionPolicy: { providerPresetId: preset.id },
    promptTemplate: { templateVersion: 1, promptMarkdown: "Provide a short check result.", contextSelectors: [] },
    outputPolicy: { artifactFormat: "markdown", destinations: [{ type: "automation_thread" }] },
  }, now);
  const { authToken, daemonUrl } = fixture.transportOptions();
  const write = (path: string, body: unknown) => fetch(`${daemonUrl}${path}?cwd=${encodeURIComponent(fixture.cwd)}`, {
    method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
  });
  const runReply = await write(`/automations/${automation.id}/run`, { idempotencyKey: "source-automation-run" });
  assert.ok(runReply.ok, await runReply.clone().text());
  const { automationRun } = await runReply.json() as { automationRun: { id: string } };
  const original = await waitFor(() => {
    const run = store.getAutomationRun(automationRun.id);
    return run?.status === "succeeded" ? run : undefined;
  });
  assert.ok(original.runId);
  const link = (connection: typeof operator, sourceType: "channel_task" | "automation_run", sourceId: string, idempotencyKey: string) =>
    connection.call<LingAppServerWorkItemResult>("workItem/create", {
      sourceType, sourceId, idempotencyKey, title: "Track current execution", linkExistingExecution: true,
    });
  await assert.rejects(link(operator, "automation_run", "unknown-occurrence", "unknown-execution"), { code: "workspace_binding_invalid" });
  const [first, duplicate] = await Promise.all([
    link(operator, "automation_run", original.id, "automation-entry"),
    link(peer, "automation_run", original.id, "controller-entry"),
  ]);
  assert.deepEqual(first, duplicate);
  assert.deepEqual(first.workItem.linkedExecution, { kind: "automation_run", id: original.id, runId: original.runId, status: "succeeded" });
  assert.ok(first.workItem.currentExecutionRefs.includes(original.id));
  const linkedTask = await link(operator, "channel_task", task.id, "channel-entry");
  assert.deepEqual(linkedTask.workItem.linkedExecution, { kind: "channel_task", id: task.id, status: "todo" });
  const workItemId = linkedTask.workItem.workItemId;
  const claim = await write(`/work-items/${workItemId}/claim`, { ownerId: "legacy-claim" });
  assert.equal((await claim.json() as { blocker?: { code: string } }).blocker?.code, "control_blocked");
  const before = { workItemId, expectedWorkItemRevision: Number(linkedTask.workItem.revision) };
  await assert.rejects(operator.call("workItem/accept", { ...before, idempotencyKey: "try-second-owner" }), { code: "stale_revision" });
  await assert.rejects(operator.call("workItem/cancel", {
    ...before, expectedControlGeneration: 0, idempotencyKey: "try-cancel-source", actorId: "local-user",
  }), { code: "resume_blocked" });
  assert.equal(store.getTask(task.id)?.status, "todo");
  store.updateTask(task.id, { status: "cancelled" }, new Date().toISOString());
  await fixture.restart();
  const restored = await fixture.connect();
  const taskProjection = await restored.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  assert.equal(taskProjection.workItem.linkedExecution?.status, "cancelled");
  assert.equal((await link(restored, "automation_run", original.id, "automation-entry")).workItem.workItemId, first.workItem.workItemId);
  assert.deepEqual(fixture.getStore().listRuns().map(run => run.id), [original.runId]);
  assert.equal(provider.requests.length, 1);
});

test("an operator resolves a deliberation round once against its current revision", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const [operator, peer] = await Promise.all([fixture.connect(), fixture.connect()]);
  const { workItem } = await operator.call<LingAppServerWorkItemResult>("workItem/create", {
    sourceId: "review-choices", title: "Review compatibility options",
  });
  const workItemId = workItem.workItemId;
  const start = (expectedWorkItemRevision: number, idempotencyKey: string, connection = operator) => connection.call<LingAppServerWorkItemCollaborationAppendResult>(
    "workItem/deliberation/start", { workItemId, expectedWorkItemRevision, actorId: "coordinator", idempotencyKey,
      payload: { decisionPoint: "Choose a compatibility approach", options: ["adapter", "migration"] } });
  const round = await start(Number(workItem.revision), "review-start");
  const before = await operator.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  await peer.call("workItem/subscribe", { workItemId, cursor: before.cursor });
  const decision: LingAppServerDeliberationDecideParams = {
    workItemId, roundId: round.record.id, expectedRoundRevision: round.record.collaborationRevision,
    expectedWorkItemRevision: round.workItemRevision, idempotencyKey: "choose-adapter", reason: "Preserve the public interface",
    decision: { disposition: "selected", option: "adapter" },
  };
  const decide = (input: LingAppServerDeliberationDecideParams, connection = operator) =>
    connection.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/deliberation/decide", input);
  await assert.rejects(decide({ ...decision, expectedRoundRevision: round.record.collaborationRevision + 1 }), { code: "stale_revision" });
  await assert.rejects(decide({ ...decision, decision: { disposition: "selected", option: "unproposed" } }), { code: "invalid_params" });

  const paused = await operator.call<LingAppServerWorkItemControlResult>("workItem/pause", {
    workItemId, actorId: "local-user", expectedWorkItemRevision: Number(before.workItem.revision),
    expectedControlGeneration: 0, idempotencyKey: "review-pause",
  });
  await assert.rejects(decide({ ...decision, expectedWorkItemRevision: Number(paused.workItem.revision) }), { code: "resume_blocked" });
  const resumed = await operator.call<LingAppServerWorkItemControlResult>("workItem/resume", {
    workItemId, actorId: "local-user", expectedWorkItemRevision: Number(paused.workItem.revision),
    expectedControlGeneration: 1, idempotencyKey: "review-resume",
  });
  const first = { ...decision, expectedWorkItemRevision: Number(resumed.workItem.revision) };
  const second: LingAppServerDeliberationDecideParams = { ...first, idempotencyKey: "choose-migration", reason: "Remove the obsolete shape",
    decision: { disposition: "selected", option: "migration" } };
  await assert.rejects(decide(decision), { code: "stale_revision" });

  const requests = [first, second] as const;
  const answers = await Promise.allSettled([decide(first), decide(second, peer)]);
  const winningIndex = answers.findIndex(result => result.status === "fulfilled");
  const winner = answers[winningIndex];
  const loser = answers[1 - winningIndex];
  assert.ok(winner?.status === "fulfilled");
  assert.ok(loser?.status === "rejected");
  assert.equal((loser.reason as { code: string }).code, "stale_revision");
  assert.equal(winner.value.record.action, "decided");
  assert.equal(winner.value.record.parentRecordId, round.record.id);
  const update = await waitFor(() => peer.notices.find(notice => notice.method === "workItem/deliberation/updated"
    && notice.params?.event?.action === "work_item.deliberation.decided"));
  assert.ok(update.params?.eventId);

  await fixture.restart();
  const restored = await fixture.connect();
  await restored.call("workItem/subscribe", { workItemId, cursor: before.cursor });
  await waitFor(() => restored.notices.find(notice => notice.params?.eventId === update.params?.eventId));
  const read = await restored.call<LingAppServerWorkItemCollaborationReadResult>("workItem/deliberation/read", { workItemId });
  assert.deepEqual(read.records.map(record => record.id), [round.record.id, winner.value.record.id]);
  const winningInput = requests[winningIndex]!;
  const replay = await decide(winningInput, restored);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.record.id, winner.value.record.id);
  await assert.rejects(decide({ ...winningInput, reason: "Different reasoning" }, restored), { code: "idempotency_conflict" });
  const { decision: _, ...cancel } = winningInput;
  await assert.rejects(restored.call("workItem/deliberation/cancel", { ...cancel, idempotencyKey: "cannot-cancel-closed" }), { code: "stale_revision" });
  const nextRound = await start(replay.workItemRevision, "second-round", restored);
  const cancelled = await restored.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/deliberation/cancel", {
    ...cancel, roundId: nextRound.record.id, expectedRoundRevision: nextRound.record.collaborationRevision,
    expectedWorkItemRevision: nextRound.workItemRevision, idempotencyKey: "cancel-second-round", reason: "Wait for a new compatibility requirement",
  });
  assert.equal(cancelled.record.action, "cancelled");
  assert.equal(cancelled.record.parentRecordId, nextRound.record.id);
  assert.equal(fixture.getStore().listRuns().length, 0);
});

test("a GitHub Work Item recovers its Workflow, gathers independent ballots and releases one decision dependency", { timeout: 40_000 }, async t => {
  let completeContract: () => void = () => undefined;
  const contractGate = new Promise<void>(resolve => { completeContract = resolve; });
  let completeQaVote: () => void = () => undefined;
  const qaVoteGate = new Promise<void>(resolve => { completeQaVote = resolve; });
  let implementationReadRequested = false;
  const provider = await startLoopbackPiProvider(async (body: unknown, request: number) => {
    if (request === 1) await contractGate;
    const input = body as { stream: boolean; tools?: readonly unknown[]; messages: readonly { content: string | readonly { text?: string }[] }[] };
    const lastContent = input.messages.at(-1)?.content;
    if (input.stream === false && typeof lastContent === "string" && lastContent.includes('"workItem":')) {
      const source = JSON.parse(lastContent) as { items: readonly { id: string; text: string; verified: boolean }[] };
      const proof = source.items.find(entry => entry.verified && entry.text.includes("Verified compatibility input"));
      assert.ok(proof, "The Learning Review lacked the owned Run's read evidence.");
      return { text: JSON.stringify({ kind: "memory", title: "Compatibility input", body: "Read the verified compatibility input before implementation.",
        evidence: { evidenceId: proof.id, quote: "Verified compatibility input" } }) };
    }
    if (!implementationReadRequested && JSON.stringify(input.messages).includes("Accepted Plan decision:")) {
      implementationReadRequested = true;
      return { tool: "read", input: { path: "implementation-input.txt" } };
    }
    const prompt = input.messages.flatMap(message => typeof message.content === "string" ? [message.content]
      : message.content?.map(part => part.text ?? "") ?? []).join("\n");
    const ballotKey = /ballotKey "([a-f0-9]{64})"/u.exec(prompt)?.[1];
    if (ballotKey) {
      assert.equal(input.tools?.length ?? 0, 0);
      const isQa = prompt.includes("Assigned teammate: QA (");
      if (isQa) await qaVoteGate;
      const option = isQa ? "Migration" : "Adapter";
      return { text: JSON.stringify({ ballotKey, option, rationale: "Prefer the compatibility trade-off for this role." }) };
    }
    return { text: "Stage completed" };
  });
  t.after(async () => { completeContract(); completeQaVote(); await provider.close(); });
  const fixture = await releaseFixture(t, {
    githubSources: cwd => [{ workspaceRoot: cwd, repository: "example/ling", repositoryId: "73" }],
    externalWorkFetch: async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname === "/repos/example/ling") return Response.json({ id: 73, full_name: "example/ling" });
      assert.equal(url.pathname, "/repos/example/ling/issues/21");
      return Response.json({ number: 21, title: "Close the staged compatibility task", state: "open" });
    },
  });
  const [client, peer] = await Promise.all([fixture.connect(), fixture.connect()]);
  const intake = { gitHubSubject: { repository: "example/ling", kind: "issue", number: 21 }, title: "Close the staged compatibility task" };
  const [chat, codex] = await Promise.all([
    client.call<LingAppServerWorkItemResult>("workItem/create", { ...intake, sourceId: "staged-chat", idempotencyKey: "staged-chat" }),
    peer.call<LingAppServerWorkItemResult>("workItem/create", { ...intake, sourceId: "staged-codex", idempotencyKey: "staged-codex" }),
  ]);
  assert.deepEqual(codex.workItem, chat.workItem);
  assert.equal(chat.sourceReceipt?.targetKey, codex.sourceReceipt?.targetKey);
  const workItemId = chat.workItem.workItemId;
  const before = await client.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  await peer.call("workItem/subscribe", { workItemId, cursor: before.cursor });
  assert.deepEqual(before.workItem.currentExecutionRefs, []);
  const inputFile = join(fixture.cwd, "implementation-input.txt");
  await writeFile(inputFile, "Verified compatibility input\n");
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".gitignore", "implementation-input.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Freeze the staged input");
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "Workflow-owned work", boundPath: fixture.cwd,
    allowedTools: ["read"], defaultProviderPresetId: preset.id }, now);
  const thread = store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
    title: "Workflow plan", objective: "Bind an accepted plan to staged execution" }, now);
  const plan = store.upsertProposedPlanArtifact({ id: "plan_workflow_owned", threadId: thread.id, channelId: channel.id,
    title: "Staged implementation", bodyMarkdown: "Implement the staged change", status: "draft" }, now);
  const request = async (path: string, body?: object) => {
    const { daemonUrl, authToken } = fixture.transportOptions();
    const url = new URL(path, daemonUrl);
    url.searchParams.set("cwd", fixture.cwd);
    return fetch(url, {
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    });
  };
  const conversionPath = `/threads/${thread.id}/proposed-plans/${plan.id}/convert-workflow`;
  const p01Preview = { title: "P01 accept the contract", stageId: "P01", ownerId: "teammate_builtin_engineer", ownerLabel: "Engineer" };
  const p02Preview = { title: "P02 implement the selected approach", stageId: "P02", dependsOnStageIds: ["P01", "V-ENGINEER", "V-QA"],
    ownerId: "teammate_builtin_engineer", ownerLabel: "Engineer", requiredTools: ["read"],
    requiredDecision: { question: "Which compatible approach should this stage implement?", options: ["Adapter", "Migration"],
      trigger: "when_ready", ballot: { voterStageIds: ["V-ENGINEER", "V-QA"], quorum: 2 } } };
  const qaPreview = { title: "Prepare contract regression checks", stageId: "QA", dependsOnStageIds: ["P01"],
    handoffFromStageIds: ["P01"],
    ownerId: "teammate_builtin_qa", ownerLabel: "QA" };
  const ballots = [
    { title: "Review the compatibility options", stageId: "V-ENGINEER", dependsOnStageIds: ["P01"],
      ownerId: "teammate_builtin_engineer", ownerLabel: "Engineer" },
    { title: "Evaluate the regression impact", stageId: "V-QA", dependsOnStageIds: ["P01"],
      ownerId: "teammate_builtin_qa", ownerLabel: "QA" },
  ];
  const invalid = await request(conversionPath, { expectedRevision: plan.revision,
    workflowStepPreviews: [{ ...p01Preview, dependsOnStageIds: ["P02"] }, p02Preview, ...ballots] });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: string }).error, "bad_workflow_stage_dependencies");
  assert.equal(store.getProposedPlanArtifact(plan.id)?.revision, plan.revision);
  const planResponse = await request(conversionPath, { expectedRevision: plan.revision,
    workflowStepPreviews: [p02Preview, p01Preview, qaPreview, ...ballots] });
  assert.ok(planResponse.ok, await planResponse.clone().text());
  const converted = await planResponse.json() as ProposedPlanActionResponse;
  assert.ok(converted.workflowId);
  assert.equal(converted.plan.acceptedWorkflowId, converted.workflowId);
  const [p02, p01, qa, engineerVote, qaVote] = store.listChannelWorkflowSteps({ workflowId: converted.workflowId, complete: true });
  assert.ok(p01 && p02 && qa && engineerVote && qaVote);
  assert.deepEqual(p02.metadata?.dependsOnStepIds, [p01.id]);
  assert.deepEqual(qa.metadata?.dependsOnStepIds, [p01.id]);
  const startImplementation = () => request(`/workflow-steps/${encodeURIComponent(p02.id)}/start`, { mode: "create_and_run_task" });
  const unbound = await startImplementation();
  assert.equal(unbound.status, 409);
  assert.equal((await unbound.json() as { error: string }).error, "work_item_workflow_unbound");
  const item = store.getWorkItem(workItemId);
  assert.ok(item);
  const accepted = await client.call<LingAppServerWorkItemAcceptResult>("workItem/accept", {
    workItemId: item.id, expectedWorkItemRevision: item.revision, idempotencyKey: "workflow-owned-accept",
  });
  const bind = {
    workItemId: item.id, planId: plan.id, expectedPlanRevision: converted.plan.revision,
    expectedWorkItemRevision: Number(accepted.workItem.revision), idempotencyKey: "workflow-owned-bind",
  };
  await client.call("thread/subscribe", { threadId: thread.id });
  await assert.rejects(client.call("workItem/workflow/bind", { ...bind, expectedPlanRevision: plan.revision }), { code: "stale_revision" });
  const bound = await client.call<{
    binding: { workflowId: string; planRevision: number; threadId: string };
    workItem: LingAppServerWorkItemSnapshot;
  }>("workItem/workflow/bind", bind);
  assert.equal(bound.binding.workflowId, converted.workflowId);
  assert.equal(bound.binding.planRevision, converted.plan.revision);
  await waitFor(() => peer.notices.find(notice => notice.params?.event?.action === "work_item.workflow.linked"
    && notice.params.event.entityId === workItemId));
  const stages = await client.call<LingAppServerWorkItemCollaborationReadResult>("workItem/stage/read", { workItemId: item.id });
  assert.equal(stages.workflow?.workflowId, converted.workflowId);
  assert.deepEqual(stages.workflow?.steps.map(({ stageId, status }) => [stageId, status]),
    [["P02", "queued"], ["P01", "queued"], ["QA", "queued"], ["V-ENGINEER", "queued"], ["V-QA", "queued"]]);
  assert.equal(stages.workflow?.steps[0]?.admissionBlocker, "work_item_decision_pending");
  assert.equal(stages.workflow?.steps.find(step => step.stepId === engineerVote.id)?.admissionBlocker, "work_item_ballot_pending");
  const earlyVote = await request(`/workflow-steps/${encodeURIComponent(engineerVote.id)}/start`, { mode: "create_and_run_task" });
  assert.equal(earlyVote.status, 409);
  assert.equal((await earlyVote.json() as { error: string }).error, "work_item_ballot_pending");
  await assert.rejects(client.call("workItem/deliberation/start", {
    workItemId, workflowStepId: p02.id, expectedWorkItemRevision: Number(bound.workItem.revision), idempotencyKey: "before-contract",
  }), { code: "resume_blocked" });
  assert.ok(stages.workflow?.steps.every(step => step.briefBasis === undefined));
  const workflowPath = `/workflows/${encodeURIComponent(converted.workflowId)}/orchestrate`;
  const itemPath = `/work-items/${encodeURIComponent(item.id)}`;
  const start = await request(workflowPath, {});
  const started = await start.json() as { status: string; blocker?: string };
  assert.equal(started.status, "started", JSON.stringify(started));
  await waitFor(() => provider.requests.length === 1 ? true : undefined);

  const paused = await client.call<LingAppServerWorkItemControlResult>("workItem/pause", {
    workItemId: item.id, actorId: "local-user", expectedWorkItemRevision: Number(bound.workItem.revision), expectedControlGeneration: 0,
    idempotencyKey: "workflow-owned-pause", reason: "Hold before staged execution",
  });
  const response = await request(workflowPath, {});
  assert.equal(response.status, 200);
  const orchestration = await response.json() as { status: string; blocker?: string };
  assert.equal(orchestration.status, "blocked");
  assert.equal(orchestration.blocker, "work_item_workflow_held");
  const direct = await startImplementation();
  assert.equal(direct.status, 409);
  assert.equal((await direct.json()).error, "work_item_workflow_held");
  const legacyClaim = await request(`${itemPath}/claim`, { ownerId: "legacy-claim" });
  assert.equal(legacyClaim.status, 200);
  assert.equal((await legacyClaim.json()).blocker?.code, "control_blocked");
  assert.equal(paused.workItem.control.state, "paused");
  completeContract();
  await waitFor(() => store.getChannelWorkflowStep(p01.id)?.status === "succeeded" ? true : undefined);
  const stageEvent = await waitFor(() => peer.notices.find(event => event.method === "workItem/stage/updated"
    && event.params?.event?.data?.stepId === p01.id && event.params?.event?.data?.status === "succeeded"));
  assert.ok(stageEvent.params?.eventId);
  await waitFor(() => client.notices.find(event => event.method === "workItem/stage/updated"
    && event.params?.eventId === stageEvent.params?.eventId));
  const readBrief = (connection: typeof client) => connection.call<LingAppServerWorkItemCollaborationReadResult>(
    "workItem/stage/brief/read", { workItemId: item.id });
  const brief = (await readBrief(client)).workflow?.steps.find(step => step.stepId === p01.id);
  assert.ok(brief?.briefBasis);
  const [transition] = store.listStateTransitionEvents({ entityType: "workflow_step", entityId: p01.id, limit: 1 });
  assert.deepEqual(brief.briefBasis, { transitionId: transition?.id, committedAt: transition?.createdAt });
  assert.equal(transition?.toStatus, "succeeded");
  assert.equal(brief.runId, store.getChannelWorkflowStep(p01.id)?.runId);
  const observerSecret = randomBytes(32).toString("hex");
  const { grant } = await client.call<{ grant: LingAppServerGrant }>("server/grants/create", {
    label: "Observe staged work", subject: { kind: "workItem", id: item.id }, scopes: ["observe"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    credentialSha256: createHash("sha256").update(observerSecret).digest("hex"), idempotencyKey: "observe-staged-work",
  });
  const observer = await fixture.connect("/app-server/rpc", fixture.cwd, `las1.${grant.grantId}.${observerSecret}`);
  const observedBrief = (await readBrief(observer)).workflow?.steps.find(step => step.stepId === p01.id);
  assert.equal(observedBrief?.status, "succeeded");
  assert.equal(observedBrief.briefBasis, undefined);
  assert.equal(observedBrief.runId, undefined);
  assert.ok((await readBrief(observer)).workflow?.steps.every(step => step.decision === undefined));
  assert.equal(provider.requests.length, 1);
  await fixture.restart();
  const resumedClient = await fixture.connect();
  const replay = await resumedClient.call<{ replayed: boolean }>("workItem/workflow/bind", bind);
  assert.equal(replay.replayed, true);
  await resumedClient.call("workItem/subscribe", { workItemId: item.id, cursor: before.cursor });
  await waitFor(() => resumedClient.notices.find(event => event.params?.eventId === stageEvent.params?.eventId));
  const held = await resumedClient.call<LingAppServerWorkItemCollaborationReadResult>("workItem/stage/read", { workItemId: item.id });
  assert.equal(held.workflow?.admissionBlocker, "work_item_workflow_held");
  assert.deepEqual(held.workflow?.steps.map(step => step.status), ["queued", "succeeded", "queued", "queued", "queued"]);
  assert.deepEqual((await readBrief(resumedClient)).workflow?.steps.find(step => step.stepId === p01.id), brief);
  assert.equal(provider.requests.length, 1);
  await resumedClient.call<LingAppServerWorkItemControlResult>("workItem/resume", {
    workItemId: item.id, actorId: "local-user", expectedWorkItemRevision: Number(paused.workItem.revision),
    expectedControlGeneration: 1, idempotencyKey: "workflow-owned-resume",
  });
  const resumedStore = fixture.getStore();
  assert.equal(resumedStore.listRuns({ workflowStepId: p02.id }).length, 0);
  const pending = await startImplementation();
  assert.equal(pending.status, 409);
  assert.equal((await pending.json() as { error: string }).error, "work_item_decision_pending");
  const round = await waitFor(async () => {
    const rounds = await resumedClient.call<LingAppServerWorkItemCollaborationReadResult>("workItem/deliberation/read", { workItemId: item.id });
    return rounds.records.find(record => record.action === "started");
  });
  assert.deepEqual((round.payload as { options: readonly string[] }).options, ["Adapter", "Migration"]);
  assert.equal(round.actorId, "ling_agent");
  const qaStage = (await readBrief(resumedClient)).workflow?.steps.find(step => step.stepId === qa.id);
  const qaHandoff = qaStage?.handoffs?.[0];
  assert.equal(qaStage?.admissionBlocker, "work_item_handoff_pending");
  assert.equal(qaHandoff?.status, "awaiting_acceptance");
  assert.equal(qaHandoff.sourceStepId, p01.id);
  assert.equal(resumedStore.listRuns({ workflowStepId: qa.id }).length, 0);
  const qaDirectStart = await request(`/workflow-steps/${encodeURIComponent(qa.id)}/start`, { mode: "create_and_run_task" });
  assert.equal(qaDirectStart.status, 409);
  assert.equal((await qaDirectStart.json() as { error: string }).error, "work_item_handoff_pending");
  const itemBeforeHandoff = await resumedClient.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  assert.ok(itemBeforeHandoff.workItem.planRevision && qaStage);
  const changeBasis = { workItemId, planRevision: itemBeforeHandoff.workItem.planRevision };
  const contractChange = await resumedClient.call<LingAppServerWorkItemPlanChangeResult>("workItem/plan/change/request", {
    ...changeBasis, expectedWorkItemRevision: Number(itemBeforeHandoff.workItem.revision),
    affectedStageIds: ["P01"], reason: "Inspect the impact of changing the contract", idempotencyKey: "contract-scope",
  });
  assert.deepEqual(new Set(contractChange.receipt.affectedStepIds), new Set([p01.id, p02.id, qa.id, engineerVote.id, qaVote.id]));
  assert.equal((await readBrief(resumedClient)).workflow?.steps.find(step => step.stepId === qa.id)?.admissionBlocker,
    "work_item_plan_change_pending");
  const withdrawn = await resumedClient.call<LingAppServerWorkItemPlanChangeResult>("workItem/plan/change/withdraw", {
    ...changeBasis, expectedWorkItemRevision: Number(contractChange.workItem.revision),
    changeId: contractChange.receipt.changeId, idempotencyKey: "withdraw-contract-scope",
  });
  assert.equal(withdrawn.receipt.status, "withdrawn");
  assert.equal(withdrawn.workItem.control.state, "active");
  const offeredHandoff = { workItemId, planRevision: itemBeforeHandoff.workItem.planRevision,
    sourceStepId: p01.id, targetStepId: qa.id, expectedSourceRevision: qaHandoff.sourceRevision, expectedTargetRevision: qaStage.updatedAt,
    expectedWorkItemRevision: Number(withdrawn.workItem.revision), idempotencyKey: "qa-review-contract" };
  await assert.rejects(resumedClient.call("workItem/handoff/return", {
    ...offeredHandoff, expectedWorkItemRevision: Number(itemBeforeHandoff.workItem.revision), reason: "required_check_incomplete",
  }), { code: "stale_revision" });
  await assert.rejects(resumedClient.call("workItem/handoff/return", { ...offeredHandoff, expectedSourceRevision: new Date(0).toISOString(),
    reason: "candidate_stale" }), { code: "stale_revision" });
  const returnedHandoff = await resumedClient.call<LingAppServerWorkItemCollaborationAppendResult>(
    "workItem/handoff/return", { ...offeredHandoff, reason: "required_check_incomplete" });
  const returnedStage = (await readBrief(resumedClient)).workflow?.steps.find(step => step.stepId === qa.id);
  assert.equal(returnedStage?.handoffs?.[0]?.status, "returned");
  assert.equal(returnedStage.handoffs[0]?.reason, "required_check_incomplete");
  assert.equal(resumedStore.listRuns({ workflowStepId: qa.id }).length, 0);
  await assert.rejects(resumedClient.call("workItem/handoff/accept", {
    ...offeredHandoff, expectedWorkItemRevision: returnedHandoff.workItemRevision, idempotencyKey: "qa-accept-returned",
  }), { code: "stale_revision" });
  const oldSource = resumedStore.getChannelWorkflowStep(p01.id);
  const oldPacket = oldSource?.metadata?.outputArtifactId ? resumedStore.getArtifact(oldSource.metadata.outputArtifactId) : undefined;
  assert.ok(oldSource && oldPacket?.sealedPayload);
  const repairedAt = new Date(Date.parse(oldSource.updatedAt) + 1).toISOString();
  const revisedPacket = { ...(oldPacket.sealedPayload as Record<string, unknown>), resultSummary: "The current contract checks are complete." };
  const revisedPath = oldPacket.path.replace(/\.json$/u, "-repaired.json");
  const revisedBytes = JSON.stringify(revisedPacket);
  await writeFile(join(resumedStore.paths.artifactsDir, revisedPath), revisedBytes);
  const revisedArtifact = resumedStore.createArtifact({
    runId: oldPacket.runId, type: oldPacket.type, title: oldPacket.title, contentType: oldPacket.contentType,
    sealedPayload: revisedPacket, path: revisedPath, sizeBytes: Buffer.byteLength(revisedBytes), createdAt: repairedAt,
  });
  const revisedSource = resumedStore.updateChannelWorkflowStep(p01.id,
    { metadata: { ...oldSource.metadata, outputArtifactId: revisedArtifact.id } }, repairedAt);
  assert.ok(revisedSource);
  const implementationChange = {
    ...changeBasis, expectedWorkItemRevision: returnedHandoff.workItemRevision,
    affectedStageIds: ["P02"], reason: "Reconsider the implementation approach", idempotencyKey: "implementation-scope",
  };
  const implementationHold = await resumedClient.call<LingAppServerWorkItemPlanChangeResult>("workItem/plan/change/request", implementationChange);
  assert.deepEqual(implementationHold.receipt.affectedStepIds, [p02.id]);
  const targetStage = resumedStore.getChannelWorkflowStep(p02.id);
  assert.ok(targetStage);
  const stageMessage = {
    ...changeBasis, expectedWorkItemRevision: Number(implementationHold.workItem.revision),
    targetStepId: p02.id, expectedTargetRevision: targetStage.updatedAt, idempotencyKey: "implementation-coordination",
    body: "Preserve the exact response order for legacy consumers.",
  };
  const coordinated = await resumedClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/message/send", stageMessage);
  assert.equal(coordinated.status, "appended");
  assert.equal(coordinated.record.actorId, "local-user");
  await assert.rejects(resumedClient.call("workItem/message/send", { ...stageMessage, body: "Use different input." }), { code: "idempotency_conflict" });
  const ask = {
    ...changeBasis, expectedWorkItemRevision: coordinated.workItemRevision, waitingStepId: qa.id, respondentStepId: p02.id,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), question: "Should the regression include omitted fields?",
    idempotencyKey: "qa-compatibility-question",
  };
  const question = await resumedClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", ask);
  assert.equal(question.status, "appended");
  await assert.rejects(resumedClient.call("workItem/question/ask", {
    ...ask, expectedWorkItemRevision: question.workItemRevision, waitingStepId: p02.id, respondentStepId: qa.id, idempotencyKey: "mutual-wait",
  }), { code: "work_item_question_cycle" });
  const { candidate } = await resumedClient.call<LingAppServerCaptureChangesResult>("changes/capture");
  const handoff = { ...offeredHandoff, expectedSourceRevision: revisedSource.updatedAt, expectedCandidateDigest: candidate.candidateDigest,
    expectedWorkItemRevision: question.workItemRevision, idempotencyKey: "qa-accept-repaired-contract" };
  await writeFile(inputFile, "Changed after QA read\n");
  await assert.rejects(resumedClient.call("workItem/handoff/accept", handoff), { code: "work_item_handoff_candidate_stale" });
  await writeFile(inputFile, "Verified compatibility input\n");
  const handoffPath = `${itemPath}/handoff`;
  const { daemonUrl, authToken } = fixture.transportOptions();
  const forbiddenHandoff = await fetch(new URL(`${handoffPath}?cwd=${encodeURIComponent(fixture.cwd)}`, daemonUrl), {
    method: "POST", headers: { Origin: "https://other.example", Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json" }, body: JSON.stringify({ ...handoff, action: "accepted" }),
  });
  assert.equal(forbiddenHandoff.status, 403);
  assert.ok(resumedStore.updateAiTeammate(qa.toParticipantId, { status: "disabled" }, new Date().toISOString()));
  await assert.rejects(resumedClient.call("workItem/handoff/accept", handoff), { code: "work_item_handoff_recipient_unavailable" });
  const unavailableBeforeAccept = (await readBrief(resumedClient)).workflow?.steps.find(step => step.stepId === qa.id);
  assert.equal(unavailableBeforeAccept?.handoffs?.[0]?.status, "awaiting_acceptance");
  assert.equal(resumedStore.getWorkItem(workItemId)?.revision, handoff.expectedWorkItemRevision);
  assert.ok(resumedStore.updateAiTeammate(qa.toParticipantId, { status: "active" }, new Date().toISOString()));
  const [acceptedHandoff, repeatedHandoff] = await Promise.all([
    resumedClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/handoff/accept", handoff),
    request(handoffPath, { ...handoff, action: "accepted" }).then(async reply => {
      assert.ok(reply.ok, await reply.clone().text());
      return await reply.json() as LingAppServerWorkItemCollaborationAppendResult;
    }),
  ]);
  assert.deepEqual(new Set([acceptedHandoff.status, repeatedHandoff.status]), new Set(["appended", "replayed"]));
  assert.equal(acceptedHandoff.record.id, repeatedHandoff.record.id);
  assert.ok(acceptedHandoff.record.sourceRefs.some(source => source.id === revisedArtifact.id));
  const awaitingReply = (await readBrief(resumedClient)).workflow?.steps.find(step => step.stepId === qa.id);
  assert.equal(awaitingReply?.handoffs?.[0]?.status, "accepted");
  assert.equal(awaitingReply.handoffs[0]?.candidateDigest, candidate.candidateDigest);
  assert.equal(awaitingReply.admissionBlocker, "work_item_stage_question_pending");
  const readBallots = (connection: typeof client) => connection.call<LingAppServerWorkItemCollaborationReadResult>(
    "workItem/deliberation/read", { workItemId: item.id });
  assert.deepEqual((await readBallots(resumedClient)).ballots, [{ roundId: round.id, status: "waiting" }]);
  const current = await resumedClient.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: item.id });
  const expectedWorkItemRevision = Number(current.workItem.revision);
  await assert.rejects(resumedClient.call("workItem/deliberation/start", {
    workItemId: item.id, workflowStepId: p02.id, expectedWorkItemRevision,
    idempotencyKey: "duplicate-decision" }), { code: "stale_revision" });
  const heldDecision = {
    workItemId: item.id, roundId: round.id, expectedRoundRevision: round.collaborationRevision,
    expectedWorkItemRevision, idempotencyKey: "workflow-owned-selected", reason: "Keep both compatibility paths",
    decision: { disposition: "selected", option: "Adapter" },
  };
  await assert.rejects(resumedClient.call("workItem/deliberation/decide", heldDecision), { code: "resume_blocked" });
  completeQaVote();
  await waitFor(() => [engineerVote, qaVote].every(step => resumedStore.getChannelWorkflowStep(step.id)?.status === "succeeded") ? true : undefined);
  assert.equal(resumedStore.listRuns({ workflowStepId: qa.id }).length, 0);
  await fixture.restart();
  const decisionClient = await fixture.connect();
  const [readyBallot] = (await readBallots(decisionClient)).ballots ?? [];
  assert.equal(readyBallot?.status, "ready");
  assert.equal(readyBallot.summary.tied, true);
  assert.deepEqual(readyBallot.summary.tally, [{ option: "Adapter", count: 1 }, { option: "Migration", count: 1 }]);
  const readyStage = (await readBrief(decisionClient)).workflow?.steps.find(step => step.stepId === p02.id);
  assert.equal(readyStage?.decision?.status, "ready");
  assert.equal(readyStage.admissionBlocker, "work_item_plan_change_pending");
  assert.deepEqual(readyStage.decision.ballot, readyBallot.summary);
  assert.equal(fixture.getStore().listRuns({ workflowStepId: p02.id }).length, 0);
  const restoredChange = await decisionClient.call<LingAppServerWorkItemPlanChangeResult>("workItem/plan/change/request", implementationChange);
  assert.equal(restoredChange.replayed, true);
  assert.deepEqual(restoredChange.receipt, implementationHold.receipt);
  await assert.rejects(decisionClient.call("workItem/deliberation/decide", heldDecision), { code: "resume_blocked" });
  const restoredMessage = await decisionClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/message/send", stageMessage);
  assert.equal(restoredMessage.status, "replayed");
  assert.equal(restoredMessage.record.id, coordinated.record.id);
  const restoredQuestion = await decisionClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", ask);
  assert.equal(restoredQuestion.status, "replayed");
  assert.equal(restoredQuestion.record.id, question.record.id);
  assert.equal((await readBrief(decisionClient)).workflow?.steps.find(step => step.stepId === qa.id)?.admissionBlocker, "work_item_stage_question_pending");
  const reply = {
    workItemId, questionId: question.record.id, expectedQuestionRevision: question.record.collaborationRevision,
    expectedWorkItemRevision: restoredMessage.workItemRevision, answer: "Include omitted optional fields in the QA checks.", idempotencyKey: "qa-compatibility-answer",
  };
  await writeFile(inputFile, "Changed after the handoff was accepted\n");
  await assert.rejects(decisionClient.call("workItem/question/reply", { ...reply, expectedQuestionRevision: 1 }), { code: "stale_revision" });
  const answered = await decisionClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/reply", reply);
  const repeatedAnswer = await decisionClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/reply", reply);
  assert.equal(repeatedAnswer.status, "replayed");
  assert.equal(repeatedAnswer.record.id, answered.record.id);
  const drifted = await waitFor(async () => {
    const response = await request(`/workflow-steps/${encodeURIComponent(qa.id)}/start`, { mode: "create_and_run_task" });
    const body = await response.json() as { error?: string };
    return body.error === "resource_conflict" ? undefined : { status: response.status, code: body.error };
  });
  assert.deepEqual(drifted, { status: 409, code: "work_item_handoff_candidate_stale" });
  assert.equal(fixture.getStore().listRuns({ workflowStepId: qa.id }).length, 0);
  const handoffStore = fixture.getStore();
  assert.ok(handoffStore.updateAiTeammate(qa.toParticipantId, { status: "disabled" }, new Date().toISOString()));
  await writeFile(inputFile, "Verified compatibility input\n");
  const unavailableStart = await request(`/workflow-steps/${encodeURIComponent(qa.id)}/start`, { mode: "create_and_run_task" });
  assert.equal(unavailableStart.status, 409);
  assert.equal((await unavailableStart.json() as { error: string }).error, "work_item_handoff_recipient_unavailable");
  assert.equal(handoffStore.listRuns({ workflowStepId: qa.id }).length, 0);
  const unavailableAfterAccept = (await readBrief(decisionClient)).workflow?.steps.find(step => step.stepId === qa.id);
  assert.equal(unavailableAfterAccept?.status, "queued");
  assert.equal(unavailableAfterAccept.admissionBlocker, "work_item_handoff_recipient_unavailable");
  assert.equal(unavailableAfterAccept.handoffs?.[0]?.receiptId, acceptedHandoff.record.id);
  const override = { mode: "create_task", assigneeTeammateId: p01.toParticipantId };
  const overridden = await request(`/workflow-steps/${encodeURIComponent(qa.id)}/start`, override);
  assert.equal(overridden.status, 409);
  assert.equal((await overridden.json() as { error: string }).error, "workflow_participant_override_forbidden");
  assert.ok(handoffStore.updateAiTeammate(qa.toParticipantId, { status: "active" }, new Date().toISOString()));
  await waitFor(() => handoffStore.getChannelWorkflowStep(qa.id)?.status === "succeeded" ? true : undefined);
  const releaseImplementation = await decisionClient.call<LingAppServerWorkItemPlanChangeResult>("workItem/plan/change/withdraw", {
    ...changeBasis, expectedWorkItemRevision: answered.workItemRevision,
    changeId: restoredChange.receipt.changeId, idempotencyKey: "withdraw-implementation-scope",
  });
  const decision = { ...heldDecision, expectedWorkItemRevision: Number(releaseImplementation.workItem.revision) };
  const restoredHandoff = await decisionClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/handoff/accept", handoff);
  assert.equal(restoredHandoff.status, "replayed");
  assert.equal(restoredHandoff.record.id, acceptedHandoff.record.id);
  const handoffObserver = await fixture.connect("/app-server/rpc", fixture.cwd, `las1.${grant.grantId}.${observerSecret}`);
  await assert.rejects(handoffObserver.call("workItem/message/send", stageMessage), { code: "capability_denied" });
  assert.doesNotMatch(JSON.stringify(await handoffObserver.call("workItem/message/list", { workItemId })), /legacy consumers/u);
  assert.doesNotMatch(JSON.stringify(await handoffObserver.call("workItem/evidence/read", { workItemId })), /legacy consumers/u);
  assert.doesNotMatch(JSON.stringify(await handoffObserver.call("workItem/question/read", { workItemId })), /omitted optional fields/u);
  const handoffHistory = await handoffObserver.call<LingAppServerWorkItemCollaborationReadResult>("workItem/handoff/read", { workItemId });
  assert.deepEqual(handoffHistory.records.map(record => record.id), [returnedHandoff.record.id, acceptedHandoff.record.id]);
  assert.ok(handoffHistory.records.every(record => record.sourceRefs.length === 0));
  await assert.rejects(decisionClient.call("workItem/deliberation/decide", { ...decision,
    decision: { disposition: "selected", option: "Rewrite" } }), { code: "invalid_params" });
  const selected = await decisionClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/deliberation/decide", decision);
  assert.deepEqual((selected.record.payload as { ballot: { tally: unknown; tied: boolean } }).ballot.tally,
    [{ option: "Adapter", count: 1 }, { option: "Migration", count: 1 }]);
  assert.equal((selected.record.payload as { ballot: { tied: boolean } }).ballot.tied, true);
  const retried = await decisionClient.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/deliberation/decide", decision);
  assert.equal(retried.status, "replayed");
  assert.equal(retried.record.id, selected.record.id);
  assert.equal((await readBallots(decisionClient)).ballots, undefined);
  const finishedStore = fixture.getStore();
  await waitFor(() => finishedStore.getChannelWorkflow(converted.workflowId!)?.status === "succeeded" ? true : undefined);
  for (const step of [p01, p02, qa, engineerVote, qaVote]) assert.equal(finishedStore.listRuns({ workflowStepId: step.id }).length, 1);
  assert.ok(provider.requests.some(body => {
    const input = JSON.stringify(body);
    return input.includes("Accepted Plan decision:") && input.includes(selected.record.id);
  }), "The implementation did not receive the accepted decision.");
  const recipients = provider.requests.map(body => JSON.stringify(body)).filter(input => input.includes(stageMessage.body));
  assert.ok(recipients.length >= 1, "The queued stage message was missing from the actual Pi prompt.");
  assert.ok(recipients.every(input => input.includes(selected.record.id) && input.includes(coordinated.record.id)),
    "The message was delivered outside the authorized stage.");
  const answers = provider.requests.map(body => JSON.stringify(body)).filter(input => input.includes(reply.answer));
  assert.equal(answers.length, 1);
  assert.match(answers[0]!, /Assigned teammate: QA/u);
  assert.ok(answers[0]!.includes(answered.record.id));
  const detail = await request(itemPath);
  assert.equal(detail.status, 200);
  const body = await detail.json() as { workflow?: LingAppServerWorkItemCollaborationReadResult["workflow"] };
  assert.deepEqual(body.workflow?.steps.map(step => step.status), ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
  assert.deepEqual(body.workflow?.steps.filter(step => step.stageId?.startsWith("V-")).map(step => step.brief),
    ["Ballot received.", "Ballot received."]);
  assert.deepEqual(body.workflow?.steps.find(step => step.stepId === p01.id)?.briefBasis, brief.briefBasis);
  assert.deepEqual(body.workflow?.steps.find(step => step.stepId === p02.id)?.decision, {
    question: p02Preview.requiredDecision.question, status: "decided", selectedOption: "Adapter",
    reason: decision.reason, ballot: readyBallot.summary,
  });
  const sourceRunId = finishedStore.getChannelWorkflowStep(p02.id)?.runId;
  assert.ok(sourceRunId);
  const currentWorkItem = await decisionClient.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: item.id });
  const feedbackInput = {
    workItemId: item.id, sourceRunId, providerPresetId: preset.id,
    expectedWorkItemRevision: Number(currentWorkItem.workItem.revision), idempotencyKey: "workflow-experience",
  };
  const feedback = await decisionClient.call<LingAppServerWorkItemFeedbackResult>("workItem/feedback/add", feedbackInput);
  assert.equal(feedback.replayed, false);
  assert.equal(feedback.job.evidence.workItem?.id, item.id);
  const feedbackReplay = await decisionClient.call<LingAppServerWorkItemFeedbackResult>("workItem/feedback/add", feedbackInput);
  assert.equal(feedbackReplay.replayed, true);
  assert.equal(feedbackReplay.job.id, feedback.job.id);
  await assert.rejects(decisionClient.call("workItem/feedback/add", { ...feedbackInput, sourceRunId: "other-run" }),
    { code: "idempotency_conflict" });
  const completedReview = await waitFor(() => {
    const job = finishedStore.getLearningReviewJob(feedback.job.id);
    return job && ["succeeded", "failed", "cancelled"].includes(job.status) ? job : undefined;
  });
  assert.equal(completedReview.status, "succeeded", JSON.stringify({
    reason: completedReview.reason, items: completedReview.evidence.items,
  }));
  const [memoryId] = completedReview.candidateIds;
  assert.ok(memoryId);
  assert.equal(finishedStore.getMemoryObject(memoryId)?.reviewState, "candidate");
  assert.equal(completedReview.modelRequests, 1);
  const reviews = await request(`/skills/learning-reviews?workItemId=${encodeURIComponent(item.id)}`);
  assert.equal(reviews.status, 200);
  assert.deepEqual((await reviews.json() as { jobs: readonly { id: string }[] }).jobs.map(job => job.id), [feedback.job.id]);
  await fixture.restart();
  const finalClient = await fixture.connect();
  assert.equal((await finalClient.call<LingAppServerWorkItemFeedbackResult>("workItem/feedback/add", feedbackInput)).job.id, feedback.job.id);
});

test("a paused Work Item replaces its accepted Workflow after the old Run settles", { timeout: 35_000 }, async t => {
  let finishPredecessor: () => void = () => undefined;
  const predecessorGate = new Promise<void>(resolve => { finishPredecessor = resolve; });
  const provider = await startLoopbackPiProvider(async (_body: unknown, request: number) => {
    if (request === 1) {
      await predecessorGate;
      return { tool: "read", input: { path: "old-contract.txt" } };
    }
    return { text: "Stage completed" };
  });
  t.after(async () => { finishPredecessor(); await provider.close(); });
  const fixture = await releaseFixture(t);
  await writeFile(join(fixture.cwd, "old-contract.txt"), "Superseded contract contents\n");
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "Compatibility work", boundPath: fixture.cwd,
    allowedTools: ["read"], defaultProviderPresetId: preset.id }, now);
  const thread = store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
    title: "Compatibility plan", objective: "Revise the accepted contract during execution" }, now);
  const plan = store.upsertProposedPlanArtifact({ id: "plan_replacement", threadId: thread.id,
    channelId: channel.id, title: "Compatibility plan", bodyMarkdown: "Preserve the original contract", status: "draft" }, now);
  const post = async (path: string, body: object) => {
    const { daemonUrl, authToken } = fixture.transportOptions();
    const url = new URL(path, daemonUrl);
    url.searchParams.set("cwd", fixture.cwd);
    return fetch(url, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` } });
  };
  const planPath = (id: string, action: string) => `/threads/${thread.id}/proposed-plans/${id}/${action}`;
  const step = (stageId: string, title: string) => ({
    stageId, title, ownerId: "teammate_builtin_engineer", ownerLabel: "Engineer",
  });
  const conversion = await post(planPath(plan.id, "convert-workflow"), {
    expectedRevision: plan.revision,
    workflowStepPreviews: [{ ...step("P01", "Read the old contract"), requiredTools: ["read"] }, {
      ...step("P02", "Implement the old contract"), dependsOnStageIds: ["P01"],
      handoffFromStageIds: ["P01"], ownerId: "teammate_builtin_qa", ownerLabel: "QA",
    }],
  });
  assert.equal(conversion.status, 200);
  const original = await conversion.json() as ProposedPlanActionResponse;
  assert.ok(original.workflowId);
  const [p01, p02] = store.listChannelWorkflowSteps({ workflowId: original.workflowId, complete: true });
  assert.ok(p01 && p02);
  assert.equal(p02.toParticipantId, "teammate_builtin_qa");
  const item = store.upsertWorkItem({ sourceType: "manual", sourceId: "workflow-replacement", title: "Compatibility work",
    channelId: channel.id, initialStatus: "ready" }, now);
  const client = await fixture.connect();
  const accept = await client.call<LingAppServerWorkItemAcceptResult>("workItem/accept", {
    workItemId: item.id, expectedWorkItemRevision: item.revision, idempotencyKey: "accept-compatibility",
  });
  const bind = {
    workItemId: item.id, planId: original.plan.id, expectedPlanRevision: original.plan.revision,
    expectedWorkItemRevision: Number(accept.workItem.revision), idempotencyKey: "bind-compatibility",
  };
  await client.call<LingAppServerWorkItemWorkflowBindResult>("workItem/workflow/bind", bind);
  const initialBinding = await client.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: item.id });
  assert.ok(initialBinding.workItem.planRevision);
  const { record: oldQuestion } = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", {
    workItemId: item.id, planRevision: initialBinding.workItem.planRevision,
    expectedWorkItemRevision: Number(initialBinding.workItem.revision), waitingStepId: p02.id, respondentStepId: p01.id,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(), question: "Does the predecessor allow the old contract?",
    idempotencyKey: "predecessor-question",
  });
  const before = await client.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: item.id });
  const runWorkflow = (workflowId: string) => post(`/workflows/${workflowId}/orchestrate`, {});
  const started = await runWorkflow(original.workflowId);
  assert.equal((await started.json()).status, "started");
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  assert.ok(store.updateAiTeammate(p02.toParticipantId, { status: "disabled" }, new Date().toISOString()));

  const { plan: draft } = await client.call<ProposedPlanActionResponse>("plan/refine", {
    threadId: thread.id, planId: original.plan.id, expectedRevision: original.plan.revision,
    draft: { title: "Revised compatibility plan", bodyMarkdown: "Adopt the revised compatibility contract." },
  });
  assert.equal(draft.parentPlanId, original.plan.id);
  assert.equal(draft.bodyMarkdown, "Adopt the revised compatibility contract.");
  assert.ok(typeof draft.revision === "number");
  assert.equal(store.getWorkItemWorkflowAdmissionBlocker(original.workflowId), undefined);
  assert.ok(before.workItem.planRevision);
  const scopeChange = await client.call<LingAppServerWorkItemPlanChangeResult>("workItem/plan/change/request", {
    workItemId: item.id, planRevision: before.workItem.planRevision, expectedWorkItemRevision: Number(before.workItem.revision),
    affectedStageIds: ["P02"], reason: "Replace the accepted implementation stage", idempotencyKey: "scope-successor",
  });
  const taskBypass = await post(planPath(draft.id, "accept"), { expectedRevision: draft.revision });
  assert.equal(taskBypass.status, 409);
  assert.equal((await taskBypass.json()).error, "work_item_workflow_replan_required");
  const replacement = { threadId: thread.id, planId: draft.id, mode: "workflow",
    expectedRevision: draft.revision, workflowStepPreviews: [
      step("P02", "Implement the accepted successor contract"), step("P03", "Clarify the compatibility requirement"),
    ] };
  await assert.rejects(client.call("plan/accept", { ...replacement, expectedRevision: draft.revision + 1 }), { code: "stale_revision" });
  const successor = await client.call<ProposedPlanActionResponse>("plan/accept", replacement);
  assert.ok(successor.workflowId);
  const [newStep, clarification] = store.listChannelWorkflowSteps({ workflowId: successor.workflowId, complete: true });
  assert.ok(newStep && clarification);
  assert.equal(newStep.toParticipantId, "teammate_builtin_engineer");
  const startStep = (stepId: string) => post(`/workflow-steps/${stepId}/start`, { mode: "create_and_run_task" });
  const unbound = await startStep(newStep.id);
  assert.equal(unbound.status, 409);
  assert.equal((await unbound.json()).error, "work_item_workflow_unbound");
  const superseding = await startStep(p02.id);
  assert.equal(superseding.status, 409);
  assert.equal((await superseding.json()).error, "work_item_plan_change_pending");
  const control = (action: "pause" | "resume", expectedWorkItemRevision: number, expectedControlGeneration: number, connection = client) =>
    connection.call<LingAppServerWorkItemControlResult>(`workItem/${action}`, {
      workItemId: item.id, actorId: "local-user", expectedWorkItemRevision, expectedControlGeneration,
      idempotencyKey: `compatibility-${action}`, reason: "Accept the revised compatibility contract",
    });
  const held = await control("pause", Number(scopeChange.workItem.revision), 0);
  const rebind = {
    ...bind, planId: successor.plan.id, expectedPlanRevision: successor.plan.revision,
    previousWorkflowId: original.workflowId, expectedWorkItemRevision: Number(held.workItem.revision), idempotencyKey: "bind-successor",
    resolvedPlanChangeIds: [scopeChange.receipt.changeId],
  };
  await assert.rejects(client.call("workItem/workflow/bind", rebind), { code: "resume_blocked" });
  finishPredecessor();
  await waitFor(() => store.getChannelWorkflowStep(p01.id)?.status === "succeeded" ? true : undefined);
  assert.match(JSON.stringify(provider.requests[1]), /work_item_workflow_held/u);
  assert.doesNotMatch(JSON.stringify(provider.requests[1]), /Superseded contract contents/u);
  await fixture.restart();
  const restored = await fixture.connect();
  await assert.rejects(restored.call("workItem/workflow/bind", { ...rebind, resolvedPlanChangeIds: [] }), { code: "resume_blocked" });
  const retainedSource = fixture.getStore().getChannelWorkflowStep(p01.id);
  assert.ok(retainedSource?.metadata?.outputArtifactId);
  const retainedResult = { sourceStepId: p01.id, expectedSourceRevision: retainedSource.updatedAt, targetStepId: newStep.id };
  await assert.rejects(restored.call("workItem/workflow/bind", {
    ...rebind, retainStageResults: [{ ...retainedResult, expectedSourceRevision: new Date(0).toISOString() }],
  }), { code: "stale_revision" });
  const [boundSuccessor, replay] = await Promise.all([restored, await fixture.connect()].map(connection =>
    connection.call<LingAppServerWorkItemWorkflowBindResult>("workItem/workflow/bind", { ...rebind, retainStageResults: [retainedResult] })));
  assert.ok(boundSuccessor && replay);
  assert.deepEqual([boundSuccessor.replayed, replay.replayed].sort(), [false, true]);
  assert.deepEqual(boundSuccessor.binding, replay.binding);
  assert.equal(boundSuccessor.binding.previousWorkflowId, original.workflowId);
  assert.equal(boundSuccessor.binding.workflowId, successor.workflowId);
  assert.deepEqual(boundSuccessor.binding.retainedStageResults, [{
    ...retainedResult, sourceWorkflowId: original.workflowId, sourceStageId: "P01", sourceRunId: retainedSource.runId,
    sourceArtifactId: retainedSource.metadata.outputArtifactId,
  }]);
  const stageInputs = await restored.call<LingAppServerWorkItemCollaborationReadResult>("workItem/stage/read", { workItemId: item.id });
  assert.deepEqual(stageInputs.workflow?.steps.find(step => step.stepId === newStep.id)?.retainedStageResults, boundSuccessor.binding.retainedStageResults);
  const artifact = await restored.call<{ artifact: { id: string } }>("artifact/read", {
    workItemId: item.id, artifactId: retainedSource.metadata.outputArtifactId,
  });
  assert.equal(artifact.artifact.id, retainedSource.metadata.outputArtifactId);
  assert.equal(boundSuccessor.workItem.control.state, "paused");
  assert.ok(!boundSuccessor.workItem.holds.some(hold => hold.id === scopeChange.receipt.changeId));
  await restored.call("workItem/subscribe", { workItemId: item.id, cursor: before.cursor });
  await waitFor(() => restored.notices.find(notice => notice.params?.event?.action === "work_item.workflow.linked"
    && notice.params.event.data?.previousWorkflowId === original.workflowId));
  const moveQuestion = { workItemId: item.id, planRevision: boundSuccessor.workItem.planRevision,
    waitingStepId: newStep.id, respondentStepId: clarification.id,
    expectedWorkItemRevision: Number(boundSuccessor.workItem.revision), idempotencyKey: "move-question-to-successor",
    deadlineAt: new Date(Date.now() + 120_000).toISOString(), question: "Does the predecessor allow the old contract?",
    predecessorQuestion: { id: oldQuestion.id, revision: oldQuestion.collaborationRevision },
  };
  await assert.rejects(restored.call("workItem/question/ask", {
    ...moveQuestion, predecessorQuestion: { ...moveQuestion.predecessorQuestion, revision: oldQuestion.collaborationRevision + 1 },
  }), { code: "stale_revision" });
  const moved = await restored.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", moveQuestion);
  assert.equal(moved.record.parentRecordId, oldQuestion.id);
  assert.notEqual(moved.record.id, oldQuestion.id);
  assert.equal((await restored.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", moveQuestion)).status, "replayed");
  const history = await restored.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/reply", {
    workItemId: item.id, questionId: oldQuestion.id, expectedQuestionRevision: oldQuestion.collaborationRevision,
    expectedWorkItemRevision: moved.workItemRevision, idempotencyKey: "predecessor-late-reply",
    answer: "This answer applies to the old contract.",
  });
  assert.equal((history.record.payload as { historicalReason?: string }).historicalReason, "plan_superseded");
  await control("resume", history.workItemRevision, 1, restored);
  const stale = await startStep(p02.id);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "work_item_workflow_stale");
  const newStart = await runWorkflow(successor.workflowId);
  assert.equal((await newStart.json()).status, "started");
  const restoredStore = fixture.getStore();
  await waitFor(() => restoredStore.getChannelWorkflowStep(clarification.id)?.status === "succeeded" ? true : undefined);
  const waitingOnMovedQuestion = await startStep(newStep.id);
  assert.equal(waitingOnMovedQuestion.status, 409);
  assert.equal((await waitingOnMovedQuestion.json()).error, "work_item_stage_question_pending");
  const current = await restored.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: item.id });
  await restored.call("workItem/question/reply", {
    workItemId: item.id, questionId: moved.record.id, expectedQuestionRevision: moved.record.collaborationRevision,
    expectedWorkItemRevision: Number(current.workItem.revision), idempotencyKey: "successor-question-reply",
    answer: "The accepted revision preserves the compatibility clause.",
  });
  await waitFor(() => restoredStore.getChannelWorkflowStep(newStep.id)?.status === "succeeded" ? true : undefined);
  assert.equal(restoredStore.listRuns({ workflowStepId: p01.id }).length, 1);
  assert.equal(restoredStore.listRuns({ workflowStepId: p02.id }).length, 0);
  const successorRuns = restoredStore.listRuns({ workflowStepId: newStep.id });
  assert.equal(successorRuns.length, 1);
  assert.equal(successorRuns[0]?.teammateId, newStep.toParticipantId);
  assert.equal(provider.requests.length, 4);
  assert.match(JSON.stringify(provider.requests[2]), /Does the predecessor allow the old contract/u);
  assert.match(JSON.stringify(provider.requests[3]), /Retained upstream results from the predecessor Plan/u);
  assert.ok(JSON.stringify(provider.requests[3]).includes(retainedSource.metadata.outputArtifactId));
  assert.match(JSON.stringify(provider.requests[3]), /accepted revision preserves the compatibility clause/u);
  assert.doesNotMatch(JSON.stringify(provider.requests[3]), /answer applies to the old contract/u);
});

async function stageQuestionWorkflow(t: TestContext, providerBaseUrl?: string) {
  const fixture = await releaseFixture(t);
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const preset = providerBaseUrl ? addLoopbackPreset(store, providerBaseUrl) : undefined;
  const channel = store.createChannel({ name: "Review", boundPath: fixture.cwd, allowedTools: [], defaultProviderPresetId: preset?.id }, now);
  const thread = store.createLingThread({ channelId: channel.id, kind: "channel_discussion",
    title: "Review plan", objective: "Review the compatibility contract." }, now);
  const plan = store.upsertProposedPlanArtifact({
    id: "plan-question-deadline", threadId: thread.id, channelId: channel.id,
    title: "Review", bodyMarkdown: "Review the compatibility contract.", status: "draft",
  }, now);
  const client = await fixture.connect();
  const accepted = await client.call<ProposedPlanActionResponse>("plan/accept", {
    mode: "workflow", threadId: thread.id, planId: plan.id, expectedRevision: plan.revision,
    workflowStepPreviews: [
      { title: "Review", stageId: "QA", ownerId: "teammate_builtin_qa", ownerLabel: "QA" },
      { title: "Explain the contract", stageId: "P01", ownerId: "teammate_builtin_engineer", ownerLabel: "Engineer" },
    ],
  });
  assert.ok(accepted.workflowId);
  const [waiting, respondent] = store.listChannelWorkflowSteps({ workflowId: accepted.workflowId, complete: true });
  assert.ok(waiting && respondent);
  const item = store.upsertWorkItem({ sourceType: "manual", sourceId: "question-deadline", title: "Review",
    channelId: channel.id, initialStatus: "ready" }, now);
  const claim = await client.call<LingAppServerWorkItemAcceptResult>("workItem/accept", {
    workItemId: item.id, expectedWorkItemRevision: item.revision, idempotencyKey: "accept-question-deadline",
  });
  const { workItem } = await client.call<LingAppServerWorkItemWorkflowBindResult>("workItem/workflow/bind", {
    workItemId: item.id, planId: plan.id, expectedPlanRevision: accepted.plan.revision,
    expectedWorkItemRevision: Number(claim.workItem.revision), idempotencyKey: "bind-question-deadline",
  });
  assert.ok(workItem.planRevision);
  return { fixture, store, client, item, workItem, workflowId: accepted.workflowId, waiting, respondent };
}

test("a reply at a stage question deadline is durable history and does not release the waiting step", { timeout: 15_000 }, async t => {
  const { fixture, store, client, item, workItem, workflowId, waiting, respondent } = await stageQuestionWorkflow(t);
  const deadline = new Date(Date.now() + 120_000);
  const question = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", {
    workItemId: item.id, planRevision: workItem.planRevision, expectedWorkItemRevision: Number(workItem.revision),
    waitingStepId: waiting.id, respondentStepId: respondent.id, deadlineAt: deadline.toISOString(),
    question: "Which inputs does QA need?", idempotencyKey: "ask-with-deadline",
  });
  assert.equal(store.getWorkItemWorkflowAdmissionBlocker(workflowId, waiting), "work_item_stage_question_pending");
  t.mock.timers.enable({ apis: ["Date"], now: deadline });
  const reply = { workItemId: item.id, questionId: question.record.id, expectedQuestionRevision: question.record.collaborationRevision,
    expectedWorkItemRevision: question.workItemRevision, answer: "The previous revision.", idempotencyKey: "reply-at-deadline" };
  const history = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/reply", reply);
  assert.equal((history.record.payload as { historicalReason?: string }).historicalReason, "deadline_expired");
  assert.equal(store.getWorkItemWorkflowAdmissionBlocker(workflowId, waiting), "work_item_stage_question_overdue");
  assert.equal(store.getWorkItemWorkflowAdmissionBlocker(workflowId, respondent), undefined);
  await fixture.restart();
  const restored = await fixture.connect();
  const replayed = await restored.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/reply", reply);
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.record.id, history.record.id);
  assert.deepEqual(replayed.record.payload, history.record.payload);
  await assert.rejects(restored.call("workItem/question/reply", { ...reply, answer: "Change the reply." }), { code: "idempotency_conflict" });
  assert.equal(fixture.getStore().getWorkItemWorkflowAdmissionBlocker(workflowId, waiting), "work_item_stage_question_overdue");
  assert.equal(fixture.getStore().listRuns({ workflowStepId: waiting.id }).length, 0);
});

test("the assigned Agent can answer a stage question using its owned Workflow result", { timeout: 25_000 }, async t => {
  let automaticId = "", coordinatorId = "";
  const provider = await startLoopbackPiProvider((body: unknown, count: number) => {
    const observed = JSON.stringify(body);
    if (count === 1) {
      assert.ok(automaticId && coordinatorId);
      assert.ok(observed.includes(automaticId));
      return { text: "Contract reviewed.\n\n```ling-stage-answers\n" + JSON.stringify([
        { questionId: automaticId, answer: "Confirm that omitted headers stay optional." },
        { questionId: coordinatorId, answer: "The coordinator can be bypassed." },
      ]) + "\n```" };
    }
    assert.match(observed, /Confirm that omitted headers stay optional/u);
    assert.match(observed, /Run the accepted regression suite/u);
    assert.doesNotMatch(observed, /The coordinator can be bypassed/u);
    return { text: "QA complete." };
  });
  t.after(() => provider.close());
  const { fixture, store, client, item, workItem, workflowId, waiting, respondent } = await stageQuestionWorkflow(t, provider.baseUrl);
  const ask = { workItemId: item.id, planRevision: workItem.planRevision,
    expectedWorkItemRevision: Number(workItem.revision), waitingStepId: waiting.id, respondentStepId: respondent.id,
    deadlineAt: new Date(Date.now() + 120_000).toISOString() };
  const automatic = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", {
    ...ask, answerFromStageResult: true, question: "What changed in the header contract?", idempotencyKey: "automatic-stage-question",
  });
  automaticId = automatic.record.id;
  const coordinator = await client.call<LingAppServerWorkItemCollaborationAppendResult>("workItem/question/ask", {
    ...ask, expectedWorkItemRevision: automatic.workItemRevision, question: "Which test suite is approved?",
    idempotencyKey: "coordinator-stage-question",
  });
  coordinatorId = coordinator.record.id;
  const { daemonUrl, authToken } = fixture.transportOptions();
  const url = new URL(`/workflows/${workflowId}/orchestrate`, daemonUrl);
  url.searchParams.set("cwd", fixture.cwd);
  const response = await fetch(url, { method: "POST", body: "{}",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` } });
  const started = await response.json() as { status: string; blocker?: string };
  assert.equal(started.status, "started", JSON.stringify(started));
  await waitFor(() => store.getChannelWorkflowStep(respondent.id)?.status === "succeeded" ? true : undefined);
  const [source] = store.listRuns({ workflowStepId: respondent.id });
  assert.ok(source);
  const prepared = source.requestSnapshot as { contextPack?: { stageQuestionIds?: readonly string[] } };
  assert.deepEqual(prepared.contextPack?.stageQuestionIds, [automaticId]);
  const completedStep = store.getChannelWorkflowStep(respondent.id);
  assert.equal(completedStep?.resultSummary, "Contract reviewed.");
  assert.ok(completedStep.metadata?.outputArtifactId);
  assert.doesNotMatch(JSON.stringify(store.getArtifact(completedStep.metadata.outputArtifactId)?.sealedPayload),
    /Confirm that omitted headers|coordinator can be bypassed/u);
  const readReplies = async (connection: typeof client) => (await connection.call<LingAppServerWorkItemCollaborationReadResult>(
    "workItem/question/read", { workItemId: item.id })).records.filter(record => record.action === "replied");
  const received = await waitFor(async () => (await readReplies(client)).find(record => record.parentRecordId === automaticId));
  assert.equal(received.actorId, respondent.toParticipantId);
  assert.deepEqual(received.sourceRefs, [{ type: "run", id: source.id }]);
  assert.equal(store.getWorkItemWorkflowAdmissionBlocker(workflowId, waiting), "work_item_stage_question_pending");
  assert.equal(store.listRuns({ workflowStepId: waiting.id }).length, 0);
  assert.equal(provider.requests.length, 1);
  await fixture.restart();
  const restored = await fixture.connect();
  const replies = await readReplies(restored);
  assert.deepEqual(replies.map(record => record.id), [received.id]);
  const latest = await restored.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId: item.id });
  await restored.call("workItem/question/reply", {
    workItemId: item.id, questionId: coordinatorId, expectedQuestionRevision: coordinator.record.collaborationRevision,
    expectedWorkItemRevision: Number(latest.workItem.revision), answer: "Run the accepted regression suite.", idempotencyKey: "coordinator-reply",
  });
  const recovered = fixture.getStore();
  await waitFor(() => recovered.getChannelWorkflowStep(waiting.id)?.status === "succeeded" ? true : undefined);
  assert.equal(recovered.listRuns({ workflowStepId: waiting.id }).length, 1);
  assert.equal(recovered.listRuns({ workflowStepId: respondent.id }).length, 1);
  assert.equal(provider.requests.length, 2);
});

test("App Server reads bounded artifact ranges without exposing private metadata", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const store = fixture.getStore();
  const now = new Date().toISOString();
  await mkdir(store.paths.artifactsDir, { recursive: true });
  await writeFile(join(store.paths.artifactsDir, "public-proof.txt"), "Ling proof payload\n", "utf8");
  store.createRun({ id: "app-server-artifact-run", cwd: fixture.cwd, taskId: "app-server-artifact-task",
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: { cwd: fixture.cwd }, createdAt: now });
  const artifact = store.createArtifact({ id: "app-server-public-proof", runId: "app-server-artifact-run", type: "file", path: "public-proof.txt", createdAt: now });
  const client = await fixture.connect();
  const metadata = await client.call<{ artifact: { id: string; contentSha256?: string } }>("artifact/read", { artifactId: artifact.id });
  assert.equal(metadata.artifact.id, artifact.id);
  assert.equal(metadata.artifact.contentSha256, undefined);
  const range = await client.call<{ contentBase64: string; offset: number; endExclusive: number; sizeBytes: number }>("artifact/read", {
    artifactId: artifact.id, offset: 0, limit: 4,
  });
  assert.equal(Buffer.from(range.contentBase64, "base64").toString("utf8"), "Ling");
  assert.deepEqual({ offset: range.offset, endExclusive: range.endExclusive, sizeBytes: range.sizeBytes }, { offset: 0, endExclusive: 4, sizeBytes: 19 });
});

test("a scheduled coordination occurrence commits with its round, restores its deadline and skips a paused Work Item", { timeout: 25_000 }, async t => {
  const fixture = await releaseFixture(t, { recoveryJournal: true });
  const client = await fixture.connect();
  const { workItem } = await client.call<LingAppServerWorkItemResult>("workItem/create", { sourceId: "coordination", title: "Review the stage" });
  const { workItemId, workspaceId } = workItem;
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const home = store.createLingThread({ kind: "automation", title: "Daily checkpoint", objective: "Review the team progress" }, now);
  const due = new Date(Date.now() - 100).toISOString();
  const automation = store.createAutomationDefinition({
    threadId: home.id, title: "Daily checkpoint", kind: "custom_prompt",
    trigger: { type: "schedule", timezone: "UTC", missedRunPolicy: "run_one",
      schedule: { cadence: "daily", timeOfDay: "00:00" } },
    target: { scope: "workspace", workspaceId }, executionPolicy: {},
    promptTemplate: { templateVersion: 1, promptMarkdown: "Review the current Work Item.", contextSelectors: [] },
    outputPolicy: { artifactFormat: "markdown", destinations: [{ type: "automation_thread" }] },
    nextRunAt: due,
  }, now);
  const policy = { automationId: automation.id, workItemId, expectedRevision: 0, enabled: true, kind: "checkpoint", durationMs: 3500 };
  const configured = await client.call<{ schedule: LingAppServerCoordinationSchedule }>("workItem/coordination/schedule/set", policy);
  assert.equal(configured.schedule.revision, 1);
  await assert.rejects(client.call("workItem/coordination/schedule/set", { ...policy, enabled: false }), { code: "stale_revision" });
  const runAutomation = (body: object) => {
    const { daemonUrl, authToken, cwd } = fixture.transportOptions();
    return fetch(`${daemonUrl}/automations/${automation.id}/run?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    });
  };
  const before = await client.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  const occurrence = { triggerType: "schedule", scheduledFor: due, idempotencyKey: `automation:${automation.id}:schedule:${due}` };
  const database = new DatabaseSync(store.paths.databasePath);
  try {
    database.exec(`CREATE TRIGGER fixture_fail_coordination BEFORE INSERT ON control_plane_events
      WHEN NEW.action = 'work_item.collaboration.coordination.started'
      BEGIN SELECT RAISE(ABORT, 'fixture_coordination_write_failed'); END`);
    const failed = await runAutomation(occurrence);
    assert.ok(!failed.ok);
    assert.equal(store.listAutomationRuns({ automationId: automation.id }).length, 0);
    assert.equal(store.listWorkItemEvidence({ workItemId }).length, 0);
    database.exec("DROP TRIGGER fixture_fail_coordination");
  } finally {
    database.close();
  }
  const recovery = await client.call<LingAppServerRecoveryResult>("server/recovery/prepare", {
    expectedRevision: 0, idempotencyKey: "hold-coordination-occurrence",
  });
  await fixture.restart();
  const restored = await fixture.connect();
  assert.equal((await restored.call<LingAppServerSubscriptionResult>("workItem/subscribe", { workItemId, cursor: before.cursor })).disposition, "snapshot_required");
  const currentCursor = (await restored.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId })).cursor;
  await restored.call("workItem/subscribe", { workItemId, cursor: currentCursor });
  const blocked = await runAutomation(occurrence);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json() as { error: string }).error, "resume_blocked");
  assert.equal(fixture.getStore().listAutomationRuns({ automationId: automation.id }).length, 0);
  assert.equal(fixture.getStore().getAutomationDefinition(automation.id)?.nextRunAt, due);
  const reconciled = await restored.call<LingAppServerRecoveryResult>("server/recovery/reconcile", { expectedRevision: recovery.revision });
  assert.equal(reconciled.status, "ready");
  const scheduled = await waitFor(() => fixture.getStore().listAutomationRuns({ automationId: automation.id })[0]);
  assert.equal(scheduled.scheduledFor, due);
  assert.equal(scheduled.status, "succeeded");
  assert.ok(scheduled.coordinationRoundId && scheduled.completedAt);
  assert.equal(scheduled.runId, undefined);
  const round = fixture.getStore().readScheduledCoordinationRound(scheduled.coordinationRoundId);
  assert.ok(round);
  await waitFor(() => restored.notices.find(value => value.params?.event?.action === "work_item.collaboration.coordination.started"));
  const replay = await runAutomation(occurrence);
  assert.equal(replay.status, 202);
  assert.deepEqual((await replay.json() as { automationRun: AutomationRun }).automationRun, scheduled);
  assert.equal(fixture.getStore().listAutomationRuns({ automationId: automation.id }).length, 1);

  await fixture.restart();
  const observer = await fixture.connect();
  const afterRestart = fixture.getStore().readScheduledCoordinationRound(round.recordId);
  assert.equal(afterRestart?.deadlineAt, round.deadlineAt);
  const controlScheduler = (action: "start" | "stop") => {
    const { daemonUrl, cwd, authToken } = fixture.transportOptions();
    return fetch(`${daemonUrl}/automations/scheduler/${action}?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { Authorization: `Bearer ${authToken}` },
    });
  };
  assert.equal((await controlScheduler("start")).status, 200);
  assert.equal((await controlScheduler("stop")).status, 200);
  await delay(Math.max(0, Date.parse(round.deadlineAt) - Date.now()) + 100);
  assert.equal(fixture.getStore().readScheduledCoordinationRound(round.recordId)?.closedRecordId, undefined);
  assert.equal((await controlScheduler("start")).status, 200);
  const closed = await waitFor(() => fixture.getStore().readScheduledCoordinationRound(round.recordId)?.closedRecordId);
  const records = await observer.call<LingAppServerWorkItemCollaborationReadResult>("workItem/collaboration/read", { workItemId });
  assert.deepEqual(records.records.map(record => record.kind), ["coordination", "brief", "coordination"]);
  assert.equal(records.records[2]?.id, closed);
  const terminal = records.records[2]?.payload as { closeReason: string; briefId: string };
  assert.equal(terminal.closeReason, "deadline");
  assert.equal(terminal.briefId, records.records[1]?.id);
  const current = await observer.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
  await observer.call("workItem/pause", { workItemId, expectedWorkItemRevision: Number(current.workItem.revision),
    expectedControlGeneration: 0, actorId: "local-user", idempotencyKey: "pause-coordination" });
  const skipped = await runAutomation({ idempotencyKey: "paused-coordination" });
  assert.equal(skipped.status, 202);
  const skipReceipt = (await skipped.json() as { automationRun: AutomationRun }).automationRun;
  assert.equal(skipReceipt.status, "skipped");
  assert.equal(skipReceipt.skipReason, "coordination_policy_denied");
  assert.equal(fixture.getStore().listRuns().length, 0);
  const secret = createHash("sha256").update(randomUUID()).digest("hex");
  const { grant } = await observer.call<{ grant: LingAppServerGrant }>("server/grants/create", {
    label: "Work Item coordination observer", subject: { kind: "workItem", id: workItemId }, scopes: ["observe"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), credentialSha256: createHash("sha256").update(secret).digest("hex"),
    idempotencyKey: "scoped-coordination",
  });
  const scoped = await fixture.connect("/app-server/rpc", fixture.cwd, `las1.${grant.grantId}.${secret}`);
  assert.deepEqual(await scoped.call("workItem/coordination/schedule/read", { workItemId, automationId: automation.id }), configured);
  await assert.rejects(scoped.call("workItem/coordination/schedule/set", { ...policy, expectedRevision: 1 }), { code: "capability_denied" });
  await assert.rejects(scoped.call("workItem/accept", { workItemId, expectedWorkItemRevision: Number(current.workItem.revision),
    dispatch: { threadId: home.id, message: "Start on another thread" }, idempotencyKey: "scoped-accept" }), { code: "capability_denied" });
});

test("Work Item controls commit state, receipt and event together and replay after a later control", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const created = await client.call<LingAppServerWorkItemResult>("workItem/create", {
    sourceId: "atomic-control", title: "Recover Work Item controls",
  });
  const { workItemId, workspaceId } = created.workItem;
  const peer = await fixture.connect();
  const { cursor, window } = await peer.call<LingAppServerSubscriptionResult>("workItem/subscribe", { workItemId });
  assert.ok(cursor && window);
  const input = {
    workItemId, actorId: "local-user", expectedWorkItemRevision: 1, expectedControlGeneration: 0, idempotencyKey: "atomic-pause",
  };
  const store = fixture.getStore();
  const database = new DatabaseSync(store.paths.databasePath);
  try {
    database.exec("CREATE TRIGGER fail_pause_event BEFORE INSERT ON control_plane_events WHEN NEW.action = 'work_item.control.pause' BEGIN SELECT RAISE(ABORT, 'fixture pause event rejected'); END");
    await assert.rejects(client.call("workItem/pause", input), /fixture pause event rejected/u);
    const { cwd, workItem } = await client.call<LingAppServerWorkItemReadResult>("workItem/read", { workItemId });
    assert.deepEqual({ cwd, workItem }, created);
    assert.equal(store.listAppServerState("work_item_control").length, 0);
    database.exec("DROP TRIGGER fail_pause_event");
  } finally {
    database.close();
  }
  const paused = await client.call<LingAppServerWorkItemControlResult>("workItem/pause", input);
  assert.equal(paused.workItem.control.state, "paused");
  assert.equal(paused.replayed, false);
  const resumed = await peer.call<LingAppServerWorkItemControlResult>("workItem/resume", {
    ...input, expectedWorkItemRevision: 2, expectedControlGeneration: 1, idempotencyKey: "atomic-resume",
  });
  assert.equal(resumed.workItem.control.state, "active");
  const events = () => fixture.getStore().listControlPlaneEvents({ workspaceId, entityId: workItemId, afterSeq: window.nextAfterSeq });
  assert.deepEqual(events().map(event => event.data.receiptId), [paused.controlReceipt.id, resumed.controlReceipt.id]);
  await fixture.restart();
  const restored = await fixture.connect();
  await restored.call("workItem/subscribe", { workItemId, cursor });
  await waitFor(() => restored.notices.find(notice => notice.method === "workItem/replay/ready"));
  const controls = restored.notices.filter(notice => notice.method === "workItem/control/updated");
  assert.deepEqual(controls.map(notice => notice.params?.event?.action), ["work_item.control.pause", "work_item.control.resume"]);
  const retry = await restored.call<LingAppServerWorkItemControlResult>("workItem/pause", input);
  assert.deepEqual(retry, { ...resumed, replayed: true, controlReceipt: paused.controlReceipt });
  await assert.rejects(restored.call("workItem/pause", { ...input, reason: "Different pause" }), { code: "idempotency_conflict" });
  assert.equal(events().length, 2);
});

test("a Pi question is pushed live, accepts the current Host authority once and replays its resolution", { timeout: 30_000 }, async t => {
  const answerText = "Use the repository contract.";
  const provider = await startLoopbackPiProvider((_: unknown, count: number) => count === 1 ? {
    tool: "request_user_input",
    input: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "scope", prompt: "Which contract should I use?", required: true, allowFreeText: true, options: [] },
    ] },
  } : { text: "Used the selected contract." });
  t.after(() => provider.close());
  const fixture = await releaseFixture(t, { harness: { toolBroker: { mode: "enforce" } } });
  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Host question" });
  const { cursor } = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  await client.call("thread/subscribe", { threadId: thread.id, cursor });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { run, turn } = await client.call<{ run: { id: string }; turn: { id: string } }>("turn/start", {
    threadId: thread.id, message: "Ask which contract applies.", idempotencyKey: "question-turn", providerPresetId: preset.id,
  });
  const request = await waitFor(() => client.notices.find(notice => notice.method === "input/requestAnswer"));
  assert.match(JSON.stringify(request), /Which contract should I use\?/u);
  assert.doesNotMatch(JSON.stringify(request), /answerAuthority/u);
  await waitFor(() => fixture.getStore().getRun(run.id)?.status === "yielded" ? true : undefined);
  const state = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  const authority = state.pendingInputs[0]?.answerAuthority;
  assert.ok(authority);
  assert.equal(authority.runId, run.id);
  assert.equal(request.params?.requestId, authority.requestId);
  assert.equal(state.pendingInputs[0]?.source.turnId, turn.id);
  await fixture.restart();
  const resumed = await fixture.connect();
  await resumed.call("thread/subscribe", { threadId: thread.id, cursor });
  await waitFor(() => resumed.notices.find(notice => notice.method === "input/requestAnswer"));
  const command: LingAppServerInputRespondParams = {
    schemaVersion: 1, authority, idempotencyKey: "question-answer",
    answers: [{ questionId: "scope", kind: "text", text: answerText }],
  };
  const parsed = parseUserInputAnswerCommandV1(command);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.error));
  await assert.rejects(resumed.call("input/respond", { ...command, cwd: fixture.root }), { code: "workspace_binding_invalid" });
  await assert.rejects(resumed.call("input/respond", { ...command, authority: { ...authority, statusRevision: authority.statusRevision + 1 } }),
    { code: "stale_revision" });
  await assert.rejects(resumed.call("input/respond", { ...command, authority: { ...authority, runId: "different-run" } }), { code: "stale_revision" });
  const accepted = await resumed.call<LingAppServerInputRespondResult>("input/respond", command);
  assert.equal(accepted.receipt.replayed, false);
  assert.equal(accepted.receipt.requestId, authority.requestId);
  const resolution = await waitFor(() => resumed.notices.find(notice =>
    notice.method === "serverRequest/resolved" && notice.params?.event?.entityId === authority.requestId));
  assert.equal(resolution.params?.event?.action, "answered");
  assert.doesNotMatch(JSON.stringify(resolution), new RegExp(answerText, "u"));
  const replay = await resumed.call<LingAppServerInputRespondResult>("input/respond", command);
  assert.deepEqual(replay.receipt, { ...accepted.receipt, replayed: true });
  await assert.rejects(resumed.call("input/respond", { ...command, idempotencyKey: "different-answer" }), { code: "idempotency_conflict" });
  await waitFor(() => fixture.getStore().getUserInputDelivery(thread.id, accepted.receipt.deliveryId)?.status === "applied" ? true : undefined);
  await waitFor(() => fixture.getStore().getLingTurn(turn.id)?.status === "succeeded" ? true : undefined);
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /Use the repository contract/u);
  const observer = await fixture.connect();
  await observer.call("thread/subscribe", { threadId: thread.id, cursor });
  await waitFor(() => observer.notices.find(notice => notice.method === "thread/replay/ready"));
  assert.equal(observer.notices.some(notice => notice.method === "input/requestAnswer"), false);
  assert.deepEqual(observer.notices.filter(notice => notice.method === "serverRequest/resolved"
    && notice.params?.event?.entityId === authority.requestId).map(notice => notice.params?.eventId), [resolution.params?.eventId]);
});

test("an authenticated connection can decide its Run approval and rejects a different workspace binding", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const taskId = "approval-fixture-task";
  const run = store.createRun({
    id: "approval-fixture-run", cwd: fixture.cwd, taskId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  store.markRunStarted(run.id, now);
  const approval = store.createApprovalRequest({
    runId: run.id, taskId, toolCallId: "fixture-tool", actionType: "bash", risk: "high",
    title: "Fixture only", description: "Test approval disposition", payload: {
      type: "bash", cwd: fixture.cwd, command: "true", riskFlags: [],
    },
  }, now);
  const params = { approvalId: approval.id, runId: run.id, decision: "deny" };
  await assert.rejects(client.call("approval/respond", { ...params, cwd: fixture.root }), { code: "workspace_binding_invalid" });
  assert.equal(store.getApprovalRequest(approval.id)?.status, "pending");
  await client.call("approval/respond", params);
  assert.equal(store.getApprovalRequest(approval.id)?.status, "denied");
  await assert.rejects(client.call("approval/respond", params), { code: "request_already_resolved" });
});

test("App Server grants restrict observers, controllers and approvers to their subject and revoke live access", { timeout: 30_000 }, async t => {
  const fixture = await releaseFixture(t);
  const operator = await fixture.connect();
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const subject = store.createLingThread({ kind: "conversation", title: "Scoped thread", objective: "Observe scoped progress" }, now);
  const other = store.createLingThread({ kind: "conversation", title: "Separate thread", objective: "Preserve privacy" }, now);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const grant = async (label: string, scopes: readonly LingAppServerGrantScope[]) => {
    const secret = createHash("sha256").update(randomUUID()).digest("hex");
    const input = {
      label, scopes, expiresAt, subject: { kind: "thread", id: subject.id },
      credentialSha256: createHash("sha256").update(secret).digest("hex"), idempotencyKey: label,
    };
    const result = await operator.call<{ grant: LingAppServerGrant }>("server/grants/create", input);
    assert.deepEqual(await operator.call("server/grants/create", input), result);
    assert.equal("credentialSha256" in result.grant, false);
    return { ...result, bearer: `las1.${result.grant.grantId}.${secret}` };
  };
  const observation = await grant("Observer", ["observe"]);
  const control = await grant("Controller", ["observe", "control"]);
  const approvals = await grant("Approver", ["observe", "approve"]);
  const observer = await fixture.connect("/app-server/rpc", fixture.cwd, observation.bearer);
  const controller = await fixture.connect("/app-server/rpc", fixture.cwd, control.bearer);
  const approver = await fixture.connect("/app-server/rpc", fixture.cwd, approvals.bearer);
  assert.deepEqual(observer.initialization?.effectiveScopes, ["observe"]);
  assert.ok(observer.initialization?.capabilities.includes("thread.events"));
  assert.ok(!observer.initialization?.capabilities.includes("turn.control"));
  const current = await observer.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: subject.id });
  const privileged = await operator.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: subject.id });
  assert.equal(current.thread.id, subject.id);
  await assert.rejects(observer.call("thread/snapshot", { threadId: other.id }), { code: "capability_denied" });
  await assert.rejects(observer.call("thread/subscribe", {}), { code: "capability_denied" });
  await assert.rejects(observer.call("thread/list"), { code: "capability_denied" });
  await assert.rejects(observer.call("server/grants/list"), { code: "capability_denied" });
  await assert.rejects(observer.call("turn/start", { threadId: subject.id, message: "Record this." }), { code: "capability_denied" });
  const rejectedCursor = await observer.call<LingAppServerThreadEventsResult>("thread/events/read", { threadId: subject.id, cursor: privileged.cursor });
  assert.equal(rejectedCursor.window.disposition, "snapshot_required");

  await observer.call("thread/subscribe", { threadId: subject.id, cursor: current.cursor });
  const turn = await controller.call<{ turn: { id: string } }>("turn/start", { threadId: subject.id, message: "Record this.", turnId: "scoped-turn" });
  assert.equal(turn.turn.id, "scoped-turn");
  await waitFor(() => observer.notices.find(notice => notice.method === "turn/started" && notice.params?.subject?.threadId === subject.id));
  await assert.rejects(controller.call("turn/start", { threadId: other.id, message: "Outside the grant." }), { code: "capability_denied" });
  const makeApproval = (threadId: string, id: string) => {
    const run = store.createRun({
      id, threadId, cwd: fixture.cwd, taskId: id, providerName: "fixture", providerModel: "fixture",
      taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
    });
    store.markRunStarted(run.id, now);
    return store.createApprovalRequest({
      runId: run.id, taskId: id, toolCallId: "approved-tool", actionType: "bash", risk: "medium",
      title: "Fixture approval", description: "Check approval ownership",
      payload: { type: "bash", cwd: fixture.cwd, command: "true", riskFlags: [] },
    }, now);
  };
  const allowedApproval = makeApproval(subject.id, "approved-run");
  const unrelatedApproval = makeApproval(other.id, "other-run");
  store.appendControlPlaneEvent({ workspaceId: subject.workspaceId, cwd: fixture.cwd, domain: "approvals",
    entityType: "approval", entityId: allowedApproval.id, action: "approval.created",
    data: { runId: allowedApproval.runId, threadId: subject.id } }, now);
  await approver.call("thread/subscribe", { threadId: subject.id });
  const pending = await waitFor(() => approver.notices.find(notice => notice.method === "approval/requestDecision" && notice.params?.approvalId === allowedApproval.id));
  assert.ok(pending.params?.revision);
  await assert.rejects(controller.call("approval/respond", { approvalId: allowedApproval.id, decision: "deny" }), { code: "capability_denied" });
  await assert.rejects(approver.call("approval/respond", { approvalId: unrelatedApproval.id, decision: "deny" }), { code: "capability_denied" });
  await assert.rejects(approver.call("approval/respond", { approvalId: allowedApproval.id, decision: "deny", expectedRevision: "stale" }),
    { code: "stale_revision" });
  assert.equal(store.getApprovalRequest(allowedApproval.id)?.status, "pending");
  await approver.call("approval/respond", { approvalId: allowedApproval.id, decision: "deny", expectedRevision: pending.params.revision });
  assert.equal(store.getApprovalRequest(allowedApproval.id)?.status, "denied");
  assert.equal(store.getApprovalRequest(unrelatedApproval.id)?.status, "pending");
  const reconnect = await fixture.connect("/app-server/rpc", fixture.cwd, approvals.bearer);
  await reconnect.call("thread/subscribe", { threadId: subject.id });
  await waitFor(() => reconnect.notices.find(notice => notice.method === "thread/replay/ready"));
  assert.ok(!reconnect.notices.some(notice => notice.method === "approval/requestDecision"));

  const input = new PassThrough(), output = new PassThrough();
  const running = runLingAppServerMcp({ ...fixture.transportOptions(), authToken: observation.bearer }, input, output);
  t.after(async () => { input.end(); await running; });
  const host = jsonLines(input, output);
  await host.call("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, clientInfo: { name: "Scoped fixture", version: "1" }, capabilities: {} });
  host.send("notifications/initialized", {});
  const { tools } = await host.call<{ tools: Array<{ name: string }> }>("tools/list");
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["ling_artifact_read", "ling_thread_events", "ling_thread_read", "ling_thread_snapshot"]);

  const closing = observer.waitForClose();
  await operator.call("server/grants/revoke", { grantId: observation.grant.grantId, expectedRevision: observation.grant.revision });
  const [code, reason] = await closing;
  assert.equal(code, 1008);
  assert.equal(String(reason), "authorization_changed");
  await fixture.restart();
  await assert.rejects(fixture.connect("/app-server/rpc", fixture.cwd, observation.bearer), /401/u);
  const restored = await fixture.connect("/app-server/rpc", fixture.cwd, control.bearer);
  const snapshot = await restored.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: subject.id });
  assert.equal(snapshot.thread.id, subject.id);
  await assert.rejects(fixture.connect("/rpc/stream", fixture.cwd, control.bearer), /401/u);
});

test("the dedicated TLS App Server accepts scoped controllers and revokes access across listeners", { timeout: 30_000 }, async t => {
  const provider = await startLoopbackPiProvider((_: unknown, count: number) => count === 1 ? {
    tool: "request_user_input",
    input: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "remote-scope", prompt: "Which compatibility contract applies?", required: true, allowFreeText: true, options: [] },
    ] },
  } : { text: "Used the authorized remote response." });
  t.after(() => provider.close());
  const fixture = await releaseFixture(t, {
    harness: { toolBroker: { mode: "enforce" } },
    wssConfig: async root => {
      const certificateFile = join(root, "certificate.pem");
      const privateKeyFile = join(root, "private-key.pem");
      const opensslConfig = join(root, "tls.cnf");
      await writeFile(opensslConfig, [
        "[req]", "prompt=no", "distinguished_name=dn", "x509_extensions=extensions", "[dn]", "CN=127.0.0.1",
        "[extensions]", "subjectAltName=IP:127.0.0.1", "basicConstraints=critical,CA:TRUE",
      ].join("\n"));
      execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-config", opensslConfig,
        "-keyout", privateKeyFile, "-out", certificateFile], { stdio: "ignore" });
      return { certificateFile, privateKeyFile, host: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"] };
    },
  });
  const host = await fixture.connect();
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { thread } = await host.call<ThreadRead>("thread/start", { title: "Remote authorized task" });
  const { thread: other } = await host.call<ThreadRead>("thread/start", { title: "Unrelated task" });
  const secret = createHash("sha256").update(randomUUID()).digest("hex");
  const { grant } = await host.call<{ grant: LingAppServerGrant }>("server/grants/create", {
    label: "Remote controller", scopes: ["observe", "control"], subject: { kind: "thread", id: thread.id },
    expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "remote-grant",
    credentialSha256: createHash("sha256").update(secret).digest("hex"),
  });
  const credential = `las1.${grant.grantId}.${secret}`;
  const url = new URL(fixture.wssUrl());
  url.pathname = "/app-server/rpc";
  url.searchParams.set("cwd", fixture.cwd);
  const ca = await readFile(join(fixture.root, "certificate.pem"));
  const open = (credential: string | undefined, options: { host?: string; origin?: string; trust?: boolean } = {}) => once(new WebSocket(url, {
    ca: options.trust === false ? undefined : ca,
    headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(options.host ? { Host: options.host } : {}), ...(options.origin ? { Origin: options.origin } : {}) },
  }), "open");
  await assert.rejects(open(undefined), /401/u);
  await assert.rejects(open(fixture.transportOptions().authToken), /401/u);
  await assert.rejects(open(credential, { host: "unapproved.example.test" }), /403/u);
  await assert.rejects(open(credential, { origin: "https://unapproved.example.test" }), /403/u);
  await assert.rejects(open(credential, { trust: false }), /certificate/u);
  const legacy = new URL(url);
  legacy.pathname = "/rpc/stream";
  await assert.rejects(once(new WebSocket(legacy, { ca, headers: { Authorization: `Bearer ${credential}` } }), "open"), /404/u);

  let socket: WebSocket | undefined;
  let socketCount = 0;
  const client = new LingAppServerClient({
    url: url.href, clientInfo: { name: "remote-contract-test", version: "1" }, reconnectDelayMs: 10,
    createSocket: address => {
      socketCount++;
      socket = new WebSocket(address, { ca, headers: { Authorization: `Bearer ${credential}` } });
      return socket as unknown as LingAppServerSocket;
    },
  });
  t.after(() => client.close());
  const notifications: string[] = [];
  client.onNotification(notification => notifications.push(notification.method));
  const states: string[] = [];
  client.onConnectionState(status => states.push(status.state));
  const remote = await client.connect();
  assert.deepEqual(remote.effectiveScopes, ["control", "observe"]);
  await client.subscribe({ threadId: thread.id });
  await assert.rejects(client.readThread(other.id), { code: "capability_denied" });
  const action = await client.startTurn({ threadId: thread.id, providerPresetId: preset.id,
    message: "Ask which compatibility contract applies.", idempotencyKey: "wss-turn" }) as { turn: { id: string }; run: { id: string } };
  assert.ok(action.turn.id && action.run.id);
  await waitFor(() => notifications.includes("turn/started") ? true : undefined);
  const answerSecret = randomBytes(32).toString("hex");
  const answerGrant = await host.call<{ grant: LingAppServerGrant }>("server/grants/create", {
    label: "Remote responder", scopes: ["observe", "respond"], subject: { kind: "thread", id: thread.id },
    expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "remote-answer-grant",
    credentialSha256: createHash("sha256").update(answerSecret).digest("hex"),
  });
  const responder = new LingAppServerClient({
    url: url.href, clientInfo: { name: "remote-response-test", version: "1" }, autoReconnect: false,
    createSocket: location => new WebSocket(location, {
      ca, headers: { Authorization: `Bearer las1.${answerGrant.grant.grantId}.${answerSecret}` },
    }) as unknown as LingAppServerSocket,
  });
  t.after(() => responder.close());
  const authority = await waitFor(async () => {
    const snapshot = await responder.readThreadSnapshot({ threadId: thread.id });
    return snapshot.pendingInputs[0]?.answerAuthority;
  });
  assert.equal(authority.runId, action.run.id);
  await waitFor(() => fixture.getStore().getRun(authority.runId)?.status === "yielded" ? true : undefined);
  const answer: LingAppServerInputRespondParams = {
    schemaVersion: 1, authority, idempotencyKey: "wss-answer",
    answers: [{ questionId: "remote-scope", kind: "text", text: "Use the accepted remote compatibility contract." }],
  };
  assert.equal((await client.readThreadSnapshot({ threadId: thread.id })).pendingInputs[0]?.answerAuthority, undefined);
  await assert.rejects(client.respondInput(answer), { code: "capability_denied" });
  const answered = await responder.respondInput(answer);
  assert.deepEqual((await responder.respondInput(answer)).receipt, { ...answered.receipt, replayed: true });
  await waitFor(() => provider.requests.length === 2 ? true : undefined);
  assert.match(JSON.stringify(provider.requests[1]), /Use the accepted remote compatibility contract/u);
  await waitFor(() => fixture.getStore().getLingTurn(action.turn.id)?.status === "succeeded" ? true : undefined);
  assert.ok(socket);
  const closed = once(socket, "close");
  await host.call("server/grants/revoke", { grantId: grant.grantId, expectedRevision: grant.revision });
  await closed;
  await waitFor(() => states.includes("authorization_required") ? true : undefined);
  assert.equal(socketCount, 1);
  await assert.rejects(open(credential), /401/u);
});

test("native CLI stdio and WebSocket share a Turn and replay its events after restart", { timeout: 30_000 }, async t => {
  const provider = await startLoopbackPiProvider(() => ({ text: "App Server transport verified" }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t);
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const { daemonUrl, authToken } = fixture.transportOptions();
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl, "app-server", "stdio"],
    { env: { ...process.env, LING_STACK_AUTH_TOKEN: authToken }, stdio: ["pipe", "pipe", "pipe"] });
  const childClosed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await childClosed; });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-2_000); });
  const host = jsonLines(child.stdin, child.stdout);
  const session = await host.call<LingAppServerInitializeResult>("initialize", { protocolVersions: ["ling-app-server/1"] });
  assert.equal(session.protocolVersion, "ling-app-server/1");
  const { thread } = await host.call<ThreadRead>("thread/start", { title: "Native transport" });
  const ws = await fixture.connect();
  assert.ok(session.serverInstanceId);
  assert.equal(session.serverInstanceId, ws.initialization?.serverInstanceId);
  const { cursor } = await ws.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  const { disposition } = await host.call<LingAppServerSubscriptionResult>("thread/subscribe", { threadId: thread.id, cursor });
  assert.equal(disposition, "complete");
  const { turn } = await ws.call<{ turn: { id: string } }>("turn/start", {
    threadId: thread.id, providerPresetId: preset.id, message: "Verify stdio and WebSocket on this host.", idempotencyKey: "native-transport-turn",
  });
  const completion = await waitFor(() => host.notices.find(notice =>
    notice.method === "turn/completed" && notice.params?.subject?.turnId === turn.id));
  assert.ok(completion.params?.eventId);
  assert.ok(validateLingAppServerNotificationParams("turn/completed", completion.params).ok);
  assert.equal(provider.requests.length, 1);
  child.stdin.end();
  const [exit, signal] = await childClosed;
  assert.equal(exit, 0, stderr);
  assert.equal(signal, null);
  await fixture.restart();
  const restored = await fixture.connect();
  assert.ok(restored.initialization?.serverInstanceId);
  assert.notEqual(restored.initialization.serverInstanceId, session.serverInstanceId);
  const snapshot = await restored.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  assert.equal(snapshot.turn?.id, turn.id);
  assert.equal(snapshot.turn?.status, "succeeded");
  await restored.call("thread/subscribe", { threadId: thread.id, cursor });
  await waitFor(() => restored.notices.find(notice => notice.params?.eventId === completion.params?.eventId));
  assert.equal(provider.requests.length, 1);
});

test("stdio and the private Unix socket deliver the same App Server Thread events", {
  timeout: 20_000, skip: process.platform === "win32",
}, async t => {
  const fixture = await releaseFixture(t);
  const options = fixture.transportOptions();
  assert.equal((await probeLingAppServer(options)).protocolVersion, "ling-app-server/1");
  const input = new PassThrough(), output = new PassThrough();
  const stdio = runLingAppServerStdio(options, input, output);
  t.after(async () => { input.end(); await stdio; });
  const host = jsonLines(input, output);
  await host.call("initialize", { protocolVersions: ["ling-app-server/1"] });
  const { thread } = await host.call<{ thread: { id: string } }>("thread/start", { title: "Stdio Thread" });
  await host.call("thread/subscribe", { threadId: thread.id });
  await host.call("turn/start", { threadId: thread.id, message: "Keep this durable" });
  const notice = await waitFor(() => host.notices.find(value => value.method === "turn/started"));
  assert.equal(notice.params?.subject?.threadId, thread.id);

  const controller = new AbortController();
  const path = join(fixture.root, "a.sock");
  const listener = listenLingAppServerSocket(options, path, controller.signal);
  t.after(async () => { controller.abort(); await listener; });
  await waitFor(async () => {
    const mode = (await lstat(path).catch(() => undefined))?.mode;
    return mode !== undefined && (mode & 0o777) === 0o600 ? true : undefined;
  });
  const socket: Duplex = createConnection(path);
  await once(socket, "connect");
  t.after(() => socket.destroy());
  const peer = jsonLines(socket, socket);
  await peer.call("initialize", { protocolVersions: ["ling-app-server/1"] });
  assert.equal((await peer.call<ThreadRead>("thread/read", { threadId: thread.id })).thread.id, thread.id);
  controller.abort();
  await listener;
  await assert.rejects(lstat(path), { code: "ENOENT" });
  const restart = new AbortController();
  const restarted = listenLingAppServerSocket(options, path, restart.signal);
  t.after(async () => { restart.abort(); await restarted; });
  await waitFor(async () => (await lstat(path).catch(() => undefined))?.isSocket() ? true : undefined);
  await unlink(path);
  await writeFile(path, "replacement");
  restart.abort();
  await restarted;
  assert.equal(await readFile(path, "utf8"), "replacement");
});

test("private Unix socket listener removes a stale published path before rebinding", {
  timeout: 20_000, skip: process.platform === "win32",
}, async t => {
  const fixture = await releaseFixture(t);
  const path = join(fixture.root, "stale.sock");
  const bindPath = join(fixture.root, "stale-binding.sock");
  const stale = createServer();
  stale.listen(bindPath);
  await once(stale, "listening");
  await chmod(bindPath, 0o660);
  await link(bindPath, path);
  await new Promise<void>(resolve => stale.close(() => resolve()));
  assert.equal((await lstat(path)).isSocket(), true);

  const controller = new AbortController();
  const listener = listenLingAppServerSocket(fixture.transportOptions(), path, controller.signal);
  t.after(async () => { controller.abort(); await listener; });
  await waitFor(async () => {
    const current = await lstat(path).catch(() => undefined);
    return current?.isSocket() && (current.mode & 0o777) === 0o600 ? true : undefined;
  });
  const socket = createConnection(path);
  await once(socket, "connect");
  socket.destroy();
  controller.abort();
  await listener;
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

type ThreadRead = { thread: { id: string } };

function readOnlyExternalConformance(adapterRevision: string) {
  return {
    adapterRevision, curatedTools: ["read"], toolSideEffects: { read: "workspace_read" },
    allowedSideEffects: ["none", "workspace_read"], nativeSideEffectMode: "disabled",
    toolSurfaceCurated: true, approvalBridgeVerified: true, sandboxBindingVerified: true,
    evidenceCommitVerified: true, abortPropagationVerified: true, attemptFencingVerified: true,
    workspaceBoundaryVerified: true, artifactImportVerified: true,
  } as const;
}

function addLoopbackPreset(store: SqliteRunStore, baseUrl: string) {
  const now = new Date().toISOString();
  const preset = store.createProviderPreset({
    kind: "openai-compatible", displayName: "Release Pi fixture", providerId: "release-pi-fixture", model: "static-tools",
    api: "openai-completions", baseUrl, authHeader: false, reasoning: false, capabilities: ["chat"], enabled: true,
  }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Loopback fixture", checkedAt: now });
  return preset;
}

test("the MCP bridge calls the bound App Server and replays the same Thread on retry", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const input = new PassThrough(), output = new PassThrough();
  const running = runLingAppServerMcp(fixture.transportOptions(), input, output);
  t.after(async () => { input.end(); await running; });
  const host = jsonLines(input, output);
  await host.call("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, clientInfo: { name: "Fixture", version: "1" }, capabilities: {} });
  host.send("notifications/initialized", {});
  const { tools } = await host.call<{ tools: Array<{ name: string }> }>("tools/list");
  assert.ok(tools.some(tool => tool.name === "ling_turn_start"));
  assert.ok(tools.some(tool => tool.name === "ling_work_item_stages"));
  assert.ok(tools.some(tool => tool.name === "ling_work_item_collaboration"));
  assert.ok(tools.some(tool => tool.name === "ling_plan_refine"));
  assert.ok(tools.some(tool => tool.name === "ling_plan_accept_workflow"));
  assert.ok(tools.some(tool => tool.name === "ling_handoff_resume"));
  assert.ok(tools.some(tool => tool.name === "ling_artifact_read"));
  assert.ok(tools.some(tool => tool.name === "ling_model_list"));
  assert.ok(tools.some(tool => tool.name === "ling_skill_read"));
  assert.ok(tools.some(tool => tool.name === "ling_permission_profile_list"));
  assert.ok(tools.every(tool => !tool.name.includes("approval")));
  const call = async (name: string, args: object) => {
    const reply = await host.call<{ isError?: boolean; content: Array<{ text: string }> }>("tools/call", { name, arguments: args });
    assert.ok(!reply.isError, reply.content[0]?.text);
    return JSON.parse(reply.content[0]!.text) as ThreadRead;
  };
  const request = { title: "MCP Thread", idempotencyKey: "identity" };
  const first = await call("ling_thread_start", request);
  assert.equal((await call("ling_thread_start", request)).thread.id, first.thread.id);
  assert.equal((await call("ling_thread_read", { threadId: first.thread.id })).thread.id, first.thread.id);
});

test("legacy RPC only exposes its existing methods and can still start and cancel a Run", { timeout: 20_000 }, async t => {
  let finishResponse: () => void = () => undefined;
  const response = new Promise<void>(resolve => { finishResponse = resolve; });
  const provider = await startLoopbackPiProvider(async () => {
    await response;
    return { text: "Legacy Run response" };
  });
  t.after(async () => {
    finishResponse();
    await provider.close();
  });
  const fixture = await releaseFixture(t, { requireAuth: false });
  const legacy = await fixture.connect("/rpc/stream");

  for (const method of ["turn/start", "thread/subscribe", "workItem/subscribe"]) {
    await assert.rejects(legacy.call(method), { code: "method_not_found" }, method);
  }

  await legacy.call("controlPlane.snapshot", { domains: ["providers"] });
  const store = fixture.getStore();
  const preset = addLoopbackPreset(store, provider.baseUrl);
  const task = { id: "legacy-rpc-run", title: "Legacy Run", prompt: "Check the project instructions." };
  const accepted = await legacy.call<{ accepted: boolean }>("runs.start", {
    cwd: fixture.cwd, providerPresetId: preset.id, skipProviderPreflight: true, task, tools: ["read"],
  });
  assert.equal(accepted.accepted, true);
  await waitFor(() => provider.requests.length === 1 ? true : undefined);
  const run = store.listRuns({ limit: 10 }).find(run => run.taskId === task.id);
  assert.ok(run);
  const cancelled = await legacy.call<{ cancelled: boolean }>("runs.cancel", { runId: run.id });
  assert.equal(cancelled.cancelled, true);
  assert.equal(store.getRun(run.id)?.status, "cancelled");
});

test("App Server replay cursors survive restart and stay bound to the workspace, subject and credential", { timeout: 20_000 }, async t => {
  const fixture = await releaseFixture(t);
  const client = await fixture.connect();
  assert.ok(client.initialization?.storeIncarnation && client.initialization.authorizationEpoch);
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Replay scope" });
  const other = await client.call<ThreadRead>("thread/start", { title: "Another Thread" });
  const { cursor } = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  const turn = await client.call<{ turn: { id: string } }>("turn/start", { threadId: thread.id, message: "Record a future instruction." });
  const read = { threadId: thread.id, cursor };
  const subscription = await client.call<LingAppServerSubscriptionResult>("thread/subscribe", read);
  assert.equal(subscription.disposition, "complete");
  const event = await waitFor(() => client.notices.find(notice => notice.method === "turn/started"
    && notice.params?.event?.entityId === turn.turn.id));
  assert.ok(event.params?.eventId);
  const mismatched = await client.call<LingAppServerSubscriptionResult>("thread/subscribe", { ...read, threadId: other.thread.id });
  assert.equal(mismatched.disposition, "snapshot_required");
  assert.equal(mismatched.window?.reason, "cursor_unavailable");
  const differentKind = await client.call<LingAppServerSubscriptionResult>("workItem/subscribe", { workItemId: thread.id, cursor });
  assert.equal(differentKind.disposition, "snapshot_required");

  const secondCwd = join(fixture.cwd, "other-workspace");
  await mkdir(secondCwd);
  const alias = join(fixture.root, "workspace-link");
  await symlink(secondCwd, alias, "dir");
  const secondWorkspace = await fixture.connect("/app-server/rpc", alias);
  await unlink(alias);
  await symlink(fixture.cwd, alias, "dir");
  assert.equal((await secondWorkspace.call<{ cwd: string }>("workspace/read")).cwd, secondCwd);
  await assert.rejects(secondWorkspace.call("workspace/read", { cwd: alias }), { code: "workspace_binding_invalid" });
  await secondWorkspace.call("thread/start", { threadId: thread.id, title: "Same ID in another workspace" });
  const differentWorkspace = await secondWorkspace.call<LingAppServerThreadEventsResult>("thread/events/read", read);
  assert.equal(differentWorkspace.window.disposition, "snapshot_required");
  assert.deepEqual(differentWorkspace.events, []);
  assert.equal(secondWorkspace.initialization?.storeIncarnation, undefined);

  await fixture.restart();
  const restored = await fixture.connect();
  assert.equal(restored.initialization?.storeIncarnation, client.initialization?.storeIncarnation);
  assert.equal(restored.initialization?.authorizationEpoch, client.initialization?.authorizationEpoch);
  await restored.call("thread/subscribe", read);
  const replayed = await waitFor(() => restored.notices.find(notice => notice.params?.eventId === event.params?.eventId));
  assert.equal(replayed.params?.event?.entityId, turn.turn.id);

  await fixture.restart({ rotateAuthToken: true });
  const rotated = await fixture.connect();
  assert.equal(rotated.initialization?.storeIncarnation, client.initialization?.storeIncarnation);
  assert.notEqual(rotated.initialization?.authorizationEpoch, client.initialization?.authorizationEpoch);
  const resync = await rotated.call<LingAppServerThreadEventsResult>("thread/events/read", read);
  assert.equal(resync.window.disposition, "snapshot_required");
  assert.deepEqual(resync.events, []);
  const current = await rotated.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  assert.equal((await rotated.call<LingAppServerSubscriptionResult>("thread/subscribe", {
    threadId: thread.id, cursor: current.cursor,
  })).disposition, "complete");
});

test("restoring a pre-cutover SQLite snapshot retains the recovery fence, observed GitHub delivery and grant revocation", { timeout: 35_000 }, async t => {
  const base = "b".repeat(40), mergedCommit = "c".repeat(40);
  const workflowPath = ".github/workflows/verify.yml";
  const workflow = "name: Trusted verification\n";
  const workflowSha256 = createHash("sha256").update(workflow).digest("hex");
  const prefix = "https://api.github.com/repos/example/ling";
  const checkRunUrl = `${prefix}/check-runs/18`;
  let head = "";
  const provider = await startLoopbackPiProvider(async () => ({ text: "Received after reconciliation" }));
  t.after(() => provider.close());
  const fixture = await releaseFixture(t, {
    recoveryJournal: true,
    githubSources: cwd => [{ workspaceRoot: cwd, repository: "example/ling", repositoryId: "73",
      deliveryPolicies: [{ baseRef: "main", requiredChecks: [
        { name: "unit", appId: 19, workflowId: 5, workflowPath, workflowSha256, basis: "head", coverageRefs: ["unit"] },
      ] }],
    }],
    externalWorkFetch: async (input, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      const path = String(input).slice(prefix.length);
      const responses: Record<string, object> = {
        "": { id: 73, full_name: "example/ling" },
        "/pulls/12": { number: 12, title: "Confirm the delivery", state: "closed", merged: true,
          base: { sha: base, ref: "main", repo: { id: 73 } }, head: { sha: head }, merge_commit_sha: mergedCommit },
        [`/git/commits/${mergedCommit}`]: { sha: mergedCommit, parents: [{ sha: base }, { sha: head }] },
        [`/actions/workflows/5/runs?head_sha=${head}&per_page=100`]: { total_count: 1, workflow_runs: [
          { id: 15, workflow_id: 5, head_sha: head, created_at: "2026-11-22T00:00:00Z", run_attempt: 1,
            status: "completed", path: workflowPath, event: "push" },
        ] },
        "/actions/runs/15": { id: 15, run_attempt: 1 },
        "/actions/runs/15/attempts/1/jobs?per_page=100": { total_count: 1, jobs: [
          { id: 16, run_id: 15, head_sha: head, name: "unit", check_run_url: checkRunUrl, status: "completed", conclusion: "success" },
        ] },
        [`/commits/${head}/check-runs?per_page=100&filter=latest`]: { total_count: 1, check_runs: [
          { id: 18, name: "unit", head_sha: head, status: "completed", conclusion: "success", url: checkRunUrl, app: { id: 19 } },
        ] },
        [`/contents/${workflowPath}?ref=${head}`]: {
          type: "file", path: workflowPath, encoding: "base64", content: Buffer.from(workflow).toString("base64"),
        },
      };
      return Object.hasOwn(responses, path) ? Response.json(responses[path]) : Response.json({}, { status: 404 });
    },
  });
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(fixture.cwd, "delivery.txt"), "Candidate content\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Candidate");
  head = git("rev-parse", "HEAD");

  const client = await fixture.connect();
  const { thread } = await client.call<ThreadRead>("thread/start", { title: "Record a delivery" });
  const { thread: newWork } = await client.call<ThreadRead>("thread/start", { title: "Next task" });
  const preset = addLoopbackPreset(fixture.getStore(), provider.baseUrl);
  const created = await client.call<LingAppServerWorkItemResult>("workItem/create", { sourceId: "rollback-delivery", title: "Confirm a merge" });
  const { workItemId } = created.workItem;
  const { workItem } = await client.call<LingAppServerWorkItemResult>("workItem/accept", {
    workItemId, expectedWorkItemRevision: Number(created.workItem.revision), idempotencyKey: "rollback-acceptance",
  });
  const { candidate } = await client.call<LingAppServerCaptureChangesResult>("changes/capture");
  const reconcileDelivery = async (connection: typeof client) => (await connection.call<LingAppServerGitHubDeliveryResult>("github/delivery/reconcile", {
    workItemId, threadId: thread.id, expectedWorkItemRevision: Number(workItem.revision),
    repository: "example/ling", pullRequestNumber: 12, candidateDigest: candidate.candidateDigest,
  })).delivery;
  const makeGrant = async (label: string, connection = client) => {
    const secret = createHash("sha256").update(randomUUID()).digest("hex");
    const { grant } = await connection.call<{ grant: LingAppServerGrant }>("server/grants/create", {
      label, idempotencyKey: label, subject: { kind: "thread", id: newWork.id }, scopes: ["control", "observe"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), credentialSha256: createHash("sha256").update(secret).digest("hex"),
    });
    return { grant, token: `las1.${grant.grantId}.${secret}` };
  };
  const previous = await makeGrant("Already issued");
  const revocable = await makeGrant("Revoke during cutover");
  const observer = await fixture.connect("/app-server/rpc", fixture.cwd, previous.token);
  await assert.rejects(observer.call("server/recovery/prepare", { expectedRevision: 0, idempotencyKey: "forbidden" }), { code: "capability_denied" });
  const { cursor } = await client.call<LingAppServerThreadSnapshotResult>("thread/snapshot", { threadId: thread.id });
  await observer.call("thread/subscribe", { threadId: newWork.id });

  const databasePath = fixture.getStore().paths.databasePath;
  const backup = join(fixture.root, "before-cutover.sqlite");
  backupSqlite(databasePath, backup);

  const observed = await reconcileDelivery(client);
  assert.equal(observed.status, "delivered");
  await client.call("server/grants/revoke", { grantId: revocable.grant.grantId, expectedRevision: revocable.grant.revision });
  const closed = observer.waitForClose();
  const prepare = { expectedRevision: 0, idempotencyKey: "restore-pre-cutover-snapshot" };
  const prepared = await client.call<LingAppServerRecoveryResult>("server/recovery/prepare", prepare);
  assert.equal(prepared.status, "reconciliation_required");
  assert.equal((await closed)[0], 1008);

  const premature = await fixture.connect();
  await assert.rejects(premature.call("server/recovery/reconcile", { expectedRevision: prepared.revision }), { code: "resume_blocked" });
  await fixture.restart({ beforeStart: () => restoreSqlite(databasePath, backup) });
  const restored = await fixture.connect();
  assert.notEqual(restored.initialization?.storeIncarnation, client.initialization?.storeIncarnation);
  assert.notEqual(restored.initialization?.authorizationEpoch, client.initialization?.authorizationEpoch);
  assert.equal((await restored.call<LingAppServerThreadEventsResult>("thread/events/read", { threadId: thread.id, cursor })).window.disposition, "snapshot_required");
  await assert.rejects(fixture.connect("/app-server/rpc", fixture.cwd, previous.token), /401/u);
  await assert.rejects(fixture.connect("/app-server/rpc", fixture.cwd, revocable.token), /401/u);
  await assert.rejects(restored.call("workItem/delivery/read", { workItemId }), { code: "github_delivery_binding_unavailable" });
  assert.deepEqual(await restored.call("server/recovery/prepare", prepare), prepared);
  const recoveryInput = { expectedRevision: prepared.revision };
  const blocked = await restored.call<LingAppServerRecoveryResult>("server/recovery/reconcile", recoveryInput);
  assert.equal(blocked.status, "reconciliation_required");
  assert.equal(blocked.pendingCount, 1);
  assert.ok(blocked.entries.some(entry => entry.kind === "grant_revocation" && entry.id === revocable.grant.grantId));
  const request = { threadId: newWork.id, message: "Proceed after reconciliation", providerPresetId: preset.id, idempotencyKey: "after-rollback" };
  await assert.rejects(restored.call("turn/start", request), { code: "resume_blocked" });
  const { daemonUrl, authToken } = fixture.transportOptions();
  const blockedHttp = await fetch(`${daemonUrl}/runs`, {
    method: "POST", headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: fixture.cwd, providerPresetId: preset.id,
      task: { id: "http-during-recovery", title: "Try to start during recovery", prompt: "Wait for recovery" }, tools: ["read"] }),
  });
  assert.equal(blockedHttp.status, 409);
  assert.equal((await blockedHttp.json() as { error: string }).error, "resume_blocked");
  const blockedNative = await fetch(`${daemonUrl}/runs`, {
    method: "POST", headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: fixture.cwd,
      executionBinding: { kind: "native_profile", engineId: "openclaw-acp", profileId: "held-profile", profileRevision: 1 },
      task: { id: "native-during-recovery", title: "Try to start a native Run during recovery", prompt: "Wait for recovery" } }),
  });
  assert.equal(blockedNative.status, 409);
  assert.equal((await blockedNative.json() as { error: string }).error, "resume_blocked");
  assert.equal(provider.requests.length, 0);

  assert.equal((await reconcileDelivery(restored)).deliveryId, observed.deliveryId);
  const reconciled = await restored.call<LingAppServerRecoveryResult>("server/recovery/reconcile", recoveryInput);
  assert.equal(reconciled.status, "ready");
  assert.equal(reconciled.pendingCount, 0);
  assert.equal(reconciled.entries.filter(entry => entry.kind === "github_delivery").length, 1);
  assert.deepEqual(await restored.call("server/recovery/read"), reconciled);
  await assert.rejects(fixture.connect("/app-server/rpc", fixture.cwd, previous.token), /401/u);
  await assert.rejects(fixture.connect("/app-server/rpc", fixture.cwd, revocable.token), /401/u);
  const renewed = await makeGrant("Current epoch", restored);
  const controller = await fixture.connect("/app-server/rpc", fixture.cwd, renewed.token);
  const { run } = await controller.call<{ run: { id: string } }>("turn/start", request);
  await waitFor(() => fixture.getStore().getRun(run.id)?.status === "succeeded" ? true : undefined);
  assert.equal(provider.requests.length, 1);
});

function backupSqlite(databasePath: string, backupPath: string): void {
  const db = new DatabaseSync(databasePath);
  try { db.prepare("VACUUM INTO ?").run(backupPath); } finally { db.close(); }
}

async function restoreSqlite(databasePath: string, backupPath: string): Promise<void> {
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await copyFile(backupPath, databasePath);
}

const previousBuild = process.env.LING_APP_SERVER_PREVIOUS_BUILD;
test("candidate App Server recovers v0.6.1 Thread state and preserves legacy clients", {
  skip: !previousBuild, timeout: 30_000,
}, async t => {
  const previousModule = (path: string) => pathToFileURL(join(previousBuild!, "packages", path)).href;
  const [daemon, core, sdk] = await Promise.all([
    import(previousModule("daemon/dist/index.js")) as Promise<Pick<ReleaseRuntime, "createDaemonServer">>,
    import(previousModule("core/dist/index.js")) as Promise<Omit<ReleaseRuntime, "createDaemonServer">>,
    import(previousModule("api-client/dist/index.js")) as Promise<{ LingDaemonClient: typeof LingDaemonClient }>,
  ]);
  const fixture = await releaseFixture(t, { initialRuntime: { ...core, ...daemon } });
  const legacyClient = () => {
    const { daemonUrl, authToken } = fixture.transportOptions();
    return new sdk.LingDaemonClient({ baseUrl: daemonUrl, fetch(input, init) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${authToken}`);
      return fetch(input, { ...init, headers });
    } });
  };
  const currentClient = (path: string) => {
    const { daemonUrl, authToken } = fixture.transportOptions();
    const url = new URL(path, daemonUrl);
    url.protocol = "ws:";
    url.searchParams.set("cwd", fixture.cwd);
    const client = new LingAppServerClient({
      url: url.href, clientInfo: { name: "release-compatibility", version: "1" }, autoReconnect: false,
      createSocket: url => new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }) as unknown as LingAppServerSocket,
      requestTimeoutMs: 3_000,
    });
    t.after(() => client.close());
    return client;
  };

  // A legacy client opens this workspace before the candidate migrates its database.
  await legacyClient().listApprovals(fixture.cwd);
  const store = fixture.getStore();
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", title: "Legacy delivery", objective: "Preserve the pending approval" }, now);
  const taskId = "legacy-task";
  const run = store.createRun({
    id: "legacy-run", threadId: thread.id, cwd: fixture.cwd, taskId, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now,
  });
  const turn = store.createLingTurn({
    threadId: thread.id, kind: "initial_request", title: "Legacy run", userInstruction: "Check the fixture", lastRunId: run.id,
  }, now);
  store.markRunStarted(run.id, now);
  const approval = store.createApprovalRequest({
    runId: run.id, taskId, toolCallId: "legacy-tool", actionType: "bash", risk: "high",
    title: "Fixture approval", description: "Verify approval survival across versions",
    payload: { type: "bash", cwd: fixture.cwd, command: "true", riskFlags: [] },
  }, now);
  const event = store.appendControlPlaneEvent({
    workspaceId: thread.workspaceId, cwd: fixture.cwd, domain: "approvals", entityType: "approval",
    entityId: approval.id, action: "approval.requested", data: { runId: run.id, threadId: thread.id },
  }, now);
  assert.equal((await legacyClient().getApproval(fixture.cwd, approval.id)).approval.status, "pending");
  const incompatible = currentClient("/rpc/stream");
  await assert.rejects(incompatible.startThread({ title: "Must not start", threadId: "refused-on-legacy" }), { code: "protocol_version_unsupported" });
  incompatible.close();
  assert.equal(store.getLingThread("refused-on-legacy"), undefined);

  await fixture.restart();
  const current = currentClient("/app-server/rpc");
  const snapshot = await current.readThreadSnapshot({ threadId: thread.id });
  assert.equal(snapshot.turn?.id, turn.id);
  assert.equal(snapshot.run?.id, run.id);
  assert.equal(snapshot.pendingApprovals.find(item => item.id === approval.id)?.status, "pending");
  assert.equal((await current.readThreadEvents({ threadId: thread.id, cursor: String(event.seq) })).window.disposition, "snapshot_required");
  const replay = await current.readThreadEvents({ threadId: thread.id });
  assert.ok(replay.events.some(item => item.seq === event.seq && item.entityId === approval.id));
  assert.equal((await legacyClient().getLingThread(fixture.cwd, thread.id)).thread.id, thread.id);
  await current.respondApproval({ approvalId: approval.id, runId: run.id, decision: "deny" });
  assert.equal((await legacyClient().getApproval(fixture.cwd, approval.id)).approval.status, "denied");

  const { daemonUrl, authToken } = fixture.transportOptions();
  const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
  const callCli = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      cli, "--cwd", fixture.cwd, "--daemon-url", daemonUrl, "app-server", ...args,
    ], { env: { ...process.env, LING_STACK_AUTH_TOKEN: authToken }, timeout: 8_000 });
    return JSON.parse(stdout);
  };
  assert.equal((await callCli("probe")).ok, true);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "ignore" });
  await writeFile(join(fixture.cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(fixture.cwd, "README.md"), "# Source compatibility fixture\n");
  git("init", "-q");
  git("add", ".gitignore", "README.md");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "CLI candidate");
  const draft = await callCli("instructions-init");
  assert.equal(draft.status, "draft");
  assert.equal(draft.draft.path, "AGENTS.md");
  await assert.rejects(readFile(join(fixture.cwd, "AGENTS.md")), { code: "ENOENT" });

  const candidate = await current.captureChanges();
  const planned = await callCli("verify", "--plan", "--thread", thread.id, "--check", "unregistered-check");
  assert.equal(planned.operation, undefined);
  assert.equal(planned.plan.candidate.candidateDigest, candidate.candidate.candidateDigest);
  assert.equal(planned.plan.threadId, thread.id);
  const started = await callCli("verify", "--thread", thread.id, "--check", "unregistered-check");
  const operation = await waitFor(async () => {
    const result = await callCli("verify-status", started.operation.operationId);
    return result.operation.completedAt ? result.operation : undefined;
  });
  assert.equal(operation.candidateDigest, candidate.candidate.candidateDigest);
  assert.deepEqual(operation.checks.map((check: { status: string }) => check.status), ["blocked"]);
});

type JsonLine = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
  params?: { codexUserAgent?: string; eventId?: string; requestId?: string; approvalId?: string; revision?: string;
    event?: { entityId: string; action: string; data?: Readonly<Record<string, unknown>> };
    itemId?: string; runId?: string; streamEpoch?: string; offset?: number; text?: string;
    subject?: { threadId?: string; turnId?: string; workItemId?: string } };
};

function jsonLines(input: Writable, output: Readable) {
  const messages = new Map<number, JsonLine>();
  const notices: JsonLine[] = [];
  let next = 0;
  let pending = "";
  output.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const message = JSON.parse(pending.slice(0, end)) as JsonLine;
      pending = pending.slice(end + 1);
      if (typeof message.id === "number") messages.set(message.id, message);
      else notices.push(message);
    }
  });
  const send = (method: string, params: object, id?: number) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return { send, notices, async call<T>(method: string, params: object = {}) {
    const id = ++next;
    send(method, params, id);
    const response = await waitFor(() => messages.get(id));
    messages.delete(id);
    if (response.error) throw new Error(response.error.message);
    return response.result as T;
  } };
}

type ReleaseRuntime = {
  createDaemonServer: typeof createDaemonServer;
  createSqliteRunStore: typeof createSqliteRunStore;
  resolveStoragePaths: typeof resolveStoragePaths;
};
const candidateRuntime: ReleaseRuntime = { createDaemonServer, createSqliteRunStore, resolveStoragePaths };

async function releaseFixture(t: TestContext, {
  runner, initialRuntime = candidateRuntime, harness, requireAuth = true, verificationRecipes, githubSources, externalWorkFetch, secretResolver, wssConfig,
  recoveryJournal = false,
}: {
  runner?: RunnerRegistrationInput;
  initialRuntime?: ReleaseRuntime;
  harness?: DaemonConfig["harness"];
  requireAuth?: boolean;
  verificationRecipes?: (root: string, cwd: string) => Promise<DaemonConfig["appServerVerificationRecipes"]>;
  githubSources?: (cwd: string) => DaemonConfig["appServerGitHubSources"];
  externalWorkFetch?: typeof fetch;
  secretResolver?: SecretResolver;
  wssConfig?: (root: string) => Promise<DaemonConfig["appServerWss"]>;
  recoveryJournal?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-as-")));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const appServerVerificationRecipes = await verificationRecipes?.(root, cwd);
  const appServerWss = await wssConfig?.(root);
  let authToken = randomUUID();
  const priorLingHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "fixture-home");
  const stores = new Map<string, SqliteRunStore>();
  const clients = new Set<WebSocket>();
  const makeDaemon = (runtime: ReleaseRuntime) => runtime.createDaemonServer({
    host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd, authToken: requireAuth ? authToken : undefined, harness,
    appServerVerificationRecipes, appServerGitHubSources: githubSources?.(cwd), appServerWss,
    ...(recoveryJournal ? { appServerRecoveryDirectory: join(root, "recovery-journal") } : {}),
  }, {
    ...(runner ? { runnerRegistry: createRunnerRegistry([runner]) } : {}),
    chromeBrowserNativeMessagingEnabled: false,
    externalWorkFetch,
    secretResolver,
    remoteReplyDispatcher: null,
    storeFactory(workspace) {
      const store = runtime.createSqliteRunStore(workspace, runtime.resolveStoragePaths(workspace, {
        homeDir: join(root, "fixture-home"), env: {}, workspaceStateLocation: "repo-local",
      }).workspace);
      stores.set(workspace, store);
      return store;
    },
  });
  let daemon = makeDaemon(initialRuntime);
  async function stop() {
    for (const socket of clients) socket.terminate();
    clients.clear();
    await daemon.stop();
  }
  t.after(async () => {
    try { await stop(); } finally {
      if (priorLingHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = priorLingHome;
      await rm(root, { recursive: true, force: true });
    }
  });
  await daemon.start();
  return {
    root,
    cwd,
    transportOptions() {
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      return { daemonUrl: `http://127.0.0.1:${address.port}`, cwd, authToken };
    },
    wssUrl() {
      const address = daemon.appServerWss?.address();
      assert.ok(address && typeof address === "object");
      return `wss://127.0.0.1:${address.port}`;
    },
    getStore() {
      const store = stores.get(cwd);
      assert.ok(store);
      return store;
    },
    async restart({ rotateAuthToken = false, beforeStart }: { rotateAuthToken?: boolean; beforeStart?: () => Promise<void> } = {}) {
      await stop();
      stores.clear();
      await beforeStart?.();
      if (rotateAuthToken) authToken = randomUUID();
      daemon = makeDaemon(candidateRuntime);
      await daemon.start();
    },
    async connect(path: "/app-server/rpc" | "/rpc/stream" = "/app-server/rpc", workspaceCwd = cwd, credential?: string) {
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}?cwd=${encodeURIComponent(workspaceCwd)}`, {
        headers: credential || requireAuth ? { Authorization: `Bearer ${credential ?? authToken}` } : undefined,
      });
      clients.add(socket);
      await once(socket, "open");
      let next = 0;
      const messages = new Map<number, { result?: unknown; error?: { data: { code: string }; message: string } }>();
      const notices: JsonLine[] = [];
      socket.on("message", data => {
        const value = JSON.parse(data.toString());
        if (typeof value.id === "number") messages.set(value.id, value);
        else notices.push(value);
      });
      const call = async <T>(method: string, params: object = {}): Promise<T> => {
        const id = ++next;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        const response = await waitFor(() => messages.get(id));
        messages.delete(id);
        if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.data.code });
        return response.result as T;
      };
      const initialization = path === "/app-server/rpc"
        ? await call<LingAppServerInitializeResult>("initialize", { protocolVersions: ["ling-app-server/1"] }) : undefined;
      if (initialization) {
        await call(credential ? "server/ping" : "workItem/list");
      } else {
        const initialized = await call<{ ok: boolean }>("initialize");
        assert.equal(initialized.ok, true);
      }
      return { call, notices, initialization, close: () => socket.terminate(), waitForClose: () => once(socket, "close") };
    },
  };
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for the App Server fixture.");
}

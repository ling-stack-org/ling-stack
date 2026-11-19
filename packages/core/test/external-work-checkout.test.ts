import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { ExternalWorkflowDefinition } from "../dist/index.js";

interface SpawnCall { readonly command: string; readonly args: unknown; readonly options: unknown }

const fixtureCredentialRemote = `https://${["user", "password-fixture"].join(":")}@git.example.com/repo.git`;

test("explicit workspace checkout respects hooks, recovery and the original process gate", async (t) => {
  const calls: SpawnCall[] = [];
  let result = { exitCode: 0, stdout: "", stderr: "", ignoreTerm: false };
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  t.mock.method(childProcess, "spawn", ((command: string, args: unknown, options: unknown) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        if (signal !== "SIGTERM" || !result.ignoreTerm) queueMicrotask(() => child.emit("close", null));
        return true;
      },
    });
    if (!result.ignoreTerm) queueMicrotask(() => {
      child.stdout.write(result.stdout); child.stderr.write(result.stderr); child.emit("close", result.exitCode);
    });
    return child as unknown as ChildProcess;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  const core = await import("../dist/index.js");

  function fixture(context: TestContext, overrides: { readonly afterCreate?: string; readonly beforeRun?: string; readonly timeoutMs?: number } = {}) {
    const cwd = mkdtempSync(resolve(tmpdir(), "ling-checkout-"));
    let store = core.createSqliteRunStore(cwd);
    context.after(() => { store.close(); rmSync(cwd, { recursive: true, force: true }); });
    const channel = store.createChannel({ name: "External", boundPath: cwd }, "2026-11-16T00:00:00.000Z");
    const workflow: ExternalWorkflowDefinition = core.parseExternalWorkflowMarkdown(`---
source:
  kind: linear
  projectSlug: project
workspace:
  root: workspaces
  gitRemoteUrl: https://git.example.com/owner/repo.git
hooks: ${JSON.stringify({ timeoutMs: 1000, ...overrides })}
---
Review {{ item.identifier }}.
`);
    const fetch = async () => new Response(JSON.stringify({ data: { issues: { nodes: [{
      id: "issue-id", identifier: "LIN-1", title: "Work", state: "open", project: { slug: "project" },
    }] } } }));
    return {
      cwd, workflow, get store() { return store; },
      reopen() { store.close(); store = core.createSqliteRunStore(cwd); },
      workspacePath: resolve(cwd, "workspaces", createHash("sha256").update("linear:issue:issue-id").digest("hex").slice(0, 24)),
      poll(executeHooks = true, definition = workflow) {
        return core.pollLinearExternalWork({ store, cwd, channelId: channel.id, workflowDirectory: cwd,
          workflowDefinition: definition, fetch, executeHooks, linearToken: "provider-fixture-secret" });
      },
    };
  }

  await t.test("checkout uses argument arrays, records evidence, then runs beforeRun", async (context) => {
    const f = fixture(context, { beforeRun: "check-workspace" }), before = calls.length;
    const polled = await f.poll();
    assert.equal(polled.claimed, 1);
    assert.equal(polled.schedulerStates[0].schedulerStatus, "ready");
    assert.deepEqual(calls.slice(before).map((call) => call.command), ["git", "check-workspace"]);
    assert.deepEqual(calls[before].args, ["clone", "--", f.workflow.config.workspace.gitRemoteUrl, "."]);
    const options = calls[before].options as childProcess.SpawnOptions;
    assert.equal(options.shell, false);
    assert.equal(options.cwd, polled.schedulerStates[0].workspacePath);
    assert.equal(options.env?.GIT_TERMINAL_PROMPT, "0");
    const artifact = polled.artifacts.find((item) => item.title === "External work Git checkout");
    assert.ok(artifact);
    const evidence = JSON.parse(readFileSync(resolve(f.store.paths.artifactsDir, artifact.path), "utf8"));
    assert.equal(evidence.type, "git_checkout"); assert.equal(evidence.exitCode, 0);
    assert.equal(evidence.remoteUrl, f.workflow.config.workspace.gitRemoteUrl);
    assert.ok(polled.schedulerStates[0].hookArtifactIds.includes(artifact.id));
    const duplicate = await f.poll();
    assert.equal(duplicate.duplicates, 1); assert.equal(calls.length, before + 2);
  });

  await t.test("checkout is skipped without opt-in, with afterCreate, or for an existing directory", async (context) => {
    const disabled = fixture(context), before = calls.length;
    assert.equal((await disabled.poll(false)).claimed, 1);
    assert.equal(calls.length, before);
    const hooked = fixture(context, { afterCreate: "custom-checkout", beforeRun: "check-workspace" });
    assert.equal((await hooked.poll()).claimed, 1);
    assert.deepEqual(calls.slice(before).map((call) => call.command), ["custom-checkout", "check-workspace"]);
    const existing = fixture(context);
    mkdirSync(existing.workspacePath, { recursive: true });
    writeFileSync(resolve(existing.workspacePath, "retained.txt"), "caller-owned");
    const existingBefore = calls.length;
    assert.equal((await existing.poll()).claimed, 1);
    assert.equal(calls.length, existingBefore);
    assert.deepEqual(readdirSync(existing.workspacePath), ["retained.txt"]);
  });

  await t.test("failed checkout persists bounded redacted evidence and cannot become ready after reopen", async (context) => {
    const f = fixture(context), before = calls.length;
    result = { exitCode: 7, stdout: "x".repeat(80_000),
      stderr: `${fixtureCredentialRemote}?token=query-fixture provider-fixture-secret`, ignoreTerm: false };
    const failed = await f.poll();
    assert.equal(failed.blocked, 1); assert.equal(failed.retryScheduled, 0);
    assert.equal(failed.schedulerStates[0].lastErrorCode, "workspace_checkout_failed");
    const artifact = failed.artifacts.find((item) => item.title === "External work Git checkout");
    assert.ok(artifact);
    const content = readFileSync(resolve(f.store.paths.artifactsDir, artifact.path), "utf8");
    assert.doesNotMatch(content, /password-fixture|query-fixture|provider-fixture-secret/);
    assert.ok(JSON.parse(content).stdout.length <= 64_000);
    f.reopen();
    assert.equal((await f.poll(false)).blocked, 1);
    assert.equal((await f.poll()).blocked, 1);
    assert.equal(calls.length, before + 1);
    result = { exitCode: 0, stdout: "", stderr: "", ignoreTerm: false };
    const repaired = await f.poll(true, { ...f.workflow, config: { ...f.workflow.config,
      workspace: { ...f.workflow.config.workspace, mode: "per_attempt" } } });
    assert.equal(repaired.schedulerStates[0].schedulerStatus, "ready");
    assert.equal(calls.length, before + 2);
  });

  await t.test("missing checkout evidence blocks the retained workspace", async (context) => {
    const f = fixture(context), createArtifact = f.store.createArtifact.bind(f.store), before = calls.length;
    context.mock.method(f.store, "createArtifact", (input: Parameters<typeof createArtifact>[0]) => {
      if (input.title === "External work Git checkout") throw new Error("artifact fixture failure");
      return createArtifact(input);
    });
    assert.equal((await f.poll()).blocked, 1);
    assert.equal((await f.poll(false)).blocked, 1);
    assert.equal(calls.length, before + 1);
  });

  await t.test("checkout timeout escalates termination and records the blocked outcome", async (context) => {
    const f = fixture(context, { timeoutMs: 5 }), before = signals.length;
    result = { exitCode: 0, stdout: "", stderr: "", ignoreTerm: true };
    const failed = await f.poll();
    assert.equal(failed.blocked, 1);
    assert.deepEqual(signals.slice(before), ["SIGTERM", "SIGKILL"]);
    const artifact = failed.artifacts.find((item) => item.title === "External work Git checkout");
    assert.ok(artifact);
    assert.equal(JSON.parse(readFileSync(resolve(f.store.paths.artifactsDir, artifact.path), "utf8")).timedOut, true);
    result = { exitCode: 0, stdout: "", stderr: "", ignoreTerm: false };
  });

  await t.test("original Host refusal is preserved without native launch or ordinary retry", async (context) => {
    const f = fixture(context), before = calls.length, refusal = new Error("fixture Host refusal");
    core.bindCoreOriginalProcessGuard(core.CORE_EXTERNAL_WORK_SCHEDULER_ENTRY, {
      assertMayLaunch() { throw refusal; }, nativeEntryEntered() { assert.fail("refused entry must not launch"); },
    });
    await assert.rejects(f.poll(), (error: unknown) => error === refusal && core.isCoreOriginalLaunchRefusal(error));
    assert.equal(calls.length, before);
    const state = f.store.listExternalWorkSchedulerStates()[0];
    assert.equal(state.schedulerStatus, "workspace_preparing");
    assert.equal(state.nextAttemptAt, undefined);
  });
});

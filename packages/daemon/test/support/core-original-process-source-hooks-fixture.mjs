import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

export const CORE_SOURCE_GATE_CODE = "protected_host_actor_unbound_with_active_stage";
export const CORE_SOURCE_FIXTURE_NOW = "2026-10-06T00:00:00.000Z";

/**
 * Observe captured original producers, not kernel/profile/descendant protection.
 * Install before Core or the existing source fixture is dynamically imported.
 * Git never reaches a real process; the one real shell mode accepts only a
 * fixed harmless printf command in this test's disposable workspace.
 */
export function observeCoreOriginalProcesses(t) {
  const originalExecFile = childProcess.execFile, originalSpawn = childProcess.spawn;
  const calls = [];
  let gitHandler = observedGitOutput, spawnError, spawnExitCode = 0, realShellRoot;
  const gitResult = (command, args, options) => {
    const call = { kind: "execFile", command, args: [...args], options };
    calls.push(call);
    assert.equal(command, "git", "this observer never launches real Git or a remote command");
    return { stdout: gitHandler(call), stderr: "" };
  };
  const observedExecFile = (command, args, options, callback) => {
    const child = new EventEmitter();
    try {
      const result = gitResult(command, args, options);
      queueMicrotask(() => callback(null, result.stdout, result.stderr));
    } catch (error) { queueMicrotask(() => callback(error, "", "")); }
    return child;
  };
  Object.defineProperty(observedExecFile, promisify.custom, {
    value(command, args, options) {
      try { return Promise.resolve(gitResult(command, args, options)); }
      catch (error) { return Promise.reject(error); }
    },
  });
  childProcess.execFile = observedExecFile;
  const spawnPatch = t.mock.method(childProcess, "spawn", (command, argsOrOptions, maybeOptions) => {
    const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
    const options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions;
    calls.push({ kind: "spawn", command, args, options });
    if (spawnError) throw spawnError;
    if (realShellRoot !== undefined) {
      assert.equal(command, "printf 'core-original-shell-positive'");
      assert.equal(options.shell, true);
      assert.ok(options.cwd.startsWith(realShellRoot + "/"));
      return originalSpawn(command, argsOrOptions, maybeOptions);
    }
    const child = new EventEmitter();
    Object.assign(child, { pid: 57000 + calls.length, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { return true; }, unref() {} });
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout.end("observed-source-hook-output");
      child.stderr.end(spawnExitCode === 0 ? "" : "observed-source-hook-error");
      child.exitCode = spawnExitCode;
      child.emit("exit", spawnExitCode, null); child.emit("close", spawnExitCode, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = originalExecFile;
    spawnPatch.mock.restore();
    syncBuiltinESMExports();
  });
  return { calls,
    setGitHandler(handler = observedGitOutput) { gitHandler = handler; },
    setSpawnError(error) { spawnError = error; },
    setSpawnExitCode(code = 0) { spawnExitCode = code; },
    enableRealShell(root) { realShellRoot = root; },
    disableRealShell() { realShellRoot = undefined; },
  };
}

/** Only exact default sources are actor evidence; no synthetic complete manifest is constructed. */
export async function loadCoreOriginalSourceHarness() {
  const core = await import("@ling-stack/core");
  const sourceFixture = await import("./protected-host-source-hooks-fixture.mjs");
  let bridge = {};
  try { bridge = await sourceFixture.loadSourceHookModule("runtime/sandbox/core-original-process-bridge.js"); }
  catch (error) {
    // Legacy dist must reach public producers with an active stage and go RED,
    // not skip because the new bridge export is missing.
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("core-original-process-bridge.js")) throw error;
  }
  let factory = {};
  try { factory = await import(new URL("original-host-process-entry.js", import.meta.resolve("@ling-stack/core")).href); }
  catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("original-host-process-entry.js")) throw error;
  }
  const entries = [bridge.CORE_OFFICIAL_SKILL_GIT_ACTOR_ENTRY, bridge.CORE_EXTERNAL_WORK_SCHEDULER_ACTOR_ENTRY]
    .filter(entry => entry !== undefined);
  return { core, factory, entries, ...sourceFixture,
    bind(fixture) { fixture.registry.bindOriginalActorEntries(entries); } };
}

export function makeOfficialCache(t, cwd) {
  const sourcesDir = join(cwd, "source-cache"), cacheRoot = join(sourcesDir, "official-gstack");
  mkdirSync(join(cacheRoot, ".agents", "skills"), { recursive: true, mode: 0o700 });
  return { sourcesDir, cacheRoot };
}

/** A disposable SQLite-backed poll fixture; never queries GitHub/Linear or a real user store. */
export function makeExternalPoll(core, store, cwd, kind = "github", command = "printf observed-core-source", options = {}) {
  const channel = store.createChannel({ name: "Core source " + kind, boundPath: cwd,
    defaultTeammateId: "engineer" }, CORE_SOURCE_FIXTURE_NOW);
  const markdown = [
    "---", "source:", "  kind: " + kind,
    kind === "github" ? "  repository: openclaw/openclaw" : "  projectSlug: ling-stack",
    "  events:", kind === "github" ? "    - pull_request.opened" : "    - issue.created",
    "agent:", "  teammateId: engineer", "scheduler:", "  reconcileOnStartup: false",
    "  pollIntervalMs: " + (options.pollIntervalMs ?? 30000), "  maxRetryBackoffMs: 1000",
    "hooks:", "  beforeRun: " + JSON.stringify(command), "  timeoutMs: 5000",
    "---", "", "Review {{ item.identifier }}.", "",
  ].join("\n");
  const workflowPath = join(cwd, "WORKFLOW-" + channel.id + ".md");
  writeFileSync(workflowPath, markdown, "utf8");
  const workflowDefinition = core.parseExternalWorkflowMarkdown(markdown), fetchCalls = [];
  const fetch = async url => {
    const value = String(url); fetchCalls.push(value);
    if (kind === "linear") return jsonResponse({ data: { issues: { nodes: [linearIssue()] } } });
    if (value.includes("/pulls?")) return jsonResponse([githubPull()]);
    if (value.includes("/issues?")) return jsonResponse([]);
    if (value.includes("/pulls/86279")) return jsonResponse(githubPull());
    throw new Error("Unexpected mocked external request: " + value);
  };
  const input = { store, cwd, channelId: channel.id, workflowDefinition, workflowDirectory: cwd,
    fetch, executeHooks: true, now: CORE_SOURCE_FIXTURE_NOW,
    ...(kind === "linear" ? { linearToken: "fixture-linear-token" } : {}) };
  return { channel, workflowPath, fetch, fetchCalls, input,
    poll() { return kind === "linear" ? core.pollLinearExternalWork(input) : core.pollGitHubExternalWork(input); } };
}

/** Observe and rethrow the real registry gate error without replacing the gate or its decision. */
export function recordRegistryRefusals(t, registry) {
  const original = registry.assertActorEntryLaunchCurrent, errors = [];
  t.mock.method(registry, "assertActorEntryLaunchCurrent", function (...args) {
    try { return Reflect.apply(original, this, args); }
    catch (error) { errors.push(error); throw error; }
  });
  return errors;
}

export function createPlainCoreWorkspace(t, core) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-core-original-prebinding-"));
  const cwd = join(root, "workspace"); mkdirSync(cwd, { mode: 0o700 });
  const store = core.createSqliteRunStore(cwd);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { cwd, store };
}

export async function waitForPublicScheduler(registry, cwd, predicate) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const scheduler = registry.list(cwd)[0];
    if (scheduler && predicate(scheduler)) return scheduler;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Public background scheduler did not reach its expected state");
}

function observedGitOutput({ args, options }) {
  if (args.includes("--show-toplevel")) return options.cwd + "\n";
  if (args.includes("remote.origin.url")) return "https://github.com/garrytan/gstack.git\n";
  if (args.includes("HEAD")) return "core-original-observed-revision\n";
  return "";
}
function jsonResponse(body) {
  return { ok: true, status: 200, statusText: "OK", async json() { return body; } };
}
function githubPull() {
  return { id: 1001, number: 86279, title: "Observe original source hooks", body: "Local fixture only.",
    html_url: "https://github.com/openclaw/openclaw/pull/86279", state: "open", labels: [],
    updated_at: "2026-05-29T20:26:56Z", base: { ref: "main", sha: "base-sha-1" },
    head: { ref: "fixture", sha: "head-sha-1" } };
}
function linearIssue() {
  return { id: "core-original-linear-123", identifier: "LIN-123", title: "Observe original source hooks",
    description: "Local fixture only.", url: "https://linear.app/ling-stack/issue/LIN-123",
    priority: 2, branchName: "fixture", updatedAt: "2026-06-01T00:00:00.000Z",
    state: { name: "Todo", type: "unstarted" }, labels: { nodes: [] },
    project: { name: "Ling Stack", slug: "ling-stack" }, team: { key: "LIN", name: "Ling" } };
}

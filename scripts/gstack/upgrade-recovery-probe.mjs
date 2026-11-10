import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSqliteRunStore } from "../../packages/core/dist/index.js";
import { PiRunnerAdapter } from "../../packages/runner-pi/dist/index.js";
import { createDaemonServer } from "../../packages/daemon/dist/index.js";
import { prepareBundledSkillStartup } from "../../packages/daemon/dist/features/skills/bundled-startup.js";
import { retainPackagedSkillGeneration } from "../../packages/daemon/dist/features/skills/packaged-history.js";
import { installPackagedSkillRuntime, packagedSkillEnvironment } from "../../packages/daemon/dist/features/skills/packaged-runtime.js";

const [work, selectionFile, phase] = process.argv.slice(2);
const selection = JSON.parse(await readFile(selectionFile)), cwd = join(work, "workspace"), calls = [];
await mkdir(cwd, { recursive: true });
const generations = await retainPackagedSkillGeneration(join(work, "cache"), selection,
  process.env.LING_GSTACK_BROWSER_ROOT);
installPackagedSkillRuntime(generations.current, phase === "missing" ? [] : generations.retained);
const initializeBundledSkills = await prepareBundledSkillStartup(selection);
class RecoveryRunner extends PiRunnerAdapter {
  async runTask(options) {
    const store = createSqliteRunStore(cwd);
    try {
      const run = store.getRun(options.runId), frozen = run.requestSnapshot.runnerExecutionInput;
      assert.deepEqual(frozen.preparedInput, options.preparedInput);
      const env = packagedSkillEnvironment(frozen.skillSourceContext, cwd);
      const command = spawnSync(process.execPath, ["--input-type=module", "-e",
        'import{readFileSync}from"node:fs";console.log(readFileSync(process.env.GSTACK_ROOT+"/generation.txt","utf8"))'],
      { env, encoding: "utf8", timeout: 3000 });
      assert.equal(command.status, 0, command.stderr);
      calls.push({ runId: run.id, generation: command.stdout.trim(),
        binding: frozen.skillSourceContext.resourceBinding, prompt: frozen.input.appendSystemPrompt.join("\n") });
      if (phase === "initial") throw new Error("synthetic retryable failure");
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "local recovery fixture" }] };
    } finally { store.close(); }
  }
}
const seed = createSqliteRunStore(cwd), now = new Date().toISOString();
let info;
if (phase === "initial") {
  const provider = seed.createProviderPreset({ kind: "openai-compatible", displayName: "No-transport recovery fixture",
    providerId: "local-recovery", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
    authHeader: false, reasoning: false, capabilities: ["chat", "tool_call"], enabled: true }, now);
  seed.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Synthetic only", checkedAt: now });
  seed.replaceTeammateSkillBindings("teammate_builtin_engineer", [{ skillId: "qa", enabled: true, source: "user" }], now);
  const channel = seed.createChannel({ name: "Recovery fixture", boundPath: cwd, defaultProviderPresetId: provider.id,
    defaultTeammateId: "teammate_builtin_engineer", allowedTools: ["read", "grep", "find", "ls", "bash"] }, now);
  const task = seed.createTask({ channelId: channel.id, title: "Frozen task", prompt: "Do not call a provider.",
    assigneeTeammateId: "teammate_builtin_engineer", requestedSkillId: "qa" }, now);
  info = { providerId: provider.id, taskId: task.id, channelId: channel.id };
} else info = JSON.parse(await readFile(join(work, "run-info.json")));
seed.close();
const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
  harness: { continuations: { mode: "enforce" } } }, { runner: new RecoveryRunner(), initializeBundledSkills });
await daemon.start();
const base = `http://127.0.0.1:${daemon.server.address().port}`;
const post = (path, body) => fetch(`${base}${path}?cwd=${encodeURIComponent(cwd)}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runTask = async taskId => {
  const response = await post(`/tasks/${taskId}/run`, { providerPresetId: info.providerId,
    tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write" });
  const text = await response.text(); assert.equal(response.status, 200, text);
};
try {
  if (phase === "initial") {
    await runTask(info.taskId);
    const store = createSqliteRunStore(cwd);
    try {
      const run = store.listRuns()[0]; assert.equal(run.status, "failed");
      info.runId = run.id; info.workUnitId = run.workUnitId; info.frozen = run.requestSnapshot.runnerExecutionInput;
      info.oldSnapshotId = store.getSkillSourceSnapshot("qa").id;
      await writeFile(join(work, "run-info.json"), JSON.stringify(info));
    } finally { store.close(); }
  } else {
    const response = await post(`/work-units/${info.workUnitId}/retry`, {}), result = await response.json();
    if (phase === "missing") {
      assert.equal(response.status, 409, JSON.stringify({ error: result.error, message: result.message }));
      assert.equal(result.error, "packaged_skill_resource_version_unavailable"); assert.equal(calls.length, 0);
    } else {
      assert.equal(response.status, 202, JSON.stringify(result));
      let completed;
      for (let i = 0; i < 100; i++) {
        const store = createSqliteRunStore(cwd);
        try { completed = store.getRun(info.runId); } finally { store.close(); }
        if (completed.status === "succeeded") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(completed.status, "succeeded");
      assert.deepEqual(completed.requestSnapshot.runnerExecutionInput, info.frozen);
      const store = createSqliteRunStore(cwd);
      const create = () => store.createTask({ channelId: info.channelId, title: "New task", prompt: "Local only",
        assigneeTeammateId: "teammate_builtin_engineer", requestedSkillId: "qa" }, new Date().toISOString());
      try {
        await runTask(create().id);
        store.rollbackSkillSourceSnapshot(info.oldSnapshotId, new Date().toISOString());
        assert.equal(store.getSkillSourceSnapshot("qa").bundleUpdateMode, "pinned");
        await runTask(create().id);
        assert.deepEqual(store.getRun(info.runId).requestSnapshot.runnerExecutionInput, info.frozen);
      } finally { store.close(); }
      assert.deepEqual(calls.map(call => call.generation), ["1", "2", "1"]);
      assert.match(calls[0].prompt, /# qa 1/); assert.match(calls[1].prompt, /# qa 2/);
      assert.deepEqual(calls[0].binding, info.frozen.skillSourceContext.resourceBinding);
    }
  }
} finally { await daemon.stop(); }
console.log(JSON.stringify({ phase, calls, noProviderTransport: true,
  scope: "real-daemon-sqlite-http-retry-and-bound-fixture-child-not-installed-gs-or-host-bash" }));

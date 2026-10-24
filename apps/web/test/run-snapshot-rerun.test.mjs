import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(`${specifier.slice(0, -3)}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const builders = await import("../src/api/run-request-builders.ts");
const run = overrides => ({
  id: "run_one", taskId: "task_one", channelId: "channel_one", cwd: "/isolated-workspace",
  providerPresetId: "provider_one", status: "failed",
  taskSnapshot: { id: "task_one", title: "Accepted task", prompt: "User objective", channelId: "channel_one" },
  requestSnapshot: { tools: ["read"], thinkingLevel: "medium" },
  ...overrides,
});

test("workflow runs cannot be reconstructed as independent tasks from a public or cached snapshot", () => {
  for (const source of [
    run({ workflowStepId: "step_one" }),
    run({ workflowStepId: "step_one", taskSnapshot: { id: "task_one", title: "Accepted task" } }),
    run({ requestSnapshot: { workflowStepId: "step_one" } }),
  ]) {
    assert.throws(() => builders.buildRerunRequest(source), /workflow step/iu);
    assert.equal(builders.canRerunSnapshot(source), false);
  }
});

test("snapshot capability requires an explicit accepted objective and a provider preset", () => {
  assert.equal(builders.canRerunSnapshot(undefined), false);
  assert.equal(builders.canRerunSnapshot(run({ providerPresetId: undefined })), false);
  for (const taskSnapshot of [undefined, {}, { prompt: "" }]) {
    assert.equal(builders.canRerunSnapshot(run({ taskSnapshot })), false);
    assert.throws(() => builders.buildRerunRequest(run({ taskSnapshot })), /no prompt/iu);
  }
  assert.equal(builders.canRerunSnapshot(run()), true);
  assert.equal(builders.canRerunSnapshot(run({ providerPresetId: undefined, requestSnapshot: { providerPresetId: "fallback" } })), true);
});

test("ordinary rerun uses the user task, not old cached internal system hydration", () => {
  const source = run({ requestSnapshot: {
    tools: ["read", "bash"], permissionMode: "standard", thinkingLevel: "high",
    systemPrompt: "private-cached-body", appendSystemPrompt: ["private-cached-body"],
    runnerExecutionInput: { input: { prompt: "private-cached-body" } },
    preselectedMemoryUse: { renderedPrompt: "private-cached-body" },
  } });
  const before = structuredClone(source);
  const request = builders.buildRerunRequest(source);
  assert.deepEqual(request.task, source.taskSnapshot);
  assert.deepEqual(request.tools, ["read", "bash"]);
  assert.equal(request.providerPresetId, "provider_one");
  assert.equal(request.thinkingLevel, "high");
  assert.equal(request.permissionMode, "standard");
  assert.doesNotMatch(JSON.stringify(request), /private-cached-body/u);
  assert.deepEqual(source, before);
});

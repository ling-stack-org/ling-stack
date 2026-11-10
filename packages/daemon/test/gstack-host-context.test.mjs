import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { withGstackHostContext } from "../dist/features/runs/gstack-host-context.js";
import { capturePreparedRunnerInput, restorePreparedRunnerOptions } from "../dist/features/runs/prepared-runner-input.js";

const context = { skillId: "review", sourceKind: "gstack-skill-directory", upstreamName: "gstack",
  loaded: true, truncated: false, runtimeViewKind: "original_source" };
function options(userInput) {
  return { cwd: "/fixture", task: { id: "host", title: "Review", prompt: "Review" },
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1" },
    appendSystemPrompt: ["ALL ORIGINAL RULES"], tools: ["read"],
    initialToolSurface: { mediaGeneration: false, toolHydration: false, userInput } };
}

test("gs Host mapping describes native structured questions only when the trusted surface is enabled", () => {
  const original = options(true), result = withGstackHostContext(original, context);
  assert.deepEqual(original.appendSystemPrompt, ["ALL ORIGINAL RULES"]);
  assert.equal(result.appendSystemPrompt[0], "ALL ORIGINAL RULES");
  const mapping = result.appendSystemPrompt.at(-1);
  assert.match(mapping, /Ling gs Host mapping v1/);
  assert.match(mapping, /AskUserQuestion.*request_user_input/);
  assert.match(mapping, /waitMode.*required/);
  assert.match(mapping, /questionId.*prompt.*required.*allowFreeText.*options/);
  assert.match(mapping, /not permission approval/);
  assert.match(mapping, /No native delegation tool/);
  assert.match(mapping, /must not.*shell.*HTTP/);
  assert.match(mapping, /Host approval and workspace policy/);
  assert.equal(result.initialToolSurface, original.initialToolSurface);
  assert.equal(result.tools, original.tools);
});

test("closed or absent question gates declare unavailable without exposing new tools", () => {
  for (const input of [options(false), { ...options(false), initialToolSurface: undefined }]) {
    const result = withGstackHostContext(input, context);
    assert.match(result.appendSystemPrompt.at(-1), /native structured questions are unavailable/);
    assert.doesNotMatch(result.appendSystemPrompt.at(-1), /Use request_user_input/);
    assert.equal(result.initialToolSurface, input.initialToolSurface);
    assert.equal(result.onUserInputRequest, undefined);
  }
});

test("custom, native, unloaded and incomplete source contexts do not receive a gs adapter", () => {
  const input = options(true);
  for (const source of [undefined, { ...context, sourceKind: "prompt" }, { ...context, loaded: false },
    { ...context, truncated: true }, { ...context, upstreamName: "custom" }]) {
    assert.equal(withGstackHostContext(input, source), input);
  }
});

test("actual Pi preparation freezes the gs question mapping with the native schema; revocation still rejects", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-gs-host-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const input = withGstackHostContext({ ...options(true), cwd, agentDir: join(cwd, "agent") }, context);
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(input);
  assert.match(preparedInput.systemPrompt, /Ling gs Host mapping v1/);
  const tool = preparedInput.tools.find(tool => tool.name === "request_user_input");
  assert.ok(tool);
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options: input, preparedInput, skillSourceContext: context });
  const restored = restorePreparedRunnerOptions(payload, input);
  assert.deepEqual(restored.preparedInput, preparedInput);
  assert.equal(restored.appendSystemPrompt.at(-1), input.appendSystemPrompt.at(-1));
  assert.throws(() => restorePreparedRunnerOptions(payload, { ...input,
    initialToolSurface: { ...input.initialToolSurface, userInput: false } }),
  error => error.code === "prepared_tool_capability_changed");
});

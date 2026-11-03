import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORTED_PROVIDER_APIS } from "../dist/constants.js";
import { createLingStackApprovalExtension } from "../dist/extensions/approval.js";
import { createLingStackBashToolExtension } from "../dist/extensions/bash.js";
import { getPiRunnerExtension } from "../dist/index.js";

test("runner-pi exposes OpenAI Codex Responses provider support", () => {
  assert.ok(SUPPORTED_PROVIDER_APIS.includes("openai-codex-responses"));
  assert.ok(getPiRunnerExtension().supportedProviderApis.includes("openai-codex-responses"));
});

test("unified exec bash extension returns daemon handled results", async () => {
  const registered = [];
  let resultHook;
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    async onApprovalRequired(request) {
      assert.equal(request.toolName, "bash");
      assert.equal(request.toolCallId, "tool_bash");
      assert.deepEqual(request.input, { command: "echo handled" });
      return {
        approved: true,
        handledResult: {
          content: [{ type: "text", text: "Command exited 0 in 12ms." }],
          details: { unifiedExec: { status: "succeeded" } },
        },
      };
    },
  })({ on(_event, handler) { resultHook = handler; }, registerTool: (tool) => registered.push(tool) });

  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].parameters.properties.prefix_rule.items, { type: "string" });
  const result = await registered[0].execute("tool_bash", { command: "echo handled" });
  assert.deepEqual(result.content, [{ type: "text", text: "Command exited 0 in 12ms." }]);
  assert.deepEqual(result.details, { unifiedExec: { status: "succeeded" } });
});

test("unified exec bash advertises the Host cwd contract without requiring a command rewrite", () => {
  const registered = [];
  createLingStackBashToolExtension(baseOptions())({ on() {}, registerTool: tool => registered.push(tool) });
  const tool = registered[0];
  assert.equal(tool.parameters.properties.cwd?.type, "string");
  assert.equal(tool.parameters.properties.cwd?.minLength, 1);
  assert.ok(!tool.parameters.required.includes("cwd"), "omitted cwd retains Host-selected defaults");
  assert.match(tool.description, /Host.*working directory/);
  assert.match(tool.description, /immutable.*operation/);
  assert.match(tool.parameters.properties.cwd.description, /workspace/);
});

test("unified exec bash forwards exact relative or absolute cwd to the Host, never local execution", async () => {
  const requests = [], registered = [];
  let resultHook;
  createLingStackBashToolExtension({
    ...baseOptions(),
    async onApprovalRequired(request) {
      requests.push(structuredClone(request));
      return { approved: false, handledResult: { content: [{ type: "text", text: "Host cwd mismatch" }], isError: true } };
    },
  })({ on(_event, handler) { resultHook = handler; }, registerTool: tool => registered.push(tool) });
  for (const cwd of ["project", `${process.cwd()}/project`]) {
    const input = { command: "node cli.js ../records.csv --json", cwd, timeout: 3 };
    const result = await registered[0].execute(`cwd-${requests.length}`, input);
    assert.deepEqual(requests.at(-1).input, input, "no cd or argv/cwd rewriting before Host authority");
    assert.equal(requests.at(-1).cwd, process.cwd(), "Runner cwd remains the session workspace root");
    assert.equal(result.content[0].text, "Host cwd mismatch");
    assert.equal(resultHook({ toolCallId: requests.at(-1).toolCallId, toolName: "bash", ...result, isError: false }).isError,
      true, "a Host directory denial remains an error at the SDK result hook");
  }
});

test("unified exec bash extension preserves daemon handled error results", async () => {
  const registered = [];
  let resultHook;
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => ({
      approved: true,
      handledResult: {
        content: [{ type: "text", text: "Command exited 2 in 8ms." }],
        details: { unifiedExec: { status: "failed", exitCode: 2 } },
        isError: true,
      },
    }),
  })({ on(_event, handler) { resultHook = handler; }, registerTool: (tool) => registered.push(tool) });

  const result = await registered[0].execute("tool_bash_failed", { command: "exit 2" });
  assert.deepEqual(result.content, [{ type: "text", text: "Command exited 2 in 8ms." }]);
  assert.deepEqual(result.details, { unifiedExec: { status: "failed", exitCode: 2 } });
  assert.equal(resultHook({ toolCallId: "tool_bash_failed", toolName: "bash", ...result, isError: false }).isError, true);
});

test("unified exec bash extension returns daemon handled denial results", async () => {
  const registered = [];
  let resultHook;
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => ({
      approved: false,
      reason: "policy denied bash",
      handledResult: {
        content: [{ type: "text", text: "Ling Stack policy denied bash." }],
        details: { unifiedExec: { status: "failed", denied: true } },
        isError: true,
      },
    }),
  })({ on(_event, handler) { resultHook = handler; }, registerTool: (tool) => registered.push(tool) });

  const result = await registered[0].execute("tool_bash_denied", { command: "rm -rf out" });
  assert.equal(result.content[0].text, "Ling Stack policy denied bash.");
  assert.deepEqual(result.details, { unifiedExec: { status: "failed", denied: true } });
  assert.equal(resultHook({ toolCallId: "tool_bash_denied", toolName: "bash", ...result, isError: false }).isError, true);
});

test("unified exec bash extension fails closed without handled result", async () => {
  const registered = [];
  let resultHook;
  createLingStackBashToolExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => ({ approved: true }),
  })({ on(_event, handler) { resultHook = handler; }, registerTool: (tool) => registered.push(tool) });

  await assert.rejects(
    registered[0].execute("tool_bash_missing", { command: "echo missing" }),
    /approved bash without a handled result/,
  );
});

test("approval listener skips bash when unified exec owns the tool", async () => {
  let handler;
  createLingStackApprovalExtension({
    ...baseOptions(),
    runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: () => {
      throw new Error("approval listener should not handle bash");
    },
  })({ on: (_event, nextHandler) => { handler = nextHandler; } });

  const result = await handler({ toolName: "bash", toolCallId: "tool_bash", input: { command: "echo ok" } });
  assert.equal(result, undefined);
});

function baseOptions() {
  return {
    cwd: process.cwd(),
    task: { id: "task", title: "Task", prompt: "Run bash" },
    provider: { provider: "test", model: "test" },
  };
}

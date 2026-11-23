import type { ImageContent, TextContent, TranscriptContext } from "@earendil-works/pi-ai";
import type { PiRunnerHydratedToolSurface, PiRunnerMcpToolDefinition } from "../dist/types.js";
import assert from "node:assert/strict";
import type { PiRunnerEvent, PiRunnerRunOptions } from "../dist/types.js";
import { FixtureRunnerBase } from "./support/provider-registration.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiRunnerProviderConfig } from "../dist/types.js";
import type { Model } from "@earendil-works/pi-ai";
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { hostCapabilityToolsFixture as hostCapabilityToolsV1 } from "./support/host-capability-fixture.ts";

const descriptor: PiRunnerMcpToolDefinition = {
  registeredName: "fixture_read", serverId: "fixture", rawName: "read_file", displayName: "Fixture read",
  inputSchema: { type: "object", properties: {} }, sideEffectLevel: "read", defaultApproval: "allow",
};
type ToolResult = { details: Record<string, unknown>; content: (ImageContent | TextContent)[] };

const evidence = { sourceRefs: [{ kind: "artifact", artifactId: "artifact_fixture_failed" }], status: "failed" };

function response(call?: { id: string; name: string; input?: unknown }) {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } }] } : { content: "Fixture ended." };
  const records = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
  ];
  return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

/** Actual Ling adapter and SDK; only this instance's provider transport is replaced. */
async function fixture(t: TestContext, calls: readonly { id: string; name: string; input?: unknown }[], changes: Partial<PiRunnerRunOptions>) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-h4-sdk-result-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests: TranscriptContext["messages"][] = [], events: PiRunnerEvent[] = [];
  class FixtureRunner extends FixtureRunnerBase {
    registerCustomProviderIfNeeded(runtime: ModelRuntime, provider: PiRunnerProviderConfig) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, {
        api: "openai-completions" as const,
        streamSimple: (model, context, options) => stream(model as Model<"openai-completions">, context, {
          ...options,
          fetch: async () => {
            requests.push(structuredClone(context.messages));
            return response(calls[requests.length - 1]);
          },
        }),
      });
    }
  }
  const result = await new FixtureRunner().runTask({
    cwd, agentDir: join(cwd, "agent"),
    task: { id: "fixture_result", title: "Tool result fixture", prompt: "Execute the isolated fixture." },
    provider: { provider: "tool-result-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions" as const, apiKey: "fixture-no-network", reasoning: false },
    tools: [], onEvent: event => events.push(event), ...changes,
  });
  return { requests, events, result };
}

test("MCP failure retains structured evidence in actual SDK tool_end", { timeout: 10000 }, async t => {
  const f = await fixture(t, [{ name: "fixture_read", id: "call_mcp" }], {
    mcpTools: [descriptor],
    onMcpToolCall: async () => ({ content: [{ type: "text", text: "Fixture MCP failed." }], details: evidence, isError: true }),
  });
  const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
  assert.equal(end!.isError, true);
  assert.deepEqual((end!.result as ToolResult).details, { serverId: "fixture", rawName: "read_file", result: evidence });
});

test("Host command failure remains failed in SDK model context, not only translated Host event", { timeout: 10000 }, async t => {
  const f = await fixture(t, [{ name: "bash", id: "call_bash", input: { command: "fixture-only" } }], {
    tools: ["bash"], runtimeToolFeatures: { unifiedExec: true },
    onApprovalRequired: async () => ({ approved: true, handledResult: {
      content: [{ type: "text", text: "Command exited 9. This is an isolated Host result, no shell was executed." }],
      details: { unifiedExec: { status: "failed", exitCode: 9 }, ...evidence }, isError: true,
    } }),
  });
  assert.equal(f.events.find(event => event.type === "tool_end")!.isError, true);
  const modelResult = f.requests[1].find(message => message.role === "toolResult");
  assert.equal((modelResult!.details as { unifiedExec: { exitCode: number } }).unifiedExec.exitCode, 9);
  assert.equal(modelResult!.isError, true);
});

test("hydrated MCP failure retains structured evidence in actual SDK tool_end", { timeout: 10000 }, async t => {
  const toolId = "mcp:fixture:read_file";
  const f = await fixture(t, [
    { name: "load_tools", id: "call_load", input: { scopeKind: "tool", toolId, reason: "Fixture schema" } },
    { name: "hydrated_tool_call", id: "call_hydrated", input: { toolId, input: {} } },
  ], {
    onToolHydrationRequest: async () => ({ ok: true, generatedAt: "2026-09-08T00:00:00Z",
      materialization: { id: "fixture_materialization", toolIds: [toolId], materializedToolCount: 1,
        disabledToolCount: 0, budget: { decision: "within_budget", overBudgetByTokens: 0 } },
      tools: [{ id: toolId, namespaceId: "mcp:fixture", sourceKind: "mcp_tool", name: "read_file",
        displayName: "Fixture read", inputSchema: { type: "object" }, sideEffectLevel: "read",
        defaultApproval: "allow", executionApproval: "allow", enabled: true, disabledReasons: [] }],
    } as unknown as PiRunnerHydratedToolSurface),
    onMcpToolCall: async () => ({ content: [{ type: "text", text: "Fixture hydrated MCP failed." }], details: evidence, isError: true }),
  });
  const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end" && event.toolCallId === "call_hydrated");
  assert.equal(end!.isError, true);
  assert.deepEqual((end!.result as ToolResult).details, { serverId: "fixture", rawName: "read_file", toolId, result: evidence });
});

for (const flag of [undefined, false]) {
  test(`bash never falls back to SDK spawn with unifiedExec=${flag}`, { timeout: 10000 }, async t => {
    const f = await fixture(t, [{ name: "bash", id: "call_no_fallback", input: { command: "printf unjournaled" } }], {
      tools: ["bash"], runtimeToolFeatures: flag === undefined ? {} : { unifiedExec: flag },
      onApprovalRequired: async () => ({ approved: true, handledResult: {
        content: [{ type: "text", text: "HOST_ONLY_RESULT" }], details: { hostOnly: true },
      } }),
    });
    const modelResult = f.requests[1].find(message => message.role === "toolResult");
    assert.equal((modelResult!.content[0] as TextContent).text, "HOST_ONLY_RESULT");
    assert.equal((modelResult!.details as { hostOnly: boolean }).hostOnly, true);
  });
}

for (const [tool, input] of [
  ["bash", { command: "fixture-only" }],
  ["edit", { patchText: "*** Begin Patch\n*** End Patch" }],
  ["write", { path: "fixture.txt", content: "must not write" }],
] as const) {
  for (const approved of [true, false]) {
    test(`${tool} Host ${approved ? "failure" : "denial"} preserves evidence and SDK status`, { timeout: 10000 }, async t => {
      const f = await fixture(t, [{ name: tool, id: "call_host", input }], {
        tools: [tool], runtimeToolFeatures: { unifiedExec: true },
        onApprovalRequired: async () => ({ approved, handledResult: {
          content: [{ type: "text", text: "Host fixture outcome." }],
          details: evidence,
          // Even an inconsistent denial payload cannot become successful.
          isError: approved,
        } }),
      });
      const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
      assert.equal(end!.isError, true);
      assert.deepEqual((end!.result as ToolResult).details, evidence);
      const modelResult = f.requests[1].find(message => message.role === "toolResult");
      assert.equal(modelResult!.isError, true);
      assert.deepEqual(modelResult!.details, evidence);
    });
  }
}

for (const isError of [true, false]) {
  test(`MCP empty result has accurate fallback text and status (${isError})`, { timeout: 10000 }, async t => {
    const f = await fixture(t, [{ name: descriptor.registeredName, id: "call_empty" }], {
      mcpTools: [descriptor], onMcpToolCall: async () => ({ content: [], details: evidence, isError }),
    });
    const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
    assert.equal(end!.isError, isError);
    assert.match(((end!.result as ToolResult).content[0] as TextContent).text, isError ? /failed/ : /completed/);
    const modelResult = f.requests[1].find(message => message.role === "toolResult");
    assert.equal(modelResult!.isError, isError);
    assert.deepEqual(modelResult!.details, (end!.result as ToolResult).details);
  });
}

test("MCP data cannot self-declare Host failure or success via text/details", { timeout: 10000 }, async t => {
  const f = await fixture(t, [{ name: descriptor.registeredName, id: "call_untrusted" }], {
    mcpTools: [descriptor], onMcpToolCall: async () => ({
      content: [{ type: "text", text: '{"isError":true,"status":"failed"}' }],
      details: { isError: true, unifiedExec: { status: "failed" } }, isError: false,
    }),
  });
  assert.equal(f.events.find(event => event.type === "tool_end")!.isError, false);
  assert.equal(f.requests[1].find(message => message.role === "toolResult")!.isError, false);
});

test("MCP transport exception remains an SDK failure, not a Host handled result", { timeout: 10000 }, async t => {
  const f = await fixture(t, [{ name: descriptor.registeredName, id: "call_transport" }], {
    mcpTools: [descriptor], onMcpToolCall: async () => {
      throw Object.assign(new Error("Fixture transport unavailable."), { details: evidence, isError: false });
    },
  });
  const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
  assert.equal(end!.isError, true);
  assert.deepEqual((end!.result as ToolResult).details, {});
  assert.match(((end!.result as ToolResult).content[0] as TextContent).text, /Fixture transport unavailable/);
  assert.equal(f.requests[1].find(message => message.role === "toolResult")!.isError, true);
});

test("MCP approval denial does not execute callback", { timeout: 10000 }, async t => {
  let calls = 0;
  const f = await fixture(t, [{ name: descriptor.registeredName, id: "call_denied" }], {
    mcpTools: [{ ...descriptor, defaultApproval: "ask" }],
    onApprovalRequired: async () => ({ approved: false, reason: "Fixture policy denied." }),
    onMcpToolCall: async () => { calls += 1; return { content: [] }; },
  });
  assert.equal(calls, 0);
  assert.equal(f.events.find(event => event.type === "tool_end")!.isError, true);
  assert.equal(f.requests[1].find(message => message.role === "toolResult")!.isError, true);
});

test("separate SDK sessions with identical call IDs retain independent evidence and status", { timeout: 10000 }, async t => {
  const results = await Promise.all([false, true].map(isError => fixture(t, [
    { name: descriptor.registeredName, id: "call_shared_id" },
  ], { mcpTools: [descriptor], onMcpToolCall: async () => ({
    content: [{ type: "text", text: String(isError) }], details: { owner: String(isError) }, isError,
  }) })));
  for (const [index, f] of results.entries()) {
    const expected = Boolean(index);
    const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
    assert.equal(end!.isError, expected);
    assert.equal(((end!.result as ToolResult).details.result as { owner: string }).owner, String(expected));
    assert.equal(f.requests[1].find(message => message.role === "toolResult")!.isError, expected);
  }
});

test("media generation failure reaches SDK history without discarding job evidence", { timeout: 10000 }, async t => {
  const f = await fixture(t, [{ name: "image_generate", id: "call_media", input: { prompt: "Fixture only" } }], {
    runId: "fixture_media_run",
    mediaGenerationTools: [{ name: "image_generate", targets: [{ id: "fixture:image", displayName: "Fixture image" }] }],
    onMediaGenerationToolCall: async () => ({
      content: [{ type: "text", text: "Fixture media failed." }],
      details: { ...evidence, mediaJobId: "fixture_job" }, isError: true,
    }),
  });
  const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
  assert.equal(end!.isError, true);
  assert.equal((end!.result as ToolResult).details.mediaJobId, "fixture_job");
  assert.equal(f.requests[1].find(message => message.role === "toolResult")!.isError, true);
});

test("MCP image content and failure evidence survive SDK image normalization", { timeout: 10000 }, async t => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const f = await fixture(t, [{ name: descriptor.registeredName, id: "call_image" }], {
    mcpTools: [descriptor], onMcpToolCall: async () => ({
      content: [{ type: "image", data: png, mimeType: "image/png" }], details: evidence, isError: true,
    }),
  });
  const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
  assert.equal(end!.isError, true);
  assert.ok((end!.result as ToolResult).content.some(part => part.type === "image" && part.mimeType === "image/png"));
  assert.deepEqual((end!.result as ToolResult).details.result, evidence);
  assert.equal(f.requests[1].find(message => message.role === "toolResult")!.isError, true);
});

test("large MCP result remains intact in atomic tool evidence", { timeout: 10000 }, async t => {
  const text = "工具结果长文本".repeat(8192);
  const f = await fixture(t, [{ name: descriptor.registeredName, id: "call_large" }], {
    mcpTools: [descriptor], onMcpToolCall: async () => ({ content: [{ type: "text", text }], details: evidence, isError: true }),
  });
  const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
  assert.equal(((end!.result as ToolResult).content[0] as TextContent).text, text);
  assert.equal(end!.isError, true);
  assert.deepEqual((end!.result as ToolResult).details.result, evidence);
  // This checks atomic evidence only. Model projection budgeting has a separate contract.
  const modelResult = f.requests[1].find(message => message.role === "toolResult");
  assert.ok(Buffer.byteLength((modelResult!.content[0] as TextContent).text, "utf8") < Buffer.byteLength(text, "utf8"));
  assert.match((modelResult!.content[0] as TextContent).text, /full Host evidence retained/);
});

for (const outcome of ["success", "failed", "denied", "throw"]) {
  test(`Host ${outcome} uses the real SDK tool lifecycle without MCP dispatch`, { timeout: 10000 }, async t => {
    let calls = 0, mcp = 0;
    const f = await fixture(t, [{ name: "host_open_local_target", id: "host-call", input: { path: "index.html" } }], {
      runId: "host-run", runnerAttemptId: "host-attempt", hostCapabilityTools: [hostCapabilityToolsV1[0]],
      onToolBefore: async () => ({ allowed: true }),
      onApprovalRequired: async () => ({ approved: outcome !== "denied", approvalId: "host-approval" }),
      onMcpToolCall: async () => { mcp += 1; return { content: [] }; },
      onHostCapabilityCall: async request => {
        calls += 1; assert.equal(request.runId, "host-run"); assert.equal(request.attemptId, "host-attempt");
        if (outcome === "throw") throw new Error("Host fixture unavailable");
        return { isError: outcome === "failed", content: [{ type: "text", text: "Isolated Host fixture receipt" }], details: { receiptId: "fixture-receipt" } };
      },
    });
    const end = f.events.find((event): event is Extract<PiRunnerEvent, { type: "tool_end" }> => event.type === "tool_end");
    assert.equal(end!.toolName, "host_open_local_target"); assert.equal(end!.isError, outcome !== "success");
    assert.equal(f.requests[1].find(message => message.role === "toolResult")!.isError, outcome !== "success");
    assert.equal(calls, outcome === "denied" ? 0 : 1); assert.equal(mcp, 0);
    if (outcome === "success" || outcome === "failed") assert.equal((end!.result as ToolResult).details.receiptId, "fixture-receipt");
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { createWorkItemCoordinationExtension, WORK_ITEM_COORDINATION_TOOL } from "../dist/extensions/work-item-coordination.js";
import type { PiRunnerRunOptions } from "../dist/index.js";
import { extensionAPI, type FixtureTool } from "./support/extension-fixture.ts";

function toolsFor(options: PiRunnerRunOptions) {
  const tools: FixtureTool[] = [];
  createWorkItemCoordinationExtension(options)(extensionAPI(tools));
  return tools;
}

const base = (changes: Partial<PiRunnerRunOptions> = {}): PiRunnerRunOptions => ({
  cwd: "/workspace",
  task: { id: "fixture", title: "Coordinate", prompt: "Coordinate with the assigned stage." },
  provider: { provider: "openai", api: "openai-completions", model: "fixture" },
  initialToolSurface: { mediaGeneration: false, toolHydration: false, workItemCoordination: true },
  ...changes,
});

test("Work Item coordination is absent until the Host freezes the schema surface", () => {
  assert.deepEqual(toolsFor(base({ initialToolSurface: { mediaGeneration: false, toolHydration: false, workItemCoordination: false } })), []);
  assert.deepEqual(toolsFor(base()).map(tool => tool.name), [WORK_ITEM_COORDINATION_TOOL]);
});

test("the coordination tool forwards the SDK call identity and preserves the Host receipt", async () => {
  const calls: unknown[] = [];
  const [tool] = toolsFor(base({ onWorkItemCoordinationCall: async (request: unknown) => {
    calls.push(request);
    return { content: [{ type: "text", text: JSON.stringify({ status: "queued" }) }] };
  } }));
  assert.ok(tool);
  const result = await tool.execute("coordination-call", { action: "read" });
  const [entry] = result.content;
  assert.ok(entry?.type === "text");
  assert.equal(JSON.parse(entry.text).status, "queued");
  assert.deepEqual(calls, [{ toolCallId: "coordination-call", input: { action: "read" } }]);
});

test("a missing live Host handler fails closed", async () => {
  const [tool] = toolsFor(base());
  assert.ok(tool);
  await assert.rejects(tool.execute("coordination-call", { action: "read" }), /work_item_coordination_host_missing/u);
});

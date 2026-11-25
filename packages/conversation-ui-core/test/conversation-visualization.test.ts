import assert from "node:assert/strict";
import test from "node:test";
import { parseMessageBody, readConversationVisualizationReferences } from "../dist/index.js";

const first = "viz_" + "a".repeat(32);
const second = "viz_" + "b".repeat(32);
const link = (id: string, label = "Interface") => "[" + label + "](#ling-visualization-v1-" + id + ")";

test("only explicit top-level visualization references become blocks in finished assistant text", () => {
  const body = ["Before", link(first), "> " + link(second), "- " + link(second),
    "Snippet: " + link(second), "```demo\n" + link(second) + "\n```", link(first), link(second), "After"].join("\n\n");
  const refs = [{ artifactId: first, label: "Interface" }, { artifactId: second, label: "Interface" }];
  assert.deepEqual(readConversationVisualizationReferences(body), refs);
  const active = parseMessageBody(body, undefined, { allowVisualizations: true });
  assert.deepEqual(active.map(block => block.kind), ["paragraph", "visualization", "quote", "list", "paragraph", "code", "paragraph", "visualization", "paragraph"]);
  assert.deepEqual(active.flatMap(block => block.kind === "visualization" ? [block.reference] : []), refs);
  assert.ok(parseMessageBody(body).every(block => block.kind !== "visualization"));
  assert.ok(parseMessageBody(body, undefined, { allowVisualizations: true, streaming: true }).every(block => block.kind !== "visualization"));
});

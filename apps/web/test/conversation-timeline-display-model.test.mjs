import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true },
});
const { projectConversationTimelineDisplayModel } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/conversation-timeline-display-model.ts",
);
const { conversationTimelineSubAgentDisclosureKey } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/conversation-timeline-view-retain-keys.ts",
);
after(async () => vite.close());

test("stable rows retain identity when history is prepended or canonical positions change", () => {
  const first = message("stable-first", 0);
  const second = message("stable-second", 1);
  const before = projectConversationTimelineDisplayModel([first, second], new Map());
  const after = projectConversationTimelineDisplayModel([
    message("older", 0),
    { ...first, threadSequence: 10, partIndex: 2 },
    { ...second, threadSequence: 11, partIndex: 3, revision: 2 },
  ], new Map());
  for (const item of [first, second]) {
    assert.equal(after.locationByItemId.get(item.id)?.rowKey, before.locationByItemId.get(item.id)?.rowKey);
  }
});

function displayBatch(kind, count = 3, overrides = {}) {
  const children = Array.from({ length: count }, (_, index) => ({
    ...lineage, id: `${kind}:child:${index}`, kind: kind === "commandBatch" ? "commandExecution" : "exploration",
    threadSequence: index + 2, partIndex: 0, actionId: `action:${index}`,
  }));
  return {
    ...lineage, id: `${kind}:batch`, kind,
    batch: { id: `${kind}:batch`, revisionKey: "1", defaultExpanded: false,
      ...(kind === "commandBatch" ? { commands: children } : { children }) },
    ...overrides,
  };
}

for (const kind of ["commandBatch", "explorationBatch"]) {
  test(`${kind} counts and indexes collapsed atomic rows in the root window`, () => {
    const batch = displayBatch(kind, 1_000);
    const model = projectConversationTimelineDisplayModel([batch], new Map());
    assert.equal(model.rows.length, 1);
    assert.equal(model.potentialRowCount, 1_001);
    assert.equal(model.locationByItemId.get(`${kind}:child:999`)?.visible, false);
    assert.deepEqual(model.locationByItemId.get(`${kind}:child:999`)?.disclosurePath, [batch.batch.id]);
  });

  test(`${kind} expands atomic rows without changing their identity or duplicating facts`, () => {
    const batch = displayBatch(kind);
    const closed = projectConversationTimelineDisplayModel([batch], new Map());
    const open = projectConversationTimelineDisplayModel([batch], new Map([
      [batch.batch.id, { revisionKey: "1", expanded: true, touched: true }],
    ]));
    assert.deepEqual(open.rows.map((row) => row.item.id), [batch.id,
      `${kind}:child:0`, `${kind}:child:1`, `${kind}:child:2`]);
    assert.equal(open.locationByItemId.get(`${kind}:child:2`)?.rowKey,
      closed.locationByItemId.get(`${kind}:child:2`)?.rowKey);
    assert.equal(open.rows[1].parentBatchId, batch.id);
    assert.equal(open.rows[1].depth, 0);
  });
}

test("Agent plus batch disclosure forms one reveal path and preserves atomic leading items", () => {
  const batch = displayBatch("commandBatch");
  batch.batch.commands[1].leadingItems = [message("leading:before-command", 2)];
  const agent = subAgent({ childItems: [batch] });
  const agentKey = conversationTimelineSubAgentDisclosureKey(agent.id);
  const closed = projectConversationTimelineDisplayModel([agent], new Map());
  const location = closed.locationByItemId.get("leading:before-command");
  assert.deepEqual(location?.disclosurePath, [agentKey, batch.batch.id]);
  assert.equal(closed.potentialRowCount, 6);
  const open = projectConversationTimelineDisplayModel([agent], new Map([
    [agentKey, { revisionKey: "1", expanded: true, touched: true }],
    [batch.batch.id, { revisionKey: "1", expanded: true, touched: true }],
  ]));
  assert.deepEqual(open.rows.map((row) => row.item.id), [agent.id, batch.id,
    "commandBatch:child:0", "leading:before-command", "commandBatch:child:1", "commandBatch:child:2"]);
  assert.ok(open.rows.slice(1).every((row) => row.depth === 1 && row.parentSubAgentId === agent.id));
  assert.equal(open.locationByItemId.get("leading:before-command")?.rowKey, location.rowKey);
  assert.equal(open.rows.at(-1).childIndex, open.rows.at(-1).childCount - 1);
});

test("batch row identity survives unbatching and touched expansion survives streaming revisions", () => {
  const batch = displayBatch("commandBatch");
  const disclosure = new Map([[batch.batch.id, { revisionKey: "1", expanded: true, touched: true }]]);
  const revised = { ...batch, revision: 2, batch: { ...batch.batch, revisionKey: "2" } };
  const batched = projectConversationTimelineDisplayModel([revised], disclosure);
  const atomic = projectConversationTimelineDisplayModel(batch.batch.commands, new Map());
  assert.equal(batched.rows.length, 4);
  assert.deepEqual(batched.rows.slice(1).map((row) => row.rowKey), atomic.rows.map((row) => row.rowKey));
});

const lineage = {
  revision: 1,
  threadSequence: 1,
  partIndex: 0,
  sourceRefs: [],
};

function message(id, sequence = 1) {
  return {
    ...lineage,
    id,
    threadSequence: sequence,
    kind: "agentMessage",
    markdown: id,
  };
}

function subAgent(overrides = {}) {
  return {
    ...lineage,
    id: "sub-agent:engineer",
    kind: "subAgentActivity",
    participantId: "engineer",
    runId: "run_engineer",
    attemptId: "attempt_engineer",
    workflowStepId: "step_engineer",
    label: "Engineer",
    lifecycle: "completed",
    childItems: [message("message:child:1", 2), message("message:child:2", 3)],
    ...overrides,
  };
}

test("display model keeps completed Agent children collapsed but locatable", () => {
  const agent = subAgent();
  const model = projectConversationTimelineDisplayModel([
    message("message:before", 0),
    agent,
    message("message:after", 4),
  ], new Map());

  assert.deepEqual(model.rows.map((row) => [row.kind, row.item.id, row.depth]), [
    ["item", "message:before", 0],
    ["subAgentHeader", agent.id, 0],
    ["item", "message:after", 0],
  ]);
  assert.equal(model.potentialRowCount, 5);
  assert.equal(model.locationByItemId.get("message:child:2")?.parentSubAgentId, agent.id);
  assert.equal(model.locationByItemId.get("message:child:2")?.visible, false);
});

test("display model flattens expanded Agent children into root order with stable parent-scoped keys", () => {
  const agent = subAgent();
  const disclosureId = conversationTimelineSubAgentDisclosureKey(agent.id);
  const model = projectConversationTimelineDisplayModel(
    [message("message:before", 0), agent, message("message:after", 4)],
    new Map([[disclosureId, { expanded: true, revisionKey: "1", touched: true }]]),
  );

  assert.deepEqual(model.rows.map((row) => [row.kind, row.item.id, row.depth]), [
    ["item", "message:before", 0],
    ["subAgentHeader", agent.id, 0],
    ["subAgentChild", "message:child:1", 1],
    ["subAgentChild", "message:child:2", 1],
    ["item", "message:after", 0],
  ]);
  const childRows = model.rows.filter((row) => row.kind === "subAgentChild");
  assert.equal(new Set(childRows.map((row) => row.rowKey)).size, 2);
  assert.ok(childRows.every((row) => row.rowKey.includes(encodeURIComponent(agent.id))));
  assert.equal(model.locationByItemId.get("message:child:2")?.visible, true);
});

test("touched disclosure survives a revision while untouched state follows the new default", () => {
  const running = subAgent({ revision: 2, lifecycle: "running" });
  const disclosureId = conversationTimelineSubAgentDisclosureKey(running.id);
  const touched = projectConversationTimelineDisplayModel(
    [running],
    new Map([[disclosureId, { expanded: false, revisionKey: "1", touched: true }]]),
  );
  const untouched = projectConversationTimelineDisplayModel(
    [running],
    new Map([[disclosureId, { expanded: false, revisionKey: "1", touched: false }]]),
  );

  assert.equal(touched.rows.length, 1);
  assert.equal(untouched.rows.length, 3);
});

test("nested Agent child becomes one depth-one diagnostic and never a depth-two row", () => {
  const nested = subAgent({
    id: "sub-agent:nested",
    participantId: "nested",
    label: "Nested",
    childItems: [message("message:must-not-render", 9)],
  });
  const root = subAgent({ childItems: [nested] });
  const disclosureId = conversationTimelineSubAgentDisclosureKey(root.id);
  const model = projectConversationTimelineDisplayModel(
    [root],
    new Map([[disclosureId, { expanded: true, revisionKey: "1", touched: true }]]),
  );

  assert.deepEqual(model.rows.map((row) => [row.item.kind, row.item.id, row.depth]), [
    ["subAgentActivity", root.id, 0],
    ["diagnostic", `diagnostic:nested-depth:${nested.id}`, 1],
  ]);
  assert.equal(model.locationByItemId.get(nested.id)?.rowKey, model.rows[1]?.rowKey);
  assert.equal(model.locationByItemId.has("message:must-not-render"), false);
});

test("display row keys encode parent and item ids without delimiter collisions", () => {
  const first = subAgent({
    id: "a:b",
    childItems: [message("c", 7)],
  });
  const second = subAgent({
    id: "a",
    childItems: [message("b:c", 7)],
  });
  const disclosureById = new Map([
    [conversationTimelineSubAgentDisclosureKey(first.id), { expanded: true, revisionKey: "1", touched: true }],
    [conversationTimelineSubAgentDisclosureKey(second.id), { expanded: true, revisionKey: "1", touched: true }],
  ]);
  const model = projectConversationTimelineDisplayModel([first, second], disclosureById);
  const childRows = model.rows.filter((row) => row.kind === "subAgentChild");

  assert.equal(childRows.length, 2);
  assert.equal(new Set(childRows.map((row) => row.rowKey)).size, 2);
  assert.match(childRows[0].rowKey, /a%3Ab:c$/);
  assert.match(childRows[1].rowKey, /a:b%3Ac$/);
});

test("display row keys remain stable across item revisions", () => {
  const initial = subAgent({
    revision: 1,
    childItems: [message("message:stable", 7)],
  });
  const revised = subAgent({
    revision: 9,
    childItems: [{ ...message("message:stable", 7), revision: 12 }],
  });
  const disclosureById = new Map([[
    conversationTimelineSubAgentDisclosureKey(initial.id),
    { expanded: true, revisionKey: "1", touched: true },
  ]]);
  const before = projectConversationTimelineDisplayModel([initial], disclosureById);
  const after = projectConversationTimelineDisplayModel([revised], disclosureById);

  assert.deepEqual(
    after.rows.map((row) => row.rowKey),
    before.rows.map((row) => row.rowKey),
  );
});

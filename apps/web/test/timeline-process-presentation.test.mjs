import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", server: { middlewareMode: true } });
const { projectTimelineProcessSections } = await vite.ssrLoadModule("/src/shared/conversation/timeline/timeline-process-presentation.ts");
const { projectTimelineActivitySections } = await vite.ssrLoadModule("/src/shared/conversation/timeline/timeline-activity-presentation.ts");
const { summarizeTimelineProcess, timelineActivityCategory } = await vite.ssrLoadModule("/src/shared/conversation/timeline/timeline-process-summary.ts");
const { projectConversationTimelineDisplayModel } = await vite.ssrLoadModule("/src/shared/conversation/timeline/conversation-timeline-display-model.ts");
after(() => vite.close());
const base = { revision: 1, turnId: "turn", runId: "run", attemptId: "attempt", participantId: "ling_agent", workflowStepId: null, sourceRefs: [], threadSequence: 1, partIndex: 0, status: "succeeded" };
const message = (id, phase = "commentary", more = {}) => ({ ...base, id, kind: "agentMessage", phase, markdown: id, ...more });
const action = (id, more = {}) => ({ ...base, id, kind: "exploration", actionId: id, operation: "read", title: "Read", targets: [], ...more });

test("completed summaries count unique atomic facts through display batches, without reading command claims", () => {
  const read = action("read"), grep = action("grep", { operation: "grep" });
  const command = action("command", { kind: "commandExecution", command: "echo 'tests passed; modified 12 files'" });
  const edit = action("edit", { kind: "fileChange", files: [{ fileRef: { kind: "file", id: "a", path: "/a.ts" } }] });
  const editAgain = { ...edit, id: "edit-again", actionId: "edit-again" };
  assert.deepEqual(summarizeTimelineProcess([
    { ...base, id: "allowed-first", actionId: command.actionId, kind: "approval", status: "succeeded", decision: "allowed" },
    { ...base, kind: "explorationBatch", id: "reads", batch: { children: [read, grep] } },
    { ...base, kind: "commandBatch", id: "commands", batch: { commands: [command] } },
    { ...base, id: "allowed", actionId: command.actionId, kind: "approval", status: "succeeded", decision: "allowed" },
    read, command, edit, editAgain, action("unfinished", { status: "running" }), action("failed", { status: "failed" }),
  ]), { reads: 1, explorations: 1, changedFiles: 1, commands: 1, tools: 0, toolLoads: 0, webSearches: 0 });
});

test("activity categories reflect accepted tool identities, never tool descriptions or command text", () => {
  const tool = (id, toolName, more = {}) => action(id, { kind: "mcpToolCall", toolName, ...more });
  const facts = summarizeTimelineProcess([
    tool("load", "load_tools"), tool("web", "web_search"), tool("generic", "catalog.lookup", { resultSummary: "Loaded tools and searched the web" }),
    tool("similar", "custom.web_search"), tool("failed-load", "load_tools", { status: "failed" }),
    tool("pending-web", "web_search", { status: "running" }),
    action("shell", { kind: "commandExecution", command: "echo load_tools web_search" }),
  ]);
  assert.deepEqual(facts, { reads: 0, explorations: 0, changedFiles: 0, commands: 1, tools: 2, toolLoads: 1, webSearches: 1 });
  assert.equal(timelineActivityCategory(facts), "tool");
  const empty = { reads: 0, explorations: 0, changedFiles: 0, commands: 0, tools: 0, toolLoads: 0, webSearches: 0 };
  for (const [more, expected] of [
    [{ commands: 2 }, "command"], [{ reads: 1, commands: 2 }, "search"],
    [{ changedFiles: 1, reads: 1, commands: 2 }, "edit"], [{ webSearches: 1 }, "web"],
    [{ toolLoads: 1, changedFiles: 1, reads: 1, commands: 2, webSearches: 1 }, "tool"],
  ]) assert.equal(timelineActivityCategory({ ...empty, ...more }), expected);
});

test("live thinking placeholder stays a single independent row without a process header", () => {
  const item = message("waiting", "commentary", { status: "running", waitingPlaceholder: true });
  assert.deepEqual(projectTimelineProcessSections([item]), [{ kind: "item", item }]);
});

test("compaction stays an independent system row in every lifecycle state", () => {
  for (const status of ["running", "succeeded", "failed", "cancelled", "blocked"]) {
    const compaction = { ...base, id: "compaction", kind: "contextCompaction", status, title: "Context compaction", summary: "" };
    const sections = projectTimelineProcessSections([compaction]);
    assert.deepEqual(sections, [{ kind: "item", item: compaction }]);
    const model = projectConversationTimelineDisplayModel([compaction], new Map());
    assert.equal(model.locationByItemId.get(compaction.id).visible, true);
  }
});

test("a succeeded process collapses; final stays outside and hidden atoms retain their lookup", () => {
  const items = [message("before"), action("read"), message("final", "final")];
  const before = JSON.stringify(items);
  const sections = projectTimelineProcessSections(items);
  assert.equal(sections[0].group.status, "completed");
  const model = projectConversationTimelineDisplayModel(items, new Map());
  assert.deepEqual(model.rows.map(row => row.kind), ["processHeader", "item"]);
  assert.equal(model.rows.at(-1).item.id, "final");
  assert.deepEqual(model.locationByItemId.get("read").disclosurePath, [sections[0].group.id]);
  assert.equal(model.locationByItemId.get("read").visible, false);
  assert.equal(JSON.stringify(items), before);
  const open = projectConversationTimelineDisplayModel(items, new Map([[sections[0].group.id, { expanded: true, touched: true, revisionKey: "completed" }]]));
  assert.deepEqual(open.rows.map(row => row.item.id), ["before", "before", "read", "final"]);
  assert.equal(open.locationByItemId.get("read").rowKey, model.locationByItemId.get("read").rowKey);
});

test("running and unknown history shows narration, reasoning and current actions without a process fold", () => {
  for (const status of ["running", undefined]) {
    const items = [message("before", "commentary", { status }), action("read", { status }), message("final", "final", { status })];
    assert.ok(projectTimelineProcessSections(items).every(section => section.kind === "item"));
    assert.equal(projectConversationTimelineDisplayModel(items, new Map()).locationByItemId.get("read").visible, true);
  }
});

test("unknown phase and missing lineage remain visible and break grouping", () => {
  const items = [action("read"), message("unknown", undefined, { phase: undefined }), action("orphan", { attemptId: undefined }), message("final", "final")];
  const model = projectConversationTimelineDisplayModel(items, new Map());
  assert.equal(model.locationByItemId.get("unknown").visible, true);
  assert.equal(model.locationByItemId.get("orphan").visible, true);
});

test("turn, run, attempt, participant and workflow step each form an isolation boundary", () => {
  for (const field of ["turnId", "runId", "attemptId", "participantId", "workflowStepId"]) {
    const groups = projectTimelineProcessSections([action("first"), action("second", { [field]: "other" })]);
    assert.equal(groups.length, 2, field);
    assert.ok(groups.every(section => section.kind === "item"), field);
  }
});

test("exceptions and pending human input override a touched closed preference", () => {
  for (const problem of [action("problem", { status: "failed" }), action("problem", { kind: "approval", approvalId: "approval" }),
    action("problem", { kind: "userInputRequest", userInput: { availability: "available", status: "pending" } })]) {
    const items = [problem, message("final", "final")];
    const group = projectTimelineProcessSections(items)[0].group;
    const model = projectConversationTimelineDisplayModel(items, new Map([[group.id, { expanded: false, touched: true, revisionKey: "completed" }]]));
    assert.equal(model.locationByItemId.get("problem").visible, true);
    assert.equal(group.status, "attention");
  }
});

test("child process lookup reveals Agent then process without another timeline", () => {
  const children = [action("child-read"), message("child-final", "final")];
  const child = { ...base, id: "child", kind: "subAgentActivity", label: "Engineer", lifecycle: "completed", childItems: children };
  const model = projectConversationTimelineDisplayModel([child], new Map());
  assert.equal(model.rows.length, 1);
  assert.equal(model.locationByItemId.get("child-read").disclosurePath.length, 2);
  const disclosures = new Map(model.locationByItemId.get("child-read").disclosurePath.map(id => [id, { expanded: true, touched: true, revisionKey: "completed" }]));
  const open = projectConversationTimelineDisplayModel([child], disclosures);
  assert.equal(open.locationByItemId.get("child-read").visible, true);
  assert.ok(open.rows.slice(1).every(row => row.depth === 1));
});

test("Host lifecycle settles tool-only history and supplies duration, without guessed timestamps", () => {
  const items = [action("read")];
  const lifecycle = { id: "run", status: "succeeded", startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T00:00:03Z" };
  const section = projectTimelineProcessSections(items, "root", new Map([["run", lifecycle]]))[0];
  assert.equal(section.group.status, "completed");
  assert.equal(section.group.durationMs, 3000);
  for (const changes of [{ startedAt: undefined }, { startedAt: "bad" }, { endedAt: "2026-09-01T00:00:00Z" }])
    assert.equal(projectTimelineProcessSections(items, "root", new Map([["run", { ...lifecycle, ...changes }]]))[0].group.durationMs, undefined);
  assert.equal(projectTimelineProcessSections([action("read", { status: "running" })], "root", new Map([["run", lifecycle]]))[0].kind, "item");
});

test("completion adds one closed process fold around formerly visible narration", () => {
  const running = [message("before"), action("read", { status: "running" })];
  const done = [message("before"), action("read"), message("final", "final")];
  assert.equal(projectConversationTimelineDisplayModel(running, new Map()).locationByItemId.get("before").visible, true);
  const id = projectTimelineProcessSections(done)[0].group.id;
  assert.equal(projectConversationTimelineDisplayModel(done, new Map()).locationByItemId.get("read").visible, false);
  const touched = new Map([[id, { expanded: true, touched: true, revisionKey: "completed" }]]);
  assert.equal(projectConversationTimelineDisplayModel(done, touched).locationByItemId.get("read").visible, true);
});

test("attention inside a completed child cannot be hidden by a touched Agent disclosure", () => {
  const child = { ...base, id: "child", kind: "subAgentActivity", label: "Engineer", lifecycle: "completed",
    childItems: [action("failed", { status: "failed" }), message("final", "final")] };
  const model = projectConversationTimelineDisplayModel([child], new Map([["timeline-sub-agent:child", { expanded: false, touched: true, revisionKey: "1" }]]));
  assert.equal(model.locationByItemId.get("failed").visible, true);
});

test("long histories and fragmented scopes do not rescan every atom for each process", () => {
  for (const fragmented of [false, true]) {
    let inspectedKinds = 0;
    const items = Array.from({ length: 200 }, (_, index) => {
      const ownership = fragmented ? {} : { turnId: `turn-${index}`, runId: `run-${index}` };
      return [action(`read-${index}`, ownership), message(`final-${index}`, "final", ownership)];
    }).flat().map(item => {
      const kind = item.kind;
      return { ...item, get kind() { inspectedKinds += 1; return kind; } };
    });
    const sections = projectTimelineProcessSections(items);
    assert.equal(sections.filter(section => section.kind === "process").length, 200);
    assert.ok(sections.filter(section => section.kind === "process").every(section => section.group.status === "completed"));
    assert.ok(inspectedKinds < items.length * 40, `unexpected repeated scanning: ${inspectedKinds} inspections for ${items.length} atoms`);
  }
});

const operation = (id, sequence, more = {}) => action(id, {
  threadSequence: sequence, partIndex: 1, sourceRefs: [{ kind: "conversation_item", id }], ...more,
});
const segmentsFor = items => new Map(items.map(item => [item.id, "context-1"]));
const command = (id, sequence, more = {}) => operation(id, sequence, {
  kind: "commandExecution", command: "node --test", risk: "low", exitCode: 0, ...more,
});

test("consecutive settled mixed operations fold while narration and the live action stay visible", () => {
  const items = [message("before"), operation("read", 2), operation("edit", 3, {
    kind: "fileChange", files: [{ fileRef: { kind: "file", id: "a", path: "/a.ts" } }],
  }), command("test", 4), message("update"), command("live", 6, { status: "running" })];
  const context = segmentsFor(items);
  const sections = projectTimelineProcessSections(items, "root", undefined, context);
  assert.deepEqual(sections.map(section => section.kind === "item" ? section.item.id : section.group.presentation), ["before", "activity", "update", "live"]);
  assert.deepEqual(sections[1].group.items.map(item => item.id), ["read", "edit", "test"]);
  const closed = projectConversationTimelineDisplayModel(items, new Map(), undefined, context);
  assert.equal(closed.locationByItemId.get("read").visible, false);
  for (const id of ["before", "update", "live"]) assert.equal(closed.locationByItemId.get(id).visible, true);
  const id = sections[1].group.id;
  const open = projectConversationTimelineDisplayModel(items, new Map([[id, { expanded: true, touched: true, revisionKey: "old" }]]), undefined, context);
  assert.equal(open.locationByItemId.get("edit").visible, true);
});

test("reasoning breaks consecutive operations and is never itself an activity fold", () => {
  const items = [command("one", 1), { ...base, id: "thought", kind: "reasoning", summary: "Safe summary" }, command("two", 3)];
  assert.ok(projectTimelineActivitySections(items, "root", segmentsFor(items)).every(section => section.kind === "item"));
});

test("activity folds require context, canonical adjacency, ownership and successful safe facts", () => {
  const first = command("one", 1), second = command("two", 2);
  assert.equal(projectTimelineActivitySections([first, second]).length, 2);
  for (const changes of [
    { threadSequence: 4 }, { turnId: "other" }, { runId: "other" }, { attemptId: "other" },
    { participantId: "other" }, { workflowStepId: "other" }, { workUnitId: "other" }, { turnRunRole: "retry" },
    { status: "running" }, { status: "failed" }, { approvalId: "approval" }, { risk: "high" }, { exitCode: 1 },
    { attemptId: undefined },
  ]) {
    const items = [first, { ...second, ...changes }];
    assert.ok(projectTimelineActivitySections(items, "root", segmentsFor(items)).every(section => section.kind === "item"), JSON.stringify(changes));
  }
  assert.equal(projectTimelineActivitySections([first, second], "root", new Map([["one", "a"], ["two", "b"]])).length, 2);
});

test("completion preserves inner expansion and the final response outside the process fold", () => {
  const first = command("one", 1), second = command("two", 2), live = command("three", 3, { status: "running" });
  const context = segmentsFor([first, second, live]);
  const activityId = projectTimelineActivitySections([first, second], "root", context)[0].group.id;
  const done = [first, second, { ...live, status: "succeeded" }, message("final", "final")];
  const processId = projectTimelineProcessSections(done)[0].group.id;
  const preferences = new Map([[activityId, { expanded: true, touched: true, revisionKey: "old" }]]);
  const closed = projectConversationTimelineDisplayModel(done, preferences, undefined, context);
  assert.equal(closed.locationByItemId.get("final").visible, true);
  assert.deepEqual(closed.locationByItemId.get("three").disclosurePath, [processId, activityId]);
  preferences.set(processId, { expanded: true, touched: true, revisionKey: "completed" });
  const open = projectConversationTimelineDisplayModel(done, preferences, undefined, context);
  assert.equal(open.locationByItemId.get("three").visible, true);
  assert.equal(open.rows.filter(row => row.kind !== "processHeader" && row.item.id === "one").length, 1);
});

test("mixed grouping expands pre-existing batches into atoms without another nested batch header", () => {
  const commands = [command("one", 1), command("two", 2), command("three", 3)];
  const batch = { ...commands[0], kind: "commandBatch", id: "batch", batch: { id: "batch", commands } };
  const read = operation("read", 4);
  const items = [batch, read];
  const context = segmentsFor([...commands, read]);
  const section = projectTimelineActivitySections(items, "root", context)[0];
  assert.equal(section.group.presentation, "activity");
  assert.deepEqual(section.group.items.map(item => item.id), ["one", "two", "three", "read"]);
  const model = projectConversationTimelineDisplayModel(items, new Map(), undefined, context);
  assert.equal(model.locationByItemId.get("batch").visible, true);
  assert.equal(model.locationByItemId.get("three").disclosurePath.length, 1);
});

test("operation disclosure identity and retention survive the core batching threshold", async () => {
  const { collectConversationTimelineViewRetainKeys } = await vite.ssrLoadModule('/src/shared/conversation/timeline/conversation-timeline-view-retain-keys.ts');
  const commands = [command("one", 1), command("two", 2), command("three", 3)];
  const context = segmentsFor(commands);
  const id = projectTimelineActivitySections(commands.slice(0, 2), "root", context)[0].group.id;
  const batch = { ...commands[0], kind: "commandBatch", id: "batch", actionIds: commands.map(item => item.actionId), childActionIds: [],
    batch: { id: "batch", revisionKey: "2", defaultExpanded: false, commands } };
  assert.equal(projectTimelineActivitySections([batch], "root", context)[0].kind, "item");
  assert.equal(collectConversationTimelineViewRetainKeys([batch]).blockIds.has(id), true);
  const model = projectConversationTimelineDisplayModel([batch], new Map([[id, { expanded: true, touched: true, revisionKey: "old" }]]), undefined, context);
  assert.equal(model.locationByItemId.get("three").visible, true);
  assert.equal(model.rows[0].item.kind, "commandBatch");
  assert.deepEqual(model.locationByItemId.get("three").disclosurePath, [id]);
  assert.equal(model.rows.filter(row => row.item.kind === "commandExecution").length, 3);
});

test("Agent process and operation folds share a complete reveal path with correct child row positions", () => {
  const children = [command("one", 1), command("two", 2), message("child-final", "final")];
  const context = segmentsFor(children);
  const agent = { ...base, id: "child", kind: "subAgentActivity", label: "Engineer", lifecycle: "completed", childItems: children };
  const closed = projectConversationTimelineDisplayModel([agent], new Map(), undefined, context);
  const path = closed.locationByItemId.get("two").disclosurePath;
  assert.equal(path.length, 3);
  const preferences = new Map(path.map(id => [id, { expanded: true, touched: true, revisionKey: "old" }]));
  const open = projectConversationTimelineDisplayModel([agent], preferences, undefined, context);
  assert.equal(open.locationByItemId.get("two").visible, true);
  const childRows = open.rows.filter(row => row.kind === "subAgentChild");
  assert.deepEqual(childRows.map(row => row.childIndex), [0, 1, 2]);
  assert.ok(childRows.every(row => row.childCount === 3));
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", server: { middlewareMode: true } });
const { projectTimelineProcessSections } = await vite.ssrLoadModule("/src/shared/conversation/timeline/timeline-process-presentation.ts");
const { projectConversationTimelineDisplayModel } = await vite.ssrLoadModule("/src/shared/conversation/timeline/conversation-timeline-display-model.ts");
after(() => vite.close());
const base = { revision: 1, turnId: "turn", runId: "run", attemptId: "attempt", participantId: "ling_agent", workflowStepId: null, sourceRefs: [], threadSequence: 1, partIndex: 0, status: "succeeded" };
const message = (id, phase = "commentary", more = {}) => ({ ...base, id, kind: "agentMessage", phase, markdown: id, ...more });
const action = (id, more = {}) => ({ ...base, id, kind: "exploration", actionId: id, operation: "read", title: "Read", targets: [], ...more });

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

test("running and unknown groups start open; only Host status can settle", () => {
  for (const status of ["running", undefined]) {
    const items = [message("before", "commentary", { status }), action("read", { status }), message("final", "final", { status })];
    assert.equal(projectTimelineProcessSections(items)[0].group.defaultExpanded, true);
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
    assert.notEqual(groups[0].group.id, groups[1].group.id);
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
  assert.equal(projectTimelineProcessSections([action("read", { status: "running" })], "root", new Map([["run", lifecycle]]))[0].group.status, "running");
});

test("touched expansion survives streaming/reconnect; default follows Host settlement", () => {
  const running = [message("before", "commentary", { status: "running" }), action("read", { status: "running" })];
  const done = [message("before"), action("read"), message("final", "final")];
  const id = projectTimelineProcessSections(running)[0].group.id;
  assert.equal(projectTimelineProcessSections(done)[0].group.id, id);
  const untouched = new Map([[id, { expanded: true, touched: false, revisionKey: "running" }]]);
  const touched = new Map([[id, { expanded: true, touched: true, revisionKey: "running" }]]);
  assert.equal(projectConversationTimelineDisplayModel(done, untouched).locationByItemId.get("read").visible, false);
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

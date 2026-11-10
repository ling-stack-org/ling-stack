import assert from "node:assert/strict";
import test from "node:test";
import { placeTimelineResponseReports, projectTimelineResponseFooterRows, projectTimelineResponsePresentation } from "../src/shared/conversation/timeline/timeline-response-presentation.ts";

function message(id, overrides = {}) {
  return { id, kind: "agentMessage", itemId: "message_1", turnId: "turn_1", runId: "run_1",
    participantId: "engineer", revision: 1, threadSequence: 1, partIndex: 0,
    markdown: id, phase: "final", status: "succeeded", sourceRefs: [], ...overrides };
}
function report(id = "report", overrides = {}) {
  return { id, kind: "terminalReport", reportId: id, turnId: "turn_1", runId: "run_1",
    revision: 1, generation: 1, threadSequence: 3, partIndex: 0, status: "succeeded",
    outcomeStatus: "succeeded", title: "Completed", summary: "Completed", outcomeSourceRefs: [],
    changes: [], verification: [], participants: [], artifacts: [], risks: [], corrections: [],
    references: [], sourceRefs: [], ...overrides };
}

test("narration and report share one final owner, identity belongs to the first segment", () => {
  const items = [message("start", { phase: "commentary" }), { id: "tool", kind: "commandExecution", turnId: "turn_1" },
    message("final"), report()];
  const result = projectTimelineResponsePresentation(items);
  assert.deepEqual([...result.identityOwnerIds], ["start"]);
  assert.deepEqual([...result.footerByItemId.keys()], ["report"]);
  assert.equal(result.footerByItemId.get("report").copyText, "start\n\nfinal");
  assert.equal(result.footerByItemId.get("report").logicalMessageCount, 1);
  assert.equal(result.responseByItemId.get("final"), result.responseByItemId.get("report"));
});

test("running or commentary-only replies have no final actions", () => {
  for (const overrides of [{ phase: "commentary" }, { status: "running" }, { status: "waiting" }]) {
    assert.equal(projectTimelineResponsePresentation([message("live", overrides)]).footerByItemId.size, 0);
  }
});

test("root and child response actions never copy each other's narration", () => {
  const child = message("child", { participantId: "qa" });
  const items = [message("root"), { id: "agent", kind: "subAgentActivity", participantId: "qa", childItems: [child, report("child-report")] }, report()];
  const result = projectTimelineResponsePresentation(items);
  assert.deepEqual([...result.footerByItemId.keys()], ["report", "child-report"]);
  assert.equal(result.footerByItemId.get("report").copyText, "root");
  assert.equal(result.footerByItemId.get("child-report").copyText, "child");
});

test("different Turns retain separate footers and different speakers retain identity", () => {
  const items = [message("a"), message("b", { itemId: "message_2", participantId: "ling" }), report(),
    message("next", { turnId: "turn_2", itemId: "message_3" })];
  const result = projectTimelineResponsePresentation(items);
  assert.deepEqual([...result.identityOwnerIds], ["a", "b", "next"]);
  assert.deepEqual([...result.footerByItemId.keys()], ["report", "next"]);
});

test("a settled report provides fallback actions without requiring model narration", () => {
  const result = projectTimelineResponsePresentation([report("fallback", { status: "partially_succeeded" })]);
  assert.equal(result.footerByItemId.get("fallback").message, undefined);
  assert.equal(result.footerByItemId.get("fallback").report.id, "fallback");
});

test("scope-less optimistic messages cannot collapse into one unrelated response", () => {
  const result = projectTimelineResponsePresentation([
    message("one", { turnId: undefined, runId: undefined, itemId: undefined }),
    message("two", { turnId: undefined, runId: undefined, itemId: undefined }),
  ]);
  assert.deepEqual([...result.footerByItemId.keys()], ["one", "two"]);
});

test("a live child prevents a final parent footer even if a settled message or stale report is present", () => {
  for (const lifecycle of ["started", "running", "waiting"]) {
    const child = { id: "child", kind: "subAgentActivity", turnId: "turn_1", lifecycle, childItems: [] };
    for (const items of [[message("root"), child], [message("root"), child, report()]]) {
      assert.equal(projectTimelineResponsePresentation(items).footerByItemId.size, 0);
    }
  }
});

test("an unknown author never inherits a known teammate identity", () => {
  const items = [message("coordinator", { participantId: undefined }), message("teammate", { participantId: "qa", itemId: "message_2" }),
    message("coordinator-tail", { participantId: undefined })];
  assert.deepEqual([...projectTimelineResponsePresentation(items).identityOwnerIds], ["coordinator", "teammate"]);
});

test("the effective report with highest generation owns actions", () => {
  const items = [message("final"), report("old"), report("new", { generation: 2 }), report("late-old", { revision: 10 })];
  assert.deepEqual([...projectTimelineResponsePresentation(items).footerByItemId.keys()], ["new"]);
});

test("footer placement follows trailing atomic facts without changing narration/report ownership", () => {
  const items = [message("final"), report(), { id: "last-tool", kind: "commandExecution", turnId: "turn_1", status: "succeeded" }];
  const presentation = projectTimelineResponsePresentation(items);
  const footers = projectTimelineResponseFooterRows(presentation, items.map((item) => ({ item })));
  assert.deepEqual([...presentation.footerByItemId.keys()], ["report"]);
  assert.deepEqual([...footers.keys()], ["last-tool"]);
  assert.equal(footers.get("last-tool").copyText, "final");
  assert.equal(footers.get("last-tool").report.id, "report");
});

test("batch disclosure moves one footer to its last displayed fact; hidden children have none", () => {
  const commands = [{ id: "cmd-a", kind: "commandExecution" }, { id: "cmd-b", kind: "commandExecution" }];
  const batch = { id: "batch", kind: "commandBatch", turnId: "turn_1", batch: { commands }, status: "succeeded" };
  const childItems = [message("child"), batch];
  const child = { id: "agent", kind: "subAgentActivity", turnId: "turn_1", lifecycle: "completed", childItems };
  const rootItems = [message("root"), child, report()];
  const presentation = projectTimelineResponsePresentation(rootItems);
  const rootRows = rootItems.map((item) => ({ item }));
  assert.deepEqual([...projectTimelineResponseFooterRows(presentation, rootRows).keys()], ["report"]);
  const collapsed = projectTimelineResponseFooterRows(presentation, [...rootRows, ...childItems.map((item) => ({ item }))]);
  assert.deepEqual([...collapsed.keys()], ["report", "batch"]);
  const expanded = projectTimelineResponseFooterRows(presentation, [...rootRows, ...childItems.map((item) => ({ item })), ...commands.map((item) => ({ item }))]);
  assert.deepEqual([...expanded.keys()], ["report", "cmd-b"]);
  assert.equal(expanded.get("cmd-b").copyText, "child");
  assert.equal(expanded.get("report").copyText, "root");
});

test("placement never promotes live responses or a superseded terminal report", () => {
  const liveItems = [message("text"), { id: "running", kind: "commandExecution", turnId: "turn_1", status: "running" }];
  assert.equal(projectTimelineResponseFooterRows(projectTimelineResponsePresentation(liveItems), liveItems.map((item) => ({ item }))).size, 0);
  const items = [message("final"), report("new", { generation: 2 }), report("late-old")];
  assert.deepEqual([...projectTimelineResponseFooterRows(projectTimelineResponsePresentation(items), items.map((item) => ({ item }))).keys()], ["new"]);
});

test("a late report generation stays at its owning response rather than below a newer Turn", () => {
  const first = message("first", { threadSequence: 2 });
  const nextUser = { id: "user-next", kind: "userMessage", turnId: "turn_2", threadSequence: 4 };
  const next = message("next", { turnId: "turn_2", runId: "run_2", threadSequence: 5 });
  const nextReport = report("next-report", { turnId: "turn_2", runId: "run_2", threadSequence: 6 });
  const lateReport = report("first-generation-2", { generation: 2, threadSequence: 7 });
  const input = [first, nextUser, next, nextReport, lateReport];
  const placed = placeTimelineResponseReports(input);
  assert.deepEqual(placed.map((item) => item.id), [first.id, lateReport.id, nextUser.id, next.id, nextReport.id]);
  assert.equal(placed[1], lateReport);
  assert.equal(lateReport.threadSequence, 7, "placement cannot rewrite canonical sequence");
  assert.deepEqual(input.map((item) => item.id), [first.id, nextUser.id, next.id, nextReport.id, lateReport.id]);
  assert.deepEqual(placeTimelineResponseReports(placed), placed, "reconnect reconstruction is idempotent");
});

test("report placement is child-scoped and orphan reports do not attach to a visible different Turn", () => {
  const orphan = report("orphan", { turnId: "off-page", runId: "off-page-run" });
  const childFirst = message("child-first");
  const childNext = message("child-next", { turnId: "child-turn-2", runId: "child-run-2" });
  const childReport = report("child-late", { generation: 2 });
  const child = { id: "child", kind: "subAgentActivity", turnId: "turn_1", lifecycle: "completed", participantId: "qa", childItems: [childFirst, childNext, childReport] };
  const placed = placeTimelineResponseReports([message("root"), child, report("root-report"), orphan]);
  assert.deepEqual(placed.map((item) => item.id), ["root", "child", "root-report", "orphan"]);
  assert.deepEqual(placed[1].childItems.map((item) => item.id), ["child-first", "child-late", "child-next"]);
  assert.deepEqual(child.childItems.map((item) => item.id), ["child-first", "child-next", "child-late"]);
});

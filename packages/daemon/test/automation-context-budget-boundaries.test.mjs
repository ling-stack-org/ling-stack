import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAutomationContext } from "../dist/features/automations/context.js";

// Pure projection edge controls only: the explicit Store double supplies source
// facts. No HTTP server, SQLite, runner, model request or durable admission.
const now = "2026-10-15T12:00:00.000Z";
const channelId = "channel-a23-projection";
const indices = [1, 2, 3];
const brief = {
  id: "brief-a23-projection",
  objective: "BRIEF_BEGIN\n\n```txt\nwhole brief body\n```\n\nBRIEF_END",
  scope: "Projection fixture scope",
  acceptanceCriteria: ["BRIEF_ACCEPT"], openQuestions: ["BRIEF_QUESTION"], risks: ["BRIEF_RISK"],
};
const runs = indices.map(index => ({
  id: `run-projection-${index}`, channelId, status: "failed", createdAt: now,
  taskId: `RUN_TASK_${index}_BEGIN`,
  errorMessage: `RUN_ERROR_${index}_BEGIN\nwhole error body\nRUN_ERROR_${index}_END`,
}));
const approvals = indices.map(index => ({
  id: `approval-projection-${index}`, title: `APPROVAL_TITLE_${index}_BEGIN`,
  risk: "medium", actionType: "bash", createdAt: now,
}));
const artifacts = indices.map(index => ({
  id: `artifact-projection-${index}`, type: "markdown", path: `output/projection-${index}.md`,
  title: `ARTIFACT_${index}_BEGIN\n\n\`\`\`txt\nwhole artifact body\n\`\`\`\n\nARTIFACT_${index}_END`,
}));
const transitions = indices.map(index => ({
  id: `transition-projection-${index}`, entityType: "run", entityId: `entity-${index}`,
  fromStatus: index === 1 ? undefined : "running", toStatus: "failed", event: "run_failed", actor: "host",
}));
const externalWork = indices.map(index => ({
  id: `external-projection-${index}`, identifier: `projection/owned#${index}`,
  sourceKind: "github", workItemKind: "github_issue", updatedAt: now,
}));

// Independent expected refs and complete rendered entries, not captured output.
const cases = [
  { selector: { kind: "channel_brief" }, entries: [{
    ref: { kind: "channel_brief", id: brief.id, label: brief.objective }, marker: "BRIEF_BEGIN",
    body: `Objective: ${brief.objective}\nScope: ${brief.scope}\nAcceptance criteria:\n- BRIEF_ACCEPT\nOpen questions:\n- BRIEF_QUESTION\nRisks:\n- BRIEF_RISK`,
  }] },
  { selector: { kind: "recent_runs", limit: 3 }, entries: runs.map(run => ({
    ref: { kind: "run", id: run.id, label: run.taskId }, marker: run.taskId,
    body: `- ${run.id}: ${run.status}; task=${run.taskId}; created=${run.createdAt}; error=${run.errorMessage}`,
  })) },
  { selector: { kind: "pending_approvals", limit: 3 }, entries: approvals.map(approval => ({
    ref: { kind: "approval", id: approval.id, label: approval.title }, marker: approval.title,
    body: `- ${approval.id}: ${approval.title}; risk=${approval.risk}; action=${approval.actionType}; created=${approval.createdAt}`,
  })) },
  { selector: { kind: "recent_artifacts", limit: 3 }, entries: artifacts.map((artifact, index) => ({
    ref: { kind: "artifact", id: artifact.id, label: artifact.title }, marker: `ARTIFACT_${index + 1}_BEGIN`,
    body: `- ${artifact.id}: ${artifact.title}; type=${artifact.type}; run=${runs[index].id}`,
  })) },
  { selector: { kind: "state_transitions", limit: 3 }, entries: transitions.map(transition => ({
    ref: { kind: "state_transition", id: transition.id, label: `${transition.entityType}:${transition.entityId}` },
    marker: transition.id,
    body: `- ${transition.id}: ${transition.entityType}:${transition.entityId} ${transition.fromStatus ?? "none"} -> ${transition.toStatus}; event=${transition.event}; actor=${transition.actor}`,
  })) },
  { selector: { kind: "external_work", limit: 3 }, entries: externalWork.map(record => ({
    ref: { kind: "external_work", id: record.id, label: record.identifier }, marker: record.id,
    body: `- ${record.id}: ${record.identifier}; source=${record.sourceKind}; item=${record.workItemKind}; updated=${record.updatedAt}`,
  })) },
];
const allEntries = cases.flatMap(item => item.entries);

/** Only the read methods used by this projection exist; query order is recorded. */
function createProjectionStore({ missingBrief = false, emptyMethods = [] } = {}) {
  const calls = [];
  const record = (method, args, result) => {
    calls.push({ method, args });
    return emptyMethods.includes(method) ? [] : result;
  };
  const store = {
    getChannelBrief(id) {
      assert.equal(id, channelId);
      calls.push({ method: "getChannelBrief", args: id });
      return missingBrief ? undefined : brief;
    },
    listRuns(query) { return record("listRuns", query, runs.slice(0, query.limit)); },
    listApprovalRequests(query) {
      assert.equal(query.status, "pending");
      return record("listApprovalRequests", query, approvals.slice(0, query.limit));
    },
    listArtifacts(runId) {
      const index = runs.findIndex(run => run.id === runId);
      assert.notEqual(index, -1);
      return record("listArtifacts", runId, [artifacts[index]]);
    },
    listStateTransitionEvents(query) { return record("listStateTransitionEvents", query, transitions.slice(0, query.limit)); },
    listExternalWorkRecords(query) {
      assert.equal(query.channelId, channelId);
      return record("listExternalWorkRecords", query, externalWork.slice(0, query.limit));
    },
  };
  return { store, calls };
}

function project(selectors, maxContextItems, fixture = createProjectionStore(), mode = "preview") {
  return buildAutomationContext({ store: fixture.store, now, mode, automation: {
    id: "automation-a23-projection", title: "A23 pure projection", channelId,
    target: { scope: "channel", workspaceId: "workspace-a23-projection", channelId },
    promptTemplate: { templateVersion: 1, promptMarkdown: "Use only supplied facts.", contextSelectors: selectors,
      ...(maxContextItems === undefined ? {} : { maxContextItems }) },
  } });
}

/** Exact body and unique-anchor counts detect partial, duplicated or orphaned text. */
function assertProjection(result, expected) {
  assert.deepEqual(result.selectedRefs, expected.map(entry => entry.ref));
  assert.ok(result.renderedPrompt.includes(result.contextMarkdown));
  for (const entry of allEntries) {
    const count = expected.filter(selected => selected === entry).length;
    for (const field of ["contextMarkdown", "renderedPrompt"]) {
      assert.equal(result[field].split(entry.marker).length - 1, count, `${field}: ${entry.marker} occurrence count`);
      assert.equal(result[field].split(entry.body).length - 1, count, `${field}: complete ${entry.ref.kind} body count`);
    }
  }
}

function assertOmissionCount(result, count) {
  assert.ok(result.warnings.some(warning => /omit|truncat/i.test(warning) &&
    new RegExp(`\\b${count}\\b`).test(warning)), `disclose ${count} omitted whole-item occurrence(s)`);
}

for (const scenario of cases) {
  test(`A23 pure ${scenario.selector.kind} preserves exact whole entries with sufficient budget`, () => {
    const result = project([scenario.selector], Number.MAX_SAFE_INTEGER);
    assertProjection(result, scenario.entries);
    assert.deepEqual(result.warnings, []);
  });

  test(`A23 pure ${scenario.selector.kind} small budget selects one whole occurrence, not body fragments`, () => {
    // A brief is one item; append a different selector to prove its budget use.
    const suffix = scenario.selector.kind === "channel_brief" ? [cases[1].selector] : [];
    const result = project([scenario.selector, ...suffix], 1);
    assertProjection(result, scenario.entries.slice(0, 1));
    assertOmissionCount(result, scenario.entries.length + (suffix.length ? cases[1].entries.length : 0) - 1);
  });
}

test("A23 pure repeated selectors retain occurrence order and count each appearance", () => {
  const first = { ...cases[1].selector, limit: 2 };
  const selectors = [first, cases[2].selector, first];
  const ordered = [...cases[1].entries.slice(0, 2), ...cases[2].entries, ...cases[1].entries.slice(0, 2)];
  const preview = project(selectors, 6), run = project(selectors, 6, createProjectionStore(), "run");
  assertProjection(preview, ordered.slice(0, 6));
  assertProjection(run, ordered.slice(0, 6));
  assert.deepEqual(preview.selectedRefs, run.selectedRefs);
  assert.deepEqual(preview.warnings, run.warnings);
  assertOmissionCount(preview, 1);
});

test("A23 pure omitted budget preserves selector limits and does not silently impose max32", () => {
  const selectors = Array.from({ length: 18 }, () => ({ ...cases[1].selector, limit: 2 }));
  const expected = selectors.flatMap(() => cases[1].entries.slice(0, 2));
  const fixture = createProjectionStore();
  const result = project(selectors, undefined, fixture);
  assert.equal(expected.length, 36);
  assertProjection(result, expected);
  assert.deepEqual(result.warnings, []);
  assert.equal(fixture.calls.length, 18);
  assert.ok(fixture.calls.every(call => call.method === "listRuns" && call.args.limit === 8));
});

test("A23 pure missing brief and empty query results do not consume later-item budget", () => {
  const fixture = createProjectionStore({ missingBrief: true, emptyMethods: ["listApprovalRequests"] });
  const result = project([cases[0].selector, cases[2].selector, { ...cases[5].selector, limit: 1 }], 1, fixture);
  assertProjection(result, cases[5].entries.slice(0, 1));
  assert.deepEqual(fixture.calls.map(call => call.method), ["getChannelBrief", "listApprovalRequests", "listExternalWorkRecords"]);
  assert.ok(result.warnings.some(warning => /brief/i.test(warning)));
  assert.ok(!result.warnings.some(warning => /omit|budget|maxContextItems|truncat/i.test(warning)));
});

for (const [caseIndex, emptyMethod] of [
  [1, "listRuns"], [2, "listApprovalRequests"], [3, "listArtifacts"],
  [4, "listStateTransitionEvents"], [5, "listExternalWorkRecords"],
]) {
  test(`A23 pure empty ${cases[caseIndex].selector.kind} leaves the full later-item budget`, () => {
    const next = cases[caseIndex === 2 ? 5 : 2];
    const fixture = createProjectionStore({ emptyMethods: [emptyMethod] });
    const result = project([cases[caseIndex].selector, { ...next.selector, limit: 1 }], 1, fixture);
    assertProjection(result, next.entries.slice(0, 1));
    assert.deepEqual(result.warnings, []);
    assert.ok(fixture.calls.some(call => call.method === emptyMethod));
  });
}

for (const kind of ["doctor_summary", "mcp_status"]) {
  test(`A23 pure unsupported ${kind} warns without consuming later-item budget`, () => {
    const fixture = createProjectionStore();
    const result = project([{ kind }, { ...cases[2].selector, limit: 1 }], 1, fixture);
    assertProjection(result, cases[2].entries.slice(0, 1));
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(kind));
    assert.deepEqual(fixture.calls.map(call => call.method), ["listApprovalRequests"]);
  });
}

test("A23 pure exhausted budget retains unavailable warnings without empty sections", () => {
  const fixture = createProjectionStore({ missingBrief: true });
  const result = project([
    { ...cases[2].selector, limit: 1 },
    cases[0].selector,
    { kind: "doctor_summary" },
    { kind: "mcp_status" },
    { ...cases[1].selector, limit: 1 },
  ], 1, fixture);
  assertProjection(result, cases[2].entries.slice(0, 1));
  assertOmissionCount(result, 1);
  for (const label of ["brief", "doctor_summary", "mcp_status"]) {
    assert.ok(result.warnings.some(warning => warning.toLowerCase().includes(label)));
  }
  assert.doesNotMatch(result.contextMarkdown, /## Channel Brief|## Recent Runs/);
});

for (const [label, budget] of [
  ["zero", 0], ["negative", -1], ["fraction", 1.5], ["NaN", NaN],
  ["Infinity", Infinity], ["negative Infinity", -Infinity], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ["string", "1"], ["null", null], ["boolean", true],
]) {
  test(`A23 pure explicit ${label} budget fails closed before any Store access`, () => {
    let accesses = 0;
    const fixture = { store: new Proxy({}, { get() { accesses++; throw new Error("Unexpected Store access"); } }) };
    assert.throws(() => project(cases.map(scenario => scenario.selector), budget, fixture),
      /maxContextItems.*positive.*safe integer/i);
    assert.equal(accesses, 0, "invalid budgets cannot query or even access the Store");
  });
}

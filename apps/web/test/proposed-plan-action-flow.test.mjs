import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { proposedPlanActionPayload } from "../src/features/workspace/proposed-plan-action-payload.ts";

// Execute the real nested handler without mounting React or making HTTP calls.
// This is a handler unit test, not packaged GUI evidence.
const path = new URL("../src/features/workspace/WorkspaceClientView.tsx", import.meta.url);
const source = readFileSync(path, "utf8");
const startMarker = "  async function runProposedPlanAction(";
const start = source.indexOf(startMarker);
const end = source.indexOf("\n  function openProposedPlanSource(", start);
assert.ok(start >= 0 && end > start);
assert.equal(source.indexOf(startMarker, start + 1), -1);
// Node transforms this exact TS function; TypeScript 7's package has no compiler API.
const handlerCode = stripTypeScriptTypes(`(${source.slice(start, end).trim()})`, { mode: "transform" });
const displayed = { id: "parent", threadId: "thread", title: "Displayed", bodyMarkdown: "Old body", version: 1, revision: 2 };

function fixture({ channelPlanModeActive = false, reject = false } = {}) {
  const events = [];
  const canonical = { ...displayed, id: "canonical-child", title: "Canonical", bodyMarkdown: "Exact\n\n```js\n1 + 2\n```", version: 2, revision: 1 };
  const perform = async (...args) => {
    events.push({ kind: "host", args });
    if (reject) throw new Error("409 stale snapshot");
    return { plan: canonical };
  };
  const run = vm.runInNewContext(handlerCode, {
    proposedPlanActionBusyId: "", channelPlanModeActive, cwd: "/owned-test-workspace",
    proposedPlanActionPayload,
    setProposedPlanActionBusyId: id => events.push({ kind: "busy", id }),
    ensureChannelGoalThreadId: async () => { throw new Error("unexpected thread creation"); },
    acceptProposedPlanArtifact: perform, refineProposedPlanArtifact: perform,
    saveProposedPlanArtifact: perform, archiveProposedPlanArtifact: perform, convertProposedPlanToWorkflow: perform,
    rememberProposedPlanArtifact: plan => events.push({ kind: "remember", plan }),
    onRefreshTasks: () => events.push({ kind: "tasks" }),
    onRefreshChannelActivity: () => events.push({ kind: "activity" }),
    refreshProposedPlanHistory: () => events.push({ kind: "history" }),
    setChannelPlanMode: async value => events.push({ kind: "mode", value }),
    onSendMessage: async input => events.push({ kind: "message", input }),
    showComposerFeedback: (kind, text) => events.push({ kind: "feedback", level: kind, text }),
    t: (text, values = {}) => text.replace(/\{(\w+)\}/gu, (_, key) => values[key]),
  });
  return { events, canonical, run };
}

for (const action of ["accept", "refine"]) {
  test(`${action} does not switch mode or send a continuation after Host rejection`, async () => {
    const f = fixture({ channelPlanModeActive: action === "accept", reject: true });
    await f.run(displayed, action);
    assert.equal(f.events.some(event => event.kind === "host"), true);
    for (const kind of ["mode", "message", "remember", "tasks"]) {
      assert.equal(f.events.some(event => event.kind === kind), false, kind);
    }
    assert.equal(f.events.find(event => event.kind === "feedback").level, "error");
    assert.equal(f.events.at(-1).id, "");
  });

  test(`${action} uses the Host-returned plan and only then changes plan mode`, async () => {
    const f = fixture({ channelPlanModeActive: action === "accept" });
    await f.run(displayed, action);
    const hostIndex = f.events.findIndex(event => event.kind === "host");
    const modeIndex = f.events.findIndex(event => event.kind === "mode");
    const messageIndex = f.events.findIndex(event => event.kind === "message");
    assert.ok(hostIndex < modeIndex && modeIndex < messageIndex);
    assert.equal(f.events[hostIndex].args[3].plan.expectedRevision, displayed.revision);
    assert.equal(f.events[hostIndex].args[3].expectedRevision, displayed.revision);
    assert.equal(f.events[modeIndex].value, action === "refine");
    const message = f.events[messageIndex].input;
    assert.ok(message.body.includes(f.canonical.title));
    assert.ok(message.body.endsWith(f.canonical.bodyMarkdown));
    assert.equal(message.body.includes(displayed.bodyMarkdown), false);
    assert.equal(message.requestAiReply, action === "refine");
    assert.equal(f.events.find(event => event.kind === "remember").plan.id, f.canonical.id);
    assert.equal(f.events.find(event => event.kind === "feedback").level, "success");
    assert.equal(f.events.at(-1).id, "");
  });
}

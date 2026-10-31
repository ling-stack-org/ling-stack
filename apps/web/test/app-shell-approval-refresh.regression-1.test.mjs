import assert from "node:assert/strict";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "../scripts/typescript-ast.mjs";

// Regression: R6 — GET completion refreshed ordinary conversations but not the owning channel.
// Found by /qa independent review on 2026-10-25
// Report: output/e6-20260928/p3-current-checkpoint-20261025.md
// Value: protects=receipt-owned read-only channel invalidation; fails_when=channel views are omitted or foreign views are refreshed;
// why_new=domain tests cover emitted events, not AppShell dispatch; seam=none;
// no_claim=actual AppShell callback with stubbed view IO is not packaged GUI or live SSE recovery.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const appPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
class DaemonObservationDeferredError extends Error {}
const callback = withTypeScriptSourceFiles([appPath], files => {
  const source = files.get(appPath), matches = [];
  visitTypeScriptNode(source, node => {
    if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === "refreshApprovalDependents") matches.push(node.getText(source));
  });
  assert.equal(matches.length, 1);
  return stripTypeScriptTypes(matches[0], { mode: "transform" });
}, { cwd: webRoot });

function fixture(overrides = {}) {
  const calls = [], timers = [];
  const io = Object.fromEntries(["refreshConversationThreads", "refreshSelectedConversation", "refreshExternalActionDetailsByIds",
    "loadRun", "refreshRuns", "refreshMediaJobs", "refreshTasks", "refreshChannelMessages", "refreshChannelProtocol",
    "refreshChannelFiles", "refreshChannelRunArtifacts", "refreshChannelExecutionActions", "refreshChannelActivityTransitions"]
    .map(name => [name, async (...args) => { calls.push({ name, args }); }]));
  const context = { ...io, DaemonObservationDeferredError, window: { setTimeout: callback => { timers.push(callback); return timers.length; } },
    selectedConversationDetail: undefined, activeRunId: "", lookupRunId: "", approvalRepairRunId: "",
    selectedChannelId: "channel-qa", selectedChannelMessageThreadId: "topic-qa", channelRunsForArtifacts: [{ id: "run-qa" }],
    approvalRefreshOwnerRef: { current: { cwd: "/isolated/qa", channelId: "channel-qa" } },
    daemonObservationRef: { current: { paused: false, epoch: 1 } },
    refreshApprovals: () => { throw new Error("receipt observer must not recurse"); }, ...overrides };
  context.approvalRefreshOwner = context.approvalRefreshOwnerRef.current;
  return { calls, timers, refresh: runInNewContext(`(${callback})`, context),
    pause(paused = true) { context.daemonObservationRef.current = { paused, epoch: context.daemonObservationRef.current.epoch + 1 }; },
    replaceOwner(cwd, channelId) { context.approvalRefreshOwnerRef.current = { cwd, channelId }; } };
}

// Regression: R03-OBS — delayed receipt invalidation bypassed Host pause.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-packaging-retry-20261026/live-findings.md
test("paused Host receipt callbacks cannot start new observation reads", async () => {
  const f = fixture(); f.pause();
  await f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" });
  assert.equal(f.calls.length, 0); assert.equal(f.timers.length, 0);
});

test("a receipt refresh spanning pause and resume cannot schedule stale fan-out", async () => {
  let release;
  const f = fixture({ refreshConversationThreads: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" });
  f.pause(); f.pause(false); release(); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.timers.length, 0);
});

test("receipt follow-up timers consult current Host observation before issuing reads", async () => {
  const f = fixture({ activeRunId: "run-qa" });
  await f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" });
  const prior = f.calls.length; assert.equal(f.timers.length, 2);
  f.pause(); f.pause(false);
  for (const timer of f.timers) timer();
  assert.equal(f.calls.length, prior);
});

test("a deferred diagnostic read after approval completion stops fan-out without reporting approval failure", async () => {
  const f = fixture({ activeRunId: "run-qa", loadRun: async () => { f.pause(); throw new DaemonObservationDeferredError(); } });
  await f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" });
  assert.equal(f.calls.some(c => channelNames.includes(c.name)), false);
});

test("approval read fan-out retains HTTP and plain errors even if they resemble observation deferral", async () => {
  for (const error of [new Error("HTTP 403 denied"), Object.assign(new Error("Observation paused"), { name: "DaemonObservationDeferredError" })]) {
    const f = fixture({ activeRunId: "run-qa", loadRun: async () => { throw error; } });
    await assert.rejects(f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" }), caught => caught === error);
  }
});
const channelNames = ["refreshTasks", "refreshChannelMessages", "refreshChannelProtocol", "refreshChannelFiles",
  "refreshChannelRunArtifacts", "refreshChannelExecutionActions", "refreshChannelActivityTransitions"];

test("completion refreshes the receipt-owned channel even when its run is not the diagnostic run", async () => {
  const f = fixture();
  await f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" });
  for (const name of channelNames) assert.equal(f.calls.filter(c => c.name === name).length, 1, name);
  assert.equal(f.calls.filter(c => c.name === "refreshRuns").length, 1);
  assert.deepEqual(f.calls.find(c => c.name === "refreshChannelMessages").args, ["channel-qa", "topic-qa"]);
});

test("a receipt for another channel never refreshes the current channel despite a stale matching run", async () => {
  const f = fixture();
  await f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-other" });
  assert.equal(f.calls.some(c => channelNames.includes(c.name)), false);
});

test("a receipt without channel metadata can use an already-observed exact channel run", async () => {
  const f = fixture();
  await f.refresh("/isolated/qa", { runId: "run-qa" });
  assert.equal(f.calls.filter(c => c.name === "refreshChannelProtocol").length, 1);
});

test("ordinary conversation completion preserves detail refresh without touching channel views", async () => {
  const f = fixture({ selectedConversationDetail: { runs: [{ id: "ordinary-qa" }] } });
  await f.refresh("/isolated/qa", { runId: "ordinary-qa" });
  assert.equal(f.calls.filter(c => c.name === "refreshSelectedConversation").length, 1);
  assert.equal(f.calls.some(c => channelNames.includes(c.name)), false);
});

for (const change of ["channel", "workspace", "away-and-back"]) {
  test(`a delayed receipt refresh cannot fan out after ${change} owner change`, async () => {
    let release;
    const f = fixture({ refreshConversationThreads: () => new Promise(resolve => { release = resolve; }) });
    const pending = f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" });
    f.replaceOwner(change === "workspace" ? "/isolated/other" : "/isolated/qa", "channel-other");
    if (change === "away-and-back") f.replaceOwner("/isolated/qa", "channel-qa");
    release();
    await pending;
    assert.equal(f.calls.some(c => channelNames.includes(c.name)), false);
    assert.equal(f.timers.length, 0, "stale completion must not schedule follow-up views");
  });
  test(`an old render callback cannot adopt the new owner after ${change} before entry`, async () => {
    const f = fixture();
    f.replaceOwner(change === "workspace" ? "/isolated/other" : "/isolated/qa", "channel-other");
    if (change === "away-and-back") f.replaceOwner("/isolated/qa", "channel-qa");
    await f.refresh("/isolated/qa", { runId: "run-qa", channelId: "channel-qa" });
    assert.equal(f.calls.length, 0, "obsolete render must not start any view request");
    assert.equal(f.timers.length, 0);
  });
}

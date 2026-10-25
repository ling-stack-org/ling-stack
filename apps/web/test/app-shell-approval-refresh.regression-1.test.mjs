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
  const context = { ...io, window: { setTimeout: callback => { timers.push(callback); return timers.length; } },
    selectedConversationDetail: undefined, activeRunId: "", lookupRunId: "", approvalRepairRunId: "",
    selectedChannelId: "channel-qa", selectedChannelMessageThreadId: "topic-qa", channelRunsForArtifacts: [{ id: "run-qa" }],
    approvalRefreshOwnerRef: { current: { cwd: "/isolated/qa", channelId: "channel-qa" } },
    refreshApprovals: () => { throw new Error("receipt observer must not recurse"); }, ...overrides };
  context.approvalRefreshOwner = context.approvalRefreshOwnerRef.current;
  return { calls, timers, refresh: runInNewContext(`(${callback})`, context),
    replaceOwner(cwd, channelId) { context.approvalRefreshOwnerRef.current = { cwd, channelId }; } };
}
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

import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "../scripts/typescript-ast.mjs";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

// R02 packaged evidence: an accepted POST disconnected, later control SSE restored
// the selected detail but never refreshed the recent-thread list. Actual hook/decoder,
// synthetic transport, no claim of packaged GUI or real Host execution.
async function fixture(t, overrides = {}, { ready = true } = {}) {
  const port = catalogHookPort(), calls = [], timers = new Map(), sources = [];
  let nextTimer = 0;
  const hookTransform = anchor => ({ anchor, replace: key =>
    `const ${anchor.slice(anchor.indexOf("{"), anchor.indexOf("}") + 1)} = globalThis[${JSON.stringify(key)}].ports.hooks;` });
  const h = await catalogConsumerHarness(t, {
    exports: { "app/use-control-plane-invalidation.ts": ["useControlPlaneInvalidation"] },
    ports: { hooks: port.hooks, snapshot: async () => ({ latestEventSeq: 100 }) },
    transforms: {
      "app/use-control-plane-invalidation.ts": [hookTransform('import { useEffect, useRef, useState } from "react";'),
        { anchor: 'import { getControlPlaneSnapshot } from "../api/control-plane.js";', replace: key =>
          `const getControlPlaneSnapshot = globalThis[${JSON.stringify(key)}].ports.snapshot;` }],
      "app/use-focused-domain-error-owner.ts": [hookTransform('import { useEffect, useReducer, useRef } from "react";')],
    },
  });
  const descriptors = Object.fromEntries(["window", "EventSource"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const replace = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, value });
  replace("window", { dispatchEvent() {}, setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); } });
  replace("EventSource", class {
    listeners = new Map();
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    close() {}
    emit(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  });
  const names = ["refreshRuns", "refreshConversationThreads", "refreshSelectedConversation", "refreshRuntimeState", "refreshApprovals",
    "refreshApprovalPolicy", "refreshProviders", "refreshMcp", "refreshPlugins", "refreshRuntimeSettings", "refreshAiTeammates",
    "refreshUsedMemoryAudit", "refreshChannelRunArtifacts", "refreshChannelExecutionActions", "refreshChannelActivity",
    "refreshSelectedChannelProtocol", "refreshSelectedChannelConversation", "invalidateSelectedTeammateConversation", "setSkillLibraryRefreshToken"];
  const input = { daemonBaseUrl: "http://127.0.0.1:17928", daemonHealthy: true, localWebSocketRpcEnabled: false,
    workspaceCwd: "/isolated/r02", selectedChannelId: "", selectedTeammateId: "", channelRunsForArtifacts: [],
    ...Object.fromEntries(names.map(name => [name, async (...args) => { calls.push({ name, args }); }])), ...overrides };
  const render = () => port.render(h.module.useControlPlaneInvalidation, input);
  render(); await port.flush();
  t.after(() => { port.unmount(); for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  const flush = async () => {
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    for (let i = 0; i < 12; i++) await port.flush();
  };
  const replayReady = (source, seq) => source.emit("control_plane_replay_ready", {
    disposition: "complete", requestedAfterSeq: seq, replayFloorSeq: 0, upperBoundSeq: seq, nextAfterSeq: seq,
  });
  if (ready) { replayReady(sources[0], 100); await flush(); calls.length = 0; }
  return { calls, render, input, sources, flush, replayReady,
    async invalidate(domains) {
      let seq = 100;
      for (const domain of domains) sources.at(-1).emit("control_plane_event", { seq: ++seq, domain, action: "updated" });
      await flush();
    } };
}

test("one control invalidation batch refreshes both selected detail and recent conversation states", async t => {
  const f = await fixture(t); await f.invalidate(["runs", "work_units", "approvals", "artifacts"]);
  assert.equal(f.calls.filter(c => c.name === "refreshSelectedConversation").length, 1);
  assert.deepEqual(f.calls.filter(c => c.name === "refreshConversationThreads"), [
    { name: "refreshConversationThreads", args: ["/isolated/r02", { throwOnError: true }] },
  ]);
});

test("the global recent list also recovers while a channel is selected; no ordinary detail is selected", async t => {
  const f = await fixture(t, { selectedChannelId: "channel-r02" }); await f.invalidate(["runs"]);
  assert.equal(f.calls.filter(c => c.name === "refreshConversationThreads").length, 1);
  assert.equal(f.calls.filter(c => c.name === "refreshSelectedConversation").length, 0);
  assert.equal(f.calls.filter(c => c.name === "refreshChannelActivity").length, 1);
  assert.deepEqual(f.calls.find(c => c.name === "refreshChannelActivity").args, [{ throwOnError: true }]);
});

test("a newly queued workflow observation invalidation immediately revokes ready", async t => {
  let resolveRefresh;
  const refresh = new Promise(resolve => { resolveRefresh = resolve; });
  const f = await fixture(t, { selectedChannelId: "channel-r02" });
  assert.equal(f.render().observationReady, true);
  f.input.refreshChannelActivity = () => refresh; f.render();
  const source = f.sources.at(-1);
  source.emit("control_plane_event", { seq: 101, domain: "runs", action: "updated" });
  assert.equal(f.render().observationReady, false);
  await f.flush();
  assert.equal(f.render().observationReady, false, "the debounced refresh must finish before ready");
  resolveRefresh();
  await f.flush();
  assert.equal(f.render().observationReady, true);
  f.calls.length = 0;
  source.emit("control_plane_event", { seq: 101, domain: "runs", action: "updated" });
  source.emit("control_plane_event", { seq: 100, domain: "work_units", action: "updated" });
  assert.equal(f.render().observationReady, true, "duplicates do not revoke an already-applied proof");
  await f.flush(); assert.deepEqual(f.calls, []);
});

test("a selected-channel refresh failure keeps workflow observation not ready", async t => {
  const f = await fixture(t, { selectedChannelId: "channel-r02" });
  assert.equal(f.render().observationReady, true);
  let shouldFail = true;
  f.input.refreshChannelActivity = async () => { if (shouldFail) throw new Error("channel offline"); }; f.render();
  f.sources.at(-1).emit("control_plane_event", { seq: 101, domain: "runs", action: "updated" });
  await f.flush();
  assert.equal(f.render().observationReady, false);
  assert.equal(f.render().error?.message, "channel offline");
  await f.flush();
  assert.equal(new URL(f.sources.at(-1).url).searchParams.get("afterSeq"), "100");
  assert.equal(f.render().observationReady, false);
  shouldFail = false;
  f.sources.at(-1).emit("control_plane_event", { seq: 101, domain: "runs", action: "updated" });
  f.replayReady(f.sources.at(-1), 101); await f.flush();
  assert.equal(f.render().observationReady, true);
  assert.equal(f.render().error, undefined);
  f.sources.at(-1).emit("error"); await f.flush();
  assert.equal(new URL(f.sources.at(-1).url).searchParams.get("afterSeq"), "101");
});

test("an earlier successful batch cannot restore ready while a newer batch is pending", async t => {
  const f = await fixture(t, { selectedChannelId: "channel-r02" });
  assert.equal(f.render().observationReady, true);
  let releaseFirst, releaseSecond, reads = 0;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const second = new Promise(resolve => { releaseSecond = resolve; });
  f.input.refreshChannelActivity = () => ++reads === 1 ? first : second; f.render();
  f.sources.at(-1).emit("control_plane_event", { seq: 101, domain: "runs", action: "updated" }); await f.flush();
  assert.equal(reads, 1);
  f.sources.at(-1).emit("control_plane_event", { seq: 102, domain: "work_units", action: "updated" });
  releaseFirst(); await f.flush();
  assert.equal(reads, 2);
  assert.equal(f.render().observationReady, false);
  releaseSecond(); await f.flush();
  assert.equal(f.render().observationReady, true);
});

test("ready waits for every refresh in the invalidation batch", async t => {
  const f = await fixture(t, { selectedChannelId: "channel-r02" });
  assert.equal(f.render().observationReady, true);
  let releaseActivity, releaseList;
  f.input.refreshChannelActivity = () => new Promise(resolve => { releaseActivity = resolve; });
  f.input.refreshConversationThreads = () => new Promise(resolve => { releaseList = resolve; }); f.render();
  f.sources.at(-1).emit("control_plane_event", { seq: 101, domain: "runs", action: "updated" }); await f.flush();
  releaseActivity(); await f.flush(); assert.equal(f.render().observationReady, false);
  releaseList(); await f.flush(); assert.equal(f.render().observationReady, true);
});

test("approvals-only invalidation refreshes selected workflow steps without broad channel activity", async t => {
  const f = await fixture(t, { selectedChannelId: "channel-r02" });
  assert.equal(f.render().observationReady, true);
  await f.invalidate(["approvals"]);
  for (const name of ["refreshApprovals", "refreshApprovalPolicy", "refreshSelectedChannelProtocol", "refreshSelectedChannelConversation"]) {
    assert.equal(f.calls.filter(call => call.name === name).length, 1, name);
  }
  assert.equal(f.calls.some(call => call.name === "refreshChannelActivity" || call.name === "refreshRuntimeState"), false);
  assert.equal(f.render().observationReady, true);
  f.calls.length = 0;
  f.sources.at(-1).emit("control_plane_event", { seq: 102, domain: "runs", action: "updated" });
  f.sources.at(-1).emit("control_plane_event", { seq: 103, domain: "approvals", action: "updated" }); await f.flush();
  assert.equal(f.calls.filter(call => call.name === "refreshChannelActivity").length, 1);
  assert.equal(f.calls.some(call => call.name === "refreshSelectedChannelProtocol"), false, "activity already owns the protocol read");
});

test("approvals-only protocol failure cannot advance the cursor or restore ready", async t => {
  const f = await fixture(t, { selectedChannelId: "channel-r02" });
  assert.equal(f.render().observationReady, true);
  f.input.refreshSelectedChannelProtocol = async () => { throw new Error("workflow steps offline"); }; f.render();
  await f.invalidate(["approvals"]);
  assert.equal(f.render().observationReady, false);
  assert.equal(f.render().error?.message, "workflow steps offline");
  await f.flush();
  assert.equal(new URL(f.sources.at(-1).url).searchParams.get("afterSeq"), "100");
});

test("the selected-protocol callback remains optional for existing invalidation callers", async t => {
  const f = await fixture(t, { selectedChannelId: "channel-r02", refreshSelectedChannelProtocol: undefined });
  await f.invalidate(["approvals"]);
  assert.equal(f.render().observationReady, true);
  assert.equal(f.calls.filter(call => call.name === "refreshApprovals").length, 1);
});

test("actual AppShell refresh preserves strict protocol failures and default caller compatibility", async () => {
  const appPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
  const callbacks = withTypeScriptSourceFiles([appPath], files => {
    const source = files.get(appPath), activity = [], protocol = [];
    visitTypeScriptNode(source, node => {
      if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === "refreshChannelActivity") activity.push(node.getText(source));
      if (ts.isCallExpression(node) && node.expression.getText(source) === "useControlPlaneInvalidation") {
        for (const property of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(source) === "refreshSelectedChannelProtocol") protocol.push(property.initializer.getText(source));
        }
      }
    });
    assert.equal(activity.length, 1); assert.equal(protocol.length, 1);
    return { activity: stripTypeScriptTypes(activity[0], { mode: "transform" }), protocol: stripTypeScriptTypes(protocol[0], { mode: "transform" }) };
  }, { cwd: fileURLToPath(new URL("..", import.meta.url)) });
  const calls = [], failure = new Error("workflow protocol offline");
  const context = { selectedChannelId: "channel-r02", selectedChannelMessageThreadId: "branch-r02", channelRunsForArtifacts: [],
    form: { cwd: "/isolated/r02" }, daemonObservationRef: { current: { paused: false } },
    ...Object.fromEntries(["refreshChannels", "refreshTasks", "refreshChannelMessages", "refreshChannelExecutionProposals", "refreshChannelFiles",
      "refreshChannelRunArtifacts", "refreshChannelExecutionActions", "refreshChannelGovernanceNotifications", "refreshSelectedChannelCouncil",
      "refreshRuns", "refreshApprovals", "refreshExternalWorkCiTriage", "refreshUsedMemoryAudit", "refreshChannelActivityTransitions"]
      .map(name => [name, async (...args) => { calls.push({ name, args }); }])),
    refreshChannelProtocol: async (...args) => { calls.push({ name: "refreshChannelProtocol", args }); throw failure; } };
  const activity = runInNewContext(`(${callbacks.activity})`, context);
  await assert.rejects(activity({ throwOnError: true }), caught => caught === failure);
  assert.equal(calls.find(call => call.name === "refreshChannelProtocol").args[1].throwOnError, true);
  calls.length = 0;
  await activity();
  assert.equal(calls.find(call => call.name === "refreshChannelProtocol").args[1], undefined);
  calls.length = 0;
  const protocol = runInNewContext(callbacks.protocol, context);
  await assert.rejects(protocol(), caught => caught === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "channel-r02"); assert.equal(calls[0].args[1].throwOnError, true);
  context.selectedChannelId = ""; calls.length = 0;
  await protocol(); assert.deepEqual(calls, []);
});

test("unrelated invalidations do not reload conversation lists", async t => {
  const f = await fixture(t); await f.invalidate(["memory", "providers"]);
  assert.equal(f.calls.some(c => c.name === "refreshConversationThreads"), false);
});

test("a failed list refresh blocks advancing the replay cursor and reconnects from the last applied state", async t => {
  let shouldFail = false;
  const f = await fixture(t, { refreshConversationThreads: async () => { if (shouldFail) throw new Error("list offline"); } });
  shouldFail = true;
  await f.invalidate(["runs"]);
  assert.equal(f.render().error?.message, "list offline");
  await f.flush();
  assert.equal(new URL(f.sources.at(-1).url).searchParams.get("afterSeq"), "100");
  assert.equal(f.sources.length, 2);
});

// Regression: R03-OBS — Host drain is not ordinary offline and cannot consume invalidations.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-packaging-retry-20261026/live-findings.md
test("Host pause closes observation without new refresh/reconnect; resume takes a fresh snapshot", async t => {
  const f = await fixture(t);
  assert.equal(f.render().observationReady, true);
  f.input.observation = { paused: true, workspaceCwd: "/isolated/r02", epoch: 2, baseUrl: f.input.daemonBaseUrl };
  assert.equal(f.render().observationReady, false); await f.flush();
  const count = f.sources.length;
  await f.invalidate(["runs"]); await f.flush();
  assert.deepEqual(f.calls, []);
  assert.equal(f.sources.length, count);
  f.input.observation = { ...f.input.observation, paused: false, epoch: 3 };
  assert.equal(f.render().observationReady, false); await f.flush();
  assert.equal(f.sources.length, count + 1);
  assert.equal(new URL(f.sources.at(-1).url).searchParams.get("afterSeq"), "100");
  f.replayReady(f.sources.at(-1), 100); await f.flush();
  assert.ok(f.calls.some(call => call.name === "refreshConversationThreads"));
  assert.equal(f.render().observationReady, true);
});

test("workflow graph observation is unknown until replay/baseline completes and is revoked on disconnect", async t => {
  const f = await fixture(t, {}, { ready: false });
  assert.equal(f.render().observationReady, false, "daemon health alone is not a read freshness proof");
  const original = f.sources[0];
  f.replayReady(original, 100); await f.flush();
  assert.equal(f.render().observationReady, true);
  original.emit("error");
  assert.equal(f.render().observationReady, false);
  f.replayReady(original, 100); await f.flush();
  assert.equal(f.sources.length, 2);
  assert.equal(f.render().observationReady, false, "a stale transport callback cannot restore observation");
  f.replayReady(f.sources.at(-1), 100); await f.flush();
  assert.equal(f.render().observationReady, true);
  f.input.workspaceCwd = "/other-workspace";
  assert.equal(f.render().observationReady, false, "ready proof is scoped to one workspace");
});

test("workflow graph observation does not publish current while the baseline refresh is pending", async t => {
  let resolveBaseline;
  const baseline = new Promise(resolve => { resolveBaseline = resolve; });
  const f = await fixture(t, { refreshConversationThreads: () => baseline }, { ready: false });
  f.replayReady(f.sources[0], 100); await f.flush();
  assert.equal(f.render().observationReady, false);
  resolveBaseline(); await f.flush();
  assert.equal(f.render().observationReady, true);
});

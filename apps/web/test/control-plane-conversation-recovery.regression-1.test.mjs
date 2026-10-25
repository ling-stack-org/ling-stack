import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

// R02 packaged evidence: an accepted POST disconnected, later control SSE restored
// the selected detail but never refreshed the recent-thread list. Actual hook/decoder,
// synthetic transport, no claim of packaged GUI or real Host execution.
async function fixture(t, overrides = {}) {
  const port = catalogHookPort(), calls = [], timers = new Map(), sources = [];
  let nextTimer = 0;
  const hookTransform = anchor => ({ anchor, replace: key =>
    `const ${anchor.slice(anchor.indexOf("{"), anchor.indexOf("}") + 1)} = globalThis[${JSON.stringify(key)}].ports.hooks;` });
  const h = await catalogConsumerHarness(t, {
    exports: { "app/use-control-plane-invalidation.ts": ["useControlPlaneInvalidation"] },
    ports: { hooks: port.hooks, snapshot: async () => ({ latestEventSeq: 100 }) },
    transforms: {
      "app/use-control-plane-invalidation.ts": [hookTransform('import { useEffect, useRef } from "react";'),
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
    "refreshSelectedChannelConversation", "invalidateSelectedTeammateConversation", "setSkillLibraryRefreshToken"];
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
  replayReady(sources[0], 100); await flush(); calls.length = 0;
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

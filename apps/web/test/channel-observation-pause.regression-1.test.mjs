import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LingDaemonError, LingDaemonTransportError } from "@ling-stack/api-client";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

// Native controller callbacks/guards/projections, with hooks and transport as
// ports. No GUI, live Host, database, model request or Run status is fabricated.
const cwd = "/isolated/r03-channel";
const workspacePath = "domains/workspace/use-workspace-domain.ts";
const actionsPath = "app/use-channel-actions-controller.ts";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const transport = () => new LingDaemonTransportError("fetch", new TypeError("Failed to fetch"));
function envelope(threadId = "root", body = "original") {
  const item = { schemaVersion: 1, id: `user-${threadId}`, workspaceId: "qa", channelId: "channel", threadId,
    turnId: `turn-${threadId}`, sequence: 1, kind: "user_message", actorType: "local_user", actorId: "local-user",
    status: "committed", visibility: "channel", revision: 1, domainRefs: [],
    createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
    payload: { body, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } };
  return { channelId: "channel", thread: { id: threadId, workspaceId: "qa", channelId: "channel",
    surfaceKind: threadId === "root" ? "channel_root" : "branch", relationKind: "root" },
    turn: { id: item.turnId }, userItem: item, items: [item], assistantItems: [], decorations: [],
    turnContextAssignments: [], generatedMedia: [], hasMore: true, nextBeforeSequence: 5 };
}

async function fixture(t, kind, paused = false) {
  const port = catalogHookPort(), calls = [], feedback = [], pendingKeys = new Map(), state = { messages: [], items: [], accepted: 0 };
  let apiOverride, stream, input;
  const observation = { paused, epoch: 1, workspaceCwd: cwd, baseUrl: "http://127.0.0.1:17928" };
  const apiPort = async (name, ...args) => {
    calls.push({ name, args });
    const result = apiOverride?.(name, ...args);
    if (result !== undefined) return result;
    if (name === "listChannelConversationItems") return envelope(args[2]?.surface?.threadId);
    if (name === "getConversationSubmission") {
      const sourceItem = envelope(args[1].threadId).userItem;
      return { cwd, surface: "channel", channelId: "channel", threadId: sourceItem.threadId, turnId: sourceItem.turnId,
        sourceItemId: sourceItem.id, status: "accepted", idempotencyKey: args[1].idempotencyKey, sourceItem };
    }
    if (name === "streamChannelTurn") return {};
    if (name === "listChannels") return { channels: [{ id: "channel" }], branches: [] };
    if (name === "listTasks") return { tasks: [] };
    if (name === "listAiCouncils") return { councils: [] };
    if (name === "getAiCouncilHealth") return { report: {} };
    if (name === "getChannelCouncilPolicy") return { policy: {} };
    if (name === "getChannelEffectiveCouncil") return { effectiveCouncil: {} };
    if (name === "listChannelExecutionProposals") return { proposals: [] };
    if (name === "listChannelAttachments") return { attachments: [] };
    if (name === "listChannelLinkPreviews") return { linkPreviews: [] };
    if (name === "listRunArtifacts") return { artifacts: [] };
    if (name === "listExecutionActions") return { actions: [] };
    if (name === "listStateTransitions") return { transitions: [] };
    if (name === "listGovernanceNotifications") return { notifications: [] };
    if (name === "listChannelMessageRouteDecisions" || name === "listChannelIntentDecisions" || name === "listChannelDecisions") return { decisions: [] };
    if (name === "getChannelBrief") return {};
    if (name === "getChannelCollaborationProtocol") return {};
    if (name === "listChannelHandoffs") return { handoffs: [] };
    if (name === "listChannelContextSummaries") return { contextSummaries: [] };
    if (name === "listChannelWorkflows") return { workflows: [] };
    if (name === "listMemoryObjects") return { memories: [] };
    if (name === "listUsedMemoryEvents") return { events: [] };
    throw new Error(`unexpected IO ${name}`);
  };
  const transforms = {};
  for (const path of [workspacePath, actionsPath]) {
    const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
    const start = source.indexOf("import {\n"), end = source.indexOf('} from "' + (path === workspacePath ? "../../api.js" : "../api.js") + '";', start);
    assert.ok(start >= 0 && end > start);
    const anchor = source.slice(start, source.indexOf(";", end) + 1);
    const names = anchor.slice(anchor.indexOf("{") + 1, anchor.indexOf("}")).split(",").map(name => name.trim()).filter(Boolean);
    const hooksAnchor = source.slice(0, source.indexOf(";") + 1);
    transforms[path] = [{ anchor: hooksAnchor, replace: key => `const { useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
      { anchor, replace: key => `const { ${names.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` }];
  }
  transforms["lib/use-latest-request.ts"] = [{ anchor: 'import { useRef } from "react";', replace: key => `const { useRef } = globalThis[${JSON.stringify(key)}].ports.hooks;` }];
  transforms[actionsPath].push(
    { anchor: 'import { readSseResponse } from "../sse.js";', replace: key => `const { readSseResponse } = globalThis[${JSON.stringify(key)}].ports;` },
    { anchor: 'import { submissionLookupJournal } from "../shared/conversation/conversation-submission-journal.js";', replace: key => `const submissionLookupJournal = globalThis[${JSON.stringify(key)}].ports.journal;` },
  );
  const names = new Set(Object.values(transforms).flat().filter(seam => seam.anchor.includes("/api.js")).flatMap(seam =>
    seam.anchor.slice(seam.anchor.indexOf("{") + 1, seam.anchor.indexOf("}")).split(",").map(name => name.trim()).filter(Boolean)));
  const h = await catalogConsumerHarness(t, { exports: { [workspacePath]: ["useWorkspaceDomain"], [actionsPath]: ["useChannelActionsController"] }, transforms,
    ports: { hooks: port.hooks, api: Object.fromEntries([...names].map(name => [name, (...args) => apiPort(name, ...args)])),
      readSseResponse: async (_response, receive) => stream?.(receive), journal: {
        read: owner => pendingKeys.get(JSON.stringify(owner)), begin: (owner, key) => pendingKeys.set(JSON.stringify(owner), key),
        finish() {}, forget: owner => pendingKeys.delete(JSON.stringify(owner)),
      } } });
  const noop = () => {};
  input = kind === "workspace" ? { cwd, initialWorkspaceCwd: cwd, selectedChannelBranchId: "", translate: value => value,
    clearFeedback: noop, reportFeedback: entry => feedback.push(entry) } : {
    form: { cwd }, selectedChannelId: "channel", selectedChannelMessageThreadId: undefined,
    channels: [], providers: [], providerTemplates: [], channelDecisions: [], clearFeedback: noop,
    reportFeedback: entry => feedback.push(entry), setChannelMessages: update => { state.messages = typeof update === "function" ? update(state.messages) : update; },
    setChannelConversationItems: update => { state.items = typeof update === "function" ? update(state.items) : update; },
    ...Object.fromEntries(["refreshChannelMessages", "refreshChannelExecutionProposals", "refreshChannelIntentDecisions", "refreshUsedMemoryAudit",
      "refreshChannelMessageRouteDecisions", "refreshChannelFiles", "refreshChannelActivity", "refreshRuns", "refreshRuntimeState"].map(name => [name, async () => { calls.push({ name }); }])),
  };
  const render = () => port.render(h.module[kind === "workspace" ? "useWorkspaceDomain" : "useChannelActionsController"], { ...input, observation: { ...observation } });
  render();
  if (kind === "workspace") { render().actions.setSelectedChannelId("channel"); render(); }
  t.after(() => port.unmount());
  return { render, calls, feedback, pendingKeys, state, observation,
    io(value) { apiOverride = value; }, stream(value) { stream = value; },
    change(value) { input = { ...input, ...value }; return render(); },
    pause(paused = true, workspaceCwd = cwd) { Object.assign(observation, { paused, workspaceCwd, epoch: observation.epoch + 1 }); render(); },
    send(threadId) { return render().sendChannelMessage({ threadId, body: "qa", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [],
      requestAiReply: false, onMessageAccepted() { state.accepted++; } }); },
  };
}

test("channel root/panels/sidebar/memory reads do not start while the same owned Host is paused", async t => {
  const f = await fixture(t, "workspace", true), actions = f.render().actions;
  for (const name of ["refreshChannels", "refreshAiCouncils", "refreshTasks", "refreshSelectedChannelCouncil", "refreshChannelMessages",
    "refreshChannelExecutionProposals", "refreshChannelFiles", "refreshChannelRunArtifacts", "refreshChannelExecutionActions",
    "refreshChannelActivityTransitions", "refreshChannelGovernanceNotifications", "refreshChannelMessageRouteDecisions",
    "refreshChannelIntentDecisions", "refreshChannelProtocol", "refreshUsedMemoryAudit"]) {
    await actions[name]();
  }
  assert.deepEqual(f.calls, []);
});

for (const threadId of [undefined, "branch"]) {
  test(`late ${threadId ?? "root"} transcript and paging cannot cross pause/resume epochs`, async t => {
    const f = await fixture(t, "workspace");
    if (threadId) {
      f.render().actions.setChannelBranches([{ id: "branch-owner", channelId: "channel", rootThreadId: threadId, status: "active" }]);
      f.change({ selectedChannelBranchId: "branch-owner" });
    }
    await f.render().actions.refreshChannelMessages("channel", threadId);
    const pending = deferred(); f.io(name => name === "listChannelConversationItems" ? pending.promise : undefined);
    const read = f.render().actions.loadOlderChannelMessages("channel", threadId);
    f.pause(); f.pause(false); pending.resolve(envelope(threadId, "stale")); await read;
    assert.equal(f.render().state.channelMessages[0].body, "original");
    f.pause(); const before = f.calls.length;
    await f.render().actions.refreshChannelMessages("channel", threadId);
    await f.render().actions.loadOlderChannelMessages("channel", threadId);
    assert.equal(f.calls.length, before);
  });
}

for (const [label, error, expected] of [["typed transport", transport(), false], ["HTTP business", new Error("HTTP 403 denied"), true],
  ["plain TypeError", new TypeError("Failed to fetch"), true]]) {
  test(`paused channel reads merge only typed transport, retain ${label}`, async t => {
    const f = await fixture(t, "workspace"), pending = deferred();
    f.io(name => name === "listChannelConversationItems" ? pending.promise : undefined);
    const read = f.render().actions.refreshChannelMessages("channel"); f.pause(); pending.reject(error); await read;
    assert.equal(f.feedback.some(entry => entry.message === error.message), expected);
  });
}

test("a foreign workspace pause neither gates channel reads nor merges its transport errors", async t => {
  const f = await fixture(t, "workspace"); f.pause(true, "/foreign");
  f.io(name => name === "listChannelConversationItems" ? Promise.reject(transport()) : undefined);
  await f.render().actions.refreshChannelMessages("channel");
  assert.equal(f.calls.length, 1); assert.equal(f.feedback.length, 1);
});

for (const [action, endpoint, errorState] of [["refreshChannelRunArtifacts", "listRunArtifacts", "channelArtifactErrorsByRun"],
  ["refreshChannelExecutionActions", "listExecutionActions", "channelExecutionActionError"],
  ["refreshChannelActivityTransitions", "listStateTransitions", "channelActivityTransitionError"]]) {
  test(`${action} preserves actual business errors across drain, without string-based transport merging`, async t => {
    for (const [error, visible] of [[transport(), false], [new Error("HTTP 403 batch denied"), true]]) {
      const f = await fixture(t, "workspace"), pending = deferred();
      f.io(name => name === endpoint ? pending.promise : undefined);
      const read = f.render().actions[action](cwd, "channel", [{ id: "run", channelId: "channel", updatedAt: "2026-10-26T00:00:00.000Z" }]);
      f.pause(); pending.reject(error); await read;
      const result = f.render().state[errorState];
      const messages = typeof result === "string" ? result : Object.values(result).join(" ");
      assert.equal(messages.includes(error.message), visible);
    }
  });
}

for (const threadId of [undefined, "topic", "branch"]) {
  test(`paused ${threadId ?? "root"} submissions do not POST or change their lookup journal`, async t => {
    const f = await fixture(t, "actions", true);
    await assert.rejects(f.send(threadId), error => error.name === "DaemonObservationDeferredError");
    assert.deepEqual(f.calls, []); assert.equal(f.pendingKeys.size, 0);
  });
}

test("all exported channel mutation callbacks consult the current pause ref, including callbacks captured before pause", async t => {
  const f = await fixture(t, "actions"), beforePause = f.render(); f.pause();
  for (const [name, action] of Object.entries(beforePause)) {
    if (name === "sendChannelMessage") continue;
    await assert.rejects(action(), error => error.name === "DaemonObservationDeferredError", name);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.feedback, []);
});

test("accepted channel stream transport loss during drain keeps acceptance and performs no refresh or resend", async t => {
  const f = await fixture(t, "actions");
  f.stream(receive => { receive({ event: "ready", data: JSON.stringify(envelope()) }); f.pause(); throw transport(); });
  assert.deepEqual(await f.send(), {});
  assert.equal(f.state.accepted, 1); assert.equal(f.pendingKeys.size, 0);
  assert.deepEqual(f.calls.map(call => call.name), ["streamChannelTurn"]); assert.deepEqual(f.feedback, []);
});

test("unconfirmed channel send stays query-only across drain, then recovers receipt without a second POST", async t => {
  const f = await fixture(t, "actions");
  f.stream(() => { f.pause(); throw transport(); });
  await assert.rejects(f.send(), error => error.name === "UnconfirmedConversationSubmissionError");
  assert.equal(f.pendingKeys.size, 1); assert.deepEqual(f.calls.map(call => call.name), ["streamChannelTurn"]);
  f.pause(false);
  await assert.rejects(f.send(), error => error.name === "RecoveredConversationSubmissionError");
  assert.equal(f.pendingKeys.size, 0); assert.equal(f.calls.filter(call => call.name === "streamChannelTurn").length, 1);
});

test("late channel ready still acknowledges the receipt but cannot publish after pause/resume", async t => {
  const f = await fixture(t, "actions");
  f.stream(receive => { f.pause(); f.pause(false); receive({ event: "ready", data: JSON.stringify(envelope()) }); });
  await f.send(); assert.equal(f.state.accepted, 1); assert.equal(f.pendingKeys.size, 0);
  assert.deepEqual(f.state.messages, []); assert.deepEqual(f.state.items, []);
});

test("accepted channel EOF during drain performs no final refresh and never invents a failed Run", async t => {
  const f = await fixture(t, "actions");
  f.stream(receive => { receive({ event: "ready", data: JSON.stringify(envelope()) }); f.pause(); });
  assert.deepEqual(await f.send(), {}); assert.equal(f.state.accepted, 1);
  assert.deepEqual(f.calls.map(call => call.name), ["streamChannelTurn"]); assert.deepEqual(f.feedback, []);
});

for (const error of [new Error("HTTP 403 denied"), new TypeError("Failed to fetch")]) {
  test(`accepted channel ${error.name} remains visible during drain`, async t => {
    const f = await fixture(t, "actions");
    f.stream(receive => { receive({ event: "ready", data: JSON.stringify(envelope()) }); f.pause(); throw error; });
    await assert.rejects(f.send(), error); assert.equal(f.feedback.at(-1).message, error.message);
    assert.deepEqual(f.calls.map(call => call.name), ["streamChannelTurn"]);
  });
}

test("a pre-pause unknown channel receipt cannot confirm rejection or forget the pending input", async t => {
  const f = await fixture(t, "actions");
  const rejection = new LingDaemonError("HTTP 409 rejected", 409, "Conflict");
  f.stream(() => { throw rejection; });
  f.io((name, _cwd, query) => name === "getConversationSubmission"
    ? { status: "unknown", cwd, idempotencyKey: query.idempotencyKey } : undefined);
  const sending = f.send();
  const observed = sending.catch(error => error);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.filter(call => call.name === "getConversationSubmission").length, 1);
  f.pause();
  await observed;
  assert.equal(f.calls.filter(call => call.name === "getConversationSubmission").length, 1, "paused retries do not issue new GETs");
  assert.equal(f.pendingKeys.size, 1, "stale unknown is not proof of rejection");
  assert.equal(f.calls.filter(call => call.name === "streamChannelTurn").length, 1);
});

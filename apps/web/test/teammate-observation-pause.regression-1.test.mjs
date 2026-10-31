import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

// Actual private transcript hook and read conditions; only hooks, transport and
// the external Host observation context are ports. No Host/Run status is invented.
const path = "features/teammates/use-teammate-private-timeline.ts";
const cwd = "/isolated/r03-private";
class TransportError extends Error {}
const response = threadId => ({ cwd, teammateId: "engineer", messages: [],
  thread: { id: threadId, teammateId: "engineer", workspaceId: "qa-workspace" } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function fixture(t, paused = false) {
  const port = catalogHookPort(), calls = [], timeouts = new Map(), intervals = new Map();
  let nextTimer = 0, read = async () => response("direct-original");
  const observation = { paused, epoch: 1, workspaceCwd: cwd, baseUrl: "http://127.0.0.1:17928" };
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  globalThis.window = { setTimeout: callback => { timeouts.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timeouts.delete(id), setInterval: callback => { intervals.set(++nextTimer, callback); return nextTimer; },
    clearInterval: id => intervals.delete(id) };
  globalThis.document = { visibilityState: "visible" };
  t.after(() => { port.unmount(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const transforms = [
    { anchor: 'import { useEffect, useRef, useState } from "react";',
      replace: key => `const { useEffect, useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
    { anchor: 'import { listTeammateDirectMessages } from "../../api.js";',
      replace: key => `const { listTeammateDirectMessages } = globalThis[${JSON.stringify(key)}].ports;` },
  ];
  // This seam is absent on the RED baseline: the original hook has no Host
  // observation input at all. The assertions below, not source matching, fail.
  for (const anchor of [
    'import { LingDaemonTransportError } from "@ling-stack/api-client";',
    'import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";',
  ]) if (source.includes(anchor)) transforms.push({ anchor, replace: key => anchor.includes("LingDaemonTransportError")
    ? `const { LingDaemonTransportError } = globalThis[${JSON.stringify(key)}].ports;`
    : `const { useDaemonObservation, isDaemonObservationPausedForWorkspace } = globalThis[${JSON.stringify(key)}].ports;` });
  const h = await catalogConsumerHarness(t, { exports: { [path]: ["useTeammatePrivateTimeline"] }, transforms: { [path]: transforms },
    ports: { hooks: port.hooks, LingDaemonTransportError: TransportError, useDaemonObservation: () => ({ ...observation }),
      isDaemonObservationPausedForWorkspace: (value, workspace) => value.paused && value.workspaceCwd === workspace.trim(),
      listTeammateDirectMessages: async (...args) => { calls.push(args); return read(...args); } } });
  let input = { cwd, teammateId: "engineer", refreshKey: "1", active: true };
  const render = () => port.render(h.module.useTeammatePrivateTimeline, input);
  async function flush() {
    await port.flush();
    const pending = [...timeouts.values()]; timeouts.clear(); pending.forEach(callback => callback());
    await port.flush(); await Promise.resolve(); await Promise.resolve();
  }
  render();
  return { calls, render, flush, observation,
    read(value) { read = value; },
    async pause(value, workspaceCwd = cwd) { Object.assign(observation, { paused: value, workspaceCwd, epoch: observation.epoch + 1 }); render(); await flush(); },
    async tick() { [...intervals.values()].forEach(callback => callback()); await flush(); },
    async update(value) { input = { ...input, ...value }; render(); await flush(); },
  };
}

test("private first load and 750ms polling do not read a paused owned Host; resume reads once", async t => {
  const f = await fixture(t, true);
  await f.flush(); await f.tick(); await f.update({ refreshKey: "2" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.render().status, "loading");
  await f.pause(false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.render().status, "loaded");
  assert.equal(f.render().directThreadId, "direct-original");
});

test("a read from before the Host epoch change cannot commit; resumed snapshot owns the result", async t => {
  const f = await fixture(t), oldRead = deferred(); f.read(() => oldRead.promise);
  await f.flush(); assert.equal(f.calls.length, 1);
  await f.pause(true); oldRead.resolve(response("stale-direct")); await f.flush();
  assert.equal(f.render().directThreadId, undefined);
  await f.tick(); assert.equal(f.calls.length, 1);
  f.read(async () => response("fresh-direct")); await f.pause(false);
  assert.equal(f.render().directThreadId, "fresh-direct");
  assert.equal(f.calls.length, 2);
});

test("paused transport loss retains the last snapshot; an HTTP/business rejection remains an error", async t => {
  const f = await fixture(t); await f.flush();
  const transport = deferred(); f.read(() => transport.promise); await f.tick();
  await f.pause(true); transport.reject(new TransportError("Failed to fetch")); await f.flush();
  assert.equal(f.render().status, "loaded");
  assert.equal(f.render().directThreadId, "direct-original");
  const business = deferred(); f.read(() => business.promise); await f.pause(false);
  await f.pause(true); business.reject(new Error("HTTP 403: private scope denied")); await f.flush();
  assert.equal(f.render().status, "error");
  assert.equal(f.render().directThreadId, "direct-original");
});

test("a foreign workspace pause does not gate or swallow this private workspace's reads", async t => {
  const f = await fixture(t); await f.flush();
  f.read(async () => { throw new TransportError("network unavailable"); });
  await f.pause(true, "/foreign/workspace"); await f.tick();
  assert.ok(f.calls.length > 1);
  assert.equal(f.render().status, "error");
});

test("teammate navigation still fences late snapshots across a Host pause", async t => {
  const f = await fixture(t), pending = deferred(); f.read(() => pending.promise); await f.flush();
  await f.pause(true); await f.update({ teammateId: "reviewer" });
  pending.resolve(response("engineer-only")); await f.flush();
  assert.equal(f.render().status, "loading");
  assert.equal(f.render().directThreadId, undefined);
});

async function workspaceFixture(t, paused = false) {
  const port = catalogHookPort(), calls = [], lifecycle = [], pendingKeys = new Map();
  const apiOverrides = new Map(), messageUpdates = [];
  let holdMessageUpdates = false, confirmFullAccess, privateGuidancePending = false;
  const observation = { paused, epoch: 1, workspaceCwd: cwd, baseUrl: "http://127.0.0.1:17928" };
  const sourcePath = "features/teammates/TeammateWorkspace.tsx";
  const source = await readFile(new URL(`../src/${sourcePath}`, import.meta.url), "utf8");
  const componentStart = source.indexOf("export function TeammateWorkspace({");
  const callbacksStart = source.indexOf("  async function refreshTeammateWorkspace(");
  const callbacksEnd = source.indexOf("  function handlePrivateComposerSubmit(");
  const componentEnd = source.indexOf("\n}\n", callbacksEnd) + 3;
  assert.ok(componentStart > 0 && callbacksStart > componentStart && callbacksEnd > callbacksStart && componentEnd > callbacksEnd);
  const apiStart = source.indexOf("import {\n  cancelTeammateDirectIntervention,");
  const apiEnd = source.indexOf('} from "../../api.js";', apiStart) + '} from "../../api.js";'.length;
  const apiImport = source.slice(apiStart, apiEnd);
  const apiNames = apiImport.slice(apiImport.indexOf("{") + 1, apiImport.indexOf("}")).split(",").map(name => name.trim()).filter(Boolean);
  let readOverride, streamRead;
  const directResponse = () => ({ ...response("direct-original"), generatedMedia: [], hasMore: true, nextBeforeMessageId: "older" });
  const api = Object.fromEntries(apiNames.map(name => [name, async (...args) => {
    calls.push({ name, args });
    if (apiOverrides.has(name)) return apiOverrides.get(name)(...args);
    if (name === "streamTeammateDirectMessage") return { ok: true, body: {} };
    if (name === "getTeammateDirectMessageSubmission") return undefined;
    if (name === "listTeammateDirectMessages") return readOverride ? readOverride() : directResponse();
    if (name === "getTeammateDirectRuntime") return { thread: directResponse().thread, interventions: [] };
    if (name === "getTeammateDirectWorkspace") return {};
    if (name === "listTeammateDirectLinkPreviews") return { linkPreviews: [] };
    if (name === "listTeammatePrivateAttachments") return { attachments: [] };
    if (name === "getSkillSourceHealth") return { snapshots: [] };
    if (name === "listTeammateSkills") return { bindings: [], effectiveSkills: [] };
    if (name === "listSkills") return { skills: [] };
    if (name === "listMcpServers") return { servers: [] };
    if (name === "listMcpTools") return { tools: [] };
    if (name === "listTeammateMcpBindings") return { bindings: [] };
    if (name === "listTeammateActivity") return { items: [] };
    throw new Error(`unexpected test IO ${name}`);
  }]));
  const hookTransform = anchor => ({ anchor, replace: key => `const ${anchor.slice(anchor.indexOf("{"), anchor.indexOf("}") + 1)} = globalThis[${JSON.stringify(key)}].ports.hooks;` });
  const noOpSetters = ["setGeneratedMedia", "setMessageSnapshotIdentity", "setHasMoreDirectMessages", "setNextDirectBeforeMessageId", "setDirectTimelineRuns", "setDirectWorkspace", "setDirectLinkPreviews", "setPrivateAttachments", "setMcpServers", "setMcpTools", "setMcpBindings", "setActivityItems", "setLoading", "setLoadingOlderDirectMessages", "setPendingAttachments", "setPendingDirectLinkPreviewIds", "setSending", "setDirectGuidanceSubmitting", "setDirectGuidanceCancelingId", "setDirectGuidancePromotingId"];
  // Retain the actual workspace callback bodies unchanged. Replace only its
  // unrelated UI/controller setup with explicit hook/IO ports. Full component
  // composition and timer wiring remain a separate packaged/browser check.
  const replacement = key => `export function TeammateWorkspace({ cwd, teammate }) {
    const p = globalThis[${JSON.stringify(key)}].ports;
    const { lifecycle: directSendLifecycle, memoryController, privateAttachmentUploads } = p;
    ${source.includes("const observationReads = useTeammateObservationReads(cwd);") ? "const observationReads = useTeammateObservationReads(cwd);" : ""}
    const workspaceRequestOwner = useTeammateWorkspaceRequestOwner(cwd, teammate.id);
    const [messages, applyMessages] = useState([]), [directRuntime, setDirectRuntime] = useState(undefined);
    const setMessages = value => p.publishMessages(value, applyMessages);
    const [messageDraft, setMessageDraft] = useState("R03 private original");
    const onConfirmFullAccess = () => p.confirmFullAccess();
    const ${noOpSetters.join(" = () => {}, ")} = () => {};
    const skillsController = { beginSnapshotRequest: () => 1, applySnapshot: () => {} };
    const t = text => text, currentDirectRuntime = directRuntime, currentDirectWorkspace = undefined;
    const pendingDirectLinkPreviews = [], pendingAttachments = [], pendingDirectLinkPreviewIds = [], composerFileReferenceParts = [];
    const composerSubmissionInputParts = parseComposerInputParts(messageDraft);
    const privateComposerPayload = { body: messageDraft, attachmentIds: [], linkPreviewIds: [], fileRefs: [] };
    const sending = false, privateAttachmentOperationPending = false, selectedWorkspaceAccessMode = "local";
    const loadingOlderDirectMessages = false, hasMoreDirectMessages = true, nextDirectBeforeMessageId = "older", normalizedMessageSearchQuery = "";
    const scrollPrivateFeedToLatest = () => {}, privateSubmissionDraftRef = useRef(undefined);
    privateSubmissionDraftRef.current = { body: messageDraft, attachmentIds: [], pendingAttachmentCount: 0, linkPreviewIds: [], fileRefs: [] };
    const directGuidanceSubmitting = "", directGuidanceCancelingId = "", directGuidancePromotingId = "";
    ${source.slice(callbacksStart, callbacksEnd)}
    return { messages, directRuntime, messageDraft, setMessageDraft, error: workspaceRequestOwner.latestError?.message ?? "",
      refreshTeammateWorkspace, refreshTeammateConversationSnapshot, refreshDirectRuntime, refreshTeammateActivity, loadOlderDirectMessages, sendPrivateMessage, submitDirectGuidance };
  }`;
  const timelineSource = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const timelineTransforms = [hookTransform('import { useEffect, useRef, useState } from "react";')];
  for (const anchor of [
    'import { LingDaemonTransportError } from "@ling-stack/api-client";',
    'import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";',
  ]) if (timelineSource.includes(anchor)) timelineTransforms.push({ anchor, replace: key => anchor.includes("LingDaemonTransportError")
    ? `const { LingDaemonTransportError } = globalThis[${JSON.stringify(key)}].ports;`
    : `const { useDaemonObservation, isDaemonObservationPausedForWorkspace } = globalThis[${JSON.stringify(key)}].ports;` });
  const h = await catalogConsumerHarness(t, { exports: { [sourcePath]: ["TeammateWorkspace"] }, ports: {
    hooks: port.hooks, api, LingDaemonTransportError: TransportError, useDaemonObservation: () => ({ ...observation }),
    isDaemonObservationPausedForWorkspace: (value, workspace) => value.paused && value.workspaceCwd === workspace.trim(),
    lifecycle: { activeReplies: [], begin: () => { lifecycle.push("begin"); return {}; }, accept: () => lifecycle.push("accept"), settle: () => lifecycle.push("settle"),
      fail: () => { lifecycle.push("fail"); return { restoreInput: true }; }, defer: () => lifecycle.push("defer") },
    memoryController: { refresh: async () => { calls.push({ name: "memory-refresh" }); } }, privateAttachmentUploads: { releasePreviews() {} },
    journal: { read: owner => pendingKeys.get(JSON.stringify(owner)), remember: (owner, key) => pendingKeys.set(JSON.stringify(owner), key), forget: owner => pendingKeys.delete(JSON.stringify(owner)) },
    readSseResponse: async (_response, receive) => streamRead?.(receive),
    confirmFullAccess: () => confirmFullAccess?.(),
    hasPendingPrivateGuidance: () => privateGuidancePending,
    submitPrivateGuidance: async () => { calls.push({ name: "submitPrivateGuidance" }); throw new Error("synthetic guidance transport reached"); },
    publishMessages: (value, apply) => { if (holdMessageUpdates) messageUpdates.push(() => apply(value)); else apply(value); },
  }, transforms: {
    [sourcePath]: [
      { anchor: source.slice(componentStart, componentEnd), replace: replacement },
      { anchor: 'import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type UIEvent } from "react";', replace: key => `const { useEffect, useMemo, useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
      { anchor: apiImport, replace: key => `const { ${apiNames.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
      { anchor: 'import { readSseResponse } from "../../sse.js";', replace: key => `const { readSseResponse } = globalThis[${JSON.stringify(key)}].ports;` },
      { anchor: 'import { submissionLookupJournal } from "../../shared/conversation/conversation-submission-journal.js";', replace: key => `const submissionLookupJournal = globalThis[${JSON.stringify(key)}].ports.journal;` },
      { anchor: 'import { hasPendingPrivateGuidance, submitPrivateGuidance } from "./teammate-private-guidance.js";', replace: key => `const { hasPendingPrivateGuidance, submitPrivateGuidance } = globalThis[${JSON.stringify(key)}].ports;` },
    ],
    [path]: timelineTransforms,
    "features/teammates/useTeammateAsyncRequestOwner.ts": [hookTransform('import { useReducer, useRef } from "react";')],
  } });
  const input = { cwd, teammate: { id: "engineer", providerPresetId: "qa-provider" } };
  const render = () => port.render(h.module.TeammateWorkspace, input);
  render(); t.after(() => port.unmount());
  return { calls, lifecycle, pendingKeys, render,
    pause() { Object.assign(observation, { paused: true, epoch: observation.epoch + 1 }); render(); },
    resume() { Object.assign(observation, { paused: false, epoch: observation.epoch + 1 }); render(); },
    holdMessageUpdates() { holdMessageUpdates = true; },
    flushMessageUpdates() { holdMessageUpdates = false; messageUpdates.splice(0).forEach(apply => apply()); },
    setDraft(value) { render().setMessageDraft(value); render(); },
    setApi(name, value) { apiOverrides.set(name, value); },
    setConfirmFullAccess(value) { confirmFullAccess = value; },
    setGuidancePending(value) { privateGuidancePending = value; },
    setActiveReply() { h.state.ports.lifecycle.activeReplies = [{ workUnitId: "accepted-parent" }]; },
    rememberPending(key) { pendingKeys.set(JSON.stringify({ cwd, surface: "private", ownerId: "engineer" }), key); },
    setRead(value) { readOverride = value; }, setStream(value) { streamRead = value; },
    send: () => render().sendPrivateMessage({ authorizationMode: "manual", permissionPreset: "read_only" }),
  };
}

test("all private workspace transcript/runtime/activity/history reads are gated while the owned Host is paused", async t => {
  const f = await workspaceFixture(t, true);
  for (const name of ["refreshTeammateWorkspace", "refreshTeammateConversationSnapshot", "refreshDirectRuntime", "refreshTeammateActivity", "loadOlderDirectMessages"]) await f.render()[name]();
  assert.deepEqual(f.calls, []);
});

test("private workspace read commits are fenced by the Host epoch and typed transport is not a false runtime failure", async t => {
  const f = await workspaceFixture(t), pending = deferred(); f.setRead(() => pending.promise);
  const read = f.render().refreshDirectRuntime(); f.pause(); pending.resolve(response("old-epoch"));
  assert.equal(await read, "stale"); assert.equal(f.render().directRuntime, undefined);
  const business = await workspaceFixture(t), denied = deferred(); business.setRead(() => denied.promise);
  const deniedRead = business.render().refreshTeammateConversationSnapshot(); business.pause(); denied.reject(new Error("HTTP 403: denied"));
  await deniedRead; assert.equal(business.render().error, "HTTP 403: denied");
});

test("accepted private stream loss during Host drain does not refresh, replay or fail the accepted reply", async t => {
  const f = await workspaceFixture(t);
  f.setStream(receive => { receive({ event: "accepted", data: JSON.stringify({ message: { id: "accepted-user", body: "qa" } }) }); f.pause(); throw new TransportError("Failed to fetch"); });
  await f.send();
  assert.deepEqual(f.calls.map(call => call.name), ["streamTeammateDirectMessage"]);
  assert.equal(f.pendingKeys.size, 0); assert.ok(f.lifecycle.includes("accept")); assert.equal(f.lifecycle.includes("fail"), false);
  assert.equal(f.render().messages[0].id, "accepted-user"); assert.equal(f.render().error, "");
});

test("unconfirmed private submission remains journaled during Host drain without a new receipt read or resend", async t => {
  const f = await workspaceFixture(t);
  f.setStream(() => { f.pause(); throw new TransportError("Failed to fetch"); });
  await f.send();
  assert.deepEqual(f.calls.map(call => call.name), ["streamTeammateDirectMessage"]);
  assert.equal(f.pendingKeys.size, 1); assert.ok(f.lifecycle.includes("defer")); assert.equal(f.lifecycle.includes("fail"), false);
  assert.equal(f.render().error, "Pending confirmation");
});

test("private send admission rejects both initially paused and captured-before-pause callbacks without clearing the draft", async t => {
  for (const initiallyPaused of [true, false]) {
    const f = await workspaceFixture(t, initiallyPaused);
    const send = f.render().sendPrivateMessage;
    if (!initiallyPaused) f.pause();
    await send({ authorizationMode: "manual", permissionPreset: "read_only" });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.lifecycle, []);
    assert.equal(f.pendingKeys.size, 0);
    assert.equal(f.render().messageDraft, "R03 private original");
  }
});

test("private full-access confirmation cannot admit a new submission after the Host pauses", async t => {
  const f = await workspaceFixture(t), confirmation = deferred();
  f.setConfirmFullAccess(() => confirmation.promise);
  const send = f.render().sendPrivateMessage({ authorizationMode: "manual", permissionPreset: "full_access" });
  f.pause(); confirmation.resolve({ confirmed: true });
  await send;
  assert.deepEqual(f.calls, []);
  assert.equal(f.pendingKeys.size, 0);
  assert.equal(f.render().messageDraft, "R03 private original");
});

test("private link preview preparation stops at the pause fence and cannot reach another preview or message POST", async t => {
  const f = await workspaceFixture(t);
  f.setDraft("Inspect https://one.example/test and https://two.example/test");
  f.setApi("createTeammateDirectLinkPreview", async (_cwd, _teammate, { url }) => {
    f.pause();
    return { linkPreview: { id: "first-preview", url, normalizedUrl: url } };
  });
  await f.send();
  assert.deepEqual(f.calls.map(call => call.name), ["createTeammateDirectLinkPreview"]);
  assert.equal(f.pendingKeys.size, 0);
  assert.equal(f.render().messageDraft, "Inspect https://one.example/test and https://two.example/test");
  assert.equal(f.lifecycle.includes("fail"), false);
});

const streamUser = { id: "accepted-user", body: "request", createdAt: "2026-10-26T00:00:00.000Z" };
const streamReply = { id: "accepted-reply", body: "original reply", status: "pending", createdAt: "2026-10-26T00:00:01.000Z" };
const emitPrivate = (receive, event, data) => receive({ event, data: JSON.stringify(data) });

test("old private stream ready and delta cannot replace the accepted snapshot after pause and resume", async t => {
  const f = await workspaceFixture(t);
  f.setStream(receive => {
    emitPrivate(receive, "ready", { message: streamUser, aiReply: streamReply });
    f.pause(); f.resume();
    emitPrivate(receive, "ready", { message: streamUser, aiReply: { ...streamReply, body: "stale ready" } });
    emitPrivate(receive, "delta", { messageId: streamReply.id, body: "stale delta" });
  });
  await f.send();
  assert.equal(f.render().messages.find(message => message.id === streamReply.id)?.body, "original reply");
  assert.equal(f.pendingKeys.size, 0);
  assert.equal(f.lifecycle.includes("fail"), false);
  assert.deepEqual(f.calls.map(call => call.name), ["streamTeammateDirectMessage"]);
});

test("private stream functional publication rechecks the observation epoch when React applies the updater", async t => {
  const f = await workspaceFixture(t);
  f.setStream(receive => {
    emitPrivate(receive, "ready", { message: streamUser, aiReply: streamReply });
    f.holdMessageUpdates();
    emitPrivate(receive, "delta", { messageId: streamReply.id, body: "queued stale delta" });
    f.pause(); f.flushMessageUpdates();
  });
  await f.send();
  assert.equal(f.render().messages.find(message => message.id === streamReply.id)?.body, "original reply");
  assert.equal(f.lifecycle.includes("accept"), true);
  assert.equal(f.lifecycle.includes("fail"), false);
});

test("a real terminal event from an accepted private stream settles during pause without publishing an old-epoch snapshot", async t => {
  for (const terminal of ["done", "blocked"]) {
    const f = await workspaceFixture(t);
    f.setStream(receive => {
      emitPrivate(receive, "ready", { message: streamUser, aiReply: streamReply });
      f.pause();
      emitPrivate(receive, terminal, { message: streamUser, aiReply: { ...streamReply, body: "terminal fact", status: "complete" } });
    });
    await f.send();
    assert.equal(f.lifecycle.includes("settle"), true, "a Host observation pause must not erase a received terminal fact");
    assert.equal(f.lifecycle.includes("fail"), false);
    assert.equal(f.pendingKeys.size, 0);
    assert.equal(f.render().messages.find(message => message.id === streamReply.id)?.body, "original reply");
    assert.deepEqual(f.calls.map(call => call.name), ["streamTeammateDirectMessage"]);
  }
});

test("private stream business errors stay visible during pause while unconfirmed submissions remain journaled", async t => {
  for (const error of [new Error("HTTP 403: private policy denied"), new TypeError("local stream parser bug")]) {
    const f = await workspaceFixture(t);
    f.setStream(() => { f.pause(); throw error; });
    await f.send();
    assert.equal(f.render().error, error.message);
    assert.equal(f.pendingKeys.size, 1);
    assert.equal(f.lifecycle.includes("defer"), true);
    assert.equal(f.lifecycle.includes("fail"), false);
    assert.deepEqual(f.calls.map(call => call.name), ["streamTeammateDirectMessage"]);
  }
});

test("a private SSE business error is not hidden by a paused projection", async t => {
  const f = await workspaceFixture(t);
  f.setStream(receive => {
    emitPrivate(receive, "accepted", { message: streamUser });
    f.pause();
    emitPrivate(receive, "error", { error: "Host rejected the effect" });
  });
  await f.send();
  assert.equal(f.render().error, "Host rejected the effect");
  assert.equal(f.lifecycle.includes("fail"), true);
  assert.equal(f.pendingKeys.size, 0);
});

test("paused private guidance recovery cannot admit a new request", async t => {
  const f = await workspaceFixture(t, true);
  f.setGuidancePending(true);
  assert.equal(await f.render().submitDirectGuidance("queue_followup"), false);
  assert.deepEqual(f.calls, []);
});

test("private guidance rechecks admission after awaited reply and preview preparation", async t => {
  const f = await workspaceFixture(t);
  f.setActiveReply();
  const request = f.render().submitDirectGuidance("interrupt_redirect");
  await Promise.resolve();
  f.pause();
  assert.equal(await request, false);
  assert.deepEqual(f.calls, []);
});

test("private unknown receipt from before a Host pause cannot prove a business rejection or release the journal", async t => {
  const f = await workspaceFixture(t);
  f.setApi("streamTeammateDirectMessage", async () => { throw Object.assign(new Error("HTTP 403: denied"), { status: 403 }); });
  f.setApi("getTeammateDirectMessageSubmission", async (_cwd, _teammateId, key) => {
    f.pause();
    return { cwd, teammateId: "engineer", idempotencyKey: key, status: "unknown" };
  });
  await f.send();
  assert.equal(f.pendingKeys.size, 1);
  assert.equal(f.lifecycle.includes("defer"), true);
  assert.equal(f.lifecycle.includes("fail"), false);
  assert.equal(f.render().error, "HTTP 403: denied");
  assert.deepEqual(f.calls.map(call => call.name), ["streamTeammateDirectMessage", "getTeammateDirectMessageSubmission"]);
});

test("private recovery retries cannot cross a pause-resume observation epoch", async t => {
  const f = await workspaceFixture(t);
  f.rememberPending("existing-private-submission");
  f.setApi("getTeammateDirectMessageSubmission", async (_cwd, _teammateId, key) => {
    f.pause(); f.resume();
    return { cwd, teammateId: "engineer", idempotencyKey: key, status: "unknown" };
  });
  await f.send();
  assert.equal(f.pendingKeys.size, 1);
  assert.deepEqual(f.calls.map(call => call.name), ["getTeammateDirectMessageSubmission"]);
  assert.equal(f.render().error, "Pending confirmation");
});

test("a late accepted private receipt preserves acceptance and draft cleanup without old-epoch snapshot publication", async t => {
  const f = await workspaceFixture(t);
  f.rememberPending("existing-private-submission");
  f.setApi("getTeammateDirectMessageSubmission", async (_cwd, _teammateId, key) => {
    f.pause();
    return { cwd, teammateId: "engineer", idempotencyKey: key, status: "accepted", message: {
      ...streamUser, teammateId: "engineer", authorType: "local-user", authorId: "local-user", body: "R03 private original",
      attachmentIds: [], linkPreviewIds: [], fileRefs: [],
    } };
  });
  await f.send();
  assert.equal(f.pendingKeys.size, 0);
  assert.deepEqual(f.render().messages, []);
  assert.equal(f.render().messageDraft, "");
  assert.deepEqual(f.calls.map(call => call.name), ["getTeammateDirectMessageSubmission"]);
});

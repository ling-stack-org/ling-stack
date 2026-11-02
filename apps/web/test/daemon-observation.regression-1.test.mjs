import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness, React } from "./support/catalog-consumer-harness.mjs";

// Regression: R03-OBS — last-known running was presented as a live execution after Host drain.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-packaging-retry-20261026/live-findings.md
// Value: protects=scope-bound observation overlay and canonical immutability;
// fails_when=paused live labels retain realtime semantics; why_new=banner tests do not render child rows;
// seam=existing catalog/component harness; no_claim=packaged GUI or real execution.
const observationModule = "shared/conversation/observation/daemon-observation.tsx";
const baseUrl = "http://127.0.0.1:17928";
const cwd = "/isolated/r03";
const item = { kind: "commandExecution", id: "action", revision: 3, runId: "run", attemptId: "attempt",
  turnId: "turn", participantId: "engineer", threadSequence: 1, partIndex: 0, sourceRefs: [], status: "running",
  title: "Command", command: "node example.mjs", outputTail: [] };

test("only owned valid stopping status from the exact endpoint pauses a scoped observation epoch", async t => {
  const h = await catalogConsumerHarness(t, { exports: { [observationModule]: ["projectDaemonObservation", "liveDaemonObservation"] } });
  const project = status => h.module.projectDaemonObservation(h.module.liveDaemonObservation, status, baseUrl, cwd);
  for (const status of [undefined, { state: "disconnected", ownedByDesktop: true, baseUrl },
    { state: "draining", ownedByDesktop: false, baseUrl },
    { state: "draining", ownedByDesktop: true, baseUrl: `${baseUrl}/other` },
    { state: "blocked", ownedByDesktop: true, baseUrl, reason: "start_timeout" }]) assert.equal(project(status).paused, false);
  const paused = project({ state: "blocked", ownedByDesktop: true, baseUrl, reason: "stop_blocked" });
  assert.equal(paused.paused, true); assert.equal(paused.workspaceCwd, cwd);
  assert.equal(h.module.projectDaemonObservation(paused, { state: "draining", ownedByDesktop: true, baseUrl: `${baseUrl}/` }, baseUrl, cwd), paused);
  const resumed = h.module.projectDaemonObservation(paused, { state: "connected", ownedByDesktop: true, baseUrl }, baseUrl, cwd);
  assert.equal(resumed.paused, false); assert.equal(resumed.epoch, paused.epoch + 1);
});

test("shared command and thinking renderers qualify stale running without rewriting facts", async t => {
  const h = await catalogConsumerHarness(t, { exports: {
    [observationModule]: ["DaemonObservationProvider"],
    "shared/conversation/timeline/ConversationTimelineCommandRenderer.tsx": ["ConversationTimelineCommandRenderer"],
    "shared/conversation/timeline/ConversationTimelineMessageRenderer.tsx": ["ConversationTimelineMessageRenderer"],
  } });
  const observation = { paused: true, epoch: 2, workspaceCwd: cwd, baseUrl };
  const render = (Component, props) => h.render(h.module.DaemonObservationProvider, {
    value: observation, children: React.createElement(Component, props),
  });
  for (const depth of [0, 1]) {
    const before = JSON.stringify(item);
    const html = render(h.module.ConversationTimelineCommandRenderer, { item, depth });
    assert.match(html, /Stale snapshot/);
    assert.match(html, /data-activity-motion="idle"/);
    assert.match(html, /data-conversation-timeline-status="running"/);
    assert.match(html, /node example.mjs/);
    assert.equal(JSON.stringify(item), before);
    const thinking = render(h.module.ConversationTimelineMessageRenderer, {
      item: { ...item, kind: "agentMessage", markdown: "Thinking...", waitingPlaceholder: true }, depth, cwd,
    });
    assert.match(thinking, /Pending confirmation/);
    assert.doesNotMatch(thinking, /Thinking\.\.\./);
  }
  const failed = render(h.module.ConversationTimelineCommandRenderer, { item: { ...item, status: "failed" }, depth: 0 });
  assert.match(failed, /Failed/); assert.doesNotMatch(failed, /Stale snapshot/);
});

test("reader IO is typed but protocol/onMessage exceptions retain their original identity", async t => {
  const h = await catalogConsumerHarness(t, { exports: { "sse.ts": ["readSseResponse"] } });
  const cause = new TypeError("reader disconnected");
  const response = new Response(new ReadableStream({ start(controller) { controller.error(cause); } }));
  await assert.rejects(h.module.readSseResponse(response, () => {}), error =>
    error.name === "LingDaemonTransportError" && error.phase === "stream-read" && error.cause === cause);
  const business = new TypeError("onMessage rejected a payload");
  await assert.rejects(h.module.readSseResponse(new Response("event: ready\ndata: {}\n\n"), () => { throw business; }), error => error === business);
  const cancellation = new DOMException("aborted", "AbortError");
  await assert.rejects(h.module.readSseResponse(new Response(new ReadableStream({
    start(controller) { controller.error(cancellation); },
  })), () => {}), error => error === cancellation);
});

test("ordinary/private/channel timelines and nested agents share one stale observation overlay", async t => {
  const h = await catalogConsumerHarness(t, { exports: {
    [observationModule]: ["DaemonObservationProvider"],
    "shared/conversation/view-store/conversation-view-provider.tsx": ["ConversationViewProvider"],
    "shared/conversation/timeline/ConversationTimeline.tsx": ["ConversationTimeline"],
  } });
  for (const kind of ["normal", "private", "channel_root", "topic", "branch"]) {
    const snapshot = { scope: { kind, threadId: `thread-${kind}`, parentThreadId: null, anchorItemId: null, depth: 0 }, canonicalRevision: 3, sseCursor: "42", activeRun: null,
      contextSegmentIdByItemId: new Map(), runLifecycles: new Map(), items: [{ ...item, kind: "subAgentActivity", id: "child",
        label: "Engineer", lifecycle: "running", childItems: [{ ...item, id: "child-command" }] }] };
    const before = JSON.stringify(snapshot);
    const html = h.render(h.module.DaemonObservationProvider, {
      value: { paused: true, epoch: 2, workspaceCwd: cwd, baseUrl }, children: React.createElement(h.module.ConversationViewProvider,
        { surfaceId: kind }, React.createElement(h.module.ConversationTimeline, { snapshot, depth: 0, cwd })),
    });
    assert.match(html, /data-daemon-observation="paused"/);
    assert.match(html, /aria-busy="false"/);
    assert.doesNotMatch(html, /aria-busy="true"/);
    assert.match(html, /Stale snapshot/);
    assert.match(html, /data-conversation-timeline-depth="1"/);
    assert.equal(JSON.stringify(snapshot), before);
  }
});

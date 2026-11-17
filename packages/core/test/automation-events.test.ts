import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { automationEventDigest, createSqliteRunStore, DEFAULT_WORKSPACE_ID, parseAutomationEventSource,
  type AutomationEventSource, type RunStore } from "../dist/index.js";

const now = "2026-11-16T00:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-event-store-"));
  const store = createSqliteRunStore(cwd); t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "automation", title: "Event fixture", objective: "Handle events" }, now);
  const definition = store.createAutomationDefinition({ threadId: thread.id, title: "Event fixture", kind: "custom_prompt", trigger: { type: "manual" },
    target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd }, promptTemplate: { templateVersion: 1, promptMarkdown: "Handle the supplied event", contextSelectors: [] },
    executionPolicy: {}, outputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" } }, now);
  const source = store.putAutomationEventSource({ id: "test-source", label: "Issues", adapter: "business", enabled: true, secretRefs: ["env:EVENT_SECRET"],
    rules: [{ automationId: definition.id, types: ["alert.opened"], predicates: [{ path: "priority", equals: "high" }], destinationIds: ["im_test"] }] }, undefined, now);
  const event = (id: string, payload: Record<string, unknown> = { priority: "high" }) => ({ sourceId: source.id, externalId: id,
    type: "alert.opened", occurredAt: now, payload, payloadDigest: automationEventDigest({ id, payload }) });
  return { cwd, store, source, definition, event };
}
function updateSource(store: RunStore, source: AutomationEventSource, enabled: boolean) {
  const { revision, createdAt: _created, updatedAt: _updated, ...input } = source;
  return store.putAutomationEventSource({ ...input, enabled }, revision, later(1));
}

test("an event and its matching work are atomic, deduplicated and revision bound", async t => {
  const f = await fixture(t);
  const first = f.store.acceptAutomationEvent(f.event("one"), f.source.revision, now);
  assert.equal(first.duplicate, false);
  assert.equal(f.store.acceptAutomationEvent(f.event("one"), f.source.revision, now).event.id, first.event.id);
  assert.equal(f.store.listAutomationEventDispatches().length, 1);
  assert.throws(() => f.store.acceptAutomationEvent(f.event("one", { priority: "other" }), f.source.revision, now), /digest_conflict/);
  f.store.acceptAutomationEvent(f.event("not-matched", { priority: "low" }), f.source.revision, now);
  assert.equal(f.store.listAutomationEventDispatches().length, 1);
  updateSource(f.store, f.source, false);
  assert.throws(() => f.store.acceptAutomationEvent(f.event("revoked"), f.source.revision, later(1)), /source_revoked/);
  assert.equal(f.store.listAutomationEvents().length, 2);
});

test("source updates require the current revision and reject raw secrets or executable predicates", async t => {
  const f = await fixture(t);
  const { revision, createdAt: _created, updatedAt: _updated, ...input } = f.source;
  assert.throws(() => f.store.putAutomationEventSource(input, revision + 1, now), /revision_conflict/);
  for (const patch of [{ secretRefs: ["raw-secret"] }, { secretRefs: [] }, { rules: [{ automationId: f.definition.id, types: ["x"], predicates: [{ path: "constructor.x", equals: 1 }] }] },
    { rules: [{ automationId: f.definition.id, types: [".*"] }] }]) assert.throws(() => parseAutomationEventSource({ ...input, ...patch }));
  f.store.updateAutomationDefinition(f.definition.id, { status: "disabled" }, now);
  f.store.acceptAutomationEvent(f.event("disabled"), revision, now);
  assert.deepEqual(f.store.listAutomationEventDispatches(), []);
});

test("claims survive reopen, exclude competitors and reject stale lease completion", async t => {
  const f = await fixture(t);
  f.store.acceptAutomationEvent(f.event("one"), f.source.revision, now);
  const first = f.store.claimAutomationEventDispatch(now); assert.ok(first?.leaseToken);
  const other = createSqliteRunStore(f.cwd); t.after(() => other.close());
  assert.equal(other.claimAutomationEventDispatch(later(1)), undefined);
  const reclaimed = other.claimAutomationEventDispatch(later(61)); assert.ok(reclaimed?.leaseToken);
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  assert.equal(f.store.finishAutomationEventDispatch(first.id, first.leaseToken, { status: "failed" }, later(61)), false);
  assert.equal(other.finishAutomationEventDispatch(reclaimed.id, reclaimed.leaseToken, { status: "failed", error: "fixture" }, later(61)), true);
});

test("event rate limits do not reject duplicate receipts or partially reserve new work", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 100; i++) f.store.acceptAutomationEvent(f.event(`event-${i}`), f.source.revision, now);
  assert.equal(f.store.acceptAutomationEvent(f.event("event-0"), f.source.revision, now).duplicate, true);
  assert.throws(() => f.store.acceptAutomationEvent(f.event("overflow"), f.source.revision, now), /rate_limit/);
  assert.equal(f.store.listAutomationEventDispatches(500).length, 100);
  assert.equal(f.store.listAutomationEvents().length, 100);
});

test("inbox capacity counts only eligible matching dispatches", async t => {
  const f = await fixture(t);
  const definitions = [f.definition];
  for (let i = 1; i < 32; i++) definitions.push(f.store.createAutomationDefinition({
    threadId: f.definition.threadId, title: `Event fixture ${i}`, kind: "custom_prompt", trigger: { type: "manual" },
    target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd: f.cwd }, promptTemplate: { templateVersion: 1,
      promptMarkdown: "Handle the supplied event", contextSelectors: [] }, executionPolicy: {},
    outputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
  }, now));
  const allRules = definitions.map(definition => ({ automationId: definition.id, types: ["alert.opened"],
    predicates: [{ path: "priority", equals: "high" }], destinationIds: ["im_test"] }));
  const { revision: originalRevision, createdAt: _created, updatedAt: _updated, ...sourceInput } = f.source;
  const expanded = f.store.putAutomationEventSource({ ...sourceInput, rules: allRules }, originalRevision, later(1));
  for (let i = 0; i < 156; i++) {
    const id = `queued-${i}`, receivedAt = later(61 + i * 61), payload = { priority: "high" };
    f.store.acceptAutomationEvent({ sourceId: expanded.id, externalId: id, type: "alert.opened", occurredAt: now,
      payload, payloadDigest: automationEventDigest({ id, payload }) }, expanded.revision, receivedAt);
  }
  const selectiveRules = allRules.map((rule, index) => ({ ...rule, types: [index === 0 ? "alert.opened" : "issue.opened"] }));
  const selective = f.store.putAutomationEventSource({ ...sourceInput, rules: selectiveRules }, expanded.revision, later(61 + 156 * 61));
  const id = "eligible-after-capacity", payload = { priority: "high" }, receivedAt = later(61 + 157 * 61);
  const accepted = f.store.acceptAutomationEvent({ sourceId: selective.id, externalId: id, type: "alert.opened", occurredAt: now,
    payload, payloadDigest: automationEventDigest({ id, payload }) }, selective.revision, receivedAt);
  assert.equal(accepted.duplicate, false);
  assert.equal(f.store.listAutomationEventDispatches().find(dispatch => dispatch.eventId === accepted.event.id)?.automationId, definitions[0].id);
});

test("delivery materialization is idempotent and an interrupted send remains unknown until reconciled", async t => {
  const f = await fixture(t);
  f.store.acceptAutomationEvent(f.event("one"), f.source.revision, now);
  const job = f.store.claimAutomationEventDispatch(now); assert.ok(job?.leaseToken);
  const run = f.store.createRun({ id: "event-run", cwd: f.cwd, taskId: "event-task", providerName: "fixture", providerModel: "fixture", createdAt: now,
    taskSnapshot: { id: "event-task", title: "Event task", prompt: "Handle event" }, providerSnapshot: {}, requestSnapshot: {} });
  f.store.markRunStarted(run.id, now); f.store.appendEvent(run.id, "message_end", { role: "assistant", text: "Verified result" }, now);
  f.store.markRunSucceeded(run.id, now);
  const automationRun = f.store.createAutomationRun({ automationId: f.definition.id, threadId: f.definition.threadId,
    runId: run.id, triggerType: "event", status: "succeeded", idempotencyKey: "event-one" }, now);
  assert.equal(f.store.finishAutomationEventDispatch(job.id, job.leaseToken, { status: "linked", automationRunId: automationRun.id }, now), true);
  f.store.reconcileAutomationDeliveries(now); f.store.reconcileAutomationDeliveries(now);
  assert.equal(f.store.listAutomationDeliveries().length, 1); assert.equal(f.store.getAutomationRunResultText(run.id), "Verified result");
  const sending = f.store.claimAutomationDelivery(now); assert.ok(sending?.leaseToken);
  f.store.reconcileAutomationDeliveries(later(31));
  const unknown = f.store.listAutomationDeliveries()[0]; assert.equal(unknown.status, "unknown");
  assert.equal(f.store.claimAutomationDelivery(later(32)), undefined);
  assert.equal(f.store.settleAutomationDelivery(sending.id, sending.leaseToken, { status: "delivered", receipt: "late" }, later(32)), false);
  assert.throws(() => f.store.reconcileAutomationDelivery(unknown.id, "stale", "retry", "Checked receiver", later(33)), /conflict/);
  const retry = f.store.reconcileAutomationDelivery(unknown.id, unknown.updatedAt, "retry", "Receiver confirms no message", later(33));
  assert.equal(retry.status, "queued");
  const next = f.store.claimAutomationDelivery(later(33)); assert.ok(next?.leaseToken);
  assert.equal(f.store.settleAutomationDelivery(next.id, next.leaseToken, { status: "delivered", receipt: "http:200" }, later(34)), true);
  assert.equal(f.store.claimAutomationDelivery(later(35)), undefined);
});

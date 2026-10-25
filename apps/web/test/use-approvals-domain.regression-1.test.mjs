import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";
import { createApprovalDecisionLookupJournal } from "../src/lib/approval-decision-lookup-journal.ts";
import { approvalReceiptRecoveryState, approvalRecoveryNotice } from "../src/lib/approval-recovery.ts";

// Regression: R6 — durable decisions lost their observation pointer before recovery completed.
// Found by /qa on 2026-10-25
// Report: output/e6-20260928/p3-current-checkpoint-20261025.md
// Value: protects=GET-only approval recovery through completion; fails_when=deferred pointers are forgotten;
// why_new=journal tests do not exercise the real domain controller; seam=existing test IO/hook ports;
// no_claim=mocked API and deterministic hooks are not packaged GUI or Host execution evidence.
const cwd = "/isolated/approval-recovery";
const scope = { cwd, daemonBaseUrl: "http://127.0.0.1:17928" };
const approval = { id: "approval-qa", runId: "run-qa", status: "approved", actionType: "bash", risk: "low",
  title: "QA command", description: "Synthetic", payload: {}, createdAt: "2026-10-25T00:00:00Z" };
const deferredResponse = { approval, postCommit: { status: "deferred", code: "approval_postcommit_reconciliation_required" } };
const receipt = (status = "pending", overrides = {}) => ({ approval, postCommitEffects: ["decision_event", "owner", "control_plane_event"]
  .map(effectKind => ({ approvalId: approval.id, effectKind, status: effectKind === "owner" ? status : "completed", revision: 1,
    attempts: 1, updatedAt: "2026-10-25T00:00:00Z" })), ...overrides });

async function fixture(t, options = {}) {
  const entries = new Map(), timers = new Map(), calls = [], events = [];
  let timerId = 0, response = receipt(), getFailure, pendingGet;
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key), key: i => [...entries.keys()][i] ?? null, get length() { return entries.size; } };
  const journal = createApprovalDecisionLookupJournal(storage);
  const port = catalogHookPort();
  const apiNames = ["approveApproval", "cancelExternalWorkAction", "denyApproval", "executeExternalWorkAction", "getApproval", "getExternalWorkAction", "listApprovals"];
  const api = Object.fromEntries(apiNames.map(name => [name, async (...args) => {
    calls.push({ name, args });
    if (name === "listApprovals") return { cwd: args[0], approvals: [response.approval] };
    if (name === "getApproval") { if (pendingGet) return pendingGet; if (getFailure) throw getFailure; return response; }
    if (name === "approveApproval" || name === "denyApproval") {
      if (options.postError) throw options.postError;
      return options.mutation ?? deferredResponse;
    }
    throw new Error(`unexpected QA IO: ${name}`);
  }]));
  const h = await catalogConsumerHarness(t, { exports: { "domains/approvals/use-approvals-domain.ts": ["useApprovalsDomain"] },
    ports: { hooks: port.hooks, api, journal }, transforms: { "domains/approvals/use-approvals-domain.ts": [
      { anchor: 'import { useEffect, useReducer, useRef, useState } from "react";',
        replace: key => `const { useEffect, useReducer, useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
      { anchor: `import {\n${apiNames.map(name => `  ${name},`).join("\n")}\n} from "../../api.js";`,
        replace: key => `const { ${apiNames.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
      { anchor: 'import { daemonBaseUrl } from "../../api/client.js";', replace: () => `const daemonBaseUrl = ${JSON.stringify(scope.daemonBaseUrl)};` },
      { anchor: 'import { approvalDecisionLookupJournal } from "../../lib/approval-decision-lookup-journal.js";',
        replace: key => `const approvalDecisionLookupJournal = globalThis[${JSON.stringify(key)}].ports.journal;` },
    ] } });
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  } });
  t.after(() => { port.unmount(); if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else delete globalThis.window; });
  let input = { cwd, emitEvent: async event => { events.push(event); } };
  const render = () => port.render(h.module.useApprovalsDomain, input);
  render(); await port.flush();
  return { calls, events, timers, journal, render, port,
    setReceipt(value) { response = value; getFailure = undefined; pendingGet = undefined; },
    failGet(error) { getFailure = error; },
    pauseGet(promise) { pendingGet = promise; },
    async switchCwd(value) { input = { ...input, cwd: value }; render(); await port.flush(); },
    async tick() { assert.equal(timers.size, 1, "one workspace recovery timer"); const [id, task] = timers.entries().next().value;
      timers.delete(id); await task.callback(); await port.flush(); },
  };
}
const states = f => f.events.filter(e => e.type === "approval.recoveryChanged").map(e => e.recoveryState);

test("deferred decisions retain their pointer until a complete receipt; no second approval is sent", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  assert.equal(f.journal.read(scope).length, 1);
  assert.deepEqual(states(f), ["pending"]);
  await f.render().actions.refreshApprovals();
  assert.equal(f.journal.read(scope).length, 1);
  f.setReceipt(receipt("completed"));
  await f.render().actions.refreshApprovals();
  assert.deepEqual(states(f), ["pending", "completed"]);
  assert.deepEqual(f.journal.read(scope), []);
  await f.render().actions.refreshApprovals();
  assert.deepEqual(states(f), ["pending", "completed"], "no duplicate completed notifications");
  assert.equal(f.calls.filter(c => c.name === "approveApproval").length, 1);
});

test("lost POST response and still-pending approval remain queryable; refresh never authorizes again", async t => {
  const f = await fixture(t, { postError: new Error("Synthetic response loss") });
  f.setReceipt(receipt("pending", { approval: { ...approval, status: "pending" } }));
  await f.render().actions.resolveApproval(approval.id, "approve");
  await f.render().actions.refreshApprovals();
  assert.equal(f.journal.read(scope).length, 1);
  assert.equal(states(f).includes("completed"), false);
  f.setReceipt(receipt("completed"));
  await f.render().actions.refreshApprovals();
  assert.equal(states(f).at(-1), "completed");
  assert.equal(f.calls.filter(c => c.name === "approveApproval").length, 1);
});

test("GET failure, missing effects and wrong-owner effects never erase a durable lookup", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  f.failGet(new Error("Synthetic offline"));
  await f.render().actions.refreshApprovals();
  assert.equal(f.journal.read(scope).length, 1);
  assert.equal(states(f).at(-1), "unknown");
  for (const bad of [receipt("completed", { postCommitEffects: undefined }), receipt("completed", {
    postCommitEffects: [{ approvalId: "foreign", effectKind: "owner", status: "completed" }],
  })]) {
    f.setReceipt(bad);
    await f.render().actions.refreshApprovals();
    assert.equal(f.journal.read(scope).length, 1);
    assert.equal(states(f).at(-1), "unknown");
  }
  assert.equal(states(f).filter(s => s === "unknown").length, 1, "same unresolved state does not flood toasts");
});

test("blocked and effect-unknown receipts stay unresolved and can later complete by GET only", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  for (const status of ["blocked", "effect_unknown", "pending", "completed"]) {
    f.setReceipt(receipt(status));
    await f.render().actions.refreshApprovals();
    assert.equal(f.journal.read(scope).length, status === "completed" ? 0 : 1);
  }
  assert.deepEqual(states(f), ["pending", "blocked", "unknown", "pending", "completed"]);
  assert.equal(f.calls.filter(c => c.name === "approveApproval").length, 1);
});

test("a single owned timer observes completion even without another SSE/list refresh", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve_command_rule", undefined, "qa-fingerprint");
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.timers.size, 1);
  f.setReceipt(receipt("completed"));
  await f.tick();
  assert.deepEqual(f.journal.read(scope), []);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls.filter(c => c.name === "approveApproval")[0].args,
    [cwd, approval.id, { reason: undefined, decisionKind: "approve_command_rule", proposedRuleFingerprint: "qa-fingerprint" }]);
});

test("workspace change fences a delayed receipt and stops the old workspace timer", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  let resolve;
  f.pauseGet(new Promise(done => { resolve = done; }));
  const old = f.render().actions.refreshApprovals();
  await f.port.flush();
  await f.switchCwd("/isolated/other");
  resolve(receipt("completed"));
  await old;
  assert.equal(f.journal.read(scope).length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(states(f).includes("completed"), false);
});

test("unmount cancels observation, preserves durable pointers and never resends a decision", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  assert.equal(f.timers.size, 1);
  f.port.unmount();
  assert.equal(f.timers.size, 0);
  assert.equal(f.journal.read(scope).length, 1);
  assert.equal(f.calls.filter(c => c.name === "approveApproval").length, 1);
});

test("an immediately reconciled deny forgets the lookup and preserves the deny route", async t => {
  const denied = { ...approval, status: "denied" };
  const f = await fixture(t, { mutation: { approval: denied } });
  await f.render().actions.resolveApproval(approval.id, "deny", "QA denied");
  assert.deepEqual(f.journal.read(scope), []);
  assert.deepEqual(states(f), ["completed"]);
  assert.deepEqual(f.calls.filter(c => c.name === "denyApproval")[0].args, [cwd, approval.id, "QA denied"]);
  assert.equal(f.timers.size, 0);
});

test("completion carries receipt-owned refresh targets without emitting recursive resolution", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  f.setReceipt(receipt("completed", { approval: { ...approval, mediaJobId: "media-qa", externalWorkActionId: "external-qa", channelId: "channel-qa" } }));
  await f.render().actions.refreshApprovals();
  assert.deepEqual(f.events.find(e => e.type === "approval.recoveryChanged" && e.recoveryState === "completed"), {
    type: "approval.recoveryChanged", cwd, approvalId: approval.id, recoveryState: "completed",
    runId: approval.runId, mediaJobId: "media-qa", externalWorkActionId: "external-qa", channelId: "channel-qa",
  });
  assert.equal(f.events.filter(e => e.type === "approval.resolved").length, 1);
  assert.equal(f.timers.size, 0, "completed receipt cancels the now-unnecessary timer");
});

test("timer and list refresh share an in-flight GET and discard its stale response", async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  let resolve;
  f.pauseGet(new Promise(done => { resolve = done; }));
  const tick = f.tick();
  await f.port.flush();
  await f.render().actions.refreshApprovals();
  assert.equal(f.calls.filter(c => c.name === "getApproval").length, 1);
  resolve(receipt("completed"));
  await tick;
  assert.equal(f.journal.read(scope).length, 1, "superseded list generation cannot clear the pointer");
  f.setReceipt(receipt("completed"));
  await f.tick();
  assert.deepEqual(f.journal.read(scope), []);
  assert.equal(f.calls.filter(c => c.name === "approveApproval").length, 1);
});

for (const failure of [false, true]) test(`unmount fences an in-flight recovery ${failure ? "failure" : "success"}`, async t => {
  const f = await fixture(t);
  await f.render().actions.resolveApproval(approval.id, "approve");
  let settle;
  f.pauseGet(new Promise((resolve, reject) => { settle = failure ? reject : resolve; }));
  const tick = f.tick();
  await f.port.flush();
  const before = f.events.length;
  f.port.unmount();
  settle(failure ? new Error("Synthetic disconnect after unmount") : receipt("completed"));
  await tick;
  assert.equal(f.events.length, before);
  assert.equal(f.timers.size, 0);
  assert.equal(f.journal.read(scope).length, 1);
});

test("reopening a durable journal recovers by GET only without a new decision", async t => {
  const f = await fixture(t);
  f.journal.remember(scope, { approvalId: approval.id, token: "from-previous-mount" });
  await f.render().actions.refreshApprovals();
  assert.deepEqual(states(f), ["pending"]);
  f.setReceipt(receipt("completed"));
  await f.tick();
  assert.deepEqual(states(f), ["pending", "completed"]);
  assert.deepEqual(f.journal.read(scope), []);
  assert.equal(f.calls.some(c => ["approveApproval", "denyApproval"].includes(c.name)), false);
});

test("a lost POST response uses the exact GET recovery state, not a synthetic pending state", async t => {
  for (const [status, expected] of [["blocked", "blocked"], ["effect_unknown", "unknown"]]) {
    await t.test(status, async t => {
      const f = await fixture(t, { postError: new Error("Synthetic response loss") });
      f.setReceipt(receipt(status));
      await f.render().actions.resolveApproval(approval.id, "approve");
      assert.deepEqual(states(f), [expected]);
      assert.equal(f.journal.read(scope).length, 1);
    });
  }
});

test("receipt classification rejects invalid effects and notices distinguish pending from failure", () => {
  for (const effects of [undefined, null, [{ approvalId: approval.id, effectKind: "other", status: "completed" }],
    [...receipt("completed").postCommitEffects, receipt("completed").postCommitEffects[0]],
    [{ approvalId: approval.id, effectKind: "owner", status: "other" }]]) {
    assert.equal(approvalReceiptRecoveryState(receipt("completed", { postCommitEffects: effects })), "unknown");
  }
  assert.equal(approvalReceiptRecoveryState(receipt("completed", { postCommitEffects: [] })), "completed");
  assert.equal(approvalRecoveryNotice("pending").tone, "info");
  assert.equal(approvalRecoveryNotice("blocked").tone, "warning");
  assert.equal(approvalRecoveryNotice("unknown").tone, "warning");
  assert.equal(approvalRecoveryNotice("completed"), undefined);
});

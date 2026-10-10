import assert from "node:assert/strict";
import test from "node:test";
import { createHumanQaController, canSubmitHumanQa, validHumanQaRationale } from "../src/features/settings/human-qa/human-qa-controller.ts";
import { qaCwd, qaRow, qaSnapshot, qaEvent, qaReport, qaCapability, deferred } from "./human-qa-fixtures.mjs";

test("collapsed QA does not read; missing capability never mutates or reads normal runs", async () => {
  let reads = 0;
  const controller = createHumanQaController(qaCapability({ list: async () => { reads++; return { accepted: true, canonicalWorkspaceCwd: qaCwd, items: [] }; } }), qaCwd);
  await controller.refresh(); await controller.loadMore();
  assert.equal(reads, 0);
  await controller.activate();
  assert.equal(reads, 1);
  const unavailable = createHumanQaController(undefined, qaCwd);
  await unavailable.activate();
  assert.equal(unavailable.getSnapshot().phase, "unavailable");
});

test("QA pages append terminal tasks, stop at end and reject duplicate/nonadvancing or foreign scope", async () => {
  const calls = [];
  const controller = createHumanQaController(qaCapability({ list: async request => {
    calls.push(request);
    return { accepted: true, canonicalWorkspaceCwd: qaCwd, items: [qaRow(calls.length === 1 ? "a" : "b")],
      ...(calls.length === 1 ? { nextAfterEnrollmentId: "enrolled:a" } : {}) };
  } }), qaCwd);
  await controller.activate(); await controller.loadMore(); await controller.loadMore();
  assert.deepEqual(calls, [{ limit: 25 }, { limit: 25, afterEnrollmentId: "enrolled:a" }]);
  assert.deepEqual(controller.getSnapshot().items.map(row => row.taskId), ["a", "b"]);
  for (const result of [
    { canonicalWorkspaceCwd: "/foreign", items: [qaRow()] },
    { canonicalWorkspaceCwd: qaCwd, items: [], nextAfterEnrollmentId: "foreign" },
    { canonicalWorkspaceCwd: qaCwd, items: [qaRow(), qaRow()] },
    { canonicalWorkspaceCwd: qaCwd, items: [qaRow()], nextAfterEnrollmentId: "foreign" },
  ]) {
    const bad = createHumanQaController(qaCapability({ list: async () => ({ accepted: true, ...result }) }), qaCwd);
    await bad.activate();
    assert.equal(bad.getSnapshot().phase, "error");
    assert.deepEqual(bad.getSnapshot().items, []);
  }
});

test("only the Host-verified configured alias or canonical path can show the fixed QA workspace", async () => {
  for (const cwd of ["/var/qa", "/private/var/qa", "/foreign"]) {
    const controller = createHumanQaController(qaCapability({ list: async () => ({ accepted: true,
      workspaceCwd: "/var/qa", canonicalWorkspaceCwd: "/private/var/qa", items: [qaRow()] }) }), cwd);
    await controller.activate();
    assert.equal(controller.getSnapshot().phase, cwd === "/foreign" ? "error" : "ready");
    assert.equal(controller.getSnapshot().items.length, cwd === "/foreign" ? 0 : 1);
  }
});

test("suspension/capability replacement erases old data and suppresses late success or raw errors", async () => {
  for (const success of [true, false]) {
    const read = deferred();
    const controller = createHumanQaController(qaCapability({ list: () => read.promise }), qaCwd);
    const pending = controller.activate(); controller.suspend();
    success ? read.resolve({ accepted: true, canonicalWorkspaceCwd: qaCwd, items: [qaRow()] }) : read.reject(new Error("PRIVATE_SECRET"));
    await pending;
    assert.deepEqual(controller.getSnapshot(), { phase: "idle", items: [] });
  }
});

test("selection inspects exact enrolled task before enabling feedback and ignores foreign events", async () => {
  const read = deferred();
  let submits = 0;
  const controller = createHumanQaController(qaCapability({ inspect: () => read.promise, submit: async () => { submits++; } }), qaCwd);
  await controller.activate();
  const selection = controller.select("task");
  await controller.submit({ kind: "adjudicate", decision: { verdict: "pass", rationale: "QA" } });
  assert.equal(submits, 0); assert.equal(canSubmitHumanQa(controller.getSnapshot()), false);
  read.resolve(qaSnapshot([qaEvent(1, "adjudicate", "foreign")])); await selection;
  assert.equal(controller.getSnapshot().issue, "invalid_response");
  assert.equal(canSubmitHumanQa(controller.getSnapshot()), false);
});

test("duplicate native submit is prevented and cancellation uses only the exact active request", async () => {
  const result = deferred(); const submits = [], cancels = [];
  const controller = createHumanQaController(qaCapability({ submit: request => { submits.push(request); return result.promise; },
    cancel: async id => { cancels.push(id); return { accepted: true }; } }), qaCwd, () => "request:one");
  await controller.activate(); await controller.select("task");
  const submission = { kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } };
  const first = controller.submit(submission); await controller.submit(submission); await controller.cancel();
  assert.equal(submits.length, 1); assert.deepEqual(cancels, ["request:one"]);
  result.resolve({ accepted: false, reason: "cancelled" }); await first;
  await controller.cancel(); assert.equal(cancels.length, 1);
});

test("unknown response performs readback once, never resubmits, and unrelated none does not clear uncertainty", async () => {
  let submits = 0, reads = 0;
  const controller = createHumanQaController(qaCapability({ inspect: async () => { reads++; return qaSnapshot(); },
    submit: async () => { submits++; return { accepted: false, reason: "submission_unknown" }; } }), qaCwd, () => "request:one");
  await controller.activate(); await controller.select("task");
  const submission = { kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } };
  await controller.submit(submission); await controller.submit(submission); await controller.inspect();
  assert.equal(submits, 1); assert.equal(reads, 3);
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown");
  await controller.select("task");
  assert.equal(canSubmitHumanQa(controller.getSnapshot()), false, "selection cannot drop unresolved request");
});

for (const reason of ["authority_changed", "unauthorized_sender"]) test(`${reason} is still unknown through suspend/reopen and none until exact committed readback`, async () => {
  let response = qaSnapshot(), submits = 0, reads = 0;
  const controller = createHumanQaController(qaCapability({ inspect: async () => { reads++; return response; },
    submit: async () => { submits++; return { accepted: false, reason }; } }), qaCwd, () => "request:one");
  const submission = { kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } };
  await controller.activate(); await controller.select("task"); await controller.submit(submission);
  assert.equal(reads, 2, "uncertain rejection performs one persistence readback");
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown");
  assert.equal(canSubmitHumanQa(controller.getSnapshot()), false);
  controller.suspend(); await controller.activate(); await controller.select("task"); await controller.inspect();
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown", "reopen and none are not proof of rollback");
  await controller.submit(submission); assert.equal(submits, 1, "an uncertain rejection is never automatically or manually retried");
  response = qaSnapshot([qaEvent(1, "adjudicate", "task", "unrelated:request")], { lastSubmission: "committed" });
  await controller.inspect();
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown"); assert.equal(canSubmitHumanQa(controller.getSnapshot()), false);
  response = qaSnapshot([qaEvent()], { lastSubmission: "committed" });
  await controller.inspect();
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "committed"); assert.equal(canSubmitHumanQa(controller.getSnapshot()), true);
  assert.equal(submits, 1);
});

test("suspending an in-flight submit cannot erase its uncertainty when QA is reopened", async () => {
  for (const responseKind of ["committed", "throw"]) {
    const pending = deferred();
    const controller = createHumanQaController(qaCapability({ submit: () => pending.promise }), qaCwd, () => "request:one");
    await controller.activate(); await controller.select("task");
    const submission = controller.submit({ kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } });
    controller.suspend(); await controller.activate(); await controller.select("task");
    assert.equal(canSubmitHumanQa(controller.getSnapshot()), false, "in-flight acknowledgement is not a known failure");
    responseKind === "committed" ? pending.resolve({ accepted: true, eventId: "event:task:1", revision: 1, state: "active" })
      : pending.reject(new Error("lost acknowledgement"));
    await submission;
    assert.equal(canSubmitHumanQa(controller.getSnapshot()), false);
  }
});

test("a late known failure clears only its exact suspended request guard on the next explicit readback", async () => {
  const pending = deferred(); let submits = 0;
  const controller = createHumanQaController(qaCapability({ submit: () => { submits++; return pending.promise; } }), qaCwd, () => "request:one");
  await controller.activate(); await controller.select("task");
  const submission = controller.submit({ kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } });
  controller.suspend(); await controller.activate(); await controller.select("task");
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown");
  pending.resolve({ accepted: false, reason: "confirmation_failed" }); await submission;
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown", "late completion cannot replace the reopened view");
  await controller.inspect();
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "none"); assert.equal(canSubmitHumanQa(controller.getSnapshot()), true);
  assert.equal(submits, 1, "readback does not dispatch another submission");
});

test("a late R1 known failure cannot clear the successor R2 uncertainty or bypass its exact readback", async () => {
  const first = deferred(), second = deferred(); let response = qaSnapshot(), requestOrdinal = 0;
  const requests = [], firstEvent = qaEvent(1, "adjudicate", "task", "request:1");
  const controller = createHumanQaController(qaCapability({ inspect: async () => response,
    submit: request => { requests.push(request); return requests.length === 1 ? first.promise : second.promise; } }), qaCwd, () => `request:${++requestOrdinal}`);
  await controller.activate(); await controller.select("task");
  const r1 = controller.submit({ kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } });
  controller.suspend(); response = qaSnapshot([firstEvent], { lastSubmission: "committed" });
  await controller.activate(); await controller.select("task");
  assert.equal(canSubmitHumanQa(controller.getSnapshot()), true, "R1 exact event readback clears only R1");
  const correction = { kind: "correct", supersedesEventId: firstEvent.id, decision: { verdict: "fail", rationale: "second review" } };
  const r2 = controller.submit(correction); second.resolve({ accepted: false, reason: "submission_unknown" }); await r2;
  assert.deepEqual(requests.map(request => request.requestId), ["request:1", "request:2"]);
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown");
  first.resolve({ accepted: false, reason: "confirmation_failed" }); await r1;
  await controller.inspect();
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown", "late R1 failure must not erase R2's guard");
  await controller.submit(correction); assert.equal(requests.length, 2);
  controller.suspend(); response = qaSnapshot(); await controller.activate(); await controller.select("task");
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "unknown", "R2 guard survives another reopen and none");
  response = qaSnapshot([firstEvent, qaEvent(2, "correct", "task", "request:2")], { lastSubmission: "committed" });
  await controller.inspect();
  assert.equal(controller.getSnapshot().snapshot.lastSubmission, "committed"); assert.equal(canSubmitHumanQa(controller.getSnapshot()), true);
  assert.equal(requests.length, 2);
});

test("exact committed request readback resolves uncertainty, not a prior or unrelated committed event", async () => {
  let response = qaSnapshot();
  const controller = createHumanQaController(qaCapability({ inspect: async () => response,
    submit: async () => { throw new Error("PRIVATE_SECRET"); } }), qaCwd, () => "request:one");
  await controller.activate(); await controller.select("task");
  await controller.submit({ kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } });
  assert.equal(controller.getSnapshot().issue, "submission_unknown");
  assert.ok(!JSON.stringify(controller.getSnapshot()).includes("PRIVATE_SECRET"));
  response = qaSnapshot([qaEvent(1, "adjudicate", "task", "prior:request")], { lastSubmission: "committed" });
  await controller.inspect(); assert.equal(canSubmitHumanQa(controller.getSnapshot()), false);
  response = qaSnapshot([qaEvent()], { lastSubmission: "committed" });
  await controller.inspect(); assert.equal(canSubmitHumanQa(controller.getSnapshot()), true);
});

test("correction/revoke binds exact head and revoked decisions cannot be silently adjudicated again", async () => {
  let response = qaSnapshot([qaEvent()]); const submissions = [];
  const controller = createHumanQaController(qaCapability({ inspect: async () => response,
    submit: async request => { submissions.push(request); return { accepted: false, reason: "cancelled" }; } }), qaCwd);
  await controller.activate(); await controller.select("task");
  await controller.submit({ kind: "correct", supersedesEventId: "wrong", decision: { verdict: "fail", rationale: "reviewed" } });
  assert.equal(submissions.length, 0);
  await controller.inspect();
  await controller.submit({ kind: "revoke", revokesEventId: "event:task:1", rationale: "withdrawn" });
  assert.equal(submissions.length, 1);
  response = qaSnapshot([qaEvent(), qaEvent(2, "revoke")]); await controller.inspect();
  assert.equal(canSubmitHumanQa(controller.getSnapshot()), false);
});

test("report is explicit, fixed, then only currentness changes after correction or withdrawal", async () => {
  let response = qaSnapshot([qaEvent()]); const report = qaReport(); let generates = 0;
  const controller = createHumanQaController(qaCapability({ inspect: async () => response,
    generateReport: async ref => { generates++; assert.deepEqual(ref, report.report.ref); return report; } }), qaCwd);
  await controller.activate(); await controller.select("task"); assert.equal(generates, 0);
  await controller.generateReport(); const fixed = JSON.stringify(controller.getSnapshot().report.report);
  response = qaSnapshot([qaEvent(), qaEvent(2, "correct")], { reportCurrentness: "stale" });
  await controller.inspect();
  assert.equal(generates, 1); assert.equal(controller.getSnapshot().report.currentness, "stale");
  assert.equal(JSON.stringify(controller.getSnapshot().report.report), fixed);
});

test("explicit report accepts only the Host-verified workspace alias or its canonical identity", async () => {
  const alias = "/var/qa", canonical = "/private/var/qa", report = { ...qaReport(), workspaceCwd: alias, canonicalWorkspaceCwd: canonical };
  for (const cwd of [alias, canonical]) {
    const refs = [];
    const controller = createHumanQaController(qaCapability({ list: async () => ({ accepted: true,
      workspaceCwd: alias, canonicalWorkspaceCwd: canonical, items: [qaRow()] }), inspect: async () => qaSnapshot([qaEvent()]),
      generateReport: async ref => { refs.push(ref); return report; } }), cwd);
    await controller.activate(); await controller.select("task"); await controller.generateReport();
    assert.equal(controller.getSnapshot().phase, "ready"); assert.equal(controller.getSnapshot().issue, undefined);
    assert.deepEqual(controller.getSnapshot().report.report, report.report);
    assert.deepEqual(refs, [report.report.ref]);
  }
});

test("a late report cannot repopulate a suspended scope or a different case", async () => {
  const read = deferred();
  const controller = createHumanQaController(qaCapability({ inspect: async () => qaSnapshot([qaEvent()]), generateReport: () => read.promise }), qaCwd);
  await controller.activate(); await controller.select("task");
  const pending = controller.generateReport(); controller.suspend(); read.resolve(qaReport()); await pending;
  assert.deepEqual(controller.getSnapshot(), { phase: "idle", items: [] });
});

test("report scope/reference mismatches never become displayed facts", async () => {
  for (const result of [{ ...qaReport(), workspaceCwd: "/foreign", canonicalWorkspaceCwd: "/foreign" },
    { ...qaReport(), report: { ...qaReport().report, ref: { taskId: "foreign", eventId: "event:task:1", revision: 1 } } }]) {
    const controller = createHumanQaController(qaCapability({ inspect: async () => qaSnapshot([qaEvent()]), generateReport: async () => result }), qaCwd);
    await controller.activate(); await controller.select("task"); await controller.generateReport();
    assert.equal(controller.getSnapshot().phase, "error"); assert.equal(controller.getSnapshot().report, undefined);
  }
});

test("rationale validation is bounded and does not accept blank/control-only feedback", () => {
  for (const bad of [" ", "\u0000", "x".repeat(2001)]) assert.equal(validHumanQaRationale(bad), false);
  assert.equal(validHumanQaRationale("reviewed\nredacted QA"), true);
});

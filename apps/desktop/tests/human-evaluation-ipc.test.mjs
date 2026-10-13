import assert from "node:assert/strict";
import test from "node:test";
import { registerHumanEvaluationIpc, parseHumanEvaluationRequest, parseHumanEvaluationInspectRequest,
  parseHumanEvaluationListRequest, parseHumanEvaluationReportRef } from "../dist/main/human-evaluation/ipc.js";
import { DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS as channels } from "../dist/shared/ipc-channels.js";

const request = { taskId: "task-qa", requestId: "request-qa", submission: { kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } } };
const knownAppUrl = "file:///fixed/web/index.html";
function fixture(overrides = {}) {
  const handlers = new Map(), calls = [], mainFrame = { url: knownAppUrl };
  const owner = { id: 4, mainFrame, isDestroyed: () => false, getURL: () => knownAppUrl };
  const window = { webContents: owner, isDestroyed: () => false };
  const event = { sender: owner, senderFrame: mainFrame };
  const unregister = registerHumanEvaluationIpc({ knownAppUrl, getMainWindow: () => window,
    ipcMainImpl: { handle: (c, h) => handlers.set(c, h), removeHandler: c => handlers.delete(c) },
    coordinator: { submit(r, check) { calls.push(r); return overrides.submit?.(r, check) ?? Promise.resolve({ accepted: check() }); },
      inspect(r, check) { calls.push(r); return overrides.inspect?.(r, check) ?? Promise.resolve({ accepted: check() }); },
      list(r, check) { calls.push(r); return overrides.list?.(r, check) ?? Promise.resolve({ accepted: check() }); },
      generateReport(r, check) { calls.push(r); return overrides.generateReport?.(r, check) ?? Promise.resolve({ accepted: check() }); },
      cancel(id) { calls.push(id); return { accepted: true }; } },
  });
  return { handlers, calls, owner, mainFrame, window, event, unregister };
}

test("exact owner mainFrame and known app URL admit one cloned payload", async () => {
  const f = fixture();
  assert.equal((await f.handlers.get(channels.submit)(f.event, request)).accepted, true);
  assert.deepEqual(f.calls[0], request);
  assert.notEqual(f.calls[0], request);
  assert.ok(Object.isFrozen(f.calls[0].submission.decision));
  f.unregister(); assert.equal(f.handlers.size, 0);
});

test("readback accepts bounded own cursor/report lineage, never a Renderer-provided native intent or identity", async () => {
  const f = fixture();
  const query = { taskId: "task-qa", afterRevision: 100, reportRef: { taskId: "task-qa", eventId: "event", revision: 1 } };
  assert.equal((await f.handlers.get(channels.inspect)(f.event, query)).accepted, true);
  for (const invalid of [{ ...query, intentId: "stolen" }, { ...query, authenticated: true },
    { ...query, afterRevision: -1 }, { ...query, reportRef: { ...query.reportRef, taskId: "other" } }]) {
    assert.equal(parseHumanEvaluationInspectRequest(invalid), undefined);
  }
  const stranger = { ...f.event, sender: { ...f.owner } };
  assert.equal((await f.handlers.get(channels.inspect)(stranger, query)).accepted, false);
});
for (const confusion of ["sameId", "subframe", "allURLsWrong", "destroyed", "extraArgs"]) {
  test(`IPC ${confusion} rejected before coordinator`, async () => {
    const f = fixture(); let args = [request];
    if (confusion === "sameId") f.event.sender = { ...f.owner };
    if (confusion === "subframe") f.event.senderFrame = { ...f.mainFrame };
    if (confusion === "allURLsWrong") { f.owner.getURL = () => "https://evil.example"; f.mainFrame.url = "https://evil.example"; }
    if (confusion === "destroyed") f.window.isDestroyed = () => true;
    if (confusion === "extraArgs") args.push({ authenticated: true });
    assert.equal((await f.handlers.get(channels.submit)(f.event, ...args)).accepted, false);
    assert.equal(f.calls.length, 0);
  });
}
test("own-data parser rejects auth claims, hidden accessors and unsupported decisions", () => {
  let reads = 0;
  for (const bad of [ { ...request, authenticated: true },
    { ...request, submission: { ...request.submission, adjudicator: "user" } },
    { ...request, submission: { kind: "adjudicate", decision: { verdict: "inconclusive", rationale: "test" } } },
    Object.defineProperty({ ...request }, "secret", { get() { reads++; return "key"; } }) ]) {
    assert.equal(parseHumanEvaluationRequest(bad), undefined);
  }
  assert.equal(reads, 0);
  assert.equal(parseHumanEvaluationRequest({ ...request, submission: { kind: "correct", supersedesEventId: "event", decision: { verdict: "abstain", rationale: "update", score: 0.5 } } }).submission.kind, "correct");
  assert.equal(parseHumanEvaluationRequest({ ...request, submission: { kind: "revoke", revokesEventId: "event", rationale: "withdraw" } }).submission.kind, "revoke");
});

for (const action of ["submit", "inspect", "list", "generateReport"]) {
  test(`IPC ${action} rechecks exact owner after the coordinator settles`, async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ [action]: () => pending });
    const result = f.handlers.get(channels[action])(f.event, action === "submit" ? request : action === "list" ? {}
      : action === "generateReport" ? { taskId: request.taskId, eventId: "event", revision: 1 } : { taskId: request.taskId });
    f.owner.getURL = () => "https://not-the-owner.example";
    release({ accepted: true, eventId: "must-not-return", events: [{ privateQa: "must-not-return" }] });
    assert.deepEqual(await result, { accepted: false, reason: "unauthorized_sender" });
  });
}

test("private QA list/report parse only bounded own cursors and exact immutable refs", async () => {
  const f = fixture();
  assert.deepEqual(parseHumanEvaluationListRequest({}), {});
  assert.deepEqual(parseHumanEvaluationListRequest({ afterEnrollmentId: "enrollment", limit: 50 }), { afterEnrollmentId: "enrollment", limit: 50 });
  let reads = 0;
  for (const invalid of [{ workspaceCwd: "/other" }, { namespaceId: "other" }, { authenticated: true }, { limit: 0 }, { limit: 51 },
    { limit: 1.5 }, { afterEnrollmentId: "a".repeat(161) }, Object.defineProperty({}, "limit", { get() { reads++; return 1; } })]) {
    assert.equal(parseHumanEvaluationListRequest(invalid), undefined);
  }
  const ref = { taskId: "task", eventId: "event", revision: 1 };
  for (const invalid of [{ ...ref, authority: "human" }, { ...ref, grade: "pass" }, { ...ref, revision: 0 }, { ...ref, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(parseHumanEvaluationReportRef(invalid), undefined);
  }
  assert.equal(reads, 0);
  assert.equal((await f.handlers.get(channels.list)(f.event, {})).accepted, true);
  assert.equal((await f.handlers.get(channels.generateReport)(f.event, ref)).accepted, true);
  const stranger = { ...f.event, sender: { ...f.owner } };
  for (const [action, query] of [["list", {}], ["generateReport", ref]]) {
    assert.equal((await f.handlers.get(channels[action])(stranger, query)).accepted, false);
    assert.equal((await f.handlers.get(channels[action])(f.event, query, {})).reason, "invalid_request");
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AcpApprovalJournal } from "../dist/runtime/acp/approval-journal.js";
import { KimiActionPreparer } from "../dist/runtime/acp/kimi-action-preparation.js";
import { NativeSecretRegistry } from "../dist/runtime/adapters/native-stream-redaction.js";

const now = "2026-09-09T00:00:00.000Z";
const request = { requestId: "permission-1", params: { sessionId: "native-session",
  toolCall: { toolCallId: "fixture-tool", title: "Fixture" }, options: [
    { optionId: "once", kind: "allow_once", name: "Once" }, { optionId: "deny", kind: "reject_once", name: "Deny" },
    { optionId: "always", kind: "allow_always", name: "Always" },
  ] } };
const reply = approved => ({ outcome: { outcome: "selected", optionId: approved ? "once" : "deny" } });

async function fixture(t, engineId = "kimi-acp") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-acp-approval-journal-"));
  const stores = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  const store = open();
  t.after(async () => { for (const store of stores) store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "ACP", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "ACP", prompt: "Synthetic" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "ACP", objective: "Synthetic" }, now);
  store.createRun({ id: "run_acp", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
    providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const work = store.createWorkUnit({ id: "wu_acp", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "run", ownerId: "run_acp", idempotencyKey: "acp", createdByActor: "user", request: {}, linkedRunId: "run_acp", runnerId: engineId, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runtimeInstanceId: "runtime", runnerId: engineId, now });
  store.linkRunToWorkUnit("run_acp", work.id, now);
  const fence = toRuntimeAttemptFence(attempt);
  const entry = store.reserveNativeExecution({ runId: "run_acp", generation: 1, fence,
    selection: { engineId, profileId: "fixture", profileRevision: 1, profileFingerprint: "a".repeat(64), configurationFingerprint: "b".repeat(64) } }, now);
  const key = { submissionId: entry.submission.id, fence };
  if (engineId === "openclaw-acp") store.prepareNativeOpenClawSession({ ...key, agentId: "fixture" }, now);
  store.bindNativeExecutionSession({ ...key, nativeSessionId: "native-session" }, now);
  store.beginNativeSubmission({ ...key, nativePromptRequestId: 3 }, now);
  store.acceptNativeSubmission({ ...key, nativePromptRequestId: 3 }, now);
  const prepared = { kind: "action", policyDecision: { decision: "ask", reason: "Fixture" }, approval: {
    actionType: "bash", risk: "medium", title: "Approve fixture", description: "Owned fixture only", toolCallId: "fixture-tool",
    payload: { type: "bash", command: "whois example.com", cwd, riskFlags: [] },
  } };
  const actions = { prepare: () => structuredClone(prepared) };
  const clock = { now };
  const journal = new AcpApprovalJournal(store, key, actions, () => clock.now);
  return { cwd, store, open, key, prepared, actions, journal, clock };
}

test("Kimi finalized tool input becomes the persisted command, not the display summary", async t => {
  const f = await fixture(t);
  const actions = new KimiActionPreparer({ sessionId: "native-session", cwd: f.cwd,
    policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [f.cwd] } });
  actions.receive({ sessionId: "native-session", update: { sessionUpdate: "tool_call", toolCallId: "1:bash",
    kind: "execute", status: "in_progress", title: "Untrusted progress description",
    rawInput: { command: "/usr/bin/whois 'example.com'", timeout: 60 },
    content: [{ type: "content", content: { type: "text", text: "echo misleading-preview" } }] } });
  const native = { requestId: "kimi-permission", params: { sessionId: "native-session",
    toolCall: { toolCallId: "1:bash", title: "Bash" }, options: [
      { optionId: "approve_once", kind: "allow_once", name: "Once" },
      { optionId: "approve_always", kind: "allow_always", name: "Session" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ] } };
  const journal = new AcpApprovalJournal(f.store, f.key, actions, () => now);
  const approval = journal.create(native, new AbortController().signal);
  assert.equal(approval.payload.command, "/usr/bin/whois 'example.com'");
  assert.equal(approval.payload.cwd, f.cwd);
  assert.equal(approval.toolCallId, "1:bash");
  assert.deepEqual(approval.availableDecisions, ["approve_once", "deny"]);
  f.store.approveApprovalRequest(approval.id, {}, now);
  journal.beforeWrite(native, { outcome: { outcome: "selected", optionId: "approve_once" } });
  journal.observe({ requestId: native.requestId, outcome: "written" });
  assert.equal(f.open().getNativeApprovalCorrelation(approval.id).replyStatus, "written");
});

test("Kimi changed-then-restored arguments cannot reuse an earlier human approval", async t => {
  const f = await fixture(t);
  const actions = new KimiActionPreparer({ sessionId: "native-session", cwd: f.cwd,
    policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [f.cwd] } });
  const event = { sessionId: "native-session", update: { sessionUpdate: "tool_call", toolCallId: "1:bash",
    kind: "execute", status: "in_progress", title: "Bash", rawInput: { command: "whois example.com" } } };
  const native = structuredClone(request);
  native.params.toolCall = { toolCallId: "1:bash", title: "Bash" };
  native.params.options = [
    { optionId: "approve_once", kind: "allow_once", name: "Once" },
    { optionId: "approve_always", kind: "allow_always", name: "Session" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ];
  actions.receive(event);
  const journal = new AcpApprovalJournal(f.store, f.key, actions, () => now);
  const approval = journal.create(native, new AbortController().signal);
  f.store.approveApprovalRequest(approval.id, {}, now);
  actions.receive({ sessionId: event.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "1:bash",
    rawInput: { command: "whois other.example" } } });
  actions.receive({ ...event, update: { ...event.update, sessionUpdate: "tool_call_update" } });
  assert.throws(() => journal.beforeWrite(native, { outcome: { outcome: "selected", optionId: "approve_once" } }),
    { code: "host_commit_failed" });
  journal.observe({ requestId: native.requestId, outcome: "not_written" });
  assert.equal(f.open().getNativeApprovalCorrelation(approval.id).replyStatus, "not_written");
  assert.equal(f.store.getApprovalRequest(approval.id).status, "approved");
});

test("Kimi live secret registration redacts new approvals without changing a waiting command", async t => {
  const f = await fixture(t);
  const initial = "synthetic-first-access-token", rotated = "synthetic-next-access-token";
  const secrets = new NativeSecretRegistry([initial]);
  const actions = new KimiActionPreparer({ sessionId: "native-session", cwd: f.cwd,
    policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [f.cwd] } }, secrets);
  const journal = new AcpApprovalJournal(f.store, f.key, actions, () => now);
  const native = structuredClone(request);
  native.params.options = [
    { optionId: "approve_once", kind: "allow_once", name: "Once" },
    { optionId: "approve_always", kind: "allow_always", name: "Session" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ];
  const prepare = (id, value) => {
    actions.receive({ sessionId: "native-session", update: { sessionUpdate: "tool_call", toolCallId: id,
      kind: "execute", status: "in_progress", rawInput: { command: `whois ${value}` } } });
    return { ...structuredClone(native), requestId: id, params: { ...structuredClone(native.params), toolCall: { toolCallId: id, title: "Bash" } } };
  };
  const firstRequest = prepare("first", initial);
  const first = journal.create(firstRequest, new AbortController().signal);
  assert.equal(JSON.stringify(first).includes(initial), false);
  secrets.register([rotated]);
  assert.equal(journal.create(firstRequest, new AbortController().signal).id, first.id);
  assert.equal(actions.prepare(firstRequest).approval.payload.command, `whois ${initial}`);
  f.store.approveApprovalRequest(first.id, {}, now);
  journal.beforeWrite(firstRequest, { outcome: { outcome: "selected", optionId: "approve_once" } });
  journal.observe({ requestId: firstRequest.requestId, outcome: "written" });
  const secondRequest = prepare("second", rotated);
  const second = journal.create(secondRequest, new AbortController().signal);
  assert.equal(JSON.stringify(second).includes(rotated), false);
  assert.notEqual(second.id, first.id);
  const saved = JSON.stringify(f.open().listApprovalRequests({ runId: "run_acp" }));
  assert.equal(saved.includes(initial), false); assert.equal(saved.includes(rotated), false);
});

test("ACP journal rejects ambiguous option ids and missing action policy before persisting", async t => {
  const f = await fixture(t);
  const ambiguous = structuredClone(request);
  ambiguous.params.options[1].optionId = "once";
  assert.throws(() => f.journal.create(ambiguous, new AbortController().signal), { code: "host_commit_failed" });
  f.prepared.policyDecision = { decision: "unverified" };
  assert.throws(() => f.journal.create(request, new AbortController().signal), { code: "host_commit_failed" });
  assert.equal(f.store.listApprovalRequests({ runId: "run_acp" }).length, 0);
});

for (const mutation of ["policy", "command", "request", "response", "expired", "fence"]) {
  test(`ACP journal rechecks ${mutation} before a saved approval can be sent`, async t => {
    const f = await fixture(t);
    const approval = f.journal.create(request, new AbortController().signal);
    f.store.approveApprovalRequest(approval.id, {}, now);
    const sending = structuredClone(request);
    let response = reply(true);
    if (mutation === "policy") f.prepared.policyDecision = { decision: "deny", reason: "Plan mode" };
    if (mutation === "command") f.prepared.approval.payload.command = "different-command";
    if (mutation === "request") sending.params.toolCall.toolCallId = "different-tool";
    if (mutation === "response") response = { outcome: { outcome: "selected", optionId: "always" } };
    if (mutation === "expired") f.clock.now = "2026-09-09T00:05:00.000Z";
    if (mutation === "fence") f.store.createWorkUnitAttempt({ workUnitId: f.key.fence.workUnitId, attemptNumber: 2,
      runtimeInstanceId: "replacement", runnerId: "kimi-acp", now });
    assert.throws(() => f.journal.beforeWrite(sending, response), error =>
      ["host_commit_failed", "native_owner_mismatch", "native_approval_unavailable"].includes(error.code));
    assert.equal(f.store.getApprovalRequest(approval.id).status, "approved");
    assert.notEqual(f.open().getNativeApprovalCorrelation(approval.id).replyStatus, "written");
  });
}

for (const kind of ["pending", "approved", "claimed", "written"]) test(`ACP journal cancellation preserves the ${kind} decision/delivery distinction`, async t => {
  const f = await fixture(t);
  const approval = f.journal.create(request, new AbortController().signal);
  if (kind !== "pending") f.store.approveApprovalRequest(approval.id, {}, now);
  if (kind === "claimed" || kind === "written") f.journal.beforeWrite(request, reply(true));
  const outcome = kind === "written" ? "written" : kind === "claimed" ? "unknown" : "not_written";
  f.journal.observe({ requestId: request.requestId, outcome });
  const reopened = f.open();
  assert.equal(reopened.getApprovalRequest(approval.id).status, kind === "pending" ? "cancelled" : "approved");
  assert.equal(reopened.getNativeApprovalCorrelation(approval.id).replyStatus, outcome);
  assert.throws(() => reopened.claimNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence }, now), { code: "native_approval_unavailable" });
});

test("ACP journal snapshots request/preparation, retains expiry on repeat create, and rejects unsaved grants", async t => {
  const f = await fixture(t);
  assert.throws(() => f.journal.beforeWrite(request, reply(true)), { code: "host_commit_failed" });
  f.journal.beforeWrite(request, reply(false));
  const original = structuredClone(request);
  const first = f.journal.create(original, new AbortController().signal);
  original.params.options[0].optionId = "always";
  f.clock.now = "2026-09-09T00:00:01.000Z";
  const again = f.journal.create(request, new AbortController().signal);
  assert.equal(again.id, first.id);
  assert.equal(again.expiresAt, "2026-09-09T00:05:00.000Z");
  f.store.approveApprovalRequest(first.id, {}, now);
  f.journal.beforeWrite(request, reply(true));
});

for (const phase of ["pending", "approved", "written"]) test(`ACP ${phase} approval retains creation identity after redaction registration`, async t => {
  const f = await fixture(t);
  f.prepared.approval.extraSecrets = ["synthetic-initial-token"];
  const first = f.journal.create(request, new AbortController().signal);
  const originalInput = { ...f.key, requestId: request.requestId, method: "session/request_permission",
    approval: { ...structuredClone(f.prepared.approval), expiresAt: first.expiresAt } };
  if (phase !== "pending") f.store.approveApprovalRequest(first.id, {}, now);
  if (phase === "written") {
    f.journal.beforeWrite(request, reply(true));
    f.journal.observe({ requestId: request.requestId, outcome: "written" });
  }
  f.prepared.approval.extraSecrets.push("synthetic-rotated-token", "example.com");
  f.clock.now = "2026-09-09T00:00:02.000Z";
  const repeated = f.journal.create(request, new AbortController().signal);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.expiresAt, first.expiresAt);
  assert.deepEqual(repeated.payload, first.payload);
  assert.equal(f.journal.findForHost(f.prepared), first.id);
  assert.equal(f.journal.findForHost(f.prepared, repeated), first.id);
  assert.equal(f.journal.findForHost(f.prepared, { ...repeated, expiresAt: "2026-09-09T00:10:00.000Z" }), undefined);
  assert.equal(f.journal.findForHost(f.prepared, { ...repeated, payload: { ...repeated.payload, command: "different-command" } }), undefined);
  assert.equal(f.open().createNativeApproval(originalInput, f.clock.now).approval.id, first.id);
  assert.equal(f.store.listApprovalRequests({ runId: "run_acp" }).length, 1);
  if (phase === "pending") f.store.approveApprovalRequest(first.id, {}, now);
  if (phase !== "written") {
    f.journal.beforeWrite(request, reply(true));
    f.journal.observe({ requestId: request.requestId, outcome: "written" });
  }
  assert.equal(f.open().getNativeApprovalCorrelation(first.id).replyStatus, "written");
  assert.throws(() => f.journal.beforeWrite(request, reply(true)), { code: "native_approval_unavailable" });
});

for (const changed of ["command", "cwd", "policy", "revision"]) test(`ACP redaction rotation does not hide changed raw ${changed}`, async t => {
  const f = await fixture(t);
  f.prepared.contextRevision = 1;
  f.prepared.approval.extraSecrets = ["synthetic-alpha-token", "synthetic-beta-token"];
  f.prepared.approval.payload.command = "whois synthetic-alpha-token";
  const first = f.journal.create(request, new AbortController().signal);
  f.store.approveApprovalRequest(first.id, {}, now);
  f.prepared.approval.extraSecrets.push("synthetic-next-token");
  if (changed === "command") f.prepared.approval.payload.command = "whois synthetic-beta-token";
  if (changed === "cwd") f.prepared.approval.payload.cwd = join(f.cwd, "different");
  if (changed === "policy") f.prepared.policyDecision = { decision: "allow", reason: "Different policy" };
  if (changed === "revision") f.prepared.contextRevision = 2;
  assert.throws(() => f.journal.create(request, new AbortController().signal), { code: "host_commit_failed" });
  assert.equal(f.journal.findForHost(f.prepared, first), undefined);
  assert.throws(() => f.journal.beforeWrite(request, reply(true)), { code: "host_commit_failed" });
  assert.notEqual(f.open().getNativeApprovalCorrelation(first.id).replyStatus, "written");
  assert.equal(f.store.listApprovalRequests({ runId: "run_acp" }).length, 1);
});

test("ACP journal rejects late creation, cross-session requests and unsupported/native-scope proposals", async t => {
  const f = await fixture(t);
  const abort = new AbortController(); abort.abort();
  assert.throws(() => f.journal.create(request, abort.signal));
  assert.throws(() => f.journal.create({ ...request, params: { ...request.params, sessionId: "other" } }, new AbortController().signal),
    { code: "host_commit_failed" });
  f.actions.prepare = () => ({ kind: "unsupported", reason: "missing_native_context" });
  assert.throws(() => f.journal.create(request, new AbortController().signal), { code: "host_commit_failed" });
  f.prepared.approval.payload.type = "native_permission_request";
  f.actions.prepare = () => f.prepared;
  assert.throws(() => f.journal.create(request, new AbortController().signal), { code: "host_commit_failed" });
  assert.equal(f.store.listApprovalRequests({ runId: "run_acp" }).length, 0);
});

for (const engineId of ["kimi-acp", "openclaw-acp"]) for (const approve of [true, false]) {
  test(`${engineId} journals a ${approve ? "grant" : "denial"} independently from reply delivery`, async t => {
    const f = await fixture(t, engineId);
    const approval = f.journal.create(request, new AbortController().signal);
    assert.deepEqual(approval.availableDecisions, ["approve_once", "deny"]);
    assert.throws(() => f.journal.beforeWrite(request, reply(approve)), { code: "native_approval_unavailable" });
    if (approve) f.store.approveApprovalRequest(approval.id, {}, now); else f.store.denyApprovalRequest(approval.id, {}, now);
    f.journal.beforeWrite(request, reply(approve));
    assert.equal(f.open().getNativeApprovalCorrelation(approval.id).replyStatus, "claimed");
    f.journal.observe({ requestId: request.requestId, outcome: "written" });
    assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
    assert.throws(() => f.journal.beforeWrite(request, reply(approve)), { code: "native_approval_unavailable" });
    assert.equal(f.store.getApprovalRequest(approval.id).status, approve ? "approved" : "denied");
  });
}

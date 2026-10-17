import assert from "node:assert/strict";
import test from "node:test";
import { recoverSubmissionReceipt, resolveGuidanceSubmission, submissionWasRejected, UnconfirmedConversationSubmissionError } from "../src/shared/conversation/conversation-submission-recovery.ts";
import { createGuidanceLookupJournal, createSubmissionLookupJournal } from "../src/shared/conversation/conversation-submission-journal.ts";
import { validateConversationSubmissionReceipt, validatePrivateSubmissionReceipt } from "../src/shared/conversation/submission-receipt-scope.ts";
import { privateSubmissionDraftMatches } from "../src/features/teammates/teammate-private-submission-draft.ts";

test("receipt recovery only queries with bounded waits; unknown/errors do not imply rejection", async () => {
  let queries = 0;
  const waits = [];
  const receipt = await recoverSubmissionReceipt(async () => {
    queries++;
    if (queries === 1) throw new TypeError("Offline");
    return { status: queries === 3 ? "accepted" : "unknown", id: "original" };
  }, ms => { waits.push(ms); return Promise.resolve(); });
  assert.equal(receipt.id, "original");
  assert.equal(queries, 3);
  assert.deepEqual(waits, [150, 300]);
  assert.deepEqual(await recoverSubmissionReceipt(async () => ({ status: "unknown" }), () => Promise.resolve()), { status: "unknown" });
});

test("HTTP rejection requires a successful native unknown lookup; an unreachable receipt is not rejection", () => {
  const error = Object.assign(new Error("Preparation failed"), { status: 400 });
  assert.equal(submissionWasRejected(error), false);
  assert.equal(submissionWasRejected(error, { status: "accepted" }), false);
  assert.equal(submissionWasRejected(error, { status: "unknown" }), true);
  for (const status of [408, 500, 502]) assert.equal(submissionWasRejected(Object.assign(new Error(), { status }), { status: "unknown" }), false);
});

test("lookup journal survives recreation, isolates native owners and removes only its own key", () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const journal = createSubmissionLookupJournal(storage);
  const scope = { cwd: "/workspace", surface: "channel", ownerId: "engineering", threadId: "topic-one" };
  journal.remember(scope, "original-key");
  const reopened = createSubmissionLookupJournal(storage);
  assert.equal(reopened.read(scope), "original-key");
  for (const other of [{ ...scope, cwd: "/other" }, { ...scope, threadId: "topic-two" },
    { ...scope, ownerId: "other-channel" }, { ...scope, surface: "private" }]) {
    assert.equal(reopened.read(other), undefined);
  }
  reopened.remember(scope, "new-key");
  journal.forget(scope, "original-key");
  assert.equal(reopened.read(scope), "new-key");
  reopened.forget(scope, "new-key");
  assert.equal(journal.read(scope), undefined);
  assert.equal(entries.size, 0);
});

test("concurrent submissions keep every receipt pointer while live requests do not block another send", () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const journal = createSubmissionLookupJournal(storage);
  const scope = { cwd: "/workspace", surface: "channel", ownerId: "engineering" };
  journal.begin(scope, "first-key");
  assert.equal(journal.read(scope), undefined, "an existing live request is not a lost response");
  journal.begin(scope, "second-key");
  const reopened = createSubmissionLookupJournal(storage);
  assert.equal(reopened.read(scope), "first-key", "reload must recover the oldest unconfirmed input");
  journal.finish(scope, "first-key");
  assert.equal(journal.read(scope), "first-key", "failed response remains query-only");
  journal.forget(scope, "second-key");
  assert.equal(reopened.read(scope), "first-key", "a newer acknowledgement cannot erase the unknown input");
  journal.forget(scope, "first-key");
  assert.equal(reopened.read(scope), undefined);
  assert.equal(entries.size, 0);
});

test("concurrent receipt pointers survive out-of-order acknowledgement and legacy storage", () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const scope = { cwd: "/workspace", surface: "channel", ownerId: "engineering" };
  entries.set(`ling-stack.submission-lookup.v1:${JSON.stringify(["/workspace", "channel", "engineering", ""])}`, "legacy-key");
  const journal = createSubmissionLookupJournal(storage);
  journal.remember(scope, "second-key");
  journal.remember(scope, "third-key");
  journal.forget(scope, "second-key");
  assert.equal(journal.read(scope), "legacy-key");
  journal.forget(scope, "legacy-key");
  assert.equal(journal.read(scope), "third-key");
  journal.forget(scope, "third-key");
  assert.equal(entries.size, 0);
});

test("native receipt validation fences workspace, thread, channel and private reply ownership", () => {
  const query = { surface: "channel", channelId: "engineering", threadId: "branch", idempotencyKey: "original-key" };
  const receipt = { cwd: "/workspace", status: "accepted", idempotencyKey: "original-key", threadId: "branch", turnId: "turn", sourceItemId: "user-item",
    sourceItem: { id: "user-item", kind: "user_message", threadId: "branch", turnId: "turn", channelId: "engineering" } };
  assert.equal(validateConversationSubmissionReceipt(receipt, "/workspace", query), receipt);
  for (const bad of [{ ...receipt, cwd: "/other" }, { ...receipt, threadId: "other" }, { ...receipt, idempotencyKey: "other" },
    { ...receipt, sourceItem: { ...receipt.sourceItem, channelId: "other" } }, { ...receipt, turnId: "other" }]) {
    assert.throws(() => validateConversationSubmissionReceipt(bad, "/workspace", query), /scope mismatch/);
  }
  const direct = { cwd: "/workspace", teammateId: "engineer", idempotencyKey: "original-key", status: "accepted",
    message: { id: "direct-input", workspaceId: "workspace", threadId: "direct-thread", teammateId: "engineer", authorType: "local-user", authorId: "local-user" },
    aiReply: { id: "reply", workspaceId: "workspace", threadId: "direct-thread", teammateId: "engineer", authorType: "ai-teammate", authorId: "engineer" } };
  assert.equal(validatePrivateSubmissionReceipt(direct, "/workspace", "engineer", "original-key"), direct);
  assert.throws(() => validatePrivateSubmissionReceipt({ ...direct, aiReply: { ...direct.aiReply, threadId: "foreign" } }, "/workspace", "engineer", "original-key"), /scope mismatch/);
});

test("private recovery clears only the complete original draft, not same text with new input", () => {
  const draft = { body: "Original", attachmentIds: ["file-one"], pendingAttachmentCount: 1, linkPreviewIds: ["link-one"], fileRefs: [{ path: "source.ts", line: 3 }] };
  const message = { ...draft };
  assert.equal(privateSubmissionDraftMatches(draft, message), true);
  for (const changed of [{ ...draft, body: "New" }, { ...draft, attachmentIds: ["file-two"] },
    { ...draft, pendingAttachmentCount: 2 }, { ...draft, linkPreviewIds: ["link-two"] },
    { ...draft, fileRefs: [{ path: "source.ts", line: 4 }] }]) {
    assert.equal(privateSubmissionDraftMatches(changed, message), false);
  }
});

function guidanceFixture() {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const journal = createGuidanceLookupJournal(storage);
  const scope = { cwd: "/workspace", surface: "normal", ownerId: "thread-one" };
  const record = { key: "original-key", sourceId: "original-run", threadId: "thread-one", mode: "queue_followup" };
  return { entries, storage, journal, scope, record };
}

test("guidance journal stores only the original query pointer and isolates every owner", () => {
  const f = guidanceFixture();
  f.journal.remember(f.scope, f.record);
  const reopened = createGuidanceLookupJournal(f.storage);
  assert.deepEqual(reopened.read(f.scope), f.record);
  for (const other of [{ ...f.scope, cwd: "/other" }, { ...f.scope, surface: "private" }, { ...f.scope, ownerId: "other-thread" }]) {
    assert.equal(reopened.read(other), undefined);
  }
  reopened.remember(f.scope, { ...f.record, key: "newer-key" });
  f.journal.forget(f.scope, f.record.key);
  assert.equal(reopened.read(f.scope).key, "newer-key");
  assert.deepEqual(Object.keys(JSON.parse([...f.entries.values()][0])).sort(), ["key", "mode", "sourceId", "threadId"]);
});

test("unknown guidance survives journal recreation; another click queries the original identity without preparing or posting", async () => {
  const f = guidanceFixture();
  let posts = 0, reads = 0, available = false;
  const intervention = { id: "accepted-guidance", idempotencyKey: f.record.key };
  const operation = { ...f, prepare: () => f.record, create: async () => { posts++; throw new TypeError("Receipt lost"); },
    read: async record => { reads++; assert.deepEqual(record, f.record); return available ? { status: "accepted", intervention } : { status: "unknown" }; },
    wait: () => Promise.resolve() };
  await assert.rejects(resolveGuidanceSubmission(operation), UnconfirmedConversationSubmissionError);
  const resumed = { ...operation, journal: createGuidanceLookupJournal(f.storage), prepare: () => assert.fail("must not prepare another input") };
  await assert.rejects(resolveGuidanceSubmission(resumed), error => error instanceof UnconfirmedConversationSubmissionError && error.recoveryOnly);
  assert.equal(posts, 1); assert.equal(reads, 6);
  available = true;
  assert.deepEqual(await resolveGuidanceSubmission(resumed), { intervention, queryOnly: true });
  assert.equal(posts, 1); assert.equal(reads, 7);
  assert.equal(f.journal.read(f.scope), undefined);
});

test("guidance resolves accepted HTTP failure by its receipt but releases a proven rejection for a later intentional send", async () => {
  const f = guidanceFixture();
  const rejection = Object.assign(new Error("Rejected before acceptance"), { status: 400 });
  const operation = { ...f, prepare: () => f.record, create: async () => { throw rejection; }, wait: () => Promise.resolve() };
  await assert.rejects(resolveGuidanceSubmission({ ...operation, read: async () => ({ status: "unknown" }) }), error => error === rejection);
  assert.equal(f.journal.read(f.scope), undefined);
  const intervention = { id: "native-original" };
  assert.deepEqual(await resolveGuidanceSubmission({ ...operation, read: async () => ({ status: "accepted", intervention }) }),
    { intervention, queryOnly: false });
  assert.equal(f.journal.read(f.scope), undefined);
});

test("unreachable guidance queries and failed journal cleanup cannot grant resend or orphan deletion authority", async () => {
  const f = guidanceFixture();
  const operation = { ...f, prepare: () => f.record, create: async () => { throw Object.assign(new Error("HTTP failure"), { status: 400 }); },
    read: async () => { throw new Error("Unreachable or unfiltered receipt"); }, wait: () => Promise.resolve() };
  await assert.rejects(resolveGuidanceSubmission(operation), UnconfirmedConversationSubmissionError);
  assert.deepEqual(f.journal.read(f.scope), f.record);
  const journal = createGuidanceLookupJournal({ ...f.storage, removeItem: () => { throw new Error("Storage failure"); } });
  await assert.rejects(resolveGuidanceSubmission({ ...operation, journal, read: async () => ({ status: "accepted", intervention: { id: "native" } }) }),
    UnconfirmedConversationSubmissionError);
  assert.deepEqual(f.journal.read(f.scope), f.record);
});

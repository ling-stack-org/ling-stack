import assert from "node:assert/strict";
import test from "node:test";
import { channelSessionSelection, channelSessionThreadId, channelSessionUnread, isChannelSessionDraft, reconcileSessionReadWatermarks, sessionStatus } from "../src/app/channel-session-state.ts";
import { channelDraftStorageKey, readChannelComposerDraft, restorableChannelAttachments, writeChannelComposerDraft } from "../src/features/workspace/channel-composer-draft-storage.ts";

test("canonical session navigation never interprets a legacy branch or draft as a thread", () => {
  assert.equal(channelSessionThreadId(channelSessionSelection("thread-A")), "thread-A");
  assert.equal(channelSessionThreadId("channel_branch_A"), undefined);
  assert.equal(channelSessionThreadId("session-draft:request-A"), undefined);
  assert.equal(isChannelSessionDraft("session-draft:request-A"), true);
});

test("first upgrade establishes each thread baseline and reading A preserves B unread", () => {
  const baseline = reconcileSessionReadWatermarks({}, [{ id: "A", latestNotificationRevision: 4 }, { id: "B", latestNotificationRevision: 9 }]);
  assert.equal(channelSessionUnread([{ id: "B", latestNotificationRevision: 9 }], baseline), false);
  const changed = [{ id: "A", latestNotificationRevision: 5 }, { id: "B", latestNotificationRevision: 10 }];
  assert.equal(channelSessionUnread(changed, baseline), true);
  const readA = { ...baseline, A: 5 };
  assert.equal(channelSessionUnread(changed, readA), true);
  assert.equal(channelSessionUnread(changed, { ...readA, B: 10 }), false);
  assert.deepEqual(reconcileSessionReadWatermarks(readA, changed), readA);
});

test("session status retains actionable approval and terminal failure precedence", () => {
  assert.equal(sessionStatus({ runtimeState: "running", pendingApprovalCount: 1 }), "waiting");
  assert.equal(sessionStatus({ runtimeState: "blocked", pendingApprovalCount: 0 }), "blocked");
  assert.equal(sessionStatus({ runtimeState: "failed", pendingApprovalCount: 0 }), "failed");
  assert.equal(sessionStatus({ runtimeState: "queued", pendingApprovalCount: 0 }), "queued");
});

test("draft storage keeps uploaded references and requires missing local files to be selected again", () => {
  const attachment = { id: "asset-A", channelId: "channel-A" };
  const restored = restorableChannelAttachments([
    { localId: "A", fileName: "uploaded.txt", sizeBytes: 7, state: "ready", attachment, previewUrl: "blob:A", sourceFile: {} },
    { localId: "B", fileName: "pending.txt", sizeBytes: 10, state: "uploading", previewUrl: "blob:B", sourceFile: {} },
  ]);
  assert.equal(restored[0].attachment, attachment);
  assert.equal(restored[0].sourceFile, undefined);
  assert.equal(restored[0].previewUrl, undefined);
  assert.equal(restored[1].state, "failed");
  assert.match(restored[1].error, /again/);
});

test("workspace/channel/thread draft keys isolate saved text, assets, and failed sends", () => {
  const entries = new Map();
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  try {
    const A = JSON.stringify(["/workspace-1", "channel", "A"]);
    const B = JSON.stringify(["/workspace-1", "channel", "B"]);
    const otherWorkspace = JSON.stringify(["/workspace-2", "channel", "A"]);
    writeChannelComposerDraft(A, { messageDraft: "A text", pendingAttachments: [], sendState: "sending" });
    writeChannelComposerDraft(B, { messageDraft: "B text", pendingAttachments: [], sendState: "failed", sendError: "B failure" });
    assert.equal(readChannelComposerDraft(A).messageDraft, "A text");
    assert.equal(readChannelComposerDraft(A).sendState, "idle");
    assert.equal(readChannelComposerDraft(B).sendError, "B failure");
    assert.equal(readChannelComposerDraft(otherWorkspace), undefined);
    entries.set(channelDraftStorageKey(otherWorkspace), "malformed");
    assert.equal(readChannelComposerDraft(otherWorkspace), undefined);
  } finally { delete globalThis.localStorage; }
});

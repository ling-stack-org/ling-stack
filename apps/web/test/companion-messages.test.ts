import assert from "node:assert/strict";
import test from "node:test";
import type { TeammateDirectMessage } from "@ling-stack/contracts";
import { mergeCompanionMessages } from "../src/features/companions/companion-messages.ts";

const message: TeammateDirectMessage = {
  id: "reply", workspaceId: "workspace", threadId: "thread", teammateId: "teammate",
  authorType: "ai-teammate", body: "Hello", status: "pending", attachmentIds: [], linkPreviewIds: [], fileRefs: [],
  createdAt: "2026-11-16T01:00:00.000Z", updatedAt: "2026-11-16T01:00:01.000Z",
};

test("late history responses cannot roll back streamed text or reopen a terminal reply", () => {
  const stale = { ...message, body: "He", updatedAt: message.createdAt };
  assert.deepEqual(mergeCompanionMessages([message], [stale]), [message]);
  const ready = { ...message, body: "Hello!", status: "ready" as const };
  assert.deepEqual(mergeCompanionMessages([message], [ready]), [ready]);
  assert.deepEqual(mergeCompanionMessages([ready], [message]), [ready]);
});

test("merging history and streamed messages deduplicates IDs and retains older pages", () => {
  const earlier = { ...message, id: "earlier", body: "Older" };
  assert.deepEqual(mergeCompanionMessages([earlier, message], [message]), [earlier, message]);
});

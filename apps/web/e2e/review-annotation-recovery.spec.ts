import { expect, test } from "@playwright/test";
import type { ChannelMessageFileRef } from "@ling-stack/contracts";
import type { submitNormalConversationGuidance } from "../src/features/workspace/normal-conversation-guidance-controller";
import { mountReviewPage, remountReviewPage } from "./support/review-test-helpers";

for (const changed of [false, true]) test(`normal guidance recovery compares canonical comments and retains changed drafts=${changed}`, async ({ page }) => {
  let reads = 0;
  await page.route(/\/runs\/review-run\/interventions(?:\?.*)?$/u, route => {
    expect(route.request().method()).toBe("GET");
    reads += 1;
    return route.fulfill({ json: { cwd: "/workspace", idempotencyKey: "review-receipt", interventions: [{
      id: "accepted-review", sourceRunId: "review-run", mode: "queue_followup", idempotencyKey: "review-receipt", instruction: "Review",
      messagePayload: { body: "Review", attachmentIds: [], linkPreviewIds: [], fileRefs: [{
        path: "src/main.ts", source: "composer", line: 3,
        annotation: { kind: "code", id: "accepted", text: "Check this", side: "right", startLine: 2 },
      }] },
    }] } });
  });
  await page.goto("/e2e/support/p2-reading.html?manual");
  const result = await page.evaluate(async changed => {
    const controllerPath = "/src/features/workspace/normal-conversation-guidance-controller.ts";
    const journalPath = "/src/shared/conversation/conversation-submission-journal.ts";
    const draftPath = "/src/shared/conversation/review/review-draft.ts";
    const { submitNormalConversationGuidance: submit } = await import(/* @vite-ignore */ controllerPath) as { submitNormalConversationGuidance: typeof submitNormalConversationGuidance };
    const { guidanceLookupJournal } = await import(/* @vite-ignore */ journalPath);
    const { acknowledgeReviewDraft } = await import(/* @vite-ignore */ draftPath) as typeof import("../src/shared/conversation/review/review-draft");
    guidanceLookupJournal.remember({ cwd: "/workspace", surface: "normal", ownerId: "review-thread" }, {
      key: "review-receipt", sourceId: "review-run", threadId: "review-thread", mode: "queue_followup",
    });
    const ref: ChannelMessageFileRef = { path: "src/main.ts", source: "composer", line: 3,
      annotation: { kind: "code", id: "accepted", side: "right", startLine: 2, text: "Check this" } };
    const fileRefs: readonly ChannelMessageFileRef[] = changed ? [ref,
      { ...ref, annotation: { ...ref.annotation!, id: "additional", text: "More feedback" } },
    ] : [ref];
    const identity = { surface: "normal_conversation", workspaceCwd: "/workspace", threadId: "review-thread", identity: "review-thread" } as const;
    const errors: string[] = [];
    let clearDraft = false;
    let remaining = fileRefs;
    let refreshed = false;
    const attachmentController = { pendingAttachments: [], readyAttachmentIds: [], attachFiles: async () => {}, removeAttachment: async () => {},
        retryAttachment: async () => {}, cleanupFailures: [], retryCleanup: async () => {}, consumeForSend: () => [], protectForSubmission: items => items.map(item => ({ ...item, deleteOnRemove: false })),
        markSendBound() {}, restoreForIdentity: () => true, abandonSend() {}, releasePreviews() {} } satisfies Parameters<typeof submit>[0]["attachmentController"];
    await submit({ activeReply: undefined, threadId: "review-thread", workspaceCwd: "/workspace", body: "Review", fileRefs, notReadyMessage: "Not ready",
      attachmentController,
      identityController: { identity: "review-thread", ownerKey: "owner", ready: true, capture: () => identity, isCurrent: () => true, createCommitGuard: () => () => true },
      operationOwner: { busy: false, begin: value => ({ requestId: 1, ownerKey: "owner", value }), finish() {} },
      actionFeedback: { message: "", messageFor: () => "", clear() {}, report: (_scope, message) => errors.push(message) },
      onAccepted: () => { throw new Error("Unexpected new submission"); },
      onInputAccepted: accepted => { remaining = acknowledgeReviewDraft(fileRefs, accepted); },
      onRecovered: clear => { clearDraft = clear; },
      refresh: async () => { refreshed = true; },
    });
    return { clearDraft, remaining: remaining.map(ref => ref.annotation?.id), errors, refreshed };
  }, changed);
  expect(result).toEqual({ clearDraft: !changed, remaining: changed ? ["additional"] : [], errors: [], refreshed: true });
  expect(reads).toBe(1);
});

test("unfinished code text restores and empty shelf edits block sending", async ({ page }) => {
  await mountReviewPage(page);
  await page.getByRole("button", { name: "Comment on line 2", exact: true }).last().click();
  const pending = page.locator(".code-review-comment-editor");
  await pending.getByRole("textbox").fill("Still drafting");
  await page.reload(); await remountReviewPage(page);
  await expect(pending.getByRole("textbox")).toHaveValue("Still drafting");
  await pending.getByRole("button", { name: "Add comment", exact: true }).click();
  const shelf = page.getByRole("region", { name: "Review feedback" });
  await shelf.getByRole("textbox").fill("");
  await expect(shelf.getByRole("button", { name: "Send feedback" })).toBeDisabled();
  await page.reload(); await remountReviewPage(page);
  await expect(shelf.getByRole("textbox")).toHaveValue("");
  await shelf.getByRole("textbox").fill("Finished comment");
  await shelf.getByRole("button", { name: "Send feedback" }).click();
  await expect(shelf).toHaveCount(0);
});

test("late acceptance clears the departed owner and preserves edits made while sending", async ({ page }) => {
  await mountReviewPage(page);
  await page.getByRole("button", { name: "Comment on line 2", exact: true }).last().click();
  await page.locator(".code-review-comment-editor").getByRole("textbox").fill("Original comment");
  await page.locator(".code-review-comment-editor").getByRole("button", { name: "Add comment", exact: true }).click();
  const shelf = page.getByRole("region", { name: "Review feedback" });
  await page.getByRole("button", { name: "Defer next send" }).click();
  await shelf.getByRole("button", { name: "Send feedback" }).click();
  await shelf.getByRole("textbox").fill("Edited during send");
  await page.getByRole("button", { name: "Accept deferred" }).click();
  await expect(shelf.getByRole("textbox")).toHaveValue("Edited during send");
  await shelf.getByRole("button", { name: "Send feedback" }).click();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await page.getByRole("button", { name: "Accept deferred" }).click();
  await expect(shelf).toHaveCount(0);
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(shelf).toHaveCount(0);
  expect(await page.evaluate(() => window.reviewHarness.accepted().length)).toBe(2);
});

import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

export function assertWorkItemConversationAdmission(store: RunStore, threadId: string, submissionKey: string | undefined, automaticIntakeReceiptId?: string): void {
  try {
    store.checkWorkItemConversationAdmission(threadId, submissionKey, automaticIntakeReceiptId);
  } catch (error) {
    if (error instanceof Error && (error.message === "work_item_dispatch_held" || error.message === "work_item_dispatch_intent_required")) {
      throw new HttpError(409, error.message, "The Work Item cannot admit this conversation execution.");
    }
    throw error;
  }
}

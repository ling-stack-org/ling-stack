import { DEFAULT_WORKSPACE_ID, userInputRequestEventKey, type RunStore, type UserInputAnswerReceipt, type UserInputRequest } from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";

export function publishUserInputRequestChange(
  store: Pick<RunStore, "getControlPlaneEventByIdempotency">,
  hub: ControlPlaneEventHub | undefined,
  request: Pick<UserInputRequest, "requestId" | "statusRevision">,
): void {
  if (!hub) return;
  try {
    const event = store.getControlPlaneEventByIdempotency(DEFAULT_WORKSPACE_ID, userInputRequestEventKey(request));
    if (event) hub.publish(event);
  } catch {
    // The request transaction has committed. Subscribers can recover from the durable cursor.
  }
}

export function publishUserInputAnswerAcceptance(
  store: RunStore, hub: ControlPlaneEventHub, threadId: string, receipt: UserInputAnswerReceipt,
): void {
  if (receipt.replayed) return;
  try {
    const request = store.getUserInputRequest(threadId, receipt.requestId);
    if (request?.status === "answered") publishUserInputRequestChange(store, hub, request);
  } catch {
    // The accepted answer and its event remain in the store.
  }
}

import type { UserInputAnswerCommandV1 } from "@ling-stack/contracts";
import type { RunStore, UserInputAnswerReceipt } from "@ling-stack/core";

export type UserInputAnswerAcceptedHook = (store: RunStore, threadId: string, receipt: UserInputAnswerReceipt) => void;

export function submitAuthorizedUserInputAnswer(store: RunStore, command: UserInputAnswerCommandV1, now: string): UserInputAnswerReceipt {
  const { authority, idempotencyKey, answers } = command;
  return store.submitUserInputAnswer({
    threadId: authority.threadId,
    authority,
    submission: {
      schemaVersion: 1,
      requestId: authority.requestId,
      expectedVersion: authority.requestVersion,
      expectedStatusRevision: authority.statusRevision,
      idempotencyKey,
      answers,
    },
  }, now);
}

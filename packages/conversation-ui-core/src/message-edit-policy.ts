import { getConversationSurfacePolicy, type ConversationSurfaceKind } from "./surface-policy.js";

export type ConversationMessageEditAuthor = "local-user" | "assistant" | "teammate" | "system";

export interface ConversationMessageEditCandidate {
  readonly id: string;
  readonly surface: ConversationSurfaceKind;
  readonly ownerId: string;
  readonly laneId: string;
  readonly author: ConversationMessageEditAuthor;
  readonly revision: number;
  readonly readOnly?: boolean;
  readonly superseded?: boolean;
}

export interface ConversationMessageEditScope {
  readonly surface: ConversationSurfaceKind;
  readonly ownerId: string;
  readonly laneId: string;
}

export function findLatestEditableConversationMessage(
  messages: readonly ConversationMessageEditCandidate[],
  scope: ConversationMessageEditScope,
): ConversationMessageEditCandidate | undefined {
  if (!getConversationSurfacePolicy(scope.surface).allowLatestUserMessageEdit) {
    return undefined;
  }

  const latest = findLatestLocalUserMessage(messages, scope);
  if (!latest || latest.readOnly === true) {
    return undefined;
  }
  return latest;
}

function findLatestLocalUserMessage(
  messages: readonly ConversationMessageEditCandidate[],
  scope: ConversationMessageEditScope,
): ConversationMessageEditCandidate | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.surface !== scope.surface ||
      message.ownerId !== scope.ownerId ||
      message.laneId !== scope.laneId ||
      message.author !== "local-user" ||
      message.superseded === true
    ) {
      continue;
    }
    return message;
  }
  return undefined;
}

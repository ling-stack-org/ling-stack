import type {
  ConversationDomainRef,
  ConversationItemV1,
  ConversationUserMessagePayloadV1,
} from "@ling-stack/contracts";
import type { LingTurnKind } from "./run-types.js";

export interface AppendConversationUserTurnInput {
  readonly itemId?: string;
  readonly turnId?: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly turnKind?: LingTurnKind;
  readonly title: string;
  readonly userInstruction: string;
  readonly actorId?: string;
  readonly payload: ConversationUserMessagePayloadV1;
  readonly domainRefs?: readonly ConversationDomainRef[];
  readonly sourceTurnId?: string;
  readonly supersedesItemId?: string;
  readonly idempotencyKey: string;
}

export interface AppendConversationUserTurnResult {
  readonly turnId: string;
  readonly item: ConversationItemV1;
  readonly contextSegmentId: string;
  readonly idempotentReplay: boolean;
}

import type {
  ConversationDomainRef,
  ConversationItemActorTypeV1,
  ConversationItemKindV1,
  ConversationItemPayloadByKindV1,
  ConversationItemStatusV1,
  ConversationItemV1,
  ConversationItemVisibilityV1,
} from "@ling-stack/contracts";

export interface AppendConversationItemInput<K extends ConversationItemKindV1 = ConversationItemKindV1> {
  readonly id?: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly kind: K;
  readonly status?: ConversationItemStatusV1;
  readonly actorType: ConversationItemActorTypeV1;
  readonly actorId?: string;
  readonly visibility: ConversationItemVisibilityV1;
  readonly visibilityOwnerId?: string;
  readonly payload: ConversationItemPayloadByKindV1[K];
  readonly domainRefs?: readonly ConversationDomainRef[];
  readonly idempotencyKey?: string;
  readonly supersedesItemId?: string;
}

export type AppendConversationItem = {
  readonly [K in ConversationItemKindV1]: AppendConversationItemInput<K>;
}[ConversationItemKindV1];

export interface UpdatePendingConversationItemInput<K extends ConversationItemKindV1 = ConversationItemKindV1> {
  readonly expectedRevision: number;
  readonly payload: ConversationItemPayloadByKindV1[K];
  readonly status?: "pending" | "committed" | "failed";
}

export interface ListConversationItemsOptions {
  readonly threadId: string;
  readonly beforeSequence?: number;
  readonly effectiveOnly?: boolean;
  readonly limit?: number;
}

export interface ConversationItemListPage {
  readonly items: readonly ConversationItemV1[];
  readonly nextBeforeSequence?: number;
}

export interface ListConversationItemsByChannelOptions {
  readonly channelId: string;
  readonly threadId?: string;
  readonly excludeThreadIds?: readonly string[];
  readonly beforeItemId?: string;
  readonly kinds?: readonly ConversationItemKindV1[];
  readonly effectiveOnly?: boolean;
  readonly limit?: number;
}

export interface ConversationItemChannelListPage {
  readonly items: readonly ConversationItemV1[];
  readonly hasMore: boolean;
  readonly nextBeforeItemId?: string;
}

export interface ListConversationItemsForSegmentOptions {
  readonly threadId: string;
  readonly segmentId: string;
  readonly throughSequence: number;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface FindConversationItemByDomainRefInput {
  readonly threadId: string;
  readonly ref: ConversationDomainRef;
  readonly beforeSequence?: number;
}

export interface ListConversationItemsForTurnOptions {
  readonly turnId: string;
}

export type ConversationItemStoreErrorCode =
  | "thread_not_found"
  | "thread_archived"
  | "turn_not_found"
  | "turn_thread_mismatch"
  | "channel_thread_mismatch"
  | "item_invalid"
  | "item_not_found"
  | "item_not_pending"
  | "item_revision_conflict"
  | "item_id_conflict"
  | "item_sequence_conflict"
  | "idempotency_conflict"
  | "supersession_invalid"
  | "supersession_conflict";

export class ConversationItemStoreError extends Error {
  readonly code: ConversationItemStoreErrorCode;

  constructor(code: ConversationItemStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationItemStoreError";
    this.code = code;
  }
}

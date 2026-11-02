import { createHash } from "node:crypto";
import type { ChannelIntentPendingOperationV1 } from "@ling-stack/contracts";
import type { ChannelIntentDecision } from "./workspace-types.js";

/** Content identity, not a permission token. Only the root digest is excluded. */
export function channelPendingOperationFingerprintV1(value: Omit<ChannelIntentPendingOperationV1, "fingerprint"> | ChannelIntentPendingOperationV1): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item)
      .filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonical(value)])) : item;
  const { fingerprint: _fingerprint, ...snapshot } = value as ChannelIntentPendingOperationV1;
  return createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex");
}

export interface ResolveChannelPendingOperationInput {
  readonly pendingDecisionId: string;
  readonly expectedDraftFingerprint: string;
  readonly answerItemId: string;
  readonly expectedAnswerRevision: number;
  readonly expectedQuestionRevision: number;
}

export interface ChannelPendingOperationResolution {
  readonly pendingDecisionId: string;
  readonly draftFingerprint: string;
  readonly answerItemId: string;
  readonly answerRevision: number;
  readonly questionRevision: number;
  readonly decisionId: string;
  readonly createdAt: string;
}

export interface ChannelPendingOperationResolved {
  readonly decision: ChannelIntentDecision;
  readonly replayed: boolean;
}

export interface GetChannelPendingAuthorityVersionsInput {
  readonly workspaceId: string;
  readonly channelId: string;
  /** Actual effective channel participants, including the coordinator; not labels or aliases. */
  readonly participantIds: readonly string[];
}

/** Durable policy lineage, separate from timestamps and current configuration equality. */
export interface ChannelPendingAuthorityVersions {
  readonly workspaceRevision: number;
  readonly channelRevision: number;
  readonly participants: readonly { readonly participantId: string; readonly revision: number }[];
}

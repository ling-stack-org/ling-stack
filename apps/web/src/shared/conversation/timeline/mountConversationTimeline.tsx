import type { ReactNode } from "react";
import {
  fingerprintConversationTimeline,
  type TimelineSnapshot,
} from "@ling-stack/conversation-ui-core";
import { ConversationTimeline, type ConversationTimelineProps } from "./ConversationTimeline.js";

export interface ConversationTimelineMountInput extends Omit<ConversationTimelineProps, "snapshot"> {
  readonly snapshot: TimelineSnapshot;
}

export interface ConversationTimelineMount {
  readonly node: ReactNode;
  readonly fingerprint: ReturnType<typeof fingerprintConversationTimeline>;
}

/**
 * The only composition entry point for a surface transcript. Adapters provide
 * an already-scoped snapshot and Host callbacks; this function never sorts,
 * projects, fetches, or adds a second activity owner.
 */
export function mountConversationTimeline(
  input: ConversationTimelineMountInput,
): ConversationTimelineMount {
  return {
    node: <ConversationTimeline {...input} />,
    fingerprint: fingerprintConversationTimeline(input.snapshot.items),
  };
}

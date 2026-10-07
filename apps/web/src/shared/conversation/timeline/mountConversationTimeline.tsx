import { useMemo, type ReactNode } from "react";
import {
  fingerprintConversationTimeline,
  type TimelineSnapshot,
} from "@ling-stack/conversation-ui-core";
import { ConversationTimeline, type ConversationTimelineProps } from "./ConversationTimeline.js";
import type { ConversationViewRetainKeys } from "../view-store/conversation-view-store.js";
import {
  ConversationViewProvider,
  useOptionalConversationViewStore,
} from "../view-store/conversation-view-provider.js";
import { useConversationViewReconciliation } from "../view-store/use-conversation-view-reconciliation.js";
import { collectConversationTimelineViewRetainKeys } from "./conversation-timeline-view-retain-keys.js";

export interface ConversationTimelineMountInput extends Omit<ConversationTimelineProps, "snapshot"> {
  readonly snapshot: TimelineSnapshot;
  /** Existing surface keys that must remain live beside typed Timeline keys. */
  readonly viewStateRetainKeys?: ConversationViewRetainKeys;
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
    node: <ConversationTimelineMountRoot {...input} />,
    fingerprint: fingerprintConversationTimeline(input.snapshot.items),
  };
}

function ConversationTimelineMountRoot({
  viewStateRetainKeys,
  ...timelineProps
}: ConversationTimelineMountInput): React.JSX.Element {
  const existingStore = useOptionalConversationViewStore();
  if (existingStore) {
    return (
      <ConversationTimelineOwnedMount
        {...timelineProps}
        viewStateRetainKeys={viewStateRetainKeys}
      />
    );
  }
  const surfaceId = [
    "timeline",
    timelineProps.snapshot.scope.kind,
    timelineProps.snapshot.scope.threadId,
    timelineProps.snapshot.scope.anchorItemId ?? "root",
  ].join(":");
  return (
    <ConversationViewProvider surfaceId={surfaceId}>
      <ConversationTimelineOwnedMount
        {...timelineProps}
        viewStateRetainKeys={viewStateRetainKeys}
      />
    </ConversationViewProvider>
  );
}

function ConversationTimelineOwnedMount({
  viewStateRetainKeys,
  ...timelineProps
}: ConversationTimelineMountInput): React.JSX.Element {
  const retainKeys = useMemo(
    () => collectConversationTimelineViewRetainKeys(timelineProps.snapshot.items, viewStateRetainKeys),
    [timelineProps.snapshot.items, viewStateRetainKeys],
  );
  useConversationViewReconciliation(retainKeys);
  return <ConversationTimeline {...timelineProps} />;
}

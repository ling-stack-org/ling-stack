export interface ChannelReplyLaneKey {
  readonly workspaceId: string;
  readonly channelId: string;
}

export type ChannelReplyLaneClaim = ChannelReplyLaneOwner | ChannelReplyLaneFollower;

export interface ChannelReplyLaneOwner {
  readonly kind: "owner";
  readonly sourceMessageId: string;
  linkRun(runId: string): void;
  release(): void;
}

export interface ChannelReplyLaneFollower {
  readonly kind: "follower";
  readonly sourceMessageId: string;
  waitForRun(): Promise<string | undefined>;
}

interface PendingChannelReplyLane {
  readonly sourceMessageId: string;
  readonly outcome: Promise<string | undefined>;
  settled: boolean;
  settle(runId?: string): void;
}

export class ChannelReplyDispatchCoordinator {
  private readonly lanes = new Map<string, PendingChannelReplyLane>();
  private readonly messageClassifications = new Map<string, number>();

  beginMessageClassification(workspaceId: string, sourceMessageId: string): () => void {
    const key = serializeMessageKey(workspaceId, sourceMessageId);
    this.messageClassifications.set(key, (this.messageClassifications.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.messageClassifications.get(key) ?? 0;
      if (count <= 1) {
        this.messageClassifications.delete(key);
      } else {
        this.messageClassifications.set(key, count - 1);
      }
    };
  }

  isMessageClassificationPending(workspaceId: string, sourceMessageId: string): boolean {
    return this.messageClassifications.has(serializeMessageKey(workspaceId, sourceMessageId));
  }

  claim(key: ChannelReplyLaneKey, sourceMessageId: string): ChannelReplyLaneClaim {
    const laneKey = serializeLaneKey(key);
    const existing = this.lanes.get(laneKey);
    if (existing) {
      return {
        kind: "follower",
        sourceMessageId: existing.sourceMessageId,
        waitForRun: () => existing.outcome,
      };
    }

    let settleOutcome: (runId?: string) => void = () => undefined;
    const lane: PendingChannelReplyLane = {
      sourceMessageId,
      outcome: new Promise<string | undefined>((resolve) => {
        settleOutcome = resolve;
      }),
      settled: false,
      settle: (runId) => {
        if (lane.settled) return;
        lane.settled = true;
        this.lanes.delete(laneKey);
        settleOutcome(runId);
      },
    };
    this.lanes.set(laneKey, lane);
    return {
      kind: "owner",
      sourceMessageId,
      linkRun: (runId) => lane.settle(runId),
      release: () => lane.settle(),
    };
  }

  close(): void {
    for (const lane of [...this.lanes.values()]) {
      lane.settle();
    }
    this.lanes.clear();
    this.messageClassifications.clear();
  }
}

function serializeLaneKey(key: ChannelReplyLaneKey): string {
  return JSON.stringify([key.workspaceId, key.channelId]);
}

function serializeMessageKey(workspaceId: string, sourceMessageId: string): string {
  return JSON.stringify([workspaceId, sourceMessageId]);
}

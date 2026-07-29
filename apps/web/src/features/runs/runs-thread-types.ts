import type {
  LingThread,
  LingTurn,
  LingTurnRun,
  RunSession,
} from "../../types.js";

export type WorkHistoryTurnLoadState =
  | { readonly status: "loading"; readonly signature: string }
  | {
      readonly status: "loaded";
      readonly turns: readonly LingTurn[];
      readonly runLinks: readonly LingTurnRun[];
      readonly signature: string;
    }
  | { readonly status: "failed"; readonly error: string; readonly signature: string };

export interface WorkHistoryTurnAttempt {
  readonly run: RunSession;
  readonly attemptNumber: number;
  readonly role: LingTurnRun["role"] | "legacy";
  readonly linkedAt: string;
}

export interface WorkHistoryTurnGroup {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly title: string;
  readonly status: string;
  readonly runIds: readonly string[];
  readonly latestRunId: string;
  readonly attemptCount: number;
  readonly updatedAt: string;
  readonly source: "durable_turn" | "legacy_thread";
  readonly attempts: readonly WorkHistoryTurnAttempt[];
  readonly thread: LingThread | undefined;
}

export interface WorkHistoryTurnContext {
  readonly group: WorkHistoryTurnGroup;
  readonly turn: LingTurn;
}

export interface WorkHistoryTreeRow {
  readonly group: WorkHistoryTurnGroup;
  readonly depth: number;
  readonly parentHidden: boolean;
}

export type ThreadListLoadState = "idle" | "loading-initial" | "refreshing" | "ready" | "stale" | "failed" | "legacy";

export interface ThreadRequestIdentity {
  readonly cwd: string;
  readonly objectId: string;
  readonly revision: number;
}

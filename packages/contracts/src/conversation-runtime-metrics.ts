/** Runtime facts from the effective, owner-scoped linked runs of a conversation. */
export interface ConversationRuntimeMetrics {
  /** Observed assistant generation rounds (`turn_start`), not human conversation turns. */
  readonly aiRounds: number | null;
  /** Observed started tool executions. */
  readonly toolSteps: number | null;
  /** Sum of measured provider usage; null if no usage was reported. */
  readonly totalTokens: number | null;
  /** Uncached input tokens; Pi separates cache-read and cache-write input. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** Latest observed output tokens / turn_start→message_end elapsed; includes tool time. */
  readonly recentReplyTokensPerSecond: number | null;
  readonly context: {
    /** Latest measured provider input = uncached input + cache-read + cache-write. */
    readonly measuredInputTokens: number | null;
    readonly capacityTokens: number | null;
    /** Latest SDK compaction estimate, never presented as measured usage. */
    readonly estimatedTokens: number | null;
    readonly basis: "measured" | "estimated" | "unavailable";
  };
  /** Partial means a linked run has missing event/usage evidence or an uncompleted response. */
  readonly coverage: "complete" | "partial" | "unavailable";
}

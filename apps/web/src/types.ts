export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type RunEventType =
  | "run_created"
  | "run_start"
  | "turn_start"
  | "turn_end"
  | "assistant_text_delta"
  | "assistant_thinking_delta"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "run_end"
  | "run_error"
  | "run_cancelled"
  | "result";

export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RunEventType;
  readonly data: unknown;
}

export interface RunSession {
  readonly id: string;
  readonly status: RunStatus;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly eventLogPath: string;
  readonly summaryPath?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt: string;
}

export interface RunEventsResponse {
  readonly runId: string;
  readonly events: readonly RunEventEnvelope[];
  readonly nextSeq: number;
}

export type ToolName = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

export interface RunFormState {
  readonly cwd: string;
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly api: string;
  readonly tools: readonly ToolName[];
}

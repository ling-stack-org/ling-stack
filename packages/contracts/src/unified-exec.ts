export type UnifiedExecCommand =
  | {
      readonly kind: "shell";
      readonly command: string;
      readonly shell?: string;
    }
  | {
      readonly kind: "argv";
      readonly argv: readonly string[];
    };

export type UnifiedExecEnvironmentMode = "inherit_minimal" | "inherit_run" | "explicit";

export interface UnifiedExecEnvironmentPolicy {
  readonly mode: UnifiedExecEnvironmentMode;
  readonly extraEnv?: Record<string, string | undefined>;
}

export interface UnifiedExecEnvironmentSummary {
  readonly mode: UnifiedExecEnvironmentMode;
  readonly cwd: string;
  readonly keys: readonly string[];
  readonly redactedKeys: readonly string[];
  readonly pathEntryCount?: number;
}

export interface UnifiedExecRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly approvalId?: string;
  readonly cwd: string;
  readonly command: UnifiedExecCommand;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly pty?: boolean;
  readonly maxInlineBytes?: number;
  readonly environment?: UnifiedExecEnvironmentPolicy;
  readonly startedBy: "run_tool";
}

export interface UnifiedExecOutputChunk {
  readonly toolCallId: string;
  readonly stream: "stdout" | "stderr";
  readonly sequence: number;
  readonly text: string;
  readonly byteCount: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly ts: string;
}

export interface UnifiedExecArtifactSummary {
  readonly artifactId: string;
  readonly role: "result" | "stdout" | "stderr" | "combined";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

export type UnifiedExecStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

export interface UnifiedExecStreamSummary {
  readonly byteCount: number;
  readonly lineCount?: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly artifactId?: string;
}

export interface UnifiedExecResult {
  readonly status: UnifiedExecStatus;
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly approvalId?: string;
  readonly cwd: string;
  readonly command: UnifiedExecCommand;
  readonly environmentSummary: UnifiedExecEnvironmentSummary;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: UnifiedExecStreamSummary;
  readonly stderr: UnifiedExecStreamSummary;
  readonly artifacts: readonly UnifiedExecArtifactSummary[];
}

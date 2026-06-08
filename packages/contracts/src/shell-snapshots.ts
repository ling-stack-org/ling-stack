import type { UnifiedExecEnvironmentSummary } from "./unified-exec.js";

export type ShellSnapshotSource =
  | "exec_start"
  | "exec_first_output"
  | "exec_periodic"
  | "exec_timeout"
  | "exec_cancel"
  | "exec_end";

export type ShellSnapshotStatus =
  | "starting"
  | "running"
  | "exited"
  | "cancelled"
  | "timed_out"
  | "failed";

export interface ShellSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly approvalId?: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly source: ShellSnapshotSource;
  readonly status: ShellSnapshotStatus;
  readonly command: ShellCommandSnapshot;
  readonly process?: ShellProcessSnapshot;
  readonly terminal?: ShellTerminalSnapshot;
  readonly output: ShellOutputSnapshot;
  readonly artifacts: readonly ShellSnapshotArtifactSummary[];
  readonly redaction: ShellSnapshotRedactionSummary;
}

export interface ShellCommandSnapshot {
  readonly cwd: string;
  readonly commandKind: "shell" | "argv";
  readonly commandPreview: string;
  readonly argvPreview?: readonly string[];
  readonly shell?: string;
  readonly pty: boolean;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly environmentSummary: UnifiedExecEnvironmentSummary;
}

export interface ShellProcessSnapshot {
  readonly pid?: number;
  readonly processGroupId?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface ShellTerminalSnapshot {
  readonly rows?: number;
  readonly cols?: number;
  readonly visibleText?: string;
  readonly cursorRow?: number;
  readonly cursorCol?: number;
}

export interface ShellOutputSnapshot {
  readonly stdoutHead?: string;
  readonly stdoutTail?: string;
  readonly stderrHead?: string;
  readonly stderrTail?: string;
  readonly stdoutByteCount: number;
  readonly stderrByteCount: number;
  readonly stdoutLineCount?: number;
  readonly stderrLineCount?: number;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly truncated: boolean;
}

export interface ShellSnapshotArtifactSummary {
  readonly artifactId: string;
  readonly role: "snapshot_json" | "snapshot_text" | "stdout" | "stderr" | "combined" | "exec_result";
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface ShellSnapshotRedactionSummary {
  readonly redacted: boolean;
  readonly extraSecretCount: number;
  readonly commandRedacted: boolean;
  readonly stdoutRedacted: boolean;
  readonly stderrRedacted: boolean;
  readonly environmentValuesStored: false;
}

export interface ShellSnapshotListItem {
  readonly id: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly source: ShellSnapshotSource;
  readonly status: ShellSnapshotStatus;
  readonly commandPreview: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly artifactId: string;
  readonly textArtifactId?: string;
}

export interface ShellSnapshotListResponse {
  readonly runId: string;
  readonly snapshots: readonly ShellSnapshotListItem[];
}

export interface ShellSnapshotResponse {
  readonly snapshot: ShellSnapshot;
  readonly artifactId: string;
  readonly textArtifactId?: string;
}

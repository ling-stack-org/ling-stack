export type WorkspaceTerminalCommandStatus = "succeeded" | "failed" | "timed_out";

export interface WorkspaceTerminalCommandRequest {
  readonly command: string;
}

export interface WorkspaceTerminalProfileResponse {
  readonly cwd: string;
  readonly workspaceLabel: string;
  readonly promptLabel: string;
  readonly username?: string;
  readonly hostname?: string;
  readonly shell?: string;
}

export interface WorkspaceTerminalCommandResponse {
  readonly id: string;
  readonly cwd: string;
  readonly command: string;
  readonly status: WorkspaceTerminalCommandStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

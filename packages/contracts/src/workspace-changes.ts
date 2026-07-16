import type { WorkspaceGitFileKind, WorkspaceGitStatusState } from "./channels.js";

export interface WorkspaceChangeFile {
  readonly path: string;
  readonly originalPath?: string;
  readonly kind: WorkspaceGitFileKind;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly diff?: string;
  readonly truncated: boolean;
}

export interface WorkspaceChangesResponse {
  readonly cwd: string;
  readonly state: WorkspaceGitStatusState;
  readonly repoRoot?: string;
  readonly branchName?: string;
  readonly upstream?: string;
  readonly headSha?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly files: readonly WorkspaceChangeFile[];
  readonly totalFileCount: number;
  readonly truncated: boolean;
  readonly checkedAt: string;
  readonly unavailableReason?: string;
  readonly errorMessage?: string;
}

export type RunWorkspaceChangeState = "applied" | "undone" | "conflicted" | "unavailable";

export interface RunWorkspaceChangeFile {
  readonly path: string;
  readonly operationCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface RunWorkspaceChangeSummary {
  readonly fileCount: number;
  readonly addCount: number;
  readonly updateCount: number;
  readonly deleteCount: number;
  readonly moveCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface RunWorkspaceChangesResponse {
  readonly cwd: string;
  readonly runId: string;
  readonly state: RunWorkspaceChangeState;
  readonly canUndo: boolean;
  readonly canReapply: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: RunWorkspaceChangeSummary;
  readonly unavailableReason?: string;
  readonly updatedAt: string;
}

export interface WorkflowWorkspaceChangesResponse {
  readonly cwd: string;
  readonly workflowId: string;
  readonly runIds: readonly string[];
  readonly state: RunWorkspaceChangeState;
  readonly canUndo: boolean;
  readonly canReapply: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: RunWorkspaceChangeSummary;
  readonly unavailableReason?: string;
  readonly updatedAt: string;
}

export type WorkspaceFileOpenTarget =
  | "vscode"
  | "cursor"
  | "zed"
  | "sublime_text"
  | "textedit"
  | "xcode"
  | "pycharm"
  | "webstorm"
  | "intellij"
  | "finder"
  | "terminal";

export interface WorkspaceFileOpenOption {
  readonly id: WorkspaceFileOpenTarget;
  readonly label: string;
  readonly available: boolean;
}

export interface WorkspaceFileOpenOptionsResponse {
  readonly cwd: string;
  readonly path: string;
  readonly options: readonly WorkspaceFileOpenOption[];
}

export interface WorkspaceFileOpenRequest {
  readonly target: WorkspaceFileOpenTarget;
  readonly line?: number;
}

export interface WorkspaceFileOpenResponse {
  readonly cwd: string;
  readonly path: string;
  readonly target: WorkspaceFileOpenTarget;
  readonly opened: true;
}

import type { LingThreadStatus } from "./threads.js";

export interface WorkSummarySession {
  readonly id: string;
  readonly title: string;
  readonly status: LingThreadStatus;
  readonly surface: "conversation" | "channel" | "teammate" | "thread";
  readonly threadId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  /** Canonical worktree root; shared work is deliberately not attributed to one session. */
  readonly workspaceKey?: string;
}

export interface WorkSummaryCommit {
  readonly sha: string;
  readonly subject: string;
  readonly committedAt: string;
}

export interface WorkSummaryWorkspace {
  readonly key: string;
  readonly cwd: string;
  readonly state: "ready" | "not_repository" | "unavailable";
  readonly branch?: string;
  readonly headSha?: string;
  readonly changedFiles?: number;
  /** Net HEAD-to-working-tree text changes, including bounded untracked text files. */
  readonly additions?: number;
  readonly deletions?: number;
  readonly binaryFiles?: number;
  readonly partial: boolean;
  readonly commits: readonly WorkSummaryCommit[];
  readonly checkedAt: string;
  readonly error?: string;
}

export interface WorkSummaryPullRequestBinding {
  readonly url: string;
  readonly createdAt: string;
}

export interface WorkSummaryPullRequest extends WorkSummaryPullRequestBinding {
  readonly number: number;
  readonly repository: string;
  readonly title?: string;
  readonly state: "draft" | "open" | "merged" | "closed" | "unknown";
  readonly connection: "connected" | "unconnected" | "error";
  readonly headSha?: string;
  readonly ci: "success" | "failure" | "pending" | "unknown";
  readonly checkedAt?: string;
  readonly error?: string;
}

export interface WorkSummaryResponse {
  readonly cwd: string;
  readonly sessions: readonly WorkSummarySession[];
  readonly workspaces: readonly WorkSummaryWorkspace[];
  readonly pullRequests: readonly WorkSummaryPullRequest[];
  readonly truncated: boolean;
  readonly checkedAt: string;
}

import type { Dispatch, SetStateAction } from "react";
import type { MediaJob, MediaJobFormState, MediaJobStatus, RunArtifact } from "../../types.js";

export type MediaJobsLoadPhase = "idle" | "initial" | "refreshing" | "polling";
export type MediaJobMutationPhase = "idle" | "submitting";
export type MediaJobArtifactPhase = "idle" | "loading" | "ready" | "error";
export type MediaJobsRefreshReason = "manual" | "poll" | "enter" | "repair-return";

export interface MediaJobArtifactState {
  readonly signature: string;
  readonly phase: MediaJobArtifactPhase;
  readonly artifacts: readonly RunArtifact[];
  readonly errorMessage?: string;
}

export type MediaScopedErrorOwner =
  | "load"
  | "refresh"
  | "create"
  | `run:${string}`
  | `artifacts:${string}`;

export interface MediaScopedError {
  readonly owner: MediaScopedErrorOwner;
  readonly message: string;
}

export interface MediaMutationResult {
  readonly ok: boolean;
  readonly jobId?: string;
  readonly status?: MediaJobStatus;
}

export interface MediaJobsDomainState {
  readonly mediaJobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, MediaJobArtifactState>>;
  readonly loadPhase: MediaJobsLoadPhase;
  readonly createPhase: MediaJobMutationPhase;
  readonly runningJobIds: ReadonlySet<string>;
  readonly selectedMediaJobId: string;
  readonly form: MediaJobFormState;
  readonly errors: readonly MediaScopedError[];
}

export interface MediaJobsDomainActions {
  readonly setMediaJobForm: Dispatch<SetStateAction<MediaJobFormState>>;
  readonly setSelectedMediaJobId: Dispatch<SetStateAction<string>>;
  readonly refreshMediaJobs: (cwd?: string, reason?: MediaJobsRefreshReason) => Promise<void>;
  readonly createMediaJobFromForm: () => Promise<MediaMutationResult>;
  readonly executeMediaJob: (jobId: string) => Promise<MediaMutationResult>;
  readonly retryMediaJobArtifacts: (jobId: string) => Promise<void>;
  readonly clearMediaError: (owner: MediaScopedErrorOwner) => void;
  readonly resetForCwd: () => void;
}

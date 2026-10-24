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

/** Host observations, not proof of complete descendant termination or rollback. */
export interface UnifiedExecProcessObservation {
  readonly scope: "process_group" | "leader";
  readonly leaderExited: boolean;
  readonly stdioClosed: boolean;
  readonly descendants: "unverified";
  readonly stopReason?: "cancelled" | "timeout" | "output_drain" | "observer_error";
  readonly settledBy: "close" | "spawn_error" | "cleanup_deadline";
  readonly signalFailures: readonly string[];
}

export interface UnifiedExecStreamSummary {
  readonly byteCount: number;
  readonly lineCount?: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly artifactId?: string;
  /** SHA256 of all observed redacted UTF-8 bytes, independent of preview/artifact caps. */
  readonly contentSha256?: string;
}

/** Host execution coordinates and immutable input identities, separate from the requested command/cwd. */
export interface UnifiedExecIsolationEvidence {
  readonly backend: "macos_seatbelt";
  readonly originalCwd: string;
  readonly executionCwd: string;
  readonly actualCommand: UnifiedExecCommand;
  readonly policyHash: string;
  readonly profileHash: string;
  readonly inputs: readonly { readonly path: string; readonly sha256: string; readonly sizeBytes: number; readonly sourceItemIds: readonly string[];
    readonly derivation?: { readonly kind: "node_module_dependency_v1" | "node_package_metadata_v1";
      readonly parentPath: string; readonly parentSha256: string; readonly projectRoot: string } }[];
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
  readonly processObservation?: UnifiedExecProcessObservation;
  readonly isolation?: UnifiedExecIsolationEvidence;
  readonly stdout: UnifiedExecStreamSummary;
  readonly stderr: UnifiedExecStreamSummary;
  readonly artifacts: readonly UnifiedExecArtifactSummary[];
}

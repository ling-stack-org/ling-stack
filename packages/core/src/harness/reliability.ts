/** Derived metadata only. None of these records is execution or completion authority. */
export const HARNESS_PROJECTION_DOMAINS = ["continuation", "tool_execution", "evaluation", "delegation"] as const;
export type HarnessProjectionDomain = typeof HARNESS_PROJECTION_DOMAINS[number];

export interface HarnessProjectionCheckpoint {
  readonly domain: HarnessProjectionDomain;
  readonly generation: number;
  readonly sourceEpoch: number;
  readonly builtEpoch: number;
  readonly state: "stale" | "rebuilding" | "ready" | "failed";
  readonly rowCount: number;
  readonly digest: string;
  readonly cursor?: string;
  readonly failureCode?: string;
  readonly updatedAt: string;
}

export interface HarnessProjectionRow {
  readonly id: string;
  readonly runId: string;
  readonly rootRunId?: string;
  readonly workUnitId?: string;
  readonly state: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface HarnessProjectionPage {
  readonly checkpoint: HarnessProjectionCheckpoint;
  readonly items: readonly HarnessProjectionRow[];
  readonly nextCursor?: string;
}

export interface HarnessProjectionStore {
  getHarnessProjectionCheckpoint(domain: HarnessProjectionDomain): HarnessProjectionCheckpoint;
  /** Performs at most one bounded source page, including restart from an invalidated generation. */
  reconcileHarnessProjectionPage(input: {
    readonly domain: HarnessProjectionDomain;
    readonly now: string;
    readonly limit?: number;
  }): HarnessProjectionCheckpoint;
  queryHarnessProjection(input: {
    readonly domain: HarnessProjectionDomain;
    readonly generation: number;
    readonly after?: string;
    readonly limit?: number;
  }): HarnessProjectionPage;
}

export interface HarnessArtifactRetention {
  readonly artifactId: string;
  readonly contentSha256: string;
  readonly retainUntil: string;
  readonly enrolledAt: string;
  readonly prunedAt?: string;
}

export interface HarnessArtifactRetentionStore {
  /** Host-owned opt-in only. Existing artifacts are never implicitly eligible for GC. */
  enrollHarnessArtifactRetention(input: {
    readonly artifactId: string;
    readonly retainUntil: string;
    readonly now: string;
  }): HarnessArtifactRetention;
  pinHarnessArtifact(input: {
    readonly artifactId: string;
    readonly holder: string;
    readonly reason: "recovery" | "audit_hold";
    readonly now: string;
  }): void;
  releaseHarnessArtifactPin(input: { readonly artifactId: string; readonly holder: string; readonly now: string }): void;
  getHarnessArtifactRetention(artifactId: string): HarnessArtifactRetention | undefined;
  collectHarnessArtifactBodies(input: {
    readonly now: string;
    readonly limit?: number;
    readonly after?: string;
  }): { readonly examined: number; readonly prunedArtifactIds: readonly string[]; readonly nextCursor?: string };
}

export class HarnessReliabilityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HarnessReliabilityError";
  }
}

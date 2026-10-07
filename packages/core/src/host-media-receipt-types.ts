import type { MediaRemoteTerminalObservation, HostMediaProtocol } from "@ling-stack/contracts";
import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

/** Sealed Host facts, never model claims, caller safety flags, or launch capabilities. */
export interface HostMediaReceiptIdentity {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly mediaJobId: string;
  readonly executionGenerationId: string;
  readonly source: HostOperationSource;
  readonly childFence: RuntimeAttemptFenceV1;
  readonly namespaceDigest: string;
  readonly protocol: HostMediaProtocol;
}
export interface HostMediaCompletedResponse extends HostMediaReceiptIdentity {
  readonly kind: "media_response_v1";
  readonly effectId: string;
  readonly routeDigest: string;
  readonly wireDigest: string;
  readonly responseNamespaceDigest: string;
  readonly httpStatus: number;
  readonly bodySha256: string;
  readonly completedAt: string;
  /** Generation acknowledgement ID, not a guessed cache value or model output. */
  readonly externalOperationId?: string;
}
export interface HostMediaSubmission extends HostMediaReceiptIdentity {
  readonly kind: "media_submission_v1";
  readonly effectId: string;
  readonly responseArtifactId: string;
  readonly externalOperationId: string;
  readonly statusRouteDigest: string;
  /** Legacy Comfy's fixed, ordered same-task routes, sealed before its first poll. */
  readonly statusRouteDigests?: readonly string[];
  readonly completedAt: string;
}
/** Recovery projection only. All execution/job/remote/child identity is derived from the sealed receipt. */
export interface HostMediaSubmissionExecutionProjection {
  readonly recovery: Readonly<Record<string, unknown>>;
  readonly nextPollAt?: string | null;
  readonly pollAttempts?: number;
}
export interface HostMediaTerminal extends HostMediaReceiptIdentity {
  readonly kind: "media_terminal_v1";
  readonly observation: MediaRemoteTerminalObservation;
  readonly responseNamespaceDigest: string;
  readonly routeDigest: string;
  readonly bodySha256: string;
  readonly httpStatus: number;
  readonly completedAt: string;
}
export interface HostMediaArtifactManifestItem {
  readonly artifactId: string;
  readonly type: string;
  readonly path: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Digest of actual persisted media bytes, not the JSON seal. */
  readonly bytesSha256: string;
  readonly remoteDescriptorDigest: string;
  readonly collectedAt: string;
}
export interface HostMediaArtifactManifest extends HostMediaReceiptIdentity {
  readonly kind: "media_manifest_v1";
  readonly outcome: "collected" | "collection_failed" | "remote_failed" | "remote_cancelled";
  readonly items: readonly HostMediaArtifactManifestItem[];
  readonly completedAt: string;
}
export interface HostMediaLocalFinalization extends HostMediaReceiptIdentity {
  readonly kind: "media_finalization_v1";
  readonly effects: readonly { readonly effectId: string; readonly responseArtifactId?: string; readonly noStartArtifactId?: string }[];
  readonly submissionArtifactId?: string;
  readonly terminalArtifactId?: string;
  readonly manifestArtifactId: string;
  readonly completedAt: string;
}
export interface HostMediaEffectNoStart extends HostMediaReceiptIdentity {
  readonly kind: "media_effect_no_start_v1";
  readonly effectId: string;
  readonly completedAt: string;
}

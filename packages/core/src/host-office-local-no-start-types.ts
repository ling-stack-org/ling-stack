import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { HOST_OFFICE_LOCAL_PROTOCOL } from "./host-office-local-types.js";

/**
 * Immutable exclusion facts for an original, live-closed Office execution.
 * A receipt is historical evidence, never an execution or settlement capability.
 */
export interface HostOfficeLocalNoStartReceipt {
  readonly schemaVersion: 1;
  readonly protocol: typeof HOST_OFFICE_LOCAL_PROTOCOL;
  readonly kind: "office_local_no_start_v1";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly source: HostOperationSource;
  readonly parentOperationId: string;
  readonly producerOperationId: string;
  readonly toolCallId: string;
  readonly preparedArtifactId: string;
  readonly preparedDigest: string;
  /** Bind a completed read-only failed writer, or prove that no terminal existed at closure. */
  readonly terminal: { readonly terminalArtifactId: string; readonly terminalDigest: string } | null;
  readonly effects: readonly { readonly ordinal: number; readonly effectId: string; readonly effectDigest: string }[];
  /** Entire descendant tree, excluding only the designated binary producer itself. */
  readonly requiredDescendants: readonly { readonly operationId: string; readonly evidenceDigest: string }[];
  /** Issued only after every required descendant has genuinely settled as known-no-start. */
  readonly closedAt: string;
  /** Canonical digest of every other exact field in this receipt. */
  readonly receiptDigest: string;
}

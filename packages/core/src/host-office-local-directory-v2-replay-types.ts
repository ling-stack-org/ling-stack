import type { HostOfficeLocalDirectoryExecutionRecordV2 } from "./host-office-local-directory-v2-types.js";
import type { HostOfficeLocalDirectoryTerminalRecordV2 } from "./host-office-local-directory-v2-terminal-types.js";
import type { OfficeDirectoryHistoryEntryV2 } from "./storage/sqlite/host-office-local-directory-v2-history.js";

/** Getter facts only. Serialized IDs, digests and this input never restore live authority. */
export interface OfficeLocalDirectoryReplayInputV2 {
  readonly execution: HostOfficeLocalDirectoryExecutionRecordV2;
  readonly terminal: HostOfficeLocalDirectoryTerminalRecordV2;
  readonly effects: readonly OfficeDirectoryHistoryEntryV2[];
}
/** Internal graph proof, deliberately not a safe receipt, settlement or canonical namespace proof. */
export interface OfficeLocalDirectoryReplayResultV2 {
  readonly kind: "graph_verified_only";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly targetMemberId: string;
  readonly effectCount: number;
  readonly resourceCount: number;
  readonly callCount: number;
  readonly coreSafe: false;
  readonly canonicalVisibility: "unverified";
  readonly scopeBinding: "unbound";
  readonly packaged: false;
}

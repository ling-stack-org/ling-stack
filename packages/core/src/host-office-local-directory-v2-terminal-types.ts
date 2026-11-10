import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, HostOfficeDirectoryTerminalResourceV2 } from "./host-office-local-directory-v2-types.js";
import type { HostOfficeLocalTerminalEffect } from "./host-office-local-terminal-types.js";

/** Canonical proof remains unavailable until an original issuer/observer provides the full visibility window. */
export interface HostOfficeLocalDirectoryTerminalManifestV2 {
  readonly schemaVersion: 2;
  readonly protocol: typeof HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL;
  readonly kind: "office_local_directory_terminal_v2";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly source: HostOperationSource;
  readonly preparedArtifactId: string;
  readonly preparedDigest: string;
  readonly outcome: "published_native_only" | "failed" | "unknown";
  readonly installationEntered: boolean;
  readonly effects: readonly HostOfficeLocalTerminalEffect[];
  readonly resources: readonly HostOfficeDirectoryTerminalResourceV2[];
  readonly canonicalVisibility: { readonly state: "unverified"; readonly blockerCode: string };
  readonly completedAt: string;
}
export interface HostOfficeLocalDirectoryTerminalRecordV2 extends HostOfficeLocalDirectoryTerminalManifestV2 {
  readonly terminalArtifactId: string;
  readonly terminalDigest: string;
  readonly effectSetDigest: string;
  readonly effectCount: number;
  readonly sealedAt: string;
}

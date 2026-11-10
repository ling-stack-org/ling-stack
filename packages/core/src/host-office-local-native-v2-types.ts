/** Native protocol 2 facts. These DTOs never restore opaque session/resource capabilities. */
export interface HostOfficeNativeIdentityV2 {
  readonly device: string;
  readonly inode: string;
  readonly sizeBytes: string;
  readonly modifiedNs: string;
  readonly changedNs: string;
  readonly mode: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}
export type HostOfficeNativeResourceStateV2 = "not_acquired" | "retained" | "closed" | "unknown";
export interface HostOfficeNativeResourceFactV2 {
  readonly lifetimeId: string;
  readonly kind: "ancestor" | "stage_parent" | "destination_parent" | "created_directory" | "created_file" | "publication_directory" | "publication_file";
  readonly basename: string;
  readonly parentLifetimeId: string;
  readonly state: HostOfficeNativeResourceStateV2;
  readonly identityObserved: boolean;
  readonly device: string;
  readonly inode: string;
  readonly bytesWritten: string;
  readonly fsyncReturned: boolean;
  readonly initialIdentity?: HostOfficeNativeIdentityV2;
  readonly identity?: HostOfficeNativeIdentityV2;
  readonly initialObservedAtMonotonicNs?: string;
  readonly observedAtMonotonicNs?: string;
}
export type HostOfficeNativeSyscallV2 = "open" | "openat" | "openat_create_exclusive" | "mkdirat"
  | "fstat" | "fstatat_no_follow" | "write" | "pread" | "pread_eof_probe" | "fsync" | "close" | "renameatx_np_RENAME_EXCL";
interface HostOfficeNativeCallBaseV2 {
  readonly syscall: HostOfficeNativeSyscallV2;
  readonly resourceLifetimeId: string;
  readonly parentLifetimeId: string;
  readonly calledAtMonotonicNs: string;
  readonly returnedAtMonotonicNs: string;
  readonly requestedBytes?: string;
  readonly offset?: string;
  readonly identity?: HostOfficeNativeIdentityV2;
  readonly entryName?: string;
}
export type HostOfficeNativeCallV2 = HostOfficeNativeCallBaseV2 & (
  | { readonly nativeReturnState: "not_returned" }
  | { readonly nativeReturnState: "returned"; readonly returned: number | "descriptor_acquired_redacted";
      readonly success: boolean; readonly errno: number });
export interface HostOfficeNativeReadbackV2 {
  readonly operationId: string;
  readonly resourceLifetimeId: string;
  readonly expectedBytes: string;
  readonly budgetBytes: string;
  readonly bytesRead: string;
  readonly maximumSyscallAttempts: string;
  readonly syscallAttempts: string;
  readonly eofObserved: boolean;
  readonly identitiesMatch: boolean;
  readonly success: boolean;
  readonly nativeOutcome: "not_entered" | "entered" | "returned_failed" | "returned_success" | "unknown_exception";
  readonly calls: readonly HostOfficeNativeCallV2[];
  readonly blockerCode?: string;
  readonly identityBefore?: HostOfficeNativeIdentityV2;
  readonly identityAfter?: HostOfficeNativeIdentityV2;
}
export interface HostOfficeNativeSnapshotV2 {
  readonly sessionNonce: string;
  readonly phase: "building" | "blocked" | "published_native_only" | "cancelled" | "closed";
  readonly resources: readonly HostOfficeNativeResourceFactV2[];
  readonly installationEntered: boolean;
  readonly residualCreation: boolean;
  readonly everFailed: boolean;
  readonly publicationObservationClaimed: boolean;
  readonly cancelRequested: boolean;
  readonly installation?: HostOfficeNativeInstallationV2;
  readonly publication?: HostOfficeNativePublicationV2;
  readonly readbacks: readonly HostOfficeNativeReadbackV2[];
  readonly scopeBinding: "unbound";
  readonly protectedStageVerified: false;
  readonly coreSafe: false;
  readonly packaged: false;
}
export interface HostOfficeNativeInstallationV2 {
  readonly treeLifetimeId: string;
  readonly sourceParentLifetimeId: string;
  readonly destinationParentLifetimeId: string;
  readonly destinationName: string;
  readonly entries: readonly { readonly resourceLifetimeId: string; readonly parentLifetimeId: string; readonly expectedBytes: string }[];
  readonly entered: boolean;
  readonly nativeReturnState: "returned" | "not_returned";
  readonly calledAtMonotonicNs: string;
  readonly returnedAtMonotonicNs: string;
  readonly returned?: number;
  readonly errno?: number;
}
export interface HostOfficeNativePublicationV2 {
  readonly operationId: string;
  readonly observationBasis: "original_destination_parent_relative";
  readonly expectedBytes: string;
  readonly budgetBytes: string;
  readonly maximumCalls: string;
  readonly success: boolean;
  readonly nativeOutcome: HostOfficeNativeReadbackV2["nativeOutcome"];
  readonly entries: readonly { readonly originalLifetimeId: string; readonly observedLifetimeId?: string; readonly readback?: HostOfficeNativeReadbackV2 }[];
  readonly calls: readonly HostOfficeNativeCallV2[];
  readonly blockerCode?: string;
}
/** Lossless factual projection of an actual packet, excluding caps and payload bytes. */
export interface HostOfficeNativeResultFactsV2 {
  readonly success: boolean;
  readonly nativeOutcome: "returned";
  readonly hostAcknowledgment: "not_provided";
  /** Actual native string: empty for openSession/closeSession, not an invented effect ID. */
  readonly operationId: string;
  readonly calls: readonly HostOfficeNativeCallV2[];
  readonly snapshot: HostOfficeNativeSnapshotV2;
  readonly resourceFact?: HostOfficeNativeResourceFactV2;
  readonly readback?: HostOfficeNativeReadbackV2;
  readonly publication?: HostOfficeNativePublicationV2;
  readonly maximumSyscallAttempts?: string;
  readonly syscallAttempts?: string;
  readonly blockerCode?: string;
}
/** Raw N-API result only. `unknown` objects require the original adapter's private live ownership. */
export interface HostOfficeNativePacketV2 extends HostOfficeNativeResultFactsV2 {
  readonly session?: unknown;
  readonly stageParent?: unknown;
  readonly destinationParent?: unknown;
  readonly capability?: unknown;
  readonly bytes?: Uint8Array;
  readonly publicationFiles?: readonly { readonly originalLifetimeId: string; readonly observedLifetimeId: string; readonly bytes: Uint8Array }[];
}

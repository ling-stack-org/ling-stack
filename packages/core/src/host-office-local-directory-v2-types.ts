import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { HostOfficeLocalFormat, HostOfficeLocalTicket, HostOfficeLocalTool } from "./host-office-local-types.js";
import type { HostOfficeNativeIdentityV2, HostOfficeNativeResultFactsV2, HostOfficeNativeResourceStateV2 } from "./host-office-local-native-v2-types.js";

export const HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL = "ling-office-local-binary-v2" as const;
export const HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH = "missing_subtree_no_replace_v1" as const;
export const HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES = 50 * 1024 * 1024;
export interface HostOfficeDirectoryAncestorV2 {
  readonly resourceSlotId: string;
  readonly path: string;
  readonly identity: HostOfficeNativeIdentityV2;
}
export interface HostOfficeDirectoryMemberV2 {
  readonly memberId: string;
  readonly kind: "created_directory" | "created_file";
  readonly resourceSlotId: string;
  readonly publicationResourceSlotId: string;
  readonly parentResourceSlotId: string;
  readonly basename: string;
  readonly canonicalPath: string;
  readonly stagePath: string;
  readonly initial: "absent";
}
/** Serialized scope reference is history, never a `verified:true` execution authority. */
export interface HostOfficeDirectoryScopeRefV2 {
  readonly scopeId: string;
  readonly issuerId: string;
  readonly evidenceDigest: string;
}
export interface HostOfficeLocalDirectoryPreparedV2 {
  readonly schemaVersion: 2;
  readonly protocol: typeof HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL;
  readonly graph: typeof HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH;
  readonly executionId: string;
  readonly source: HostOperationSource;
  readonly parentOperationId: string;
  readonly producerOperationId: string;
  readonly toolCallId: string;
  readonly toolName: Extract<HostOfficeLocalTool, "office_create_workbook" | "office_create_document" | "office_create_presentation">;
  readonly format: HostOfficeLocalFormat;
  readonly workspacePath: string;
  readonly workspaceIdentity: HostOfficeNativeIdentityV2;
  readonly targetPath: string;
  readonly requestDigest: string;
  readonly policyDigest: string;
  readonly output: { readonly bytesSha256: string; readonly sizeBytes: number };
  readonly stage: { readonly parentPath: string; readonly parentResourceSlotId: string;
    readonly topBasename: string; readonly ancestors: readonly HostOfficeDirectoryAncestorV2[] };
  readonly destination: { readonly parentPath: string; readonly parentResourceSlotId: string;
    readonly firstMissingComponent: string; readonly ancestors: readonly HostOfficeDirectoryAncestorV2[] };
  readonly members: readonly HostOfficeDirectoryMemberV2[];
  readonly scopeRef: HostOfficeDirectoryScopeRefV2;
  readonly preparedAt: string;
}
export interface HostOfficeLocalDirectoryExecutionRecordV2 extends HostOfficeLocalDirectoryPreparedV2 {
  readonly preparedArtifactId: string;
  readonly preparedDigest: string;
  readonly identityDigest: string;
  readonly revision: number;
}
/** Same original Office ticket authority; protocol dispatch never reissues a journal pair. */
export type HostOfficeLocalDirectoryTicketV2 = HostOfficeLocalTicket;
export interface HostOfficeDirectoryCallRefV2 { readonly effectId: string; readonly ordinal: number }
export interface HostOfficeDirectoryResourceBindingV2 {
  readonly resourceSlotId: string;
  readonly nativeLifetimeId: string;
  readonly acquisitionCallRef?: HostOfficeDirectoryCallRefV2;
  readonly firstFstatCallRef?: HostOfficeDirectoryCallRefV2;
}
interface HostOfficeDirectoryEffectBaseV2 {
  readonly effectId: string;
  readonly ordinal: number;
  readonly preparedAt: string;
}
export type PrepareHostOfficeLocalDirectoryEffectV2 = HostOfficeDirectoryEffectBaseV2 & (
  | { readonly kind: "capture_parents"; readonly mode: "forward" }
  | { readonly kind: "create_directory" | "create_file"; readonly mode: "forward";
      readonly resourceSlotId: string; readonly parentResourceSlotId: string; readonly parentNativeLifetimeId: string; readonly basename: string }
  | { readonly kind: "write_file"; readonly mode: "forward"; readonly resourceSlotId: string;
      readonly nativeLifetimeId: string; readonly offset: number; readonly sizeBytes: number }
  | { readonly kind: "read_file"; readonly mode: "forward"; readonly resourceSlotId: string;
      readonly nativeLifetimeId: string; readonly expectedBytes: number; readonly budgetBytes: number }
  | { readonly kind: "observe_publication"; readonly mode: "forward"; readonly resourceSlotId: string;
      readonly nativeLifetimeId: string; readonly budgetBytes: number }
  | { readonly kind: "fsync_resource" | "observe_resource" | "close_resource"; readonly mode: "forward";
      readonly resourceSlotId: string; readonly nativeLifetimeId: string }
  | { readonly kind: "install_tree"; readonly mode: "forward"; readonly resourceSlotId: string;
      readonly nativeLifetimeId: string; readonly sourceParentResourceSlotId: string; readonly sourceParentNativeLifetimeId: string;
      readonly sourceBasename: string; readonly destinationParentResourceSlotId: string; readonly destinationParentNativeLifetimeId: string;
      readonly destinationBasename: string; readonly flags: "RENAME_EXCL" }
  | { readonly kind: "close_session"; readonly mode: "forward" | "cleanup" });
export type HostOfficeLocalDirectoryEffectRecordV2 = PrepareHostOfficeLocalDirectoryEffectV2 & {
  readonly executionId: string;
  readonly effectDigest: string;
  readonly enteredAt?: string;
  readonly observationArtifactId?: string;
  readonly revision: number;
};
export type HostOfficeDirectoryNativeObservationV2 = { readonly state: "not_entered" }
  | { readonly state: "threw"; readonly calledAt: string; readonly completedAt: string; readonly errorCode: string }
  | { readonly state: "returned_unprojectable"; readonly calledAt: string; readonly returnedAt: string; readonly errorCode: string }
  | { readonly state: "returned"; readonly calledAt: string; readonly returnedAt: string;
      readonly result: HostOfficeNativeResultFactsV2 };
export interface HostOfficeLocalDirectoryObservationV2 {
  readonly schemaVersion: 2;
  readonly protocol: typeof HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL;
  readonly kind: "office_local_directory_effect_v2";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly source: HostOperationSource;
  readonly effectId: string;
  readonly effectDigest: string;
  readonly native: HostOfficeDirectoryNativeObservationV2;
  readonly host: { readonly state: "returned" } | { readonly state: "unconfirmed"; readonly errorCode: string };
  /** Complete slot mapping for this packet's snapshot, not live capabilities. */
  readonly resourceBindings: readonly HostOfficeDirectoryResourceBindingV2[];
  /** Hash of actual bytes from this original returned read, computed by the Host adapter. */
  readonly readbackBytes?: { readonly bytesSha256: string; readonly sizeBytes: number };
  readonly publicationBytes?: readonly { readonly originalLifetimeId: string; readonly observedLifetimeId: string;
    readonly bytesSha256: string; readonly sizeBytes: number }[];
  readonly completedAt: string;
}
export type HostOfficeDirectoryTerminalResourceV2 = { readonly resourceSlotId: string; readonly state: "not_acquired" }
  | { readonly resourceSlotId: string; readonly state: "unknown"; readonly unknownCause: "native_reply_unknown" }
  | (HostOfficeDirectoryResourceBindingV2 & { readonly state: Exclude<HostOfficeNativeResourceStateV2, "not_acquired">;
      readonly closeCallRef?: HostOfficeDirectoryCallRefV2;
      /** Descriptor-loss and close-entered unknown are distinct facts. */
      readonly unknownCause?: "original_fstat_lost" | "close_entered" | "native_reply_unknown" });

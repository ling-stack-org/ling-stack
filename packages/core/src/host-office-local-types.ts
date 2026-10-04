import type { HostOperationSource } from "./host-operation-journal-types.js";

/** Fixed local OOXML protocol. Live Office/GUI results cannot satisfy this contract. */
export const HOST_OFFICE_LOCAL_PROTOCOL = "ling-office-local-binary-v1" as const;
export type HostOfficeLocalTool = "office_create_workbook" | "office_edit_workbook"
  | "office_create_document" | "office_edit_document" | "office_create_presentation" | "office_edit_presentation";
export type HostOfficeLocalFormat = "xlsx" | "docx" | "pptx";
export interface HostOfficeFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly sizeBytes: number;
  readonly modifiedNs: string;
  readonly changedNs: string;
}
export type HostOfficeFileSnapshot = { readonly state: "absent" }
  | { readonly state: "file"; readonly identity: HostOfficeFileIdentity; readonly bytesSha256: string; readonly sizeBytes: number };
export interface HostOfficeLocalMember {
  readonly memberId: string;
  readonly role: "target" | "temporary" | "recovery" | "directory";
  readonly path: string;
  readonly initial: HostOfficeFileSnapshot | { readonly state: "directory"; readonly identity: HostOfficeFileIdentity };
}
export interface HostOfficeLocalPrepared {
  readonly schemaVersion: 1;
  readonly protocol: typeof HOST_OFFICE_LOCAL_PROTOCOL;
  readonly executionId: string;
  readonly source: HostOperationSource;
  readonly parentOperationId: string;
  readonly producerOperationId: string;
  readonly toolCallId: string;
  readonly toolName: HostOfficeLocalTool;
  readonly format: HostOfficeLocalFormat;
  readonly workspacePath: string;
  /** Captured source root identity. Historical verification must never substitute today's disk identity. */
  readonly workspaceIdentity: HostOfficeFileIdentity;
  readonly targetPath: string;
  readonly overwrite: boolean;
  readonly requestDigest: string;
  readonly policyDigest: string;
  readonly input: HostOfficeFileSnapshot;
  readonly output: { readonly bytesSha256: string; readonly sizeBytes: number };
  readonly members: readonly HostOfficeLocalMember[];
  readonly preparedAt: string;
}
declare const hostOfficeLocalTicket: unique symbol;
/** Live store-owned capability. Neither a row, a seal nor a structural clone grants execution. */
export interface HostOfficeLocalTicket { readonly executionId: string; readonly [hostOfficeLocalTicket]: true }
export interface PrepareHostOfficeLocalInput {
  readonly executionId: string;
  readonly preparedArtifactId: string;
  readonly preparedDigest: string;
}
export interface HostOfficeLocalExecutionRecord extends HostOfficeLocalPrepared {
  readonly preparedArtifactId: string;
  readonly preparedDigest: string;
  readonly identityDigest: string;
  readonly revision: number;
}
export interface PrepareHostOfficeLocalEffect {
  readonly effectId: string;
  readonly ordinal: number;
  readonly kind: "mkdir" | "open" | "write" | "fsync" | "close" | "link" | "rename" | "unlink" | "rmdir";
  readonly mode: "forward" | "cleanup";
  readonly memberId: string;
  readonly fromMemberId?: string;
  /** Host-created lifetime; required for open/write/fsync/close, never a raw numeric FD. */
  readonly resourceLifetimeId?: string;
  readonly offset?: number;
  readonly sizeBytes?: number;
  readonly preparedAt: string;
}
export interface HostOfficeLocalEffectRecord extends PrepareHostOfficeLocalEffect {
  readonly executionId: string;
  readonly effectDigest: string;
  readonly enteredAt?: string;
  readonly observationArtifactId?: string;
  readonly revision: number;
}
export type HostOfficeLocalNativeResult =
  | { readonly kind: "open" | "fsync" | "close"; readonly resourceLifetimeId: string }
  | { readonly kind: "write"; readonly resourceLifetimeId: string; readonly bytesWritten: number }
  | { readonly kind: "mkdir" | "link" | "rename" | "unlink" | "rmdir" };
/** Latched at the actual native call, before readback, resource observation or Host COMMIT. */
export type HostOfficeLocalNativeObservation =
  | { readonly state: "not_entered" }
  | { readonly state: "returned"; readonly calledAt: string; readonly returnedAt: string; readonly result: HostOfficeLocalNativeResult }
  | { readonly state: "threw"; readonly calledAt: string; readonly completedAt: string; readonly errorCode: string };
export type HostOfficeLocalHostObservation = { readonly state: "returned" }
  | { readonly state: "unconfirmed"; readonly errorCode: string };

/** First fstat of the original returned open FD, separate from the native primitive result. */
export interface HostOfficeLocalOpenResourceObservation {
  readonly resourceLifetimeId: string;
  readonly identity: HostOfficeFileIdentity;
  readonly observedAt: string;
}

/** Native facts and Host transaction outcome are separate; neither is a safe receipt. */
export interface HostOfficeLocalEffectObservation {
  readonly schemaVersion: 1;
  readonly protocol: typeof HOST_OFFICE_LOCAL_PROTOCOL;
  readonly kind: "office_local_effect_v1";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly source: HostOperationSource;
  readonly effectId: string;
  readonly effectDigest: string;
  readonly native: HostOfficeLocalNativeObservation;
  readonly host: HostOfficeLocalHostObservation;
  /** Optional fact only for native open returned; absence cannot prove a safe resource lifetime. */
  readonly openResource?: HostOfficeLocalOpenResourceObservation;
  readonly completedAt: string;
}

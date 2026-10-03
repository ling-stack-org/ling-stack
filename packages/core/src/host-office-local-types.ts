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
/** Actual fixed-writer observation; success text from an Office tool is not accepted. */
export interface HostOfficeLocalEffectObservation {
  readonly schemaVersion: 1;
  readonly protocol: typeof HOST_OFFICE_LOCAL_PROTOCOL;
  readonly kind: "office_local_effect_v1";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly source: HostOperationSource;
  readonly effectId: string;
  readonly effectDigest: string;
  readonly outcome: "returned" | "failed" | "not_entered";
  readonly errorCode?: string;
  readonly completedAt: string;
}

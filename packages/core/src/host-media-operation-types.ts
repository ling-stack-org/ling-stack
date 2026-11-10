import type { HostMediaEffectKind, HostMediaProtocol } from "@ling-stack/contracts";
import type { HostOperationSource, HostOperationTicket } from "./host-operation-journal-types.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

export type { HostMediaEffectKind, HostMediaProtocol } from "@ling-stack/contracts";
declare const hostMediaExecutionTicket: unique symbol;
/** Issued only by the admitting Core store. A persisted ID never authorizes another send. */
export interface HostMediaExecutionTicket {
  readonly executionId: string;
  readonly [hostMediaExecutionTicket]: true;
}

/** Non-secret prepared intent. Exact wire bytes are bound separately for every forward effect. */
export interface PrepareHostMediaExecutionInput {
  readonly executionId: string;
  readonly mediaJobId: string;
  readonly mediaChildWorkUnitId: string;
  readonly executionGenerationId: string;
  readonly protocol: HostMediaProtocol;
  readonly adapterId: string;
  readonly toolName: "image_generate" | "video_generate";
  readonly operation: "image_generate" | "image_edit" | "video_generate";
  readonly intentDigest: string;
  readonly targetDigest: string;
  readonly namespaceDigest: string;
  readonly preparedRequestArtifactId: string;
  readonly preparedRequestDigest: string;
  readonly preparedAt: string;
}
export interface HostMediaExecutionRecord extends PrepareHostMediaExecutionInput {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly source: HostOperationSource;
  readonly toolCallId: string;
  readonly parentOperationId: string;
  readonly transportOperationId: string;
  readonly childFence?: RuntimeAttemptFenceV1;
  readonly childBoundAt?: string;
  readonly identityDigest: string;
  readonly revision: number;
  readonly submissionArtifactId?: string;
  readonly terminalArtifactId?: string;
  readonly manifestArtifactId?: string;
  readonly finalizationArtifactId?: string;
}

export interface PrepareHostMediaEffectInput {
  readonly effectId: string;
  readonly ordinal: number;
  readonly kind: HostMediaEffectKind;
  readonly method: "POST";
  readonly routeDigest: string;
  readonly wireDigest: string;
  readonly preparedAt: string;
}
export interface HostMediaEffectRecord extends PrepareHostMediaEffectInput {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly launchedAt?: string;
  readonly revision: number;
  readonly responseArtifactId?: string;
  readonly noStartArtifactId?: string;
}

/** Internal journal pair is retained with the capability, never reconstructed from latest owner. */
export interface HostMediaJournalTickets {
  readonly parent: HostOperationTicket;
  readonly transport: HostOperationTicket;
}

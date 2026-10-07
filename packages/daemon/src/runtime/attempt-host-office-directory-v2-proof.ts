import { isDeepStrictEqual } from "node:util";
import type { HostOfficeLocalDirectoryCloseClaimV2, HostOfficeLocalDirectoryCommittedPairV2,
  HostOfficeLocalDirectoryCommittedPairExpectedV2, HostOfficeLocalSettlement, HostOperationRecord } from "@ling-stack/core";
import { readOriginalOfficeDirectoryCommittedPairV2 } from "@ling-stack/core/original-office-committed-pair-v2";
import type { HostExecutorKind, HostExecutorSettlement } from "./attempt-execution-quiescence.js";

export interface OfficeDirectoryTrackerMemberIdentityV2 {
  readonly operationId: string;
  readonly kind: HostExecutorKind;
  readonly toolCallId: string;
  readonly parentOperationId?: string;
  readonly producerId?: string;
}
export interface OfficeDirectoryTrackerPairProofV2 {
  readonly pair: Readonly<HostOfficeLocalSettlement>;
  readonly parent: HostExecutorSettlement;
  readonly producer: HostExecutorSettlement;
}

/** Fixed Core readback only. Member identities are comparisons, never caller receipts or proof hooks. */
export function readOriginalOfficeDirectoryTrackerPairProofV2(owner: object,
  grant: HostOfficeLocalDirectoryCommittedPairV2, claim: HostOfficeLocalDirectoryCloseClaimV2,
  expected: HostOfficeLocalDirectoryCommittedPairExpectedV2, parent: OfficeDirectoryTrackerMemberIdentityV2,
  producer: OfficeDirectoryTrackerMemberIdentityV2): OfficeDirectoryTrackerPairProofV2 {
  const pair = readOriginalOfficeDirectoryCommittedPairV2(owner, grant, claim, expected);
  if (parent.kind !== "mcp" || producer.kind !== "file_mutation" || parent.operationId !== expected.parentOperationId
    || producer.operationId !== expected.producerOperationId || producer.parentOperationId !== parent.operationId
    || producer.producerId !== "office-local-binary" || producer.toolCallId !== parent.toolCallId
    || pair.parent.settledAt !== pair.producer.settledAt) invalid();
  const parentProof = proof(pair.parent, parent, expected, "office_local_chain_completed", "office_local_chain_execution");
  const producerProof = proof(pair.producer, producer, expected, "office_local_binary_completed", "office_local_binary_execution");
  return Object.freeze({ pair, parent: parentProof, producer: producerProof });
}

function proof(record: HostOperationRecord, identity: OfficeDirectoryTrackerMemberIdentityV2,
  expected: HostOfficeLocalDirectoryCommittedPairExpectedV2, kind: string, evidenceKind: string): HostExecutorSettlement {
  if (record.schemaVersion !== 1 || record.operationId !== identity.operationId || record.kind !== identity.kind
    || record.toolCallId !== identity.toolCallId || record.parentOperationId !== identity.parentOperationId
    || record.producerId !== identity.producerId || !isDeepStrictEqual(record.source, expected.source)
    || record.phase !== "safe" || record.settlementKind !== kind || record.evidenceRef?.kind !== evidenceKind
    || record.evidenceRef.id !== expected.executionId || !record.launchedAt || !record.settledAt
    || !/^[a-f0-9]{64}$/u.test(record.evidenceDigest ?? "")) invalid();
  return Object.freeze({ schemaVersion: 1, source: record.source, operationId: record.operationId,
    evidenceRef: `host_operation:${record.operationId}:${record.evidenceDigest}`, settledAt: record.settledAt,
    kind: "completed_persisted", physicalScope: "entire_operation", effects: "persisted" });
}
function invalid(): never { throw new Error("attempt_host_operation_office_directory_proof_invalid"); }

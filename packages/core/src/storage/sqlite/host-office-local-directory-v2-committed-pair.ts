import type { DatabaseSync } from "node:sqlite";
import type { HostOfficeLocalTicket, HostOfficeLocalSettlement } from "../../host-office-local-types.js";
import type { HostOfficeLocalDirectoryCloseClaimV2, HostOfficeLocalDirectoryCommittedPairV2,
  HostOfficeLocalDirectoryCommittedPairExpectedV2, HostOfficeLocalDirectoryExecutionRecordV2 } from "../../host-office-local-directory-v2-types.js";
import { hostOperationFailure, readHostOperation, sameHostOperationSource, verifyHostOperationSafe } from "./host-operation-journal-evidence.js";
import { readOfficeLocalDirectoryExecutionV2 } from "./host-office-local-directory-v2-records.js";
import { readOfficeDirectoryCertificateV2 } from "./host-office-local-directory-v2-certificate.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { OriginalOfficeDirectoryAuthorityV2 } from "../../original-office-host-bridge.js";
import type { OfficeDirectoryWindowCloseClaimV2 } from "./host-office-local-directory-v2-close-claim.js";

interface CommittedPairCustodyV2 {
  readonly reader: OfficeDirectoryCommittedPairReaderV2;
  readonly owner: object;
  readonly closeClaim: HostOfficeLocalDirectoryCloseClaimV2;
  readonly authority: OriginalOfficeDirectoryAuthorityV2;
  readonly expected: HostOfficeLocalDirectoryCommittedPairExpectedV2;
  readonly identityDigest: string;
}
const custodies = new WeakMap<HostOfficeLocalDirectoryCommittedPairV2, CommittedPairCustodyV2>();
const invalid = (): never => hostOperationFailure("host_office_local_committed_pair_invalid");

/** Constructor-private reader, never exposed by RunStore; no callback can be registered as proof. */
export class OfficeDirectoryCommittedPairReaderV2 {
  #handles = new WeakMap<HostOfficeLocalTicket, HostOfficeLocalDirectoryCommittedPairV2>();
  constructor(private readonly database: DatabaseSync, private readonly owner: object) {}
  /** Only the owning Directory Store calls this after its original ticket has returned from COMMIT. */
  issue(ticket: HostOfficeLocalTicket, execution: HostOfficeLocalDirectoryExecutionRecordV2,
    originalHistory: OfficeDirectoryWindowCloseClaimV2,
    closeClaim: HostOfficeLocalDirectoryCloseClaimV2): HostOfficeLocalDirectoryCommittedPairV2 {
    // Derive custody from the owning ticket's retained claim, never from a caller-supplied authority.
    const authority = originalHistory.readOriginalAuthority(closeClaim);
    const expected = Object.freeze({ executionId: execution.executionId, source: Object.freeze({ ...execution.source }),
      parentOperationId: execution.parentOperationId, producerOperationId: execution.producerOperationId });
    const original = this.#handles.get(ticket);
    if (original) {
      if (custodies.get(original)?.authority !== authority) return hostOperationFailure("host_office_local_committed_pair_authority_invalid");
      readOriginalOfficeDirectoryCommittedPairV2(this.owner, original, closeClaim, expected);
      return original;
    }
    this.read(expected, execution.identityDigest);
    const handle = Object.freeze({}) as HostOfficeLocalDirectoryCommittedPairV2;
    custodies.set(handle, Object.freeze({ reader: this, owner: this.owner, closeClaim, authority, expected, identityDigest: execution.identityDigest }));
    this.#handles.set(ticket, handle);
    return handle;
  }
  /** Reads the captured constructor DB, never a replaceable RunStore getter. No Host/current-scope or FD call. */
  read(expected: HostOfficeLocalDirectoryCommittedPairExpectedV2, identityDigest: string): Readonly<HostOfficeLocalSettlement> {
    return readSqliteSnapshot(this.database, () => {
      const execution = readOfficeLocalDirectoryExecutionV2(this.database, expected.executionId);
      const parent = readHostOperation(this.database, expected.parentOperationId), producer = readHostOperation(this.database, expected.producerOperationId);
      if (!execution || execution.identityDigest !== identityDigest || execution.parentOperationId !== expected.parentOperationId
        || execution.producerOperationId !== expected.producerOperationId || !sameHostOperationSource(execution.source, expected.source)
        || !parent || !producer || parent.phase !== "safe" || producer.phase !== "safe" || !parent.settledAt
        || parent.settledAt !== producer.settledAt || verifyHostOperationSafe(this.database, parent) !== parent.evidenceDigest
        || verifyHostOperationSafe(this.database, producer) !== producer.evidenceDigest) return invalid();
      readOfficeDirectoryCertificateV2(this.database, execution, parent, producer, parent.settledAt);
      return freeze({ parent, producer });
    });
  }
}

/** Fixed exact original committed readback; expected identity is a comparison, never caller evidence. */
export function readOriginalOfficeDirectoryCommittedPairV2(owner: object, handle: HostOfficeLocalDirectoryCommittedPairV2,
  closeClaim: HostOfficeLocalDirectoryCloseClaimV2,
  expected: HostOfficeLocalDirectoryCommittedPairExpectedV2): Readonly<HostOfficeLocalSettlement> {
  const original = custodies.get(handle);
  if (!original || original.owner !== owner) return invalid();
  if (original.closeClaim !== closeClaim) return hostOperationFailure("host_office_local_close_claim_invalid");
  if (!expected
    || original.expected.executionId !== expected.executionId || original.expected.parentOperationId !== expected.parentOperationId
    || original.expected.producerOperationId !== expected.producerOperationId || !expected.source
    || !sameHostOperationSource(original.expected.source, expected.source)) return invalid();
  return original.reader.read(original.expected, original.identityDigest);
}
export function assertOriginalOfficeDirectoryCommittedPairV2(owner: object, handle: HostOfficeLocalDirectoryCommittedPairV2,
  closeClaim: HostOfficeLocalDirectoryCloseClaimV2, expected: HostOfficeLocalDirectoryCommittedPairExpectedV2): void {
  readOriginalOfficeDirectoryCommittedPairV2(owner, handle, closeClaim, expected);
}
/** Fixed lease-consumer binding: the committed pair belongs to this exact original Core authority, not a matching window DTO. */
export function assertOriginalOfficeDirectoryCommittedPairAuthorityV2(owner: object, handle: HostOfficeLocalDirectoryCommittedPairV2,
  closeClaim: HostOfficeLocalDirectoryCloseClaimV2, originalAuthority: OriginalOfficeDirectoryAuthorityV2,
  expected: HostOfficeLocalDirectoryCommittedPairExpectedV2): void {
  readOriginalOfficeDirectoryCommittedPairV2(owner, handle, closeClaim, expected);
  if (custodies.get(handle)?.authority !== originalAuthority) {
    return hostOperationFailure("host_office_local_committed_pair_authority_invalid");
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

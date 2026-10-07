import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import type { HostOfficeLocalDirectoryExecutionRecordV2 } from "../../host-office-local-directory-v2-types.js";
import { hostOperationFailure, hostOperationTimestamp, sameHostOperationSource, type StoredHostOperation } from "./host-operation-journal-evidence.js";
import { officeDirectoryRawRosterDigestV2 } from "./host-office-local-directory-v2-close-roster.js";
import { readOfficeLocalDirectoryEffectsV2, validateOfficeLocalDirectoryObservationV2 } from "./host-office-local-directory-v2-records.js";
import { readOfficeLocalDirectoryTerminalV2 } from "./host-office-local-directory-v2-terminal.js";
import { verifyOfficeLocalDirectoryReplayV2 } from "./host-office-local-directory-v2-replay.js";

const fail = (): never => hostOperationFailure("host_office_local_directory_v2_certificate_invalid");
const issuers = new WeakSet<DatabaseSync>();
export interface OfficeDirectoryCertificateV2 {
  readonly executionId: string;
  readonly settledAt: string;
  readonly json: string;
  readonly digest: string;
}

/** Pure sealed-history reconstruction. Live request/policy/current-owner checks belong to the original fixed Host assertClosed. */
export function officeDirectoryCertificateFactsV2(database: DatabaseSync,
  execution: HostOfficeLocalDirectoryExecutionRecordV2, parent: StoredHostOperation,
  producer: StoredHostOperation, settledAt: string): OfficeDirectoryCertificateV2 {
  const at = hostOperationTimestamp(settledAt), terminal = readOfficeLocalDirectoryTerminalV2(database, execution);
  if (!parent.launchedAt || !producer.launchedAt || !terminal || hostOperationTimestamp(terminal.sealedAt) > at
    || parent.operationId !== execution.parentOperationId || producer.operationId !== execution.producerOperationId
    || !sameHostOperationSource(parent.source, execution.source) || !sameHostOperationSource(producer.source, execution.source)
    || parent.toolCallId !== execution.toolCallId || producer.toolCallId !== execution.toolCallId) return fail();
  const launched = Math.max(hostOperationTimestamp(parent.launchedAt), hostOperationTimestamp(producer.launchedAt));
  if (at < launched) return fail();
  const effects = readOfficeLocalDirectoryEffectsV2(database, execution).map(effect => {
    const observation = effect.observationArtifactId
      ? validateOfficeLocalDirectoryObservationV2(database, execution, effect, effect.observationArtifactId) : null;
    if (!observation || observation.native.state !== "returned"
      || hostOperationTimestamp(observation.native.calledAt) < launched) return fail();
    return { effect, observation };
  });
  const replay = verifyOfficeLocalDirectoryReplayV2({ execution, terminal, effects });
  const facts = {
    schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_core_certificate_v2",
    executionId: execution.executionId, executionIdentityDigest: execution.identityDigest,
    source: execution.source, toolCallId: execution.toolCallId, graph: execution.graph,
    preparedArtifactId: execution.preparedArtifactId, preparedDigest: execution.preparedDigest,
    // These are exact original prepared digests, not a guessed reconstruction of MCP input.
    requestDigest: execution.requestDigest, policyDigest: execution.policyDigest, scopeRef: execution.scopeRef,
    parent: { operationId: parent.operationId, domainIdentityDigest: parent.domainIdentityDigest,
      admittedAt: parent.admittedAt, launchedAt: parent.launchedAt },
    producer: { operationId: producer.operationId, domainIdentityDigest: producer.domainIdentityDigest,
      admittedAt: producer.admittedAt, launchedAt: producer.launchedAt },
    terminalArtifactId: terminal.terminalArtifactId, terminalDigest: terminal.terminalDigest,
    effectSetDigest: terminal.effectSetDigest, effectCount: terminal.effectCount, sealedAt: terminal.sealedAt,
    rosterDigest: officeDirectoryRawRosterDigestV2(database, parent, producer, settledAt), settledAt, replay,
  };
  return Object.freeze({ executionId: execution.executionId, settledAt, json: JSON.stringify(facts), digest: digestHarnessToolValue(facts) });
}

/** Independent immutable certificate read; never opens a native resource or adopts a live authority. */
export function readOfficeDirectoryCertificateV2(database: DatabaseSync,
  execution: HostOfficeLocalDirectoryExecutionRecordV2, parent: StoredHostOperation,
  producer: StoredHostOperation, settledAt: string): OfficeDirectoryCertificateV2 {
  const row = database.prepare("SELECT * FROM host_office_local_directory_v2_certificates WHERE execution_id=?").get(execution.executionId);
  if (!row || row.schema_version !== 2 || row.protocol !== execution.protocol || row.settled_at !== settledAt) return fail();
  const expected = officeDirectoryCertificateFactsV2(database, execution, parent, producer, settledAt);
  if (row.certificate_json !== expected.json || row.certificate_digest !== expected.digest) return fail();
  return expected;
}

/** Constructor-private issuance guard. A reopened connection can read history but cannot mint an original ticket. */
export class OfficeDirectoryCertificateIssuerV2 {
  #admission?: OfficeDirectoryCertificateV2;
  #intents = new Map<string, OfficeDirectoryCertificateV2>();
  constructor(private readonly database: DatabaseSync) {
    if (issuers.has(database)) return hostOperationFailure("host_office_local_directory_v2_issuer_already_owned");
    issuers.add(database);
    database.function("ling_office_directory_v2_certificate_insert", (executionId, json, digest, settledAt) => {
      const allowed = this.#admission;
      return allowed && executionId === allowed.executionId && json === allowed.json
        && digest === allowed.digest && settledAt === allowed.settledAt ? 1 : 0;
    });
  }
  /** Called only after the owning Store has verified its original ticket/Map/seal/close claim under BEGIN IMMEDIATE. */
  insert(certificate: OfficeDirectoryCertificateV2): void {
    if (this.#admission) return hostOperationFailure("host_office_local_directory_v2_certificate_reentry");
    const retained = this.#intents.get(certificate.executionId);
    if (retained && (retained.json !== certificate.json || retained.digest !== certificate.digest)) {
      return hostOperationFailure("host_office_local_directory_v2_certificate_claim_conflict");
    }
    // Preserve exact first certificate intent as well as its pair clock across rollback/ACK loss.
    this.#intents.set(certificate.executionId, retained ?? certificate);
    this.#admission = certificate;
    try {
      this.database.prepare(`INSERT INTO host_office_local_directory_v2_certificates
        (execution_id,schema_version,protocol,certificate_json,certificate_digest,settled_at)
        VALUES(?,2,'ling-office-local-binary-v2',?,?,?)`).run(certificate.executionId, certificate.json, certificate.digest, certificate.settledAt);
    } finally { this.#admission = undefined; }
  }
  /** SQL-only ACK-loss reconciliation must retain the exact first certificate, not merely a matching clock. */
  assertCommittedIntent(executionId: string, settledAt: string): void {
    const retained = this.#intents.get(executionId);
    const row = this.database.prepare("SELECT certificate_json,certificate_digest,settled_at FROM host_office_local_directory_v2_certificates WHERE execution_id=?").get(executionId);
    if (!retained || retained.settledAt !== settledAt || !row || row.settled_at !== settledAt
      || row.certificate_json !== retained.json || row.certificate_digest !== retained.digest) {
      return hostOperationFailure("host_office_local_directory_v2_certificate_claim_conflict");
    }
  }
}

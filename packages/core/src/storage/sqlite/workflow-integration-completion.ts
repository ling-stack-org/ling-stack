import type { DatabaseSync } from "node:sqlite";
import type { WorkflowIntegrationCandidate, WorkflowIntegrationRoundInputsV1, WorkflowIsolationWriter } from "../../workflow-isolation-types.js";
import { workflowIsolationCanonicalJson as json, workflowIsolationDigest as digest,
  workflowIsolationRecord as record } from "../../workflow-isolation.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";

const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
const readers = new WeakMap<DatabaseSync, (workflowId: string, now: string) => string | undefined>();
const publicationReaders = new WeakMap<DatabaseSync, (workflowId: string) => string | undefined>();

/** Installed by the Host-only adapter, not exposed through RunStore or the Core barrel. */
export function registerWorkflowIntegrationCompletionReader(database: DatabaseSync,
  read: (workflowId: string, now: string) => string | undefined,
  readPublication: (workflowId: string) => string | undefined): void {
  if (readers.has(database)) throw new Error("workflow_integration.completion_reader_already_registered");
  readers.set(database, read);
  publicationReaders.set(database, readPublication);
}

/** Re-read physical-effect evidence inside the final report publication transaction. */
export function readWorkflowIntegrationPublicationBlocker(database: DatabaseSync, workflowId: string): string | undefined {
  const read = (): string | undefined => {
    try {
      const reader = publicationReaders.get(database);
      return reader ? reader(workflowId) : "workflow_isolation.publication_reader_unavailable";
    } catch { return "workflow_isolation.publication_evidence_invalid"; }
  };
  return database.isTransaction ? readSqliteWithinTransaction(database, read) : readSqliteSnapshot(database, read);
}

/** Shared evidence check, not an execution, approval or target-apply capability. */
export function workflowCandidateVerificationMatches(value: unknown, input: {
  readonly roundId: string; readonly generation: number; readonly inputs: WorkflowIntegrationRoundInputsV1;
  readonly inputsDigest: string; readonly candidate: WorkflowIntegrationCandidate; readonly writer: WorkflowIsolationWriter;
}): boolean {
  const { candidate, inputs } = input;
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "workflow_candidate_verification" || value.status !== "passed"
    || value.applied !== false || value.projectTestsRun !== false || !record(value.candidate)
    || value.candidate.commit !== candidate.commit || value.candidate.tree !== candidate.tree
    || value.candidate.packetDigest !== candidate.packetDigest
    || value.candidate.resultRef !== `refs/ling/workflow/candidates/${input.roundId}/${input.generation}-${inputs.integration.worktreeId}/candidate`
    || typeof value.candidate.patchDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.candidate.patchDigest)
    || value.inputsDigest !== input.inputsDigest || !same(value.writer, input.writer)
    || !same(value.validationRequirements, inputs.validationRequirements)
    || value.requirementsDigest !== digest(inputs.validationRequirements, "wvr1_")
    || digest(value, "wgp1_") !== candidate.validationDigest || !record(value.executionScope)
    || !Array.isArray(value.results) || value.results.length !== inputs.validationRequirements.length) return false;
  const scope = { kind: "candidate_tree_static_checks", readOnly: true, executionRoot: inputs.canonicalWorkspaceRoot,
    commonDir: inputs.repositoryIdentity.commonDir, repositoryBasisDigest: inputs.target.cleanStateDigest,
    roundId: input.roundId, generation: input.generation, baseCommit: inputs.baseCommit,
    candidateCommit: candidate.commit, candidateTree: candidate.tree };
  if (!same(value.executionScope, scope)) return false;
  const seen = new Set<string>();
  for (const item of value.results) {
    if (!record(item) || typeof item.id !== "string" || seen.has(item.id) || item.status !== "passed" || item.exitCode !== 0
      || !inputs.validationRequirements.some(requirement => requirement.id === item.id && requirement.fingerprint === item.fingerprint)
      || !same(item.executionScope, scope) || !record(item.artifact) || item.artifact.contentType !== "application/json"
      || typeof item.artifact.payload !== "string") return false;
    const body: unknown = JSON.parse(item.artifact.payload);
    if (!record(body) || body.exitCode !== 0 || item.artifact.digest !== digest(body, "wgp1_")
      || item.artifact.payload !== json(body)) return false;
    seen.add(item.id);
  }
  return true;
}

/** Synchronous reads join an existing completion transaction, never BEGIN inside it. */
export function readWorkflowIntegrationCompletionBlocker(database: DatabaseSync, workflowId: string, now = new Date().toISOString()): string | undefined {
  const read = (): string | undefined => {
    try {
      const reader = readers.get(database);
      if (reader) return reader(workflowId, now);
      return "workflow_isolation.completion_reader_unavailable";
    }
    catch { return "workflow_isolation.completion_evidence_invalid"; }
  };
  return database.isTransaction ? readSqliteWithinTransaction(database, read) : readSqliteSnapshot(database, read);
}

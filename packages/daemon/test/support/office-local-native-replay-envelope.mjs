import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { officeDirectorySlotsV2 } from "../../../core/dist/storage/sqlite/host-office-local-directory-v2-effects.js";
import { directoryV2Prepared } from "../../../core/test/support/host-office-local-directory-v2-fixture.mjs";
import { resealDirectoryV2Replay } from "../../../core/test/support/host-office-local-directory-v2-replay-fixture.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");

/**
 * Logical/digest envelopes only. Every identity, call and snapshot comes from
 * the actual native projection. The expected digest uses the prepared OOXML
 * Buffer; returned byte hashes come from Daemon's actual packet projection.
 * The preparation is assembled after actual capture; this is NOT a pre-entry
 * SQLite seal, live Host scope, admission, lineage or permission capability.
 */
export function createNativeReplayEnvelope({ caseId, stagePath, workspacePath, directoryCount,
  bytes, capture, preparedAt, requestDigest }) {
  assert.ok(Number.isInteger(directoryCount) && directoryCount >= 1 && directoryCount <= 127);
  const prepared = directoryV2Prepared({ stagePath, workspacePath, preparedAt,
    executionId: `${caseId}-execution`, toolCallId: `${caseId}-call`,
    parentOperationId: `${caseId}-parent-dto`, producerOperationId: `${caseId}-producer-dto` });
  // These IDs deliberately advertise the missing authority. They are DTOs,
  // not the Supervisor's original live factory/source/scope references.
  prepared.scopeRef = { scopeId: `${caseId}-pure-dto-scope`, issuerId: "pure-native-conformance-dto-issuer",
    evidenceDigest: hash("pure DTO only; no Host issuer or protected scope") };
  prepared.requestDigest = requestDigest;
  prepared.policyDigest = hash("pure native conformance; no policy admission");
  prepared.output = { bytesSha256: hash(bytes), sizeBytes: bytes.length };
  let resourceIndex = 0;
  for (const role of ["stage", "destination"]) {
    for (const [index, ancestor] of prepared[role].ancestors.entries()) {
      const resource = capture.facts.snapshot.resources[resourceIndex++];
      assert.equal(resource.kind, index === prepared[role].ancestors.length - 1 ? `${role}_parent` : "ancestor");
      assert.equal(resource.basename, ancestor.path === "/" ? "/" : ancestor.path.split("/").at(-1));
      assert.ok(resource.initialIdentity, "No fixture identity may replace an actual acquired identity.");
      ancestor.identity = clone(resource.initialIdentity);
    }
  }
  assert.equal(resourceIndex, capture.facts.snapshot.resources.length);
  prepared.workspaceIdentity = clone(prepared.destination.ancestors.at(-1).identity);
  prepared.members = [];
  let parentResourceSlotId = prepared.stage.parentResourceSlotId,
    stageParent = stagePath, canonicalParent = workspacePath;
  for (let index = 0; index < directoryCount; index++) {
    const resourceSlotId = index === 0 ? "tree" : `directory-${index}`,
      basename = index === 0 ? prepared.stage.topBasename : `nested-${index}`;
    stageParent = join(stageParent, basename);
    canonicalParent = join(canonicalParent, index === 0 ? prepared.destination.firstMissingComponent : basename);
    prepared.members.push({ memberId: resourceSlotId, kind: "created_directory", resourceSlotId,
      publicationResourceSlotId: `${resourceSlotId}-publication`, parentResourceSlotId, basename,
      canonicalPath: canonicalParent, stagePath: stageParent, initial: "absent" });
    parentResourceSlotId = resourceSlotId;
  }
  prepared.targetPath = join(canonicalParent, "report.docx");
  prepared.members.push({ memberId: "file", kind: "created_file", resourceSlotId: "file",
    publicationResourceSlotId: "file-publication", parentResourceSlotId, basename: "report.docx",
    canonicalPath: prepared.targetPath, stagePath: join(stageParent, "report.docx"), initial: "absent" });
  const execution = { ...prepared, preparedArtifactId: `${caseId}-preparation-dto`,
    preparedDigest: "0".repeat(64), identityDigest: "0".repeat(64), revision: 0 };
  const slots = officeDirectorySlotsV2(execution), bindings = new Map(), closeRefs = new Map(), effects = [];

  const record = (kind, effectId, projection, parameters, window, mode = "forward") => {
    const facts = projection.facts;
    assert.equal(facts.success, true, `Actual ${kind} failed: ${JSON.stringify(facts)}`);
    assert.equal(facts.operationId, ["capture_parents", "close_session"].includes(kind) ? "" : effectId);
    assert.equal(facts.snapshot.coreSafe, false);
    assert.equal(facts.snapshot.scopeBinding, "unbound");
    assert.equal(facts.snapshot.protectedStageVerified, false);
    assert.equal(facts.snapshot.packaged, false);
    for (const [index, resource] of facts.snapshot.resources.entries()) {
      const slot = slots[index];
      assert.ok(slot, "Native resource roster cannot be padded with fixture slots.");
      assert.equal(resource.kind, slot.kind);
      assert.equal(resource.basename, slot.basename);
      const existing = bindings.get(resource.lifetimeId);
      if (existing) {
        assert.equal(existing.resourceSlotId, slot.resourceSlotId);
      } else {
        const acquisition = facts.calls.findIndex(call => call.resourceLifetimeId === resource.lifetimeId
          && call.returned === "descriptor_acquired_redacted");
        const firstStat = facts.calls.findIndex(call => call.resourceLifetimeId === resource.lifetimeId
          && call.syscall === "fstat" && call.returned === 0);
        assert.ok(acquisition >= 0 && firstStat > acquisition, "Actual acquisition and first fstat are required.");
        bindings.set(resource.lifetimeId, { resourceSlotId: slot.resourceSlotId, nativeLifetimeId: resource.lifetimeId,
          acquisitionCallRef: { effectId, ordinal: acquisition }, firstFstatCallRef: { effectId, ordinal: firstStat } });
      }
    }
    for (const [ordinal, call] of facts.calls.entries()) {
      if (call.syscall !== "close" || call.returned !== 0) continue;
      assert.equal(closeRefs.has(call.resourceLifetimeId), false, "A real lifetime must close exactly once.");
      closeRefs.set(call.resourceLifetimeId, { effectId, ordinal });
    }
    const effect = { effectId, ordinal: effects.length, kind, mode, preparedAt: window.preparedAt,
      ...parameters, executionId: execution.executionId, effectDigest: "0".repeat(64), enteredAt: window.enteredAt,
      observationArtifactId: `${caseId}-observation-${effects.length}-dto`, revision: 2 };
    const observation = { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_effect_v2",
      executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: clone(execution.source),
      effectId, effectDigest: effect.effectDigest,
      native: { state: "returned", calledAt: window.calledAt, returnedAt: window.returnedAt, result: facts },
      host: { state: "returned" }, resourceBindings: clone([...bindings.values()]),
      ...(projection.readbackBytes ? { readbackBytes: projection.readbackBytes } : {}),
      ...(projection.publicationBytes ? { publicationBytes: projection.publicationBytes } : {}), completedAt: new Date().toISOString() };
    effects.push({ effect, observation });
  };
  const finish = () => {
    const final = effects.at(-1)?.observation.native.result;
    assert.equal(effects.at(-1)?.effect.kind, "close_session");
    assert.equal(final.snapshot.resources.length, slots.length);
    const resources = final.snapshot.resources.map(resource => {
      assert.equal(resource.state, "closed");
      assert.ok(closeRefs.has(resource.lifetimeId), "Closure must refer to an actual returned close.");
      return { ...clone(bindings.get(resource.lifetimeId)), state: resource.state,
        closeCallRef: clone(closeRefs.get(resource.lifetimeId)) };
    });
    const terminal = { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_terminal_v2",
      executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: clone(execution.source),
      preparedArtifactId: execution.preparedArtifactId, preparedDigest: execution.preparedDigest,
      outcome: "published_native_only", installationEntered: final.snapshot.installationEntered, effects: [], resources,
      canonicalVisibility: { state: "unverified", blockerCode: "actual_native_graph_only_no_host_scope_or_absolute_canonical_proof" },
      completedAt: new Date().toISOString(), terminalArtifactId: `${caseId}-terminal-dto`,
      terminalDigest: "0".repeat(64), effectSetDigest: "0".repeat(64), effectCount: effects.length, sealedAt: new Date().toISOString() };
    // Only pure envelope digests and references are filled. Native facts are
    // immutable and remain untouched; no clock/identity/call is synthesized.
    return resealDirectoryV2Replay({ execution, terminal, effects });
  };
  return { execution, record, finish, effectCount: () => effects.length };
}

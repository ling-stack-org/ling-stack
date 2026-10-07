import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, officeDirectorySlotsV2, verifyOfficeLocalDirectoryReplayV2 } from "@ling-stack/core";
import { assertOfficeLocalDirectoryWriteForwardAuthority }
  from "../../dist/features/office-documents/office-local-authority.js";
import { projectOfficeLocalNativePacket } from "../../dist/features/office-documents/office-local-native-facts.js";
import { OfficeLocalDirectoryResourceFacts } from "../../dist/features/office-documents/office-local-directory-resource-facts.js";
import { createOfficeLocalDirectoryTerminalArtifact, readOfficeLocalDirectoryHistory }
  from "../../dist/features/office-documents/office-local-directory-terminal.js";
import { officeObservationTime } from "../../dist/features/office-documents/office-local-clock.js";

/**
 * Test-only finite missing-subtree graph. Every packet comes from the original
 * reviewed runtime inside its original Core synchronous effect gate; the real
 * resource ledger/terminal helpers derive all proof data. No adapter closeStage,
 * manufactured history, arbitrary caller executor, native retry or fallback.
 */
export function executeOriginalOfficeDirectoryNativeGraph(f) {
  const { state, runtime, store, tracker } = f, execution = state.execution;
  assert.equal(state.used, false); assert.equal(state.lifecycle.closed, false);
  state.used = true;
  const ledger = new OfficeLocalDirectoryResourceFacts(execution), capabilities = new Map();
  let observedAt = execution.preparedAt;
  const held = slot => ({ capability: capabilities.get(slot), nativeLifetimeId: ledger.binding(slot).nativeLifetimeId });
  const invoke = (specification, nativeCall) => {
    assertOfficeLocalDirectoryWriteForwardAuthority(f.plan);
    const effect = tracker.prepareOfficeLocalDirectoryEffectV2(state.ticket, { ...specification, mode: "forward",
      effectId: randomUUID(), ordinal: f.effects().length, preparedAt: officeObservationTime(observedAt) });
    let native, projection, bindings;
    const packet = tracker.launchOfficeLocalDirectoryEffectV2(state.ticket, effect.effectId, () => {
      assertOfficeLocalDirectoryWriteForwardAuthority(f.plan);
      const calledAt = officeObservationTime(effect.preparedAt), returned = nativeCall(effect.effectId);
      projection = projectOfficeLocalNativePacket(returned);
      try { bindings = ledger.accept(effect.effectId, projection.facts); }
      catch (error) {
        const slots = officeDirectorySlotsV2(execution);
        for (const [index, resource] of projection.facts.snapshot.resources.entries()) {
          const slot = slots[index];
          if (slot?.initialIdentity && resource.identityObserved && !isDeepStrictEqual(slot.initialIdentity, resource.initialIdentity)) {
            f.diagnostic(`Original native capture identity mismatch: ${JSON.stringify({ resourceSlotId: slot.resourceSlotId,
              prepared: slot.initialIdentity, observed: resource.initialIdentity })}`);
          }
        }
        throw error; // Never relax identity, replace facts or retry the capture.
      }
      native = { state: "returned", calledAt, returnedAt: officeObservationTime(calledAt), result: projection.facts };
      return returned;
    }, "forward");
    observedAt = officeObservationTime(native.returnedAt);
    const observation = store.createArtifact({ runId: execution.source.runId, type: "json",
      path: `office/${f.plan.executionId}/genuine-effect-${effect.ordinal}.json`, createdAt: observedAt, sealedPayload: {
        schemaVersion: 2, protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, kind: "office_local_directory_effect_v2",
        executionId: f.plan.executionId, executionIdentityDigest: state.identityDigest, source: execution.source,
        effectId: effect.effectId, effectDigest: effect.effectDigest, native, host: { state: "returned" }, resourceBindings: bindings,
        ...(projection.readbackBytes ? { readbackBytes: projection.readbackBytes } : {}),
        ...(projection.publicationBytes ? { publicationBytes: projection.publicationBytes } : {}), completedAt: observedAt } });
    tracker.recordOfficeLocalDirectoryObservationV2(state.ticket, effect.effectId, observation.id);
    assert.equal(projection.facts.success, true, projection.facts.blockerCode);
    return { packet, projection };
  };
  const resourceEffect = (kind, slot, parameters, nativeCall) => {
    const resource = held(slot);
    return invoke({ kind, resourceSlotId: slot, nativeLifetimeId: resource.nativeLifetimeId, ...parameters },
      effectId => nativeCall(resource.capability, effectId));
  };
  const sync = slot => resourceEffect("fsync_resource", slot, {}, (capability, effectId) => runtime.fsyncResource(state.scope, capability, effectId));
  const captured = invoke({ kind: "capture_parents" }, () => runtime.openSession(state.scope, execution.destination.parentPath));
  capabilities.set(execution.stage.parentResourceSlotId, captured.packet.stageParent);
  capabilities.set(execution.destination.parentResourceSlotId, captured.packet.destinationParent);
  for (const member of execution.members) {
    const parent = held(member.parentResourceSlotId), directory = member.kind === "created_directory";
    const created = invoke({ kind: directory ? "create_directory" : "create_file", resourceSlotId: member.resourceSlotId,
      parentResourceSlotId: member.parentResourceSlotId, parentNativeLifetimeId: parent.nativeLifetimeId, basename: member.basename },
    effectId => directory ? runtime.createDirectory(state.scope, parent.capability, member.basename, effectId)
      : runtime.createFile(state.scope, parent.capability, member.basename, effectId));
    assert.ok(created.packet.capability); capabilities.set(member.resourceSlotId, created.packet.capability);
  }
  const file = execution.members.at(-1);
  resourceEffect("write_file", file.resourceSlotId, { offset: 0, sizeBytes: state.bytes.length },
    (capability, effectId) => runtime.writeFile(state.scope, capability, state.bytes, effectId));
  sync(file.resourceSlotId);
  const read = resourceEffect("read_file", file.resourceSlotId, { expectedBytes: state.bytes.length, budgetBytes: state.bytes.length + 1 },
    (capability, effectId) => runtime.readFile(state.scope, capability, state.bytes.length, state.bytes.length + 1, effectId));
  assert.deepEqual(read.packet.bytes, f.artifact.bytes);
  resourceEffect("close_resource", file.resourceSlotId, {}, (capability, effectId) => runtime.closeResource(state.scope, capability, effectId));
  for (const directory of execution.members.slice(0, -1).reverse()) sync(directory.resourceSlotId);
  const top = execution.members[0], tree = held(top.resourceSlotId), stage = held(execution.stage.parentResourceSlotId),
    destination = held(execution.destination.parentResourceSlotId);
  invoke({ kind: "install_tree", resourceSlotId: top.resourceSlotId, nativeLifetimeId: tree.nativeLifetimeId,
    sourceParentResourceSlotId: execution.stage.parentResourceSlotId, sourceParentNativeLifetimeId: stage.nativeLifetimeId,
    sourceBasename: execution.stage.topBasename, destinationParentResourceSlotId: execution.destination.parentResourceSlotId,
    destinationParentNativeLifetimeId: destination.nativeLifetimeId, destinationBasename: execution.destination.firstMissingComponent, flags: "RENAME_EXCL" },
  effectId => runtime.installTree(state.scope, tree.capability, execution.destination.firstMissingComponent, effectId));
  sync(execution.stage.parentResourceSlotId); sync(execution.destination.parentResourceSlotId);
  const publication = resourceEffect("observe_publication", top.resourceSlotId, { budgetBytes: state.bytes.length + 1 },
    (capability, effectId) => runtime.observePublication(state.scope, capability, state.bytes.length + 1, effectId));
  assert.deepEqual(publication.packet.publicationFiles[0].bytes, f.artifact.bytes);
  invoke({ kind: "close_session" }, () => runtime.closeSession(state.scope));
  state.lifecycle.closed = true;
  const terminalArtifact = createOfficeLocalDirectoryTerminalArtifact(state, "published_native_only");
  tracker.sealOfficeLocalDirectoryTerminalV2(state.ticket,
    { terminalArtifactId: terminalArtifact.artifactId, terminalDigest: terminalArtifact.digest });
  const history = readOfficeLocalDirectoryHistory(state), terminal = f.terminal();
  const graph = verifyOfficeLocalDirectoryReplayV2({ execution: history.execution, effects: history.entries, terminal });
  assert.equal(graph.kind, "graph_verified_only"); assert.equal(graph.coreSafe, false);
  assert.ok(terminal.resources.every(resource => resource.state === "closed"));
  return { terminalArtifact, history, graph };
}

import { randomUUID } from "node:crypto";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, verifyOfficeLocalDirectoryReplayV2,
  type HostOfficeDirectoryNativeObservationV2, type OfficeLocalDirectoryReplayResultV2,
  type PrepareHostOfficeLocalDirectoryEffectV2, type HostOfficeLocalSettlement } from "@ling-stack/core";
import { assertOfficeLocalDirectoryWriteForwardAuthority, officeLocalDirectoryWriteState,
  type OfficeLocalDirectoryWritePlan } from "./office-local-authority.js";
import { officeBytesDigest, officeErrorCode } from "./office-local-members.js";
import { officeObservationTime } from "./office-local-clock.js";
import { projectOfficeLocalNativePacket, type OfficeLocalNativePacketProjection } from "./office-local-native-facts.js";
import type { OfficeLocalNativePacket, OfficeLocalNativeResource } from "./office-local-native-runtime.js";
import { OfficeLocalDirectoryResourceFacts } from "./office-local-directory-resource-facts.js";
import { createOfficeLocalDirectoryTerminalArtifact, readOfficeLocalDirectoryHistory } from "./office-local-directory-terminal.js";
import { closeOriginalOfficeLocalDirectoryWriteWindow,
  settleOriginalOfficeLocalDirectoryWrite } from "./office-local-authority-state.js";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "effectId" | "ordinal" | "preparedAt"> : never;
type FixedEffect = WithoutEnvelope<PrepareHostOfficeLocalDirectoryEffectV2>;
export interface OfficeLocalDirectoryNativeFacts {
  readonly kind: "office_local_directory_native_facts_v2";
  readonly executionId: string;
  readonly targetPath: string;
  readonly outcome: "published_native_only";
  readonly terminalArtifactId: string;
  readonly terminalDigest: string;
  readonly hostStageClosure: "closed";
  readonly graph: OfficeLocalDirectoryReplayResultV2;
  readonly coreSafe: false;
  readonly canonicalVisibility: "unverified";
  readonly packaged: false;
}
/** Consumer result keeps native-only facts separate from the committed Core pair. */
export interface OfficeLocalDirectoryWriteResultV2 {
  readonly kind: "office_local_directory_write_result_v2";
  readonly executionId: string;
  readonly path: string;
  readonly nativeFacts: OfficeLocalDirectoryNativeFacts;
  readonly settlement: HostOfficeLocalSettlement;
}
/** Diagnostic failure only. No field permits retry, permission release or safe settlement. */
export class OfficeLocalDirectoryWriterError extends Error {
  constructor(readonly cause: unknown, readonly executionId: string, readonly terminalArtifactId: string | undefined,
    readonly terminalDigest: string | undefined, readonly terminalSealConfirmed: boolean,
    readonly evidenceAcknowledgment: "confirmed" | "unconfirmed", readonly hostStageClosure: "closed" | "unconfirmed") {
    super("office_local_directory_write_failed"); this.name = "OfficeLocalDirectoryWriterError";
  }
}

/**
 * One private fixed missing-subtree graph over the original Host plan. No caller
 * callbacks, arbitrary effect sequence, path write/rmdir, legacy fallback,
 * native retry or caller-supplied proof. Native facts remain Core-safe unavailable;
 * a consumer result additionally requires the original committed pair and release.
 */
export function executeOfficeLocalDirectoryWrite(plan: OfficeLocalDirectoryWritePlan): OfficeLocalDirectoryWriteResultV2 {
  const state = officeLocalDirectoryWriteState(plan);
  if (state.used) throw new Error("office_local_directory_write_already_entered");
  if (state.lifecycle.closed) throw new Error("office_local_directory_write_closed");
  state.tracker.assertOfficeLocalPlanOpen(state.ticket);
  state.used = true; // Never reset on API, marshalling, COMMIT or ACK failure.
  const resources = new OfficeLocalDirectoryResourceFacts(state.execution);
  const capabilities = new Map<string, OfficeLocalNativeResource>();
  let failure: unknown, failed = false, nativeAttempted = false, sessionCloseAttempted = false, stageClosed = false;
  let acknowledgmentUnconfirmed = false;
  let lastObservedAt = state.execution.preparedAt;
  let terminal: ReturnType<typeof createOfficeLocalDirectoryTerminalArtifact> | undefined, terminalSealConfirmed = false;
  const fail = (error: unknown): void => {
    failure = failed ? new AggregateError([failure, error], "office_local_directory_unconfirmed") : error; failed = true;
  };
  const held = (slot: string): { capability: OfficeLocalNativeResource; nativeLifetimeId: string } => {
    const capability = capabilities.get(slot);
    if (!capability) throw new Error("office_local_directory_capability_unavailable");
    return { capability, nativeLifetimeId: resources.binding(slot).nativeLifetimeId };
  };
  // This closure is private to the fixed graph. It is never accepted from tools,
  // HTTP, MCP options, a serialized plan or an arbitrary external executor.
  const invoke = (specification: FixedEffect, nativeCall: (effectId: string) => OfficeLocalNativePacket): {
    readonly packet: OfficeLocalNativePacket; readonly projection: OfficeLocalNativePacketProjection;
  } => {
    if (specification.mode === "forward") assertOfficeLocalDirectoryWriteForwardAuthority(plan);
    let descriptor: ReturnType<typeof state.tracker.prepareOfficeLocalDirectoryEffectV2>;
    try {
      descriptor = state.tracker.prepareOfficeLocalDirectoryEffectV2(state.ticket, { ...specification,
        effectId: randomUUID(), ordinal: state.store.listHostOfficeLocalDirectoryEffectsV2(plan.executionId).length,
        preparedAt: officeObservationTime(lastObservedAt) });
    } catch (error) {
      // Preparation may have committed without its acknowledgment. Never issue
      // another descriptor to retry the same native operation.
      acknowledgmentUnconfirmed = true; throw error;
    }
    let native: HostOfficeDirectoryNativeObservationV2 = { state: "not_entered" }, packet: OfficeLocalNativePacket | undefined,
      projection: OfficeLocalNativePacketProjection | undefined, bindings: ReturnType<OfficeLocalDirectoryResourceFacts["accept"]> = [];
    const latest = (): { native: HostOfficeDirectoryNativeObservationV2; packet: OfficeLocalNativePacket | undefined;
      projection: OfficeLocalNativePacketProjection | undefined } => ({ native, packet, projection });
    let invocationError: unknown, hostFailed = false;
    try {
      state.tracker.launchOfficeLocalDirectoryEffectV2(state.ticket, descriptor.effectId, () => {
        if (specification.mode === "forward") assertOfficeLocalDirectoryWriteForwardAuthority(plan);
        const calledAt = officeObservationTime(descriptor.preparedAt);
        nativeAttempted = true;
        try { packet = nativeCall(descriptor.effectId); }
        catch (error) {
          native = { state: "threw", calledAt, completedAt: officeObservationTime(calledAt), errorCode: officeErrorCode(error) };
          throw error;
        }
        // Preserve actual normal return even when the checked facts boundary fails.
        const returnedAt = officeObservationTime(calledAt);
        try {
          projection = projectOfficeLocalNativePacket(packet);
          bindings = resources.accept(descriptor.effectId, projection.facts);
        } catch (error) {
          native = { state: "returned_unprojectable", calledAt, returnedAt, errorCode: officeErrorCode(error) };
          throw error;
        }
        native = { state: "returned", calledAt, returnedAt, result: projection.facts };
        return packet;
      }, specification.mode);
    } catch (error) {
      invocationError = error; hostFailed = true;
      // A valid native return followed by a Core launch failure is a distinct
      // ACK axis, not a physical failure or native throw.
      if (latest().native.state === "returned") acknowledgmentUnconfirmed = true;
    }
    const observed = latest(), completedAt = officeObservationTime(observed.native.state === "returned" || observed.native.state === "returned_unprojectable"
      ? observed.native.returnedAt : observed.native.state === "threw" ? observed.native.completedAt : descriptor.preparedAt);
    lastObservedAt = completedAt;
    try {
      const artifact = state.store.createArtifact({ runId: state.execution.source.runId, type: "json",
        path: `office/${plan.executionId}/effect-v2-${descriptor.ordinal}.json`, createdAt: completedAt, sealedPayload: {
          schemaVersion: 2, protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, kind: "office_local_directory_effect_v2",
          executionId: plan.executionId, executionIdentityDigest: state.identityDigest, source: state.execution.source,
          effectId: descriptor.effectId, effectDigest: descriptor.effectDigest, native: observed.native,
          host: hostFailed ? { state: "unconfirmed", errorCode: officeErrorCode(invocationError) } : { state: "returned" },
          resourceBindings: bindings,
          ...(observed.native.state === "returned" && observed.projection?.readbackBytes ? { readbackBytes: observed.projection.readbackBytes } : {}),
          ...(observed.native.state === "returned" && observed.projection?.publicationBytes ? { publicationBytes: observed.projection.publicationBytes } : {}), completedAt,
        } });
      state.tracker.recordOfficeLocalDirectoryObservationV2(state.ticket, descriptor.effectId, artifact.id);
    } catch (error) {
      acknowledgmentUnconfirmed = true;
      invocationError = hostFailed ? new AggregateError([invocationError, error], "office_local_directory_observation_unconfirmed") : error;
      hostFailed = true;
    }
    if (hostFailed) throw invocationError;
    if (!observed.packet || !observed.projection || observed.native.state !== "returned") throw new Error("office_local_directory_native_reply_unconfirmed");
    // Aggregate false is a real normal return; record its errno/partial facts first.
    if (!observed.projection.facts.success) throw new Error(observed.projection.facts.blockerCode ?? "office_local_directory_native_failed");
    return { packet: observed.packet, projection: observed.projection };
  };
  const sync = (slot: string): void => {
    const resource = held(slot);
    invoke({ kind: "fsync_resource", mode: "forward", resourceSlotId: slot, nativeLifetimeId: resource.nativeLifetimeId },
      effectId => state.runtime.fsyncResource(state.scope, resource.capability, effectId));
  };
  const closeSession = (mode: "forward" | "cleanup"): void => {
    invoke({ kind: "close_session", mode }, () => {
      sessionCloseAttempted = true; // Before actual API entry; never retry even if it throws.
      return state.runtime.closeSession(state.scope);
    });
  };
  try {
    assertOfficeLocalDirectoryWriteForwardAuthority(plan);
    const record = state.store.getHostOfficeLocalDirectoryExecutionV2(plan.executionId);
    if (!record || record.identityDigest !== state.identityDigest || state.bytes.length !== record.output.sizeBytes
      || officeBytesDigest(state.bytes) !== record.output.bytesSha256) throw new Error("office_local_bytes_changed");
    const capture = invoke({ kind: "capture_parents", mode: "forward" }, () =>
      state.runtime.openSession(state.scope, state.execution.destination.parentPath));
    if (!capture.packet.stageParent || !capture.packet.destinationParent) throw new Error("office_local_directory_capture_caps_missing");
    capabilities.set(state.execution.stage.parentResourceSlotId, capture.packet.stageParent);
    capabilities.set(state.execution.destination.parentResourceSlotId, capture.packet.destinationParent);
    for (const member of state.execution.members) {
      const parent = held(member.parentResourceSlotId), directory = member.kind === "created_directory";
      const created = invoke({ kind: directory ? "create_directory" : "create_file", mode: "forward",
        resourceSlotId: member.resourceSlotId, parentResourceSlotId: member.parentResourceSlotId,
        parentNativeLifetimeId: parent.nativeLifetimeId, basename: member.basename }, effectId => directory
        ? state.runtime.createDirectory(state.scope, parent.capability, member.basename, effectId)
        : state.runtime.createFile(state.scope, parent.capability, member.basename, effectId));
      if (!created.packet.capability) throw new Error("office_local_directory_creator_cap_missing");
      capabilities.set(member.resourceSlotId, created.packet.capability);
    }
    const file = state.execution.members.at(-1)!, fileResource = held(file.resourceSlotId);
    invoke({ kind: "write_file", mode: "forward", resourceSlotId: file.resourceSlotId,
      nativeLifetimeId: fileResource.nativeLifetimeId, offset: 0, sizeBytes: state.bytes.length },
      effectId => state.runtime.writeFile(state.scope, fileResource.capability, state.bytes, effectId));
    sync(file.resourceSlotId);
    invoke({ kind: "read_file", mode: "forward", resourceSlotId: file.resourceSlotId,
      nativeLifetimeId: fileResource.nativeLifetimeId, expectedBytes: state.bytes.length, budgetBytes: state.bytes.length + 1 },
      effectId => state.runtime.readFile(state.scope, fileResource.capability, state.bytes.length, state.bytes.length + 1, effectId));
    invoke({ kind: "close_resource", mode: "forward", resourceSlotId: file.resourceSlotId, nativeLifetimeId: fileResource.nativeLifetimeId },
      effectId => state.runtime.closeResource(state.scope, fileResource.capability, effectId));
    for (const directory of state.execution.members.slice(0, -1).reverse()) sync(directory.resourceSlotId);
    const top = state.execution.members[0]!, tree = held(top.resourceSlotId), stageParent = held(state.execution.stage.parentResourceSlotId),
      destinationParent = held(state.execution.destination.parentResourceSlotId);
    invoke({ kind: "install_tree", mode: "forward", resourceSlotId: top.resourceSlotId, nativeLifetimeId: tree.nativeLifetimeId,
      sourceParentResourceSlotId: state.execution.stage.parentResourceSlotId, sourceParentNativeLifetimeId: stageParent.nativeLifetimeId,
      sourceBasename: state.execution.stage.topBasename, destinationParentResourceSlotId: state.execution.destination.parentResourceSlotId,
      destinationParentNativeLifetimeId: destinationParent.nativeLifetimeId,
      destinationBasename: state.execution.destination.firstMissingComponent, flags: "RENAME_EXCL" },
      effectId => state.runtime.installTree(state.scope, tree.capability, state.execution.destination.firstMissingComponent, effectId));
    sync(state.execution.stage.parentResourceSlotId); sync(state.execution.destination.parentResourceSlotId);
    invoke({ kind: "observe_publication", mode: "forward", resourceSlotId: top.resourceSlotId,
      nativeLifetimeId: tree.nativeLifetimeId, budgetBytes: state.bytes.length + 1 },
      effectId => state.runtime.observePublication(state.scope, tree.capability, state.bytes.length + 1, effectId));
    closeSession("forward");
  } catch (error) { fail(error); }
  state.lifecycle.closed = true;
  if (failed) {
    try { state.runtime.revokeScope(state.scope); } catch (error) { fail(error); } // Local stop only, no native syscall or new authority.
    if (nativeAttempted && !sessionCloseAttempted) {
      try { closeSession("cleanup"); } catch (error) { fail(error); }
    }
  }
  try {
    terminal = createOfficeLocalDirectoryTerminalArtifact(state, acknowledgmentUnconfirmed ? "unknown" : failed ? "failed" : "published_native_only");
    state.tracker.sealOfficeLocalDirectoryTerminalV2(state.ticket, { terminalArtifactId: terminal.artifactId, terminalDigest: terminal.digest });
    terminalSealConfirmed = true;
  } catch (error) { acknowledgmentUnconfirmed = true; fail(error); }
  if (terminalSealConfirmed) {
    try { closeOriginalOfficeLocalDirectoryWriteWindow(plan); stageClosed = true; }
    catch (error) {
      fail(error);
      try {
        // A revoked owning proof may still complete its one original cleanup
        // before refusing to mint a claim. Historical facts affect only this
        // failure diagnostic, never the grant/release/settlement admission.
        const closed = state.runtime.readCoreWindowClosure(state.scope);
        stageClosed = closed.phase === "closed_pending" && [...closed.stage, ...closed.destination]
          .every(row => row.state === "closed" && row.close === "returned");
      } catch { /* The original close remains unconfirmed; no facts are invented. */ }
    }
  }
  if (failed && !stageClosed) {
    // Failure cleanup closes only the original readonly window, retaining its
    // protection lease and Core blockers. Runtime tombstones reject any retry
    // of an entered/unknown close. This is never a settlement or release path.
    try { state.runtime.closeCoreWindow(state.scope); stageClosed = true; }
    catch (error) { fail(error); }
  }
  let graph: OfficeLocalDirectoryReplayResultV2 | undefined;
  if (!failed && terminal) {
    try {
      const history = readOfficeLocalDirectoryHistory(state), stored = state.store.getHostOfficeLocalDirectoryTerminalV2(plan.executionId);
      if (!stored || stored.terminalArtifactId !== terminal.artifactId || stored.terminalDigest !== terminal.digest) {
        throw new Error("office_local_directory_terminal_unconfirmed");
      }
      graph = verifyOfficeLocalDirectoryReplayV2({ execution: history.execution, terminal: stored, effects: history.entries });
    } catch (error) { fail(error); }
  }
  let settlement: HostOfficeLocalSettlement | undefined;
  if (!failed && terminal && graph && stageClosed) {
    try { settlement = settleOriginalOfficeLocalDirectoryWrite(plan); }
    catch (error) { acknowledgmentUnconfirmed = true; fail(error); }
  }
  if (failed || !terminal || !graph || !stageClosed || !settlement) throw new OfficeLocalDirectoryWriterError(failure, plan.executionId,
    terminal?.artifactId, terminal?.digest, terminalSealConfirmed, acknowledgmentUnconfirmed ? "unconfirmed" : "confirmed",
    stageClosed ? "closed" : "unconfirmed");
  const nativeFacts: OfficeLocalDirectoryNativeFacts = Object.freeze({ kind: "office_local_directory_native_facts_v2", executionId: plan.executionId,
    targetPath: state.execution.targetPath, outcome: "published_native_only", terminalArtifactId: terminal.artifactId,
    terminalDigest: terminal.digest, hostStageClosure: "closed", graph, coreSafe: false, canonicalVisibility: "unverified", packaged: false });
  return Object.freeze({ kind: "office_local_directory_write_result_v2", executionId: plan.executionId,
    path: state.execution.targetPath, nativeFacts, settlement });
}

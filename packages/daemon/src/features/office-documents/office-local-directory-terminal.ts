import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, officeDirectorySlotsV2, validateOfficeDirectoryHistoryV2,
  validateOfficeLocalDirectoryObservationPayloadV2, type HostOfficeDirectoryTerminalResourceV2,
  type HostOfficeLocalDirectoryTerminalManifestV2, type OfficeDirectoryHistoryEntryV2 } from "@ling-stack/core";
import type { OfficeLocalDirectoryWriteState } from "./office-local-authority.js";
import { officeObservationTime } from "./office-local-clock.js";

/** Read only the original immutable artifact set; raw summaries are not lineage. */
export function readOfficeLocalDirectoryHistory(state: OfficeLocalDirectoryWriteState): {
  readonly execution: NonNullable<ReturnType<OfficeLocalDirectoryWriteState["store"]["getHostOfficeLocalDirectoryExecutionV2"]>>;
  readonly entries: readonly OfficeDirectoryHistoryEntryV2[];
} {
  return state.store.readSnapshot(() => {
    const execution = state.store.getHostOfficeLocalDirectoryExecutionV2(state.execution.executionId);
    if (!execution || execution.identityDigest !== state.identityDigest) throw new Error("office_local_directory_terminal_execution_invalid");
    const entries = state.store.listHostOfficeLocalDirectoryEffectsV2(execution.executionId).map(effect => {
      const artifact = effect.observationArtifactId ? state.store.getArtifact(effect.observationArtifactId) : undefined;
      if (effect.observationArtifactId && (!artifact?.contentSha256 || artifact.runId !== execution.source.runId)) {
        throw new Error("office_local_directory_terminal_effect_invalid");
      }
      return { effect, observation: artifact ? validateOfficeLocalDirectoryObservationPayloadV2(execution, effect,
        artifact.sealedPayload, artifact.createdAt) : null };
    });
    return { execution, entries };
  });
}

/**
 * All logical slots are accounted for. An unprojectable/throwing native reply
 * cannot prove no acquisition or known closure; previous real closed lifetimes
 * stay closed. Terminal sealing independently revalidates this entire roster.
 */
export function createOfficeLocalDirectoryTerminalArtifact(state: OfficeLocalDirectoryWriteState,
  requestedOutcome: HostOfficeLocalDirectoryTerminalManifestV2["outcome"]): {
    readonly artifactId: string; readonly digest: string; readonly manifest: HostOfficeLocalDirectoryTerminalManifestV2;
  } {
  const { execution, entries } = readOfficeLocalDirectoryHistory(state), known = validateOfficeDirectoryHistoryV2(entries),
    slots = officeDirectorySlotsV2(execution), unknown = new Set<string>();
  const ancestors = [...execution.stage.ancestors, ...execution.destination.ancestors].map(item => item.resourceSlotId);
  const uncertain = entries.some(({ effect, observation }) => !!effect.enteredAt
    && (!observation || observation.native.state !== "returned" || observation.host.state !== "returned"));
  for (const { effect, observation } of entries) {
    if (!effect.enteredAt || observation?.native.state === "returned") continue;
    if (effect.kind === "capture_parents") for (const id of ancestors) unknown.add(id);
    else if (effect.kind === "close_session") for (const slot of slots) unknown.add(slot.resourceSlotId);
    else if ("resourceSlotId" in effect) {
      unknown.add(effect.resourceSlotId);
      if (effect.kind === "observe_publication") for (const member of execution.members) unknown.add(member.publicationResourceSlotId);
    }
  }
  const calls = entries.flatMap(({ effect, observation }) => observation?.native.state === "returned"
    ? observation.native.result.calls.map((call, ordinal) => ({ call, ref: { effectId: effect.effectId, ordinal } })) : []);
  const resources: HostOfficeDirectoryTerminalResourceV2[] = slots.map(slot => {
    const resource = known.get(slot.resourceSlotId);
    if (!resource) return unknown.has(slot.resourceSlotId)
      ? { resourceSlotId: slot.resourceSlotId, state: "unknown", unknownCause: "native_reply_unknown" }
      : { resourceSlotId: slot.resourceSlotId, state: "not_acquired" };
    const { binding, fact } = resource;
    if (fact.state === "not_acquired") return { resourceSlotId: slot.resourceSlotId, state: "not_acquired" };
    const lastClose = calls.filter(item => item.call.resourceLifetimeId === fact.lifetimeId && item.call.syscall === "close").at(-1);
    if (fact.state === "closed") {
      if (!lastClose || lastClose.call.nativeReturnState !== "returned" || lastClose.call.returned !== 0) {
        throw new Error("office_local_directory_terminal_close_invalid");
      }
      return { ...binding, state: "closed", closeCallRef: lastClose.ref };
    }
    if (fact.state === "unknown") return lastClose
      ? { ...binding, state: "unknown", unknownCause: "close_entered", closeCallRef: lastClose.ref }
      : { ...binding, state: "unknown", unknownCause: "original_fstat_lost" };
    return unknown.has(slot.resourceSlotId)
      ? { ...binding, state: "unknown", unknownCause: "native_reply_unknown" }
      : { ...binding, state: "retained" };
  });
  const effects = entries.map(({ effect }) => {
    const seal = effect.observationArtifactId ? state.store.getArtifact(effect.observationArtifactId) : undefined;
    if (seal && !seal.contentSha256) throw new Error("office_local_directory_terminal_effect_invalid");
    return { ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest,
      enteredAt: effect.enteredAt ?? null, observation: seal ? { artifactId: seal.id, digest: seal.contentSha256! } : null };
  });
  const minimum = entries.reduce((at, { effect, observation }) => {
    const next = observation?.completedAt ?? effect.enteredAt ?? effect.preparedAt;
    return next > at ? next : at;
  }, execution.preparedAt), completedAt = officeObservationTime(minimum);
  const manifest: HostOfficeLocalDirectoryTerminalManifestV2 = { schemaVersion: 2, protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
    kind: "office_local_directory_terminal_v2", executionId: execution.executionId, executionIdentityDigest: execution.identityDigest,
    source: execution.source, preparedArtifactId: execution.preparedArtifactId, preparedDigest: execution.preparedDigest,
    outcome: uncertain ? "unknown" : requestedOutcome,
    // Trusted returned snapshots only. With outcome=unknown, false means no
    // trustworthy installation-entry observation, never physical no-start.
    installationEntered: entries.some(({ observation }) => observation?.native.state === "returned"
      && observation.native.result.snapshot.installationEntered), effects, resources,
    canonicalVisibility: { state: "unverified", blockerCode: "office_local_directory_original_scope_and_absolute_canonical_unverified" }, completedAt };
  const artifact = state.store.createArtifact({ runId: execution.source.runId, type: "json",
    path: `office/${execution.executionId}/terminal-v2.json`, createdAt: completedAt, sealedPayload: manifest });
  if (!artifact.contentSha256) throw new Error("office_local_directory_terminal_artifact_invalid");
  return { artifactId: artifact.id, digest: artifact.contentSha256, manifest };
}

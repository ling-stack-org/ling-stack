import type { HostOfficeLocalDirectoryExecutionRecordV2, HostOfficeDirectoryResourceBindingV2,
  HostOfficeDirectoryCallRefV2 } from "../../host-office-local-directory-v2-types.js";
import type { HostOfficeLocalDirectoryTerminalRecordV2 } from "../../host-office-local-directory-v2-terminal-types.js";
import type { HostOfficeNativeIdentityV2, HostOfficeNativeResourceFactV2, HostOfficeNativeReadbackV2,
  HostOfficeNativeInstallationV2, HostOfficeNativePublicationV2 } from "../../host-office-local-native-v2-types.js";
import { officeDirectorySlotsV2, officeDirectoryPreparedIdentityMatchesV2, type OfficeDirectorySlotV2 } from "./host-office-local-directory-v2-effects.js";
import type { CompleteOfficeDirectoryEntryV2 } from "./host-office-local-directory-v2-replay-integrity.js";
import { OfficeDirectoryCallCursorV2, type ReturnedOfficeDirectoryCallV2 } from "./host-office-local-directory-v2-replay-calls.js";
import { directoryV2Failure, v2Same } from "./host-office-local-directory-v2-validation.js";

export interface OfficeDirectoryReplayResourceV2 {
  readonly slot: OfficeDirectorySlotV2;
  readonly binding: HostOfficeDirectoryResourceBindingV2;
  fact: HostOfficeNativeResourceFactV2;
  modifiedAt: bigint;
  syncedAt: bigint;
  closeCallRef?: HostOfficeDirectoryCallRefV2;
}
/** Native original-lifetime guards do not treat a permission change as FD reuse. */
export const sameOfficeDirectoryLifetimeNodeV2 = (a: HostOfficeNativeIdentityV2, b: HostOfficeNativeIdentityV2): boolean =>
  a.device === b.device && a.inode === b.inode && a.isFile === b.isFile && a.isDirectory === b.isDirectory;
/** Publication acquisition and directory name fences additionally pin mode. */
export const sameOfficeDirectoryNodeV2 = (a: HostOfficeNativeIdentityV2, b: HostOfficeNativeIdentityV2): boolean =>
  sameOfficeDirectoryLifetimeNodeV2(a, b) && a.mode === b.mode;

/** Independent original-lifetime state. Snapshot flags never create ownership, bytes, durability or closure. */
export class OfficeDirectoryReplayResourcesV2 {
  private readonly slots: ReadonlyMap<string, OfficeDirectorySlotV2>;
  private readonly resources = new Map<string, OfficeDirectoryReplayResourceV2>();
  private readonly lifetimes = new Set<string>();
  private readonly acquisitionRefs = new Set<string>();
  private readonly reads: HostOfficeNativeReadbackV2[] = [];
  private nonce?: string;
  private installation?: HostOfficeNativeInstallationV2;
  private publication?: HostOfficeNativePublicationV2;
  private closed = false;
  constructor(readonly execution: HostOfficeLocalDirectoryExecutionRecordV2) {
    this.slots = new Map(officeDirectorySlotsV2(execution).map(slot => [slot.resourceSlotId, slot]));
  }
  get ordered(): readonly OfficeDirectoryReplayResourceV2[] { return [...this.resources.values()]; }
  binding(entry: CompleteOfficeDirectoryEntryV2, slotId: string): HostOfficeDirectoryResourceBindingV2 {
    const binding = entry.observation.resourceBindings.find(item => item.resourceSlotId === slotId);
    if (!binding) return directoryV2Failure();
    return binding;
  }
  get(slotId: string, lifetime?: string): OfficeDirectoryReplayResourceV2 {
    const resource = this.resources.get(slotId);
    if (!resource || lifetime !== undefined && resource.fact.lifetimeId !== lifetime) return directoryV2Failure();
    return resource;
  }
  retained(slotId: string, lifetime?: string): OfficeDirectoryReplayResourceV2 {
    const resource = this.get(slotId, lifetime);
    if (resource.fact.state !== "retained") return directoryV2Failure();
    return resource;
  }
  acquire(cursor: OfficeDirectoryCallCursorV2, slotId: string, syscall: "open" | "openat" | "openat_create_exclusive",
    observerOf?: string): OfficeDirectoryReplayResourceV2 {
    const slot = this.slots.get(slotId), binding = this.binding(cursor.entry, slotId);
    if (!slot || this.resources.has(slotId) || this.lifetimes.has(binding.nativeLifetimeId)) return directoryV2Failure();
    const parent = slot.parentResourceSlotId ? this.retained(slot.parentResourceSlotId).fact.lifetimeId : "";
    const openOrdinal = cursor.ordinal, open = cursor.take(syscall, binding.nativeLifetimeId, parent);
    const statOrdinal = cursor.ordinal, stat = cursor.take("fstat", binding.nativeLifetimeId, parent);
    const initial = stat.identity, refKey = cursor.entry.effect.effectId + ":" + openOrdinal;
    if (open.returned !== "descriptor_acquired_redacted" || !initial || this.acquisitionRefs.has(refKey)
      || !v2Same(binding.acquisitionCallRef ?? null, { effectId: cursor.entry.effect.effectId, ordinal: openOrdinal })
      || !v2Same(binding.firstFstatCallRef ?? null, { effectId: cursor.entry.effect.effectId, ordinal: statOrdinal })
      || slot.initialIdentity && !officeDirectoryPreparedIdentityMatchesV2(slot.initialIdentity, initial)
      || initial.isFile !== ["created_file", "publication_file"].includes(slot.kind) || initial.isDirectory === initial.isFile
      || (observerOf ? open.entryName !== slot.basename : open.entryName !== undefined)
      || slot.kind === "created_file" && initial.sizeBytes !== "0") return directoryV2Failure();
    if (observerOf) {
      if (!sameOfficeDirectoryNodeV2(this.get(observerOf).fact.initialIdentity!, initial)) return directoryV2Failure();
    } else if (slot.kind === "created_file" || slot.kind === "created_directory") {
      if (initial.device !== this.get(slot.parentResourceSlotId!).fact.initialIdentity!.device
        || this.ordered.some(item => item.fact.initialIdentity!.device === initial.device && item.fact.initialIdentity!.inode === initial.inode)) return directoryV2Failure();
    }
    const resource: OfficeDirectoryReplayResourceV2 = { slot, binding, modifiedAt: BigInt(stat.returnedAtMonotonicNs), syncedAt: 0n,
      fact: { lifetimeId: binding.nativeLifetimeId, kind: slot.kind, basename: slot.basename, parentLifetimeId: parent, state: "retained",
        identityObserved: true, device: initial.device, inode: initial.inode, bytesWritten: "0", fsyncReturned: false,
        initialIdentity: initial, identity: initial, initialObservedAtMonotonicNs: stat.returnedAtMonotonicNs, observedAtMonotonicNs: stat.returnedAtMonotonicNs } };
    this.resources.set(slotId, resource); this.lifetimes.add(binding.nativeLifetimeId); this.acquisitionRefs.add(refKey);
    if (slot.kind === "created_file" || slot.kind === "created_directory") this.dirty(slot.parentResourceSlotId!, open.returnedAtMonotonicNs);
    return resource;
  }
  refresh(resource: OfficeDirectoryReplayResourceV2, call: ReturnedOfficeDirectoryCallV2): void {
    if (resource.fact.state !== "retained" || call.syscall !== "fstat" || call.returned !== 0 || !call.identity
      || !sameOfficeDirectoryLifetimeNodeV2(resource.fact.initialIdentity!, call.identity)) return directoryV2Failure();
    resource.fact = { ...resource.fact, identity: call.identity, device: call.identity.device, inode: call.identity.inode,
      observedAtMonotonicNs: call.returnedAtMonotonicNs };
  }
  dirty(slotId: string, at: string): void {
    const resource = this.retained(slotId);
    resource.modifiedAt = BigInt(at); resource.fact = { ...resource.fact, fsyncReturned: false };
  }
  wrote(resource: OfficeDirectoryReplayResourceV2, count: number, at: string): void {
    this.dirty(resource.slot.resourceSlotId, at);
    resource.fact = { ...resource.fact, bytesWritten: String(BigInt(resource.fact.bytesWritten) + BigInt(count)) };
  }
  sync(cursor: OfficeDirectoryCallCursorV2, slotId: string): void {
    const resource = this.retained(slotId), call = cursor.take("fsync", resource.fact.lifetimeId, resource.fact.parentLifetimeId);
    if (call.returned !== 0 || BigInt(call.calledAtMonotonicNs) < resource.modifiedAt) return directoryV2Failure();
    resource.syncedAt = BigInt(call.returnedAtMonotonicNs); resource.fact = { ...resource.fact, fsyncReturned: true };
  }
  requireSynced(slotId: string): OfficeDirectoryReplayResourceV2 {
    const resource = this.get(slotId);
    if (!resource.fact.fsyncReturned || resource.syncedAt < resource.modifiedAt) return directoryV2Failure();
    return resource;
  }
  close(cursor: OfficeDirectoryCallCursorV2, slotId: string): void {
    const resource = this.retained(slotId), ordinal = cursor.ordinal;
    const call = cursor.take("close", resource.fact.lifetimeId, resource.fact.parentLifetimeId);
    if (call.returned !== 0 || resource.closeCallRef) return directoryV2Failure();
    resource.closeCallRef = { effectId: cursor.entry.effect.effectId, ordinal };
    resource.fact = { ...resource.fact, state: "closed" };
  }
  readback(read: HostOfficeNativeReadbackV2): void { this.reads.push(read); }
  installed(installation: HostOfficeNativeInstallationV2, at: string): void {
    if (this.installation) return directoryV2Failure();
    this.installation = installation;
    this.dirty(this.execution.stage.parentResourceSlotId, at); this.dirty(this.execution.destination.parentResourceSlotId, at);
  }
  published(publication: HostOfficeNativePublicationV2): void {
    if (!this.installation || this.publication) return directoryV2Failure();
    this.publication = publication;
  }
  closeSession(cursor: OfficeDirectoryCallCursorV2): void {
    for (const resource of [...this.ordered].reverse()) {
      if (resource.fact.state === "closed") continue;
      if (resource.fact.state !== "retained" || ["publication_file", "publication_directory"].includes(resource.fact.kind)) return directoryV2Failure();
      this.close(cursor, resource.slot.resourceSlotId);
    }
    this.closed = true;
  }
  checkpoint(entry: CompleteOfficeDirectoryEntryV2): void {
    const snapshot = entry.result.snapshot, ordered = this.ordered;
    this.nonce ??= snapshot.sessionNonce;
    const created = ordered.some(item => ["created_file", "created_directory"].includes(item.fact.kind));
    if (snapshot.sessionNonce !== this.nonce || snapshot.phase !== (this.closed ? "closed" : this.installation ? "published_native_only" : "building")
      || snapshot.installationEntered !== !!this.installation || snapshot.residualCreation !== (created && !this.installation)
      || snapshot.everFailed || snapshot.cancelRequested || snapshot.publicationObservationClaimed !== !!this.publication
      || !v2Same(snapshot.installation ?? null, this.installation ?? null) || !v2Same(snapshot.publication ?? null, this.publication ?? null)
      || !v2Same(snapshot.readbacks, this.reads) || snapshot.resources.length !== ordered.length
      || entry.observation.resourceBindings.length !== ordered.length) return directoryV2Failure();
    ordered.forEach((resource, index) => {
      if (!v2Same(snapshot.resources[index], resource.fact)
        || !v2Same(entry.observation.resourceBindings[index], resource.binding)) directoryV2Failure();
    });
  }
  finish(terminal: HostOfficeLocalDirectoryTerminalRecordV2): void {
    if (!this.closed || !this.publication || this.resources.size !== this.slots.size || terminal.resources.length !== this.resources.size) return directoryV2Failure();
    const bySlot = new Map(terminal.resources.map(resource => [resource.resourceSlotId, resource]));
    if (bySlot.size !== this.resources.size) return directoryV2Failure();
    for (const resource of this.ordered) {
      if (resource.fact.state !== "closed" || !resource.closeCallRef
        || !v2Same(bySlot.get(resource.slot.resourceSlotId), { ...resource.binding, state: "closed", closeCallRef: resource.closeCallRef })) return directoryV2Failure();
    }
  }
}

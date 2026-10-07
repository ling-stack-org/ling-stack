import type { HostOfficeFileIdentity, HostOfficeLocalEffectObservation, HostOfficeLocalEffectRecord,
  HostOfficeLocalExecutionRecord } from "../../host-office-local-types.js";
import type { HostOfficeLocalTerminalEffectResource, HostOfficeLocalTerminalManifest,
  HostOfficeLocalTerminalReadResource } from "../../host-office-local-terminal-types.js";
import { hostOperationFailure, hostOperationTimestamp } from "./host-operation-journal-evidence.js";
import { isHostOfficeFileIdentity } from "./host-office-local-identity.js";

export function officeReplayFailure(): never { return hostOperationFailure("host_office_local_replay_invalid"); }
export const sameOfficeReplayNode = (a: HostOfficeFileIdentity, b: HostOfficeFileIdentity): boolean =>
  a.device === b.device && a.inode === b.inode;
const sameIdentity = (a: HostOfficeFileIdentity, b: HostOfficeFileIdentity): boolean => sameOfficeReplayNode(a, b)
  && a.sizeBytes === b.sizeBytes && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && !value.includes("\0");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// Runtime validation must not erase the readonly roster's discriminated union.
const array = (value: unknown): boolean => Array.isArray(value);
const exact = (value: object, keys: readonly string[]): boolean => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const at = hostOperationTimestamp;

export interface OfficeReplayFile {
  readonly identity: HostOfficeFileIdentity;
  readonly sizeBytes: number;
  readonly bytesSha256: string;
}

/**
 * Complete declared resource roster for the fixed synchronous writer. No FD,
 * reopen, path lookup or serialized capability is used here. Refresh reads lack
 * an effectRef/bytes digest in v1, so their causal binding is the exact ordered
 * writer roster plus the original effect's return-to-observation time window.
 */
export class OfficeReplayResources {
  private readonly effects = new Map<string, HostOfficeLocalTerminalEffectResource>();
  private readonly reads: HostOfficeLocalTerminalReadResource[] = [];
  private readonly opened = new Set<string>();
  private readIndex = 0;
  private rosterIndex = 0;

  constructor(private readonly execution: HostOfficeLocalExecutionRecord,
    private readonly terminal: HostOfficeLocalTerminalManifest) {
    if (!array(terminal.resources)) officeReplayFailure();
    const lifetimes = new Set<string>(), readIds = new Set<string>(), nodes = new Set<string>();
    let lastReadCompleted = at(execution.preparedAt);
    for (const resource of terminal.resources) {
      if (!object(resource) || !text(resource.memberId) || !text(resource.resourceLifetimeId)
        || lifetimes.has(resource.resourceLifetimeId) || resource.state !== "closed"
        || !isHostOfficeFileIdentity(resource.identity) || !text(resource.identityObservedAt)
        || !execution.members.some(member => member.memberId === resource.memberId)) officeReplayFailure();
      lifetimes.add(resource.resourceLifetimeId);
      if (resource.origin === "effect") {
        if (!exact(resource, ["origin", "memberId", "resourceLifetimeId", "identity", "identityObservedAt", "state", "openEffectId", "closeEffectId"])
          || !text(resource.openEffectId) || !text(resource.closeEffectId)) officeReplayFailure();
        const node = `${resource.identity.device}:${resource.identity.inode}`;
        if (nodes.has(node)) officeReplayFailure();
        nodes.add(node);
        this.effects.set(resource.resourceLifetimeId, resource);
      } else if (resource.origin === "member_read") {
        if (!exact(resource, ["origin", "memberId", "resourceLifetimeId", "identity", "identityObservedAt", "state",
          "readId", "purpose", "openCalledAt", "openReturnedAt", "closeEnteredAt", "closeReturnedAt"])
          || !text(resource.readId) || readIds.has(resource.readId) || !["refresh", "final"].includes(resource.purpose)) officeReplayFailure();
        readIds.add(resource.readId);
        const called = at(resource.openCalledAt), returned = at(resource.openReturnedAt), identity = at(resource.identityObservedAt);
        const closeEntered = at(resource.closeEnteredAt), closeReturned = at(resource.closeReturnedAt);
        if (called < lastReadCompleted || returned < called || identity < returned || closeEntered < identity
          || closeReturned < closeEntered || closeReturned > at(terminal.completedAt)) officeReplayFailure();
        lastReadCompleted = closeReturned;
        this.reads.push(resource);
      } else officeReplayFailure();
    }
  }

  /** Require the first fstat of the original O_EXCL open, never a later read FD. */
  openedFile(effect: HostOfficeLocalEffectRecord, observation: HostOfficeLocalEffectObservation): HostOfficeFileIdentity {
    const original = observation.openResource, lifetime = effect.resourceLifetimeId;
    if (!lifetime || !original || !isHostOfficeFileIdentity(original.identity) || original.identity.sizeBytes !== 0
      || original.resourceLifetimeId !== lifetime || this.opened.has(lifetime)) return officeReplayFailure();
    const resource = this.effects.get(lifetime);
    if (!resource || resource.memberId !== effect.memberId || resource.openEffectId !== effect.effectId
      || !resource.identity || !sameIdentity(resource.identity, original.identity)
      || resource.identityObservedAt !== original.observedAt) return officeReplayFailure();
    const slot = this.terminal.resources[this.rosterIndex++];
    if (!slot || slot.origin !== "effect" || slot.resourceLifetimeId !== lifetime
      || sameOfficeReplayNode(original.identity, this.execution.workspaceIdentity)
      || this.execution.members.some(member => member.initial.state !== "absent"
        && sameOfficeReplayNode(original.identity, member.initial.identity))) return officeReplayFailure();
    this.opened.add(lifetime);
    this.refresh(effect.memberId, original.identity, 0, observation, original.identity, original.observedAt);
    return original.identity;
  }

  /** Every successful open/write/publication readback contributes exactly one slot. */
  refresh(memberId: string, node: HostOfficeFileIdentity, sizeBytes: number,
    observation: HostOfficeLocalEffectObservation, exactIdentity?: HostOfficeFileIdentity, notBefore?: string): void {
    const read = this.reads[this.readIndex++];
    const slot = this.terminal.resources[this.rosterIndex++];
    if (!read || read.purpose !== "refresh" || read.memberId !== memberId || !read.identity
      || !slot || slot.origin !== "member_read" || slot.resourceLifetimeId !== read.resourceLifetimeId
      || !sameOfficeReplayNode(read.identity, node) || read.identity.sizeBytes !== sizeBytes
      || (exactIdentity && !sameIdentity(read.identity, exactIdentity)) || observation.native.state !== "returned"
      || read.state !== "closed" || at(read.openCalledAt) < at(observation.native.returnedAt)
      || (notBefore !== undefined && at(read.openCalledAt) < at(notBefore))
      || at(read.closeReturnedAt) > at(observation.completedAt)) officeReplayFailure();
  }

  /** A closed snapshot alone is insufficient: bind its exact native close effect. */
  closedFile(effect: HostOfficeLocalEffectRecord): void {
    const lifetime = effect.resourceLifetimeId, resource = lifetime ? this.effects.get(lifetime) : undefined;
    if (!resource || !lifetime || !this.opened.has(lifetime) || resource.memberId !== effect.memberId
      || resource.state !== "closed" || resource.closeEffectId !== effect.effectId) officeReplayFailure();
  }

  /**
   * Compare final bytes and original-node ownership independently, then consume
   * one real, uniquely referenced final read/close for every remaining file.
   * Missing/extra reads cannot disappear behind matching final hashes.
   */
  finish(files: ReadonlyMap<string, OfficeReplayFile>, lastEffectCompletedAt: string): void {
    if (this.opened.size !== this.effects.size || !Array.isArray(this.terminal.members)
      || this.terminal.members.length !== this.execution.members.length) officeReplayFailure();
    let latest = at(lastEffectCompletedAt);
    for (const [index, expected] of this.execution.members.entries()) {
      const member = this.terminal.members[index];
      if (!object(member) || member.memberId !== expected.memberId || member.path !== expected.path || member.role !== expected.role
        || !object(member.final) || member.final.state === "unobserved") officeReplayFailure();
      const previousMemberCompleted = latest;
      const observed = at(member.observedAt);
      if (observed < previousMemberCompleted || observed > at(this.terminal.completedAt)) officeReplayFailure();
      latest = Math.max(latest, observed);
      const file = files.get(expected.memberId);
      if (file) {
        const final = member.final, ref = member.readRef, read = this.reads[this.readIndex++];
        const slot = this.terminal.resources[this.rosterIndex++];
        if (final.state !== "file" || !isHostOfficeFileIdentity(final.identity) || !sameOfficeReplayNode(final.identity, file.identity)
          || final.identity.sizeBytes !== file.sizeBytes || final.sizeBytes !== file.sizeBytes || final.bytesSha256 !== file.bytesSha256
          || !object(ref) || !exact(ref, ["readId", "resourceLifetimeId", "completedAt"])
          || !read || read.purpose !== "final" || read.memberId !== member.memberId || read.state !== "closed" || !read.identity
          || !slot || slot.origin !== "member_read" || slot.resourceLifetimeId !== read.resourceLifetimeId
          || read.readId !== ref.readId || read.resourceLifetimeId !== ref.resourceLifetimeId || read.closeReturnedAt !== ref.completedAt
          || !sameIdentity(read.identity, final.identity) || at(read.openCalledAt) < previousMemberCompleted
          || observed < at(read.identityObservedAt) || observed > at(read.closeEnteredAt)) officeReplayFailure();
        latest = Math.max(latest, at(read.closeReturnedAt));
      } else if (expected.role === "directory") {
        if (expected.initial.state !== "directory" || member.final.state !== "directory" || member.readRef !== undefined
          || !isHostOfficeFileIdentity(member.final.identity) || !sameOfficeReplayNode(expected.initial.identity, member.final.identity)) officeReplayFailure();
      } else if (member.final.state !== "absent" || !exact(member.final, ["state"]) || member.readRef !== undefined) officeReplayFailure();
    }
    const workspace = this.terminal.workspace;
    if (this.readIndex !== this.reads.length || this.rosterIndex !== this.terminal.resources.length
      || !object(workspace) || !object(workspace.final)
      || workspace.final.state !== "directory" || !isHostOfficeFileIdentity(workspace.final.identity)
      || !sameOfficeReplayNode(this.execution.workspaceIdentity, workspace.final.identity)
      || at(workspace.observedAt) < latest || at(workspace.observedAt) > at(this.terminal.completedAt)) officeReplayFailure();
  }
}

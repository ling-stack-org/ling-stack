import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import type { HostOfficeFileIdentity, HostOfficeFileSnapshot, HostOfficeLocalMember } from "@ling-stack/core";
import { officeFileIdentity, sameOfficeNode, sameOfficeFile } from "./office-local-identity.js";
import type { OfficeLocalResourceOwner, OfficeLocalMemberReadResource } from "./office-local-resources.js";
import { officeObservationTime } from "./office-local-clock.js";

export { officeFileIdentity, sameOfficeNode } from "./office-local-identity.js";

export type OfficeLocalMemberState = HostOfficeFileSnapshot
  | { readonly state: "directory"; readonly identity: HostOfficeFileIdentity };
/** Fixed writer's syscall-derived identity, not a new identity inferred from the path. */
export type OfficeLocalMemberTransition = { readonly state: "absent" }
  | { readonly state: "file" | "directory"; readonly identity: HostOfficeFileIdentity };
export interface OfficeLocalMemberFinal {
  readonly memberId: string;
  readonly path: string;
  readonly role: HostOfficeLocalMember["role"];
  readonly final: OfficeLocalMemberState | { readonly state: "unobserved"; readonly errorCode: string };
  readonly observedAt: string;
  readonly readRef?: { readonly readId: string; readonly resourceLifetimeId: string; readonly completedAt: string };
}
export interface OfficeLocalWorkspaceFinal {
  readonly final: { readonly state: "directory"; readonly identity: HostOfficeFileIdentity }
    | { readonly state: "unobserved"; readonly errorCode: string };
  readonly observedAt: string;
}
type MemberErrorCode = "office_local_snapshot_changed" | "office_local_path_unsafe" | "office_document_too_large"
  | "office_local_workspace_invalid" | "office_local_member_invalid";
const memberFailure = (code: MemberErrorCode): never => { throw Object.assign(new Error(code), { code }); };
export const officeBytesDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const officeErrorCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(code) ? code : "office_local_effect_failed";
};
function stat(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

const MAX_MEMBER_BYTES = 50 * 1024 * 1024;
interface MemberObservation {
  readonly state: OfficeLocalMemberState;
  readonly observedAt: string;
  readonly readRef?: OfficeLocalMemberFinal["readRef"];
}
/** One bounded allocation and one descriptor. A growing or replaced path never expands the read budget. */
function observeMember(member: HostOfficeLocalMember, owner: OfficeLocalResourceOwner, purpose: "refresh" | "final",
  owned?: OfficeLocalMemberTransition): MemberObservation {
  const current = stat(member.path);
  if (!current) {
    if (owned && owned.state !== "absent") return memberFailure("office_local_snapshot_changed");
    return { state: Object.freeze({ state: "absent" }), observedAt: new Date().toISOString() };
  }
  if (current.isSymbolicLink()) return memberFailure("office_local_path_unsafe");
  const captured = officeFileIdentity(current);
  if (owned && (owned.state === "absent" || !sameOfficeNode(owned.identity, captured))) {
    return memberFailure("office_local_snapshot_changed");
  }
  if (member.role === "directory" && current.isDirectory()) {
    if (owned && owned.state !== "directory") return memberFailure("office_local_snapshot_changed");
    return { state: Object.freeze({ state: "directory", identity: captured }), observedAt: new Date().toISOString() };
  }
  if (member.role === "directory" || !current.isFile()) return memberFailure("office_local_path_unsafe");
  if (owned && owned.state !== "file") return memberFailure("office_local_snapshot_changed");
  if (current.size > MAX_MEMBER_BYTES) return memberFailure("office_document_too_large");
  const readId = randomUUID(), resourceLifetimeId = randomUUID();
  let resource: OfficeLocalMemberReadResource | undefined, state: OfficeLocalMemberState, observedAt: string;
  let lastReadTime: string | undefined;
  const readTime = (notBefore?: string): string => {
    const minimum = notBefore && (!lastReadTime || notBefore > lastReadTime) ? notBefore : lastReadTime;
    return lastReadTime = officeObservationTime(minimum);
  };
  try {
    const openCalledAt = readTime();
    const fd = openSync(member.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    resource = owner.retainReadOpened({ memberId: member.memberId, resourceLifetimeId, readId, purpose, fd,
      openCalledAt, openReturnedAt: readTime() });
    const opened = owner.inspectUsable(resource);
    readTime(owner.readSnapshot(resource).identityObservedAt);
    if (!opened.isFile || !sameOfficeFile(captured, opened.identity)) return memberFailure("office_local_snapshot_changed");
    const bytes = Buffer.alloc(captured.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) return memberFailure("office_local_snapshot_changed");
      offset += count;
    }
    const after = stat(member.path), descriptorAfter = owner.inspectUsable(resource);
    if (!after?.isFile() || after.isSymbolicLink() || !descriptorAfter.isFile
      || !sameOfficeFile(captured, officeFileIdentity(after)) || !sameOfficeFile(captured, descriptorAfter.identity)) {
      return memberFailure("office_local_snapshot_changed");
    }
    state = Object.freeze({ state: "file", identity: captured, bytesSha256: officeBytesDigest(bytes), sizeBytes: bytes.length });
    observedAt = readTime();
  } finally {
    if (resource) {
      // Do not fstat or retry: a throwing close may already have released this
      // number for an unrelated borrower, even one opening the same inode.
      owner.beginReadClose(resource, readTime());
      closeSync(resource.fd);
      owner.markReadClosed(resource, readTime());
    }
  }
  const read = owner.readSnapshot(resource!);
  if (read.state !== "closed" || !read.identity) return memberFailure("office_local_snapshot_changed");
  return { state: state!, observedAt: observedAt!, readRef: Object.freeze({ readId, resourceLifetimeId, completedAt: read.closeReturnedAt }) };
}

/** Private writer ledger. Never claims descriptor-relative protection against hostile path ABA races. */
export class OfficeLocalMemberLedger {
  readonly #expected = new Map<string, OfficeLocalMemberState>();
  readonly #root: HostOfficeFileIdentity;
  constructor(readonly workspacePath: string, readonly members: readonly HostOfficeLocalMember[], rootIdentity: HostOfficeFileIdentity) {
    const root = lstatSync(workspacePath, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) memberFailure("office_local_workspace_invalid");
    // Preserve preparation's root, never adopt a replacement between capture and issuance.
    if (!rootIdentity || !sameOfficeNode(rootIdentity, officeFileIdentity(root))) memberFailure("office_local_snapshot_changed");
    this.#root = Object.freeze({ ...rootIdentity });
    for (const member of members) this.#expected.set(member.memberId, member.initial);
    this.assertCurrent();
  }
  member(id: string): HostOfficeLocalMember {
    const member = this.members.find(item => item.memberId === id);
    if (!member) return memberFailure("office_local_member_invalid");
    return member;
  }
  #assertAncestors(memberId?: string): void {
    const root = stat(this.workspacePath);
    if (!root?.isDirectory() || root.isSymbolicLink() || !sameOfficeNode(this.#root, officeFileIdentity(root))) {
      memberFailure("office_local_snapshot_changed");
    }
    for (const directory of this.members.filter(member => member.role === "directory" && member.memberId !== memberId)) {
      const current = stat(directory.path), expected = this.#expected.get(directory.memberId)!;
      if (expected.state === "absent" ? !!current : expected.state !== "directory" || !current?.isDirectory()
        || current.isSymbolicLink() || !sameOfficeNode(expected.identity, officeFileIdentity(current))) {
        memberFailure("office_local_snapshot_changed");
      }
    }
  }
  assertCurrent(): void {
    const root = stat(this.workspacePath);
    if (!root?.isDirectory() || root.isSymbolicLink() || !sameOfficeNode(this.#root, officeFileIdentity(root))) {
      memberFailure("office_local_snapshot_changed");
    }
    for (const member of this.members) {
      const current = stat(member.path), expected = this.#expected.get(member.memberId)!;
      const valid = expected.state === "absent" ? !current : !!current && !current.isSymbolicLink()
        && (expected.state === "directory" ? current.isDirectory() && sameOfficeNode(expected.identity, officeFileIdentity(current))
          : current.isFile() && sameOfficeFile(expected.identity, officeFileIdentity(current)));
      if (!valid) memberFailure("office_local_snapshot_changed");
    }
  }
  /** Advance only the existing owned node or a fixed syscall's explicit next identity. */
  refresh(id: string, owner: OfficeLocalResourceOwner, transition?: OfficeLocalMemberTransition): OfficeLocalMemberState {
    const member = this.member(id);
    this.#assertAncestors(id);
    const { state } = observeMember(member, owner, "refresh", transition ?? this.#expected.get(id)!);
    this.#expected.set(id, state);
    return state;
  }
  expected(id: string): OfficeLocalMemberState { return this.#expected.get(this.member(id).memberId)!; }
  /** Compare observed residue with existing ownership, without adopting it or granting Core safe. */
  matchesOwnedFinal(member: OfficeLocalMemberFinal): boolean {
    const original = this.member(member.memberId), expected = this.#expected.get(member.memberId)!, final = member.final;
    if (member.path !== original.path || member.role !== original.role || final.state === "unobserved") return false;
    if (expected.state === "absent") return final.state === "absent";
    if (expected.state === "directory") return final.state === "directory" && sameOfficeNode(expected.identity, final.identity);
    // link/unlink change ctime, and child writes change directory metadata. Node
    // ownership and actual final bytes are the relevant cross-effect invariants.
    return final.state === "file" && sameOfficeNode(expected.identity, final.identity)
      && expected.sizeBytes === final.sizeBytes && expected.bytesSha256 === final.bytesSha256;
  }
  /** Last independent root fence. Child writes may change metadata, but never root ownership. */
  observeWorkspaceFinal(notBefore?: string): OfficeLocalWorkspaceFinal {
    try {
      const root = stat(this.workspacePath);
      if (!root?.isDirectory() || root.isSymbolicLink()) return memberFailure("office_local_snapshot_changed");
      const identity = officeFileIdentity(root);
      if (!sameOfficeNode(this.#root, identity)) memberFailure("office_local_snapshot_changed");
      return { final: { state: "directory", identity }, observedAt: officeObservationTime(notBefore) };
    } catch (error) {
      return { final: { state: "unobserved", errorCode: officeErrorCode(error) }, observedAt: officeObservationTime(notBefore) };
    }
  }
  /** Observation of residue does not adopt external bytes or mint cleanup authority. */
  observeFinal(owner: OfficeLocalResourceOwner): readonly OfficeLocalMemberFinal[] {
    return this.members.map(member => {
      try {
        this.#assertAncestors();
        const observation = observeMember(member, owner, "final");
        return { memberId: member.memberId, role: member.role, path: member.path, final: observation.state,
          observedAt: observation.observedAt, ...(observation.readRef ? { readRef: observation.readRef } : {}) };
      } catch (error) {
        return { memberId: member.memberId, role: member.role, path: member.path,
          final: { state: "unobserved" as const, errorCode: officeErrorCode(error) }, observedAt: new Date().toISOString() };
      }
    });
  }
}

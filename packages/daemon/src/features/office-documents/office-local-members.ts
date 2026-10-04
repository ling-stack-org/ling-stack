import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import type { HostOfficeFileIdentity, HostOfficeFileSnapshot, HostOfficeLocalMember } from "@ling-stack/core";

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
}
export const officeFileIdentity = (stat: BigIntStats): HostOfficeFileIdentity => Object.freeze({ device: String(stat.dev), inode: String(stat.ino),
  sizeBytes: Number(stat.size), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) });
export const sameOfficeNode = (a: HostOfficeFileIdentity, b: HostOfficeFileIdentity): boolean => a.device === b.device && a.inode === b.inode;
const sameFile = (a: HostOfficeFileIdentity, b: HostOfficeFileIdentity): boolean => sameOfficeNode(a, b)
  && a.sizeBytes === b.sizeBytes && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;
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
/** One bounded allocation and one descriptor. A growing or replaced path never expands the read budget. */
function observeMember(member: HostOfficeLocalMember, owned?: OfficeLocalMemberTransition): OfficeLocalMemberState {
  const current = stat(member.path);
  if (!current) {
    if (owned && owned.state !== "absent") return memberFailure("office_local_snapshot_changed");
    return Object.freeze({ state: "absent" });
  }
  if (current.isSymbolicLink()) return memberFailure("office_local_path_unsafe");
  const captured = officeFileIdentity(current);
  if (owned && (owned.state === "absent" || !sameOfficeNode(owned.identity, captured))) {
    return memberFailure("office_local_snapshot_changed");
  }
  if (member.role === "directory" && current.isDirectory()) {
    if (owned && owned.state !== "directory") return memberFailure("office_local_snapshot_changed");
    return Object.freeze({ state: "directory", identity: captured });
  }
  if (member.role === "directory" || !current.isFile()) return memberFailure("office_local_path_unsafe");
  if (owned && owned.state !== "file") return memberFailure("office_local_snapshot_changed");
  if (current.size > MAX_MEMBER_BYTES) return memberFailure("office_document_too_large");
  let fd: number | undefined;
  try {
    fd = openSync(member.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(captured, officeFileIdentity(opened))) return memberFailure("office_local_snapshot_changed");
    const bytes = Buffer.alloc(captured.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) return memberFailure("office_local_snapshot_changed");
      offset += count;
    }
    const after = stat(member.path), descriptorAfter = fstatSync(fd, { bigint: true });
    if (!after?.isFile() || after.isSymbolicLink() || !descriptorAfter.isFile()
      || !sameFile(captured, officeFileIdentity(after)) || !sameFile(captured, officeFileIdentity(descriptorAfter))) {
      return memberFailure("office_local_snapshot_changed");
    }
    return Object.freeze({ state: "file", identity: captured, bytesSha256: officeBytesDigest(bytes), sizeBytes: bytes.length });
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Private writer ledger. Never claims descriptor-relative protection against hostile path ABA races. */
export class OfficeLocalMemberLedger {
  readonly #expected = new Map<string, OfficeLocalMemberState>();
  readonly #root: HostOfficeFileIdentity;
  constructor(readonly workspacePath: string, readonly members: readonly HostOfficeLocalMember[]) {
    const root = lstatSync(workspacePath, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) memberFailure("office_local_workspace_invalid");
    this.#root = officeFileIdentity(root);
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
          : current.isFile() && sameFile(expected.identity, officeFileIdentity(current)));
      if (!valid) memberFailure("office_local_snapshot_changed");
    }
  }
  /** Advance only the existing owned node or a fixed syscall's explicit next identity. */
  refresh(id: string, transition?: OfficeLocalMemberTransition): OfficeLocalMemberState {
    const member = this.member(id);
    this.#assertAncestors(id);
    const state = observeMember(member, transition ?? this.#expected.get(id)!);
    this.#expected.set(id, state);
    return state;
  }
  expected(id: string): OfficeLocalMemberState { return this.#expected.get(this.member(id).memberId)!; }
  /** Observation of residue does not adopt external bytes or mint cleanup authority. */
  observeFinal(): readonly OfficeLocalMemberFinal[] {
    return this.members.map(member => {
      try {
        this.#assertAncestors();
        const final = observeMember(member);
        return { memberId: member.memberId, role: member.role, path: member.path, final };
      } catch (error) {
        return { memberId: member.memberId, role: member.role, path: member.path,
          final: { state: "unobserved" as const, errorCode: officeErrorCode(error) } };
      }
    });
  }
}

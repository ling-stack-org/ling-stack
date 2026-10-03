import { createHash } from "node:crypto";
import { lstatSync, readFileSync, type BigIntStats } from "node:fs";
import type { HostOfficeFileIdentity, HostOfficeFileSnapshot, HostOfficeLocalMember } from "@ling-stack/core";

export type OfficeLocalMemberState = HostOfficeFileSnapshot
  | { readonly state: "directory"; readonly identity: HostOfficeFileIdentity };
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
export const officeBytesDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const officeErrorCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(code) ? code : "office_local_effect_failed";
};
function stat(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Private writer ledger. Never claims descriptor-relative protection against hostile path ABA races. */
export class OfficeLocalMemberLedger {
  readonly #expected = new Map<string, OfficeLocalMemberState>();
  readonly #root: HostOfficeFileIdentity;
  constructor(readonly workspacePath: string, readonly members: readonly HostOfficeLocalMember[]) {
    const root = lstatSync(workspacePath, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("office_local_workspace_invalid");
    this.#root = officeFileIdentity(root);
    for (const member of members) this.#expected.set(member.memberId, member.initial);
    this.assertCurrent();
  }
  member(id: string): HostOfficeLocalMember {
    const member = this.members.find(item => item.memberId === id);
    if (!member) throw new Error("office_local_member_invalid");
    return member;
  }
  assertCurrent(): void {
    const root = stat(this.workspacePath);
    if (!root?.isDirectory() || root.isSymbolicLink() || !sameOfficeNode(this.#root, officeFileIdentity(root))) {
      throw new Error("office_local_snapshot_changed");
    }
    for (const member of this.members) {
      const current = stat(member.path), expected = this.#expected.get(member.memberId)!;
      const valid = expected.state === "absent" ? !current : !!current && !current.isSymbolicLink()
        && (expected.state === "directory" ? current.isDirectory() && sameOfficeNode(expected.identity, officeFileIdentity(current))
          : current.isFile() && sameFile(expected.identity, officeFileIdentity(current)));
      if (!valid) throw new Error("office_local_snapshot_changed");
    }
  }
  /** Read the exact member immediately after its syscall, including partial writes. */
  refresh(id: string): OfficeLocalMemberState {
    const member = this.member(id), current = stat(member.path);
    let state: OfficeLocalMemberState = { state: "absent" };
    if (current) {
      if (current.isSymbolicLink()) throw new Error("office_local_path_unsafe");
      if (member.role === "directory" && current.isDirectory()) state = { state: "directory", identity: officeFileIdentity(current) };
      else if (member.role !== "directory" && current.isFile() && current.size <= 50 * 1024 * 1024) {
        const bytes = readFileSync(member.path), after = stat(member.path);
        if (!after || bytes.length !== Number(current.size) || !sameFile(officeFileIdentity(current), officeFileIdentity(after))) {
          throw new Error("office_local_snapshot_changed");
        }
        state = { state: "file", identity: officeFileIdentity(after), bytesSha256: officeBytesDigest(bytes), sizeBytes: bytes.length };
      } else throw new Error("office_local_path_unsafe");
    }
    this.#expected.set(id, state);
    return state;
  }
  expected(id: string): OfficeLocalMemberState { return this.#expected.get(this.member(id).memberId)!; }
  /** Observation of residue does not adopt external bytes or mint cleanup authority. */
  observeFinal(): readonly OfficeLocalMemberFinal[] {
    return this.members.map(member => {
      try {
        const final = this.refresh(member.memberId);
        return { memberId: member.memberId, role: member.role, path: member.path, final };
      } catch (error) {
        return { memberId: member.memberId, role: member.role, path: member.path,
          final: { state: "unobserved" as const, errorCode: officeErrorCode(error) } };
      }
    });
  }
}

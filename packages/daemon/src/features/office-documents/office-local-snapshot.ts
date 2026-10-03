import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostOfficeFileIdentity, HostOfficeFileSnapshot, HostOfficeLocalFormat, HostOperationSource } from "@ling-stack/core";

const MAX_BYTES = 50 * 1024 * 1024;
declare const officeSnapshotBrand: unique symbol;
export interface OfficeLocalReadSnapshot {
  readonly [officeSnapshotBrand]: true;
  readonly source: HostOperationSource;
  readonly workspacePath: string;
  readonly targetPath: string;
  readonly format: HostOfficeLocalFormat;
  readonly input: HostOfficeFileSnapshot;
  readonly directories: readonly { readonly path: string; readonly identity?: HostOfficeFileIdentity }[];
}
interface OwnedSnapshot { readonly bytes?: Buffer; readonly rootIdentity: HostOfficeFileIdentity }
const snapshots = new WeakMap<OfficeLocalReadSnapshot, OwnedSnapshot>();
const fail = (code: string): never => { throw new Error(code); };
const identity = (stat: BigIntStats): HostOfficeFileIdentity => Object.freeze({ device: String(stat.dev), inode: String(stat.ino),
  sizeBytes: Number(stat.size), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) });
const sameFile = (left: HostOfficeFileIdentity, right: HostOfficeFileIdentity): boolean => left.device === right.device
  && left.inode === right.inode && left.sizeBytes === right.sizeBytes && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs;
const sameNode = (left: HostOfficeFileIdentity, right: HostOfficeFileIdentity): boolean => left.device === right.device && left.inode === right.inode;
function optionalStat(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/**
 * Fixed synchronous reader: no mkdir, backup, publication, network or asynchronous
 * reopening. Its bytes belong to the original source. It is not execution authority;
 * the private Host issuer must enforce that source before reading and every write.
 */
export function captureOfficeLocalSnapshot(workspaceCwd: string, requestedPath: string, format: HostOfficeLocalFormat,
  source: HostOperationSource): OfficeLocalReadSnapshot {
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.length > 4096 || requestedPath.includes("\0")
    || !["xlsx", "docx", "pptx"].includes(format)) return fail("office_local_path_invalid");
  const workspacePath = realpathSync(resolve(workspaceCwd)), root = lstatSync(workspacePath, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) return fail("office_local_workspace_invalid");
  const targetPath = resolve(workspacePath, requestedPath), rel = relative(workspacePath, targetPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || extname(targetPath).toLowerCase() !== `.${format}`) {
    return fail("office_local_path_invalid");
  }
  const directories: { readonly path: string; readonly identity?: HostOfficeFileIdentity }[] = [];
  let parent = workspacePath, missing = false;
  for (const segment of rel.split(sep).slice(0, -1)) {
    parent = join(parent, segment);
    const stat = missing ? undefined : optionalStat(parent);
    if (!stat) missing = true;
    else if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("office_local_path_unsafe");
    directories.push(Object.freeze({ path: parent, ...(stat ? { identity: identity(stat) } : {}) }));
  }
  const before = missing ? undefined : optionalStat(targetPath);
  let bytes: Buffer | undefined, input: HostOfficeFileSnapshot = Object.freeze({ state: "absent" });
  if (before) {
    if (!before.isFile() || before.isSymbolicLink()) return fail("office_local_path_unsafe");
    if (before.size <= 0 || before.size > MAX_BYTES) return fail("office_document_too_large");
    let fd: number | undefined;
    try {
      // Reject final symlinks on platforms exposing O_NOFOLLOW. Descriptor and path
      // identity are checked too; the final symlink check is not the sole fence.
      fd = openSync(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd, { bigint: true }), capturedIdentity = identity(opened);
      if (!opened.isFile() || !sameFile(identity(before), capturedIdentity)) return fail("office_local_snapshot_changed");
      bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) return fail("office_local_snapshot_changed");
        offset += count;
      }
      const after = optionalStat(targetPath);
      if (!after || !after.isFile() || after.isSymbolicLink() || !sameFile(capturedIdentity, identity(after))
        || !sameFile(capturedIdentity, identity(fstatSync(fd, { bigint: true })))) return fail("office_local_snapshot_changed");
      input = Object.freeze({ state: "file", identity: capturedIdentity, bytesSha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length });
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const snapshot = Object.freeze({ source: Object.freeze({ ...source }), workspacePath, targetPath, format,
    input, directories: Object.freeze(directories) }) as OfficeLocalReadSnapshot;
  snapshots.set(snapshot, { bytes, rootIdentity: identity(root) });
  revalidateOfficeLocalSnapshot(snapshot);
  return snapshot;
}

/** Each consumer gets its own copy. A serializer cannot mutate the reader's source bytes. */
export function copyOfficeLocalSnapshotBytes(snapshot: OfficeLocalReadSnapshot): Buffer | undefined {
  const owned = snapshots.get(snapshot) ?? fail("office_local_snapshot_invalid");
  return owned.bytes ? Buffer.from(owned.bytes) : undefined;
}

/** Revalidate immediately before effects; never overwrites a known external update. */
export function revalidateOfficeLocalSnapshot(snapshot: OfficeLocalReadSnapshot): void {
  const owned = snapshots.get(snapshot) ?? fail("office_local_snapshot_invalid");
  const root = optionalStat(snapshot.workspacePath);
  if (!root || !root.isDirectory() || root.isSymbolicLink() || !sameNode(owned.rootIdentity, identity(root))) return fail("office_local_snapshot_changed");
  for (const directory of snapshot.directories) {
    const current = optionalStat(directory.path);
    if (directory.identity ? !current || !current.isDirectory() || current.isSymbolicLink() || !sameNode(directory.identity, identity(current)) : !!current) {
      return fail("office_local_snapshot_changed");
    }
  }
  const current = optionalStat(snapshot.targetPath);
  if (snapshot.input.state === "absent") {
    if (current) return fail("office_local_snapshot_changed");
  } else if (!current || !current.isFile() || current.isSymbolicLink() || !sameFile(snapshot.input.identity, identity(current))) {
    return fail("office_local_snapshot_changed");
  }
}

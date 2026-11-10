import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, realpathSync,
  writeSync, type BigIntStats,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isPathInsideRoot } from "../../shared/path.js";

interface DirectoryIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

/** Observed paths/identities, not a permission grant or an OS-atomic filesystem lease. */
export interface ExternalWorkflowPathAdmission {
  readonly root: string;
  readonly path: string;
  readonly directories: readonly DirectoryIdentity[];
  readonly existing?: BigIntStats;
}

/** Bytes actually read from the admitted file; never re-resolve the original alias for the response. */
export interface ExternalWorkflowFileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly markdown?: string;
  readonly bytes?: Buffer;
  readonly identity?: BigIntStats;
}

const changed = (): Error => new Error("Workflow path changed during configuration");
const outside = (): Error => new Error("workflowPath must resolve inside the channel bound path");

function lstatIfMissing(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function directoryIdentity(root: string, path: string): DirectoryIdentity {
  if (!isPathInsideRoot(root, path)) throw outside();
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workflow parent is not a directory");
  if (realpathSync(path) !== path) throw changed();
  return { path, device: stat.dev, inode: stat.ino };
}

function assertDirectoriesCurrent(admission: Pick<ExternalWorkflowPathAdmission, "root" | "directories">): void {
  for (const original of admission.directories) {
    const current = directoryIdentity(admission.root, original.path);
    if (current.device !== original.device || current.inode !== original.inode) throw changed();
  }
}

function addCanonicalParents(root: string, target: string, directories: DirectoryIdentity[]): void {
  let current = root;
  for (const component of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!directories.some(directory => directory.path === current)) directories.push(directoryIdentity(root, current));
  }
}

/**
 * Admit every existing ancestor before creating anything, then create only one
 * already-admitted level at a time. These checks fix static symlink escape;
 * concurrent external rename/link changes are not made atomic by rechecking.
 */
export function admitExternalWorkflowPath(rootInput: string, workflowPathInput: string | undefined): ExternalWorkflowPathAdmission {
  const root = realpathSync(rootInput);
  const requested = resolve(root, workflowPathInput || "WORKFLOW.md");
  if (!isPathInsideRoot(root, requested)) throw outside();
  if (requested === root) throw new Error("Workflow path is not a file");

  const directories = [directoryIdentity(root, root)];
  const components = relative(root, requested).split(sep);
  const leaf = components.pop()!;
  let parent = root;
  let missingAt = components.length;
  for (const [index, component] of components.entries()) {
    const candidate = join(parent, component);
    const existing = lstatIfMissing(candidate);
    if (!existing) { missingAt = index; break; }
    // A dangling link exists: realpath failure must not be mistaken for a missing parent.
    const canonical = realpathSync(candidate);
    if (!isPathInsideRoot(root, canonical)) throw outside();
    directories.push(directoryIdentity(root, canonical));
    parent = canonical;
  }

  assertDirectoriesCurrent({ root, directories });
  for (const component of components.slice(missingAt)) {
    assertDirectoriesCurrent({ root, directories });
    const next = join(parent, component);
    // In particular, EEXIST is a conflict, not permission to follow a newly supplied link.
    mkdirSync(next);
    directories.push(directoryIdentity(root, next));
    parent = next;
  }

  const candidate = join(parent, leaf);
  const existing = lstatIfMissing(candidate);
  if (!existing) {
    assertDirectoriesCurrent({ root, directories });
    return { root, path: candidate, directories };
  }
  const path = realpathSync(candidate);
  if (!isPathInsideRoot(root, path)) throw outside();
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("Workflow path is not a file");
  addCanonicalParents(root, path, directories);
  assertDirectoriesCurrent({ root, directories });
  return { root, path, directories, existing: file };
}

function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return second.isFile() && !second.isSymbolicLink() && first.dev === second.dev && first.ino === second.ino;
}

function sameFileState(first: BigIntStats, second: BigIntStats): boolean {
  return sameFile(first, second) && first.size === second.size && first.mode === second.mode
    && first.uid === second.uid && first.gid === second.gid && first.nlink === second.nlink
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function assertOpenFileCurrent(admission: ExternalWorkflowPathAdmission, fd: number, original: BigIntStats): void {
  assertDirectoriesCurrent(admission);
  const pathIdentity = lstatSync(admission.path, { bigint: true });
  if (!sameFile(original, fstatSync(fd, { bigint: true })) || !sameFile(original, pathIdentity)
    || realpathSync(admission.path) !== admission.path) throw changed();
}

/** Explicit offsets avoid depending on an earlier validation read's descriptor cursor. */
function readBytes(fd: number, original: BigIntStats): Buffer {
  const size = Number(original.size);
  if (!Number.isSafeInteger(size) || size < 0) throw changed();
  const bytes = Buffer.alloc(size);
  let position = 0;
  while (position < size) {
    const count = readSync(fd, bytes, position, Math.min(65_536, size - position), position);
    if (count === 0) throw changed();
    position += count;
  }
  if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0 || !sameFileState(original, fstatSync(fd, { bigint: true }))) throw changed();
  return bytes;
}

// Windows does not provide these POSIX open guarantees. Path/FD checks remain,
// without claiming that they close its (or POSIX ancestor) OS race windows.
const guardedOpenFlags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function readAdmittedExternalWorkflowFile(admission: ExternalWorkflowPathAdmission): ExternalWorkflowFileSnapshot {
  assertDirectoriesCurrent(admission);
  if (!admission.existing) {
    if (lstatIfMissing(admission.path)) throw changed();
    return { path: admission.path, exists: false };
  }
  const fd = openSync(admission.path, constants.O_RDONLY | guardedOpenFlags);
  try {
    const identity = fstatSync(fd, { bigint: true });
    if (!sameFileState(admission.existing, identity)) throw changed();
    assertOpenFileCurrent(admission, fd, identity);
    const bytes = readBytes(fd, identity);
    assertOpenFileCurrent(admission, fd, identity);
    return { path: admission.path, exists: true, markdown: bytes.toString("utf8"), bytes, identity };
  } finally { closeSync(fd); }
}

/**
 * Create exclusively, or update the same invalid file only after a non-truncating
 * open and preimage check. A partial IO failure is reported, never cleaned up by
 * guessing a pathname owner or blindly retried. This is not an atomic replace.
 */
export function writeAdmittedExternalWorkflowFile(admission: ExternalWorkflowPathAdmission,
  snapshot: ExternalWorkflowFileSnapshot, markdown: string): ExternalWorkflowFileSnapshot {
  if (snapshot.path !== admission.path || snapshot.exists !== Boolean(admission.existing)
    || snapshot.exists && (!snapshot.identity || !snapshot.bytes)) throw changed();
  assertDirectoriesCurrent(admission);
  const fd = openSync(admission.path, constants.O_RDWR | guardedOpenFlags
    | (snapshot.exists ? 0 : constants.O_CREAT | constants.O_EXCL));
  try {
    const original = fstatSync(fd, { bigint: true });
    if (!original.isFile() || snapshot.exists && !sameFileState(snapshot.identity!, original)) throw changed();
    assertOpenFileCurrent(admission, fd, original);
    if (snapshot.exists && !readBytes(fd, original).equals(snapshot.bytes!)) throw changed();
    assertOpenFileCurrent(admission, fd, original);
    const expected = Buffer.from(markdown, "utf8");
    let position = 0;
    while (position < expected.length) {
      const count = writeSync(fd, expected, position, Math.min(65_536, expected.length - position), position);
      if (count === 0) throw new Error("Workflow file write made no progress");
      position += count;
    }
    ftruncateSync(fd, expected.length);
    assertOpenFileCurrent(admission, fd, original);
    const identity = fstatSync(fd, { bigint: true });
    const bytes = readBytes(fd, identity);
    if (!bytes.equals(expected)) throw changed();
    assertOpenFileCurrent(admission, fd, identity);
    return { path: admission.path, exists: true, markdown: bytes.toString("utf8"), bytes, identity };
  } finally { closeSync(fd); }
}

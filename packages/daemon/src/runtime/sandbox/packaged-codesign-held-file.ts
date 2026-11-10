import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";

export interface OriginalCodesignHeldFile {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly identity: Readonly<{ path: string; device: string; inode: string; uid: string; mode: string; sizeBytes: number }>;
  assertCurrent(): void;
  /** A fresh bounded copy read from the original FD, never a path re-open. */
  readBytes(): Buffer;
  close(): void;
}
function requireFile(value: unknown): asserts value { if (!value) throw new Error("packaged_codesign_host_source_invalid"); }
const sameFile = (first: BigIntStats, second: BigIntStats): boolean => second.isFile() && !second.isSymbolicLink()
  && first.dev === second.dev && first.ino === second.ino && first.uid === second.uid && first.mode === second.mode
  && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;

/** Original readonly lifetime/integrity only; mode, digest and path never establish publisher trust. */
export function captureOriginalCodesignFile(path: string, maximum: number, osOwned: boolean, executable = true): OriginalCodesignHeldFile {
  const initial = lstatSync(path, { bigint: true });
  requireFile(initial.isFile() && !initial.isSymbolicLink() && realpathSync(path) === path
    && initial.size > 0n && initial.size <= BigInt(maximum) && (initial.mode & 0o022n) === 0n
    && (!executable || (initial.mode & 0o111n) !== 0n) && (!osOwned || initial.uid === 0n));
  let fd: number | undefined, acquired: BigIntStats | undefined;
  let lifetime: "retained" | "closed" | "unknown" = "retained";
  const sameAcquired = (actual: BigIntStats): boolean => acquired !== undefined && acquired.dev === actual.dev
    && acquired.ino === actual.ino && (acquired.mode & 0o170000n) === (actual.mode & 0o170000n);
  const statOriginal = (): BigIntStats => {
    requireFile(lifetime === "retained" && fd !== undefined);
    let actual: BigIntStats;
    try { actual = fstatSync(fd, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EBADF") { fd = undefined; lifetime = "unknown"; }
      throw error;
    }
    if (acquired && !sameAcquired(actual)) {
      fd = undefined; lifetime = "unknown";
      throw new Error("packaged_codesign_original_file_changed");
    }
    acquired ??= actual; // The first path/open mismatch still owns this newly acquired FD.
    if (!sameFile(initial, actual)) throw new Error("packaged_codesign_original_file_changed");
    return actual;
  };
  const readOriginal = (onBytes: (bytes: Buffer, offset: number) => void): void => {
    statOriginal();
    const bytes = Buffer.allocUnsafe(Math.min(1024 * 1024, Number(initial.size)));
    let offset = 0;
    while (offset < Number(initial.size)) {
      let count: number;
      try { count = readSync(fd!, bytes, 0, Math.min(bytes.length, Number(initial.size) - offset), offset); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EBADF") { fd = undefined; lifetime = "unknown"; }
        throw error;
      }
      requireFile(count > 0); onBytes(bytes.subarray(0, count), offset); offset += count;
    }
    statOriginal();
  };
  const digest = (): string => {
    const output = createHash("sha256"); readOriginal(bytes => output.update(bytes)); return output.digest("hex");
  };
  const close = (): void => {
    if (lifetime === "closed") return;
    requireFile(lifetime === "retained" && fd !== undefined);
    if (acquired) {
      let actual: BigIntStats;
      try { actual = fstatSync(fd, { bigint: true }); }
      catch (error) { fd = undefined; lifetime = "unknown"; throw error; }
      if (!sameAcquired(actual)) {
        fd = undefined; lifetime = "unknown";
        throw new Error("packaged_codesign_original_file_changed");
      }
    }
    const original = fd; fd = undefined; lifetime = "unknown";
    closeSync(original); lifetime = "closed";
  };
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    statOriginal();
    const sha256 = digest();
    const assertCurrent = (): void => {
      statOriginal();
      requireFile(realpathSync(path) === path && sameFile(initial, lstatSync(path, { bigint: true })) && digest() === sha256);
      statOriginal();
    };
    const readBytes = (): Buffer => {
      assertCurrent(); const bytes = Buffer.alloc(Number(initial.size));
      readOriginal((part, offset) => part.copy(bytes, offset));
      requireFile(createHash("sha256").update(bytes).digest("hex") === sha256); assertCurrent(); return bytes;
    };
    assertCurrent();
    return Object.freeze({ sha256, sizeBytes: Number(initial.size), readBytes, assertCurrent, close,
      identity: Object.freeze({ path, device: String(initial.dev), inode: String(initial.ino), uid: String(initial.uid),
        mode: String(initial.mode), sizeBytes: Number(initial.size) }) });
  } catch (error) {
    if (fd !== undefined && lifetime === "retained") {
      try { close(); } catch (closeError) { throw new AggregateError([error, closeError], "packaged_codesign_identity_close_unknown"); }
    }
    throw error;
  }
}

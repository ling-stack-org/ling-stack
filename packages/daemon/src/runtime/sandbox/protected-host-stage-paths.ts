import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

interface HeldPath {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  fd: number | undefined;
  state: "retained" | "closed" | "unknown";
  firstIdentity?: { readonly uid: string; readonly mode: string };
  close: "not_entered" | "returned" | "unknown";
}
/** Historical original-FD observations, not live custody, mkdir creator or Core settlement authority. */
export interface ProtectedHostStagePathClosureFact {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: string;
  readonly mode: string;
  readonly acquisition: "returned";
  readonly firstIdentity: "matched";
  readonly state: "retained" | "closed" | "unknown";
  readonly close: "not_entered" | "returned" | "unknown";
}
/** Readonly original descriptor ownership, never mkdir creator or path-deletion authority. */
export interface ProtectedHostStagePaths {
  readonly stagePath: string;
  readonly ancestors: readonly string[];
  assertCurrent(): void;
  identityFacts(): readonly { readonly path: string; readonly device: string; readonly inode: string;
    readonly uid: string; readonly mode: string }[];
  readTerminalClosureFacts(): readonly ProtectedHostStagePathClosureFact[];
  close(): void;
}
const same = (stat: BigIntStats, held: HeldPath): boolean => stat.isDirectory() && !stat.isSymbolicLink()
  && stat.dev === held.device && stat.ino === held.inode;

/** Capture an existing canonical directory and all ancestors; partial failure closes originals once. */
export function captureProtectedHostStagePaths(requested: string): ProtectedHostStagePaths {
  if (!isAbsolute(requested) || resolve(requested) !== requested || dirname(requested) === requested
    || realpathSync(requested) !== requested) throw new Error("protected_host_stage_path_invalid");
  const paths = [requested];
  while (dirname(paths.at(-1)!) !== paths.at(-1)) paths.push(dirname(paths.at(-1)!));
  paths.reverse();
  const held: HeldPath[] = [];
  const close = (): void => {
    const errors: unknown[] = [];
    for (const path of [...held].reverse()) {
      if (path.state !== "retained" || path.fd === undefined) continue;
      const fd = path.fd;
      path.fd = undefined; path.state = "unknown"; path.close = "unknown"; // Tombstone before the one original close; never retry an integer.
      try { closeSync(fd); path.state = "closed"; path.close = "returned"; } catch (error) { errors.push(error); }
    }
    if (errors.length || held.some(path => path.state === "unknown")) {
      throw new AggregateError(errors, "protected_host_stage_close_unknown");
    }
  };
  const assertCurrent = (): void => {
    for (const path of held) {
      if (path.state !== "retained" || path.fd === undefined) throw new Error("protected_host_stage_identity_changed");
      let original: BigIntStats;
      try { original = fstatSync(path.fd, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EBADF") { path.fd = undefined; path.state = "unknown"; }
        throw error;
      }
      if (!same(original, path)) {
        // An acquired FD cannot change inode/type. This integer is no longer our original lifetime.
        path.fd = undefined; path.state = "unknown";
        throw new Error("protected_host_stage_identity_changed");
      }
      if (realpathSync(path.path) !== path.path || !same(lstatSync(path.path, { bigint: true }), path)) {
        throw new Error("protected_host_stage_identity_changed");
      }
    }
  };
  try {
    for (const path of paths) {
      const initial = lstatSync(path, { bigint: true });
      if (!initial.isDirectory() || initial.isSymbolicLink() || realpathSync(path) !== path) throw new Error("protected_host_stage_path_invalid");
      const row: HeldPath = { path, device: initial.dev, inode: initial.ino, fd: undefined, state: "retained", close: "not_entered" };
      held.push(row); // Retain the slot before opening; a failed fstat must not lose an acquired original FD.
      row.fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let acquired: BigIntStats;
      try { acquired = fstatSync(row.fd, { bigint: true }); }
      catch (error) {
        // True EBADF proves this acquired lifetime is gone, including before its first identity seal.
        if ((error as NodeJS.ErrnoException).code === "EBADF") { row.fd = undefined; row.state = "unknown"; }
        throw error;
      }
      // Initial path/FD mismatch still owns the just-opened original FD; partial cleanup must close it.
      if (!same(acquired, row)) throw new Error("protected_host_stage_identity_changed");
      row.firstIdentity = Object.freeze({ uid: String(acquired.uid), mode: String(acquired.mode) });
    }
    assertCurrent();
    const identityFacts = (): ReturnType<ProtectedHostStagePaths["identityFacts"]> => {
      assertCurrent();
      const facts = held.map(path => {
        const stat = fstatSync(path.fd!, { bigint: true });
        return Object.freeze({ path: path.path, device: String(stat.dev), inode: String(stat.ino),
          uid: String(stat.uid), mode: String(stat.mode) });
      });
      assertCurrent(); return Object.freeze(facts);
    };
    // Read only the original capture/close slots. In particular, closed/unknown histories must not
    // fstat reused integers, reopen a pathname or promote a new inode into the original lifetime.
    const readTerminalClosureFacts = (): readonly ProtectedHostStagePathClosureFact[] => Object.freeze(held.map(path => {
      if (!path.firstIdentity) throw new Error("protected_host_stage_identity_unsealed");
      return Object.freeze({ path: path.path, device: String(path.device), inode: String(path.inode),
        uid: path.firstIdentity.uid, mode: path.firstIdentity.mode, acquisition: "returned" as const,
        firstIdentity: "matched" as const, state: path.state, close: path.close });
    }));
    return Object.freeze({ stagePath: requested, ancestors: Object.freeze(paths.slice(0, -1)), assertCurrent,
      identityFacts, readTerminalClosureFacts, close });
  } catch (error) {
    try { close(); } catch (closeError) { throw new AggregateError([error, closeError], "protected_host_stage_capture_unknown"); }
    throw error;
  }
}

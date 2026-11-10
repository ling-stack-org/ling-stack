import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";

export interface HostTextRead { readonly content: string; readonly missing?: true; assertUnchanged(): void }
const maxBytes = 4 * 1024 * 1024;
const invalid = (): Error => new Error("host_file_read_failed");

/** Caller owns authorization. Descriptor validation precedes the first content read. */
export function prepareBoundedHostText(path: string, signal: AbortSignal, options: { readonly allowMissing?: boolean } = {}): { read(): HostTextRead; close(): void } {
  signal.throwIfAborted();
  if (options.allowMissing) {
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(path), expected = lstatSync(parent, { bigint: true });
      const assertUnchanged = (): void => {
        signal.throwIfAborted();
        const actual = lstatSync(parent, { bigint: true });
        if (realpathSync(parent) !== parent || !actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw invalid();
        try { lstatSync(path); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return; throw missing; }
        throw invalid();
      };
      assertUnchanged();
      return { read() { assertUnchanged(); return { content: "", missing: true, assertUnchanged }; }, close() {} };
    }
  }
  if (realpathSync(path) !== path) throw invalid();
  const expected = lstatSync(path, { bigint: true });
  if (!expected.isFile() || expected.nlink !== 1n || expected.size > BigInt(maxBytes)) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let closed = false;
  const close = (): void => { if (!closed) { closed = true; closeSync(fd); } };
  const assertUnchanged = (): void => {
    signal.throwIfAborted();
    if (realpathSync(path) !== path || !same(expected, lstatSync(path, { bigint: true }))) throw invalid();
  };
  const check = (): void => {
    assertUnchanged();
    if (closed || !same(expected, fstatSync(fd, { bigint: true }))) throw invalid();
  };
  try {
    check();
    return { close, read: () => {
      check();
      const bytes = Buffer.alloc(Number(expected.size) + 1);
      let length = 0;
      for (;;) {
        check();
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (count === 0) break;
        length += count;
        if (length > Number(expected.size)) throw invalid();
      }
      check();
      if (length !== Number(expected.size) || bytes.subarray(0, length).includes(0)) throw invalid();
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
      return { content, assertUnchanged };
    } };
  } catch (error) { close(); throw error; }
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}

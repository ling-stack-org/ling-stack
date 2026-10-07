import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const DYLD_PATH = "/System/Library/Sandbox/Profiles/dyld-support.sb";
const DYLD_SENTINEL = Buffer.from("OBSERVER-ONLY source-placement dyld sentinel; not OS profile bytes\n");
// Exact sentinel substitution follows the existing codesign mechanism fixture.
// This is counterfeit test input, NOT a newly reviewed OS profile or support claim.
const SIMULATED_REVIEWED_DIGEST = "bdfc2354c683c8fb95a39e63fbc8610e9739b0256c89ab880564edefbe73a5ce";
const installed = new WeakMap();

/**
 * Isolate source-placement tests from the host's changing dyld profile. Only the
 * exact fixed path, its negative observer-only descriptors, and the exact SHA256
 * sentinel input are substituted. Every other FS/hash call retains its original
 * implementation; SQLite, stage paths and registry/source gates remain real.
 * This observer supplies NO OS/profile trust, physical FD ownership, kernel
 * containment, native launch or descendant-closure evidence. Do not use it in
 * native conformance tests. It does not change platform or production guards.
 */
export function observeSourceHookBootstrap(t) {
  // Multi-registry tests deliberately create two source fixtures in one context.
  if (installed.has(t)) return installed.get(t);
  const originals = Object.fromEntries(["lstatSync", "realpathSync", "readFileSync", "openSync",
    "fstatSync", "readSync", "closeSync"].map(name => [name, fs[name]]));
  const originalHash = crypto.createHash, descriptors = new Map(), issued = new Set(), patches = [];
  const opens = [], closes = [];
  let nextDescriptor = -1;
  const stat = options => {
    const number = value => options?.bigint ? BigInt(value) : value;
    return { dev: number(1), ino: number(1), uid: number(0), mode: number(0o100644),
      size: number(DYLD_SENTINEL.length), isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  };
  const descriptor = fd => {
    const value = descriptors.get(fd);
    if (!value) throw Object.assign(new Error("observer dyld descriptor closed"), { code: "EBADF" });
    return value;
  };
  const mock = (object, name, implementation) => patches.push(t.mock.method(object, name, implementation));
  mock(fs, "lstatSync", (path, ...args) => path === DYLD_PATH ? stat(args[0]) : originals.lstatSync(path, ...args));
  mock(fs, "realpathSync", (path, ...args) => path === DYLD_PATH ? path : originals.realpathSync(path, ...args));
  mock(fs, "readFileSync", (path, ...args) => {
    if (path !== DYLD_PATH) return originals.readFileSync(path, ...args);
    const encoding = typeof args[0] === "string" ? args[0] : args[0]?.encoding;
    return encoding ? DYLD_SENTINEL.toString(encoding) : Buffer.from(DYLD_SENTINEL);
  });
  mock(fs, "openSync", (path, ...args) => {
    if (path !== DYLD_PATH) return originals.openSync(path, ...args);
    assert.equal(args[0], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, "observer only accepts the original readonly bootstrap open");
    const fd = nextDescriptor--;
    descriptors.set(fd, { offset: 0 }); issued.add(fd); opens.push(fd); return fd;
  });
  mock(fs, "fstatSync", (fd, ...args) => {
    if (!issued.has(fd)) return originals.fstatSync(fd, ...args);
    descriptor(fd); return stat(args[0]);
  });
  mock(fs, "readSync", (fd, ...args) => {
    if (!issued.has(fd)) return originals.readSync(fd, ...args);
    const slot = descriptor(fd), [buffer, offset, length, position] = args;
    const start = position === null ? slot.offset : position;
    const count = Math.max(0, Math.min(length, DYLD_SENTINEL.length - start));
    DYLD_SENTINEL.copy(buffer, offset, start, start + count);
    if (position === null) slot.offset += count;
    return count;
  });
  mock(fs, "closeSync", (fd, ...args) => {
    if (!issued.has(fd)) return originals.closeSync(fd, ...args);
    descriptor(fd); descriptors.delete(fd); closes.push(fd);
  });
  mock(crypto, "createHash", (algorithm, ...args) => {
    const hash = originalHash(algorithm, ...args);
    if (algorithm !== "sha256") return hash;
    const originalUpdate = hash.update, originalDigest = hash.digest;
    let matched = true, offset = 0;
    hash.update = function (bytes, encoding) {
      const result = Reflect.apply(originalUpdate, this, [bytes, encoding]);
      if (matched) {
        const chunk = typeof bytes === "string" ? Buffer.from(bytes, encoding)
          : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
        matched = chunk.equals(DYLD_SENTINEL.subarray(offset, offset + chunk.length));
        offset += chunk.length;
      }
      return result;
    };
    hash.digest = function (encoding) {
      const digest = Reflect.apply(originalDigest, this, [encoding]);
      if (!matched || offset !== DYLD_SENTINEL.length) return digest;
      const simulated = Buffer.from(SIMULATED_REVIEWED_DIGEST, "hex");
      return encoding ? simulated.toString(encoding) : simulated;
    };
    return hash;
  });
  syncBuiltinESMExports();
  const observation = { opens, closes };
  installed.set(t, observation);
  t.after(() => {
    try { assert.equal(descriptors.size, 0, "observer-only dyld descriptors must be closed by the original reader"); }
    finally {
      for (const patch of patches.reverse()) patch.mock.restore();
      syncBuiltinESMExports(); installed.delete(t);
    }
  });
  return observation;
}

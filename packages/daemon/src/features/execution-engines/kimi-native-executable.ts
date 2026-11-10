import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";

const seaFuse = Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1");

/** Official Kimi native releases embed their resources; scripts cannot be relocated this way. */
export async function prepareKimiNativeExecutable(executable: string, root: string, expectedDigest: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const copy = join(root, process.platform === "win32" ? "kimi.exe" : "kimi");
  await copyFile(executable, copy, constants.COPYFILE_EXCL);
  await chmod(copy, 0o700);
  await verifyKimiNativeExecutable(copy, expectedDigest, signal);
  return copy;
}

export async function verifyKimiNativeExecutable(executable: string, expectedDigest: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const info = await stat(executable);
  if (!info.isFile() || info.size < 4 || info.size > 512 * 1024 * 1024) throw new Error("engine_native_format_invalid");
  const hash = createHash("sha256");
  let first = true;
  let fuseFound = false;
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(executable, { signal })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (first) {
      const magic = bytes.readUInt32BE(0);
      if (bytes.subarray(0, 2).toString("ascii") !== "MZ"
        && ![0xcffaedfe, 0xcefaedfe, 0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca, 0x7f454c46].includes(magic)) {
        throw new Error("engine_native_format_invalid");
      }
      first = false;
    }
    hash.update(bytes);
    const window = Buffer.concat([tail, bytes]);
    fuseFound ||= window.includes(seaFuse);
    tail = Buffer.from(window.subarray(-(seaFuse.length - 1)));
  }
  if (!fuseFound) throw new Error("engine_native_format_invalid");
  if (hash.digest("hex") !== expectedDigest) throw new Error("engine_executable_changed");
  signal?.throwIfAborted();
}

export function kimiNativeEnvironment(root: string, home = join(root, "data")): NodeJS.ProcessEnv {
  return { KIMI_CODE_HOME: home, KIMI_CODE_CACHE_DIR: join(root, "native-cache"),
    KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_DISABLE_TELEMETRY: "1" };
}

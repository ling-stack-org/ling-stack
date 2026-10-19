import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { EngineCredentialError } from "./native-secrets.js";

/** Read only a bounded regular file and verify its named identity after the read. */
export async function readNativeAuthFile(path: string): Promise<string> {
  const limit = 64 * 1024;
  let file;
  try {
    // O_NONBLOCK allows rejecting a FIFO without waiting for a writer.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new EngineCredentialError("engine_native_auth_invalid");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(path);
    if (length > limit || before.size !== length || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || !named.isFile() || named.dev !== before.dev || named.ino !== before.ino
      || named.size !== before.size || named.mtimeMs !== before.mtimeMs || named.ctimeMs !== before.ctimeMs) {
      throw new EngineCredentialError("engine_native_auth_invalid");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof EngineCredentialError) throw error;
    throw new EngineCredentialError(error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? "engine_native_auth_missing" : "engine_native_auth_invalid");
  } finally {
    await file?.close();
  }
}

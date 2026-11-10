import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nativeArtifactIdentity, NATIVE_ARTIFACT_MAX_BYTES, type RunArtifact } from "@ling-stack/core";

export class NativeArtifactError extends Error {
  constructor(readonly code: "invalid_artifact" | "capacity_exceeded" | "artifact_conflict" | "unsupported_artifact") { super(code); }
}

function ownedDirectory(root: string): string {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) conflict();
  const canonical = realpathSync(root);
  const directory = join(root, "native");
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()
    || realpathSync(directory) !== join(canonical, "native")) conflict();
  return realpathSync(directory);
}

export function readNativeArtifactFile(root: string, path: string, sha256: string, sizeBytes: number): Buffer {
  if (dirname(path) !== join(root, "native")) conflict();
  const directory = ownedDirectory(root);
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) conflict();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== sizeBytes || before.size > NATIVE_ARTIFACT_MAX_BYTES) conflict();
    const buffer = Buffer.alloc(sizeBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    const leaf = lstatSync(path);
    if (bytes.length !== sizeBytes || createHash("sha256").update(bytes).digest("hex") !== sha256
      || before.dev !== leaf.dev || before.ino !== leaf.ino || !leaf.isFile()
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || ownedDirectory(root) !== directory) conflict();
    return bytes;
  } catch { return conflict(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** No-overwrite publication. A DB rollback may leave unreferenced content, never a partial file. */
export function publishNativeArtifactFile(root: string, path: string, bytes: Buffer, sha256: string, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || dirname(path) !== join(root, "native")) conflict();
  try { mkdirSync(join(root, "native"), { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directory = ownedDirectory(root);
  const temporary = join(root, "native", `.incoming-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    signal.throwIfAborted();
    if (ownedDirectory(root) !== directory) conflict();
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { unlinkSync(temporary); }
  readNativeArtifactFile(root, path, sha256, bytes.length);
  signal.throwIfAborted();
}

/** Native attachments additionally verify immutable byte identity at the HTTP serving boundary. */
export function readNativeArtifactContent(root: string, artifact: RunArtifact): Buffer | undefined {
  if (!artifact.id.startsWith("artifact_native_")) return undefined;
  const payload = artifact.sealedPayload;
  if (!record(payload) || !record(payload.nativeArtifact)) conflict();
  const native = payload.nativeArtifact;
  if (native.version !== 1 || typeof native.submissionId !== "string" || typeof native.toolCallId !== "string"
    || (native.sourceKind !== undefined && native.sourceKind !== "assistant")
    || typeof native.byteSha256 !== "string" || !Number.isSafeInteger(artifact.sizeBytes)
    || Number(artifact.sizeBytes) < 0 || Number(artifact.sizeBytes) > NATIVE_ARTIFACT_MAX_BYTES) conflict();
  const identity = nativeArtifactIdentity(root, native.submissionId, { toolCallId: native.toolCallId,
    ...(native.sourceKind === "assistant" ? { sourceKind: "assistant" } : {}),
    kind: artifact.type === "image" ? "image" : "text", sha256: native.byteSha256 });
  if (artifact.id !== identity.id || artifact.path !== identity.path || artifact.contentType !== identity.contentType) conflict();
  return readNativeArtifactFile(root, identity.path, native.byteSha256, artifact.sizeBytes!);
}

function conflict(): never { throw new NativeArtifactError("artifact_conflict"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

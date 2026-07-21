import { constants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type BoundedResourceFileErrorCode =
  | "changed"
  | "oversized"
  | "path_escape"
  | "path_invalid"
  | "unavailable";

export class BoundedResourceFileError extends Error {
  constructor(
    readonly resourceCode: BoundedResourceFileErrorCode,
    readonly path: string,
  ) {
    super(`bounded_resource_file_${resourceCode}`);
    this.name = "BoundedResourceFileError";
  }
}

export async function readBoundedContainedResourceFile(options: {
  readonly resourcesPath: string;
  readonly segments: readonly string[];
  readonly maxBytes: number;
  readonly optional?: boolean;
}): Promise<Readonly<{ bytes: Buffer; path: string }> | undefined> {
  if (!isAbsolute(options.resourcesPath) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new BoundedResourceFileError("path_invalid", options.resourcesPath);
  }
  const resourcesPath = resolve(options.resourcesPath);
  const resourcePath = join(resourcesPath, ...options.segments);
  let handle;
  try {
    handle = await open(resourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error) && options.optional) return undefined;
    throw new BoundedResourceFileError(
      isUnsafeLink(error) ? "path_invalid" : "unavailable",
      resourcePath,
    );
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new BoundedResourceFileError("path_invalid", resourcePath);
    }
    if (opened.size > options.maxBytes) {
      throw new BoundedResourceFileError("oversized", resourcePath);
    }

    let pathMetadata;
    let resourceRealPath;
    let resourcesRealPath;
    try {
      [pathMetadata, resourceRealPath, resourcesRealPath] = await Promise.all([
        lstat(resourcePath),
        realpath(resourcePath),
        realpath(resourcesPath),
      ]);
    } catch {
      throw new BoundedResourceFileError("unavailable", resourcePath);
    }
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new BoundedResourceFileError("path_invalid", resourcePath);
    }
    const relativePath = relative(resourcesRealPath, resourceRealPath);
    if (
      relativePath === ""
      || relativePath === ".."
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new BoundedResourceFileError("path_escape", resourcePath);
    }

    const currentPathMetadata = await stat(resourcePath);
    if (!sameIdentity(opened, currentPathMetadata)) {
      throw new BoundedResourceFileError("changed", resourcePath);
    }
    const bytes = await readFileWithinLimit(handle, options.maxBytes, resourcePath);
    const afterRead = await handle.stat();
    if (!sameIdentity(opened, afterRead) || opened.size !== afterRead.size) {
      throw new BoundedResourceFileError("changed", resourcePath);
    }
    if (bytes.byteLength > options.maxBytes) {
      throw new BoundedResourceFileError("oversized", resourcePath);
    }
    return Object.freeze({ bytes, path: resourcePath });
  } finally {
    await handle.close();
  }
}

async function readFileWithinLimit(
  handle: FileHandle,
  maxBytes: number,
  path: string,
): Promise<Buffer> {
  // `FileHandle.readFile()` can allocate from a file that grows after the
  // initial stat. Read into one fixed max+1 buffer instead, so a replaced or
  // concurrently enlarged loose resource cannot turn startup validation into
  // an unbounded allocation.
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new BoundedResourceFileError("oversized", path);
  }
  return bytes.subarray(0, offset);
}

function sameIdentity(
  left: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint }>,
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isUnsafeLink(error: unknown): boolean {
  return isRecord(error) && (error.code === "ELOOP" || error.code === "EMLINK");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

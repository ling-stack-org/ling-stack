import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import {
  CHROME_BROWSER_NATIVE_HOST_VERSION,
  CHROME_BROWSER_NATIVE_PROTOCOL,
  CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
  parseChromeBrowserRuntimeDescriptorV1,
  type ChromeBrowserRuntimeDescriptorV1,
} from "@ling-stack/contracts";
import { browserHostRuntimeDescriptorPath } from "./paths.js";
import { withDescriptorCoordination, type DescriptorPermissionOptions } from "./descriptor-coordination.js";
import { restrictWindowsPathToCurrentUser } from "./windows-acl.js";

export function createChromeBrowserRuntimeDescriptor(input: {
  readonly port: number;
  readonly daemonPid?: number;
  readonly nowMs?: number;
  readonly ttlMs?: number;
  readonly token?: string;
  readonly generation?: string;
}): ChromeBrowserRuntimeDescriptorV1 {
  const nowMs = input.nowMs ?? Date.now();
  return parseChromeBrowserRuntimeDescriptorV1({
    schema: CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    hostVersion: CHROME_BROWSER_NATIVE_HOST_VERSION,
    port: input.port,
    token: input.token ?? randomBytes(32).toString("base64url"),
    generation: input.generation ?? randomBytes(16).toString("base64url"),
    daemonPid: input.daemonPid ?? process.pid,
    expiresAtEpochMs: nowMs + (input.ttlMs ?? 12 * 60 * 60 * 1000),
  });
}

export async function publishChromeBrowserRuntimeDescriptor(
  descriptor: ChromeBrowserRuntimeDescriptorV1,
  path = browserHostRuntimeDescriptorPath(),
  options: DescriptorPermissionOptions & { readonly expectedGeneration?: string } = {},
): Promise<"published" | "superseded"> {
  return withDescriptorCoordination(path, options, async (lockedPath) => {
    if (options.expectedGeneration !== undefined) {
      try {
        if ((await readDescriptor(lockedPath)).generation !== options.expectedGeneration) return "superseded";
      } catch (error) {
        if (isMissingFile(error)) return "superseded";
        throw error;
      }
    }
    return publishDescriptor(descriptor, lockedPath, options);
  });
}

async function publishDescriptor(
  descriptor: ChromeBrowserRuntimeDescriptorV1,
  path: string,
  options: DescriptorPermissionOptions,
): Promise<"published"> {
  const platform = options.platform ?? process.platform;
  const temporaryPath = `${path}.${descriptor.generation}.tmp`;
  let ownedTemporary = false;
  let renamed = false;
  const failures: unknown[] = [];
  const protect = async (target: string): Promise<void> => {
    if (platform === "win32") await restrictWindowsPathToCurrentUser(target, {
      ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      ...(options.username ? { username: options.username } : {}),
    });
    else await chmod(target, 0o600);
  };
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    ownedTemporary = true;
    const writeFailures: unknown[] = [];
    try { await file.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8"); }
    catch (error) { writeFailures.push(error); }
    try { await file.close(); }
    catch (error) { writeFailures.push(error); }
    if (writeFailures.length === 1) throw writeFailures[0];
    if (writeFailures.length > 1) throw new AggregateError(writeFailures, "browser_host_descriptor_write_and_close_failed");
    await protect(temporaryPath);
    await rename(temporaryPath, path);
    renamed = true;
    await protect(path);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    try {
      if (renamed) await removeDescriptor(descriptor.generation, path);
      else if (ownedTemporary) await rm(temporaryPath, { force: true });
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "browser_host_descriptor_publication_and_cleanup_failed");
  }
  return "published";
}

export async function readChromeBrowserRuntimeDescriptor(
  path = browserHostRuntimeDescriptorPath(),
  nowMs = Date.now(),
): Promise<ChromeBrowserRuntimeDescriptorV1> {
  const descriptor = await readDescriptor(path);
  if (descriptor.expiresAtEpochMs <= nowMs) throw new Error("browser_host_descriptor_expired");
  return descriptor;
}

export async function removeChromeBrowserRuntimeDescriptor(
  generation: string,
  path = browserHostRuntimeDescriptorPath(),
  options: DescriptorPermissionOptions = {},
): Promise<boolean> {
  return withDescriptorCoordination(path, options, (lockedPath) => removeDescriptor(generation, lockedPath));
}

async function readDescriptor(path: string): Promise<ChromeBrowserRuntimeDescriptorV1> {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > 16 * 1024) throw new Error("browser_host_descriptor_too_large");
  return parseChromeBrowserRuntimeDescriptorV1(JSON.parse(raw));
}

async function removeDescriptor(generation: string, path: string): Promise<boolean> {
  try {
    const descriptor = await readDescriptor(path);
    if (descriptor.generation !== generation) return false;
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

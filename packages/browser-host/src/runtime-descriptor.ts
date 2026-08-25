import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CHROME_BROWSER_NATIVE_HOST_VERSION,
  CHROME_BROWSER_NATIVE_PROTOCOL,
  CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
  parseChromeBrowserRuntimeDescriptorV1,
  type ChromeBrowserRuntimeDescriptorV1,
} from "@ling-stack/contracts";
import { browserHostRuntimeDescriptorPath } from "./paths.js";
import {
  restrictWindowsPathToCurrentUser,
  type BrowserHostCommandRunner,
} from "./windows-acl.js";

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
  options: {
    readonly platform?: NodeJS.Platform;
    readonly runCommand?: BrowserHostCommandRunner;
    readonly username?: string;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    await restrictWindowsPathToCurrentUser(directory, {
      directory: true,
      ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      ...(options.username ? { username: options.username } : {}),
    });
  } else {
    await chmod(directory, 0o700);
  }
  const temporaryPath = `${path}.${descriptor.generation}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (platform === "win32") {
    await restrictWindowsPathToCurrentUser(temporaryPath, {
      ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      ...(options.username ? { username: options.username } : {}),
    });
  } else {
    await chmod(temporaryPath, 0o600);
  }
  await rename(temporaryPath, path);
  if (platform === "win32") {
    await restrictWindowsPathToCurrentUser(path, {
      ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      ...(options.username ? { username: options.username } : {}),
    });
  } else {
    await chmod(path, 0o600);
  }
}

export async function readChromeBrowserRuntimeDescriptor(
  path = browserHostRuntimeDescriptorPath(),
  nowMs = Date.now(),
): Promise<ChromeBrowserRuntimeDescriptorV1> {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > 16 * 1024) throw new Error("browser_host_descriptor_too_large");
  const descriptor = parseChromeBrowserRuntimeDescriptorV1(JSON.parse(raw));
  if (descriptor.expiresAtEpochMs <= nowMs) throw new Error("browser_host_descriptor_expired");
  return descriptor;
}

export async function removeChromeBrowserRuntimeDescriptor(
  generation: string,
  path = browserHostRuntimeDescriptorPath(),
): Promise<boolean> {
  try {
    const descriptor = parseChromeBrowserRuntimeDescriptorV1(JSON.parse(await readFile(path, "utf8")));
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

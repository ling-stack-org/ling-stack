import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFileOpenTarget } from "@ling-stack/contracts";
import { workspaceFileOpenTargetDefinition } from "./workspace-file-open-targets.js";
import { defineProtectedHostActorEntry } from "../../runtime/sandbox/protected-host-actor-inventory.js";

const execFileAsync = promisify(execFile);
const iconSize = 64;

interface FileStat {
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface IconProbeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  producerEntered: boolean;
}

const refusedIconProbeLaunches = new WeakSet<object>();

/** Only the default runtime owns this original producer; custom runtimes receive no source proof. */
export const WORKSPACE_ICON_PROBE_ACTOR_ENTRY = defineProtectedHostActorEntry("workspace_icon_probe",
  async (launch: IconProbeLaunch): Promise<CommandResult> => {
    launch.producerEntered = true;
    const result = await execFileAsync(launch.command, [...launch.args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  });

export interface WorkspaceFileOpenIconRuntime {
  readonly platform: NodeJS.Platform | string;
  homeDirectory(): string;
  temporaryDirectory(): string;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<Buffer>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
  execFile(command: string, args: readonly string[]): Promise<CommandResult>;
}

export interface WorkspaceFileOpenIcon {
  readonly bytes: Buffer;
  readonly etag: string;
}

interface CachedIcon {
  readonly iconPath: string;
  readonly iconMtimeMs: number;
  readonly icon: WorkspaceFileOpenIcon;
}

const defaultRuntime: WorkspaceFileOpenIconRuntime = {
  platform: process.platform,
  homeDirectory: homedir,
  temporaryDirectory: tmpdir,
  stat,
  readdir,
  readFile,
  mkdtemp,
  rm: (path) => rm(path, { recursive: true, force: true }),
  execFile: async (command, args) => {
    const launch: IconProbeLaunch = { command, args: Object.freeze([...args]), producerEntered: false };
    try {
      return await WORKSPACE_ICON_PROBE_ACTOR_ENTRY.invoke(undefined, launch);
    } catch (error) {
      if (!launch.producerEntered && typeof error === "object" && error !== null) refusedIconProbeLaunches.add(error);
      throw error;
    }
  },
};

export function createWorkspaceFileOpenIconLoader(
  runtime: WorkspaceFileOpenIconRuntime = defaultRuntime,
): (target: WorkspaceFileOpenTarget) => Promise<WorkspaceFileOpenIcon | undefined> {
  const cache = new Map<WorkspaceFileOpenTarget, CachedIcon>();

  return async (target) => {
    if (runtime.platform !== "darwin") {
      return undefined;
    }
    const definition = workspaceFileOpenTargetDefinition(target);
    if (definition.kind !== "editor" || !definition.macApplication) {
      return undefined;
    }

    const cached = cache.get(target);
    if (cached) {
      const cachedIconStat = await safeStat(runtime, cached.iconPath);
      if (cachedIconStat?.isFile() && cachedIconStat.mtimeMs === cached.iconMtimeMs) {
        return cached.icon;
      }
      cache.delete(target);
    }

    const applicationPath = await resolveMacApplicationPath(runtime, definition.macApplication, definition.macBundleIdentifiers ?? []);
    if (!applicationPath) {
      return undefined;
    }
    const iconPath = await resolveMacApplicationIconPath(runtime, applicationPath, definition.macApplication);
    if (!iconPath) {
      return undefined;
    }
    const iconStat = await safeStat(runtime, iconPath);
    if (!iconStat?.isFile()) {
      return undefined;
    }

    const bytes = await convertMacApplicationIcon(runtime, iconPath);
    if (!bytes || bytes.length === 0) {
      return undefined;
    }
    const icon = {
      bytes,
      etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    } satisfies WorkspaceFileOpenIcon;
    cache.set(target, { iconPath, iconMtimeMs: iconStat.mtimeMs, icon });
    return icon;
  };
}

export const loadWorkspaceFileOpenIcon = createWorkspaceFileOpenIconLoader();

async function resolveMacApplicationPath(
  runtime: WorkspaceFileOpenIconRuntime,
  applicationName: string,
  bundleIdentifiers: readonly string[],
): Promise<string | undefined> {
  const directCandidates = [
    join("/Applications", `${applicationName}.app`),
    join(runtime.homeDirectory(), "Applications", `${applicationName}.app`),
    join("/System/Applications", `${applicationName}.app`),
    join("/System/Applications/Utilities", `${applicationName}.app`),
  ];
  for (const candidate of directCandidates) {
    if ((await safeStat(runtime, candidate))?.isDirectory()) {
      return candidate;
    }
  }

  const queries = [
    ...bundleIdentifiers.map((identifier) => `kMDItemCFBundleIdentifier == "${escapeSpotlightLiteral(identifier)}"`),
    `kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "${escapeSpotlightLiteral(applicationName)}"`,
  ];
  for (const query of queries) {
    const result = await safeExec(runtime, "/usr/bin/mdfind", [query]);
    for (const candidate of result?.stdout.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean) ?? []) {
      if (candidate.endsWith(".app") && (await safeStat(runtime, candidate))?.isDirectory()) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function resolveMacApplicationIconPath(
  runtime: WorkspaceFileOpenIconRuntime,
  applicationPath: string,
  applicationName: string,
): Promise<string | undefined> {
  const resourcesPath = join(applicationPath, "Contents", "Resources");
  const plistPath = join(applicationPath, "Contents", "Info.plist");
  const plistResult = await safeExec(runtime, "/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
  const plist = parsePlistJson(plistResult?.stdout);
  const configuredNames = [
    typeof plist?.CFBundleIconFile === "string" ? plist.CFBundleIconFile : undefined,
    ...(Array.isArray(plist?.CFBundleIconFiles) ? plist.CFBundleIconFiles.filter((item): item is string => typeof item === "string") : []),
  ].filter((item): item is string => Boolean(item));

  for (const name of configuredNames) {
    const candidate = join(resourcesPath, extname(name) ? name : `${name}.icns`);
    if ((await safeStat(runtime, candidate))?.isFile()) {
      return candidate;
    }
  }

  try {
    const iconNames = (await runtime.readdir(resourcesPath)).filter((name) => name.toLowerCase().endsWith(".icns"));
    const preferred = iconNames.find((name) => normalizeIconName(name).includes(normalizeIconName(applicationName))) ?? iconNames[0];
    if (!preferred) {
      return undefined;
    }
    const candidate = join(resourcesPath, preferred);
    return (await safeStat(runtime, candidate))?.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function convertMacApplicationIcon(
  runtime: WorkspaceFileOpenIconRuntime,
  iconPath: string,
): Promise<Buffer | undefined> {
  const temporaryPath = await runtime.mkdtemp(join(runtime.temporaryDirectory(), "ling-stack-open-icon-"));
  const outputPath = join(temporaryPath, `${basename(iconPath, extname(iconPath))}.png`);
  try {
    const result = await safeExec(runtime, "/usr/bin/sips", [
      "-s",
      "format",
      "png",
      "-z",
      String(iconSize),
      String(iconSize),
      iconPath,
      "--out",
      outputPath,
    ]);
    return result ? await runtime.readFile(outputPath) : undefined;
  } catch (error) {
    if (isRefusedDefaultIconProbe(runtime, error)) throw error;
    return undefined;
  } finally {
    await runtime.rm(temporaryPath).catch(() => undefined);
  }
}

async function safeStat(runtime: WorkspaceFileOpenIconRuntime, path: string): Promise<FileStat | undefined> {
  try {
    return await runtime.stat(path);
  } catch {
    return undefined;
  }
}

function isRefusedDefaultIconProbe(runtime: WorkspaceFileOpenIconRuntime, error: unknown): boolean {
  return runtime === defaultRuntime && typeof error === "object" && error !== null && refusedIconProbeLaunches.has(error);
}

async function safeExec(
  runtime: WorkspaceFileOpenIconRuntime,
  command: string,
  args: readonly string[],
): Promise<CommandResult | undefined> {
  try {
    return await runtime.execFile(command, args);
  } catch (error) {
    if (isRefusedDefaultIconProbe(runtime, error)) throw error;
    return undefined;
  }
}

function parsePlistJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function escapeSpotlightLiteral(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

function normalizeIconName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

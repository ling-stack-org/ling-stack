import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SkillSourceScanRoot } from "./skill-types.js";

const execFile = promisify(execFileCallback);

export const OFFICIAL_GSTACK_SOURCE_ID = "official-gstack" as const;
export const OFFICIAL_GSTACK_ORIGIN_URL = "https://github.com/garrytan/gstack.git";
export const OFFICIAL_GSTACK_ORIGIN = "github.com/garrytan/gstack";
export const OFFICIAL_GSTACK_REF = "main";

export interface ManagedOfficialSkillSource {
  readonly sourceId: typeof OFFICIAL_GSTACK_SOURCE_ID;
  readonly originUrl: typeof OFFICIAL_GSTACK_ORIGIN_URL;
  readonly ref: typeof OFFICIAL_GSTACK_REF;
  readonly repoRoot: string;
  readonly skillsRoot: string;
  readonly revision: string;
  readonly version?: string;
}

export interface ManagedOfficialSkillSourceOptions {
  readonly sourcesDir: string;
  readonly git?: ManagedOfficialSkillSourceGit;
}

export interface ManagedOfficialSkillSourceGit {
  run(args: readonly string[], options: { readonly cwd?: string }): Promise<string>;
}

export class ManagedOfficialSkillSourceError extends Error {
  constructor(
    readonly code: "git_unavailable" | "refresh_failed" | "invalid_repository" | "skills_unavailable",
    cause?: unknown,
  ) {
    super("Official skill source is unavailable.", { cause });
    this.name = "ManagedOfficialSkillSourceError";
  }
}

const defaultGit: ManagedOfficialSkillSourceGit = {
  async run(args, options) {
    try {
      const { stdout } = await execFile("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        encoding: "utf8",
      });
      return stdout.trim();
    } catch (error) {
      const code = asNodeErrorCode(error);
      throw new ManagedOfficialSkillSourceError(code === "ENOENT" ? "git_unavailable" : "refresh_failed", error);
    }
  },
};

const refreshes = new Map<string, Promise<ManagedOfficialSkillSource>>();

export async function refreshManagedOfficialGstackSource(
  options: ManagedOfficialSkillSourceOptions,
): Promise<ManagedOfficialSkillSource> {
  const sourcesDir = resolve(options.sourcesDir);
  const cacheRoot = join(sourcesDir, OFFICIAL_GSTACK_SOURCE_ID);
  const current = refreshes.get(cacheRoot);
  if (current) {
    return current;
  }
  const refresh = refreshManagedSourceCache({ cacheRoot, git: options.git ?? defaultGit });
  refreshes.set(cacheRoot, refresh);
  try {
    return await refresh;
  } finally {
    refreshes.delete(cacheRoot);
  }
}

export function officialGstackSourceScanRoot(source: ManagedOfficialSkillSource): SkillSourceScanRoot {
  return {
    id: OFFICIAL_GSTACK_SOURCE_ID,
    rootPath: source.skillsRoot,
    sourceKind: "gstack-skill-directory",
    label: "Official managed skill source",
    upstreamName: "gstack",
    upstreamVersion: source.version ?? source.revision,
  };
}

export function normalizeOfficialGstackOrigin(origin: string): string | undefined {
  const trimmed = origin.trim();
  if (!trimmed) {
    return undefined;
  }
  const sshMatch = trimmed.match(/^(?:git\+)?ssh:\/\/(?:[^@/]+@)?([^/:]+)[:/]([^/]+)\/(.+)$/i)
    ?? trimmed.match(/^(?:[^@/]+@)?([^/:]+):([^/]+)\/(.+)$/i);
  if (sshMatch) {
    return normalizeGithubPath(sshMatch[1], `${sshMatch[2]}/${sshMatch[3]}`);
  }
  try {
    const url = new URL(trimmed);
    return normalizeGithubPath(url.hostname, url.pathname);
  } catch {
    return undefined;
  }
}

async function refreshManagedSourceCache(input: {
  readonly cacheRoot: string;
  readonly git: ManagedOfficialSkillSourceGit;
}): Promise<ManagedOfficialSkillSource> {
  const exists = await isDirectory(input.cacheRoot);
  if (!exists) {
    await mkdir(resolve(input.cacheRoot, ".."), { recursive: true });
    await input.git.run([
      "clone",
      "--depth=1",
      "--branch",
      OFFICIAL_GSTACK_REF,
      OFFICIAL_GSTACK_ORIGIN_URL,
      input.cacheRoot,
    ], {});
  }

  const repoRoot = await readGit(input.git, ["rev-parse", "--show-toplevel"], input.cacheRoot);
  const canonicalRepoRoot = await realpath(repoRoot).catch(() => undefined);
  const expectedCacheRoot = await realpath(input.cacheRoot).catch(() => undefined);
  if (!canonicalRepoRoot || !expectedCacheRoot || canonicalRepoRoot !== expectedCacheRoot) {
    throw new ManagedOfficialSkillSourceError("invalid_repository");
  }
  const origin = await readGit(input.git, ["config", "--get", "remote.origin.url"], canonicalRepoRoot);
  if (normalizeOfficialGstackOrigin(origin) !== OFFICIAL_GSTACK_ORIGIN) {
    throw new ManagedOfficialSkillSourceError("invalid_repository");
  }

  await input.git.run(["fetch", "--depth=1", "origin", OFFICIAL_GSTACK_REF], { cwd: canonicalRepoRoot });
  await input.git.run(["checkout", "--force", "--detach", "FETCH_HEAD"], { cwd: canonicalRepoRoot });
  await input.git.run(["clean", "-ffdq"], { cwd: canonicalRepoRoot });
  const revision = await readGit(input.git, ["rev-parse", "HEAD"], canonicalRepoRoot);
  const skillsRoot = join(canonicalRepoRoot, ".agents", "skills");
  if (!(await isDirectory(skillsRoot))) {
    throw new ManagedOfficialSkillSourceError("skills_unavailable");
  }
  const version = await readGstackVersion(canonicalRepoRoot);
  return {
    sourceId: OFFICIAL_GSTACK_SOURCE_ID,
    originUrl: OFFICIAL_GSTACK_ORIGIN_URL,
    ref: OFFICIAL_GSTACK_REF,
    repoRoot: canonicalRepoRoot,
    skillsRoot,
    revision,
    ...(version ? { version } : {}),
  };
}

async function readGit(git: ManagedOfficialSkillSourceGit, args: readonly string[], cwd: string): Promise<string> {
  const value = await git.run(args, { cwd });
  if (!value) {
    throw new ManagedOfficialSkillSourceError("invalid_repository");
  }
  return value;
}

async function readGstackVersion(repoRoot: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeGithubPath(host: string, pathname: string): string | undefined {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
  return normalizedHost && normalizedPath ? `${normalizedHost}/${normalizedPath}` : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

function asNodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

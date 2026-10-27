/** Read-only discovery of existing engine installations (managed-lifecycle P0). */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  MANAGED_ENGINE_PACKAGES,
  type EngineDiscoveryCandidate,
  type EngineDiscoveryReport,
  type ExternalExecutionEngineId,
} from "@ling-stack/contracts";
import type { ExecutionEngineProfile } from "@ling-stack/contracts";
import { probeEngineInstallation } from "./installation-probe.js";

/** Well-known install locations beyond PATH, checked in order. */
function extraCandidateDirs(home: string, platform: NodeJS.Platform): readonly string[] {
  if (platform === "win32") return [];
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join(home, ".local", "bin")];
}

function candidatePaths(commandName: string, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): readonly string[] {
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extraCandidateDirs(home, platform)];
  const suffixes = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const paths: string[] = [];
  for (const dir of dirs) for (const suffix of suffixes) paths.push(join(dir, commandName + suffix));
  return paths;
}

async function firstExecutable(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      await access(resolved, constants.X_OK);
      return resolved;
    } catch {
      continue;
    }
  }
  return undefined;
}

function discoveryProfile(engineId: ExternalExecutionEngineId, executablePath: string): ExecutionEngineProfile {
  return {
    schemaVersion: 1,
    id: `discovery:${engineId}`,
    revision: 0,
    status: "configured",
    configuration: { engineId, executablePath, authProfileId: "discovery" },
    configurationFingerprint: "discovery",
    updatedAt: new Date(0).toISOString(),
  };
}

export interface DiscoverEnginesOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
  readonly probeTimeoutMs?: number;
  readonly spawn?: Parameters<typeof probeEngineInstallation>[1] extends { spawn?: infer S } ? S : never;
  /** Testing seam: overrides executable lookup per engine. */
  readonly resolveExecutable?: (commandName: string) => Promise<string | undefined>;
}

/** Scan PATH and well-known locations for installed engines; probe what is found. */
export async function discoverEngines(options: DiscoverEnginesOptions = {}): Promise<EngineDiscoveryReport> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const candidates: EngineDiscoveryCandidate[] = [];
  for (const pkg of MANAGED_ENGINE_PACKAGES) {
    const executable = options.resolveExecutable
      ? await options.resolveExecutable(pkg.commandName)
      : await firstExecutable(candidatePaths(pkg.commandName, env, home, platform));
    if (!executable) {
      candidates.push({ engineId: pkg.engineId, status: "not_found", installable: pkg.installable, manualGuidance: pkg.manualGuidance });
      continue;
    }
    const probe = await probeEngineInstallation(discoveryProfile(pkg.engineId, executable), {
      signal: options.signal, timeoutMs: options.probeTimeoutMs ?? 3000, spawn: options.spawn,
    });
    candidates.push({
      engineId: pkg.engineId,
      status: "detected",
      executablePath: executable,
      version: probe.runtimeVersion,
      digest: probe.executableDigest,
      installable: pkg.installable,
      manualGuidance: pkg.manualGuidance,
    });
  }
  return { checkedAt: new Date().toISOString(), candidates };
}

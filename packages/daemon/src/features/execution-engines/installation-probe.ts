import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEngineInstallationProbe, ExecutionEngineProfile, ExternalExecutionEngineId } from "@ling-stack/contracts";
import { kimiNativeEnvironment, prepareKimiNativeExecutable, verifyKimiNativeExecutable } from "./kimi-native-executable.js";
import { openclawProcessEnvironment } from "./openclaw-environment.js";
import { claudeProcessEnvironment } from "./claude-environment.js";
import { prepareOwnedNativeSpawn } from "./windows-supervisor.js";

type ProbeStatus = ExecutionEngineInstallationProbe["status"];
const maxOutputBytes = 32 * 1024;

export class EngineProbeBusyError extends Error {
  readonly code = "engine_probe_busy";

  constructor() {
    super("engine_probe_busy");
  }
}

export async function probeEngineInstallation(profile: ExecutionEngineProfile, options: {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly spawn?: typeof spawn;
} = {}): Promise<ExecutionEngineInstallationProbe> {
  const result = (status: ProbeStatus, extra: Partial<ExecutionEngineInstallationProbe> = {}): ExecutionEngineInstallationProbe => ({
    profileId: profile.id, profileRevision: profile.revision, configurationFingerprint: profile.configurationFingerprint,
    checkedAt: new Date().toISOString(), status, authentication: "not_checked", connection: "not_checked", ...extra,
  });
  if (options.signal?.aborted) return result("cancelled");
  let executable: string;
  try {
    executable = await realpath(profile.configuration.executablePath);
    const info = await stat(executable);
    if (!info.isFile() || info.size > 512 * 1024 * 1024) return result("not_executable");
    await access(executable, constants.X_OK);
  } catch (error) {
    return result(error instanceof Error && "code" in error && error.code === "ENOENT" ? "not_found" : "not_executable");
  }
  const root = await mkdtemp(join(tmpdir(), "ling-engine-probe-"));
  try {
    const before = await stat(executable);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(executable, { signal: options.signal })) hash.update(chunk);
    const digest = hash.digest("hex");
    if (options.signal?.aborted) return result("cancelled");
    const isKimi = profile.configuration.engineId === "kimi-acp";
    const launchPath = isKimi ? await prepareKimiNativeExecutable(executable, root, digest, options.signal) : executable;
    const environment = isKimi ? kimiNativeEnvironment(root)
      : profile.configuration.engineId === "openclaw-acp" ? openclawProcessEnvironment(root)
      : profile.configuration.engineId === "claude-agent-sdk" ? claudeProcessEnvironment(root) : {};
    const launch = await prepareOwnedNativeSpawn(launchPath, digest, options.spawn);
    if (options.signal?.aborted) return result("cancelled");
    const captured = await captureVersion(launchPath, root, { ...options, spawn: launch }, environment);
    if (captured.status !== "exited") return result(captured.status);
    if (isKimi) await verifyKimiNativeExecutable(launchPath, digest, options.signal);
    const after = await stat(executable);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return result("probe_failed");
    const version = parseNativeRuntimeVersion(profile.configuration.engineId, captured.stdout);
    if (!version) return result("unexpected_runtime");
    return result("installed", { runtimeVersion: version, executableDigest: digest });
  } catch (error) {
    return result(options.signal?.aborted ? "cancelled" : error instanceof Error && error.message === "engine_native_format_invalid"
      ? "unexpected_runtime" : "probe_failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function parseNativeRuntimeVersion(engineId: ExternalExecutionEngineId, output: string): string | undefined {
  const version = "([0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)";
  const patterns: Record<ExternalExecutionEngineId, RegExp> = {
    "codex-app-server": new RegExp(`\\bcodex(?:-cli)?\\s+v?${version}\\b`, "i"),
    "claude-agent-sdk": new RegExp(`${version}\\s+\\(Claude Code\\)`, "i"),
    // Successor Commander --version output; the ACP handshake separately verifies identity.
    "kimi-acp": /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?)$/,
    "openclaw-acp": new RegExp(`\\bOpenClaw\\s+v?${version}\\b`, "i"),
  };
  const match = patterns[engineId].exec(engineId === "kimi-acp" ? output.trim() : output)?.[1];
  return match && match.length <= 128 ? match : undefined;
}

/** A version check has no account authority and must not read/migrate a real native profile. */
export function buildNativeProcessEnvironment(source: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  const allowed = new Set(["path", "systemroot", "windir", "systemdrive", "comspec", "pathext", "lang", "lc_all"]);
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined));
  return { ...env, HOME: isolatedHome, USERPROFILE: isolatedHome, TMPDIR: isolatedHome, TMP: isolatedHome, TEMP: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome, XDG_DATA_HOME: isolatedHome, XDG_CACHE_HOME: isolatedHome,
    APPDATA: isolatedHome, LOCALAPPDATA: isolatedHome };
}

function captureVersion(executable: string, root: string, options: { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly spawn: typeof spawn }, environment: NodeJS.ProcessEnv): Promise<
  { readonly status: "exited"; readonly stdout: string } | { readonly status: Exclude<ProbeStatus, "installed"> }
> {
  return new Promise((resolve) => {
    const child = options.spawn(executable, ["--version"], {
      cwd: root, env: { ...buildNativeProcessEnvironment(process.env, root), ...environment }, shell: false,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    let status: "timed_out" | "cancelled" | "output_limit" | "probe_failed" | undefined;
    let bytes = 0;
    let stdout = "";
    let finished = false;
    const stop = (reason: typeof status): void => {
      if (finished || status) return;
      status = reason;
      killOwnedProbe(child);
    };
    const abort = (): void => stop("cancelled");
    const timeout = setTimeout(() => stop("timed_out"), options.timeoutMs ?? 5000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const consume = (chunk: Buffer, isStdout: boolean): void => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { stop("output_limit"); return; }
      if (isStdout) stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, true)).on("error", () => stop("probe_failed"));
    child.stderr?.on("data", (chunk: Buffer) => consume(chunk, false)).on("error", () => stop("probe_failed"));
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve(status ? { status } : code === 0 ? { status: "exited", stdout } : { status: "probe_failed" });
    };
    // Protocol/lifecycle errors can occur after spawn, while the owned child is still alive.
    child.on("error", () => stop("probe_failed"));
    // A version command may exit successfully after starting background helpers.
    child.once("exit", () => killOwnedProbe(child));
    child.once("close", finish);
    if (options.signal?.aborted) abort();
  });
}

export function killOwnedProbe(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* Fall through for an already-exiting child. */ }
  }
  child.kill("SIGKILL");
}

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { win32 } from "node:path";
import { cuaDriverArtifactLayoutFor } from "../../../shared/cua-driver-artifact-layout.mjs";
import type { CuaDriverPreparedProviderSpawn } from "../provider-host.js";
import {
  createWin32VerifierEnvironment,
  encodeWin32PowerShell,
  resolveWin32SystemExecutables,
} from "./win32-command.js";

const READY_MARKER = "LING_CUA_SPAWN_LEASE_READY_V1";
const MAX_PROTOCOL_BYTES = 4 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;

type SpawnLeaseProcess = (
  executablePath: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly windowsHide: true;
    readonly shell: false;
    readonly stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcess;

export interface Win32ExecutableSpawnLeaseOptions {
  readonly systemRoot: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnLeaseProcess;
  readonly readyTimeoutMs?: number;
  readonly releaseTimeoutMs?: number;
}

export class Win32ExecutableSpawnLeaseError extends Error {
  readonly code = "cua_driver_win32_spawn_lease_failed" as const;

  constructor(readonly leaseCode: "input_invalid" | "unavailable" | "protocol_invalid") {
    super(`win32_provider_spawn_lease_${leaseCode}`);
    this.name = "Win32ExecutableSpawnLeaseError";
  }
}

/**
 * Hold the verified PE open without write/delete sharing until CreateProcess
 * has mapped it. The helper re-hashes the held handle and checks that NTFS has
 * exactly one link, so the later direct spawn cannot name a different file.
 */
export function createWin32ExecutableSpawnLeaseAcquirer(
  options: Win32ExecutableSpawnLeaseOptions,
): (input: {
  readonly executablePath: string;
  readonly executableDigest: string;
  readonly signal: AbortSignal;
}) => Promise<CuaDriverPreparedProviderSpawn> {
  const executables = resolveWin32SystemExecutables(options.systemRoot);
  const spawnProcess = options.spawnProcess ?? ((path, args, spawnOptions) => nodeSpawn(
    path,
    [...args],
    spawnOptions,
  ));
  const baseEnvironment = createWin32VerifierEnvironment(
    options.baseEnvironment ?? process.env,
    {},
  );
  const readyTimeoutMs = boundedTimeout(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const releaseTimeoutMs = boundedTimeout(options.releaseTimeoutMs, DEFAULT_RELEASE_TIMEOUT_MS);

  return async (input) => {
    if (!win32.isAbsolute(input.executablePath)
      || win32.basename(input.executablePath).toLowerCase()
        !== cuaDriverArtifactLayoutFor("win32-x64").packagedExecutableName
      || !/^[a-f0-9]{64}$/u.test(input.executableDigest)
      || input.signal.aborted) {
      throw new Win32ExecutableSpawnLeaseError("input_invalid");
    }
    let child: ChildProcess;
    try {
      child = spawnProcess(
        executables.powershellPath,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodeWin32PowerShell(SPAWN_LEASE_SCRIPT)],
        {
          env: createWin32VerifierEnvironment(baseEnvironment, {
            SystemRoot: executables.systemRoot,
            WINDIR: executables.systemRoot,
            LING_CUA_PROVIDER_PATH: input.executablePath,
            LING_CUA_PROVIDER_SHA256: input.executableDigest,
            LING_CUA_FSUTIL_PATH: win32.join(executables.systemRoot, "System32", "fsutil.exe"),
          }),
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Win32ExecutableSpawnLeaseError("unavailable");
    }
    if (!child.stdin || !child.stdout || !child.stderr) {
      try {
        child.kill("SIGKILL");
      } catch {
        // No protocol can be trusted without all three retained streams.
      }
      throw new Win32ExecutableSpawnLeaseError("unavailable");
    }
    return waitForReadyLease({
      child,
      executablePath: input.executablePath,
      executableDigest: input.executableDigest,
      signal: input.signal,
      readyTimeoutMs,
      releaseTimeoutMs,
    });
  };
}

async function waitForReadyLease(input: {
  readonly child: ChildProcess;
  readonly executablePath: string;
  readonly executableDigest: string;
  readonly signal: AbortSignal;
  readonly readyTimeoutMs: number;
  readonly releaseTimeoutMs: number;
}): Promise<CuaDriverPreparedProviderSpawn> {
  const { child, signal } = input;
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!child.stdin || !stdoutStream || !stderrStream) {
    throw new Win32ExecutableSpawnLeaseError("unavailable");
  }
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let ready = false;
  let releaseRequested = false;
  let forcedFailure: Win32ExecutableSpawnLeaseError | undefined;
  let readyTimer: NodeJS.Timeout | undefined;
  let releaseTimer: NodeJS.Timeout | undefined;

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closedPromise = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closedPromise.catch(() => undefined);

  const requestTermination = (error: Win32ExecutableSpawnLeaseError): void => {
    forcedFailure ??= error;
    try {
      child.kill("SIGKILL");
    } catch {
      // Retain the pending close boundary; never authorize a spawn.
    }
  };
  const onAbort = (): void => requestTermination(new Win32ExecutableSpawnLeaseError("unavailable"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }

  stdoutStream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stdout.byteLength > MAX_PROTOCOL_BYTES - bytes.byteLength) {
      requestTermination(new Win32ExecutableSpawnLeaseError("protocol_invalid"));
      return;
    }
    stdout = Buffer.concat([stdout, bytes]);
    const protocol = stdout.toString("utf8");
    if (!ready && (
      protocol === `${READY_MARKER}\r\n`
      || protocol === `${READY_MARKER}\n`
    )) {
      ready = true;
      if (readyTimer) {
        clearTimeout(readyTimer);
      }
      resolveReady();
    } else if (ready || protocol.includes("\n")) {
      requestTermination(new Win32ExecutableSpawnLeaseError("protocol_invalid"));
    }
  });
  stderrStream.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_PROTOCOL_BYTES) {
      requestTermination(new Win32ExecutableSpawnLeaseError("protocol_invalid"));
    }
  });
  child.once("error", () => {
    forcedFailure ??= new Win32ExecutableSpawnLeaseError("unavailable");
    if (child.pid === undefined) {
      rejectReady(forcedFailure);
      rejectClosed(forcedFailure);
    } else {
      requestTermination(forcedFailure);
    }
  });
  child.once("close", (code, closeSignal) => {
    signal.removeEventListener("abort", onAbort);
    if (readyTimer) clearTimeout(readyTimer);
    if (releaseTimer) clearTimeout(releaseTimer);
    const failure = forcedFailure ?? (
      !ready || !releaseRequested || code !== 0 || closeSignal !== null
        ? new Win32ExecutableSpawnLeaseError("protocol_invalid")
        : undefined
    );
    if (!ready) {
      rejectReady(failure ?? new Win32ExecutableSpawnLeaseError("unavailable"));
    }
    if (failure) {
      rejectClosed(failure);
    } else {
      resolveClosed();
    }
  });
  readyTimer = setTimeout(() => {
    requestTermination(new Win32ExecutableSpawnLeaseError("unavailable"));
  }, input.readyTimeoutMs);
  readyTimer.unref?.();

  await readyPromise;
  let terminalPromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (terminalPromise) {
      return terminalPromise;
    }
    releaseRequested = true;
    terminalPromise = closedPromise;
    try {
      child.stdin!.end("release\n");
    } catch {
      requestTermination(new Win32ExecutableSpawnLeaseError("unavailable"));
    }
    releaseTimer = setTimeout(() => {
      requestTermination(new Win32ExecutableSpawnLeaseError("unavailable"));
    }, input.releaseTimeoutMs);
    releaseTimer.unref?.();
    return terminalPromise;
  };
  const abort = (): Promise<void> => {
    if (!terminalPromise) {
      terminalPromise = closedPromise;
      requestTermination(new Win32ExecutableSpawnLeaseError("unavailable"));
    }
    return terminalPromise.catch(() => undefined);
  };
  return Object.freeze({
    executablePath: input.executablePath,
    executableDigest: input.executableDigest,
    release,
    abort,
  });
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, 60_000)
    : fallback;
}

const SPAWN_LEASE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
try {
  $path = [Environment]::GetEnvironmentVariable("LING_CUA_PROVIDER_PATH")
  $expected = [Environment]::GetEnvironmentVariable("LING_CUA_PROVIDER_SHA256")
  $fsutil = [Environment]::GetEnvironmentVariable("LING_CUA_FSUTIL_PATH")
  if ([String]::IsNullOrWhiteSpace($path) -or $expected -notmatch '^[a-f0-9]{64}$') { throw "invalid" }
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $links = @(& $fsutil hardlink list $path 2>$null | Where-Object { -not [String]::IsNullOrWhiteSpace($_) })
    if ($LASTEXITCODE -ne 0 -or $links.Count -ne 1) { throw "links" }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($actual -cne $expected) { throw "digest" }
    [Console]::Out.WriteLine("LING_CUA_SPAWN_LEASE_READY_V1")
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -cne "release") { throw "protocol" }
  } finally {
    $stream.Dispose()
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("LING_CUA_SPAWN_LEASE_FAILED_V1")
  exit 20
}
`;

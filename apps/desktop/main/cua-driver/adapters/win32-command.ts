import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { win32 } from "node:path";

export const WIN32_CUA_DRIVER_COMMAND_TIMEOUT_MS = 10_000;
export const WIN32_CUA_DRIVER_STDOUT_MAX_BYTES = 256 * 1024;
export const WIN32_CUA_DRIVER_STDERR_MAX_BYTES = 64 * 1024;
/** Kernel-owned NT object-manager alias; no caller environment selects it. */
export const WIN32_KERNEL_SYSTEM_ROOT = "\\\\?\\GLOBALROOT\\SystemRoot" as const;

export interface Win32CommandInvocation {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly abortSignal?: AbortSignal;
}

export interface Win32CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
  readonly spawnFailed: boolean;
}

export interface Win32CommandRunner {
  run(invocation: Win32CommandInvocation): Promise<Win32CommandResult>;
}

export function isWin32CommandResult(value: unknown): value is Win32CommandResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<Win32CommandResult>;
  return (result.exitCode === null || Number.isInteger(result.exitCode))
    && (result.signal === null || typeof result.signal === "string")
    && typeof result.stdout === "string"
    && typeof result.stderr === "string"
    && typeof result.timedOut === "boolean"
    && typeof result.stdoutOverflow === "boolean"
    && typeof result.stderrOverflow === "boolean"
    && typeof result.spawnFailed === "boolean";
}

export interface Win32SystemExecutables {
  readonly systemRoot: string;
  readonly powershellPath: string;
  readonly icaclsPath: string;
}

type SpawnCommand = (
  executablePath: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env: NodeJS.ProcessEnv;
    readonly windowsHide: true;
    readonly shell: false;
    readonly stdio: ["ignore", "pipe", "pipe"];
    readonly signal?: AbortSignal;
  },
) => ChildProcess;

/**
 * Resolve only Windows-owned executables. No PATH lookup or user installation
 * directory participates in the native verifier boundary.
 */
export function resolveWin32SystemExecutables(systemRoot: string): Win32SystemExecutables {
  if (systemRoot !== systemRoot.trim()
    || (!/^[A-Za-z]:\\/u.test(systemRoot) && systemRoot !== WIN32_KERNEL_SYSTEM_ROOT)
    || !win32.isAbsolute(systemRoot)) {
    throw new Error("win32_system_root_must_be_absolute");
  }
  const canonicalRoot = win32.resolve(systemRoot);
  return Object.freeze({
    systemRoot: canonicalRoot,
    powershellPath: win32.join(
      canonicalRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    icaclsPath: win32.join(canonicalRoot, "System32", "icacls.exe"),
  });
}

/** Fixed UTF-16LE encoding required by Windows PowerShell -EncodedCommand. */
export function encodeWin32PowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Keep secrets and user PATH out of verifier subprocesses. */
export function createWin32VerifierEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  values: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = baseEnvironment[key];
    if (typeof value === "string" && value.length > 0) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(values)) {
    environment[key] = value;
  }
  return environment;
}

export function createBoundedWin32CommandRunner(
  options: { readonly spawnCommand?: SpawnCommand } = {},
): Win32CommandRunner {
  const spawnCommand = options.spawnCommand ?? defaultSpawnCommand;
  return Object.freeze({
    run: (invocation: Win32CommandInvocation) => runBoundedCommand(invocation, spawnCommand),
  });
}

async function runBoundedCommand(
  invocation: Win32CommandInvocation,
  spawnCommand: SpawnCommand,
): Promise<Win32CommandResult> {
  if (!win32.isAbsolute(invocation.executablePath)
    || (invocation.cwd !== undefined && !win32.isAbsolute(invocation.cwd))) {
    return emptyResult({ spawnFailed: true });
  }
  const timeoutMs = boundedPositive(
    invocation.timeoutMs,
    WIN32_CUA_DRIVER_COMMAND_TIMEOUT_MS,
    60_000,
  );
  const maxStdoutBytes = boundedPositive(
    invocation.maxStdoutBytes,
    WIN32_CUA_DRIVER_STDOUT_MAX_BYTES,
    4 * 1024 * 1024,
  );
  const maxStderrBytes = boundedPositive(
    invocation.maxStderrBytes,
    WIN32_CUA_DRIVER_STDERR_MAX_BYTES,
    1024 * 1024,
  );

  return new Promise<Win32CommandResult>((resolveResult) => {
    let child: ChildProcess;
    try {
      child = spawnCommand(invocation.executablePath, invocation.args, {
        ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
        env: invocation.environment,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...(invocation.abortSignal ? { signal: invocation.abortSignal } : {}),
      });
    } catch {
      resolveResult(emptyResult({ spawnFailed: true }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveResult({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        stdoutOverflow,
        stderrOverflow,
        spawnFailed,
      });
    };

    const terminate = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Forced bounded settlement below remains authoritative.
        }
      }
      // Never report a verifier result while the retained process or one of
      // its inherited stdio handles remains live. The platform boundary must
      // deliver `close`; a failed cleanup therefore stays fail-closed instead
      // of letting startup continue with an unowned verifier.
    };

    const acceptChunk = (
      chunk: Buffer | string,
      chunks: Buffer[],
      currentBytes: number,
      limit: number,
      markOverflow: () => void,
    ): number => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, limit - currentBytes);
      if (remaining > 0) {
        chunks.push(bytes.subarray(0, remaining));
      }
      if (bytes.byteLength > remaining) {
        markOverflow();
        terminate();
      }
      return currentBytes + bytes.byteLength;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBytes = acceptChunk(chunk, stdoutChunks, stdoutBytes, maxStdoutBytes, () => {
        stdoutOverflow = true;
      });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes = acceptChunk(chunk, stderrChunks, stderrBytes, maxStderrBytes, () => {
        stderrOverflow = true;
      });
    });
    child.once("error", () => {
      spawnFailed = true;
      if (child.pid === undefined) {
        finish(child.exitCode, child.signalCode);
      } else {
        terminate();
      }
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    if (settled) {
      return;
    }
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref?.();
  });
}

function emptyResult(overrides: Partial<Win32CommandResult> = {}): Win32CommandResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    stdoutOverflow: false,
    stderrOverflow: false,
    spawnFailed: false,
    ...overrides,
  };
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, maximum)
    : fallback;
}

const defaultSpawnCommand: SpawnCommand = (executablePath, args, options) => spawn(
  executablePath,
  [...args],
  options,
);

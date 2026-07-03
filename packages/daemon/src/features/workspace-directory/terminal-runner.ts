import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  WorkspaceTerminalCommandRequest,
  WorkspaceTerminalCommandResponse,
} from "@ling-stack/contracts";

type SpawnImpl = typeof spawn;
type StatImpl = typeof stat;
type ChildProcessLike = ReturnType<typeof spawn>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 24_000;
const MAX_COMMAND_LENGTH = 8_000;

export type WorkspaceTerminalCommandCode =
  | "terminal_command_invalid_directory"
  | "terminal_command_invalid_input"
  | "terminal_command_failed";

export class WorkspaceTerminalCommandError extends Error {
  readonly code: WorkspaceTerminalCommandCode;
  readonly statusCode: number;

  constructor(code: WorkspaceTerminalCommandCode, message: string, statusCode: number) {
    super(message);
    this.name = "WorkspaceTerminalCommandError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function runWorkspaceTerminalCommand(input: {
  readonly cwd: string;
  readonly command: string;
  readonly platform?: NodeJS.Platform;
  readonly spawnImpl?: SpawnImpl;
  readonly statImpl?: StatImpl;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly idFactory?: () => string;
}): Promise<WorkspaceTerminalCommandResponse> {
  const rawCwd = input.cwd.trim();
  const command = input.command.trim();
  const statImpl = input.statImpl ?? stat;
  const spawnImpl = input.spawnImpl ?? spawn;
  const now = input.now ?? (() => new Date());
  const idFactory = input.idFactory ?? randomUUID;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimitBytes = input.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;

  if (!rawCwd) {
    throw new WorkspaceTerminalCommandError("terminal_command_invalid_directory", "Workspace directory is required.", 400);
  }
  if (!command) {
    throw new WorkspaceTerminalCommandError("terminal_command_invalid_input", "Command is required.", 400);
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new WorkspaceTerminalCommandError(
      "terminal_command_invalid_input",
      `Command exceeds ${MAX_COMMAND_LENGTH} characters.`,
      400,
    );
  }

  const directory = resolve(rawCwd);
  await assertDirectory(directory, statImpl);

  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const shell = shellCommandForPlatform(input.platform ?? process.platform, command);
  const stdoutBuffer = createOutputBuffer(outputLimitBytes);
  const stderrBuffer = createOutputBuffer(outputLimitBytes);
  const child = spawnImpl(shell.command, [...shell.args], {
    cwd: directory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessLike;

  child.stdout?.on("data", (chunk) => stdoutBuffer.append(chunk));
  child.stderr?.on("data", (chunk) => stderrBuffer.append(chunk));

  const result = await waitForCommand(child, timeoutMs);
  const completedAtDate = now();
  const status = result.timedOut
    ? "timed_out"
    : result.code === 0
      ? "succeeded"
      : "failed";

  return {
    id: idFactory(),
    cwd: directory,
    command,
    status,
    exitCode: result.code ?? undefined,
    signal: result.signal ?? undefined,
    stdout: stdoutBuffer.text(),
    stderr: stderrBuffer.text(),
    stdoutTruncated: stdoutBuffer.truncated(),
    stderrTruncated: stderrBuffer.truncated(),
    startedAt,
    completedAt: completedAtDate.toISOString(),
    durationMs: Math.max(0, completedAtDate.getTime() - startedAtDate.getTime()),
  };
}

export function parseWorkspaceTerminalCommandRequest(value: unknown): WorkspaceTerminalCommandRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceTerminalCommandError("terminal_command_invalid_input", "Request body must be an object.", 400);
  }
  const command = (value as { command?: unknown }).command;
  if (typeof command !== "string") {
    throw new WorkspaceTerminalCommandError("terminal_command_invalid_input", "command must be a string.", 400);
  }
  return { command };
}

function shellCommandForPlatform(platform: NodeJS.Platform, command: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  if (platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return {
    command: platform === "darwin" ? "/bin/zsh" : "/bin/sh",
    args: ["-lc", command],
  };
}

async function assertDirectory(directory: string, statImpl: StatImpl): Promise<void> {
  try {
    const stats = await statImpl(directory);
    if (stats.isDirectory()) {
      return;
    }
  } catch {
    // Fall through to the normalized public error below.
  }
  throw new WorkspaceTerminalCommandError(
    "terminal_command_invalid_directory",
    `Workspace directory does not exist: ${directory}`,
    400,
  );
}

function waitForCommand(child: ChildProcessLike, timeoutMs: number): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}> {
  return new Promise((resolveCommand, rejectCommand) => {
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.once("error", (error) => {
      settle(() => rejectCommand(new WorkspaceTerminalCommandError(
        "terminal_command_failed",
        error instanceof Error ? error.message : String(error),
        500,
      )));
    });
    child.once("close", (code, signal) => {
      settle(() => resolveCommand({
        code,
        signal,
        timedOut,
      }));
    });
  });
}

function createOutputBuffer(limitBytes: number): {
  readonly append: (chunk: Buffer | string) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let isTruncated = false;
  return {
    append(chunk) {
      if (isTruncated) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = limitBytes - size;
      if (remaining <= 0) {
        isTruncated = true;
        return;
      }
      if (buffer.byteLength > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        size += remaining;
        isTruncated = true;
        return;
      }
      chunks.push(buffer);
      size += buffer.byteLength;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    truncated() {
      return isTruncated;
    },
  };
}

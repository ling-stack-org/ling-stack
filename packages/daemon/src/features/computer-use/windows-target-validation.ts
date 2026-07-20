import type { McpServer, SecretResolver } from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker } from "../../context.js";

const MAX_WINDOWS_PID = 0xffff_ffff;
const MAX_WINDOWS_HANDLE = 0xffff_ffff_ffff_ffffn;
const MAX_MACOS_WINDOW_ID = 0xffff_ffff;

export type ProviderTargetPlatform = "macos" | "windows";

export async function validateProviderTargetOwnership(input: {
  readonly platform: ProviderTargetPlatform;
  readonly server: McpServer;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly processId: number;
  readonly nativeWindowId: string;
  readonly now: string;
  readonly workspaceCwd?: string;
  readonly signal?: AbortSignal;
  readonly assertResultCurrent?: () => void;
}): Promise<boolean> {
  if (
    !input.server.enabled ||
    !isProviderPid(input.processId) ||
    !isNativeWindowId(input.platform, input.nativeWindowId)
  ) {
    return false;
  }
  try {
    input.signal?.throwIfAborted();
    const result = await input.mcpBroker.callTool(
      input.server,
      {
        secretResolver: input.secretResolver,
        workspaceCwd: input.workspaceCwd,
        now: () => input.now,
        signal: input.signal,
        assertResultCurrent: input.assertResultCurrent,
      },
      "list_windows",
      { pid: input.processId },
    );
    input.signal?.throwIfAborted();
    // Default/generation brokers fence immediately after transport return;
    // repeat at this consumer boundary so a custom broker cannot bypass it.
    input.assertResultCurrent?.();
    return result.isError !== true && providerResultOwnsTarget(
      result,
      input.platform,
      input.processId,
      input.nativeWindowId,
    );
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    return false;
  }
}

export async function validateWindowsProviderTargetOwnership(input: {
  readonly server: McpServer;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly processId: number;
  readonly nativeWindowId: string;
  readonly now: string;
  readonly workspaceCwd?: string;
  readonly signal?: AbortSignal;
  readonly assertResultCurrent?: () => void;
}): Promise<boolean> {
  return validateProviderTargetOwnership({ ...input, platform: "windows" });
}

export function providerResultOwnsTarget(
  result: PiRunnerMcpToolCallResult,
  platform: ProviderTargetPlatform,
  expectedProcessId: number,
  expectedNativeWindowId: string,
): boolean {
  if (
    !isProviderPid(expectedProcessId) ||
    !isNativeWindowId(platform, expectedNativeWindowId)
  ) {
    return false;
  }
  const windows = readWindows(result);
  if (!windows) {
    return false;
  }
  const ownersForHandle = windows
    .filter(isRecord)
    .filter((window) => readWindowId(window.window_id, platform) === expectedNativeWindowId)
    .map((window) => readProcessId(window.pid));
  return ownersForHandle.length === 1 && ownersForHandle[0] === expectedProcessId;
}

export function windowsProviderResultOwnsTarget(
  result: PiRunnerMcpToolCallResult,
  expectedProcessId: number,
  expectedNativeWindowId: string,
): boolean {
  return providerResultOwnsTarget(result, "windows", expectedProcessId, expectedNativeWindowId);
}

function readWindows(result: PiRunnerMcpToolCallResult): readonly unknown[] | undefined {
  const candidates: unknown[] = [result.details];
  for (const content of result.content) {
    if (content.type !== "text" || typeof content.text !== "string") {
      continue;
    }
    try {
      candidates.push(JSON.parse(content.text));
    } catch {
      // Only strict JSON provider output can prove HWND ownership.
    }
  }
  for (const candidate of candidates) {
    const windows = unwrapWindows(candidate);
    if (windows) {
      return windows;
    }
  }
  return undefined;
}

function unwrapWindows(value: unknown): readonly unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (Array.isArray(value.windows)) {
    return value.windows;
  }
  for (const key of ["structuredContent", "result", "data"] as const) {
    const nested = unwrapWindows(value[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function readProcessId(value: unknown): number | undefined {
  return isProviderPid(value) ? value : undefined;
}

function isProviderPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_WINDOWS_PID;
}

function readWindowId(value: unknown, platform: ProviderTargetPlatform): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    const normalized = String(value);
    return isNativeWindowId(platform, normalized) ? normalized : undefined;
  }
  return typeof value === "string" && isNativeWindowId(platform, value) ? value : undefined;
}

function isNativeWindowId(platform: ProviderTargetPlatform, value: string): boolean {
  return platform === "windows" ? isWindowsHandle(value) : isMacosWindowId(value);
}

function isWindowsHandle(value: string): boolean {
  if (!/^[1-9]\d{0,19}$/u.test(value)) {
    return false;
  }
  try {
    return BigInt(value) <= MAX_WINDOWS_HANDLE;
  } catch {
    return false;
  }
}

function isMacosWindowId(value: string): boolean {
  if (!/^[1-9]\d{0,9}$/u.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_MACOS_WINDOW_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

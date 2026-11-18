import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { LockedComputerControlPlatform } from "@ling-stack/contracts";
import type {
  LockedControlNativeAttestationRequest,
  LockedControlNativeBridge,
  LockedControlNativeIdentityRequest,
} from "./native-bridge.js";

export const LOCKED_CONTROL_NATIVE_HELPER_MAX_OUTPUT_BYTES = 16 * 1024;

export interface LockedControlNativeSessionResponse {
  readonly platform: LockedComputerControlPlatform;
  readonly sessionBindingDigest: string;
  readonly sessionActive: boolean;
  readonly sessionLocked: boolean;
}

export interface LockedControlNativeStatusResponse {
  readonly platform: "darwin";
  readonly productCapability: "disabled_by_build" | "probe_required" | "supported_restricted";
  readonly available: boolean;
  readonly captureReady: boolean;
  readonly inputReady: boolean;
  readonly secureSurfaceExcluded: boolean;
}

export interface LockedControlNativeSessionBridge extends LockedControlNativeBridge {
  readSession(signal: AbortSignal): Promise<LockedControlNativeSessionResponse>;
  readStatus(signal: AbortSignal): Promise<LockedControlNativeStatusResponse>;
}

interface NativeHelperRequest {
  readonly command: "identity" | "session" | "status" | "attest";
  readonly platform: LockedComputerControlPlatform;
  readonly requestId?: string;
  readonly localizedReason?: string;
  readonly expectedSessionBindingDigest?: string;
  readonly lockEpoch?: number;
  readonly providerGeneration?: number;
}

type InvokeHelper = (
  helperPath: string,
  request: NativeHelperRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export function createLockedControlNativeHelperBridge(options: {
  readonly helperPath: string;
  readonly platform: LockedComputerControlPlatform;
  readonly invoke?: InvokeHelper;
}): LockedControlNativeSessionBridge {
  if (!isAbsolute(options.helperPath)) {
    throw new Error("locked_control_native_helper_path_not_absolute");
  }
  const invoke = options.invoke ?? invokeJsonHelper;
  return Object.freeze({
    async verifyIdentity(request: LockedControlNativeIdentityRequest): Promise<unknown> {
      assertPlatform(request.platform, options.platform);
      return invoke(options.helperPath, {
        command: "identity",
        platform: options.platform,
        requestId: request.requestId,
        localizedReason: request.localizedReason,
      }, request.signal);
    },
    async attestLockedSession(request: LockedControlNativeAttestationRequest): Promise<unknown> {
      assertPlatform(request.platform, options.platform);
      return invoke(options.helperPath, {
        command: "attest",
        platform: options.platform,
        expectedSessionBindingDigest: request.expectedSessionBindingDigest,
        lockEpoch: request.lockEpoch,
        providerGeneration: request.providerGeneration,
      }, request.signal);
    },
    async readSession(signal: AbortSignal): Promise<LockedControlNativeSessionResponse> {
      const value = await invoke(options.helperPath, {
        command: "session",
        platform: options.platform,
      }, signal);
      const parsed = parseLockedControlNativeSessionResponse(value);
      if (!parsed || parsed.platform !== options.platform) {
        throw new Error("locked_control_native_session_invalid");
      }
      return parsed;
    },
    async readStatus(signal: AbortSignal): Promise<LockedControlNativeStatusResponse> {
      const value = await invoke(options.helperPath, {
        command: "status",
        platform: options.platform,
      }, signal);
      const parsed = parseLockedControlNativeStatusResponse(value);
      if (!parsed) throw new Error("locked_control_native_status_invalid");
      return parsed;
    },
  });
}

export function parseLockedControlNativeStatusResponse(
  value: unknown,
): LockedControlNativeStatusResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["platform", "productCapability", "available", "captureReady", "inputReady", "secureSurfaceExcluded"])
    || value.platform !== "darwin"
    || (value.productCapability !== "disabled_by_build"
      && value.productCapability !== "probe_required"
      && value.productCapability !== "supported_restricted")
    || !areBooleans(value, ["available", "captureReady", "inputReady", "secureSurfaceExcluded"])) {
    return undefined;
  }
  const supported = value.productCapability === "supported_restricted";
  if (supported !== value.available
    || (supported && (!value.captureReady || !value.inputReady || !value.secureSurfaceExcluded))
    || (!supported && (value.captureReady || value.inputReady || value.secureSurfaceExcluded))) return undefined;
  return {
    platform: "darwin",
    productCapability: value.productCapability,
    available: value.available as boolean,
    captureReady: value.captureReady as boolean,
    inputReady: value.inputReady as boolean,
    secureSurfaceExcluded: value.secureSurfaceExcluded as boolean,
  };
}

export function parseLockedControlNativeSessionResponse(
  value: unknown,
): LockedControlNativeSessionResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "platform", "sessionBindingDigest", "sessionActive", "sessionLocked",
    ])
    || (value.platform !== "darwin" && value.platform !== "win32")
    || typeof value.sessionBindingDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.sessionBindingDigest)
    || typeof value.sessionActive !== "boolean"
    || typeof value.sessionLocked !== "boolean") {
    return undefined;
  }
  return {
    platform: value.platform,
    sessionBindingDigest: value.sessionBindingDigest,
    sessionActive: value.sessionActive,
    sessionLocked: value.sessionLocked,
  };
}

async function invokeJsonHelper(
  helperPath: string,
  request: NativeHelperRequest,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    let stdout = Buffer.alloc(0);
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill("SIGKILL");
      settle(() => reject(signal.reason ?? new Error("locked_control_native_helper_aborted")));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => settle(() => reject(error)));
    child.stdin.once("error", (error) => settle(() => reject(error)));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > LOCKED_CONTROL_NATIVE_HELPER_MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        settle(() => reject(new Error("locked_control_native_helper_output_too_large")));
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        settle(() => reject(new Error("locked_control_native_helper_failed")));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout.toString("utf8"));
        settle(() => resolve(parsed));
      } catch {
        settle(() => reject(new Error("locked_control_native_helper_invalid_json")));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

function assertPlatform(
  requested: LockedComputerControlPlatform,
  configured: LockedComputerControlPlatform,
): void {
  if (requested !== configured) {
    throw new Error("locked_control_native_platform_mismatch");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function areBooleans(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "boolean");
}

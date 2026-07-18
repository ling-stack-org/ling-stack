import type {
  CuaDriverProviderState,
  WindowsManagedReadinessChangedV1,
  WindowsManagedReadinessV1,
} from "@ling-stack/contracts";
import type { JsonRpcParams, JsonRpcResponse } from "./provider-host.js";

export interface CuaDriverReadinessContext {
  readonly generation: number;
  readonly childInstanceNonce: string;
  readonly platform: "darwin" | "win32";
  readonly hostProcessId?: number;
  readonly providerProcessId?: number;
  readonly requestControl?: (method: `ling/${string}`, params: JsonRpcParams) => Promise<JsonRpcResponse>;
}

export interface CuaDriverReadinessResult {
  readonly generation: number;
  readonly childInstanceNonce: string;
  readonly ready: boolean;
  readonly providerState: Extract<CuaDriverProviderState, "ready" | "permission_required" | "interactive_session_required" | "platform_unavailable">;
  readonly reason?: string;
  /** Initial active-child response sequence; later notifications must increase. */
  readonly readinessSequence?: number;
  readonly integrityCoverage?: "standard" | "uiaccess";
  readonly limitations?: readonly string[];
}

export interface CuaDriverReadinessController {
  check(context: CuaDriverReadinessContext): Promise<CuaDriverReadinessResult>;
  acceptChanged?(context: CuaDriverReadinessContext, message: unknown): CuaDriverReadinessResult | undefined;
  invalidate(generation: number, reason: string): void;
}

/**
 * Electron/native session events are recovery hints only. A fresh active child
 * must still pass `ling/managed_readiness` before the call gate can reopen.
 */
export interface CuaDriverWindowsSessionRecoveryHint {
  readonly kind: "unlock" | "session_active";
}

export interface CuaDriverWindowsSessionRecoveryObserver {
  subscribe(listener: (hint: CuaDriverWindowsSessionRecoveryHint) => void): () => void;
}

/** Native TCC/WTS/Job Object adapters implement this narrow boundary in PR6/PR7. */
export class FailClosedCuaDriverReadinessController implements CuaDriverReadinessController {
  async check(context: CuaDriverReadinessContext): Promise<CuaDriverReadinessResult> {
    return {
      generation: context.generation,
      childInstanceNonce: context.childInstanceNonce,
      ready: false,
      providerState: "platform_unavailable",
      reason: "platform_readiness_adapter_not_installed",
    };
  }

  invalidate(_generation: number, _reason: string): void {
    // Deliberately no state survives a generation boundary.
  }
}

/**
 * Shared Windows active-child request implementation. Native Rust owns the
 * actual WTS/input-desktop/UIA/D3D/WGC checks; this adapter only validates the
 * content-free response and supplies the initial readiness fence.
 */
export class WindowsActiveChildReadinessController implements CuaDriverReadinessController {
  async check(context: CuaDriverReadinessContext): Promise<CuaDriverReadinessResult> {
    if (context.platform !== "win32" || !context.requestControl) {
      return notReadyResult(context, "windows_managed_readiness_request_unavailable");
    }
    let response;
    try {
      response = await context.requestControl("ling/managed_readiness", {
        schemaVersion: 1,
        childInstanceNonce: context.childInstanceNonce,
        leaseGeneration: context.generation,
      });
    } catch {
      return notReadyResult(context, "windows_managed_readiness_request_failed");
    }
    if (!("result" in response) || !isWindowsManagedReadiness(response.result)) {
      return notReadyResult(context, "windows_managed_readiness_response_invalid");
    }
    if (response.result.childInstanceNonce !== context.childInstanceNonce || response.result.leaseGeneration !== context.generation) {
      return notReadyResult(context, "windows_managed_readiness_context_mismatch");
    }
    return mapWindowsReadinessResult(context, response.result);
  }

  invalidate(_generation: number, _reason: string): void {
    // The next generation gets a fresh active-child request.
  }
}

/**
 * Shared nonce/generation/sequence fence for native readiness notifications.
 * It accepts no stale, malformed or out-of-order event, independent of platform.
 */
export class GenerationFencedCuaDriverReadiness implements CuaDriverReadinessController {
  private current: CuaDriverReadinessContext | undefined;
  private lastSequence = 0;
  private invalidated = false;

  constructor(private readonly delegate: CuaDriverReadinessController) {}

  async check(context: CuaDriverReadinessContext): Promise<CuaDriverReadinessResult> {
    this.bind(context);
    const result = await this.delegate.check(context);
    if (!this.isCurrentContext(context)) {
      return this.notReady(context, "readiness_check_superseded");
    }
    if (this.invalidated) {
      return this.notReady(context, "readiness_context_invalidated");
    }
    if (result.generation !== context.generation || result.childInstanceNonce !== context.childInstanceNonce) {
      this.invalidated = true;
      this.delegate.invalidate(context.generation, "readiness_context_mismatch");
      return this.notReady(context, "readiness_context_mismatch");
    }
    if (result.readinessSequence !== undefined && positive(result.readinessSequence)) {
      this.lastSequence = result.readinessSequence;
    }
    return result;
  }

  acceptChanged(context: CuaDriverReadinessContext, message: unknown): CuaDriverReadinessResult | undefined {
    if (!this.matchesContext(context) || !isWindowsReadinessChanged(message)) {
      return undefined;
    }
    if (message.childInstanceNonce !== context.childInstanceNonce || message.leaseGeneration !== context.generation || message.readinessSequence <= this.lastSequence) {
      return undefined;
    }
    this.lastSequence = message.readinessSequence;
    const result = mapWindowsReadinessResult(context, message);
    if (!result.ready) {
      this.invalidated = true;
      this.delegate.invalidate(context.generation, result.reason ?? "readiness_changed");
    }
    return result;
  }

  invalidate(generation: number, reason: string): void {
    if (this.current?.generation !== generation) {
      return;
    }
    this.invalidated = true;
    this.delegate.invalidate(generation, reason);
  }

  private bind(context: CuaDriverReadinessContext): void {
    if (!this.current || this.current.generation !== context.generation || this.current.childInstanceNonce !== context.childInstanceNonce) {
      this.current = context;
      this.lastSequence = 0;
      this.invalidated = false;
    }
  }

  private matchesContext(context: CuaDriverReadinessContext): boolean {
    return this.isCurrentContext(context) && !this.invalidated;
  }

  private isCurrentContext(context: Pick<CuaDriverReadinessContext, "generation" | "childInstanceNonce">): boolean {
    return this.current?.generation === context.generation
      && this.current.childInstanceNonce === context.childInstanceNonce;
  }

  private notReady(context: CuaDriverReadinessContext, reason: string): CuaDriverReadinessResult {
    return {
      generation: context.generation,
      childInstanceNonce: context.childInstanceNonce,
      ready: false,
      providerState: "platform_unavailable",
      reason,
    };
  }
}

function mapWindowsReadinessResult(
  context: CuaDriverReadinessContext,
  message: WindowsManagedReadinessV1 | WindowsManagedReadinessChangedV1,
): CuaDriverReadinessResult {
  const interactiveSessionUnavailable = message.inputDesktop !== "default_unlocked"
    || message.hostSessionId === 0
    || message.providerSessionId === 0
    || message.providerSessionId !== message.hostSessionId;
  const ready = !interactiveSessionUnavailable
    && context.hostProcessId !== undefined
    && message.hostProcessId === context.hostProcessId
    && context.providerProcessId !== undefined
    && message.providerProcessId === context.providerProcessId
    && message.hostIntegrityLevel === "medium"
    && message.providerIntegrityLevel === "medium"
    && message.jobObjectAssigned
    && message.killOnJobClose
    && message.uiaRuntime === "available"
    && message.d3d11 === "available"
    && message.wgcApi === "supported";
  return {
    generation: context.generation,
    childInstanceNonce: context.childInstanceNonce,
    readinessSequence: message.readinessSequence,
    ready,
    providerState: ready ? "ready" : interactiveSessionUnavailable ? "interactive_session_required" : "platform_unavailable",
    reason: ready
      ? undefined
      : ("reason" in message
          ? message.reason
          : interactiveSessionUnavailable
            ? "windows_interactive_session_required"
            : "windows_managed_readiness_not_ready"),
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  };
}

function notReadyResult(context: CuaDriverReadinessContext, reason: string): CuaDriverReadinessResult {
  return {
    generation: context.generation,
    childInstanceNonce: context.childInstanceNonce,
    ready: false,
    providerState: "platform_unavailable",
    reason,
  };
}

function isWindowsReadinessChanged(value: unknown): value is WindowsManagedReadinessChangedV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.childInstanceNonce !== "string"
    || value.childInstanceNonce.length < 16
    || !positive(value.leaseGeneration)
    || !positive(value.readinessSequence)
    || !positive(value.hostProcessId)
    || !positive(value.providerProcessId)
    || !nonNegative(value.hostSessionId)
    || !nonNegative(value.providerSessionId)
    || !isProcessIntegrity(value.hostIntegrityLevel)
    || !isProcessIntegrity(value.providerIntegrityLevel)
    || !isInputDesktop(value.inputDesktop)
    || typeof value.jobObjectAssigned !== "boolean"
    || typeof value.killOnJobClose !== "boolean"
    || !isUiaRuntime(value.uiaRuntime)
    || !isD3d11(value.d3d11)
    || !isWgc(value.wgcApi)
    || value.contentObserved !== false) {
    return false;
  }
  const allowedKeys = new Set([
    "schemaVersion", "childInstanceNonce", "leaseGeneration", "readinessSequence",
    "hostProcessId", "hostSessionId", "hostIntegrityLevel", "providerProcessId",
    "providerSessionId", "providerIntegrityLevel", "inputDesktop", "jobObjectAssigned",
    "killOnJobClose", "uiaRuntime", "d3d11", "wgcApi", "contentObserved", "reason",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  return value.reason === "lock"
    || value.reason === "unlock"
    || value.reason === "disconnect"
    || value.reason === "logoff"
    || value.reason === "fast_user_switch"
    || value.reason === "session_mismatch"
    || value.reason === "input_desktop_changed"
    || value.reason === "heartbeat";
}

function isWindowsManagedReadiness(value: unknown): value is WindowsManagedReadinessV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.childInstanceNonce !== "string"
    || value.childInstanceNonce.length < 16
    || !positive(value.leaseGeneration)
    || !positive(value.readinessSequence)
    || !positive(value.hostProcessId)
    || !positive(value.providerProcessId)
    || !nonNegative(value.hostSessionId)
    || !nonNegative(value.providerSessionId)
    || !isProcessIntegrity(value.hostIntegrityLevel)
    || !isProcessIntegrity(value.providerIntegrityLevel)
    || !isInputDesktop(value.inputDesktop)
    || typeof value.jobObjectAssigned !== "boolean"
    || typeof value.killOnJobClose !== "boolean"
    || !isUiaRuntime(value.uiaRuntime)
    || !isD3d11(value.d3d11)
    || !isWgc(value.wgcApi)
    || value.contentObserved !== false) {
    return false;
  }
  const allowedKeys = new Set([
    "schemaVersion", "childInstanceNonce", "leaseGeneration", "readinessSequence",
    "hostProcessId", "hostSessionId", "hostIntegrityLevel", "providerProcessId",
    "providerSessionId", "providerIntegrityLevel", "inputDesktop", "jobObjectAssigned",
    "killOnJobClose", "uiaRuntime", "d3d11", "wgcApi", "contentObserved",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  return true;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isProcessIntegrity(value: unknown): value is "medium" | "high" | "system" | "unknown" {
  return value === "medium" || value === "high" || value === "system" || value === "unknown";
}

function isInputDesktop(value: unknown): value is "default_unlocked" | "locked" | "non_default" | "unavailable" {
  return value === "default_unlocked" || value === "locked" || value === "non_default" || value === "unavailable";
}

function isUiaRuntime(value: unknown): value is "available" | "unavailable" {
  return value === "available" || value === "unavailable";
}

function isD3d11(value: unknown): value is "available" | "unavailable" {
  return value === "available" || value === "unavailable";
}

function isWgc(value: unknown): value is "supported" | "unsupported" | "unavailable" {
  return value === "supported" || value === "unsupported" || value === "unavailable";
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

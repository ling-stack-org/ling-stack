import type {
  BundledCuaDriverPlatform,
  CuaDriverIntegrityCoverage,
  CuaDriverLimitation,
} from "@ling-stack/contracts";
import {
  CuaDriverPlatformIdentityVerificationError,
  type CuaDriverPlatformIdentityVerifier,
} from "./provider-seal.js";
import type { CuaDriverProviderProcessLifecycle } from "./provider-host.js";
import {
  FailClosedCuaDriverReadinessController,
  type CuaDriverReadinessController,
  type CuaDriverWindowsSessionRecoveryObserver,
} from "./readiness-controller.js";
import {
  CuaDriverStateRootError,
  type CuaDriverStateRootPlatformProtector,
} from "./state-root.js";

export type CuaDriverPlatformBindingErrorCode =
  | "adapter_not_installed"
  | "availability_invalid"
  | "dependency_invalid"
  | "metadata_invalid"
  | "mixed_dependency_overrides"
  | "platform_mismatch"
  | "unsupported_platform";

export class CuaDriverPlatformBindingError extends Error {
  readonly code = "cua_driver_platform_binding_failed" as const;

  constructor(
    readonly bindingCode: CuaDriverPlatformBindingErrorCode,
    readonly platform: string,
  ) {
    super(`cua_driver_platform_binding_${bindingCode}:${platform}`);
    this.name = "CuaDriverPlatformBindingError";
  }
}

export type CuaDriverPlatformBindingAvailability =
  | Readonly<{ readonly status: "available" }>
  | Readonly<{ readonly status: "unavailable"; readonly reason: string }>;

export interface CuaDriverPlatformBindingMetadata {
  readonly integrityCoverage?: CuaDriverIntegrityCoverage;
  readonly limitations: readonly CuaDriverLimitation[];
}

interface CuaDriverPlatformBindingBase {
  readonly platform: BundledCuaDriverPlatform;
  /**
   * Placeholder bindings remain explicitly unavailable until a native adapter
   * replaces them. The coordinator checks this before resolving provider paths.
   */
  readonly availability: CuaDriverPlatformBindingAvailability;
  readonly platformIdentityVerifier: CuaDriverPlatformIdentityVerifier;
  readonly readinessController: CuaDriverReadinessController;
}

type DarwinCuaDriverProcessLifecycle = CuaDriverProviderProcessLifecycle & Readonly<{
  readonly lifetimeBoundary: "darwin-direct-child";
}>;

type Win32CuaDriverProcessLifecycle = CuaDriverProviderProcessLifecycle & Readonly<{
  readonly lifetimeBoundary: "windows-job-object";
}>;

export interface DarwinCuaDriverPlatformBinding extends CuaDriverPlatformBindingBase {
  readonly platform: "darwin";
  readonly processLifecycle: DarwinCuaDriverProcessLifecycle;
  readonly stateRootProtector?: undefined;
  readonly windowsSessionRecoveryObserver?: undefined;
  readonly metadata: Readonly<{
    readonly integrityCoverage?: undefined;
    readonly limitations: readonly [];
  }>;
}

export interface Win32CuaDriverPlatformBinding extends CuaDriverPlatformBindingBase {
  readonly platform: "win32";
  readonly processLifecycle: Win32CuaDriverProcessLifecycle;
  readonly stateRootProtector: CuaDriverStateRootPlatformProtector;
  readonly windowsSessionRecoveryObserver: CuaDriverWindowsSessionRecoveryObserver;
  readonly metadata: Readonly<{
    readonly integrityCoverage: "standard";
    readonly limitations: readonly ["elevated_pixel_input", "uwp_send_input"];
  }>;
}

export type CuaDriverPlatformBinding =
  | DarwinCuaDriverPlatformBinding
  | Win32CuaDriverPlatformBinding;

export interface CuaDriverPlatformBindingRegistry {
  readonly darwin?: DarwinCuaDriverPlatformBinding;
  readonly win32?: Win32CuaDriverPlatformBinding;
}

const EMPTY_LIMITATIONS = Object.freeze([] as const);
const WINDOWS_STANDARD_LIMITATIONS = Object.freeze([
  "elevated_pixel_input",
  "uwp_send_input",
] as const);

const failClosedIdentityVerifier: CuaDriverPlatformIdentityVerifier = Object.freeze({
  async verify() {
    throw new CuaDriverPlatformIdentityVerificationError("unavailable");
  },
});

const failClosedWindowsStateRootProtector: CuaDriverStateRootPlatformProtector = Object.freeze({
  async protect(input: Parameters<CuaDriverStateRootPlatformProtector["protect"]>[0]) {
    throw new CuaDriverStateRootError("windows_state_root_adapter_not_installed", input.stateRootPath);
  },
});

const failClosedWindowsSessionObserver: CuaDriverWindowsSessionRecoveryObserver = Object.freeze({
  subscribe() {
    throw new CuaDriverPlatformBindingError("adapter_not_installed", "win32");
  },
});

const DARWIN_PLACEHOLDER_REASON = "darwin_platform_adapter_not_installed";
const WIN32_PLACEHOLDER_REASON = "win32_platform_adapter_not_installed";

export const FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING: DarwinCuaDriverPlatformBinding = Object.freeze({
  platform: "darwin",
  availability: Object.freeze({ status: "unavailable", reason: DARWIN_PLACEHOLDER_REASON }),
  platformIdentityVerifier: failClosedIdentityVerifier,
  processLifecycle: failClosedProcessLifecycle("darwin"),
  readinessController: new FailClosedCuaDriverReadinessController(DARWIN_PLACEHOLDER_REASON),
  metadata: Object.freeze({ limitations: EMPTY_LIMITATIONS }),
});

export const FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING: Win32CuaDriverPlatformBinding = Object.freeze({
  platform: "win32",
  availability: Object.freeze({ status: "unavailable", reason: WIN32_PLACEHOLDER_REASON }),
  platformIdentityVerifier: failClosedIdentityVerifier,
  stateRootProtector: failClosedWindowsStateRootProtector,
  processLifecycle: failClosedProcessLifecycle("win32"),
  readinessController: new FailClosedCuaDriverReadinessController(WIN32_PLACEHOLDER_REASON),
  windowsSessionRecoveryObserver: failClosedWindowsSessionObserver,
  metadata: Object.freeze({
    integrityCoverage: "standard",
    limitations: WINDOWS_STANDARD_LIMITATIONS,
  }),
});

/**
 * Select exactly one host-platform implementation. Unsupported hosts never
 * fall through to the Darwin implementation.
 */
export function selectCuaDriverPlatformBinding(
  platform: string,
  registry: CuaDriverPlatformBindingRegistry = {},
): CuaDriverPlatformBinding {
  if (platform === "darwin") {
    const binding = registry.darwin ?? FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING;
    assertCuaDriverPlatformBinding(binding, platform);
    return binding;
  }
  if (platform === "win32") {
    const binding = registry.win32 ?? FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING;
    assertCuaDriverPlatformBinding(binding, platform);
    return binding;
  }
  throw new CuaDriverPlatformBindingError("unsupported_platform", platform);
}

/** Clone, validate and freeze metadata before projecting it outside main. */
export function normalizeCuaDriverPlatformBindingMetadata(
  metadata: CuaDriverPlatformBindingMetadata,
  platform: BundledCuaDriverPlatform,
): CuaDriverPlatformBindingMetadata {
  if (!metadata || !Array.isArray(metadata.limitations)) {
    throw new CuaDriverPlatformBindingError("metadata_invalid", platform);
  }
  const values = new Set<CuaDriverLimitation>();
  for (const limitation of metadata.limitations) {
    if (limitation !== "elevated_pixel_input" && limitation !== "uwp_send_input") {
      throw new CuaDriverPlatformBindingError("metadata_invalid", platform);
    }
    values.add(limitation);
  }
  const limitations = WINDOWS_STANDARD_LIMITATIONS.filter((limitation) => values.has(limitation));
  if (metadata.integrityCoverage !== undefined
    && metadata.integrityCoverage !== "standard"
    && metadata.integrityCoverage !== "uiaccess") {
    throw new CuaDriverPlatformBindingError("metadata_invalid", platform);
  }
  if (platform === "darwin") {
    if (metadata.integrityCoverage !== undefined || limitations.length !== 0) {
      throw new CuaDriverPlatformBindingError("metadata_invalid", platform);
    }
    return Object.freeze({ limitations: EMPTY_LIMITATIONS });
  }
  if (metadata.integrityCoverage !== "standard"
    || limitations.length !== WINDOWS_STANDARD_LIMITATIONS.length) {
    throw new CuaDriverPlatformBindingError("metadata_invalid", platform);
  }
  return Object.freeze({
    integrityCoverage: "standard",
    limitations: Object.freeze([...limitations]),
  });
}

export function assertCuaDriverPlatformBinding(
  binding: CuaDriverPlatformBinding,
  platform: BundledCuaDriverPlatform,
): void {
  if (binding.platform !== platform) {
    throw new CuaDriverPlatformBindingError("platform_mismatch", platform);
  }
  if (typeof binding.platformIdentityVerifier?.verify !== "function"
    || typeof binding.readinessController?.check !== "function"
    || typeof binding.readinessController?.invalidate !== "function"
    || typeof binding.processLifecycle?.spawn !== "function"
    || typeof binding.processLifecycle?.terminate !== "function") {
    throw new CuaDriverPlatformBindingError("dependency_invalid", platform);
  }
  if (platform === "darwin") {
    if (binding.processLifecycle.lifetimeBoundary !== "darwin-direct-child"
      || binding.stateRootProtector !== undefined
      || binding.windowsSessionRecoveryObserver !== undefined) {
      throw new CuaDriverPlatformBindingError("dependency_invalid", platform);
    }
  } else if (binding.processLifecycle.lifetimeBoundary !== "windows-job-object"
    || typeof binding.stateRootProtector?.protect !== "function"
    || typeof binding.windowsSessionRecoveryObserver?.subscribe !== "function") {
    throw new CuaDriverPlatformBindingError("dependency_invalid", platform);
  }
  const availability: unknown = binding.availability;
  if (!availability || typeof availability !== "object" || !("status" in availability)) {
    throw new CuaDriverPlatformBindingError("availability_invalid", platform);
  }
  const status = (availability as { readonly status?: unknown }).status;
  if (status === "available") {
    return;
  }
  const reason = (availability as { readonly reason?: unknown }).reason;
  if (status !== "unavailable" || typeof reason !== "string" || reason.length === 0 || reason !== reason.trim()) {
    throw new CuaDriverPlatformBindingError("availability_invalid", platform);
  }
}

function failClosedProcessLifecycle(platform: "darwin"): DarwinCuaDriverProcessLifecycle;
function failClosedProcessLifecycle(platform: "win32"): Win32CuaDriverProcessLifecycle;
function failClosedProcessLifecycle(
  platform: BundledCuaDriverPlatform,
): CuaDriverProviderProcessLifecycle {
  return Object.freeze({
    lifetimeBoundary: platform === "win32" ? "windows-job-object" : "darwin-direct-child",
    spawn() {
      throw new CuaDriverPlatformBindingError("adapter_not_installed", platform);
    },
    async terminate() {
      // A fail-closed placeholder cannot have spawned a child.
    },
  });
}

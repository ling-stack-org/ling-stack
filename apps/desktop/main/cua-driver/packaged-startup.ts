import type { CuaDriverFeatureFlags } from "@ling-stack/contracts";
import { resolveDesktopCuaDriverFeatureFlags } from "./feature-gates.js";
import {
  loadDesktopCuaDriverPackageAuthority,
  packagedProviderIntentCapabilities,
  type DesktopCuaDriverPackageAuthorityV1,
} from "./packaged-authority.js";
import { loadDesktopCuaDriverPackagedProviderCapabilities } from "./packaged-capabilities.js";
import {
  loadCuaDriverRuntimeTrustPolicy,
  type CuaDriverRuntimeTrustPolicyV1,
} from "./runtime-trust-policy.js";

export interface DesktopCuaDriverPackagedStartupAuthority {
  readonly authority?: DesktopCuaDriverPackageAuthorityV1;
  readonly featureFlags: CuaDriverFeatureFlags;
  readonly runtimeEligible: boolean;
  readonly policy?: CuaDriverRuntimeTrustPolicyV1;
  readonly failure?: unknown;
}

interface ResolveDesktopCuaDriverPackagedStartupAuthorityOptions {
  readonly packaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly platform: string;
}

interface ResolveDesktopCuaDriverPackagedStartupAuthorityDependencies {
  readonly loadAuthority?: typeof loadDesktopCuaDriverPackageAuthority;
  readonly loadCapabilities?: typeof loadDesktopCuaDriverPackagedProviderCapabilities;
  readonly loadPolicy?: typeof loadCuaDriverRuntimeTrustPolicy;
}

/**
 * Resolve package selection separately from runtime readiness.
 *
 * A provider-bearing package remains bundled-authoritative when its loose
 * replicas are corrupt, so daemon startup can never fall back to PATH or an
 * external CuaDriver.app. Only a fully verified tuple is runtime-eligible.
 */
export async function resolveDesktopCuaDriverPackagedStartupAuthority(
  options: ResolveDesktopCuaDriverPackagedStartupAuthorityOptions,
  dependencies: ResolveDesktopCuaDriverPackagedStartupAuthorityDependencies = {},
): Promise<DesktopCuaDriverPackagedStartupAuthority> {
  if (!options.packaged) {
    return Object.freeze({
      featureFlags: resolveDesktopCuaDriverFeatureFlags(),
      runtimeEligible: false,
    });
  }
  const loadAuthority = dependencies.loadAuthority ?? loadDesktopCuaDriverPackageAuthority;
  const loadCapabilities = dependencies.loadCapabilities
    ?? loadDesktopCuaDriverPackagedProviderCapabilities;
  const loadPolicy = dependencies.loadPolicy ?? loadCuaDriverRuntimeTrustPolicy;

  let authority: DesktopCuaDriverPackageAuthorityV1;
  try {
    authority = await loadAuthority(options.appPath);
  } catch (failure) {
    return corruptPackagedAuthority(options.platform, failure);
  }
  if (!authority.providerExpected) {
    return Object.freeze({
      authority,
      featureFlags: resolveDesktopCuaDriverFeatureFlags(),
      runtimeEligible: false,
    });
  }

  const intentCapabilities = packagedProviderIntentCapabilities(authority);
  const featureFlags = resolveDesktopCuaDriverFeatureFlags({
    packagedProvider: intentCapabilities,
    daemonRuntime: {
      darwin: intentCapabilities.darwin,
      win32: intentCapabilities.win32,
    },
  });
  const expectedPlatform = options.platform === "darwin"
    ? "darwin"
    : options.platform === "win32"
      ? "win32"
      : undefined;
  if (!expectedPlatform || authority.platform !== expectedPlatform) {
    return corruptPackagedAuthority(
      options.platform,
      new Error("cua_driver_package_authority_platform_mismatch"),
      authority,
    );
  }

  try {
    const capabilities = await loadCapabilities(options.resourcesPath, { authority });
    const policy = await loadPolicy({
      resourcesPath: options.resourcesPath,
      platform: expectedPlatform,
      authority,
    });
    if (
      capabilities.darwin !== intentCapabilities.darwin
      || capabilities.win32 !== intentCapabilities.win32
    ) {
      throw new Error("cua_driver_package_capability_intent_mismatch");
    }
    return Object.freeze({ authority, featureFlags, policy, runtimeEligible: true });
  } catch (failure) {
    return Object.freeze({ authority, featureFlags, runtimeEligible: false, failure });
  }
}

function corruptPackagedAuthority(
  platform: string,
  failure: unknown,
  authority?: DesktopCuaDriverPackageAuthorityV1,
): DesktopCuaDriverPackagedStartupAuthority {
  const currentPlatformIntent = Object.freeze({
    schemaVersion: 1 as const,
    resourcesValidated: true as const,
    darwin: platform === "darwin",
    win32: platform === "win32",
  });
  return Object.freeze({
    ...(authority ? { authority } : {}),
    featureFlags: resolveDesktopCuaDriverFeatureFlags({
      packagedProvider: currentPlatformIntent,
      daemonRuntime: {
        darwin: currentPlatformIntent.darwin,
        win32: currentPlatformIntent.win32,
      },
    }),
    runtimeEligible: false,
    failure,
  });
}

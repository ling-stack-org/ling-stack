import {
  DEFAULT_CUA_DRIVER_FEATURE_FLAGS,
  isBundledEmbeddedCuaDriverEnabled,
  type CuaDriverFeatureFlags,
} from "@ling-stack/contracts";

/**
 * Build/package output consumed by Desktop after provider resource assertions.
 * Slice 0 ships no validated provider payload, so the default is fail-closed.
 */
export interface DesktopCuaDriverPackagedProviderCapabilitiesV1 {
  readonly schemaVersion: 1;
  readonly resourcesValidated: true;
  readonly darwin: boolean;
  readonly win32: boolean;
}

export const DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES = Object.freeze({
  schemaVersion: 1 as const,
  resourcesValidated: true as const,
  darwin: false,
  win32: false,
});

export function resolveDesktopCuaDriverFeatureFlags(input: {
  readonly packagedProvider?: DesktopCuaDriverPackagedProviderCapabilitiesV1;
  readonly daemonRuntime?: {
    readonly darwin?: boolean;
    readonly win32?: boolean;
  };
} = {}): CuaDriverFeatureFlags {
  const packagedProvider = input.packagedProvider
    ?? DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES;
  return {
    bundledEmbedded: {
      darwin: input.daemonRuntime?.darwin === true,
      win32: input.daemonRuntime?.win32 === true,
    },
    packagedProvider: {
      darwin: packagedProvider.resourcesValidated && packagedProvider.darwin,
      win32: packagedProvider.resourcesValidated && packagedProvider.win32,
    },
  };
}

export function desktopBundledCuaDriverGateEnabled(
  flags: CuaDriverFeatureFlags = DEFAULT_CUA_DRIVER_FEATURE_FLAGS,
  platform: string = process.platform,
): boolean {
  return isBundledEmbeddedCuaDriverEnabled(flags, platform);
}

/**
 * Environment passed only to the Desktop-owned daemon child. A daemon-side
 * opt-in without the corresponding Desktop package assertion remains inert.
 */
export function desktopCuaDriverDaemonFeatureEnvironment(
  flags: CuaDriverFeatureFlags,
): Readonly<Record<string, "0" | "1">> {
  const packagedProvider = flags.packagedProvider ?? { darwin: false, win32: false };
  return {
    LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_DARWIN: booleanEnv(flags.bundledEmbedded.darwin),
    LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_WIN32: booleanEnv(flags.bundledEmbedded.win32),
    LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_DARWIN: booleanEnv(packagedProvider.darwin),
    LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_WIN32: booleanEnv(packagedProvider.win32),
  };
}

function booleanEnv(value: boolean): "0" | "1" {
  return value ? "1" : "0";
}

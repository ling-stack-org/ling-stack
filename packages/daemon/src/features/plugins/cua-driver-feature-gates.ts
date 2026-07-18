import type {
  BundledCuaDriverPlatform,
  CuaDriverDistribution,
  CuaDriverFeatureFlags,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";

export function cuaDriverFeatureFlagsFromConfig(
  config: Pick<ResolvedDaemonConfig, "cuaDriver">,
): CuaDriverFeatureFlags {
  return {
    bundledEmbedded: {
      darwin: config.cuaDriver.bundledEmbedded.darwin,
      win32: config.cuaDriver.bundledEmbedded.win32,
    },
    packagedProvider: {
      darwin: config.cuaDriver.packagedProvider.darwin,
      win32: config.cuaDriver.packagedProvider.win32,
    },
  };
}

export function bundledEmbeddedCuaDriverGateEnabled(
  config: Pick<ResolvedDaemonConfig, "cuaDriver">,
  platform: NodeJS.Platform | BundledCuaDriverPlatform = process.platform,
): boolean {
  if (platform === "darwin") {
    return config.cuaDriver.bundledEmbedded.darwin
      && config.cuaDriver.packagedProvider.darwin;
  }
  if (platform === "win32") {
    return config.cuaDriver.bundledEmbedded.win32
      && config.cuaDriver.packagedProvider.win32;
  }
  return false;
}

export function resolveCuaDriverDistribution(
  config: Pick<ResolvedDaemonConfig, "cuaDriver">,
  platform: NodeJS.Platform | BundledCuaDriverPlatform = process.platform,
): CuaDriverDistribution {
  return bundledEmbeddedCuaDriverGateEnabled(config, platform)
    ? "bundled_embedded"
    : "external_local";
}

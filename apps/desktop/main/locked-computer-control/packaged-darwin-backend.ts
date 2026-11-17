import type {
  LockedComputerControlCapabilityV1,
  LockedComputerControlPolicyV1,
} from "@ling-stack/contracts";
import { release } from "node:os";
import {
  LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS,
  LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS_SHA256,
  LOCKED_COMPUTER_CONTROL_TOOL_POLICY_REVISION,
} from "@ling-stack/contracts";
import {
  createInstalledDarwinLockedUseClientFactory,
  type LockedUseInstalledProfile,
} from "./installed-native-client.js";
import type { DesktopLockedUseBackend } from "./runtime-composition.js";
import {
  parseLockedControlNativeStatusResponse,
  type LockedControlNativeStatusResponse,
} from "./native-helper-bridge.js";
import type {
  CuaDriverCoordinatorSnapshot,
} from "../cua-driver/coordinator.js";

/**
 * Build the only Desktop backend that can publish a positive Darwin capability.
 * The release composition supplies the manifest digest out of band; an
 * installed file cannot nominate itself as the accepted build.
 */
export type InstalledDarwinLockedUseClientFactory = ReturnType<typeof createInstalledDarwinLockedUseClientFactory>;

export async function loadInstalledDarwinLockedUseBackend(options: {
  readonly expectedTeamId: string;
  readonly expectedBuildManifestSha256: string;
  readonly expectedProfile?: LockedUseInstalledProfile;
  readonly createFactory?: (input: {
    readonly expectedTeamId: string;
    readonly expectedBuildManifestSha256: string;
    readonly expectedProfile?: LockedUseInstalledProfile;
  }) => InstalledDarwinLockedUseClientFactory;
  readonly readStatus?: (factory: InstalledDarwinLockedUseClientFactory) => Promise<LockedControlNativeStatusResponse>;
}): Promise<DesktopLockedUseBackend | undefined> {
  const createFactory = options.createFactory ?? ((input) => createInstalledDarwinLockedUseClientFactory(input));
  const factory = createFactory({
    expectedTeamId: options.expectedTeamId,
    expectedBuildManifestSha256: options.expectedBuildManifestSha256,
    ...(options.expectedProfile ? { expectedProfile: options.expectedProfile } : {}),
  });
  const status = await (options.readStatus ?? defaultReadStatus)(factory);
  if (!parseLockedControlNativeStatusResponse(status) || status.productCapability !== "supported_restricted") return undefined;
  const policy: LockedComputerControlPolicyV1 = Object.freeze({
    schemaVersion: 1,
    mode: "task_grant_required",
    maxGrantTtlSeconds: 900,
    requireLocalUserVerification: true,
    consumeOnUnlock: true,
    suspendRevokes: true,
    lockedToolPolicyRevision: LOCKED_COMPUTER_CONTROL_TOOL_POLICY_REVISION,
    allowedLockedToolIdsSha256: LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS_SHA256,
  });
  const capability: LockedComputerControlCapabilityV1 = Object.freeze({
    schemaVersion: 1,
    platform: "darwin",
    state: "supported_restricted",
    canCaptureSameUserDesktopWhileLocked: status.captureReady,
    canInjectSameUserDesktopWhileLocked: status.inputReady,
    canProveSessionContinuity: true,
    secureSurfaceExcluded: status.secureSurfaceExcluded,
    adapterVersion: "darwin-locked-use-installed-v1",
    osVersion: release(),
    observedAt: new Date().toISOString(),
  });
  return Object.freeze({
    capability,
    policy,
    allowedToolIds: LOCKED_COMPUTER_CONTROL_ALLOWED_TOOL_IDS,
    createClient: (onRevoked: () => void) => factory.createClient(onRevoked),
    async verifyTargetReadiness(input: {
      readonly generation: number;
      readonly sessionBindingDigest: string;
      readonly providerSnapshot?: CuaDriverCoordinatorSnapshot;
      readonly nativeStatus?: LockedControlNativeStatusResponse;
    }) {
      const provider = input.providerSnapshot;
      const native = input.nativeStatus;
      const permissions = provider?.permissions;
      const providerReady = provider?.lifecycle === "active"
        && provider.generation === input.generation
        && Number.isSafeInteger(provider.pid) && provider.pid! > 0
        && provider.providerState === "ready"
        && permissions?.accessibility === "granted"
        && permissions.screenRecording === "granted"
        && permissions.capturable === true;
      const ready = providerReady && !!parseLockedControlNativeStatusResponse(native)
        && native?.productCapability === "supported_restricted";
      return { userDesktopTargeted: ready, captureReady: ready, inputReady: ready, secureSurfaceExcluded: ready };
    },
  });
}

async function defaultReadStatus(
  factory: InstalledDarwinLockedUseClientFactory,
): Promise<LockedControlNativeStatusResponse> {
  const client = factory.createClient(() => undefined);
  try {
    if (typeof client.readStatus !== "function") return unavailableStatus();
    return await client.readStatus(new AbortController().signal);
  } finally {
    client.close();
  }
}

function unavailableStatus(): LockedControlNativeStatusResponse {
  return {
    platform: "darwin",
    productCapability: "probe_required",
    available: false,
    captureReady: false,
    inputReady: false,
    secureSurfaceExcluded: false,
  };
}

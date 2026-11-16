import { release } from "node:os";
import { createHash } from "node:crypto";
import {
  DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES,
  isLockedComputerControlCapabilityV1,
  isLockedComputerControlPolicyV1,
  type LockedComputerControlCapabilityV1,
  type LockedComputerControlPolicyV1,
} from "@ling-stack/contracts";
import type { DesktopRuntimeCuaDriverCoordinator } from "../desktop-runtime.js";
import type { DesktopDaemonCuaDriverAuthorityTuple } from "../daemon-lifecycle.js";
import type { CuaDriverCoordinatorOptions } from "../cua-driver/coordinator.js";
import { RestrictedCuaDriverGeneration } from "../cua-driver/restricted-generation.js";
import { createLockedControlCapabilityAttestor } from "./capability-attestor.js";
import { createLockedControlDaemonClient } from "./daemon-client.js";
import type { DarwinLockedUseNativeClient } from "./darwin-locked-use-client.js";
import { createLockedControlIdentityVerifier } from "./identity-verifier.js";
import { LockedComputerControlPolicyCoordinator, type LockedControlPolicyCoordinatorSnapshot } from "./policy-coordinator.js";
import type { LockedControlNativeSessionResponse } from "./native-helper-bridge.js";

/** Supplied only by a packaged composition after exact-build native acceptance. */
export interface DesktopLockedUseBackend {
  readonly capability: LockedComputerControlCapabilityV1;
  readonly policy: LockedComputerControlPolicyV1;
  readonly allowedToolIds: readonly string[];
  readonly createClient: (onRevoked: () => void) => Pick<DarwinLockedUseNativeClient,
    "readSession" | "verifyIdentity" | "begin" | "check" | "beginAction" | "finishAction" | "end" | "ownsManagedSession">;
  readonly verifyTargetReadiness: (input: { readonly generation: number; readonly sessionBindingDigest: string }) => Promise<{
    readonly userDesktopTargeted: boolean;
    readonly captureReady: boolean;
    readonly inputReady: boolean;
    readonly secureSurfaceExcluded: boolean;
  }>;
}

export function composeLockedControlRuntime(options: {
  readonly platform: "darwin" | "win32";
  readonly desktopInstanceId: string;
  readonly authority: DesktopDaemonCuaDriverAuthorityTuple;
  readonly daemonBaseUrl: string;
  readonly bridgeToken: string;
  readonly daemonClient?: ReturnType<typeof createLockedControlDaemonClient>;
  readonly coordinator: DesktopRuntimeCuaDriverCoordinator;
  readonly createRestrictedCoordinator: (input: Pick<CuaDriverCoordinatorOptions, "generationFloor" | "actionGate">) => DesktopRuntimeCuaDriverCoordinator;
  readonly backend?: DesktopLockedUseBackend;
  readonly isCurrent: () => boolean;
  readonly resumeNormal: () => Promise<void>;
  readonly onStateChanged: (snapshot: LockedControlPolicyCoordinatorSnapshot) => void;
  readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
}) {
  const source = options.platform === "darwin" ? options.backend : undefined;
  const backend = source && Object.freeze({
    ...source, capability: Object.freeze({ ...source.capability }),
    policy: Object.freeze({ ...source.policy }), allowedToolIds: Object.freeze([...source.allowedToolIds]),
  });
  if (backend && (!isLockedComputerControlPolicyV1(backend.policy)
    || backend.policy.mode !== "task_grant_required" || backend.allowedToolIds.length === 0
    || new Set(backend.allowedToolIds).size !== backend.allowedToolIds.length
    || backend.allowedToolIds.some((id) => typeof id !== "string" || !id || id.length > 256 || id.trim() !== id)
    || createHash("sha256").update(JSON.stringify(backend.allowedToolIds)).digest("hex") !== backend.policy.allowedLockedToolIdsSha256)) {
    throw new Error("locked_control_policy_invalid");
  }
  const capability: LockedComputerControlCapabilityV1 = backend?.capability ?? Object.freeze({
    schemaVersion: 1, platform: options.platform, state: "disabled_by_build",
    reason: "locked_control_disabled_by_build", canCaptureSameUserDesktopWhileLocked: false,
    canInjectSameUserDesktopWhileLocked: false, canProveSessionContinuity: false,
    secureSurfaceExcluded: false, adapterVersion: `${options.platform}-locked-control-disabled-v1`,
    osVersion: release(), observedAt: new Date().toISOString(),
  });
  if (!isLockedComputerControlCapabilityV1(capability) || capability.platform !== options.platform) {
    throw new Error("locked_control_capability_invalid");
  }
  const daemon = options.daemonClient ?? createLockedControlDaemonClient({
    daemonBaseUrl: options.daemonBaseUrl, workspaceCwd: options.authority.workspaceCwd, bridgeToken: options.bridgeToken,
  });
  let policy: LockedComputerControlPolicyCoordinator;
  let client: ReturnType<DesktopLockedUseBackend["createClient"]> | undefined;
  let session: LockedControlNativeSessionResponse | undefined;
  let launcher: RestrictedCuaDriverGeneration | undefined;
  let preparedGeneration: number | undefined;
  const readAuthority = () => {
    if (!options.isCurrent()) throw new Error("locked_control_authority_rotated");
    return {
      ...options.authority, platform: options.platform, desktopInstanceId: options.desktopInstanceId,
      normalGeneration: options.coordinator.snapshot?.generation ?? 0,
      lockEpoch: policy?.snapshot().lockEpoch ?? 0,
      ...(session ? { sessionBindingDigest: session.sessionBindingDigest } : {}),
    };
  };
  const identityVerifier = createLockedControlIdentityVerifier({
    platform: options.platform,
    localizedReason: "Authorize Ling to control this computer for the current task",
    nativeBridge: {
      verifyIdentity: async (request) => {
        if (!client || !options.isCurrent()) throw new Error("locked_control_identity_unavailable");
        return client.verifyIdentity(request);
      },
    },
    readContext: async () => {
      if (!client || !options.isCurrent()) throw new Error("locked_control_authority_rotated");
      const task = await daemon.currentTask(options.authority);
      const current = await client.readSession(new AbortController().signal);
      if (!options.isCurrent()) throw new Error("locked_control_authority_rotated");
      session = current;
      const authority = readAuthority();
      return {
        ...authority, providerGeneration: authority.normalGeneration,
        sessionBindingDigest: session.sessionBindingDigest,
        sessionActive: session.sessionActive, sessionLocked: session.sessionLocked,
        ...(task ?? {}),
      };
    },
  });
  policy = new LockedComputerControlPolicyCoordinator({
    policy: backend?.policy ?? DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES[options.platform],
    capability: () => capability,
    daemon,
    identityVerifier,
    attestor: createLockedControlCapabilityAttestor({
      nativeBridge: {
        attestLockedSession: async (request) => {
          if (!backend || !client || preparedGeneration !== request.providerGeneration || !options.isCurrent()) {
            throw new Error("locked_control_probe_required");
          }
          await client.check(request.signal);
          const current = await client.readSession(request.signal);
          const facts = await backend.verifyTargetReadiness({
            generation: request.providerGeneration, sessionBindingDigest: current.sessionBindingDigest,
          });
          await client.check(request.signal);
          if (!options.isCurrent() || preparedGeneration !== request.providerGeneration) {
            throw new Error("locked_control_authority_rotated");
          }
          return {
            platform: "darwin", sessionBindingDigest: current.sessionBindingDigest,
            lockEpoch: request.lockEpoch, providerGeneration: request.providerGeneration,
            sameUserSession: current.sessionActive && !current.sessionLocked
              && current.sessionBindingDigest === request.expectedSessionBindingDigest,
            ...facts,
          };
        },
      },
    }),
    runtime: {
      readAuthority,
      closeCallGate(reason) {
        options.coordinator.closeCallGateForSecurityBoundary?.(reason);
        launcher?.closeCallGate(reason);
      },
      async retireNormalForLock(reason) {
        if (!options.isCurrent() || !options.coordinator.suspendForSystem) throw new Error("locked_control_runtime_unavailable");
        await options.coordinator.suspendForSystem(reason === "locked_control_suspend" ? "system_suspend" : "system_lock");
      },
      reserveLockedGeneration() {
        if (!backend || !client || !options.coordinator.advanceGenerationFloor || launcher) throw new Error("locked_control_disabled_by_build");
        launcher = new RestrictedCuaDriverGeneration({
          currentGeneration: () => options.coordinator.snapshot?.generation ?? 0,
          advanceNormalGenerationFloor: (generation) => options.coordinator.advanceGenerationFloor!(generation),
          createCoordinator: options.createRestrictedCoordinator,
          native: client,
          allowedToolIds: backend.allowedToolIds,
          isAuthorityCurrent: (grant) => options.isCurrent()
            && grant.desktopInstanceId === options.desktopInstanceId
            && grant.desktopInstanceEpoch === options.authority.desktopInstanceEpoch
            && grant.daemonAuthorityEpoch === options.authority.daemonAuthorityEpoch
            && grant.bridgeConnectionId === options.authority.bridgeConnectionId
            && grant.osSessionBindingDigest === session?.sessionBindingDigest,
        });
        return launcher.reserve();
      },
      async prepareLockedGeneration(input) {
        if (!client) throw new Error("locked_control_disabled_by_build");
        await client.begin(input.grant, input.generation, new AbortController().signal);
        preparedGeneration = input.generation;
      },
      async startLockedGeneration(input) {
        if (!launcher) throw new Error("locked_control_disabled_by_build");
        await launcher.start(input);
      },
      async stopLockedGeneration(reason) {
        if (launcher) { await launcher.stop(reason); launcher = undefined; }
        else if (client) { await client.end(); }
        client = undefined; preparedGeneration = undefined;
      },
      async resumeNormal() {
        if (client || launcher) throw new Error("locked_control_cleanup_unconfirmed");
        await options.resumeNormal();
      },
    },
    onStateChanged: options.onStateChanged,
  });
  void daemon.publishCapability({ authority: options.authority, capability, buildId: "ling-desktop-locked-control-v1" })
    .catch((error) => options.onDiagnostic?.("desktop_runtime.locked_control_capability_publish_failed", {
      error: error instanceof Error ? error.message : String(error),
    }));
  return Object.freeze({
    coordinator: policy,
    closeCallGate: (reason: string) => {
      options.coordinator.closeCallGateForSecurityBoundary?.(reason);
      launcher?.closeCallGate(reason);
    },
    ownsManagedSession: () => client?.ownsManagedSession === true,
    async authorize() {
      if (!backend || capability.state !== "supported_restricted") return { accepted: false, reason: capability.reason ?? "locked_control_probe_required" };
      if (policy.snapshot().phase !== "off" || client || launcher) return { accepted: false, reason: "locked_control_commit_unconfirmed" };
      client = backend.createClient(() => {
        // Native loss closes provider admission synchronously before the queue.
        options.coordinator.closeCallGateForSecurityBoundary?.("locked_control_authority_rotated");
        launcher?.closeCallGate("locked_control_authority_rotated");
        void policy.handleAuthorityRotated().catch((error) => options.onDiagnostic?.("desktop_runtime.locked_control_cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      try {
        session = await client.readSession(new AbortController().signal);
        const result = await policy.authorizeCurrentTask();
        if (!result.accepted && client) { await client.end(); client = undefined; }
        return result;
      } catch {
        await policy.handleAuthorityRotated();
        return { accepted: false, reason: "locked_control_identity_unavailable" };
      }
    },
  });
}

import type {
  BundledCuaDriverPlatform,
  CuaDriverDesktopAvailabilityState,
  CuaDriverIntegrityCoverage,
  CuaDriverIntegrityStatus,
  CuaDriverLimitation,
  CuaDriverPermissionSnapshot,
  CuaDriverWindowsReadinessSnapshot,
  DesktopCuaDriverAvailabilityV1,
} from "@ling-stack/contracts";
import { isDesktopCuaDriverAvailabilityV1 } from "@ling-stack/contracts";
import type { CuaDriverCoordinatorSnapshot } from "./coordinator.js";
import { consumeBoundedResponseBody } from "./http-response.js";
import { CUA_DRIVER_BRIDGE_TOKEN_HEADER } from "./lease-publisher.js";

export const CUA_DRIVER_AVAILABILITY_ROUTE =
  "/desktop/capabilities/cua-driver/availability" as const;

export class CuaDriverAvailabilityPublisherError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "CuaDriverAvailabilityPublisherError";
  }
}

export interface CuaDriverAvailabilityClient {
  publish(availability: DesktopCuaDriverAvailabilityV1, signal?: AbortSignal): Promise<void>;
}

export interface CuaDriverAvailabilityAuthority {
  readonly desktopInstanceId: string;
  readonly desktopInstanceEpoch: number;
  readonly bridgeConnectionId: string;
  readonly daemonAuthorityEpoch: string;
  readonly workspaceCwd: string;
  readonly platform: Exclude<BundledCuaDriverPlatform, "unsupported">;
  readonly readinessDetailsV1: boolean;
  readonly integrityCoverage?: CuaDriverIntegrityCoverage;
  readonly limitations?: readonly CuaDriverLimitation[];
}

export class HttpCuaDriverAvailabilityClient implements CuaDriverAvailabilityClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: {
    readonly daemonBaseUrl: string;
    readonly bridgeToken: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  }) {
    const url = new URL(options.daemonBaseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) {
      throw new CuaDriverAvailabilityPublisherError("availability_daemon_must_be_loopback");
    }
    if (!options.bridgeToken) {
      throw new CuaDriverAvailabilityPublisherError("availability_bridge_token_missing");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async publish(
    availability: DesktopCuaDriverAvailabilityV1,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isDesktopCuaDriverAvailabilityV1(availability)) {
      throw new CuaDriverAvailabilityPublisherError("availability_contract_invalid");
    }
    const url = new URL(
      CUA_DRIVER_AVAILABILITY_ROUTE,
      ensureTrailingSlash(this.options.daemonBaseUrl),
    );
    url.searchParams.set("cwd", availability.workspaceCwd);
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 3_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [CUA_DRIVER_BRIDGE_TOKEN_HEADER]: this.options.bridgeToken,
        },
        body: JSON.stringify(availability),
        redirect: "error",
        signal: combinedSignal,
      });
    } catch {
      throw new CuaDriverAvailabilityPublisherError("availability_daemon_unavailable");
    }
    try {
      await consumeBoundedResponseBody(response);
    } catch {
      throw new CuaDriverAvailabilityPublisherError("availability_response_body_invalid");
    }
    if (!response.ok) {
      throw new CuaDriverAvailabilityPublisherError(`availability_http_${response.status}`);
    }
  }
}

/** Serialize observational state without dispatching queued prior generations. */
export class CuaDriverAvailabilityPublisher {
  private sequence = 0;
  private generationHighWater = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: {
    readonly client: CuaDriverAvailabilityClient;
    readonly authority: CuaDriverAvailabilityAuthority;
    readonly onError?: (error: unknown, report: DesktopCuaDriverAvailabilityV1) => void;
  }) {}

  publish(snapshot: CuaDriverCoordinatorSnapshot): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (snapshot.providerState === "ready") {
      // Ready is never an availability report, but its legal generation still
      // fences observations waiting in the independent publication queue.
      if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) {
        return Promise.reject(new CuaDriverAvailabilityPublisherError("availability_contract_invalid"));
      }
      this.generationHighWater = Math.max(this.generationHighWater, snapshot.generation);
      return Promise.resolve();
    }
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new CuaDriverAvailabilityPublisherError("availability_sequence_exhausted"));
    }
    let report: DesktopCuaDriverAvailabilityV1;
    try {
      report = createAvailabilityReport(
        this.options.authority,
        snapshot,
        this.sequence + 1,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    // Only a fully validated report can advance the fence. Failed candidates
    // must not suppress subsequent legitimate lower-generation observations.
    if (report.generation < this.generationHighWater) return Promise.resolve();
    this.generationHighWater = Math.max(this.generationHighWater, report.generation);
    this.sequence = report.sequence;
    const pending = this.operationTail.catch(() => undefined).then(async () => {
      // A later snapshot may advance the fence while this report is queued.
      // Requests already inside client.publish cannot be recalled here.
      if (report.generation < this.generationHighWater) return;
      try {
        await this.options.client.publish(report);
      } catch (error) {
        try {
          this.options.onError?.(error, report);
        } catch {
          // Diagnostics cannot make an unavailable provider executable.
        }
        throw error;
      }
    });
    this.operationTail = pending;
    return pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.operationTail.catch(() => undefined);
  }
}

export function createAvailabilityReport(
  authority: CuaDriverAvailabilityAuthority,
  snapshot: CuaDriverCoordinatorSnapshot,
  sequence: number,
): DesktopCuaDriverAvailabilityV1 {
  if (snapshot.providerState === "ready") {
    throw new CuaDriverAvailabilityPublisherError("availability_ready_forbidden");
  }
  const report: DesktopCuaDriverAvailabilityV1 = {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: authority.desktopInstanceId,
    desktopInstanceEpoch: authority.desktopInstanceEpoch,
    bridgeConnectionId: authority.bridgeConnectionId,
    daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
    workspaceCwd: authority.workspaceCwd,
    generation: snapshot.generation,
    sequence,
    platform: authority.platform,
    providerState: availabilityState(snapshot.providerState),
    ...(normalizeReason(snapshot.reason) ? { reason: normalizeReason(snapshot.reason) } : {}),
    ...(authority.integrityCoverage
      ? { integrityCoverage: authority.integrityCoverage }
      : {}),
    ...(authority.readinessDetailsV1 && snapshot.integrity
      ? { integrity: snapshot.integrity satisfies CuaDriverIntegrityStatus }
      : {}),
    ...(authority.readinessDetailsV1 && snapshot.permissions
      ? { permissions: snapshot.permissions satisfies CuaDriverPermissionSnapshot }
      : {}),
    ...(authority.readinessDetailsV1 && snapshot.windowsReadiness
      ? { windowsReadiness: snapshot.windowsReadiness satisfies CuaDriverWindowsReadinessSnapshot }
      : {}),
    ...(authority.limitations
      ? { limitations: Object.freeze([...authority.limitations]) }
      : {}),
  };
  if (!isDesktopCuaDriverAvailabilityV1(report)) {
    throw new CuaDriverAvailabilityPublisherError("availability_contract_invalid");
  }
  return Object.freeze(report);
}

function availabilityState(
  state: CuaDriverCoordinatorSnapshot["providerState"],
): CuaDriverDesktopAvailabilityState {
  if (
    state === "included"
    || state === "permission_required"
    || state === "interactive_session_required"
    || state === "platform_unavailable"
    || state === "incompatible"
    || state === "corrupt"
    || state === "desktop_unavailable"
  ) {
    return state;
  }
  throw new CuaDriverAvailabilityPublisherError("availability_state_invalid");
}

function normalizeReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  return /^[a-z0-9_.:-]{1,256}$/u.test(reason) ? reason : "availability_reason_redacted";
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname === "localhost";
}

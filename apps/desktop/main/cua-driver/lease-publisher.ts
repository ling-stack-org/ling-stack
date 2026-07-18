import type {
  DesktopCuaDriverLeaseRevokeV1,
  DesktopCuaDriverLeaseV1,
} from "@ling-stack/contracts";
import { isDesktopCuaDriverLeaseV1 } from "@ling-stack/contracts";
import type { CuaDriverTelemetrySink } from "./telemetry.js";
import { createCuaDriverTelemetry } from "./telemetry.js";

export const CUA_DRIVER_LEASE_ROUTE = "/desktop/capabilities/cua-driver/lease" as const;
export const CUA_DRIVER_BRIDGE_TOKEN_HEADER = "X-Ling-Desktop-Bridge-Token" as const;

export class CuaDriverLeasePublisherError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "CuaDriverLeasePublisherError";
  }
}

export interface CuaDriverLeaseClient {
  publish(lease: DesktopCuaDriverLeaseV1, signal?: AbortSignal): Promise<void>;
  revoke(revoke: DesktopCuaDriverLeaseRevokeV1, signal?: AbortSignal): Promise<void>;
}

export interface HttpCuaDriverLeaseClientOptions {
  readonly daemonBaseUrl: string;
  readonly bridgeToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Future PR5 implements the daemon route; this client freezes the Desktop wire side now. */
export class HttpCuaDriverLeaseClient implements CuaDriverLeaseClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpCuaDriverLeaseClientOptions) {
    const url = new URL(options.daemonBaseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) {
      throw new CuaDriverLeasePublisherError("lease_daemon_must_be_loopback");
    }
    if (!options.bridgeToken) {
      throw new CuaDriverLeasePublisherError("lease_bridge_token_missing");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async publish(lease: DesktopCuaDriverLeaseV1, signal?: AbortSignal): Promise<void> {
    if (!isDesktopCuaDriverLeaseV1(lease)) {
      throw new CuaDriverLeasePublisherError("lease_contract_invalid");
    }
    const url = new URL(CUA_DRIVER_LEASE_ROUTE, ensureTrailingSlash(this.options.daemonBaseUrl));
    url.searchParams.set("cwd", lease.workspaceCwd);
    await this.request(url, "PUT", lease, signal);
  }

  async revoke(revoke: DesktopCuaDriverLeaseRevokeV1, signal?: AbortSignal): Promise<void> {
    assertRevoke(revoke);
    const path = `${CUA_DRIVER_LEASE_ROUTE}/${encodeURIComponent(String(revoke.desktopInstanceEpoch))}/${encodeURIComponent(String(revoke.generation))}`;
    const url = new URL(path, ensureTrailingSlash(this.options.daemonBaseUrl));
    url.searchParams.set("cwd", revoke.workspaceCwd);
    await this.request(url, "DELETE", revoke, signal);
  }

  private async request(
    url: URL,
    method: "PUT" | "DELETE",
    body: DesktopCuaDriverLeaseV1 | DesktopCuaDriverLeaseRevokeV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 3_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          "content-type": "application/json",
          [CUA_DRIVER_BRIDGE_TOKEN_HEADER]: this.options.bridgeToken,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch {
      throw new CuaDriverLeasePublisherError("lease_daemon_unavailable");
    }
    if (!response.ok) {
      throw new CuaDriverLeasePublisherError(`lease_http_${response.status}`);
    }
  }
}

export interface CuaDriverLeasePublisherOptions {
  readonly client: CuaDriverLeaseClient;
  readonly lease: Omit<DesktopCuaDriverLeaseV1, "expiresAt">;
  readonly ttlMs?: number;
  readonly renewIntervalMs?: number;
  readonly clock?: () => Date;
  readonly telemetry?: CuaDriverTelemetrySink;
  readonly onLeaseLost?: (error: unknown) => void;
}

export class CuaDriverLeasePublisher {
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly clock: () => Date;
  private readonly telemetry: CuaDriverTelemetrySink;
  private timer: NodeJS.Timeout | undefined;
  private publishPromise: Promise<DesktopCuaDriverLeaseV1> | undefined;
  private revokePromise: Promise<void> | undefined;
  private active = false;
  private closed = false;
  private abortController = new AbortController();
  private lastLeaseValue: DesktopCuaDriverLeaseV1 | undefined;
  private operationEpoch = 0;

  constructor(private readonly options: CuaDriverLeasePublisherOptions) {
    this.ttlMs = boundedPositive(options.ttlMs, 15_000, 120_000);
    this.renewIntervalMs = boundedPositive(options.renewIntervalMs, Math.max(1_000, Math.floor(this.ttlMs / 3)), this.ttlMs - 1);
    if (this.renewIntervalMs >= this.ttlMs) {
      throw new CuaDriverLeasePublisherError("lease_renew_interval_invalid");
    }
    this.clock = options.clock ?? (() => new Date());
    this.telemetry = options.telemetry ?? createCuaDriverTelemetry();
  }

  get lastLease(): DesktopCuaDriverLeaseV1 | undefined {
    return this.lastLeaseValue;
  }

  publish(): Promise<DesktopCuaDriverLeaseV1> {
    if (this.closed) {
      return Promise.reject(new CuaDriverLeasePublisherError("lease_publisher_closed"));
    }
    if (this.publishPromise) {
      return this.publishPromise;
    }
    const epoch = this.operationEpoch;
    const pending = this.publishOnce(epoch);
    this.publishPromise = pending;
    void pending.finally(() => {
      if (this.publishPromise === pending) {
        this.publishPromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  revoke(): Promise<void> {
    if (this.revokePromise) {
      return this.revokePromise;
    }
    const pending = this.revokeInternal();
    this.revokePromise = pending;
    void pending.catch(() => {
      if (this.revokePromise === pending) {
        this.revokePromise = undefined;
      }
    });
    return pending;
  }

  private async publishOnce(epoch: number): Promise<DesktopCuaDriverLeaseV1> {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) {
      throw new CuaDriverLeasePublisherError("lease_clock_invalid");
    }
    const lease: DesktopCuaDriverLeaseV1 = {
      ...this.options.lease,
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    if (!isDesktopCuaDriverLeaseV1(lease)) {
      throw new CuaDriverLeasePublisherError("lease_contract_invalid");
    }
    try {
      await this.options.client.publish(lease, this.abortController.signal);
      if (this.closed || epoch !== this.operationEpoch) {
        throw new CuaDriverLeasePublisherError("lease_publish_superseded");
      }
    } catch (error) {
      this.active = false;
      this.clearTimer();
      this.telemetry.emit("error", "cua_driver.lease.publish_failed", {
        generation: lease.generation,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!this.closed && epoch === this.operationEpoch) {
        try {
          this.options.onLeaseLost?.(error);
        } catch {
          // A lease-loss observer cannot make a stale lease current again.
        }
      }
      throw error;
    }
    this.active = true;
    this.lastLeaseValue = lease;
    this.scheduleRenewal();
    this.telemetry.emit("info", "cua_driver.lease.published", { generation: lease.generation, expiresAt: lease.expiresAt });
    return lease;
  }

  private scheduleRenewal(): void {
    this.clearTimer();
    if (!this.active || this.closed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publish().catch(() => undefined);
    }, this.renewIntervalMs);
    this.timer.unref?.();
  }

  private async revokeInternal(): Promise<void> {
    this.closed = true;
    this.active = false;
    this.operationEpoch += 1;
    this.clearTimer();
    this.abortController.abort(new CuaDriverLeasePublisherError("lease_revoked"));
    await this.publishPromise?.catch(() => undefined);
    const lease = this.options.lease;
    const revoke: DesktopCuaDriverLeaseRevokeV1 = {
      schemaVersion: 1,
      providerId: "cua-driver",
      desktopInstanceId: lease.desktopInstanceId,
      desktopInstanceEpoch: lease.desktopInstanceEpoch,
      bridgeConnectionId: lease.bridgeConnectionId,
      generation: lease.generation,
      daemonAuthorityEpoch: lease.daemonAuthorityEpoch,
      workspaceCwd: lease.workspaceCwd,
    };
    try {
      // Revoke is best-effort but uses a fresh signal; publisher cancellation must
      // not cancel its own cleanup request.
      await this.options.client.revoke(revoke, AbortSignal.timeout(3_000));
      this.telemetry.emit("info", "cua_driver.lease.revoked", { generation: revoke.generation });
    } finally {
      this.lastLeaseValue = undefined;
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function assertRevoke(value: DesktopCuaDriverLeaseRevokeV1): void {
  if (
    value.schemaVersion !== 1
    || value.providerId !== "cua-driver"
    || !value.desktopInstanceId
    || !Number.isSafeInteger(value.desktopInstanceEpoch)
    || value.desktopInstanceEpoch <= 0
    || !value.bridgeConnectionId
    || !Number.isSafeInteger(value.generation)
    || value.generation <= 0
    || !value.daemonAuthorityEpoch
    || !value.workspaceCwd
  ) {
    throw new CuaDriverLeasePublisherError("lease_revoke_contract_invalid");
  }
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value!, max) : fallback;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost";
}

import {
  parseHostCapabilityBridgeCommandV1,
  type HostCapabilityBridgeAvailabilityV1,
  type HostCapabilityBridgeCommandV1,
  type HostCapabilityBridgeResultV1,
} from "@ling-stack/contracts";

const ROOT = "/desktop/capabilities/host";

export interface HostCapabilityDaemonTransport {
  publishAvailability(value: HostCapabilityBridgeAvailabilityV1, signal?: AbortSignal): Promise<void>;
  claim(signal?: AbortSignal): Promise<HostCapabilityBridgeCommandV1 | undefined>;
  begin(commandId: string, signal?: AbortSignal): Promise<void>;
  complete(result: HostCapabilityBridgeResultV1, signal?: AbortSignal): Promise<void>;
}

export type HostCapabilityDaemonClientErrorCode =
  | "invalid_response"
  | "request_failed"
  | "request_rejected";

export class HostCapabilityDaemonClientError extends Error {
  constructor(
    readonly clientCode: HostCapabilityDaemonClientErrorCode,
    readonly daemonCode?: string,
  ) {
    super(`host_capability_daemon_${clientCode}`);
    this.name = "HostCapabilityDaemonClientError";
  }
}

export class HostCapabilityDaemonClient implements HostCapabilityDaemonTransport {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: {
    readonly daemonBaseUrl: string;
    readonly bridgeToken: string;
    readonly desktopInstanceId: string;
    readonly generation: number;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async publishAvailability(value: HostCapabilityBridgeAvailabilityV1, signal?: AbortSignal): Promise<void> {
    await this.request(`${ROOT}/availability`, value, signal, false);
  }

  async claim(signal?: AbortSignal): Promise<HostCapabilityBridgeCommandV1 | undefined> {
    const value = await this.request(`${ROOT}/commands/claim`, {}, signal, true);
    if (!isRecord(value)) throw new HostCapabilityDaemonClientError("invalid_response");
    if (value.command === undefined) return undefined;
    try {
      return parseHostCapabilityBridgeCommandV1(value.command);
    } catch {
      throw new HostCapabilityDaemonClientError("invalid_response");
    }
  }

  async begin(commandId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`${ROOT}/commands/${encodeURIComponent(commandId)}/begin`, {}, signal, true);
  }

  async complete(result: HostCapabilityBridgeResultV1, signal?: AbortSignal): Promise<void> {
    await this.request(`${ROOT}/commands/${encodeURIComponent(result.id)}/result`, result, signal, true);
  }

  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    withAuthority: boolean,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.options.daemonBaseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ling-desktop-bridge-token": this.options.bridgeToken,
          ...(withAuthority ? {
            "x-ling-host-desktop-instance": this.options.desktopInstanceId,
            "x-ling-host-generation": String(this.options.generation),
          } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new HostCapabilityDaemonClientError("request_failed");
    }
    const value = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      throw new HostCapabilityDaemonClientError(
        "request_rejected",
        isRecord(value) && safeCode(value.error) ? value.error : undefined,
      );
    }
    if (!isRecord(value)) throw new HostCapabilityDaemonClientError("invalid_response");
    return value;
  }
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_:-]{1,96}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

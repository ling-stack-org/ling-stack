import {
  parseOfficeDriverRequest,
  type OfficeDriverAvailability,
  type OfficeDriverRequest,
  type OfficeDriverResult,
} from "@ling-stack/contracts";

const ROOT = "/desktop/capabilities/office";

export interface OfficeDriverDaemonTransport {
  publishAvailability(availability: OfficeDriverAvailability, signal?: AbortSignal): Promise<void>;
  claim(signal?: AbortSignal): Promise<OfficeDriverRequest | undefined>;
  complete(result: OfficeDriverResult, signal?: AbortSignal): Promise<void>;
}

export class OfficeDriverDaemonClient implements OfficeDriverDaemonTransport {
  constructor(private readonly options: {
    readonly daemonBaseUrl: string;
    readonly bridgeToken: string;
    readonly desktopInstanceId: string;
    readonly generation: number;
  }) {}

  async publishAvailability(availability: OfficeDriverAvailability, signal?: AbortSignal): Promise<void> {
    await this.request(`${ROOT}/availability`, availability, signal, false);
  }

  async claim(signal?: AbortSignal): Promise<OfficeDriverRequest | undefined> {
    const value = await this.request(`${ROOT}/commands/claim`, {}, signal, true);
    if (!isRecord(value) || value.command === undefined) return undefined;
    return parseOfficeDriverRequest(value.command);
  }

  async complete(result: OfficeDriverResult, signal?: AbortSignal): Promise<void> {
    await this.request(`${ROOT}/commands/${encodeURIComponent(result.id)}/result`, result, signal, true);
  }

  private async request(path: string, body: unknown, signal: AbortSignal | undefined, withAuthority: boolean): Promise<unknown> {
    const response = await fetch(new URL(path, this.options.daemonBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ling-desktop-bridge-token": this.options.bridgeToken,
        ...(withAuthority ? {
          "x-ling-office-desktop-instance": this.options.desktopInstanceId,
          "x-ling-office-generation": String(this.options.generation),
        } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "office_driver_daemon_request_failed");
    }
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

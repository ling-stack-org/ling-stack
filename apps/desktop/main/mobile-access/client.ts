import type {
  DesktopMobileAccessCapabilities,
  DesktopMobileAccessPairingStartResult,
  DesktopMobileAccessStatus,
} from "../../shared/desktop-capabilities.js";
import {
  deriveMobileAccessCsrfToken,
  deriveMobileAccessManagementCapability,
} from "./authority.js";

export interface DesktopMobileAccessClientOptions {
  readonly daemonBaseUrl: string;
  readonly desktopBridgeToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class DesktopMobileAccessClient implements DesktopMobileAccessCapabilities {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly capability: string;
  private readonly csrfToken: string;
  private readonly origin: string;

  constructor(private readonly options: DesktopMobileAccessClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.capability = deriveMobileAccessManagementCapability(options.desktopBridgeToken);
    this.csrfToken = deriveMobileAccessCsrfToken(this.capability);
    this.origin = new URL(options.daemonBaseUrl).origin;
  }

  async status(): Promise<DesktopMobileAccessStatus> {
    return await this.request("/v1/mobile-access/status", "GET") as DesktopMobileAccessStatus;
  }

  async enable(gatewayOrigin: string): Promise<DesktopMobileAccessStatus> {
    return await this.request("/v1/mobile-access/enable", "POST", { gatewayOrigin }) as DesktopMobileAccessStatus;
  }

  async disable(): Promise<DesktopMobileAccessStatus> {
    return await this.request("/v1/mobile-access/disable", "POST", {}) as DesktopMobileAccessStatus;
  }

  async startPairing(): Promise<DesktopMobileAccessPairingStartResult> {
    return await this.request("/v1/mobile-access/pairing/start", "POST", {}) as DesktopMobileAccessPairingStartResult;
  }

  async confirmPairing(): Promise<DesktopMobileAccessStatus> {
    return await this.request("/v1/mobile-access/pairing/confirm", "POST", {}) as DesktopMobileAccessStatus;
  }

  async rejectPairing(): Promise<DesktopMobileAccessStatus> {
    return await this.request("/v1/mobile-access/pairing/reject", "POST", {}) as DesktopMobileAccessStatus;
  }

  async revoke(): Promise<DesktopMobileAccessStatus> {
    return await this.request("/v1/mobile-access/revoke", "POST", {}) as DesktopMobileAccessStatus;
  }

  private async request(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.options.daemonBaseUrl), {
      method,
      headers: {
        Origin: this.origin,
        "X-Ling-Mobile-Management-Capability": this.capability,
        ...(method === "POST" ? {
          "Content-Type": "application/json",
          "X-Ling-CSRF-Token": this.csrfToken,
        } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) as unknown : {};
    if (!response.ok) {
      const message = value && typeof value === "object" && !Array.isArray(value) && typeof (value as { message?: unknown }).message === "string"
        ? (value as { message: string }).message
        : `mobile_access_http_${response.status}`;
      throw new Error(message);
    }
    return value;
  }
}

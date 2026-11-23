import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import {
  REMOTE_DEVICE_ARTIFACT_MAX_BYTES,
  isRemoteDeviceArtifactName,
  type RemoteDeviceArtifactBuildOfferInputV1,
  type RemoteDeviceArtifactOfferInputV1,
  type RemoteDeviceBuildArtifactSummaryV1,
  type RemoteDeviceArtifactOfferV1,
} from "@ling-stack/contracts";
import type {
  LingServerConfirmedPairingMigrationV1,
  LingServerPairingMigrationConfirmationV1,
  LingServerPairingMigrationPublicationRequestV1,
  LingServerPairingMigrationRequestV1,
  LingServerPairingMigrationV1,
  RemoteDeviceAnalysisDraftInputV1,
  RemoteDeviceAnalysisDraftV1,
  RemoteDeviceAnalysisInputV1,
  RemoteDeviceCollaborationViewV1,
} from "@ling-stack/contracts";
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
  readonly pickDeviceArtifact?: () => Promise<string | undefined>;
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

  async listDeviceCollaboration(): Promise<readonly RemoteDeviceCollaborationViewV1[]> {
    const response = await this.request("/v1/mobile-access/device-collaboration", "GET") as {
      readonly shares: readonly RemoteDeviceCollaborationViewV1[];
    };
    return response.shares;
  }

  async proposeDeviceAnalysis(request: RemoteDeviceAnalysisInputV1): Promise<RemoteDeviceCollaborationViewV1> {
    return await this.request("/v1/mobile-access/device-collaboration", "POST", request) as RemoteDeviceCollaborationViewV1;
  }

  async draftDeviceAnalysis(request: RemoteDeviceAnalysisDraftInputV1): Promise<RemoteDeviceAnalysisDraftV1> {
    return await this.request("/v1/mobile-access/device-collaboration/draft", "POST", request, 15_000) as RemoteDeviceAnalysisDraftV1;
  }

  async listDeviceArtifacts({ shareId, expectedRevision }: Pick<RemoteDeviceArtifactOfferInputV1, "shareId" | "expectedRevision">) {
    const query = new URLSearchParams({ shareId, expectedRevision: String(expectedRevision) });
    const response = await this.request(`/v1/mobile-access/device-collaboration/artifacts?${query}`, "GET") as {
      readonly offers: readonly RemoteDeviceArtifactOfferV1[];
    };
    return response.offers;
  }

  async offerDeviceArtifact({ shareId, expectedRevision, proposalId }: RemoteDeviceArtifactOfferInputV1): Promise<RemoteDeviceArtifactOfferV1 | undefined> {
    const path = await this.options.pickDeviceArtifact?.();
    if (!path) return undefined;
    const name = basename(path);
    if (!isRemoteDeviceArtifactName(name)) throw new Error("The selected file name is unavailable.");
    const file = await openAsBlob(path, { type: "application/octet-stream" });
    if (file.size < 1 || file.size > REMOTE_DEVICE_ARTIFACT_MAX_BYTES) throw new Error("The file size is outside the allowed range.");
    const query = new URLSearchParams({ shareId, expectedRevision: String(expectedRevision), proposalId, name });
    return await this.request(`/v1/mobile-access/device-collaboration/artifacts?${query}`, "POST", file, 180_000) as RemoteDeviceArtifactOfferV1;
  }

  async listDeviceBuildArtifacts({ shareId, expectedRevision }: Pick<RemoteDeviceArtifactOfferInputV1, "shareId" | "expectedRevision">): Promise<readonly RemoteDeviceBuildArtifactSummaryV1[]> {
    const query = new URLSearchParams({ shareId, expectedRevision: String(expectedRevision) });
    const response = await this.request(`/v1/mobile-access/device-collaboration/artifacts/from-build?${query}`, "GET") as {
      readonly builds: readonly RemoteDeviceBuildArtifactSummaryV1[];
    };
    return response.builds;
  }

  async offerDeviceBuildArtifact(request: RemoteDeviceArtifactBuildOfferInputV1): Promise<RemoteDeviceArtifactOfferV1> {
    return await this.request("/v1/mobile-access/device-collaboration/artifacts/from-build", "POST", request, 180_000) as RemoteDeviceArtifactOfferV1;
  }

  async preparePairingMigration(request: LingServerPairingMigrationRequestV1): Promise<LingServerPairingMigrationV1> {
    return await this.request("/v1/mobile-access/pairing-migration/prepare", "POST", request) as LingServerPairingMigrationV1;
  }

  async confirmPairingMigration(request: LingServerPairingMigrationConfirmationV1): Promise<LingServerPairingMigrationPublicationRequestV1> {
    const { gatewayPublicKeyJwk } = await this.request("/v1/mobile-access/pairing-migration/gateway-key", "GET") as Pick<LingServerPairingMigrationPublicationRequestV1, "gatewayPublicKeyJwk">;
    const confirmation = await this.request("/v1/mobile-access/pairing-migration/confirm", "POST", request) as LingServerConfirmedPairingMigrationV1;
    return { confirmation, gatewayPublicKeyJwk };
  }

  private async request(path: string, method: "GET" | "POST", body?: unknown, timeoutMs = 5_000): Promise<unknown> {
    const artifact = body instanceof Blob;
    const response = await this.fetchImpl(new URL(path, this.options.daemonBaseUrl), {
      method,
      headers: {
        Origin: this.origin,
        "X-Ling-Mobile-Management-Capability": this.capability,
        ...(method === "POST" ? {
          "Content-Type": artifact ? "application/octet-stream" : "application/json",
          "X-Ling-CSRF-Token": this.csrfToken,
        } : {}),
      },
      ...(method === "POST" ? { body: artifact ? body : JSON.stringify(body ?? {}) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
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

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  DEFAULT_WORKSPACE_ID,
  LingServerPairingMigrationJournal,
  SqliteLingServerStore,
  type RunStore,
} from "@ling-stack/core";
import {
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6,
  REMOTE_PROTOCOL_LIMITS,
  isRemoteDeviceAnalysisDraftInputV1,
  isRemoteDeviceAnalysisInputV1,
  type LingServerGatewayRouteV1,
  type RemoteAuthChallengeV1,
  type RemoteCapabilityV1,
} from "@ling-stack/contracts";
import { lingServerGatewayDeviceTasksProtocol, parseRemoteAuthFrameV1, remoteWebSocketChannel, type RemoteMessageChannel } from "@ling-stack/remote-protocol";
import type { RemoteReplyDispatcher } from "./dispatch-worker.js";
import { RemoteDispatchWorker } from "./dispatch-worker.js";
import { RemoteConversationFacade } from "./conversation-facade.js";
import { RemoteAccessError } from "./errors.js";
import {
  createRemoteGatewayIdentity,
  RemotePairingAuthService,
  type AuthenticatedRemoteSession,
} from "./pairing-auth-service.js";
import { RemoteProjectionOutboxWorker } from "./projection-outbox-worker.js";
import { RemoteGatewaySession } from "./session.js";
import { RemoteAccessStateStore } from "./state-store.js";
import type { RemoteDeviceFacade } from "./device-facade.js";
import type { PhoneTaskCollaboration, PhoneTaskCollaborationPrincipal } from "./phone-task-collaboration.js";
import type { PhoneTaskAnalysisDrafter } from "../device-support/diagnosis-planner.js";
import { LingServerGatewayPeer } from "./ling-server-gateway-peer.js";
import { createPionPeerConnectionFactory, resolvePionPeerWorker } from "./pion-peer-worker.js";

const deviceTaskProtocols = [
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4,
  REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2, REMOTE_DEVICE_TASKS_SUBPROTOCOL_V1,
];

const LOOPBACK_HOST = "127.0.0.1";
const MANAGEMENT_PREFIX = "/v1/mobile-access";

export interface RemoteAccessControllerOptions {
  readonly store: RunStore;
  readonly stateDir: string;
  readonly listenerPort: number;
  readonly workspaceDisplayName: string;
  readonly managementCapability: string;
  readonly managementAllowedOrigins: readonly string[];
  readonly dispatcher?: RemoteReplyDispatcher;
  readonly deviceFacade?: RemoteDeviceFacade;
  readonly phoneTaskCollaboration?: PhoneTaskCollaboration;
  readonly draftPhoneTaskAnalysis?: PhoneTaskAnalysisDrafter;
  readonly now?: () => string;
}

export interface RemoteAccessStatus {
  readonly enabled: boolean;
  readonly listener: { readonly host: "127.0.0.1"; readonly port: number; readonly listening: boolean };
  readonly gatewayOrigin?: string;
  readonly gatewayId: string;
  readonly gatewayIdentityFingerprint: string;
  readonly pairedDevice?: {
    readonly deviceId: string;
    readonly displayName: string;
    readonly platform: "ios" | "android";
    readonly pairedAt: string;
  };
  readonly pairing: ReturnType<RemotePairingAuthService["pairingStatus"]>;
  readonly policyVersion: number;
  readonly workspaceBindingId: string;
  readonly sendEnabled: boolean;
  readonly deviceCollaborationEnabled?: boolean;
  readonly deviceCollaborationAnalysisEnabled?: boolean;
}

interface RoutedSessionAuthentication {
  readonly challenge: RemoteAuthChallengeV1;
  readonly routeExpiresAt: number;
  readonly authorityUntil: () => number;
}

export class RemoteAccessController {
  readonly csrfToken: string;
  private readonly now: () => string;
  private readonly stateStore: RemoteAccessStateStore;
  private readonly auth: RemotePairingAuthService;
  private pairingMigrationStore?: SqliteLingServerStore;
  private lingServerPeer?: LingServerGatewayPeer;
  private remoteServer?: Server;
  private webSocketServer?: WebSocketServer;
  private activeSession?: RemoteGatewaySession;
  private readonly pendingAuthentications = new Set<() => void>();
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;

  constructor(private readonly options: RemoteAccessControllerOptions) {
    if (!options.managementCapability.trim()) {
      throw new Error("Remote Access management capability is required");
    }
    if (options.managementAllowedOrigins.length === 0) {
      throw new Error("Remote Access requires at least one management Origin");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.csrfToken = createHash("sha256").update(`ling-mobile-csrf-v1:${options.managementCapability}`).digest("base64url");
    this.stateStore = new RemoteAccessStateStore({
      stateDir: options.stateDir,
      listenerPort: options.listenerPort,
      createIdentity: createRemoteGatewayIdentity,
      now: this.now,
    });
    this.auth = new RemotePairingAuthService({
      stateStore: this.stateStore,
      now: this.now,
      onSecurityStateChanged: (reason) => {
        if (reason !== "paired") {
          this.cancelPendingAuthentication();
          this.activeSession?.revoke(reason);
          this.lingServerPeer?.stop();
          this.lingServerPeer = undefined;
        }
      },
    });
  }

  async startIfEnabled(): Promise<void> {
    if (this.stateStore.hasState() && this.auth.state().enabled) {
      await this.startListener();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopPolling();
    this.lingServerPeer?.stop();
    this.lingServerPeer = undefined;
    this.cancelPendingAuthentication();
    this.activeSession?.disconnect();
    this.activeSession = undefined;
    this.pairingMigrationStore?.close();
    this.pairingMigrationStore = undefined;
    const server = this.remoteServer;
    const webSocketServer = this.webSocketServer;
    this.remoteServer = undefined;
    this.webSocketServer = undefined;
    webSocketServer?.close();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** Accept an open channel and route context from the local, authenticated peer transport. */
  attachLingServerPeer(input: {
    readonly route: LingServerGatewayRouteV1;
    readonly channel: RemoteMessageChannel;
    readonly authorityUntil?: () => number;
  }): void {
    const { channel, route } = input;
    try {
      if (this.stopped || channel.readyState !== 1) throw new Error("Peer transport is unavailable.");
      const authentication = this.auth.createRoutedAuthentication(route);
      const routeExpiresAt = Date.parse(route.expiresAt);
      this.acceptSessionChannel(channel, authentication.verify, lingServerGatewayDeviceTasksProtocol(route), {
        challenge: authentication.challenge,
        routeExpiresAt,
        authorityUntil: input.authorityUntil ?? (() => routeExpiresAt),
      });
    } catch (error) {
      channel.close(1008, "Peer authentication unavailable.");
      throw error;
    }
  }

  status(): RemoteAccessStatus {
    const state = this.auth.state();
    const address = this.remoteServer?.address() as AddressInfo | null | undefined;
    return {
      enabled: state.enabled,
      listener: {
        host: LOOPBACK_HOST,
        port: address?.port ?? state.listenerPort,
        listening: Boolean(address),
      },
      ...(state.gatewayOrigin ? { gatewayOrigin: state.gatewayOrigin } : {}),
      gatewayId: this.auth.identity.gatewayId,
      gatewayIdentityFingerprint: this.auth.identity.publicKeyFingerprint,
      ...(state.pairedDevice ? {
        pairedDevice: {
          deviceId: state.pairedDevice.deviceId,
          displayName: state.pairedDevice.displayName,
          platform: state.pairedDevice.platform,
          pairedAt: state.pairedDevice.pairedAt,
        },
      } : {}),
      pairing: this.auth.pairingStatus(),
      policyVersion: state.policyVersion,
      workspaceBindingId: state.workspaceBindingId,
      sendEnabled: Boolean(this.options.dispatcher),
      ...(this.options.phoneTaskCollaboration ? { deviceCollaborationEnabled: true } : {}),
      ...(this.options.draftPhoneTaskAnalysis && this.options.store.getWorkspaceSettings().defaultProviderPresetId
        ? { deviceCollaborationAnalysisEnabled: true } : {}),
    };
  }

  async handleManagementRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (!url.pathname.startsWith(MANAGEMENT_PREFIX)) {
      return false;
    }
    const origin = request.headers.origin;
    if (!origin || !this.options.managementAllowedOrigins.includes(origin)) {
      writeManagementJson(response, 403, { error: "origin_not_allowed", message: "A trusted management Origin is required." });
      return true;
    }
    setManagementCors(response, origin);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return true;
    }
    if (!safeHeaderEquals(request.headers["x-ling-mobile-management-capability"], this.options.managementCapability)) {
      writeManagementJson(response, 401, { error: "capability_required", message: "Mobile Access management capability is invalid." }, origin);
      return true;
    }
    if (request.method !== "GET" && !safeHeaderEquals(request.headers["x-ling-csrf-token"], this.csrfToken)) {
      writeManagementJson(response, 403, { error: "csrf_invalid", message: "Mobile Access CSRF token is invalid." }, origin);
      return true;
    }
    try {
      if (url.pathname === `${MANAGEMENT_PREFIX}/status` && request.method === "GET") {
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/device-collaboration` && this.options.phoneTaskCollaboration) {
        const collaboration = this.options.phoneTaskCollaboration;
        if (request.method === "GET") {
          const principal = this.currentCollaborationPrincipal();
          writeManagementJson(response, 200, { shares: principal ? collaboration.listForPc(principal, this.now()) : [] }, origin);
          return true;
        }
        if (request.method === "POST") {
          const input = await readJson(request);
          if (!isRemoteDeviceAnalysisInputV1(input)) throw new Error("Invalid device analysis proposal.");
          const principal = this.currentCollaborationPrincipal();
          if (!principal) throw new RemoteAccessError("binding_changed", "Pair a phone before sending analysis.");
          writeManagementJson(response, 200, collaboration.proposeFromPc(principal, input, this.now()), origin);
          return true;
        }
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/device-collaboration/draft` && request.method === "POST"
        && this.options.phoneTaskCollaboration && this.options.draftPhoneTaskAnalysis) {
        const input = await readJson(request);
        if (!isRemoteDeviceAnalysisDraftInputV1(input)) throw new Error("Invalid device analysis draft request.");
        const principal = this.currentCollaborationPrincipal();
        if (!principal) throw new RemoteAccessError("binding_changed", "Pair a phone before generating analysis.");
        const service = this.options.phoneTaskCollaboration;
        const projection = service.projectionForAnalysis(principal, input, this.now());
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        response.once("close", cancel);
        try {
          const draft = await this.options.draftPhoneTaskAnalysis(projection, input.locale, cancellation.signal).catch(() => {
            if (!cancellation.signal.aborted) throw new RemoteAccessError("pc_unavailable", "The workspace chat model could not prepare a note.");
            return undefined;
          });
          if (!draft || response.destroyed) return true;
          const current = this.currentCollaborationPrincipal();
          if (!current) throw new RemoteAccessError("binding_changed", "The phone pairing changed while preparing the note.");
          service.projectionForAnalysis(current, input, this.now());
          writeManagementJson(response, 200, { shareId: input.shareId, expectedRevision: input.expectedRevision, ...draft }, origin);
          return true;
        } finally {
          response.off("close", cancel);
        }
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/enable` && request.method === "POST") {
        const body = requireRecord(await readJson(request));
        const gatewayOrigin = requireString(body.gatewayOrigin, "gatewayOrigin");
        this.auth.enable(gatewayOrigin);
        await this.startListener();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/disable` && request.method === "POST") {
        this.auth.disable();
        await this.stop();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing/start` && request.method === "POST") {
        const pairing = this.auth.beginPairing();
        writeManagementJson(response, 200, { ...pairing, status: this.status() }, origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing/confirm` && request.method === "POST") {
        this.auth.confirmPendingPairing();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing/reject` && request.method === "POST") {
        this.auth.rejectPendingPairing();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing-migration/prepare` && request.method === "POST") {
        const input = await readJson(request);
        const migration = this.auth.prepareLingServerPairingMigration(this.pairingMigrationJournal(), input);
        writeManagementJson(response, 200, migration, origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing-migration/confirm` && request.method === "POST") {
        const input = await readJson(request);
        const migration = this.auth.confirmLingServerPairingMigration(this.pairingMigrationJournal(), input);
        this.refreshLingServerPeer();
        writeManagementJson(response, 200, migration, origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing-migration/gateway-key` && request.method === "GET") {
        writeManagementJson(response, 200, { gatewayPublicKeyJwk: this.auth.identity.publicKeyJwk }, origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/revoke` && request.method === "POST") {
        this.auth.revokeDevice();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      writeManagementJson(response, 404, { error: "not_found", message: "Mobile Access management route not found." }, origin);
      return true;
    } catch (error) {
      const statusCode = error instanceof RemoteAccessError ? 409 : 400;
      writeManagementJson(response, statusCode, {
        error: error instanceof RemoteAccessError ? error.code : "bad_request",
        message: error instanceof Error ? error.message : String(error),
      }, origin);
      return true;
    }
  }

  private migrationStore(): SqliteLingServerStore {
    this.pairingMigrationStore ??= new SqliteLingServerStore({ databasePath: join(this.options.stateDir, "ling-server-pairing-migrations.sqlite") });
    return this.pairingMigrationStore;
  }

  private currentCollaborationPrincipal(): PhoneTaskCollaborationPrincipal | undefined {
    const state = this.auth.state();
    const device = state.pairedDevice;
    if (!state.enabled || !device) return undefined;
    return {
      gatewayId: this.auth.identity.gatewayId, deviceId: device.deviceId, deviceEpoch: device.deviceEpoch,
      workspaceId: DEFAULT_WORKSPACE_ID, workspaceBindingId: state.workspaceBindingId, policyVersion: state.policyVersion,
    };
  }

  private refreshLingServerPeer(): void {
    const { enabled, lingServerMigrationId } = this.auth.state();
    const selected = this.remoteServer?.listening && enabled && lingServerMigrationId;
    if (selected && selected === this.lingServerPeer?.migrationId) return;
    this.lingServerPeer?.stop();
    this.lingServerPeer = undefined;
    if (!selected) return;
    const executable = resolvePionPeerWorker();
    if (!executable) return;
    const confirmed = this.migrationStore().getPairingMigration(selected);
    if (confirmed?.status !== "confirmed") return;
    const options = this.auth.lingServerRendezvousOptions(confirmed);
    if (options) {
      this.lingServerPeer = new LingServerGatewayPeer(selected, options, createPionPeerConnectionFactory(executable), (route, channel, authorityUntil) =>
        this.attachLingServerPeer({ route, channel, authorityUntil }));
    }
  }

  private pairingMigrationJournal(): LingServerPairingMigrationJournal {
    return new LingServerPairingMigrationJournal({
      store: this.migrationStore(),
      readReceipt: commandId => this.options.store.getRemoteCommandReceipt(commandId),
      now: this.now,
    });
  }

  private async startListener(): Promise<void> {
    if (this.remoteServer?.listening) {
      return;
    }
    const state = this.auth.state();
    if (!state.enabled || !state.gatewayOrigin) {
      throw new Error("Remote Access must be enabled before starting the listener");
    }
    const server = createServer((request, response) => {
      void this.handleRemoteHttp(request, response).catch((error) => {
        if (!response.headersSent) {
          writeRemoteJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
        } else {
          response.end();
        }
      });
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: REMOTE_PROTOCOL_LIMITS.maxFrameBytes,
      handleProtocols: protocols => deviceTaskProtocols.find(protocol => protocols.has(protocol)) ?? false,
    });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/v1/session") {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.acceptSessionChannel(remoteWebSocketChannel(webSocket), proof => this.auth.verifyAuthProof(proof), webSocket.protocol);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(state.listenerPort, LOOPBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.remoteServer = server;
    this.webSocketServer = webSocketServer;
    this.stopped = false;
    this.startPolling();
    this.refreshLingServerPeer();
  }

  private acceptSessionChannel(
    channel: RemoteMessageChannel,
    verify: (value: unknown) => Promise<AuthenticatedRemoteSession>,
    protocol: string,
    peer?: RoutedSessionAuthentication,
  ): void {
    let pending = true;
    let verifying = false;
    let detach: (() => void) | undefined;
    const finish = (): boolean => {
      if (!pending) return false;
      pending = false;
      detach?.();
      clearTimeout(timeout);
      this.pendingAuthentications.delete(cancel);
      return true;
    };
    const reject = (reason: string) => {
      if (finish()) channel.close(1008, reason.slice(0, 120));
    };
    const cancel = () => reject("Authentication cancelled.");
    const timeout = setTimeout(() => reject("Authentication proof required."), 10_000);
    timeout.unref();
    this.pendingAuthentications.add(cancel);
    try {
      detach = channel.subscribe({
        received: data => {
          if (verifying || typeof data !== "string") {
            reject("One JSON authentication proof is required.");
            return;
          }
          verifying = true;
          void (async () => {
            const authenticated = await verify(parseRemoteAuthFrameV1(data));
            if (!finish() || channel.readyState !== 1) return;
            try {
              this.activateSession(channel, authenticated, protocol, peer);
            } catch {
              channel.close(1008, "Authentication no longer current.");
            }
          })().catch(error => reject(error instanceof Error ? error.message : "Authentication failed."));
        },
        closed: finish,
        failed: () => reject("Authentication transport failed."),
      });
      if (peer) channel.send(JSON.stringify(peer.challenge));
    } catch {
      reject("Authentication transport failed.");
    }
  }

  private activateSession(
    channel: RemoteMessageChannel,
    authenticated: AuthenticatedRemoteSession,
    protocol: string,
    peer?: RoutedSessionAuthentication,
  ): void {
    const current = this.auth.state();
    const device = current.pairedDevice;
    const nowMs = Date.parse(this.now());
    if (this.stopped || !current.enabled || !device || device.deviceId !== authenticated.device.deviceId
      || device.deviceEpoch !== authenticated.device.deviceEpoch || device.publicKeyFingerprint !== authenticated.device.publicKeyFingerprint
      || (peer && !(nowMs < Math.min(peer.routeExpiresAt, peer.authorityUntil())))) {
      throw new Error("Authentication no longer current.");
    }
    const deviceFacade = deviceTaskProtocols.includes(protocol) ? this.options.deviceFacade : undefined;
    const phoneTaskCollaboration = protocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6 ? this.options.phoneTaskCollaboration : undefined;
    const capabilities = this.capabilities(deviceFacade ? protocol : "", !!phoneTaskCollaboration);
    const facade = new RemoteConversationFacade({
      store: this.options.store,
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceBindingId: current.workspaceBindingId,
      workspaceDisplayName: this.options.workspaceDisplayName,
      conversationAccess: current.conversationAccess,
      policyVersion: current.policyVersion,
      now: this.now,
    });
    const session = new RemoteGatewaySession({
      channel,
      authenticated,
      gatewayId: this.auth.identity.gatewayId,
      facade,
      deviceFacade,
      phoneTaskCollaboration,
      recoveryApprovals: protocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4 || protocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5
        || protocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6,
      isPairedDeviceCurrent: () => {
        const state = this.auth.state();
        const device = state.pairedDevice;
        return !this.stopped && state.enabled && device?.deviceId === authenticated.device.deviceId
          && device.deviceEpoch === authenticated.device.deviceEpoch && device.publicKeyFingerprint === authenticated.device.publicKeyFingerprint
          && state.workspaceBindingId === current.workspaceBindingId && state.policyVersion === current.policyVersion
          && (!peer || Date.parse(this.now()) < peer.authorityUntil());
      },
      routeAuthorityUntil: peer?.authorityUntil,
      policy: facade.policySummary(capabilities),
      now: this.now,
      onMutation: () => this.scheduleDrain(),
      onSelfUnpair: () => {
        setTimeout(() => this.auth.revokeDevice(), 0).unref();
      },
      onClosed: closed => {
        if (this.activeSession === closed) this.activeSession = undefined;
      },
    });
    if (session.isClosed) return;
    const prior = this.activeSession;
    this.activeSession = session;
    prior?.revoke("replaced");
    this.startPolling();
    this.scheduleDrain();
  }

  private cancelPendingAuthentication(): void {
    for (const cancel of this.pendingAuthentications) cancel();
  }

  private async handleRemoteHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setRemoteSecurityHeaders(response);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      writeRemoteJson(response, 200, {
        ok: true,
        gatewayId: this.auth.identity.gatewayId,
        gatewayIdentityFingerprint: this.auth.identity.publicKeyFingerprint,
        protocolVersions: [1],
      });
      return;
    }
    if (request.method !== "POST") {
      writeRemoteJson(response, 405, { error: "method_not_allowed", message: "Remote Gateway accepts POST for this route." });
      return;
    }
    try {
      const body = await readJson(request);
      if (url.pathname === "/v1/pairing/challenge") {
        const input = requireRecord(body);
        writeRemoteJson(response, 200, this.auth.createPairingChallenge(requireString(input.pairingId, "pairingId")));
        return;
      }
      if (url.pathname === "/v1/pairing/proof") {
        const result = this.auth.submitPairingProof(body);
        writeRemoteJson(response, result.status === "accepted" ? 200 : 202, result);
        return;
      }
      if (url.pathname === "/v1/auth/challenge") {
        const input = requireRecord(body);
        writeRemoteJson(response, 200, this.auth.createAuthChallenge(requireString(input.deviceId, "deviceId")));
        return;
      }
      writeRemoteJson(response, 404, { error: "not_found", message: "Remote Gateway route not found." });
    } catch (error) {
      writeRemoteJson(response, error instanceof RemoteAccessError ? 403 : 400, {
        error: error instanceof RemoteAccessError ? error.code : "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private capabilities(deviceTaskProtocol: string, supportsCollaboration: boolean): readonly RemoteCapabilityV1[] {
    const supportsJournalWatch = deviceTaskProtocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V5 || deviceTaskProtocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V6;
    const supportsJournal = supportsJournalWatch || deviceTaskProtocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V3
      || deviceTaskProtocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4;
    return [
      "conversation.read",
      ...(this.options.dispatcher ? ["conversation.send_text" as const] : []),
      "conversation.mark_read",
      "profile.read",
      "profile.update",
      "security.unpair",
      ...(deviceTaskProtocol ? ["device.read" as const, "device.approve" as const, "device.revoke" as const] : []),
      ...(supportsJournal || deviceTaskProtocol === REMOTE_DEVICE_TASKS_SUBPROTOCOL_V2 ? ["device.reconcile" as const] : []),
      ...(supportsJournal ? ["device.journal" as const] : []),
      ...(supportsJournalWatch ? ["device.journal.watch" as const] : []),
      ...(supportsCollaboration ? ["device.collaboration" as const] : []),
    ];
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.activeSession?.pushDeviceJournalPage();
      this.scheduleDrain();
    }, 250);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private scheduleDrain(): void {
    if (this.drainPromise) {
      return;
    }
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
  }

  private async drain(): Promise<void> {
    if (this.options.dispatcher) {
      const dispatchWorker = new RemoteDispatchWorker({
        store: this.options.store,
        dispatcher: this.options.dispatcher,
        workerId: `remote_gateway_${process.pid}`,
        now: this.now,
      });
      await dispatchWorker.drainBatch();
    }
    if (this.activeSession) {
      const facade = new RemoteConversationFacade({
        store: this.options.store,
        workspaceId: DEFAULT_WORKSPACE_ID,
        workspaceBindingId: this.auth.state().workspaceBindingId,
        workspaceDisplayName: this.options.workspaceDisplayName,
        conversationAccess: this.auth.state().conversationAccess,
        policyVersion: this.auth.state().policyVersion,
        now: this.now,
      });
      const worker = new RemoteProjectionOutboxWorker(this.options.store, facade, {
        publish: (event) => this.activeSession?.publish(event),
      }, this.now);
      await worker.drainUntilIdle();
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > REMOTE_PROTOCOL_LIMITS.maxFrameBytes) {
      throw new Error("Remote request is too large");
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeRemoteJson(response: ServerResponse, statusCode: number, body: unknown): void {
  setRemoteSecurityHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function setRemoteSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function writeManagementJson(response: ServerResponse, statusCode: number, body: unknown, origin?: string): void {
  if (origin) {
    setManagementCors(response, origin);
  }
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function setManagementCors(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,X-Ling-Mobile-Management-Capability,X-Ling-CSRF-Token",
  );
}

function safeHeaderEquals(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value;
}

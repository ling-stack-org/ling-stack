import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CHROME_BROWSER_PLUGIN_ID,
  CHROME_BROWSER_PROTOCOL,
  parseChromeBrowserExtensionMessage,
  type ChromeBrowserCommand,
  type ChromeBrowserExtensionState,
  type ChromeBrowserHostState,
  type ChromeBrowserMethod,
  type ChromeBrowserPairingRequest,
  type ChromeBrowserTransportKind,
} from "@ling-stack/contracts";
import type {
  ChromeBrowserCredentialStoreFacet,
  ManagedPluginStoreFacet,
} from "@ling-stack/core";
import type { ChromeBrowserSessionTransport } from "./transport.js";

type ChromeBrowserSessionStore = ChromeBrowserCredentialStoreFacet & ManagedPluginStoreFacet;

export type ChromeBrowserSessionErrorCode =
  | "chrome_browser_disabled"
  | "chrome_browser_extension_forbidden"
  | "chrome_browser_pairing_expired"
  | "chrome_browser_pairing_invalid"
  | "chrome_browser_credential_invalid"
  | "chrome_browser_disconnected"
  | "chrome_browser_command_timeout"
  | "chrome_browser_command_cancelled"
  | "chrome_browser_protocol_invalid"
  | "chrome_browser_closed";

export class ChromeBrowserSessionError extends Error {
  constructor(readonly code: ChromeBrowserSessionErrorCode, message: string) {
    super(message);
    this.name = "ChromeBrowserSessionError";
  }
}

export interface ChromeBrowserSessionSnapshot {
  readonly paired: boolean;
  readonly connected: boolean;
  readonly errorCode?: ChromeBrowserSessionErrorCode;
  readonly errorAt?: string;
  readonly extensionId?: string;
  readonly extensionVersion?: string;
  readonly browserVersion?: string;
  readonly connectedAt?: string;
  readonly lastSeenAt?: string;
  readonly transport?: ChromeBrowserTransportKind;
  readonly hostState: ChromeBrowserHostState;
  readonly extensionState: ChromeBrowserExtensionState;
}

export interface ChromeBrowserPairingGrant {
  readonly pairingCode: string;
  readonly expiresAt: string;
}

export interface ChromeBrowserPairResult {
  readonly credential: string;
  readonly workspaceCwd: string;
}

interface PendingPairing {
  readonly codeHash: string;
  readonly expiresAtMs: number;
  attempts: number;
}

interface SessionFailure {
  readonly code: ChromeBrowserSessionErrorCode;
  readonly at: string;
}

interface PendingCommand {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly abort?: () => void;
  readonly signal?: AbortSignal;
}

interface ActiveSession {
  readonly generation: number;
  readonly transport: ChromeBrowserSessionTransport;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly browserVersion?: string;
  readonly connectedAt: string;
  lastSeenAt: string;
  heartbeatTimer?: NodeJS.Timeout;
  readonly pending: Map<string, PendingCommand>;
}

export interface ChromeBrowserSessionControllerOptions {
  readonly workspaceCwd: string;
  readonly allowedExtensionIds: readonly string[];
  readonly getStore: (cwd: string) => ChromeBrowserSessionStore;
  readonly now?: () => Date;
  readonly token?: (bytes: number) => string;
  readonly pairingTtlMs?: number;
  readonly helloTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly onStateChange?: (cwd: string, snapshot: ChromeBrowserSessionSnapshot) => void;
}

export class ChromeBrowserSessionController {
  private readonly pairings = new Map<string, PendingPairing>();
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly failures = new Map<string, SessionFailure>();
  private readonly unauthenticatedTransports = new Set<ChromeBrowserSessionTransport>();
  private readonly allowedExtensionIds: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly token: (bytes: number) => string;
  private readonly pairingTtlMs: number;
  private readonly helloTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private generation = 0;
  private commandSequence = 0;
  private closed = false;
  private stateListener?: (cwd: string, snapshot: ChromeBrowserSessionSnapshot) => void;
  private hostState: ChromeBrowserHostState = "missing";
  private extensionState: ChromeBrowserExtensionState = "not_detected";

  constructor(private readonly options: ChromeBrowserSessionControllerOptions) {
    this.allowedExtensionIds = new Set(options.allowedExtensionIds.map(normalizeExtensionId));
    this.now = options.now ?? (() => new Date());
    this.token = options.token ?? ((bytes) => randomBytes(bytes).toString("base64url"));
    this.pairingTtlMs = options.pairingTtlMs ?? 5 * 60 * 1000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.stateListener = options.onStateChange;
  }

  setStateChangeListener(listener: (cwd: string, snapshot: ChromeBrowserSessionSnapshot) => void): void {
    this.stateListener = listener;
  }

  supportsWorkspace(cwd: string): boolean {
    return cwd === this.options.workspaceCwd;
  }

  createPairing(cwd: string): ChromeBrowserPairingGrant {
    this.assertOpen();
    const store = this.store(cwd);
    if (store.getManagedPlugin(CHROME_BROWSER_PLUGIN_ID)?.enabled !== true) {
      throw new ChromeBrowserSessionError("chrome_browser_disabled", "Enable the Chrome plugin before pairing.");
    }
    this.failures.delete(cwd);
    if (this.extensionState === "incompatible") this.extensionState = "not_detected";
    const pairingCode = this.token(24);
    const expiresAtMs = this.now().getTime() + this.pairingTtlMs;
    this.pairings.set(cwd, { codeHash: hashSecret(pairingCode), expiresAtMs, attempts: 0 });
    this.publish(cwd);
    return { pairingCode, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  pair(cwd: string, extensionId: string, input: ChromeBrowserPairingRequest): ChromeBrowserPairResult {
    this.assertOpen();
    const normalizedExtensionId = this.assertAllowedExtensionId(extensionId);
    const store = this.store(cwd);
    if (store.getManagedPlugin(CHROME_BROWSER_PLUGIN_ID)?.enabled !== true) {
      throw new ChromeBrowserSessionError("chrome_browser_disabled", "Chrome access is disabled in Ling.");
    }
    const pairing = this.pairings.get(cwd);
    if (!pairing || pairing.expiresAtMs <= this.now().getTime()) {
      this.pairings.delete(cwd);
      throw new ChromeBrowserSessionError("chrome_browser_pairing_expired", "The Chrome pairing code has expired.");
    }
    if (!safeHashEquals(pairing.codeHash, hashSecret(input.pairingCode))) {
      pairing.attempts += 1;
      if (pairing.attempts >= 5) this.pairings.delete(cwd);
      throw new ChromeBrowserSessionError("chrome_browser_pairing_invalid", "The Chrome pairing code is invalid.");
    }
    this.pairings.delete(cwd);
    const credential = this.token(32);
    const now = this.now().toISOString();
    store.upsertChromeBrowserCredential({
      workspaceId: "workspace_default",
      pluginId: CHROME_BROWSER_PLUGIN_ID,
      extensionId: normalizedExtensionId,
      credentialHash: hashSecret(credential),
    }, now);
    this.failures.delete(cwd);
    this.publish(cwd);
    return { credential, workspaceCwd: cwd };
  }

  revoke(cwd: string): number {
    this.pairings.delete(cwd);
    this.failures.delete(cwd);
    this.closeSession(cwd, 4003, "chrome_access_revoked");
    const count = this.store(cwd).revokeChromeBrowserCredentials(
      "workspace_default",
      CHROME_BROWSER_PLUGIN_ID,
      this.now().toISOString(),
    );
    this.publish(cwd);
    return count;
  }

  disconnect(cwd: string, reason = "chrome_plugin_disabled"): void {
    this.pairings.delete(cwd);
    this.failures.delete(cwd);
    this.closeSession(cwd, 4003, reason);
    this.publish(cwd);
  }

  acceptLegacyTransport(cwd: string, extensionId: string, transport: ChromeBrowserSessionTransport): void {
    this.assertOpen();
    const normalizedExtensionId = this.assertAllowedExtensionId(extensionId);
    this.store(cwd);
    this.unauthenticatedTransports.add(transport);
    let authenticated = false;
    const helloTimer = setTimeout(() => {
      if (!authenticated) transport.close(4001, "chrome_hello_timeout");
    }, this.helloTimeoutMs);

    transport.onMessage((data) => {
      try {
        const message = parseChromeBrowserExtensionMessage(JSON.parse(data));
        if (!authenticated) {
          if (message.type !== "hello") {
            throw new ChromeBrowserSessionError("chrome_browser_protocol_invalid", "Chrome must authenticate first.");
          }
          this.authenticate(cwd, normalizedExtensionId, message.credential);
          authenticated = true;
          clearTimeout(helloTimer);
          this.unauthenticatedTransports.delete(transport);
          this.activateSession(cwd, normalizedExtensionId, transport, {
            extensionVersion: message.extensionVersion,
            browserVersion: message.browserVersion,
          });
          return;
        }
        this.handleSessionMessage(cwd, transport, message);
      } catch (error) {
        const failure = error instanceof ChromeBrowserSessionError
          ? error
          : new ChromeBrowserSessionError("chrome_browser_protocol_invalid", "Chrome protocol is invalid.");
        this.recordSessionFailure(cwd, failure.code);
        transport.close(4002, failure.code);
      }
    });
    transport.onClose(() => {
      clearTimeout(helloTimer);
      this.unauthenticatedTransports.delete(transport);
      const session = this.sessions.get(cwd);
      if (session?.transport === transport) {
        this.failSession(cwd, new ChromeBrowserSessionError("chrome_browser_disconnected", "Chrome disconnected."));
      }
    });
    transport.onError(() => {
      if (transport.isOpen()) transport.close(1011, "chrome_socket_error");
    });
  }

  acceptNativeTransport(
    cwd: string,
    extensionId: string,
    transport: ChromeBrowserSessionTransport,
    metadata: { readonly extensionVersion: string; readonly browserVersion?: string },
  ): { readonly migratedLegacyCredential: boolean } {
    this.assertOpen();
    const normalizedExtensionId = this.assertAllowedExtensionId(extensionId);
    const store = this.store(cwd);
    if (store.getManagedPlugin(CHROME_BROWSER_PLUGIN_ID)?.enabled !== true) {
      throw new ChromeBrowserSessionError("chrome_browser_disabled", "Chrome access is disabled in Ling.");
    }
    const migratedLegacyCredential = store.revokeChromeBrowserCredentials(
      "workspace_default",
      CHROME_BROWSER_PLUGIN_ID,
      this.now().toISOString(),
    ) > 0;
    this.failures.delete(cwd);
    this.hostState = "ready";
    this.extensionState = "connected";
    this.activateSession(cwd, normalizedExtensionId, transport, metadata);
    transport.onMessage((data) => {
      try {
        this.handleSessionMessage(cwd, transport, parseChromeBrowserExtensionMessage(JSON.parse(data)));
      } catch {
        this.recordSessionFailure(cwd, "chrome_browser_protocol_invalid");
        transport.close(4002, "chrome_browser_protocol_invalid");
      }
    });
    transport.onClose(() => {
      const session = this.sessions.get(cwd);
      if (session?.transport === transport) {
        this.failSession(cwd, new ChromeBrowserSessionError("chrome_browser_disconnected", "Chrome disconnected."));
      }
    });
    transport.onError(() => {
      if (transport.isOpen()) transport.close(1011, "chrome_socket_error");
    });
    return { migratedLegacyCredential };
  }

  observeNativeState(input: {
    readonly cwd: string;
    readonly hostState?: ChromeBrowserHostState;
    readonly extensionState?: ChromeBrowserExtensionState;
  }): void {
    this.store(input.cwd);
    if (input.hostState) this.hostState = input.hostState;
    if (input.extensionState) this.extensionState = input.extensionState;
    this.publish(input.cwd);
  }

  snapshot(cwd: string): ChromeBrowserSessionSnapshot {
    const store = this.store(cwd);
    const paired = store.listChromeBrowserCredentials("workspace_default", CHROME_BROWSER_PLUGIN_ID)
      .some((credential) => !credential.revokedAt && this.allowedExtensionIds.has(credential.extensionId));
    const session = this.sessions.get(cwd);
    const failure = this.failures.get(cwd);
    return {
      paired,
      connected: Boolean(session && session.transport.isOpen()),
      hostState: this.hostState,
      extensionState: session?.transport.kind === "native_messaging" ? "connected" : this.extensionState,
      ...(failure ? { errorCode: failure.code, errorAt: failure.at } : {}),
      ...(session
        ? {
            extensionId: session.extensionId,
            extensionVersion: session.extensionVersion,
            ...(session.browserVersion ? { browserVersion: session.browserVersion } : {}),
            connectedAt: session.connectedAt,
            lastSeenAt: session.lastSeenAt,
            transport: session.transport.kind,
          }
        : {}),
    };
  }

  execute(
    cwd: string,
    method: ChromeBrowserMethod,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertOpen();
    const session = this.sessions.get(cwd);
    if (!session || !session.transport.isOpen()) {
      return Promise.reject(new ChromeBrowserSessionError("chrome_browser_disconnected", "Chrome is not connected."));
    }
    if (signal?.aborted) {
      return Promise.reject(new ChromeBrowserSessionError("chrome_browser_command_cancelled", "Chrome command was cancelled."));
    }
    const id = `chrome_${session.generation}_${++this.commandSequence}`;
    const deadlineAt = new Date(this.now().getTime() + this.commandTimeoutMs).toISOString();
    const command: ChromeBrowserCommand = {
      protocol: CHROME_BROWSER_PROTOCOL,
      type: "command",
      id,
      method,
      params,
      deadlineAt,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pending.get(id);
        session.pending.delete(id);
        if (pending?.abort) pending.signal?.removeEventListener("abort", pending.abort);
        reject(new ChromeBrowserSessionError("chrome_browser_command_timeout", "Chrome command timed out."));
      }, this.commandTimeoutMs);
      const abort = signal
        ? () => {
            const pending = session.pending.get(id);
            if (!pending) return;
            session.pending.delete(id);
            clearTimeout(pending.timer);
            reject(new ChromeBrowserSessionError("chrome_browser_command_cancelled", "Chrome command was cancelled."));
          }
        : undefined;
      if (abort) signal?.addEventListener("abort", abort, { once: true });
      session.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(abort && signal ? { abort, signal } : {}),
      });
      void session.transport.send(JSON.stringify(command)).catch(() => {
        const pending = session.pending.get(id);
        if (!pending) return;
        session.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
        reject(new ChromeBrowserSessionError("chrome_browser_disconnected", "Chrome command could not be sent."));
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pairings.clear();
    this.failures.clear();
    for (const cwd of [...this.sessions.keys()]) this.closeSession(cwd, 1001, "daemon_shutdown");
    for (const transport of this.unauthenticatedTransports) transport.terminate();
    this.unauthenticatedTransports.clear();
  }

  private activateSession(
    cwd: string,
    extensionId: string,
    transport: ChromeBrowserSessionTransport,
    metadata: { readonly extensionVersion: string; readonly browserVersion?: string },
  ): void {
    this.closeSession(cwd, 4000, "chrome_session_replaced");
    this.failures.delete(cwd);
    const now = this.now().toISOString();
    const session: ActiveSession = {
      generation: ++this.generation,
      transport,
      extensionId,
      extensionVersion: metadata.extensionVersion,
      ...(metadata.browserVersion ? { browserVersion: metadata.browserVersion } : {}),
      connectedAt: now,
      lastSeenAt: now,
      pending: new Map(),
    };
    this.sessions.set(cwd, session);
    this.armHeartbeat(cwd, session);
    this.publish(cwd);
  }

  private handleSessionMessage(
    cwd: string,
    transport: ChromeBrowserSessionTransport,
    message: ReturnType<typeof parseChromeBrowserExtensionMessage>,
  ): void {
    const session = this.sessions.get(cwd);
    if (!session || session.transport !== transport) {
      throw new ChromeBrowserSessionError("chrome_browser_credential_invalid", "Chrome session is no longer current.");
    }
    if (message.type === "hello") {
      throw new ChromeBrowserSessionError("chrome_browser_protocol_invalid", "Chrome session is already authenticated.");
    }
    session.lastSeenAt = this.now().toISOString();
    this.armHeartbeat(cwd, session);
    if (message.type === "heartbeat") {
      return;
    }
    const pending = session.pending.get(message.id);
    if (!pending) return;
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error?.message ?? "Chrome command failed."));
  }

  private authenticate(cwd: string, extensionId: string, credential: string): void {
    const store = this.store(cwd);
    if (store.getManagedPlugin(CHROME_BROWSER_PLUGIN_ID)?.enabled !== true) {
      throw new ChromeBrowserSessionError("chrome_browser_disabled", "Chrome access is disabled in Ling.");
    }
    const stored = store.getChromeBrowserCredential(
      "workspace_default",
      CHROME_BROWSER_PLUGIN_ID,
      extensionId,
    );
    if (!stored || stored.revokedAt || !safeHashEquals(stored.credentialHash, hashSecret(credential))) {
      throw new ChromeBrowserSessionError("chrome_browser_credential_invalid", "Chrome credential is invalid.");
    }
  }

  private armHeartbeat(cwd: string, session: ActiveSession): void {
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = setTimeout(() => {
      if (this.sessions.get(cwd) === session) {
        this.closeSession(cwd, 4004, "chrome_heartbeat_timeout");
        this.publish(cwd);
      }
    }, this.heartbeatTimeoutMs);
  }

  private closeSession(cwd: string, code: number, reason: string): void {
    const session = this.sessions.get(cwd);
    if (!session) return;
    this.sessions.delete(cwd);
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(new ChromeBrowserSessionError("chrome_browser_disconnected", "Chrome session ended."));
    }
    session.pending.clear();
    session.transport.close(code, reason.slice(0, 123));
  }

  private failSession(cwd: string, error: Error): void {
    const session = this.sessions.get(cwd);
    if (!session) return;
    this.sessions.delete(cwd);
    if (session.transport.kind === "native_messaging") this.extensionState = "not_detected";
    if (session.heartbeatTimer) clearTimeout(session.heartbeatTimer);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    session.pending.clear();
    this.publish(cwd);
  }

  private store(cwd: string): ChromeBrowserSessionStore {
    if (cwd !== this.options.workspaceCwd) {
      throw new ChromeBrowserSessionError("chrome_browser_extension_forbidden", "Chrome is bound to the Desktop workspace.");
    }
    return this.options.getStore(cwd);
  }

  private assertAllowedExtensionId(extensionId: string): string {
    const normalized = normalizeExtensionId(extensionId);
    if (!this.allowedExtensionIds.has(normalized)) {
      throw new ChromeBrowserSessionError("chrome_browser_extension_forbidden", "Chrome extension is not trusted by this Ling build.");
    }
    return normalized;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ChromeBrowserSessionError("chrome_browser_closed", "Chrome browser authority is closed.");
    }
  }

  private recordSessionFailure(cwd: string, code: ChromeBrowserSessionErrorCode): void {
    if (code !== "chrome_browser_protocol_invalid" && code !== "chrome_browser_credential_invalid") return;
    this.failures.set(cwd, { code, at: this.now().toISOString() });
    this.extensionState = "incompatible";
    this.publish(cwd);
  }

  private publish(cwd: string): void {
    this.stateListener?.(cwd, this.snapshot(cwd));
  }
}

export function chromeExtensionIdFromOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const match = /^chrome-extension:\/\/([a-p]{32})$/u.exec(origin.trim());
  return match?.[1];
}

function normalizeExtensionId(extensionId: string): string {
  const normalized = extensionId.trim().toLowerCase();
  if (!/^[a-p]{32}$/u.test(normalized)) {
    throw new ChromeBrowserSessionError("chrome_browser_extension_forbidden", "Invalid Chrome extension identity.");
  }
  return normalized;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

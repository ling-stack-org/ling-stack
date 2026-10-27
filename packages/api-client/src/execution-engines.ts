import type { ExecutionEngineConnectionProbe, ExecutionEngineInstallationProbe, ExecutionEngineLoginMethod, ExecutionEngineLoginOperation, ExecutionEngineManagementSession, ExecutionEngineProfileListResponse,
  ExecutionEngineProfileResponse, ExternalExecutionEngineId, SaveExecutionEngineProfileRequest, SaveExecutionEngineSecretRequest } from "@ling-stack/contracts";
import { isExecutionEngineSecretValue } from "@ling-stack/contracts";
import type { EngineDiscoveryReport, ManagedInstallStatus } from "@ling-stack/contracts";
import { LingDaemonError } from "./errors.js";

const managementRequestTimeoutMs = 10_000;
// Discovery can run four serial 3-second probes; an install also downloads and
// extracts its pinned package. Both remain bounded, synchronous owned requests.
const discoveryRequestTimeoutMs = 20_000;
const installRequestTimeoutMs = 5 * 60_000;

export interface ExecutionEngineManagementClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Main/CLI only. Browsers supply their own Origin and enroll into an in-memory session. */
  readonly origin?: string;
  readonly credentials?: () => { readonly token: string; readonly csrfToken: string } | undefined;
}

/** Separate from the workspace client so host credentials cannot reach unrelated routes. */
export class ExecutionEngineManagementClient {
  #session?: ExecutionEngineManagementSession;
  #sessionRevision = 0;
  readonly #options: ExecutionEngineManagementClientOptions;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ExecutionEngineManagementClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw failure("engine_host_must_be_local", 403);
    }
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw failure("engine_host_must_be_local", 403);
    }
    this.#baseUrl = url.origin;
    this.#options = options;
    const configuredFetch = options.fetch;
    this.#fetch = configuredFetch ? (url, init) => configuredFetch(url, init) : globalThis.fetch.bind(globalThis);
  }

  async enroll(code: string): Promise<void> {
    const revision = ++this.#sessionRevision;
    const session = await this.request<ExecutionEngineManagementSession>("/session", "POST", { code }, false);
    if (revision !== this.#sessionRevision) return;
    if (!session || typeof session.token !== "string" || !session.token || typeof session.csrfToken !== "string"
      || !session.csrfToken || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= this.now()) {
      throw failure("engine_session_invalid", 502);
    }
    this.#session = session;
  }

  listProfiles(): Promise<ExecutionEngineProfileListResponse> {
    return this.request("", "GET");
  }

  discover(): Promise<EngineDiscoveryReport> {
    return this.request("/discovery", "GET", undefined, true, undefined, discoveryRequestTimeoutMs);
  }

  install(engineId: ExternalExecutionEngineId): Promise<{ readonly install: ManagedInstallStatus }> {
    return this.request(enginePath(engineId) + "/install", "POST", {}, true, undefined, installRequestTimeoutMs);
  }

  installStatus(engineId: ExternalExecutionEngineId): Promise<{ readonly install: ManagedInstallStatus }> {
    return this.request(enginePath(engineId) + "/install", "GET");
  }

  async getProfile(engineId: ExternalExecutionEngineId): Promise<ExecutionEngineProfileResponse> {
    return this.request(profilePath(engineId), "GET");
  }

  async saveProfile(engineId: ExternalExecutionEngineId, input: SaveExecutionEngineProfileRequest): Promise<ExecutionEngineProfileResponse> {
    return this.request(profilePath(engineId), "PUT", input);
  }

  async saveProfileWithSecret(engineId: ExternalExecutionEngineId, input: SaveExecutionEngineSecretRequest): Promise<ExecutionEngineProfileResponse> {
    const path = profilePath(engineId);
    if (!input || !isExecutionEngineSecretValue(input.secret) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !input.configuration || input.configuration.engineId !== engineId || "secretRef" in input.configuration) {
      throw failure("engine_request_invalid", 400);
    }
    return this.request(`${path}/secret`, "PUT", input);
  }

  async disconnectProfile(engineId: ExternalExecutionEngineId, expectedRevision: number): Promise<ExecutionEngineProfileResponse> {
    return this.request(profilePath(engineId), "DELETE", { expectedRevision });
  }

  async probeProfile(engineId: ExternalExecutionEngineId, expectedRevision: number, signal?: AbortSignal): Promise<ExecutionEngineInstallationProbe> {
    profilePath(engineId);
    return this.request(`/${engineId}/probe`, "POST", { expectedRevision }, true, signal);
  }

  async probeConnection(engineId: ExternalExecutionEngineId, expectedRevision: number, signal?: AbortSignal): Promise<ExecutionEngineConnectionProbe> {
    profilePath(engineId);
    return this.request(`/${engineId}/probe`, "POST", { expectedRevision, mode: "connection" }, true, signal);
  }

  async startLogin(engineId: ExternalExecutionEngineId, expectedRevision: number, method: ExecutionEngineLoginMethod): Promise<ExecutionEngineLoginOperation> {
    profilePath(engineId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (method !== "chatgpt" && method !== "chatgptDeviceCode" && method !== "apiKey" && method !== "terminal")) {
      throw failure("engine_request_invalid", 400);
    }
    return this.request(`/${engineId}/auth`, "POST", { expectedRevision, method });
  }

  async getLogin(engineId: ExternalExecutionEngineId, operationId: string): Promise<ExecutionEngineLoginOperation> {
    return this.request(loginPath(engineId, operationId), "GET");
  }

  async cancelLogin(engineId: ExternalExecutionEngineId, operationId: string): Promise<ExecutionEngineLoginOperation> {
    return this.request(loginPath(engineId, operationId), "DELETE");
  }

  async revokeSession(): Promise<void> {
    const revision = this.#sessionRevision;
    try {
      await this.request("/session", "DELETE");
    } finally {
      if (revision === this.#sessionRevision) this.forgetSession();
    }
  }

  forgetSession(): void {
    this.#sessionRevision++;
    this.#session = undefined;
  }

  private now(): number {
    return (this.#options.now ?? Date.now)();
  }

  private async request<T>(path: string, method: string, body?: unknown, authenticated = true, signal?: AbortSignal,
    timeoutMs = managementRequestTimeoutMs): Promise<T> {
    if (authenticated && this.#session && Date.parse(this.#session.expiresAt) <= this.now()) this.forgetSession();
    const credentials = authenticated ? this.#options.credentials?.() ?? this.#session : undefined;
    const sessionRevision = this.#sessionRevision;
    if (authenticated && !credentials) throw failure("engine_authority_required", 401);
    const headers = new Headers();
    if (this.#options.origin) headers.set("Origin", this.#options.origin);
    if (credentials) {
      headers.set("Authorization", `Bearer ${credentials.token}`);
      if (method !== "GET") headers.set("X-Ling-Engine-Csrf", credentials.csrfToken);
    }
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.#fetch(`${this.#baseUrl}/execution-engines${path}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error", cache: "no-store", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      if (response.status === 401 && credentials && credentials.token === this.#session?.token) this.forgetSession();
      const error = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      const code = typeof error?.error === "string" && /^(engine|profile)_[a-z_]+$/.test(error.error)
        ? error.error : "engine_operation_failed";
      throw failure(code, response.status);
    }
    const result = await response.json() as T;
    if (authenticated) {
      if (this.#session && Date.parse(this.#session.expiresAt) <= this.now()) this.forgetSession();
      const current = this.#options.credentials?.() ?? this.#session;
      if (sessionRevision !== this.#sessionRevision || !current || current.token !== credentials?.token || current.csrfToken !== credentials?.csrfToken) {
        throw failure("engine_authority_required", 401);
      }
    }
    return result;
  }
}

function enginePath(engineId: ExternalExecutionEngineId): string {
  profilePath(engineId);
  return `/${engineId}`;
}

function profilePath(engineId: ExternalExecutionEngineId): string {
  if (!["codex-app-server", "claude-agent-sdk", "kimi-acp", "openclaw-acp"].includes(engineId)) throw failure("engine_request_invalid", 400);
  return `/${engineId}/profile`;
}

function loginPath(engineId: ExternalExecutionEngineId, operationId: string): string {
  profilePath(engineId);
  if (typeof operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) {
    throw failure("engine_request_invalid", 400);
  }
  return `/${engineId}/auth/${operationId}`;
}

function failure(code: string, status: number): LingDaemonError {
  return new LingDaemonError(code, status, "", code);
}

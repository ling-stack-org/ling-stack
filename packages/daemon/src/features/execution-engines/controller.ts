import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExecutionEngineProbe, ExecutionEngineProbeMode, ExecutionEngineProfile, ExternalExecutionEngineId } from "@ling-stack/contracts";
import { isExecutionEngineSecretValue } from "@ling-stack/contracts";
import { assertProfileRevision, ExecutionEngineProfileError, isExternalExecutionEngineId,
  parseExecutionEngineProfileConfiguration, type ExecutionEngineProfileStore } from "@ling-stack/core";
import { readJsonBody } from "../../shared/request.js";
import { EngineAuthorityError, type EngineManagementAuthority } from "./authority.js";
import { EngineProbeBusyError } from "./installation-probe.js";
import type { EngineLoginManager } from "./login-manager.js";
import { EngineLoginError } from "./native-login.js";
import { EngineSecretStoreError, type EngineSecretStore } from "./engine-secret-store.js";
import { saveEngineSecretProfile } from "./secret-profile.js";

const prefix = "/execution-engines";

export class EngineManagementController {
  constructor(private readonly options: {
    readonly authority: EngineManagementAuthority;
    readonly getStore: () => ExecutionEngineProfileStore;
    readonly probe?: (profile: ExecutionEngineProfile, signal: AbortSignal, mode: ExecutionEngineProbeMode) => Promise<ExecutionEngineProbe>;
    readonly onProfileChanged?: (engineId: ExternalExecutionEngineId) => void;
    readonly beforeProfileChange?: (engineId: ExternalExecutionEngineId) => void;
    readonly logins?: EngineLoginManager;
    readonly secretStore?: Pick<EngineSecretStore, "write" | "remove">;
  }) {}

  /** Own the whole namespace, including errors and preflights, before general CORS. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(prefix)) return false;
    let origin: string | undefined;
    try {
      origin = this.options.authority.validateTransport(request);
      if (url.search) throw new EngineRequestError();
      if (request.method === "OPTIONS") {
        writeEngineJson(response, 204, undefined, origin);
        return true;
      }
      if (url.pathname === `${prefix}/session` && request.method === "POST") {
        const body = await readBody(request, ["code"]);
        const session = this.options.authority.redeemEnrollment(request, body.code);
        writeEngineJson(response, 200, session, origin);
        return true;
      }
      const principal = this.options.authority.authorize(request);
      if (url.pathname === `${prefix}/enrollments` && request.method === "POST") {
        if (principal.kind !== "host") throw new EngineAuthorityError("engine_transport_forbidden");
        const body = await readBody(request, ["origin"]);
        if (typeof body.origin !== "string") throw new EngineRequestError();
        this.options.authority.authorize(request);
        writeEngineJson(response, 200, this.options.authority.createEnrollment(body.origin), origin);
        return true;
      }
      if (url.pathname === `${prefix}/session` && request.method === "DELETE") {
        if (principal.kind !== "web") throw new EngineRequestError();
        this.options.authority.revokeSession(principal.token);
        writeEngineJson(response, 200, { revoked: true }, origin);
        return true;
      }
      if (url.pathname === prefix && request.method === "GET") {
        writeEngineJson(response, 200, { profiles: this.options.getStore().list() }, origin);
        return true;
      }
      const match = /^\/execution-engines\/([^/]+)\/(profile|probe|auth)(?:\/([^/]+))?$/.exec(url.pathname);
      const engineId = match?.[1];
      const secretRoute = match?.[2] === "profile" && match[3] === "secret";
      if (!isExternalExecutionEngineId(engineId) || (match?.[3] && match?.[2] !== "auth" && !secretRoute)) {
        writeEngineJson(response, 404, { error: "engine_route_not_found" }, origin);
        return true;
      }
      if (secretRoute) {
        if (request.method !== "PUT") { writeEngineJson(response, 405, { error: "engine_method_not_allowed" }, origin); return true; }
        const body = await readBody(request, ["configuration", "expectedRevision", "secret"]);
        assertProfileRevision(body.expectedRevision);
        const secret = body.secret;
        delete body.secret;
        if (!isExecutionEngineSecretValue(secret)
          || !body.configuration || typeof body.configuration !== "object" || Array.isArray(body.configuration)
          || "secretRef" in body.configuration) throw new EngineRequestError();
        const configuration = parseExecutionEngineProfileConfiguration({ ...body.configuration, secretRef: "keychain:validation-only" });
        if (configuration.engineId !== engineId) throw new EngineRequestError();
        const { secretRef: _ref, ...withoutRef } = configuration;
        this.options.authority.authorize(request);
        this.options.beforeProfileChange?.(engineId);
        if (!this.options.secretStore) throw new EngineSecretStoreError("engine_secret_store_unavailable");
        const profile = saveEngineSecretProfile({ store: this.options.getStore(), secretStore: this.options.secretStore,
          configuration: withoutRef, expectedRevision: body.expectedRevision, secret, assertAuthority: () => {
            this.options.authority.authorize(request);
            if (response.destroyed || request.aborted) throw new EngineRequestError();
          } });
        this.options.onProfileChanged?.(engineId);
        writeEngineJson(response, 200, { profile }, origin);
        return true;
      }
      if (match?.[2] === "auth") {
        const logins = this.options.logins;
        if (!logins) { writeEngineJson(response, 404, { error: "engine_route_not_found" }, origin); return true; }
        const operationId = match[3];
        if (!operationId && request.method === "POST") {
          const body = await readBody(request, ["expectedRevision", "method"]);
          assertProfileRevision(body.expectedRevision);
          if (body.method !== "chatgpt" && body.method !== "chatgptDeviceCode" && body.method !== "apiKey" && body.method !== "terminal") throw new EngineRequestError();
          const owner = this.options.authority.authorize(request);
          const operation = logins.start(engineId, body.expectedRevision, body.method, owner);
          const disconnected = (): void => {
            if (!response.writableFinished) void logins.cancel(engineId, operation.id, owner).catch(() => undefined);
          };
          response.once("close", disconnected);
          response.once("finish", () => response.off("close", disconnected));
          writeEngineJson(response, 202, operation, origin);
        } else if (operationId && (request.method === "GET" || request.method === "DELETE")) {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)
            || request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) throw new EngineRequestError();
          const result = request.method === "GET" ? logins.get(engineId, operationId, principal)
            : await logins.cancel(engineId, operationId, principal);
          this.options.authority.authorize(request);
          writeEngineJson(response, 200, result, origin);
        } else writeEngineJson(response, 405, { error: "engine_method_not_allowed" }, origin);
        return true;
      }
      if (match?.[2] === "probe") {
        if (request.method !== "POST" || !this.options.probe) {
          writeEngineJson(response, 405, { error: "engine_method_not_allowed" }, origin);
          return true;
        }
        const body = await readBody(request, ["expectedRevision", "mode"]);
        assertProfileRevision(body.expectedRevision);
        if (body.mode !== undefined && body.mode !== "installation" && body.mode !== "connection") throw new EngineRequestError();
        this.options.authority.authorize(request);
        const profile = this.options.getStore().get(engineId);
        if (!profile) throw new ExecutionEngineProfileError("profile_not_found");
        if (profile.revision !== body.expectedRevision) throw new ExecutionEngineProfileError("profile_revision_conflict");
        if (profile.status !== "configured") throw new ExecutionEngineProfileError("profile_unavailable");
        const abort = new AbortController();
        const closed = (): void => { if (!response.writableEnded) abort.abort(); };
        response.once("close", closed);
        try {
          const signal = AbortSignal.any([abort.signal, this.options.authority.lifetime(principal)]);
          const result = await this.options.probe(profile, signal, body.mode === "connection" ? "connection" : "installation");
          this.options.authority.authorize(request);
          const current = this.options.getStore().get(engineId);
          if (!current || current.revision !== profile.revision || current.status !== "configured") {
            throw new ExecutionEngineProfileError("profile_revision_conflict");
          }
          writeEngineJson(response, 200, result, origin);
        } finally {
          response.off("close", closed);
        }
        return true;
      }
      if (request.method === "GET") {
        const profile = this.options.getStore().get(engineId);
        writeEngineJson(response, profile ? 200 : 404, profile ? { profile } : { error: "profile_not_found" }, origin);
      } else if (request.method === "PUT") {
        const body = await readBody(request, ["configuration", "expectedRevision"]);
        assertProfileRevision(body.expectedRevision);
        const configuration = parseExecutionEngineProfileConfiguration(body.configuration);
        if (configuration.engineId !== engineId) throw new EngineRequestError();
        this.options.authority.authorize(request);
        this.options.beforeProfileChange?.(engineId);
        const profile = this.options.getStore().save(configuration, body.expectedRevision);
        if (profile.revision !== body.expectedRevision) this.options.onProfileChanged?.(engineId);
        writeEngineJson(response, 200, { profile }, origin);
      } else if (request.method === "DELETE") {
        const body = await readBody(request, ["expectedRevision"]);
        assertProfileRevision(body.expectedRevision);
        this.options.authority.authorize(request);
        this.options.beforeProfileChange?.(engineId);
        const profile = this.options.getStore().disconnect(engineId, body.expectedRevision);
        this.options.onProfileChanged?.(engineId);
        writeEngineJson(response, 200, { profile }, origin);
      } else {
        writeEngineJson(response, 405, { error: "engine_method_not_allowed" }, origin);
      }
    } catch (error) {
      const failure = classifyError(error);
      writeEngineJson(response, failure.status, { error: failure.code }, origin);
    }
    return true;
  }
}

function writeEngineJson(response: ServerResponse, status: number, body: unknown, origin?: string): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Vary", "Origin");
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Ling-Engine-Csrf");
  }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(status === 204 ? undefined : `${JSON.stringify(body)}\n`);
}

class EngineRequestError extends Error {}

async function readBody(request: IncomingMessage, allowedKeys: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new EngineRequestError();
  let value: unknown;
  try {
    value = await readJsonBody(request, 64 * 1024);
  } catch {
    throw new EngineRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new EngineRequestError();
  return value as Record<string, unknown>;
}

function classifyError(error: unknown): { readonly status: number; readonly code: string } {
  if (error instanceof EngineSecretStoreError) return { status: 500, code: error.code };
  if (error instanceof EngineLoginError) return { status: error.code === "engine_login_not_found" ? 404 : 409, code: error.code };
  if (error instanceof EngineProbeBusyError) return { status: 409, code: error.code };
  if (error instanceof EngineAuthorityError) {
    return { status: error.code === "engine_authority_required" ? 401 : error.code === "engine_enrollment_rate_limited" ? 429 : 403, code: error.code };
  }
  if (error instanceof ExecutionEngineProfileError) {
    return { status: error.code === "profile_invalid" ? 400 : error.code === "profile_not_found" ? 404
      : error.code === "profile_store_invalid" ? 500 : 409, code: error.code };
  }
  if (error instanceof EngineRequestError) return { status: 400, code: "engine_request_invalid" };
  // Native/SQLite errors may contain paths, credentials or input; never return their message.
  return { status: 500, code: "engine_operation_failed" };
}

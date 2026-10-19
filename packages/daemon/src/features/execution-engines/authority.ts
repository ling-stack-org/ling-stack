import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ExecutionEngineManagementSession } from "@ling-stack/contracts";

type AuthorityErrorCode = "engine_transport_forbidden" | "engine_authority_required" | "engine_csrf_invalid"
  | "engine_enrollment_invalid" | "engine_enrollment_rate_limited" | "engine_session_limit";

export class EngineAuthorityError extends Error {
  constructor(readonly code: AuthorityErrorCode) {
    super(code);
  }
}

export type EnginePrincipal = { readonly kind: "host" } | { readonly kind: "web"; readonly token: string };
interface OriginGrant { readonly origin: string; readonly expiresAt: number }
interface SessionGrant extends OriginGrant {
  readonly csrfToken: string;
  readonly controller: AbortController;
  readonly timer: NodeJS.Timeout;
}

/** Process-local, engine-only authority. The launch capability must never reach a renderer. */
export class EngineManagementAuthority {
  private readonly enrollments = new Map<string, OriginGrant>();
  private readonly sessions = new Map<string, SessionGrant>();
  private readonly now: () => number;
  private attempts = 0;
  private attemptsResetAt = 0;
  private closed = false;
  private readonly hostLifetime = new AbortController();

  constructor(private readonly options: {
    readonly capability: string;
    readonly allowedOrigins: readonly string[];
    readonly now?: () => number;
  }) {
    if (options.capability.length < 32) throw new Error("engine_capability_invalid");
    for (const origin of options.allowedOrigins) requireLocalOrigin(origin);
    this.now = options.now ?? Date.now;
  }

  validateTransport(request: IncomingMessage): string | undefined {
    if (this.closed) fail("engine_authority_required");
    this.prune();
    const peer = request.socket.remoteAddress;
    const port = request.socket.localPort;
    const headers = request.headers;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") || !port
      || !["127.0.0.1", "localhost", "[::1]"].some((host) => headers.host === `${host}:${port}` || (port === 80 && headers.host === host))
      || Object.keys(headers).some((key) => key === "forwarded" || key.startsWith("x-forwarded-"))) {
      fail("engine_transport_forbidden");
    }
    const origin = headers.origin;
    if (origin === undefined) {
      if (Object.keys(headers).some((key) => key.startsWith("sec-fetch-"))) fail("engine_transport_forbidden");
      return undefined;
    }
    requireLocalOrigin(origin);
    const granted = [...this.enrollments.values(), ...this.sessions.values()].some((grant) => grant.origin === origin);
    const daemonOrigin = new URL(`http://${headers.host}`).origin;
    if (origin !== daemonOrigin && !this.options.allowedOrigins.includes(origin) && !granted) fail("engine_transport_forbidden");
    return origin;
  }

  authorize(request: IncomingMessage): EnginePrincipal {
    const origin = this.validateTransport(request);
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
    let principal: EnginePrincipal;
    let csrf: string;
    if (safeEquals(token, this.options.capability)) {
      principal = { kind: "host" };
      csrf = engineManagementCsrf(this.options.capability);
    } else {
      const session = token ? this.sessions.get(token) : undefined;
      if (!token || !session || !origin || session.origin !== origin) fail("engine_authority_required");
      principal = { kind: "web", token };
      csrf = session.csrfToken;
    }
    if (request.method !== "GET" && request.method !== "HEAD" && !safeEquals(request.headers["x-ling-engine-csrf"], csrf)) {
      fail("engine_csrf_invalid");
    }
    return principal;
  }

  // This method is host-side only; HTTP callers must be authorized as kind=host first.
  createEnrollment(origin: string): { readonly code: string; readonly expiresAt: string } {
    if (this.closed) fail("engine_authority_required");
    requireLocalOrigin(origin);
    this.prune();
    if (this.enrollments.size >= 16) fail("engine_session_limit");
    const code = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + 5 * 60_000;
    this.enrollments.set(code, { origin, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeemEnrollment(request: IncomingMessage, code: unknown): ExecutionEngineManagementSession {
    const origin = this.validateTransport(request);
    const now = this.now();
    if (now >= this.attemptsResetAt) {
      this.attempts = 0;
      this.attemptsResetAt = now + 60_000;
    }
    if (this.attempts >= 8) fail("engine_enrollment_rate_limited");
    this.attempts++;
    const grant = typeof code === "string" ? this.enrollments.get(code) : undefined;
    if (!origin || !grant || grant.origin !== origin || typeof code !== "string") fail("engine_enrollment_invalid");
    if (this.sessions.size >= 16) fail("engine_session_limit");
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = now + 30 * 60_000;
    // No await between consumption and publication: a racing redemption cannot succeed twice.
    this.enrollments.delete(code);
    const controller = new AbortController();
    const timer = setTimeout(() => this.revokeSession(token), expiresAt - now);
    timer.unref();
    this.sessions.set(token, { origin, csrfToken, expiresAt, controller, timer });
    return { token, csrfToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeSession(token: string): void {
    const session = this.sessions.get(token);
    this.sessions.delete(token);
    if (session) { clearTimeout(session.timer); session.controller.abort(); }
  }

  lifetime(principal: EnginePrincipal): AbortSignal {
    if (this.closed) fail("engine_authority_required");
    this.prune();
    if (principal.kind === "host") return this.hostLifetime.signal;
    const session = this.sessions.get(principal.token);
    if (!session) fail("engine_authority_required");
    return session.controller.signal;
  }

  revokeAll(): void {
    for (const token of this.sessions.keys()) this.revokeSession(token);
    this.enrollments.clear();
  }

  close(): void {
    this.closed = true;
    this.hostLifetime.abort();
    this.revokeAll();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, grant] of this.enrollments) if (grant.expiresAt <= now) this.enrollments.delete(key);
    for (const [key, grant] of this.sessions) if (grant.expiresAt <= now) this.revokeSession(key);
  }
}

export function engineManagementCsrf(capability: string): string {
  return createHmac("sha256", capability).update("ling-engine-management-csrf-v1").digest("base64url");
}

function requireLocalOrigin(origin: string): void {
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) fail("engine_transport_forbidden");
  } catch {
    fail("engine_transport_forbidden");
  }
}

function safeEquals(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string" || value.length > 256) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fail(code: AuthorityErrorCode): never {
  throw new EngineAuthorityError(code);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { LockedControlReasonCode } from "@ling-stack/contracts";
import {
  isLockedComputerControlAttestationV1,
  isLockedComputerControlCapabilityV1,
  isLockedControlIdentityResultV1,
  isLockedControlReasonCode,
  isTerminalComputerUseStatus,
} from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { desktopBridgeTokenStatus } from "./desktop-bridge-auth.js";
import type { LockedControlGrantAuthorityInput } from "./locked-control-registry.js";

const LOCKED_CONTROL_ROOT = "/computer-use/locked-control";
const LOCKED_CONTROL_DESKTOP_ROOT = `${LOCKED_CONTROL_ROOT}/desktop`;

interface LockedControlHandshakeAuthority {
  readonly daemonAuthorityEpoch: string;
  readonly bridgeConnectionId: string;
  readonly desktopInstanceEpoch: number;
  readonly workspaceCwd: string;
}

/** Handle the private Desktop mutation surface before renderer route-token checks. */
export async function handleLockedControlDesktopRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: DaemonContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(`${LOCKED_CONTROL_DESKTOP_ROOT}/`)) return false;
  response.removeHeader("Access-Control-Allow-Origin");
  response.removeHeader("Access-Control-Allow-Methods");
  response.removeHeader("Access-Control-Allow-Headers");
  const token = desktopBridgeTokenStatus(request, context.desktopBridgeToken);
  if (token !== "accepted") {
    writePrivateJson(response, token === "unavailable" ? 503 : 403, {
      error: token === "unavailable" ? "desktop_bridge_unavailable" : "desktop_bridge_forbidden",
    });
    return true;
  }
  const registry = context.lockedComputerControl;
  if (!registry) {
    writePrivateJson(response, 503, { error: "locked_control_unavailable" });
    return true;
  }
  if (request.method !== "POST") {
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = readRecord(await readOptionalJsonBody(request, context.config.maxBodyBytes));
  const action = url.pathname.slice(`${LOCKED_CONTROL_DESKTOP_ROOT}/`.length);
  const authority = action === "prepare"
    ? readGrantAuthority(body.authority)
    : readHandshakeAuthority(body.authority);
  if (!context.cuaDriverDesktopBridgeAuthority.isCurrentHandshake(authority)) {
    writePrivateJson(response, 409, { error: "locked_control_authority_rotated" });
    return true;
  }
  if (action === "capability") {
    assertOnlyKeys(body, ["authority", "buildId", "capability"]);
    const capability = body.capability;
    if (!isLockedComputerControlCapabilityV1(capability) || !isText(body.buildId)) {
      throw new Error("locked_control_capability_invalid");
    }
    return writePrivateResult(response, registry.evaluateCapability(capability, body.buildId));
  }
  if (action === "prepare") {
    assertOnlyKeys(body, ["authority", "expectedRevision", "identity", "requestId", "requestedTtlSeconds"]);
    const identity = body.identity;
    if (!isLockedControlIdentityResultV1(identity)) throw new Error("locked_control_identity_invalid");
    const grantAuthority = readGrantAuthority(body.authority);
    return writePrivateResult(response, registry.prepare({
      requestId: readText(body.requestId),
      expectedRevision: readRevision(body.expectedRevision),
      identity,
      authority: grantAuthority,
      ...(body.requestedTtlSeconds === undefined
        ? {}
        : { requestedTtlSeconds: readPositiveInteger(body.requestedTtlSeconds) }),
    }));
  }
  if (action === "commit") {
    assertOnlyKeys(body, ["authority", "expectedRevision", "grantId", "requestId"]);
    return writePrivateResult(response, registry.commit({
      requestId: readText(body.requestId),
      grantId: readText(body.grantId),
      expectedRevision: readRevision(body.expectedRevision),
    }));
  }
  if (action === "reconcile") {
    assertOnlyKeys(body, ["authority", "grantId", "requestId"]);
    writePrivateJson(response, 200, {
      accepted: true,
      snapshot: registry.reconcile(readText(body.requestId), readText(body.grantId)),
    });
    return true;
  }
  if (action === "attestation") {
    assertOnlyKeys(body, ["attestation", "authority"]);
    const attestation = body.attestation;
    if (!isLockedComputerControlAttestationV1(attestation)) {
      throw new Error("locked_control_attestation_invalid");
    }
    return writePrivateResult(response, registry.acceptAttestation(attestation));
  }
  if (action === "revoke") {
    assertOnlyKeys(body, ["acknowledged", "authority", "reason"]);
    const reason = readReason(body.reason, "locked_control_authority_rotated");
    const acknowledged = body.acknowledged === undefined ? true : readBoolean(body.acknowledged);
    return writePrivateResult(response, registry.revoke(reason, acknowledged));
  }
  writePrivateJson(response, 404, { error: "not_found" });
  return true;
}

/** Renderer-safe projection and intent surface. No OS or Desktop facts are accepted. */
export async function handleLockedControlRendererRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: DaemonContext,
): Promise<boolean> {
  if (url.pathname !== LOCKED_CONTROL_ROOT
    && url.pathname !== `${LOCKED_CONTROL_ROOT}/authorize`
    && url.pathname !== `${LOCKED_CONTROL_ROOT}/revoke`) {
    return false;
  }
  const registry = context.lockedComputerControl;
  if (!registry) {
    writeJson(response, 503, { error: "locked_control_unavailable" });
    return true;
  }
  const cwd = readCwd(url);
  if (resolve(cwd) !== resolve(context.config.defaultWorkspaceCwd)) {
    writeJson(response, 409, { error: "locked_control_workspace_mismatch" });
    return true;
  }
  if (url.pathname === LOCKED_CONTROL_ROOT) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    writeJson(response, 200, registry.snapshot());
    return true;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = readRecord(await readOptionalJsonBody(request, context.config.maxBodyBytes));
  if (url.pathname.endsWith("/authorize")) {
    assertOnlyKeys(body, ["expectedRevision", "requestId"]);
    const activeScopes = context.computerUsePreviews.list(cwd).filter((projection) =>
      projection.runId && !isTerminalComputerUseStatus(projection.status));
    // Settings has no task selector. Ambiguous concurrent sessions must fail
    // closed instead of arming whichever projection happens to sort first.
    const active = activeScopes.length === 1 ? activeScopes[0] : undefined;
    const result = registry.beginAuthorization({
      requestId: readText(body.requestId),
      expectedRevision: readRevision(body.expectedRevision),
      workspaceCwd: cwd,
      runId: active?.runId ?? "missing-active-run",
      computerUseSessionId: active?.sessionId ?? "missing-active-session",
    });
    writeJson(response, result.accepted ? 202 : 409, result);
    return true;
  }
  assertOnlyKeys(body, ["expectedRevision", "requestId"]);
  readText(body.requestId);
  const expectedRevision = readRevision(body.expectedRevision);
  const current = registry.snapshot();
  const result = expectedRevision === current.revision
    ? registry.revoke("locked_control_grant_consumed", true)
    : { accepted: false as const, reason: "locked_control_authority_rotated" as const, snapshot: current };
  writeJson(response, result.accepted ? 200 : 409, result);
  return true;
}

function writePrivateResult(
  response: ServerResponse,
  result: { readonly accepted: boolean; readonly reason?: string },
): true {
  writePrivateJson(response, result.accepted ? 200 : 409, result);
  return true;
}

function readGrantAuthority(value: unknown): LockedControlGrantAuthorityInput & LockedControlHandshakeAuthority {
  const authority = readRecord(value);
  assertOnlyKeys(authority, [
    "allowedLockedToolIdsDigest", "authorizedLockEpoch", "authorizedNormalGeneration",
    "bridgeConnectionId", "daemonAuthorityEpoch", "desktopInstanceEpoch", "desktopInstanceId",
    "osSessionBindingDigest", "platform", "workspaceCwd",
  ]);
  if ((authority.platform !== "darwin" && authority.platform !== "win32")
    || !isSha256(authority.allowedLockedToolIdsDigest)
    || !isSha256(authority.osSessionBindingDigest)) {
    throw new Error("locked_control_authority_invalid");
  }
  return {
    platform: authority.platform,
    desktopInstanceId: readText(authority.desktopInstanceId),
    desktopInstanceEpoch: readPositiveInteger(authority.desktopInstanceEpoch),
    daemonAuthorityEpoch: readText(authority.daemonAuthorityEpoch),
    bridgeConnectionId: readText(authority.bridgeConnectionId),
    authorizedNormalGeneration: readPositiveInteger(authority.authorizedNormalGeneration),
    osSessionBindingDigest: authority.osSessionBindingDigest,
    authorizedLockEpoch: readPositiveInteger(authority.authorizedLockEpoch),
    allowedLockedToolIdsDigest: authority.allowedLockedToolIdsDigest,
    workspaceCwd: readText(authority.workspaceCwd, 4_096),
  };
}

function readHandshakeAuthority(value: unknown): LockedControlHandshakeAuthority {
  const authority = readRecord(value);
  assertOnlyKeys(authority, [
    "bridgeConnectionId", "daemonAuthorityEpoch", "desktopInstanceEpoch", "workspaceCwd",
  ]);
  return {
    daemonAuthorityEpoch: readText(authority.daemonAuthorityEpoch),
    bridgeConnectionId: readText(authority.bridgeConnectionId),
    desktopInstanceEpoch: readPositiveInteger(authority.desktopInstanceEpoch),
    workspaceCwd: readText(authority.workspaceCwd, 4_096),
  };
}

function readReason(value: unknown, fallback: LockedControlReasonCode): LockedControlReasonCode {
  if (value === undefined) return fallback;
  if (!isLockedControlReasonCode(value)) throw new Error("locked_control_reason_invalid");
  return value;
}

function readCwd(url: URL): string {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) throw new Error("cwd query parameter is required");
  return cwd;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("locked_control_request_invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("locked_control_request_invalid");
  }
}

function readText(value: unknown, maxLength = 256): string {
  if (!isText(value, maxLength)) throw new Error("locked_control_request_invalid");
  return value;
}

function isText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value;
}

function readRevision(value: unknown): number {
  return readNonNegativeInteger(value);
}

function readPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("locked_control_request_invalid");
  return value as number;
}

function readNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("locked_control_request_invalid");
  return value as number;
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("locked_control_request_invalid");
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function writePrivateJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isDesktopCuaDriverLeaseRevokeV1,
  isDesktopCuaDriverLeaseV1,
  type DesktopCuaDriverLease,
  type DesktopCuaDriverLeaseRevokeV1,
} from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { isAllowedLocalOrigin } from "../../shared/local-workspace-access.js";
import { readOptionalJsonBody } from "../../shared/request.js";
import { desktopBridgeTokenStatus } from "../computer-use/desktop-bridge-auth.js";

const LEASE_COLLECTION_PATH = "/desktop/capabilities/cua-driver/lease";

type CuaDriverLeaseRoute =
  | { readonly kind: "collection" }
  | {
      readonly kind: "item";
      readonly desktopInstanceEpoch?: number;
      readonly generation?: number;
    };

export async function handleCuaDriverLeaseRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<boolean> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`,
  );
  const route = parseCuaDriverLeaseRoute(url.pathname);
  if (!route) {
    return false;
  }

  if (!isAllowedLocalOrigin(request.headers.origin)) {
    writePrivateJson(response, 403, {
      error: "forbidden_origin",
      message: "Cua Driver lease routes are only available to the local Desktop bridge.",
    });
    return true;
  }

  const tokenStatus = desktopBridgeTokenStatus(request, context.desktopBridgeToken);
  if (tokenStatus === "unavailable") {
    writePrivateJson(response, 503, {
      error: "desktop_bridge_unavailable",
      message: "The daemon was not started with a Desktop bridge token.",
    });
    return true;
  }
  if (tokenStatus === "forbidden") {
    writePrivateJson(response, 403, {
      error: "desktop_bridge_forbidden",
      message: "Desktop bridge authentication failed.",
    });
    return true;
  }

  try {
    const workspaceCwds = url.searchParams.getAll("cwd");
    if (workspaceCwds.length !== 1 || !workspaceCwds[0]) {
      throw new Error("Exactly one cwd query parameter is required");
    }
    if (workspaceCwds[0] !== context.cuaDriverDesktopBridgeAuthority.workspaceCwd) {
      writePrivateJson(response, 409, {
        accepted: false,
        error: "cua_driver_lease_workspace_mismatch",
        message: "The lease route does not belong to this daemon workspace authority.",
      });
      return true;
    }
    if (route.kind === "collection") {
      if (request.method !== "PUT") {
        writeMethodNotAllowed(response, "PUT");
        return true;
      }
      const lease = await readLease(request, context.config.maxBodyBytes);
      if (!context.cuaDriverDesktopBridgeAuthority.isCurrentHandshake(lease)) {
        writeStaleHandshake(response);
        return true;
      }
      const result = context.cuaDriverDesktopBridgeAuthority.publish(lease);
      if (!result.accepted) {
        writePrivateJson(response, 409, {
          accepted: false,
          error: "cua_driver_lease_rejected",
          reason: result.reason,
        });
        return true;
      }
      if (!result.lease) {
        throw new Error("Accepted Cua Driver lease did not return the installed lease");
      }
      if (!context.cuaDriverActivationCoordinator.handleLeasePublished(result.lease)) {
        writePrivateJson(response, 503, {
          accepted: false,
          error: "cua_driver_activation_projection_unavailable",
          message: "The lease was fenced because the daemon could not clear stale Cua Driver activation state.",
        });
        return true;
      }
      writePrivateJson(response, 200, {
        accepted: true,
        desktopInstanceEpoch: lease.desktopInstanceEpoch,
        generation: lease.generation,
        expiresAt: lease.expiresAt,
      });
      return true;
    }

    if (request.method !== "DELETE") {
      writeMethodNotAllowed(response, "DELETE");
      return true;
    }
    if (route.desktopInstanceEpoch === undefined || route.generation === undefined) {
      throw new Error("Lease route epochs must be positive safe integers");
    }
    const revoke = await readRevoke(request, context.config.maxBodyBytes);
    if (
      revoke.desktopInstanceEpoch !== route.desktopInstanceEpoch
      || revoke.generation !== route.generation
    ) {
      throw new Error("Lease revoke body does not match the route identity");
    }
    if (!context.cuaDriverDesktopBridgeAuthority.isCurrentHandshake(revoke)) {
      writeStaleHandshake(response);
      return true;
    }
    const currentLease = context.cuaDriverDesktopBridgeAuthority.leaseRegistry.getCurrent();
    const revoked = context.cuaDriverDesktopBridgeAuthority.revoke(revoke);
    if (!revoked && currentLease) {
      writePrivateJson(response, 409, {
        revoked: false,
        error: "cua_driver_lease_not_current",
      });
      return true;
    }
    // Revoke is idempotent for the current authenticated Desktop authority.
    // The registry callback fences execution immediately, but its observer
    // result is intentionally non-throwing. Re-run the durable projection here
    // so the HTTP response truthfully reports persistence and a failed caller
    // can retry after storage recovers even though the lease is already gone.
    if (!context.cuaDriverActivationCoordinator.handleLeaseChanged(undefined)) {
      writePrivateJson(response, 503, {
        revoked: true,
        error: "cua_driver_activation_projection_unavailable",
        message: "The lease was revoked, but the daemon could not clear stale Cua Driver activation state.",
      });
      return true;
    }
    writePrivateJson(response, 200, {
      revoked: true,
      desktopInstanceEpoch: revoke.desktopInstanceEpoch,
      generation: revoke.generation,
    });
    return true;
  } catch (error) {
    writePrivateJson(response, 400, {
      error: "invalid_cua_driver_lease_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function readLease(request: IncomingMessage, maxBodyBytes: number): Promise<DesktopCuaDriverLease> {
  const value = await readOptionalJsonBody(request, maxBodyBytes);
  if (!isDesktopCuaDriverLeaseV1(value)) {
    throw new Error("Cua Driver lease body must match DesktopCuaDriverLeaseV1");
  }
  return value;
}

async function readRevoke(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<DesktopCuaDriverLeaseRevokeV1> {
  const value = await readOptionalJsonBody(request, maxBodyBytes);
  if (!isDesktopCuaDriverLeaseRevokeV1(value)) {
    throw new Error("Cua Driver lease revoke body must match DesktopCuaDriverLeaseRevokeV1");
  }
  return value;
}

function parseCuaDriverLeaseRoute(pathname: string): CuaDriverLeaseRoute | undefined {
  if (pathname === LEASE_COLLECTION_PATH) {
    return { kind: "collection" };
  }
  if (!pathname.startsWith(`${LEASE_COLLECTION_PATH}/`)) {
    return undefined;
  }
  const suffix = pathname.slice(LEASE_COLLECTION_PATH.length + 1);
  const segments = suffix.split("/");
  if (segments.length !== 2) {
    return undefined;
  }
  return {
    kind: "item",
    desktopInstanceEpoch: parsePositiveSafeInteger(segments[0]),
    generation: parsePositiveSafeInteger(segments[1]),
  };
}

function parsePositiveSafeInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value
    ? parsed
    : undefined;
}

function writeMethodNotAllowed(response: ServerResponse, allow: "PUT" | "DELETE"): void {
  response.setHeader("Allow", allow);
  writePrivateJson(response, 405, {
    error: "method_not_allowed",
    message: `Cua Driver lease route supports ${allow} only.`,
  });
}

function writeStaleHandshake(response: ServerResponse): void {
  writePrivateJson(response, 409, {
    accepted: false,
    error: "cua_driver_lease_stale_handshake",
    message: "The lease does not belong to the current authenticated Desktop bridge handshake.",
  });
}

function writePrivateJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.removeHeader("Access-Control-Allow-Origin");
  response.removeHeader("Access-Control-Allow-Methods");
  response.removeHeader("Access-Control-Allow-Headers");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStoreRegistry } from "../runtime/store-registry.js";
import { writeJson } from "./response.js";

export function isAllowedLocalOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) {
    return true;
  }
  try {
    const origin = new URL(originHeader);
    return (origin.protocol === "http:" || origin.protocol === "https:")
      && (origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** User-level services without bearer authentication must stay on the local listener. */
export function allowLocalServiceRequest(request: IncomingMessage, response: ServerResponse): boolean {
  const headers = request.headers;
  const port = request.socket.localPort;
  const localPeer = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  const localHost = port && ["127.0.0.1", "localhost", "[::1]"].some((host) =>
    headers.host === `${host}:${port}` || (port === 80 && headers.host === host));
  let localOrigin = headers.origin === undefined;
  if (headers.origin !== undefined) {
    try {
      localOrigin = isAllowedLocalOrigin(headers.origin) && new URL(headers.origin).origin === headers.origin;
    } catch { localOrigin = false; }
  }
  // Native Node fetch supplies mode=cors alone. Browsers also supply site metadata;
  // reject their missing-Origin navigations/subresource requests before any effects.
  const missingBrowserOrigin = headers.origin === undefined
    && (Object.keys(headers).some((name) => name.startsWith("sec-fetch-") && name !== "sec-fetch-mode")
      || (headers["sec-fetch-mode"] !== undefined && headers["sec-fetch-mode"] !== "cors"));
  const forwarded = Object.keys(headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-"));
  if (!localPeer || !localHost || !localOrigin || missingBrowserOrigin || forwarded) {
    writeJson(response, 403, { error: "local_service_forbidden", message: "This service requires a local Ling page or authenticated daemon access." });
    return false;
  }
  return true;
}

export function allowLocalWorkspaceRequest(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly storeRegistry: RunStoreRegistry;
  readonly cwd?: string;
}): boolean {
  if (!isAllowedLocalOrigin(input.request.headers.origin)) {
    writeJson(input.response, 403, {
      error: "forbidden_origin",
      message: "Workspace file actions are only available from local Ling Stack pages.",
    });
    return false;
  }
  if (input.cwd && !input.storeRegistry.isTrustedWorkspaceRoot(input.cwd)) {
    writeJson(input.response, 403, {
      error: "workspace_not_trusted",
      message: "Workspace file actions are limited to daemon-known workspaces and run directories.",
    });
    return false;
  }
  return true;
}

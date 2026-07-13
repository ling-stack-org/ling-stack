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

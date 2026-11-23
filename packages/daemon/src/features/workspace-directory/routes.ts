import type { IncomingMessage, ServerResponse } from "node:http";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createWorkspaceRegistryStore, registerResolvedWorkspace } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalServiceRequest, isAllowedLocalOrigin } from "../../shared/local-workspace-access.js";
import { writeJson } from "../../shared/response.js";
import {
  selectWorkspaceDirectory,
  WorkspaceDirectoryPickerError,
} from "./directory-picker.js";
import { readJsonBody } from "../../shared/request.js";
import {
  getWorkspaceTerminalProfile,
  parseWorkspaceTerminalCommandRequest,
  runWorkspaceTerminalCommand,
  WorkspaceTerminalCommandError,
} from "./terminal-runner.js";

export async function handleWorkspaceDirectorySelect(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  if (request.method !== "POST") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for workspace directory selection`,
    });
    return;
  }

  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (!isAllowedLocalOrigin(request.headers.origin)) {
    writeJson(response, 403, {
      error: "forbidden_origin",
      message: "Workspace directory selection is only available from local Ling Stack pages.",
    });
    return;
  }

  try {
    let selected = await selectWorkspaceDirectory({ defaultPath: cwd });
    if (!selected.cancelled && selected.path) {
      if (url.searchParams.get("register") === "1") {
        const selectedPath = realpathSync(selected.path);
        registerResolvedWorkspace(selectedPath);
        selected = { ...selected, path: selectedPath };
      }
      storeRegistry.trustWorkspaceRoot(selected.path!);
    }
    writeJson(response, 200, selected);
  } catch (error) {
    if (error instanceof WorkspaceDirectoryPickerError) {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    writeJson(response, 500, {
      error: "directory_picker_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleRegisteredWorkspaces(request: IncomingMessage, response: ServerResponse,
  url: URL, config: ResolvedDaemonConfig, storeRegistry: RunStoreRegistry): Promise<void> {
  if (!allowLocalServiceRequest(request, response)) return;
  const registry = createWorkspaceRegistryStore();
  try {
    if (url.pathname === "/workspaces/registered" && request.method === "GET") {
      const workspaces = [];
      let cursor = "";
      let scanned = 0;
      for (;;) {
        const page = registry.listWorkspaces(cursor, 500);
        scanned += page.length;
        for (const item of page) {
          if (item.archivedAt) continue;
          const available = workspacePathAvailable(item.canonicalCwd, config.defaultWorkspaceCwd, storeRegistry);
          workspaces.push({ workspaceId: item.workspaceId, cwd: item.canonicalCwd, name: item.displayName, available });
        }
        if (page.length < 500 || scanned >= 5_000) break;
        cursor = page.at(-1)!.workspaceId;
      }
      if (!workspaces.some(item => item.cwd === config.defaultWorkspaceCwd)) {
        workspaces.unshift({ workspaceId: "default", cwd: config.defaultWorkspaceCwd,
          name: config.defaultWorkspaceCwd.split(/[\\/]/u).at(-1) ?? config.defaultWorkspaceCwd,
          available: workspacePathAvailable(config.defaultWorkspaceCwd, config.defaultWorkspaceCwd, storeRegistry) });
      }
      writeJson(response, 200, { workspaces });
      return;
    }
    if (url.pathname === "/workspaces/activate" && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
        || typeof (body as { cwd?: unknown }).cwd !== "string") {
        writeJson(response, 400, { error: "bad_request" }); return;
      }
      const cwd = (body as { cwd: string }).cwd;
      const item = registry.getWorkspaceByCanonicalCwd(cwd);
      if (cwd !== config.defaultWorkspaceCwd && !item) { writeJson(response, 404, { error: "workspace_not_registered" }); return; }
      if (!workspacePathAvailable(cwd, config.defaultWorkspaceCwd, storeRegistry)) {
        writeJson(response, 409, { error: "workspace_unavailable" }); return;
      }
      if (cwd !== config.defaultWorkspaceCwd) storeRegistry.trustWorkspaceRoot(cwd);
      writeJson(response, 200, { cwd });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed" });
  } finally { registry.close(); }
}

function workspacePathAvailable(cwd: string, defaultCwd: string, stores: RunStoreRegistry): boolean {
  if (resolve(cwd) !== cwd) return false;
  try {
    const lexical = lstatSync(cwd);
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) return false;
    const physicalPath = realpathSync(cwd);
    return (cwd === defaultCwd ? stores.isTrustedWorkspaceRoot(physicalPath) : true)
      && statSync(physicalPath).isDirectory();
  }
  catch { return false; }
}

export async function handleWorkspaceTerminalCommand(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  if (request.method !== "POST") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for workspace terminal commands`,
    });
    return;
  }

  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (!isAllowedLocalOrigin(request.headers.origin)) {
    writeJson(response, 403, {
      error: "forbidden_origin",
      message: "Workspace terminal commands are only available from local Ling Stack pages.",
    });
    return;
  }

  try {
    const body = parseWorkspaceTerminalCommandRequest(await readJsonBody(request, config.maxBodyBytes));
    writeJson(response, 200, await runWorkspaceTerminalCommand({ cwd, command: body.command }));
  } catch (error) {
    if (error instanceof WorkspaceTerminalCommandError) {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    writeJson(response, 500, {
      error: "terminal_command_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleWorkspaceTerminalProfile(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  if (request.method !== "GET") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for workspace terminal profile`,
    });
    return;
  }

  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (!isAllowedLocalOrigin(request.headers.origin)) {
    writeJson(response, 403, {
      error: "forbidden_origin",
      message: "Workspace terminal profile is only available from local Ling Stack pages.",
    });
    return;
  }

  try {
    writeJson(response, 200, await getWorkspaceTerminalProfile({ cwd }));
  } catch (error) {
    if (error instanceof WorkspaceTerminalCommandError) {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    writeJson(response, 500, {
      error: "terminal_profile_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

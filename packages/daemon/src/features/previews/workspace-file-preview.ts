import { realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { isPathInsideRoot } from "../../shared/path.js";
import { writeJson } from "../../shared/response.js";
import { buildWorkspaceFilePreview } from "./content-preview.js";

export class WorkspaceFileTargetError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "WorkspaceFileTargetError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ResolvedWorkspaceFileTarget {
  readonly workspaceRoot: string;
  readonly contentPath: string;
  readonly displayPath: string;
}

export function resolveWorkspaceFileTarget(cwd: string, requestedPath: string): ResolvedWorkspaceFileTarget {
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(resolvePath(cwd));
  } catch (error) {
    throw new WorkspaceFileTargetError(404, "workspace_not_found", error instanceof Error ? error.message : String(error));
  }

  const lexicalTarget = isAbsolute(requestedPath)
    ? resolvePath(requestedPath)
    : resolvePath(workspaceRoot, requestedPath);
  if (!isPathInsideRoot(workspaceRoot, lexicalTarget)) {
    throw new WorkspaceFileTargetError(403, "workspace_file_outside_root", "Workspace file path is outside the active workspace.");
  }

  let contentPath: string;
  try {
    contentPath = realpathSync(lexicalTarget);
  } catch (error) {
    throw new WorkspaceFileTargetError(404, "workspace_file_not_found", error instanceof Error ? error.message : String(error));
  }
  if (!isPathInsideRoot(workspaceRoot, contentPath)) {
    throw new WorkspaceFileTargetError(403, "workspace_file_outside_root", "Workspace file path resolved outside the active workspace.");
  }
  if (!statSync(contentPath).isFile()) {
    throw new WorkspaceFileTargetError(400, "workspace_file_not_regular", "Workspace file actions are available only for regular files.");
  }
  return {
    workspaceRoot,
    contentPath,
    displayPath: relative(workspaceRoot, contentPath) || basename(contentPath),
  };
}

export async function handleGetWorkspaceFilePreview(response: ServerResponse, url: URL): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  const requestedPath = url.searchParams.get("path")?.trim();
  if (!cwd || !requestedPath) {
    writeJson(response, 400, {
      error: "bad_request",
      message: "cwd and path query parameters are required",
    });
    return;
  }

  try {
    const target = resolveWorkspaceFileTarget(cwd, requestedPath);
    const maxBytes = readOptionalIntegerQuery(url, "maxBytes", 1);
    const focusLine = readOptionalIntegerQuery(url, "line", 1);
    writeJson(response, 200, await buildWorkspaceFilePreview({
      contentPath: target.contentPath,
      displayPath: target.displayPath,
      maxBytes,
      focusLine,
    }));
  } catch (error) {
    const targetError = error instanceof WorkspaceFileTargetError ? error : undefined;
    writeJson(response, targetError?.statusCode ?? 400, {
      error: targetError?.code ?? "workspace_file_preview_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

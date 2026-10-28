import { statSync } from "node:fs";
import { realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath, isAbsolute, relative as relativePath } from "node:path";
import {
  parseDeliverableSpec,
  type DeliverableBuildResponse,
} from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { buildDeliverable } from "./builders.js";
import { extractSpreadsheetSheetWindow, extractSpreadsheetWorkbook } from "./spreadsheet-extract.js";

const DELIVERABLES_DIR = ".ling-stack/deliverables";
const MAX_SPEC_BYTES = 4 * 1024 * 1024;

/**
 * Build a real office file from a versioned spec. Files land in the
 * workspace's .ling-stack/deliverables directory; registering them as run
 * artifacts happens when invoked through the harness tool (follow-up slice).
 */
export async function handleDeliverablesBuild(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Use POST to build a deliverable" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const cwd = url.searchParams.get("cwd") ?? context.config.defaultWorkspaceCwd;
  // Local origin + trusted workspace only: this route writes files, so a
  // foreign page must never reach it on the wildcard-CORS loopback daemon.
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: context.storeRegistry, cwd })) {
    return;
  }
  try {
    const body = await readJsonBody(request, Math.max(context.config.maxBodyBytes, MAX_SPEC_BYTES));
    const parsed = parseDeliverableSpec(body);
    if (!parsed.ok) {
      writeJson(response, 400, { error: "bad_request", message: parsed.reason });
      return;
    }
    const outputDir = resolvePath(isAbsolute(cwd) ? joinWorkspace(cwd, DELIVERABLES_DIR) : joinWorkspace(context.config.defaultWorkspaceCwd, DELIVERABLES_DIR));
    const built = await buildDeliverable(parsed.spec, outputDir);
    const sizeBytes = statSync(built.absolutePath).size;
    const body_: DeliverableBuildResponse = {
      schemaVersion: 1,
      kind: built.kind,
      fileName: built.fileName,
      path: `${DELIVERABLES_DIR}/${built.fileName}`,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    writeJson(response, 201, body_);
  } catch (error) {
    writeJson(response, 500, {
      error: "deliverable_build_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Windowed spreadsheet preview: metadata, then per-sheet windows. */
export async function handleSpreadsheetPreview(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Use GET for spreadsheet previews" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const cwd = url.searchParams.get("cwd") ?? context.config.defaultWorkspaceCwd;
  const path = url.searchParams.get("path");
  if (!path) {
    writeJson(response, 400, { error: "bad_request", message: "path query parameter is required" });
    return;
  }
  // Local origin + trusted workspace only: the wildcard-CORS loopback daemon
  // must not serve workbook bytes to foreign pages or outside workspaces.
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: context.storeRegistry, cwd })) {
    return;
  }
  // Workspace-bound: resolve real paths (symlinks included) and require the
  // target to stay inside the workspace via relative-path containment, which
  // cannot be fooled by sibling directory string prefixes.
  const root = isAbsolute(cwd) ? resolvePath(cwd) : resolvePath(context.config.defaultWorkspaceCwd);
  const resolvedRoot = realpathSync(root);
  const absolute = resolvePath(root, path);
  let realAbsolute: string;
  try {
    realAbsolute = realpathSync(absolute);
  } catch {
    writeJson(response, 400, { error: "bad_request", message: "Spreadsheet file does not exist." });
    return;
  }
  const relative = relativePath(resolvedRoot, realAbsolute);
  if (relative.startsWith("..") || isAbsolute(relative)) {
    writeJson(response, 403, { error: "forbidden", message: "Spreadsheet previews are workspace-bound." });
    return;
  }
  try {
    const sheetParam = url.searchParams.get("sheet");
    if (sheetParam === null) {
      const extraction = await extractSpreadsheetWorkbook(realAbsolute);
      writeJson(response, 200, extraction.workbook);
      return;
    }
    const sheetIndex = Number.parseInt(sheetParam, 10);
    if (!Number.isFinite(sheetIndex) || sheetIndex < 0) {
      writeJson(response, 400, { error: "bad_request", message: "sheet must be a non-negative index" });
      return;
    }
    const number = (name: string): number | undefined => {
      const raw = url.searchParams.get(name);
      if (raw === null) return undefined;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };
    const window = await extractSpreadsheetSheetWindow(realAbsolute, sheetIndex, {
      rowStart: number("rowStart"),
      rowEnd: number("rowEnd"),
      colStart: number("colStart"),
      colEnd: number("colEnd"),
    });
    writeJson(response, 200, window);
  } catch (error) {
    writeJson(response, 400, {
      error: "spreadsheet_preview_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function joinWorkspace(cwd: string, relative: string): string {
  return isAbsolute(cwd) ? resolvePath(cwd, relative) : resolvePath(relative);
}

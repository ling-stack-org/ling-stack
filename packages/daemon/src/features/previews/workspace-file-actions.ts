import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type {
  WorkspaceFileOpenOption,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenTarget,
} from "@ling-stack/contracts";
import { readJsonBody } from "../../shared/request.js";
import { setCorsHeaders, writeJson } from "../../shared/response.js";
import {
  resolveWorkspaceFileTarget,
  WorkspaceFileTargetError,
} from "./workspace-file-preview.js";
import {
  isWorkspaceFileOpenTarget,
  workspaceFileOpenTargetDefinition,
  workspaceFileOpenTargetDefinitions,
  type WorkspaceFileOpenTargetDefinition,
} from "./workspace-file-open-targets.js";
import { loadWorkspaceFileOpenIcon } from "./workspace-file-open-icons.js";

export function handleGetWorkspaceFileOpenOptions(response: ServerResponse, url: URL): void {
  const request = workspaceFileQuery(url);
  if (!request) {
    writeJson(response, 400, { error: "bad_request", message: "cwd and path query parameters are required" });
    return;
  }
  try {
    const target = resolveWorkspaceFileTarget(request.cwd, request.path);
    writeJson(response, 200, {
      cwd: request.cwd,
      path: target.displayPath,
      options: workspaceFileOpenOptions(),
    });
  } catch (error) {
    writeWorkspaceFileError(response, error, "workspace_file_open_options_failed");
  }
}

export async function handleGetWorkspaceFileOpenIcon(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
): Promise<void> {
  if (!isWorkspaceFileOpenTarget(target)) {
    writeJson(response, 404, { error: "workspace_file_open_icon_not_found", message: "Application icon is not available." });
    return;
  }
  try {
    const icon = await loadWorkspaceFileOpenIcon(target);
    if (!icon) {
      writeJson(response, 404, { error: "workspace_file_open_icon_not_found", message: "Application icon is not available." });
      return;
    }
    if (request.headers["if-none-match"] === icon.etag) {
      setCorsHeaders(response);
      response.writeHead(304, { "Cache-Control": "private, no-cache", ETag: icon.etag });
      response.end();
      return;
    }
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(icon.bytes.length),
      "Cache-Control": "private, no-cache",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "ETag": icon.etag,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(icon.bytes);
  } catch {
    writeJson(response, 404, { error: "workspace_file_open_icon_not_found", message: "Application icon is not available." });
  }
}

export async function handlePostWorkspaceFileOpen(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  maxBodyBytes: number,
): Promise<void> {
  const query = workspaceFileQuery(url);
  if (!query) {
    writeJson(response, 400, { error: "bad_request", message: "cwd and path query parameters are required" });
    return;
  }
  try {
    const body = await readJsonBody(request, maxBodyBytes) as Partial<WorkspaceFileOpenRequest>;
    if (!isWorkspaceFileOpenTarget(body.target)) {
      writeJson(response, 400, { error: "bad_request", message: "target must be a supported workspace file open target" });
      return;
    }
    const resolved = resolveWorkspaceFileTarget(query.cwd, query.path);
    const option = workspaceFileOpenOptions().find((candidate) => candidate.id === body.target);
    if (!option?.available) {
      writeJson(response, 409, { error: "workspace_file_open_target_unavailable", message: `${body.target} is not available on this computer.` });
      return;
    }
    await launchWorkspaceFile(body.target, resolved.contentPath, body.line);
    writeJson(response, 200, {
      cwd: query.cwd,
      path: resolved.displayPath,
      target: body.target,
      opened: true,
    });
  } catch (error) {
    writeWorkspaceFileError(response, error, "workspace_file_open_failed");
  }
}

export async function handleGetWorkspaceFileContent(response: ServerResponse, url: URL): Promise<void> {
  const request = workspaceFileQuery(url);
  if (!request) {
    writeJson(response, 400, { error: "bad_request", message: "cwd and path query parameters are required" });
    return;
  }
  try {
    const target = resolveWorkspaceFileTarget(request.cwd, request.path);
    const contentLength = statSync(target.contentPath).size;
    const download = url.searchParams.get("download") === "1";
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(contentLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${basename(target.contentPath).replace(/"/gu, "")}"`,
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(createReadStream(target.contentPath), response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    writeWorkspaceFileError(response, error, "workspace_file_content_failed");
  }
}

function workspaceFileQuery(url: URL): { readonly cwd: string; readonly path: string } | undefined {
  const cwd = url.searchParams.get("cwd")?.trim();
  const path = url.searchParams.get("path")?.trim();
  return cwd && path ? { cwd, path } : undefined;
}

function workspaceFileOpenOptions(): readonly WorkspaceFileOpenOption[] {
  return workspaceFileOpenTargetDefinitions()
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      available: workspaceFileOpenTargetAvailable(definition),
    } satisfies WorkspaceFileOpenOption))
    .filter((option) => option.available);
}

function workspaceFileOpenTargetAvailable(definition: WorkspaceFileOpenTargetDefinition): boolean {
  if (definition.kind === "finder") {
    return process.platform === "darwin";
  }
  if (definition.kind === "terminal") {
    return process.platform === "darwin" || commandAvailable("x-terminal-emulator");
  }
  if (process.platform === "darwin" && definition.macApplication) {
    return macApplicationAvailable(definition.macApplication);
  }
  return definition.command ? commandAvailable(definition.command) : false;
}

function commandAvailable(command: string): boolean {
  return resolveCommandPath(command) !== undefined;
}

function macApplicationAvailable(application: string): boolean {
  return process.platform === "darwin" && spawnSync("/usr/bin/open", ["-Ra", application], { stdio: "ignore" }).status === 0;
}

async function launchWorkspaceFile(target: WorkspaceFileOpenTarget, path: string, line: number | undefined): Promise<void> {
  if (target === "finder") {
    await spawnDetached("/usr/bin/open", ["-R", path]);
    return;
  }
  if (target === "terminal") {
    if (process.platform === "darwin") {
      await spawnDetached("/usr/bin/open", ["-a", "Terminal", dirname(path)]);
      return;
    }
    await spawnDetached("x-terminal-emulator", ["--working-directory", dirname(path)]);
    return;
  }
  const editor = workspaceFileOpenTargetDefinition(target);
  if (editor.kind !== "editor" || !editor.macApplication) {
    throw new Error(`Unsupported workspace file open target: ${target}`);
  }
  const commandPath = editor.command ? resolveCommandPath(editor.command) : undefined;
  if (commandPath) {
    await spawnDetached(commandPath, editorArgs(target, path, line));
    return;
  }
  await spawnDetached("/usr/bin/open", ["-a", editor.macApplication, path]);
}

function editorArgs(target: WorkspaceFileOpenTarget, path: string, line: number | undefined): readonly string[] {
  if (target === "vscode" || target === "cursor") {
    return ["-g", line ? `${path}:${line}` : path];
  }
  if (target === "zed" || target === "sublime_text") {
    return [line ? `${path}:${line}` : path];
  }
  if (target === "xcode") {
    return line ? ["--line", String(line), path] : [path];
  }
  if (target === "pycharm" || target === "webstorm" || target === "intellij") {
    return line ? ["--line", String(line), path] : [path];
  }
  return [path];
}

function resolveCommandPath(command: string): string | undefined {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.split(/\r?\n/gu).map((line) => line.trim()).find(Boolean);
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  if (process.platform === "win32" && /\.(?:bat|cmd)$/iu.test(command)) {
    const commandVariable = "LING_STACK_OPEN_COMMAND";
    const argumentVariables = args.map((_, index) => `LING_STACK_OPEN_ARG_${index}`);
    const invocation = `call "%${commandVariable}%"${argumentVariables.map((name) => ` "%${name}%"`).join("")}`;
    const env = {
      ...process.env,
      [commandVariable]: command,
      ...Object.fromEntries(argumentVariables.map((name, index) => [name, args[index] ?? ""])),
    };
    return spawnDetachedProcess(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", invocation], env);
  }
  return spawnDetachedProcess(command, args);
}

function spawnDetachedProcess(command: string, args: readonly string[], env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { detached: true, env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function writeWorkspaceFileError(response: ServerResponse, error: unknown, fallbackCode: string): void {
  const targetError = error instanceof WorkspaceFileTargetError ? error : undefined;
  writeJson(response, targetError?.statusCode ?? 400, {
    error: targetError?.code ?? fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  });
}

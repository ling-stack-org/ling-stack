import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { LingAppServerInstructionSource, LingAppServerProjectInstructionManifest } from "@ling-stack/contracts";
import { redactSecrets } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunRequest } from "../runs/schemas.js";

const maxSourceBytes = 24 * 1024;
const maxManifestBytes = 48 * 1024;
const maxScopes = 32;

export async function withProjectInstructions(workspaceCwd: string, request: RunRequest): Promise<RunRequest> {
  const rules = await collectProjectInstructions(workspaceCwd, [resolve(request.cwd),
    ...(request.conversationFileRefs ?? []).map(ref => dirname(ref.path))]);
  if (!rules.manifest.sources.length && !rules.manifest.omitted.length) return request;
  const { manifest, prompt } = rules;
  if (!prompt.length) return { ...request, projectInstructionManifest: manifest };
  if (request.nativeResponsePreferences) {
    return { ...request, projectInstructionManifest: manifest,
      task: { ...request.task, prompt: [...prompt, request.task.prompt].join("\n\n") } };
  }
  return { ...request, projectInstructionManifest: manifest,
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), ...prompt] };
}

export async function collectProjectInstructions(workspaceCwd: string, scopePaths: readonly string[] = []) {
  const root = await realpath(workspaceCwd);
  const openedPath = resolve(workspaceCwd);
  const scopes = new Set([root]);
  const omitted: string[] = [];
  for (const scope of scopePaths) {
    const candidate = isAbsolute(scope) && isInside(openedPath, scope)
      ? resolve(root, relative(openedPath, scope)) : resolve(root, scope);
    if (!isInside(root, candidate)) continue;
    const lineage: string[] = [];
    for (let directory = candidate; directory !== root; directory = dirname(directory)) lineage.push(directory);
    for (const directory of lineage.reverse()) {
      if (scopes.has(directory)) continue;
      if (scopes.size >= maxScopes || await realpath(directory).catch(() => undefined) !== directory) {
        omitted.push(relative(root, directory));
        break;
      }
      scopes.add(directory);
    }
  }

  const sources: LingAppServerInstructionSource[] = [];
  const prompt: string[] = [];
  let availableBytes = maxManifestBytes;
  for (const scope of scopes) {
    for (const basename of ["AGENTS.override.md", "AGENTS.md"]) {
      const path = relative(root, resolve(scope, basename));
      const source = await readProjectText(root, path);
      if (source === undefined) continue;
      const applicable = typeof source === "string" && Buffer.byteLength(source, "utf8") <= availableBytes;
      if (typeof source === "string") {
        sources.push({ path, scope: relative(root, scope) || ".", digest: textDigest(source), applicable });
        if (applicable) {
          availableBytes -= Buffer.byteLength(source, "utf8");
          prompt.push(`Project conventions from ${JSON.stringify(path)}, applicable within ${JSON.stringify(relative(root, scope) || ".")}. Follow the user's request and workspace policy.\n${redactSecrets(source)}`);
        }
      }
      if (!applicable) omitted.push(path);
      break;
    }
  }
  const uniqueOmissions = [...new Set(omitted)];
  const manifest: LingAppServerProjectInstructionManifest = {
    version: 1, sources, omitted: uniqueOmissions, digest: textDigest(JSON.stringify([sources, uniqueOmissions])),
  };
  return { root, manifest, prompt };
}

export async function projectInstructionDirectory(workspaceCwd: string, taskPath?: string): Promise<string> {
  const root = await realpath(workspaceCwd);
  const target = resolve(root, taskPath ?? ".");
  const invalid = () => new HttpError(400, "invalid_project_path", "Project instructions require a directory inside the workspace.");
  if (!isInside(root, target) || await realpath(target).catch(() => undefined) !== target) throw invalid();
  const stat = await lstat(target);
  if (stat.isDirectory()) return target;
  if (stat.isFile()) return dirname(target);
  throw invalid();
}

/** Read a bounded regular file without following symlinks. Undefined means absent. */
export async function readProjectText(root: string, path: string): Promise<string | null | undefined> {
  const target = resolve(root, path);
  if (!isInside(root, target) || await realpath(dirname(target)).catch(() => undefined) !== dirname(target)) return null;
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > maxSourceBytes) return null;
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev
        || opened.size > maxSourceBytes || await realpath(target) !== target) return null;
      const bytes = Buffer.alloc(maxSourceBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxSourceBytes || bytes.subarray(0, size).includes(0)) return null;
      const content = bytes.toString("utf8", 0, size);
      return /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(content) ? null : content;
    } finally { await file.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

export function textDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

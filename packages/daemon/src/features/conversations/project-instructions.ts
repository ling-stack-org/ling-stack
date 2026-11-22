import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { LingAppServerInstructionSource, LingAppServerProjectInstructionManifest } from "@ling-stack/contracts";
import { redactSecrets } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunRequest } from "../runs/schemas.js";

const maxSourceBytes = 24 * 1024;
export const maxProjectInstructionBytes = 48 * 1024;
export const maxProjectInstructionScopes = 32;

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

export async function collectProjectInstructions(workspaceCwd: string, scopePaths: readonly string[] = [], limits?: {
  readonly frozenScopes: ReadonlySet<string>;
  readonly remainingBytes: number;
  readonly remainingSources: number;
}) {
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
      if (scopes.size >= maxProjectInstructionScopes || await realpath(directory).catch(() => undefined) !== directory) {
        omitted.push(relative(root, directory));
        break;
      }
      scopes.add(directory);
    }
  }

  const sources: LingAppServerInstructionSource[] = [];
  const prompt: string[] = [];
  let availableBytes = limits?.remainingBytes ?? maxProjectInstructionBytes;
  for (const scope of scopes) {
    const relativeScope = relative(root, scope) || ".";
    if (limits?.frozenScopes.has(relativeScope)) continue;
    for (const basename of ["AGENTS.override.md", "AGENTS.md"]) {
      const path = relative(root, resolve(scope, basename));
      const source = await readProjectText(root, path);
      if (source === undefined) continue;
      const textBytes = typeof source === "string" ? Buffer.byteLength(source, "utf8") : undefined;
      const canRecord = !limits || sources.length < limits.remainingSources;
      const applicable = textBytes !== undefined && textBytes <= availableBytes && canRecord;
      if (typeof source === "string" && canRecord) {
        sources.push({ path, scope: relativeScope, digest: textDigest(source), applicable, textBytes });
        if (applicable) {
          availableBytes -= textBytes;
          prompt.push(`Project conventions from ${JSON.stringify(path)}, applicable within ${JSON.stringify(relativeScope)}. Follow the user's request and workspace policy.\n${redactSecrets(source)}`);
        }
      }
      if (!applicable) omitted.push(path);
      break;
    }
  }
  const manifest = projectInstructionManifest(sources, [...new Set(omitted)]);
  return { root, manifest, prompt };
}

export function projectInstructionManifest(sources: readonly LingAppServerInstructionSource[],
  omitted: readonly string[]): LingAppServerProjectInstructionManifest {
  return { version: 1, sources, omitted, digest: textDigest(JSON.stringify([sources, omitted])) };
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

export function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

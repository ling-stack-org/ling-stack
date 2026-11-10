import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import type { PiRunnerReadonlyToolCallRequest, PiRunnerReadonlyToolName, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";

const profile = "host_readonly_v1";
const maxFileBytes = 1024 * 1024;
const maxTotalBytes = 8 * maxFileBytes;
const maxEntries = 2048;
const maxFiles = 256;
const maxDepth = 16;
const maxOutputBytes = 32 * 1024;
const deniedNames = new Set([".git", ".gitconfig", ".git-credentials", ".npmrc", ".yarnrc", ".netrc", ".pypirc",
  ".ssh", ".aws", ".azure", ".kube", ".gnupg", "id_rsa", "id_ed25519"]);
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

class ReadonlyToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** The Host supplies the frozen root and live fence. Model input can only narrow that scope. */
export async function executeWorkflowReadonlyTool(input: {
  readonly root: string;
  readonly request: PiRunnerReadonlyToolCallRequest;
  readonly assertCurrent: () => void;
}): Promise<PiRunnerToolHandledResult> {
  const { request } = input;
  const deadline = performance.now() + 3000;
  const state = { entries: 0, filesRead: 0, bytesRead: 0, skippedFiles: 0, truncated: false, exhausted: false };
  const check = (): void => {
    request.signal?.throwIfAborted();
    input.assertCurrent();
    request.signal?.throwIfAborted();
    if (performance.now() > deadline) fail("limit", "Readonly tool time budget exceeded.");
  };
  // There is deliberately no write, shell, SDK tool execution, or child-process port here.
  const io = <T>(operation: () => Promise<T>): Promise<T> => { check(); return operation(); };
  try {
    check();
    const params = readParameters(request.toolName, request.input);
    const root = absoluteRoot(input.root);
    const cwd = checkedPath(root, root, request.cwd);
    if (!isAbsolute(request.cwd)) fail("path", "Readonly cwd must be absolute.");
    const target = checkedPath(root, cwd, stringParameter(params, "path", request.toolName === "read" ? undefined : "."));
    if (typeof constants.O_NOFOLLOW !== "number") fail("platform", "No-follow file access is unavailable on this platform.");
    const rootStat = await io(() => lstat(root));
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("root", "Readonly root must be a real directory.");
    const canonicalRoot = await io(() => realpath(root));
    const canonicalStat = await io(() => lstat(canonicalRoot));
    if (!sameFile(rootStat, canonicalStat)) fail("changed", "Readonly root changed during validation.");
    const canonicalTarget = resolve(canonicalRoot, relative(root, target));

    const inspect = async (path: string): Promise<Stats> => {
      const parts = relativeParts(canonicalRoot, path);
      let cursor = canonicalRoot;
      let stat = await io(() => lstat(cursor));
      if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFile(stat, canonicalStat)) {
        fail("changed", "Readonly root changed during execution.");
      }
      for (const [index, part] of parts.entries()) {
        if (blockedName(part)) fail("private_path", "Private configuration and repository state are excluded.");
        cursor = join(cursor, part);
        stat = await io(() => lstat(cursor));
        if (stat.isSymbolicLink()) fail("symlink", "Readonly tools do not follow symlinks.");
        if (index < parts.length - 1 && !stat.isDirectory()) fail("path", "Readonly path parent is not a directory.");
      }
      return stat;
    };
    const cwdStat = await inspect(resolve(canonicalRoot, relative(root, cwd)));
    if (!cwdStat.isDirectory()) fail("path", "Readonly cwd must be a directory.");

    const readText = async (path: string): Promise<string> => {
      const expected = await inspect(path);
      if (!expected.isFile() || expected.nlink !== 1) fail("unsafe_file", "Only non-linked regular text files can be read.");
      if (expected.size > maxFileBytes) fail("file_limit", "Readonly file exceeds the 1 MiB bound.");
      if (state.filesRead >= maxFiles || state.bytesRead + expected.size > maxTotalBytes) {
        fail("read_limit", "Readonly aggregate file budget exceeded.");
      }
      const handle = await io(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try {
        const opened = await io(() => handle.stat());
        if (!opened.isFile() || opened.nlink !== 1 || !sameFile(expected, opened)) fail("changed", "Readonly file changed before opening.");
        const current = await inspect(path);
        if (!sameFile(current, opened)) fail("changed", "Readonly path changed before reading.");
        const buffer = Buffer.alloc(expected.size + 1);
        let used = 0;
        while (used < buffer.length) {
          const { bytesRead } = await io(() => handle.read(buffer, used, buffer.length - used, used));
          if (!bytesRead) break;
          used += bytesRead;
        }
        const after = await io(() => handle.stat());
        if (used !== expected.size || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs) {
          fail("changed", "Readonly file changed while being read.");
        }
        state.filesRead++;
        state.bytesRead += used;
        const bytes = buffer.subarray(0, used);
        if (bytes.includes(0)) fail("binary", "Readonly tools support UTF-8 text only.");
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return fail("binary", "Readonly tools support UTF-8 text only."); }
      } finally { await handle.close(); }
    };

    const entries = async (path: string): Promise<string[]> => {
      const expected = await inspect(path);
      if (!expected.isDirectory()) fail("path", "Readonly listing requires a directory.");
      const directory = await io(() => opendir(path, { bufferSize: 16 }));
      try {
        if (!sameFile(expected, await inspect(path))) fail("changed", "Readonly directory changed before listing.");
        const names: string[] = [];
        while (!state.exhausted) {
          if (state.entries >= maxEntries) { state.truncated = state.exhausted = true; break; }
          const entry = await io(() => directory.read());
          if (!entry) break;
          state.entries++;
          if (!blockedName(entry.name) && !entry.isSymbolicLink()) names.push(entry.name);
        }
        if (!sameFile(expected, await inspect(path))) fail("changed", "Readonly directory changed while listing.");
        return names.sort();
      } finally { await directory.close(); }
    };

    const walk = async function* (path: string, depth = 0): AsyncGenerator<string> {
      for (const name of await entries(path)) {
        const child = join(path, name);
        const stat = await inspect(child);
        if (stat.isFile()) yield child;
        else if (stat.isDirectory() && !state.exhausted) {
          if (depth >= maxDepth) state.truncated = true;
          else yield* walk(child, depth + 1);
        }
      }
    };
    const output = new BoundedOutput();
    const displayPath = (path: string): string => relative(canonicalRoot, path).split(sep).join("/") || ".";
    let count = 0;
    if (request.toolName === "read") {
      const offset = integerParameter(params, "offset", 1, 1_000_000);
      const limit = integerParameter(params, "limit", 200, 1000);
      const lines = (await readText(canonicalTarget)).split(/\r?\n/);
      if (offset > lines.length) fail("offset", "Readonly offset exceeds the file line count.");
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      for (const line of selected) if (!output.add(line)) break;
      count = selected.length;
      state.truncated ||= offset - 1 + selected.length < lines.length;
    } else if (request.toolName === "ls") {
      const limit = integerParameter(params, "limit", 200, 500);
      const names = await entries(canonicalTarget);
      for (const name of names) {
        const stat = await inspect(join(canonicalTarget, name));
        if (!stat.isDirectory() && !stat.isFile()) continue;
        if (count >= limit) { state.truncated = true; break; }
        if (!output.add(name + (stat.isDirectory() ? "/" : ""))) break;
        count++;
      }
    } else {
      const limit = integerParameter(params, "limit", 100, 500);
      const pattern = stringParameter(params, "pattern");
      if (pattern.length > 256 || controlCharacters.test(pattern)) fail("pattern", "Readonly pattern must be bounded and contain no control characters.");
      const glob = request.toolName === "find" ? simpleGlob(pattern) : params.glob === undefined ? undefined : simpleGlob(stringParameter(params, "glob"));
      if (request.toolName === "grep" && params.literal !== true) fail("regex_unsupported", "Readonly grep requires literal:true; regex is unsupported.");
      const ignoreCase = booleanParameter(params, "ignoreCase");
      const context = integerParameter(params, "context", 0, 5, 0);
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      const targetStat = await inspect(canonicalTarget);
      if (request.toolName === "find" && !targetStat.isDirectory()) fail("path", "Readonly find requires a directory.");
      const files = targetStat.isDirectory() ? walk(canonicalTarget) : (async function* () { yield canonicalTarget; })();
      for await (const file of files) {
        check();
        const relativeFile = relative(canonicalTarget, file).split(sep).join("/") || basename(file);
        if (glob && !matchesGlob(relativeFile, glob) && (glob.includes("/") || !matchesGlob(basename(file), glob))) continue;
        if (request.toolName === "find") {
          if (count >= limit) { state.truncated = true; break; }
          if (!output.add(displayPath(file))) break;
          count++;
          continue;
        }
        let text: string;
        try { text = await readText(file); }
        catch (error) {
          if (!(error instanceof ReadonlyToolError)) throw error;
          if (["workflow_readonly_binary", "workflow_readonly_file_limit", "workflow_readonly_unsafe_file"].includes(error.code)) { state.skippedFiles++; continue; }
          if (error.code === "workflow_readonly_read_limit") { state.truncated = true; break; }
          throw error;
        }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          if (index % 256 === 0) check();
          if (!(ignoreCase ? lines[index].toLowerCase() : lines[index]).includes(needle)) continue;
          if (count >= limit) { state.truncated = true; break; }
          count++;
          for (let line = Math.max(0, index - context); line <= Math.min(lines.length - 1, index + context); line++) {
            if (!output.add(`${displayPath(file)}:${line + 1}${line === index ? ":" : "-"}${lines[line]}`)) break;
          }
          if (output.truncated) break;
        }
        if ((state.truncated && count >= limit) || output.truncated) break;
      }
    }
    check();
    state.truncated ||= output.truncated;
    return { content: [{ type: "text", text: output.text(state.truncated) }], details: { profile, count,
      truncated: state.truncated, visitedEntries: state.entries, filesRead: state.filesRead, bytesRead: state.bytesRead, skippedFiles: state.skippedFiles } };
  } catch (error) {
    request.signal?.throwIfAborted();
    // Fence failures remain exceptions, not recoverable model-facing permission results.
    input.assertCurrent();
    if (error instanceof ReadonlyToolError) return failure(error.code, error.message);
    if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))) {
      return failure("workflow_readonly_fs_denied", "Readonly path is unavailable or unsafe.");
    }
    throw error;
  }
}

function fail(code: string, message: string): never { throw new ReadonlyToolError(`workflow_readonly_${code}`, message); }
function failure(code: string, message: string): PiRunnerToolHandledResult {
  return { isError: true, content: [{ type: "text", text: message }], details: { profile, code } };
}
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode; }

function blockedName(name: string): boolean {
  const lower = name.toLowerCase();
  return controlCharacters.test(name) || deniedNames.has(lower) || lower.startsWith(".env")
    || lower === ".ling" || lower.startsWith(".ling.") || lower.startsWith(".ling-")
    || /\.(?:pem|key|p12|pfx)$/.test(lower);
}
function pathString(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || controlCharacters.test(value) || value.includes("\\")) {
    return fail("path", "Readonly path must be a bounded literal path.");
  }
  if (value.split("/").some(part => part.startsWith("@") || part.startsWith("~"))) fail("path_alias", "Readonly tools do not reinterpret @ or ~ paths.");
  return value;
}
function absoluteRoot(value: unknown): string {
  const root = pathString(value);
  if (!isAbsolute(root)) fail("root", "Readonly root must be absolute.");
  return resolve(root);
}
function relativeParts(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("outside_root", "Readonly path is outside the approved root.");
  const parts = rel ? rel.split(sep) : [];
  if (parts.length > 64) fail("path", "Readonly path is too deep.");
  return parts;
}
function checkedPath(root: string, cwd: string, value: unknown): string {
  const literal = pathString(value);
  if (literal.split("/").some(blockedName)) fail("private_path", "Private configuration and repository state are excluded.");
  const target = resolve(cwd, literal);
  relativeParts(root, target);
  return target;
}

function readParameters(tool: PiRunnerReadonlyToolName, value: unknown): Record<string, unknown> {
  const keys: Record<PiRunnerReadonlyToolName, readonly string[]> = {
    read: ["path", "offset", "limit"], ls: ["path", "limit"], find: ["path", "pattern", "limit"],
    grep: ["path", "pattern", "glob", "ignoreCase", "literal", "context", "limit"],
  };
  if (!Object.hasOwn(keys, tool)) fail("tool", "Only read, grep, find and ls are available.");
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail("input", "Readonly input must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("input", "Readonly input must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length > keys[tool].length) fail("input", "Unsupported readonly input fields.");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys[tool].includes(key) || !("value" in descriptors[key])) fail("input", "Unsupported readonly input fields.");
    result[key] = descriptors[key].value;
  }
  return result;
}
function stringParameter(params: Record<string, unknown>, key: string, fallback?: string): string {
  const value = params[key] === undefined ? fallback : params[key];
  if (typeof value !== "string" || !value) return fail("input", `Readonly ${key} must be a nonempty string.`);
  return value;
}
function integerParameter(params: Record<string, unknown>, key: string, fallback: number, max: number, min = 1): number {
  const value = params[key] === undefined ? fallback : params[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail("input", `Readonly ${key} exceeds its integer bounds.`);
  return value;
}
function booleanParameter(params: Record<string, unknown>, key: string): boolean {
  const value = params[key];
  if (value !== undefined && typeof value !== "boolean") fail("input", `Readonly ${key} must be boolean.`);
  return value === true;
}
function simpleGlob(pattern: string): string {
  if (pattern.length > 256 || controlCharacters.test(pattern) || /[\\{}[\]()!|]/.test(pattern)
    || isAbsolute(pattern) || pattern.split("/").some(part => part === ".." || part.startsWith("@") || part.startsWith("~")
      || part !== "**" && (part.match(/[*?]/g)?.length ?? 0) > 2)
    || (pattern.match(/\*\*/g)?.length ?? 0) > 2) {
    fail("glob", "Readonly glob supports bounded literal segments, *, ? and ** only.");
  }
  return pattern;
}

class BoundedOutput {
  private readonly lines: string[] = [];
  private bytes = 0;
  truncated = false;
  add(text: string): boolean {
    const room = maxOutputBytes - 64 - this.bytes - 1;
    const bytes = Buffer.from(text);
    if (bytes.length > room) {
      if (room > 4) this.lines.push(bytes.subarray(0, room - 4).toString("utf8"));
      this.truncated = true;
      return false;
    }
    this.lines.push(text);
    this.bytes += bytes.length + 1;
    return true;
  }
  text(truncated: boolean): string { return this.lines.join("\n") + (truncated ? "\n[Readonly output truncated]" : ""); }
}

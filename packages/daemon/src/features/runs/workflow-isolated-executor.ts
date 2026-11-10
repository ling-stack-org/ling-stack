import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { createHash } from "node:crypto";
import type { PiRunnerIsolatedToolCallRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { prepareBoundedHostText } from "../../runtime/acp/host-text-read.js";
import { HostTextWriteError, prepareBoundedHostWrite, type HostTextWriteOptions } from "../../runtime/acp/host-text-write.js";
import { executeWorkflowReadonlyTool } from "./workflow-readonly-executor.js";

const profile = "host_isolated_files_v1";
const maxBytes = 1024 * 1024;
const privateNames = new Set([".git", ".gitattributes", ".gitmodules", ".gitconfig", ".git-credentials", ".npmrc", ".yarnrc",
  ".netrc", ".pypirc", ".ssh", ".aws", ".azure", ".kube", ".gnupg", "id_rsa", "id_ed25519"]);

class IsolatedToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class WorkflowIsolatedWriteUnknownError extends Error {
  readonly code = "workflow_isolated_write_effect_unknown";
  constructor(options?: ErrorOptions) { super("The isolated file write needs reconciliation before retry.", options); }
}

/** Root and authority come from the Host's ready execution binding, never model input. */
export async function executeWorkflowIsolatedTool(input: {
  readonly root: string;
  readonly request: PiRunnerIsolatedToolCallRequest;
  readonly assertCurrent: () => void;
  readonly hostWrite?: HostTextWriteOptions;
  /** Exact approval preview hashes. An intervening edit must not acquire the old approval. */
  readonly expectedMutation?: { readonly oldSha256?: string; readonly newSha256: string };
}): Promise<PiRunnerToolHandledResult> {
  const { request } = input;
  const signal = request.signal ?? new AbortController().signal;
  const check = (): void => { signal.throwIfAborted(); input.assertCurrent(); signal.throwIfAborted(); };
  if (["read", "grep", "find", "ls"].includes(request.toolName)) {
    return executeWorkflowReadonlyTool({ root: input.root, request: { ...request,
      toolName: request.toolName as "read" | "grep" | "find" | "ls" }, assertCurrent: check });
  }
  let mutated = false;
  try {
    check();
    if (request.toolName !== "write" && request.toolName !== "edit") fail("tool", "This profile only supplies bounded file tools.");
    const params = parameters(request.toolName, request.input);
    const root = literalPath(input.root);
    if (!isAbsolute(root) || resolve(root) !== root || realpathSync.native(root) !== root) fail("root", "The isolated root must be canonical.");
    const rootIdentity = lstatSync(root, { bigint: true });
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) fail("root", "The isolated root is unavailable.");
    if (!isAbsolute(request.cwd)) fail("cwd", "The isolated cwd must be absolute.");
    const cwd = scopedPath(root, root, request.cwd);
    const path = scopedPath(root, cwd, params.path);
    const inspect = (): void => {
      check();
      if (realpathSync.native(root) !== root || !sameDirectory(rootIdentity, lstatSync(root, { bigint: true }))) {
        fail("changed", "The isolated root changed.");
      }
      for (const target of [cwd, path]) {
        const parts = scopedParts(root, target);
        let cursor = root;
        for (const [index, part] of parts.entries()) {
          if (privatePath(part)) fail("private_path", "Repository state and private configuration cannot be written.");
          cursor = join(cursor, part);
          let stat: BigIntStats;
          try { stat = lstatSync(cursor, { bigint: true }); }
          catch (error) {
            if (target === path && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw error;
          }
          if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()
            || target === cwd && !stat.isDirectory()) fail("path", "Isolated tools do not follow symlinks or non-directory parents.");
          if (target === path && index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1n)) {
            fail("file", "Only non-linked regular text files can be written.");
          }
        }
        if (target === path && parts.length === 0) fail("path", "The isolated root is not a file.");
      }
    };
    inspect();
    const retained = prepareBoundedHostText(path, signal, { allowMissing: request.toolName === "write" });
    try {
      check();
      const baseline = retained.read();
      let content: string;
      if (request.toolName === "write") content = text(params.content, true);
      else {
        const edits = exactEdits(params.edits);
        const matches = edits.map(edit => {
          const offset = baseline.content.indexOf(edit.oldText);
          if (offset < 0) fail("edit_missing", "The exact old text was not found.");
          if (baseline.content.indexOf(edit.oldText, offset + 1) !== -1) fail("edit_ambiguous", "The old text must match exactly once.");
          return { start: offset, end: offset + edit.oldText.length, newText: edit.newText };
        }).sort((a, b) => a.start - b.start);
        for (let index = 1; index < matches.length; index++) {
          if (matches[index - 1]!.end > matches[index]!.start) fail("edit_overlap", "Exact replacements must not overlap.");
        }
        content = baseline.content;
        for (const match of matches.reverse()) content = content.slice(0, match.start) + match.newText + content.slice(match.end);
      }
      text(content, true);
      const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
      if (input.expectedMutation && (input.expectedMutation.oldSha256 !== (baseline.missing ? undefined : sha256(baseline.content))
        || input.expectedMutation.newSha256 !== sha256(content))) fail("approval_changed", "The approved file preview changed.");
      inspect();
      baseline.assertUnchanged();
      const writer = prepareBoundedHostWrite(path, signal, baseline, { ...input.hostWrite, assertCurrent: inspect });
      check();
      const receipt = await writer.write(content);
      mutated = true;
      check();
      inspect();
      receipt.assertUnchanged();
      return { content: [{ type: "text", text: request.toolName === "write" ? "File written." : "File edited." }],
        details: { profile, path: relative(root, path).split(sep).join("/"), bytesWritten: Buffer.byteLength(content) } };
    } finally { retained.close(); }
  } catch (error) {
    if (mutated || error instanceof HostTextWriteError && error.outcome === "unknown") {
      throw new WorkflowIsolatedWriteUnknownError({ cause: error });
    }
    check();
    if (error instanceof IsolatedToolError) return rejected(error.code, error.message);
    if (error instanceof HostTextWriteError) return rejected("workflow_isolated_write_unavailable", "The verified Host write executor is unavailable.");
    if (error instanceof Error && error.message === "host_file_read_failed") {
      return rejected("workflow_isolated_file_changed", "The text file is unavailable, changed, or unsafe.");
    }
    if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))) {
      return rejected("workflow_isolated_path_unavailable", "The isolated path is unavailable or unsafe.");
    }
    throw error;
  }
}

function fail(code: string, message: string): never { throw new IsolatedToolError(`workflow_isolated_${code}`, message); }
function rejected(code: string, message: string): PiRunnerToolHandledResult {
  return { isError: true, content: [{ type: "text", text: message }], details: { profile, code } };
}
function sameDirectory(a: BigIntStats, b: BigIntStats): boolean { return b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino; }
function privatePath(part: string): boolean {
  const name = part.normalize("NFC").toLowerCase();
  return privateNames.has(name) || /^\.git(?:$|[ .])/.test(name) || name.startsWith(".env")
    || name === ".ling" || name.startsWith(".ling.") || name.startsWith(".ling-") || /\.(?:pem|key|p12|pfx)$/.test(name);
}
function literalPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f-\x9f\\]/.test(value)
    || value.split("/").some(part => part.startsWith("@") || part.startsWith("~"))) {
    return fail("path", "The isolated path must be a literal public file path.");
  }
  return value;
}
function scopedPath(root: string, cwd: string, value: unknown): string {
  const literal = literalPath(value);
  const local = literal === root ? "" : literal.startsWith(root + sep) ? literal.slice(root.length + 1) : literal;
  if (local.split("/").some(privatePath)) fail("private_path", "Repository state and private configuration cannot be written.");
  const path = resolve(cwd, literal);
  scopedParts(root, path);
  return path;
}
function scopedParts(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("outside_root", "The path is outside this execution binding.");
  const parts = rel ? rel.split(sep) : [];
  if (parts.length > 64) fail("path", "The isolated path is too deep.");
  return parts;
}
function text(value: unknown, empty: boolean): string {
  if (typeof value !== "string" || !empty && !value || value.includes("\0") || Buffer.byteLength(value) > maxBytes
    || Buffer.from(value).toString("utf8") !== value) return fail("text", "File text must be valid UTF-8 within 1 MiB.");
  return value;
}
function parameters(tool: "write" | "edit", value: unknown): Record<string, unknown> {
  return plainFields(value, tool === "write" ? ["path", "content"] : ["path", "edits"]);
}
function plainFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input", "File input must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
  if (Reflect.ownKeys(value).length !== keys.length) fail("input", "File input has unsupported or missing fields.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key) || !("value" in descriptors[key])) fail("input", "File input has unsupported fields.");
    result[key] = descriptors[key].value;
  }
  return result;
}

function exactEdits(value: unknown): readonly { readonly oldText: string; readonly newText: string }[] {
  if (!Array.isArray(value) || types.isProxy(value) || !value.length || value.length > 128) fail("input", "edits must be a bounded nonempty array.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) fail("input", "edits has unsupported fields.");
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) fail("input", "edits must not contain sparse entries or accessors.");
    const edit = plainFields(descriptor.value, ["oldText", "newText"]);
    return { oldText: text(edit.oldText, false), newText: text(edit.newText, true) };
  });
}

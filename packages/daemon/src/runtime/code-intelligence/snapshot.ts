import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const excluded = new Set([".git", ".hg", ".svn", ".ssh", ".aws", ".azure", ".kube", ".gnupg", "node_modules", "dist", "build", "coverage", ".next", "vendor"]);
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/i;
const privateName = /^(?:\.env|\.ling(?:$|[.-]))|\.(?:pem|key|p12|pfx)$/i;
const maxFileBytes = 1024 * 1024;
const maxBytes = 8 * maxFileBytes;
export interface CodeSnapshot {
  readonly root: string;
  readonly files: Record<string, string>;
  readonly digest: string;
  readonly truncated: boolean;
  readonly omitted: number;
  readonly bytes: number;
}

export function workspaceRelativePath(value: unknown, allowRoot = false): string {
  if (typeof value !== "string" || !value || value.length > 4096 || isAbsolute(value)
    || /[\\\u0000-\u001f\u007f-\u009f]/.test(value)
    || value.split("/").some(part => part === ".." || part.startsWith("~") || part.startsWith("@")
      || excluded.has(part.toLowerCase()) || privateName.test(part))) throw new Error("code_intelligence_path_denied");
  const path = value.replace(/^(?:\.\/)+/, "").replace(/\/$/, "") || ".";
  if (path === "." && !allowRoot) throw new Error("code_intelligence_file_required");
  return path;
}

/** Capture regular source files without following links or reading workspace configuration. */
export async function captureCodeSnapshot(input: {
  root: string; scope: string; target?: string; signal?: AbortSignal; assertCurrent: () => void;
}): Promise<CodeSnapshot> {
  const deadline = performance.now() + 5000;
  const check = () => {
    input.signal?.throwIfAborted(); input.assertCurrent(); input.signal?.throwIfAborted();
    if (performance.now() > deadline) throw new Error("code_intelligence_snapshot_timeout");
  };
  check();
  if (!isAbsolute(input.root) || !constants.O_NOFOLLOW) throw new Error("code_intelligence_root_denied");
  const originalRoot = await lstat(input.root);
  if (!originalRoot.isDirectory() || originalRoot.isSymbolicLink()) throw new Error("code_intelligence_root_denied");
  const root = await realpath(input.root);
  const same = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) => a.dev === b.dev && a.ino === b.ino;
  if (!same(originalRoot, await lstat(root))) throw new Error("code_intelligence_root_changed");
  const inspect = async (path: string) => {
    check();
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("code_intelligence_path_denied");
    let cursor = root;
    let stat = await lstat(cursor);
    if (!same(originalRoot, stat) || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("code_intelligence_root_changed");
    for (const part of rel ? rel.split(sep) : []) {
      cursor = join(cursor, part); stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error("code_intelligence_symlink_denied");
    }
    check(); return stat;
  };
  const files: Record<string, string> = Object.create(null);
  let bytes = 0, entries = 0, omitted = 0, truncated = false;
  const add = async (path: string, required = false) => {
    if (Object.hasOwn(files, path)) return;
    const expected = await inspect(path);
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > maxFileBytes) {
      if (required) throw new Error("code_intelligence_unsafe_file");
      omitted++; return;
    }
    if (Object.keys(files).length >= 256 || bytes + expected.size > maxBytes) { truncated = true; omitted++; return; }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !same(expected, opened) || !same(opened, await inspect(path))) {
        throw new Error("code_intelligence_file_changed");
      }
      const buffer = Buffer.alloc(expected.size + 1);
      let used = 0;
      while (used < buffer.length) {
        check(); const read = await handle.read(buffer, used, buffer.length - used, used);
        if (!read.bytesRead) break; used += read.bytesRead;
      }
      const after = await handle.stat();
      if (used !== expected.size || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs
        || after.ctimeMs !== expected.ctimeMs || !same(after, await inspect(path))) throw new Error("code_intelligence_file_changed");
      const content = buffer.subarray(0, used);
      if (content.includes(0)) throw new Error("code_intelligence_binary_file");
      files[path] = new TextDecoder("utf-8", { fatal: true }).decode(content);
      bytes += used;
    } finally { await handle.close(); }
  };
  const scope = resolve(root, workspaceRelativePath(input.scope, true));
  if (!(await inspect(scope)).isDirectory()) throw new Error("code_intelligence_scope_not_directory");
  if (input.target) {
    const target = resolve(root, workspaceRelativePath(input.target));
    const rel = relative(scope, target);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !sourceExtension.test(target)) throw new Error("code_intelligence_target_outside_scope");
    await add(target, true);
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    const expected = await inspect(directory);
    const handle = await opendir(directory, { bufferSize: 16 });
    const children: { name: string; directory: boolean }[] = [];
    try {
      if (!same(expected, await inspect(directory))) throw new Error("code_intelligence_directory_changed");
      for (;;) {
        check();
        if (++entries > 4096) { truncated = true; break; }
        const child = await handle.read(); if (!child) break;
        if (excluded.has(child.name.toLowerCase()) || privateName.test(child.name)) continue;
        if (child.isSymbolicLink()) { omitted++; continue; }
        if (child.isDirectory() || child.isFile() && sourceExtension.test(child.name)) {
          children.push({ name: child.name, directory: child.isDirectory() });
        }
      }
    } finally { await handle.close(); }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      check();
      if (entries > 4096 || Object.keys(files).length >= 256 || bytes >= maxBytes) { truncated = true; break; }
      const path = join(directory, child.name);
      if (child.directory) {
        if (depth >= 16) { truncated = true; omitted++; } else await walk(path, depth + 1);
      } else await add(path);
    }
    if (!same(expected, await inspect(directory))) throw new Error("code_intelligence_directory_changed");
  };
  await walk(scope, 0); check();
  const hash = createHash("sha256");
  for (const file of Object.keys(files).sort()) hash.update(relative(root, file)).update("\0").update(files[file]).update("\0");
  return { root, files, bytes, omitted, truncated: truncated || omitted > 0, digest: `sha256:${hash.digest("hex")}` };
}

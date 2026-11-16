import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { readHookDefinitions, type PiHookSet } from "@ling-stack/runner-pi";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
async function readConfiguration(path: string, userOwned: boolean): Promise<string | undefined> {
  let expected;
  try { expected = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || !expected.isFile() || expected.isSymbolicLink()
    || expected.nlink !== 1 || expected.size > 64 * 1024 || userOwned && (expected.mode & 0o022
      || typeof process.getuid === "function" && expected.uid !== process.getuid())) throw new Error("hooks_configuration_unsafe");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || opened.nlink !== 1 || !opened.isFile()) throw new Error("hooks_configuration_changed");
    const bytes = Buffer.alloc(expected.size + 1);
    let used = 0;
    while (used < bytes.length) { const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
    const after = await file.stat(), current = await lstat(path);
    if (used !== expected.size || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs
      || current.dev !== expected.dev || current.ino !== expected.ino || current.isSymbolicLink()) throw new Error("hooks_configuration_changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally { await file.close(); }
}

function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hooks_configuration_invalid");
  return value as Record<string, unknown>;
}

/** Project configuration only becomes executable when an external user file pins its bytes. */
export async function loadAgentHooks(input: { cwd: string; userRoot?: string }): Promise<PiHookSet | undefined> {
  const userRoot = input.userRoot ?? resolveUserConfigPaths().rootDir;
  const userText = await readConfiguration(join(userRoot, "hooks.json"), true);
  if (userText === undefined) return undefined;
  const root = await realpath(input.cwd), canonicalUserRoot = await realpath(userRoot);
  const rel = relative(root, canonicalUserRoot);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("hooks_user_configuration_inside_workspace");
  const user = object(userText);
  if (user.schemaVersion !== 1 || Object.keys(user).some(key => !["schemaVersion", "hooks", "trustedProjects"].includes(key))) throw new Error("hooks_configuration_invalid");
  const hooks = readHookDefinitions(user.hooks);
  const trust = user.trustedProjects ?? [];
  if (!Array.isArray(trust) || trust.length > 64 || trust.some(value => !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["root", "digest"].includes(key)) || typeof value.root !== "string" || !isAbsolute(value.root)
    || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest))
    || new Set(trust.map(value => value.root)).size !== trust.length) throw new Error("hooks_trust_invalid");
  let projectText = "";
  const selected = trust.find(value => value.root === root);
  if (selected) {
    projectText = await readConfiguration(join(root, ".ling", "hooks.json"), false) ?? "";
    if (digest(projectText) !== selected.digest) throw new Error("hooks_project_trust_changed");
    const project = object(projectText);
    if (project.schemaVersion !== 1 || Object.keys(project).some(key => !["schemaVersion", "hooks"].includes(key))) throw new Error("hooks_configuration_invalid");
    hooks.push(...readHookDefinitions(project.hooks));
  }
  return { schemaVersion: 1, digest: digest(userText + "\0" + projectText), hooks: readHookDefinitions(hooks) };
}

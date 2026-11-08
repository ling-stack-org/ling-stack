import { link, lstat, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { requireCondition, safeRelativePath, sha256 } from "./manifest.mjs";

export async function prepareOutputDir(repoRoot, supplied) {
  const root = await realpath(repoRoot);
  const directory = supplied ? resolve(supplied) : await mkdtemp(join(tmpdir(), "ling-framework-assurance-"));
  const validate = path => {
    const child = relative(root, path);
    requireCondition(child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child),
      "unsafe_output_directory", "Output must be outside the implementation checkout.");
    requireCondition(!path.split(sep).some(part => [".ling-stack", ".git", "node_modules"].includes(part)),
      "unsafe_output_directory", "Output must not target runtime state or dependency directories.");
  };
  validate(directory);
  let ancestor = directory; const missing = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  validate(resolve(ancestor, ...missing));
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  validate(canonical);
  return canonical;
}

export async function publishFile(directory, name, contents) {
  safeRelativePath(name);
  requireCondition(!name.includes("/"), "unsafe_output_directory", "Output filenames must not traverse subdirectories.");
  const target = join(directory, name), temporary = join(directory, `.assurance-${randomUUID()}.tmp`);
  const bytes = Buffer.from(contents);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporary, target); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await lstat(target);
      requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes.length,
        "output_already_exists", "Output already exists with different content.");
      requireCondition(sha256(await readFile(target)) === sha256(bytes), "output_already_exists", "Output already exists with different content.");
    }
  } finally { await unlink(temporary); }
  return target;
}

export const publishJson = (directory, name, value) => publishFile(directory, name, `${JSON.stringify(value, null, 2)}\n`);

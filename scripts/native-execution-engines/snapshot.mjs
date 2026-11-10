import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");

/** Freeze the actual checkout and consumed package dist bytes; never infer build provenance. */
export async function captureSnapshot(repository) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["path", "systemroot", "windir", "systemdrive", "comspec", "pathext"].includes(key.toLowerCase())));
  const git = async args => (await execute("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: repository, maxBuffer: 8 * 1024 * 1024, timeout: 30_000, encoding: "utf8",
    env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } })).stdout;
  const paths = new Set((await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean));
  const builds = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("candidate_snapshot_runtime_symlink");
      if (entry.isDirectory()) await walk(path);
      else builds.push(relative(repository, path));
    }
  };
  for (const entry of await readdir(join(repository, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(repository, "packages", entry.name, "dist");
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink()) throw new Error("candidate_snapshot_runtime_symlink");
      if (info.isDirectory()) await walk(directory);
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const path of builds) paths.add(path);
  const files = [];
  for (const path of [...paths].sort()) {
    const absolute = join(repository, path);
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if (error.code === "ENOENT") { files.push({ path, kind: "absent" }); continue; } throw error; }
    if (info.isSymbolicLink()) { files.push({ path, kind: "symlink", sha256: digest(await readlink(absolute)) }); continue; }
    if (!info.isFile()) throw new Error("candidate_snapshot_file_invalid");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(absolute)) hash.update(bytes);
    const after = await lstat(absolute);
    if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw new Error("candidate_snapshot_changed");
    files.push({ path, kind: "file", bytes: info.size, sha256: hash.digest("hex") });
  }
  const identity = { head: (await git(["rev-parse", "HEAD"])).trim(),
    stagedPatchSha256: digest(await git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"])), files };
  return { ...identity, packageDistEntries: builds.length, fingerprint: digest(JSON.stringify(identity)) };
}

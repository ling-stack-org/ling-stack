import { createHash } from "node:crypto";
import { chmod, lstat, open, readdir, readlink, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const inside = (root, path) => {
  const value = relative(root, path);
  return !value || !isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\");
};
const portable = (value) => value.split("\\").join("/");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

// Only call inside unpublished build staging. Native targets are not rewritten;
// copying a .bin target would break that program's own relative module resolution.
export async function materializeGstackCommandLinks({ runtimeRoot, target }) {
  const requested = resolve(runtimeRoot);
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gstack_command_root_invalid");
  if (!["darwin", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch)) {
    throw new Error("gstack_command_target_invalid");
  }
  const root = await realpath(requested);
  const node = join(root, "tools", `node${target.platform === "win32" ? ".exe" : ""}`);
  const nodeStat = await lstat(node);
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink()) throw new Error("gstack_command_node_missing");
  const changes = [];
  async function scan(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const location = path ? `${path}/${entry.name}` : entry.name;
      const absolute = join(root, location);
      if (entry.isSymbolicLink()) {
        if (!/(?:^|\/)node_modules\/\.bin\/[^/]+$/.test(location)) throw new Error(`gstack_non_command_link:${location}`);
        const destination = await realpath(absolute).catch(() => undefined);
        if (!destination || !inside(root, destination)) throw new Error(`gstack_command_link_escape:${location}`);
        const destinationStat = await lstat(destination);
        if (!destinationStat.isFile()) throw new Error(`gstack_command_target_not_node_script:${location}`);
        const handle = await open(destination, "r");
        let firstLine;
        try {
          const head = Buffer.alloc(256);
          const { bytesRead } = await handle.read(head, 0, head.length, 0);
          firstLine = head.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)[0];
        } finally { await handle.close(); }
        if (!/^#!\s*(?:\/usr\/bin\/env\s+node|\/usr\/bin\/node)\s*$/.test(firstLine)) {
          throw new Error(`gstack_command_target_not_node_script:${location}`);
        }
        const command = portable(relative(dirname(absolute), destination));
        const runtime = portable(relative(dirname(absolute), node));
        const shell = `#!/bin/sh\nd=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd) || exit 1\nexec "$d"/${quote(runtime)} "$d"/${quote(command)} "$@"\n`;
        let windows;
        if (target.platform === "win32") {
          if (/[\r\n%"!&|<>^]/.test(command + runtime)) throw new Error("gstack_command_windows_path_unsafe");
          if (await lstat(`${absolute}.cmd`).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) {
            throw new Error(`gstack_command_windows_wrapper_exists:${location}`);
          }
          windows = `@echo off\r\n"%~dp0${runtime.replaceAll("/", "\\")}" "%~dp0${command.replaceAll("/", "\\")}" %*\r\n`;
        }
        changes.push({ absolute, location, destination: portable(relative(root, destination)),
          original: await readlink(absolute), shell, windows });
      } else if (entry.isDirectory()) await scan(location);
      else if (!entry.isFile()) throw new Error(`gstack_command_resource_kind_invalid:${location}`);
    }
  }
  await scan("");
  const records = [];
  for (const change of changes) {
    if (await readlink(change.absolute) !== change.original) throw new Error("gstack_command_link_changed");
    await unlink(change.absolute);
    await writeFile(change.absolute, change.shell, { flag: "wx", mode: 0o755 });
    await chmod(change.absolute, 0o755);
    const paths = [change.location];
    if (change.windows) {
      await writeFile(`${change.absolute}.cmd`, change.windows, { flag: "wx" });
      paths.push(`${change.location}.cmd`);
    }
    records.push({ path: change.location, target: change.destination, generatedPaths: paths,
      checksum: `sha256:${createHash("sha256").update(change.shell).digest("hex")}` });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

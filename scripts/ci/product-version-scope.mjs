import { execFileSync } from "node:child_process";
import { releaseVersion } from "../release/desktop-release.mjs";

const paths = ["VERSION", "package.json"];

/**
 * Verify the version embedded in Web builds from the same Git trees as the PR
 * diff. Desktop packaging validates its own product version inputs.
 * @param {{root: string, base: string, head: string, files: string[]}} input
 */
export function inspectProductVersionChange({ root, base, head, files }) {
  const changed = paths.filter(path => files.includes(path));
  if (!changed.length) return undefined;

  function read(ref, path) {
    try {
      const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
      const entry = execFileSync("git", ["ls-tree", ref, "--", path], options);
      if (!/^100644 blob /u.test(entry)) return undefined;
      const source = execFileSync("git", ["show", `${ref}:${path}`], options);
      if (path === "VERSION") return { version: source.trim(), metadata: "" };
      const { version, ...metadata } = JSON.parse(source);
      return { version, metadata: JSON.stringify(metadata) };
    } catch {
      return undefined;
    }
  }

  const current = new Map(paths.map(path => [path, read(head, path)]));
  const version = current.get("VERSION")?.version;
  if (typeof version !== "string" || current.get("package.json")?.version !== version) return undefined;
  try { releaseVersion(`v${version}`); } catch { return undefined; }
  for (const path of changed) {
    const previous = read(base, path);
    const next = current.get(path);
    if (typeof previous?.version !== "string" || previous.version === next.version
      || previous.metadata !== next.metadata) return undefined;
  }
  return { version, paths: changed };
}

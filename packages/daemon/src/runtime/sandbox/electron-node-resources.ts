import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readdirSync, readSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

/** These are Electron's own bundle resources, never project files or arbitrary read roots. */
export const ELECTRON_NODE_RESOURCE_PATHS = [
  "Info.plist", "Frameworks/Electron Framework.framework", "Frameworks/Squirrel.framework",
  "Frameworks/ReactiveObjC.framework", "Frameworks/Mantle.framework",
] as const;
export interface ElectronNodeResourcePin { readonly relativePath: string; readonly sha256: string }
export interface ElectronNodeRuntimePin {
  readonly kind: "electron_node_v1";
  readonly resources: readonly ElectronNodeResourcePin[];
}
function requireResource(value: unknown, code = "electron_node_resource_invalid"): asserts value {
  if (!value) throw new Error(code);
}
function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith("../") && !isAbsolute(value);
}
const identity = (stat: Stats) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(":");

/**
 * Content/structure digest for one fixed runtime bundle resource. This is only
 * integrity evidence; the caller must obtain expected pins from trusted Host boot.
 * Framework aliases may point inside their own root, but never escape it.
 */
export function digestElectronNodeResource(root: string): string {
  requireResource(isAbsolute(root) && realpathSync(root) === root);
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  let entries = 0, bytes = 0;
  const walk = (path: string, depth: number): void => {
    requireResource(++entries <= 1024 && depth <= 16, "electron_node_resource_budget");
    const before = lstatSync(path);
    requireResource((before.isSymbolicLink() || (before.mode & 0o022) === 0)
      && (before.uid === 0 || before.uid === process.getuid?.()));
    const name = relative(root, path);
    if (before.isSymbolicLink()) {
      const target = readlinkSync(path);
      requireResource(path !== root && !isAbsolute(target) && inside(root, realpathSync(path)), "electron_node_resource_alias_escape");
      hash.update(JSON.stringify(["link", name, target]) + "\n");
    } else if (before.isDirectory()) {
      hash.update(JSON.stringify(["directory", name, before.mode & 0o777]) + "\n");
      for (const child of readdirSync(path).sort()) walk(join(path, child), depth + 1);
    } else {
      requireResource(before.isFile() && before.nlink === 1 && before.size <= 512 * 1024 * 1024);
      requireResource((bytes += before.size) <= 512 * 1024 * 1024, "electron_node_resource_budget");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), content = createHash("sha256");
      try {
        requireResource(identity(fstatSync(fd)) === identity(before), "electron_node_resource_changed");
        let offset = 0;
        for (;;) {
          const size = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset + 1), offset);
          if (!size) break;
          offset += size;
          requireResource(offset <= before.size, "electron_node_resource_changed");
          content.update(buffer.subarray(0, size));
        }
        requireResource(offset === before.size && identity(fstatSync(fd)) === identity(before), "electron_node_resource_changed");
      } finally { closeSync(fd); }
      hash.update(JSON.stringify(["file", name, before.mode & 0o777, before.size, content.digest("hex")]) + "\n");
    }
    requireResource(identity(lstatSync(path)) === identity(before), "electron_node_resource_changed");
  };
  walk(root, 0);
  return hash.digest("hex");
}

/** Resolve only the five fixed resources beside the already-pinned App executable. */
export function verifyElectronNodeResources(executable: string, pin: ElectronNodeRuntimePin): {
  readonly readRoots: readonly string[]; readonly resourceIdentitySha256: string;
} {
  requireResource(pin && Object.keys(pin).sort().join(",") === "kind,resources" && pin.kind === "electron_node_v1"
    && Array.isArray(pin.resources) && pin.resources.length === ELECTRON_NODE_RESOURCE_PATHS.length);
  const contents = dirname(dirname(executable));
  requireResource(basename(dirname(executable)) === "MacOS" && basename(contents) === "Contents"
    && basename(dirname(contents)).endsWith(".app") && realpathSync(contents) === contents);
  const readRoots: string[] = [], basis: ElectronNodeResourcePin[] = [];
  for (const relativePath of ELECTRON_NODE_RESOURCE_PATHS) {
    const matches = pin.resources.filter(item => item?.relativePath === relativePath);
    requireResource(matches.length === 1 && Object.keys(matches[0]!).sort().join(",") === "relativePath,sha256"
      && /^[a-f0-9]{64}$/u.test(matches[0]!.sha256));
    const path = join(contents, relativePath);
    requireResource(realpathSync(path) === path && inside(contents, path), "electron_node_resource_alias_escape");
    requireResource(digestElectronNodeResource(path) === matches[0]!.sha256, "electron_node_resource_changed");
    readRoots.push(path); basis.push({ relativePath, sha256: matches[0]!.sha256 });
  }
  return { readRoots, resourceIdentitySha256: createHash("sha256").update(JSON.stringify(basis)).digest("hex") };
}

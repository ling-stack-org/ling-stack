import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { readReviewedPackagedOfficeSource } from "./packaged-office-native-review.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const packageNames = Object.freeze(["browser-host", "contracts", "core", "daemon", "localization",
  "plugin-sdk", "providers", "remote-protocol", "runner-pi"]);
const identityKeys = Object.freeze(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const maximumFileBytes = 8 * 1024 * 1024;
const maximumTotalBytes = 128 * 1024 * 1024;
const namespace = "ling-reviewed-workspace-source";
const resolutionOrigin = Symbol("original-workspace-source-resolution");
function requireSource(value) { if (!value) throw new Error("packaged_office_daemon_source_input_invalid"); }
function same(actual, original) { return identityKeys.every(key => actual[key] === original[key]); }
function inside(path, root) {
  const local = relative(root, path);
  return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}
function packageName(path) {
  const parts = relative(repositoryRoot, path).split(sep);
  if (parts[0] !== "packages") return undefined;
  requireSource(packageNames.includes(parts[1]));
  return parts[1];
}
function safeSegments(path) {
  requireSource(typeof path === "string" && !/[\\%?#\0]/u.test(path)
    && path.split("/").every(part => part && part !== "." && part !== ".." && part !== "node_modules"));
}

/** Read only the reviewed bytes through a bounded, no-follow FD, with complete identity fences. */
function capture(path, expectedHash, original) {
  const before = lstatSync(path, { bigint: true });
  requireSource(realpathSync(path) === path && before.isFile() && !before.isSymbolicLink()
    && before.uid === BigInt(process.getuid()) && before.nlink === 1n && (before.mode & 0o022n) === 0n
    && before.size > 0n && before.size <= BigInt(maximumFileBytes) && (!original || same(before, original)));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    requireSource(same(fstatSync(fd, { bigint: true }), before));
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0, attempts = 0;
    while (offset < bytes.length) {
      requireSource(attempts++ < Math.ceil(bytes.length / 65536) + 32);
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      requireSource(count > 0); offset += count;
    }
    requireSource(readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) === 0 && same(fstatSync(fd, { bigint: true }), before));
  } finally { closeSync(fd); }
  requireSource(realpathSync(path) === path && same(lstatSync(path, { bigint: true }), before)
    && hash(bytes) === expectedHash);
  return { bytes, identity: before };
}

/**
 * Office-only input projection. No caller review/manifest/path or origin issuer.
 * Workspace code comes from privately retained reviewed authored bytes, never
 * dist. Vendor resolution remains esbuild's responsibility and a separate gate.
 */
export function createReviewedOfficeDaemonSourceInputs() {
  const { review, sourceReviewSha256 } = readReviewedPackagedOfficeSource();
  const snapshots = new Map(), used = new Set(), packages = new Map();
  let totalBytes = 0, complete = false;
  function snapshot(path) {
    requireSource(!complete && isAbsolute(path) && resolve(path) === path && inside(path, repositoryRoot));
    const name = relative(repositoryRoot, path).split(sep).join("/");
    requireSource(Object.hasOwn(review.packagingSha256, name));
    if (!snapshots.has(path)) {
      const value = capture(path, review.packagingSha256[name]);
      totalBytes += value.bytes.length; requireSource(totalBytes <= maximumTotalBytes && snapshots.size < 2048);
      snapshots.set(path, value);
    }
    return snapshots.get(path);
  }
  for (const name of packageNames) {
    const root = resolve(repositoryRoot, "packages", name);
    const json = JSON.parse(snapshot(resolve(root, "package.json")).bytes.toString("utf8"));
    requireSource(json.name === `@ling-stack/${name}` && json.type === "module");
    packages.set(name, { root, json });
    const config = JSON.parse(snapshot(resolve(root, "tsconfig.json")).bytes.toString("utf8"));
    const options = config.compilerOptions;
    // These existing NodeNext/ES2022 configs have no runtime-rewriting options.
    // Reject future changes instead of silently dropping decorators/aliases/etc.
    const allowedOptions = ["declaration", "lib", "module", "moduleResolution", "outDir", "rootDir",
      "skipLibCheck", "strict", "target", "types"];
    requireSource(Object.keys(config).every(key => ["compilerOptions", "include"].includes(key))
      && options && Object.keys(options).every(key => allowedOptions.includes(key))
      && options.module === "NodeNext" && options.moduleResolution === "NodeNext" && options.target === "ES2022"
      && options.outDir === "dist" && options.rootDir === "src" && options.strict === true
      && JSON.stringify(config.include) === '["src/**/*.ts"]');
  }
  // Bind the complete reviewer-owned workspace snapshot before any native
  // builder or asynchronous resolver runs. Never adopt a same-bytes replacement
  // just because its first runtime load happens later in the bundle.
  for (const name of Object.keys(review.packagingSha256)) {
    if (!name.startsWith("packages/")) continue;
    const path = resolve(repositoryRoot, name);
    requireSource(packageName(path));
    snapshot(path);
  }
  function authored(path) {
    const name = packageName(path);
    requireSource(name);
    const root = packages.get(name).root;
    let local = relative(root, path).split(sep).join("/");
    if (local.startsWith("dist/")) local = "src/" + local.slice(5);
    requireSource(local.startsWith("src/") && !local.endsWith(".d.ts"));
    const stem = local.replace(/\.(?:js|mjs|cjs)$/u, "");
    const candidates = /\.(?:js|mjs|cjs)$/u.test(local)
      ? [stem + ".ts", stem + ".mts", stem + ".cts", local] : [local];
    const found = candidates.map(value => resolve(root, value)).filter(value =>
      Object.hasOwn(review.packagingSha256, relative(repositoryRoot, value).split(sep).join("/")));
    requireSource(found.length === 1);
    return found[0];
  }
  function exportTarget(value) {
    if (typeof value === "string") return value;
    requireSource(value && typeof value === "object" && !Array.isArray(value));
    for (const [condition, target] of Object.entries(value)) {
      if (["import", "node", "default"].includes(condition)) return exportTarget(target);
    }
    throw new Error("packaged_office_daemon_source_export_invalid");
  }
  function workspaceExport(specifier) {
    safeSegments(specifier);
    const match = /^@ling-stack\/([a-z-]+)(\/.*)?$/u.exec(specifier);
    requireSource(match && packages.has(match[1]));
    const { root, json } = packages.get(match[1]), key = "." + (match[2] ?? "");
    let target;
    if (json.exports !== undefined) {
      const exports = json.exports;
      if (typeof exports === "string" || (exports && typeof exports === "object"
        && Object.keys(exports).every(value => !value.startsWith(".")))) {
        requireSource(key === "."); target = exportTarget(exports);
      } else {
        requireSource(exports && typeof exports === "object" && !Array.isArray(exports));
        if (Object.hasOwn(exports, key)) target = exportTarget(exports[key]);
        else {
          const matches = Object.keys(exports).filter(pattern => {
            const pieces = pattern.split("*");
            return pieces.length === 2 && key.startsWith(pieces[0]) && key.endsWith(pieces[1])
              && key.length >= pieces[0].length + pieces[1].length;
          });
          requireSource(matches.length === 1);
          const [start, end] = matches[0].split("*");
          const replacement = key.slice(start.length, key.length - end.length);
          target = exportTarget(exports[matches[0]]).replaceAll("*", replacement);
        }
      }
    } else { requireSource(key === "."); target = json.main; }
    requireSource(typeof target === "string" && target.startsWith("./"));
    safeSegments(target.slice(2));
    requireSource(inside(resolve(root, target), root));
    return authored(resolve(root, target));
  }
  function loadSource(path) {
    requireSource(authored(path) === path);
    const value = snapshot(path); used.add(path);
    const extension = path.split(".").at(-1);
    requireSource(["ts", "mts", "cts", "js", "mjs", "cjs", "json"].includes(extension));
    const contents = value.bytes.toString("utf8");
    requireSource(Buffer.from(contents).equals(value.bytes));
    return { contents, loader: ["mts", "cts"].includes(extension) ? "ts"
      : ["mjs", "cjs"].includes(extension) ? "js" : extension, resolveDir: dirname(path) };
  }
  const plugin = {
    name: namespace,
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === resolutionOrigin) return;
        requireSource(!complete);
        let path;
        if (args.path.startsWith("@ling-stack/")) path = workspaceExport(args.path);
        else if (isAbsolute(args.path) && inside(args.path, resolve(repositoryRoot, "packages"))) path = authored(args.path);
        else if (isAbsolute(args.path) && args.importer && packageName(args.importer)) path = authored(args.path);
        else if (args.path.startsWith(".") && args.importer && packageName(args.importer)) {
          path = authored(resolve(dirname(args.importer), args.path));
        } else {
          // Third-party imports retain native esbuild resolution (including
          // optional dependencies and package sideEffects). Any workspace
          // back-edge is still caught by onLoad and the actual metafile fence.
          if (args.importer && !packageName(args.importer)) return;
          const result = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir,
            kind: args.kind, namespace: args.namespace, pluginData: resolutionOrigin });
          // Preserve esbuild's default try/catch optional-dependency handling.
          // Returning resolver errors here would turn optional vendor imports
          // into fatal plugin errors; workspace inputs never use this fallback.
          if (result.errors.length) return;
          requireSource(!result.suffix && (!result.namespace || result.namespace === "file"));
          if (result.external) {
            requireSource(isBuiltin(result.path));
            return { path: result.path, external: true };
          }
          const physical = realpathSync(result.path);
          if (inside(physical, resolve(repositoryRoot, "packages"))) path = authored(physical);
          else {
            requireSource(!inside(physical, repositoryRoot) || inside(physical, resolve(repositoryRoot, "node_modules")));
            return { path: result.path, namespace: "file" };
          }
        }
        return { path, namespace: "file" };
      });
      builder.onLoad({ filter: /.*/ }, args => {
        if (inside(args.path, resolve(repositoryRoot, "packages"))) return loadSource(args.path);
        requireSource(!inside(args.path, repositoryRoot) || inside(args.path, resolve(repositoryRoot, "node_modules")));
      });
    },
  };
  function assertOriginalInputs(result) {
    requireSource(!complete && result.metafile?.inputs && used.size > 0);
    requireSource(Object.keys(result.metafile.inputs).length <= 8192);
    const observed = new Set();
    for (const name of Object.keys(result.metafile.inputs)) {
      requireSource(!name.includes("\0") && (isAbsolute(name) || !name.includes(":")));
      const path = resolve(desktopRoot, name);
      if (!inside(path, resolve(repositoryRoot, "packages"))) {
        requireSource(!inside(path, repositoryRoot) || inside(path, resolve(repositoryRoot, "node_modules")));
        continue;
      }
      requireSource(authored(path) === path && used.has(path)); observed.add(path);
    }
    requireSource(observed.size === used.size && [...used].every(path => observed.has(path)));
    for (const [path, value] of snapshots) {
      capture(path, hash(value.bytes), value.identity);
    }
    requireSource(readReviewedPackagedOfficeSource().sourceReviewSha256 === sourceReviewSha256);
    complete = true;
  }
  return Object.freeze({ entryPoint: resolve(repositoryRoot, "packages/daemon/src/cli.ts"), plugin, loadSource,
    sourceReviewSha256, assertOriginalInputs,
    // Explicit config excludes esbuild's implicit tsconfig lookup. Runtime
    // semantics match the admitted ES2022/NodeNext workspace compiler configs.
    tsconfigRaw: Object.freeze({ compilerOptions: Object.freeze({ target: "ES2022", useDefineForClassFields: true }) }),
  });
}

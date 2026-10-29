import { build } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFreshRestrictedCommandHelperPublication, readOriginalRestrictedCommandBuildPublication } from "./build-restricted-command-helper.mjs";
import { buildFreshPackagedOfficeNativePublication, readOriginalPackagedOfficeNativePublication,
  readActiveOriginalPackagedOfficeNativePublication } from "./build-packaged-office-native.mjs";
import { createReviewedOfficeDaemonSourceInputs } from "./packaged-office-daemon-source-inputs.mjs";
import { preparePackagedGstackBuild, packagedGstackIdentityPlugin } from "./packaged-gstack-resources.mjs";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const emittedCliPath = resolve(desktopRoot, "dist/daemon/cli.mjs");
const emittedBundles = new WeakMap();
const maximumCliBytes = 64n * 1024n * 1024n;
let bundling = false;

function requireBundle(value) {
  if (!value) throw new Error("packaged_office_native_emitted_bundle_invalid");
}
function sameCli(actual, original) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"]
    .every(key => actual[key] === original[key]);
}
function readEmittedCli(original, path = emittedCliPath) {
  const before = lstatSync(path, { bigint: true });
  requireBundle(before.isFile() && !before.isSymbolicLink() && realpathSync(path) === path
    && before.uid === BigInt(process.getuid()) && before.nlink === 1n && (before.mode & 0o022n) === 0n
    && before.size > 0n && before.size <= maximumCliBytes && (!original || sameCli(before, original)));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    requireBundle(sameCli(fstatSync(fd, { bigint: true }), before));
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0, attempts = 0;
    const maximumAttempts = Math.ceil(bytes.length / 65536) + 32;
    while (offset < bytes.length) {
      requireBundle(attempts++ < maximumAttempts);
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      requireBundle(count > 0); offset += count;
    }
    requireBundle(readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) === 0
      && sameCli(fstatSync(fd, { bigint: true }), before));
  } finally { closeSync(fd); }
  requireBundle(realpathSync(path) === path && sameCli(lstatSync(path, { bigint: true }), before));
  return { original: before, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Copy the unique real esbuild result before any subsequent publication read or path observation. */
function pinOriginalBuildOutput(result) {
  requireBundle(Array.isArray(result.outputFiles) && result.outputFiles.length === 1);
  const output = result.outputFiles[0];
  requireBundle(output.path === emittedCliPath && output.contents instanceof Uint8Array
    && output.contents.byteLength > 0 && BigInt(output.contents.byteLength) <= maximumCliBytes);
  const bytes = Buffer.from(output.contents);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Publish only the private API-result bytes, never adopt the contents of an already-present outfile. */
function publishOriginalBuildOutput(output) {
  const directory = dirname(emittedCliPath), directories = [desktopRoot, resolve(desktopRoot, "dist"), directory];
  const observations = directories.map((path, index) => {
    if (index > 0) {
      try { lstatSync(path); }
      catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
        mkdirSync(path, { mode: 0o700 });
      }
    }
    requireBundle(realpathSync(path) === path);
    const stat = lstatSync(path, { bigint: true });
    requireBundle(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid())
      && (stat.mode & 0o022n) === 0n);
    return { path, stat };
  });
  const temporary = join(directory, `.office-daemon-next-${randomUUID()}.mjs`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let staged, published = false, primaryFailed = false, primaryFailure;
  try {
    try {
      staged = fstatSync(fd, { bigint: true });
      let offset = 0, attempts = 0;
      const maximumAttempts = Math.ceil(output.bytes.length / 65536) + 32;
      while (offset < output.bytes.length) {
        requireBundle(attempts++ < maximumAttempts);
        const count = writeSync(fd, output.bytes, offset, Math.min(65536, output.bytes.length - offset), offset);
        requireBundle(count > 0); offset += count;
      }
      fsyncSync(fd); staged = fstatSync(fd, { bigint: true });
    } finally { closeSync(fd); }
    const beforeRename = readEmittedCli(staged, temporary);
    requireBundle(beforeRename.sha256 === output.sha256 && staged.size === BigInt(output.bytes.length));
    for (const { path, stat } of observations) {
      const current = lstatSync(path, { bigint: true });
      requireBundle(realpathSync(path) === path && ["dev", "ino", "mode", "uid", "gid"].every(key => current[key] === stat[key]));
    }
    renameSync(temporary, emittedCliPath); published = true;
    const copied = readEmittedCli();
    requireBundle(copied.sha256 === output.sha256 && ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs"]
      .every(key => copied.original[key] === staged[key]));
    for (const { path, stat } of observations) {
      const current = lstatSync(path, { bigint: true });
      requireBundle(realpathSync(path) === path && ["dev", "ino", "mode", "uid", "gid"].every(key => current[key] === stat[key]));
    }
    return copied;
  } catch (cause) {
    primaryFailed = true; primaryFailure = cause;
    throw cause;
  } finally {
    if (!published) {
      try {
        const current = lstatSync(temporary, { bigint: true });
        requireBundle(staged && current.dev === staged.dev && current.ino === staged.ino);
        unlinkSync(temporary);
      } catch (cleanupFailure) {
        if (primaryFailed) throw new AggregateError([primaryFailure, cleanupFailure],
          "packaged_office_native_emitted_bundle_and_cleanup_failed");
        throw cleanupFailure;
      }
    }
  }
}

/**
 * Original active publication only. This exposes immutable byte pins, not a
 * Buffer, receipt issuer, caller-selected path or reconstructable provenance.
 * The original emitted file is rechecked; no changed file refreshes its pins.
 */
export function readActiveOriginalPackagedOfficeDaemonBundle() {
  const publication = readActiveOriginalPackagedOfficeNativePublication();
  const owned = emittedBundles.get(publication);
  requireBundle(owned && readOriginalPackagedOfficeNativePublication(owned.token) === publication);
  requireBundle(readEmittedCli(owned.original).sha256 === owned.pins.sha256
    && readActiveOriginalPackagedOfficeNativePublication() === publication);
  return owned.pins;
}

/** Ordinary developer build; the environment signals intent, never artifact or approval identity. */
export async function buildPackagedDaemon() {
  const required = process.env.LING_PACKAGED_CODESIGN_REVIEW_REQUIRED === "1";
  if (required && (process.platform !== "darwin" || process.arch !== "arm64")) {
    throw new Error("packaged_codesign_review_target_unsupported");
  }
  await bundleOriginalDaemon(() => ({
    codesignReceipt: required ? buildFreshRestrictedCommandHelperPublication() : undefined,
    officeReceipt: undefined,
  }));
}

/** Fixed mac packaging entry: both original publications are created in this process. */
export async function buildFreshPackagedDaemonForMacOffice() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("packaged_office_native_review_target_unsupported");
  }
  return await bundleOriginalDaemon(() => {
    // Missing Office review must not invoke the other helper's compiler first.
    const sourceInputs = createReviewedOfficeDaemonSourceInputs();
    const officeReceipt = buildFreshPackagedOfficeNativePublication();
    const codesignReceipt = buildFreshRestrictedCommandHelperPublication();
    return { codesignReceipt, officeReceipt, sourceInputs };
  });
}

async function bundleOriginalDaemon(prepareOriginals) {
  if (bundling) throw new Error("packaged_daemon_bundle_busy");
  bundling = true;
  try {
    const { codesignReceipt, officeReceipt, sourceInputs } = prepareOriginals();
    await buildOriginalDaemonBundle(codesignReceipt, officeReceipt, sourceInputs);
    return officeReceipt;
  }
  finally { bundling = false; }
}

async function buildOriginalDaemonBundle(codesignReceipt, officeReceipt, sourceInputs) {
  requireBundle(Boolean(officeReceipt) === Boolean(sourceInputs));
  const gstackIdentity = await preparePackagedGstackBuild({
    required: Boolean(officeReceipt) && process.env.LING_PACKAGED_RELEASE_REVIEW_REQUIRED === "1",
  });
  const gstack = packagedGstackIdentityPlugin({ identity: gstackIdentity, sourceInputs });
  const definitions = [
    {
      name: "codesign", suffix: /packaged-codesign-published-review\.js$/,
      module: "packaged-codesign-published-review.js",
      declaration: "embeddedPublishedReviewJson", sentinel: "NO_PACKAGED_CODESIGN_REVIEW",
      receipt: codesignReceipt, read: readOriginalRestrictedCommandBuildPublication,
    },
    {
      name: "office_native", suffix: /packaged-office-native-published-review\.js$/,
      module: "packaged-office-native-published-review.js",
      declaration: "embeddedPublishedOfficeReviewJson", sentinel: "NO_PACKAGED_OFFICE_NATIVE_REVIEW",
      receipt: officeReceipt, read: readOriginalPackagedOfficeNativePublication,
    },
  ].map(item => ({ ...item, visits: 0,
    reviewModule: realpathSync(resolve(desktopRoot, `../../packages/daemon/${sourceInputs ? "src" : "dist"}/runtime/sandbox`,
      sourceInputs ? item.module.replace(/\.js$/u, ".ts") : item.module)),
    marker: `const ${item.declaration}${sourceInputs ? ": string" : ""} = "${item.sentinel}";`,
    publication: item.receipt ? item.read(item.receipt) : undefined,
  }));
  if (sourceInputs) requireBundle(definitions.find(item => item.name === "office_native").publication.sourceReviewSha256
    === sourceInputs.sourceReviewSha256);
  const result = await build({
    absWorkingDir: desktopRoot, entryPoints: [sourceInputs?.entryPoint ?? "../../packages/daemon/dist/cli.js"],
    bundle: true, platform: "node", format: "esm", outfile: "dist/daemon/cli.mjs",
    ...(sourceInputs ? { write: false, metafile: true, tsconfigRaw: sourceInputs.tsconfigRaw, target: "es2022" } : {}),
    banner: { js: 'import { createRequire as __lingCreateRequire } from "node:module"; const require = __lingCreateRequire(import.meta.url);' },
    plugins: [gstack.plugin, ...definitions.map(item => ({
      name: `original-${item.name}-review-literal`,
      setup(plugin) {
        plugin.onLoad({ filter: sourceInputs ? new RegExp(item.suffix.source.replace("\\.js", "\\.ts")) : item.suffix }, args => {
          if (realpathSync(args.path) !== item.reviewModule) throw new Error(`packaged_${item.name}_review_module_changed`);
          item.visits++;
          const source = sourceInputs ? sourceInputs.loadSource(item.reviewModule).contents : readFileSync(item.reviewModule, "utf8");
          if (source.split(item.marker).length !== 2) throw new Error(`packaged_${item.name}_review_marker_changed`);
          const contents = item.publication ? source.replace(item.marker,
            `const ${item.declaration}${sourceInputs ? ": string" : ""} = ${JSON.stringify(JSON.stringify(item.publication))};`) : source;
          return { contents, loader: sourceInputs ? "ts" : "js", resolveDir: resolve(item.reviewModule, "..") };
        });
      },
    })), ...(sourceInputs ? [sourceInputs.plugin] : [])],
  });
  const originalOutput = officeReceipt ? pinOriginalBuildOutput(result) : undefined;
  gstack.assertIncluded();
  sourceInputs?.assertOriginalInputs(result);
  for (const item of definitions) {
    if (item.receipt && item.visits !== 1) throw new Error(`packaged_${item.name}_review_module_not_bundled`);
    const after = item.receipt ? item.read(item.receipt) : undefined;
    if (JSON.stringify(after) !== JSON.stringify(item.publication)) {
      throw new Error(`packaged_${item.name}_publication_changed_during_bundle`);
    }
  }
  if (officeReceipt) {
    const publication = definitions.find(item => item.name === "office_native").publication;
    requireBundle(readOriginalPackagedOfficeNativePublication(officeReceipt) === publication);
    const { original, sha256 } = publishOriginalBuildOutput(originalOutput);
    requireBundle(readOriginalPackagedOfficeNativePublication(officeReceipt) === publication);
    const identity = Object.freeze(Object.fromEntries(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"]
      .map(key => [key, String(original[key])])));
    const pins = Object.freeze({ evidenceKind: "original_emitted_cli_byte_pins_only", path: emittedCliPath,
      sizeBytes: Number(original.size), sha256, identity });
    emittedBundles.set(publication, { token: officeReceipt, original, pins });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("packaged_daemon_build_arguments_invalid");
  await buildPackagedDaemon();
}

import { build } from "esbuild";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFreshRestrictedCommandHelperPublication, readOriginalRestrictedCommandBuildPublication } from "./build-restricted-command-helper.mjs";
import { buildFreshPackagedOfficeNativePublication, readOriginalPackagedOfficeNativePublication } from "./build-packaged-office-native.mjs";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

/** Ordinary developer build; the environment signals intent, never artifact or approval identity. */
export async function buildPackagedDaemon() {
  const required = process.env.LING_PACKAGED_CODESIGN_REVIEW_REQUIRED === "1";
  if (required && (process.platform !== "darwin" || process.arch !== "arm64")) {
    throw new Error("packaged_codesign_review_target_unsupported");
  }
  const receipt = required ? buildFreshRestrictedCommandHelperPublication() : undefined;
  await bundleOriginalDaemon(receipt, undefined);
}

/** Fixed mac packaging entry: both original publications are created in this process. */
export async function buildFreshPackagedDaemonForMacOffice() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("packaged_office_native_review_target_unsupported");
  }
  // Missing Office review must not invoke the other helper's compiler first.
  const officeReceipt = buildFreshPackagedOfficeNativePublication();
  const codesignReceipt = buildFreshRestrictedCommandHelperPublication();
  await bundleOriginalDaemon(codesignReceipt, officeReceipt);
  return officeReceipt;
}

async function bundleOriginalDaemon(codesignReceipt, officeReceipt) {
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
    reviewModule: realpathSync(resolve(desktopRoot, "../../packages/daemon/dist/runtime/sandbox", item.module)),
    marker: `const ${item.declaration} = "${item.sentinel}";`,
    publication: item.receipt ? item.read(item.receipt) : undefined,
  }));
  await build({
    absWorkingDir: desktopRoot, entryPoints: ["../../packages/daemon/dist/cli.js"],
    bundle: true, platform: "node", format: "esm", outfile: "dist/daemon/cli.mjs",
    banner: { js: 'import { createRequire as __lingCreateRequire } from "node:module"; const require = __lingCreateRequire(import.meta.url);' },
    plugins: definitions.map(item => ({
      name: `original-${item.name}-review-literal`,
      setup(plugin) {
        plugin.onLoad({ filter: item.suffix }, args => {
          if (realpathSync(args.path) !== item.reviewModule) throw new Error(`packaged_${item.name}_review_module_changed`);
          item.visits++;
          const source = readFileSync(item.reviewModule, "utf8");
          if (source.split(item.marker).length !== 2) throw new Error(`packaged_${item.name}_review_marker_changed`);
          const contents = item.publication ? source.replace(item.marker,
            `const ${item.declaration} = ${JSON.stringify(JSON.stringify(item.publication))};`) : source;
          return { contents, loader: "js", resolveDir: resolve(item.reviewModule, "..") };
        });
      },
    })),
  });
  for (const item of definitions) {
    if (item.receipt && item.visits !== 1) throw new Error(`packaged_${item.name}_review_module_not_bundled`);
    const after = item.receipt ? item.read(item.receipt) : undefined;
    if (JSON.stringify(after) !== JSON.stringify(item.publication)) {
      throw new Error(`packaged_${item.name}_publication_changed_during_bundle`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("packaged_daemon_build_arguments_invalid");
  await buildPackagedDaemon();
}

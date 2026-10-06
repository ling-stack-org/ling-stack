import { build } from "esbuild";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFreshRestrictedCommandHelperPublication, readOriginalRestrictedCommandBuildPublication } from "./build-restricted-command-helper.mjs";

if (process.argv.length !== 2) throw new Error("packaged_daemon_build_arguments_invalid");
const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const required = process.env.LING_PACKAGED_CODESIGN_REVIEW_REQUIRED === "1";
if (required && (process.platform !== "darwin" || process.arch !== "arm64")) throw new Error("packaged_codesign_review_target_unsupported");
// The only required receipt comes from this same trusted process's fixed fresh
// pipeline, never a file/env/old CLI stdout. Ordinary dev/Windows obtains none.
const receipt = required ? buildFreshRestrictedCommandHelperPublication() : undefined;
const publication = receipt ? readOriginalRestrictedCommandBuildPublication(receipt) : undefined;
const reviewModule = realpathSync(resolve(desktopRoot, "../../packages/daemon/dist/runtime/sandbox/packaged-codesign-published-review.js"));
const marker = 'const embeddedPublishedReviewJson = "NO_PACKAGED_CODESIGN_REVIEW";';
await build({
  absWorkingDir: desktopRoot, entryPoints: ["../../packages/daemon/dist/cli.js"],
  bundle: true, platform: "node", format: "esm", outfile: "dist/daemon/cli.mjs",
  banner: { js: 'import { createRequire as __lingCreateRequire } from "node:module"; const require = __lingCreateRequire(import.meta.url);' },
  plugins: [{
    name: "original-codesign-review-literal",
    setup(plugin) {
      plugin.onLoad({ filter: /packaged-codesign-published-review\.js$/ }, args => {
        if (realpathSync(args.path) !== reviewModule) throw new Error("packaged_codesign_review_module_changed");
        const source = readFileSync(reviewModule, "utf8");
        if (source.split(marker).length !== 2) throw new Error("packaged_codesign_review_marker_changed");
        const contents = publication ? source.replace(marker,
          "const embeddedPublishedReviewJson = " + JSON.stringify(JSON.stringify(publication)) + ";") : source;
        return { contents, loader: "js", resolveDir: resolve(reviewModule, "..") };
      });
    },
  }],
});
// Packaging inputs must still match the literal just embedded. No self-issued
// trust receipt is accepted from runtime JSON or ordinary build stdout.
const after = receipt ? readOriginalRestrictedCommandBuildPublication(receipt) : undefined;
if (JSON.stringify(after) !== JSON.stringify(publication)) throw new Error("packaged_codesign_publication_changed_during_bundle");

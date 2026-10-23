import { lstat, readFile, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readExecutableBundle } from "../../../scripts/gstack/executable-bundle.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const selectionFile = resolve(desktopRoot, "../../.ling-stack/build/gstack-desktop-selection.json");
let active;

/** The build selects external immutable resources; no full tree is staged in the repository. */
export async function preparePackagedGstackBuild({ required = false, selectionPath = selectionFile } = {}) {
  let selection;
  try {
    if ((await lstat(selectionPath)).size > 16 * 1024) throw new Error("packaged_gstack_build_selection_invalid");
    selection = JSON.parse(await readFile(selectionPath, "utf8"));
  }
  catch (error) { if (error.code === "ENOENT" && !required && !active) return undefined; throw error; }
  if (typeof selection.root !== "string" || !selection.identity || await realpath(selection.root) !== selection.root) throw new Error("packaged_gstack_build_selection_invalid");
  const bundle = await readExecutableBundle(selection.root, selection.identity);
  if (bundle.identity.target.platform !== process.platform || bundle.identity.target.arch !== process.arch) throw new Error("packaged_gstack_build_target_mismatch");
  if (active && (active.root !== bundle.root || !isDeepStrictEqual(active.identity, bundle.identity))) throw new Error("packaged_gstack_build_selection_changed");
  active = bundle;
  return bundle.identity;
}
export function packagedGstackBuilderConfig() {
  if (!active) return {};
  // Builder's directory walker skips these names before applying any filter.
  // Explicit file sets preserve only entries already authenticated by the full
  // selected manifest; the post-copy complete inventory/hash guard stays intact.
  const exactFiles = active.source.manifest.files
    .filter(file => [".gitkeep", ".DS_Store"].includes(basename(file.path)))
    .map(file => ({ from: join(active.root, file.path), to: `gstack/${file.path}` }));
  const extraResources = [{ from: active.root, to: "gstack", filter: ["**/*"] },
    { from: active.browser.root, to: "gstack-browser", filter: ["**/*"] }, ...exactFiles];
  // Builder interprets macros in both fields, even for authenticated literal
  // paths. Refuse before copying, not after a rewritten path has caused effects.
  if (extraResources.some(file => file.from.includes("${") || file.to.includes("${"))) {
    throw new Error("packaged_gstack_builder_path_macro_unsupported");
  }
  return { extraResources,
    extraMetadata: { lingPackagedGstack: active.identity },
    mac: { signIgnore: ["/[Rr]esources/gstack(?:-browser)?/"] } };
}
export async function verifyPackagedGstack(context) {
  const declared = context.packager?.config?.extraMetadata?.lingPackagedGstack;
  if (!active) {
    if (declared) throw new Error("packaged_gstack_build_selection_missing");
    return;
  }
  if (!isDeepStrictEqual(declared, active.identity)) throw new Error("packaged_gstack_metadata_identity_changed");
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents/Resources")
    : join(context.appOutDir, "resources");
  await readExecutableBundle(join(resources, "gstack"), active.identity);
  // Pin the original selected bytes again after the copying/signing phase.
  await readExecutableBundle(active.root, active.identity);
}

export function packagedGstackIdentityPlugin({ identity, sourceInputs, desktopRoot: root = desktopRoot }) {
  let visits = 0;
  const module = resolve(root, `../../packages/daemon/${sourceInputs ? "src" : "dist"}/features/skills/packaged-identity.${sourceInputs ? "ts" : "js"}`);
  const marker = `const embeddedBundledGstackJson${sourceInputs ? ": string" : ""} = "NO_PACKAGED_GSTACK_IDENTITY";`;
  return { plugin: { name: "build-owned-packaged-gstack-identity", setup(build) {
    build.onLoad({ filter: /features\/skills\/packaged-identity\.(?:ts|js)$/ }, async args => {
      if (await realpath(args.path) !== module) throw new Error("packaged_gstack_identity_module_changed");
      visits++;
      const source = sourceInputs ? sourceInputs.loadSource(module).contents : await readFile(module, "utf8");
      if (source.split(marker).length !== 2) throw new Error("packaged_gstack_identity_marker_changed");
      return { contents: identity ? source.replace(marker,
        `const embeddedBundledGstackJson${sourceInputs ? ": string" : ""} = ${JSON.stringify(JSON.stringify(identity))};`) : source,
        loader: sourceInputs ? "ts" : "js", resolveDir: dirname(module) };
    });
  } }, assertIncluded() {
    if (identity && visits !== 1) throw new Error("packaged_gstack_identity_not_bundled");
  } };
}

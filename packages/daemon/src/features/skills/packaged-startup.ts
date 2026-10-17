import { basename, dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { verifyBundledBrowser } from "@ling-stack/core/bundled-skill-browser";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { prepareBundledSkillStartup } from "./bundled-startup.js";
import { readPackagedGstackIdentity } from "./packaged-identity.js";
import { installPackagedSkillRuntime } from "./packaged-runtime.js";
import { retainPackagedSkillGeneration } from "./packaged-history.js";

/** The desktop owns discovery. No workspace, environment path or system install fallback. */
export async function preparePackagedGstackStartup() {
  const identity = readPackagedGstackIdentity();
  if (!identity) {
    if (process.env.LING_STACK_PACKAGED_DESKTOP === "1") throw new Error("packaged_gstack_identity_missing");
    return undefined;
  }
  if (identity.target.platform !== process.platform || identity.target.arch !== process.arch) {
    throw new Error("packaged_gstack_target_mismatch");
  }
  const executable = process.execPath;
  if (await realpath(executable) !== executable || !process.versions.electron) throw new Error("packaged_gstack_host_invalid");
  let resources: string;
  if (process.platform === "darwin") {
    const macos = dirname(executable), contents = dirname(macos);
    if (basename(macos) !== "MacOS" || basename(contents) !== "Contents" || !basename(dirname(contents)).endsWith(".app")) {
      throw new Error("packaged_gstack_host_invalid");
    }
    resources = join(contents, "Resources");
  } else if (process.platform === "win32") resources = join(dirname(executable), "resources");
  else throw new Error("packaged_gstack_host_invalid");
  const rootPath = join(resources, "gstack");
  return prepareBundledSkillStartup({ rootPath,
    expectedManifestChecksum: identity.manifestChecksum, expectedUpstreamRevision: identity.upstreamRevision,
    expectedAdaptationRevision: identity.adaptationRevision, expectedTarget: identity.target, expectedSkillIds: identity.skillIds },
    async source => {
      const receipt = JSON.parse(await source.readResource("executable-build.json"));
      const browser = verifyBundledBrowser(join(resources, "gstack-browser"), receipt.browser?.componentChecksum, identity.target);
      const cache = join(resolveUserConfigPaths().sourcesDir, "bundled-gstack");
      const generations = await retainPackagedSkillGeneration(cache, { rootPath,
        expectedManifestChecksum: source.manifestChecksum, expectedUpstreamRevision: identity.upstreamRevision,
        expectedAdaptationRevision: identity.adaptationRevision, expectedTarget: identity.target,
        expectedSkillIds: identity.skillIds }, browser.root);
      installPackagedSkillRuntime(generations.current, generations.retained);
    });
}

import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { verifyBundledBrowser } from "../../packages/core/dist/bundled-skill-browser.js";
import { prepareBundledSkillStartup } from "../../packages/daemon/dist/features/skills/bundled-startup.js";
import { retainPackagedSkillGeneration } from "../../packages/daemon/dist/features/skills/packaged-history.js";
import { installPackagedSkillRuntime } from "../../packages/daemon/dist/features/skills/packaged-runtime.js";

const base = dirname(fileURLToPath(import.meta.url));
const selected = JSON.parse(await readFile(new URL("../../.ling-stack/build/gstack-desktop-selection.json", import.meta.url)));
const resources = fileURLToPath(new URL("../../apps/desktop/release/human-qa/mac-arm64/Ling Stack Human QA.app/Contents/Resources/", import.meta.url));
const rootPath = join(resources, "gstack");
const scratch = await mkdtemp(join(base, "p2-full-bootstrap-probe-"));
const selection = { rootPath, expectedManifestChecksum: selected.identity.manifestChecksum,
  expectedUpstreamRevision: selected.identity.upstreamRevision, expectedAdaptationRevision: selected.identity.adaptationRevision,
  expectedTarget: selected.identity.target, expectedSkillIds: selected.identity.skillIds };
const start = performance.now();
let admittedAt;
const initializer = await prepareBundledSkillStartup(selection, async source => {
  admittedAt = performance.now();
  const receipt = JSON.parse(await source.readResource("executable-build.json"));
  const browser = verifyBundledBrowser(join(resources, "gstack-browser"), receipt.browser?.componentChecksum, selected.identity.target);
  const generations = await retainPackagedSkillGeneration(join(scratch, "cache"), {
    ...selection, expectedManifestChecksum: source.manifestChecksum }, browser.root);
  installPackagedSkillRuntime(generations.current, generations.retained);
});
console.log(JSON.stringify({ schemaVersion: 1, kind: "isolated-real-resource-bootstrap-not-gui",
  scratch, manifestChecksum: selected.identity.manifestChecksum, elapsedMs: performance.now() - start,
  initialAuthenticationMs: admittedAt - start, initializerPrepared: typeof initializer === "function",
  externalProviderCalls: 0, originalQaProfileChanged: false }, null, 2));

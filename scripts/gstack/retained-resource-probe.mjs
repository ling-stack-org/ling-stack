import assert from "node:assert/strict";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readExecutableBundle } from "./executable-bundle.mjs";
import { requireResourceLease, resourceCheckpoint, resourceTreeBytes, within } from "./resource-workspace.mjs";
import { retainPackagedSkillGeneration } from "../../packages/daemon/dist/features/skills/packaged-history.js";
import { installPackagedSkillRuntime, restorePackagedSkillContext, packagedSkillEnvironment }
  from "../../packages/daemon/dist/features/skills/packaged-runtime.js";

const [work, phase, selectionPath] = process.argv.slice(2), cache = join(work, "cache");
const lease = await requireResourceLease();
if (resolve(work) !== work || !within(lease.scratchPath, work) || work === lease.scratchPath
  || await realpath(work) !== work) throw new Error("gstack_retained_probe_work_outside_scratch");
await resourceCheckpoint(lease.root, phase === "retain-real" ? 2300 * 1024 ** 2 : 1024 ** 2);
if (phase === "retain-real") {
  const bundle = await readExecutableBundle(process.env.LING_GSTACK_EXECUTABLE_BUNDLE);
  const selection = { rootPath: bundle.root, expectedManifestChecksum: bundle.identity.manifestChecksum,
    expectedUpstreamRevision: bundle.identity.upstreamRevision, expectedAdaptationRevision: bundle.identity.adaptationRevision,
    expectedTarget: bundle.identity.target, expectedSkillIds: bundle.identity.skillIds };
  const { current } = await retainPackagedSkillGeneration(cache, selection, bundle.browser.root);
  const contexts = bundle.source.manifest.skills.map(skill => current.bind({
    skillId: skill.id, sourceKind: "gstack-skill-directory", loaded: true, truncated: false,
    sourceChecksum: bundle.source.manifest.files.find(file => file.path === skill.entryPath).checksum,
    referencedFiles: [{ path: "manifest.json", checksum: bundle.identity.manifestChecksum }],
  }));
  assert.equal(contexts.length, 57);
  await writeFile(join(work, "frozen-contexts.json"), JSON.stringify({ contexts, browserChecksum: bundle.browser.checksum }));
  console.log(JSON.stringify({ phase, bound: contexts.length, copies: 1,
    manifestChecksum: bundle.identity.manifestChecksum, files: bundle.source.manifest.files.length }));
} else if (phase === "reopen") {
  assert.equal(process.env.LING_GSTACK_EXECUTABLE_BUNDLE, undefined);
  assert.equal(process.env.LING_GSTACK_BROWSER_ROOT, undefined);
  const selection = JSON.parse(await readFile(selectionPath));
  const generations = await retainPackagedSkillGeneration(cache, selection);
  installPackagedSkillRuntime(generations.current, generations.retained);
  const { contexts, browserChecksum } = JSON.parse(await readFile(join(work, "frozen-contexts.json")));
  const restored = [];
  for (const context of contexts) {
    assert.deepEqual(restorePackagedSkillContext(structuredClone(context), context.skillId), context);
    const environment = packagedSkillEnvironment(context, work);
    assert.equal(environment.GSTACK_ROOT, join(cache, context.resourceBinding.manifestChecksum.slice(7), "gstack/runtime"));
    restored.push(context.skillId);
  }
  assert.equal(generations.retained.length, 1);
  assert.equal(generations.retained[0].browser.checksum, browserChecksum);
  generations.retained[0].browser.assertCurrent();
  const before = { names: (await readdir(cache)).sort(), bytes: await resourceTreeBytes(cache) };
  const reused = await retainPackagedSkillGeneration(cache, selection);
  assert.deepEqual({ names: (await readdir(cache)).sort(), bytes: await resourceTreeBytes(cache) }, before);
  assert.equal(before.names.length, 2);
  assert.equal(reused.retained[0].manifestChecksum, contexts[0].resourceBinding.manifestChecksum);
  const historicalRoot = join(cache, contexts[0].resourceBinding.manifestChecksum.slice(7));
  const manifest = JSON.parse(await readFile(join(historicalRoot, "gstack/manifest.json")));
  const browserManifest = JSON.parse(await readFile(join(historicalRoot, "gstack-browser/browser-component.json")));
  console.log(JSON.stringify({ phase, restored, browserChecksum, hashVerifiedFiles: manifest.files.length,
    authenticatedBrowserFiles: browserManifest.files.length, frameworkLinks: browserManifest.links.length,
    generationCount: 2, reuseBytesUnchanged: true,
    originalSelectionAbsentInChild: true, originalPhysicalResourcesRemoved: false, runnerDispatches: 0 }));
} else throw new Error("unknown retained-resource phase");

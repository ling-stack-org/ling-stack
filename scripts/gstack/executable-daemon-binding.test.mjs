import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../packages/core/dist/index.js";
import { readExecutableBundle } from "./executable-bundle.mjs";
import { prepareBundledSkillStartup } from "../../packages/daemon/dist/features/skills/bundled-startup.js";
import { PackagedSkillRuntime, bindPackagedSkillContext, installPackagedSkillRuntime,
  restorePackagedSkillContext } from "../../packages/daemon/dist/features/skills/packaged-runtime.js";
import { prepareRunSkillSource } from "../../packages/daemon/dist/features/runs/skill-source-context.js";

const root = process.env.LING_GSTACK_EXECUTABLE_BUNDLE;
test("the complete candidate registers all 57 real sources and pins prepared and frozen task contexts", {
  skip: !root && "requires complete executable candidate and managed execution", timeout: 180000,
}, async t => {
  const bundle = await readExecutableBundle(root);
  const work = await mkdtemp(join(tmpdir(), "ling-gs-real-binding-"));
  const store = createSqliteRunStore(work);
  t.after(async () => { store.close(); await rm(work, { recursive: true, force: true }); });
  const initialize = await prepareBundledSkillStartup({ rootPath: root,
    expectedManifestChecksum: bundle.identity.manifestChecksum,
    expectedUpstreamRevision: bundle.identity.upstreamRevision,
    expectedAdaptationRevision: bundle.identity.adaptationRevision,
    expectedTarget: bundle.identity.target, expectedSkillIds: bundle.identity.skillIds }, source => {
    installPackagedSkillRuntime(new PackagedSkillRuntime(root, source, bundle.browser));
  });
  initialize(store); initialize(store);
  assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 57);
  const boundIds = [];
  for (const id of bundle.identity.skillIds) {
    const context = prepareRunSkillSource(store, id, "no_operation").context;
    assert.equal(context.loaded, true, id);
    assert.equal(context.truncated, false, id);
    const bound = bindPackagedSkillContext(context);
    assert.equal(bound.resourceBinding.manifestChecksum, bundle.identity.manifestChecksum, id);
    assert.deepEqual(restorePackagedSkillContext(structuredClone(bound), id), bound);
    assert.throws(() => restorePackagedSkillContext({ ...context, resourceBinding: undefined }, id),
      { statusCode: 409, code: "packaged_skill_resource_binding_missing" });
    assert.throws(() => restorePackagedSkillContext({ ...bound, resourceBinding: {
      ...bound.resourceBinding, adaptationRevision: "unavailable-old-generation" } }, id),
      { statusCode: 409, code: "packaged_skill_resource_version_unavailable" });
    boundIds.push(id);
  }
  const proof = { schemaVersion: 1, scope: "actual-daemon-source-registration-and-context-binding-not-installed-client",
    identity: bundle.identity, registered: boundIds.length, preparedAndRestored: boundIds,
    restartAddedSnapshots: 0, missingOrUnavailableBindingRejected: true,
    userModelCalls: 0, releaseEligible: false,
    pending: ["task-tool-execution-in-installed-client", "historical-resource-resolution", "windows"] };
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/executable-daemon-binding-proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`);
  t.diagnostic(JSON.stringify({ registered: boundIds.length, identity: bundle.identity.manifestChecksum }));
});

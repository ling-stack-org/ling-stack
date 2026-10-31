import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectExecutableBrowserInputs, verifyBrowserInspectionPins } from "./collect-executable-browser-inputs.mjs";
import { localBrowserPin } from "./materialize-local-browser.mjs";

function inspection() {
  return { readonlyMountDetached: true, transport: { checksum: localBrowserPin.transportChecksum },
    inventoryChecksum: localBrowserPin.inventoryChecksum, browserVersion: localBrowserPin.version, target: localBrowserPin.target };
}
test("browser inspection admission preserves all fixed bytes, target and true detach evidence", () => {
  verifyBrowserInspectionPins(inspection());
  for (const delta of [{ readonlyMountDetached: false }, { transport: {} }, { inventoryChecksum: "changed" },
    { browserVersion: "newer" }, { target: { platform: "darwin", arch: "x64" } }]) {
    assert.throws(() => verifyBrowserInspectionPins({ ...inspection(), ...delta }), /detach_unknown|not_reproducible/);
  }
});

async function fixture(t, inspect) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-browser-generation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchPath = join(root, "runs/current"), outputPath = join(root, "artifacts/browser/inputs");
  await mkdir(scratchPath, { recursive: true });
  const key = `browserGeneration${randomUUID().replaceAll("-", "")}`;
  let acquisitions = 0;
  globalThis[key] = {
    managedResourceWrite: async () => ({ root, scratchPath }), resourceCheckpoint: async () => {},
    collectGstackBrowserArchives: async ({ outputPath: path }) => {
      acquisitions++; await mkdir(path); await writeFile(join(path, "browser-archives.json"), "archives"); return { archives: ["fixture"] };
    },
    collectUngoogledChromiumCandidate: async ({ outputPath: path }) => {
      acquisitions++; await mkdir(path); await writeFile(join(path, "ungoogled-candidate.json"), "candidate");
    },
    inspectUngoogledDmg: async options => {
      assert.ok(options.outputPath.startsWith(join(root, "artifacts/browser/.gstack-browser-inputs-")));
      assert.ok(!options.outputPath.startsWith(scratchPath));
      await mkdir(options.outputPath); await writeFile(join(options.outputPath, "ungoogled-inspection.json"), "inspection");
      return inspect(options);
    },
  };
  const sourceUrl = new URL("./collect-executable-browser-inputs.mjs", import.meta.url);
  let source = (await readFile(sourceUrl, "utf8")).replaceAll("import.meta.url", JSON.stringify(sourceUrl.href));
  for (const module of ["collect-browser-archives.mjs", "collect-ungoogled-chromium.mjs", "inspect-ungoogled-dmg.mjs", "resource-workspace.mjs"]) {
    source = source.replace(new RegExp(`import \\{ ([^}]+) \\} from "\\./${module.replaceAll(".", "\\.")}";`),
      (_, names) => `const { ${names} } = globalThis[${JSON.stringify(key)}];`);
  }
  source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, sourceUrl).href)}`);
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  t.after(() => { delete globalThis[key]; });
  return { root, outputPath, scratchPath, collect: () => api.collectExecutableBrowserInputs({ outputPath, resourceStagePath: "/fixture-only",
    expectedResourceStageChecksum: `sha256:${"a".repeat(64)}` }), acquisitions: () => acquisitions };
}

test("one browser generation publishes only after inspection; existing output avoids acquisition", async t => {
  const f = await fixture(t, () => inspection());
  assert.equal((await f.collect()).readonlyMountDetached, true);
  assert.equal(f.acquisitions(), 2);
  assert.deepEqual(await readdir(join(f.root, "artifacts/browser")), ["inputs"]);
  await assert.rejects(collectExecutableBrowserInputs({ outputPath: f.outputPath }), /output_exists/);
  assert.equal(f.acquisitions(), 2);
});

test("unknown mount failure retains artifact staging outside scratch; detached pin mismatch cleans owned staging", async t => {
  const pending = await fixture(t, () => { throw new Error("fixture-detach-unknown"); });
  await assert.rejects(pending.collect(), /fixture-detach-unknown/);
  const entries = await readdir(join(pending.root, "artifacts/browser"));
  assert.equal(entries.length, 1); assert.match(entries[0], /^\.gstack-browser-inputs-/);
  assert.deepEqual(await readdir(pending.scratchPath), []);
  const detached = await fixture(t, () => ({ ...inspection(), inventoryChecksum: "changed" }));
  await assert.rejects(detached.collect(), /not_reproducible/);
  assert.deepEqual(await readdir(join(detached.root, "artifacts/browser")), []);
});

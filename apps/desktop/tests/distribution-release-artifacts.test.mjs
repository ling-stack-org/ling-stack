import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { create } from "tar";
import { createVerifiedDistributionArchive, inventoryDistribution, verifyDistributionArchive } from "../../../scripts/release/distribution-archive.mjs";
import { verifyNsisPlugins } from "../../../scripts/release/verify-nsis-plugins.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-release-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "distribution");
  await mkdir(join(directory, "licenses"), { recursive: true });
  await writeFile(join(directory, "licenses/original.txt"), "Original supplier notice\n");
  return { root, directory, archivePath: join(root, "distribution.tar.gz"), expected: await inventoryDistribution(directory) };
}

test("the material archive is read back and bound to every embedded file byte", async t => {
  const f = await fixture(t), record = await createVerifiedDistributionArchive(f);
  assert.ok(record.sizeBytes > 0);
  assert.deepEqual(await verifyDistributionArchive(f.archivePath, f.expected), record);
  await assert.rejects(createVerifiedDistributionArchive(f), /already exists/u);
  await writeFile(join(f.directory, "licenses/original.txt"), "Unexpected replacement");
  await create({ file: f.archivePath, cwd: f.root, gzip: true }, ["distribution"]);
  await assert.rejects(verifyDistributionArchive(f.archivePath, f.expected), /differs/u);
});

test("stale, empty, non-tar and extra-member material archives are refused", async t => {
  const f = await fixture(t);
  await writeFile(f.archivePath, "arbitrary non-tar bytes");
  await assert.rejects(verifyDistributionArchive(f.archivePath, f.expected));
  await writeFile(join(f.root, "outside.txt"), "not embedded");
  await create({ file: f.archivePath, cwd: f.root, gzip: true }, ["distribution", "outside.txt"]);
  await assert.rejects(verifyDistributionArchive(f.archivePath, f.expected), /differs/u);
  await writeFile(f.archivePath, gzipSync(Buffer.alloc(1024)));
  await assert.rejects(verifyDistributionArchive(f.archivePath, f.expected));
});

test("NSIS plugin verification extracts actual archive members and rejects changed or missing DLLs", async t => {
  const f = await fixture(t), require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const sevenZipPath = await builderRequire("app-builder-lib/out/toolsets/7zip.js").getPath7za();
  const pluginRoot = join(f.root, "$PLUGINSDIR");
  await mkdir(pluginRoot);
  const entries = ["StdUtils", "nsis7z"].map(name => {
    const bytes = Buffer.from(`Synthetic ${name} plugin bytes`);
    return { name, bytes, binarySha256: createHash("sha256").update(bytes).digest("hex"), sha256: "f".repeat(64) };
  });
  for (const entry of entries) await writeFile(join(pluginRoot, `${entry.name}.dll`), entry.bytes);
  // A real 7z container exercises the extraction contract. Native NSIS format
  // and actual supplier DLLs are checked by the Windows candidate verifier.
  const installer = join(f.root, "synthetic-installer.7z");
  execFileSync(sevenZipPath, ["a", "-bd", installer, "$PLUGINSDIR"], { cwd: f.root });
  const args = { installer, sevenZipPath, sources: { entries } };
  const result = await verifyNsisPlugins(args);
  assert.deepEqual(result.map(file => file.sha256), entries.map(entry => entry.binarySha256));
  await writeFile(join(pluginRoot, "nsis7z.dll"), "modified native bytes");
  execFileSync(sevenZipPath, ["u", "-bd", installer, "$PLUGINSDIR"], { cwd: f.root });
  await assert.rejects(verifyNsisPlugins(args), /does not match/u);
  await rm(installer); await rm(join(pluginRoot, "nsis7z.dll"));
  execFileSync(sevenZipPath, ["a", "-bd", installer, "$PLUGINSDIR"], { cwd: f.root });
  await assert.rejects(verifyNsisPlugins(args), /does not match/u);
});

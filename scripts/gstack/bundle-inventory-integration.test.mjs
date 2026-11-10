import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE
  ? resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE) : undefined;
const skip = !stage && "Set LING_GSTACK_PLATFORM_RESOURCE_STAGE for complete actual resource inventory checks";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const verifier = new URL("../../packages/core/dist/bundled-skill-source.js", import.meta.url).href;
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url)));

async function fileChecksum(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

test("complete real resource inventories validate in bounded memory without executable promotion", { skip }, async t => {
  const receiptBytes = await readFile(join(stage, "resource-stage.json"));
  const receipt = JSON.parse(receiptBytes);
  const inventoryBytes = await readFile(join(stage, "resource-inventory.json"));
  assert.equal(checksum(inventoryBytes), receipt.inventoryChecksum);
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.deliveryStage, "resource-prerequisites");
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.files.length, receipt.fileCount);
  for (const file of inventory.files) {
    assert.equal(await fileChecksum(join(stage, file.path)), file.checksum, file.path);
  }

  const temporary = await mkdtemp(join(tmpdir(), "ling complete bundle inventory "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "diagnostic resources");
  await cp(stage, root, { recursive: true, errorOnExist: true, force: false,
    verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const source = JSON.parse(await readFile(join(stage, "source-manifest.json")));
  const files = [...inventory.files, ...[
    ["resource-stage.json", receiptBytes], ["resource-inventory.json", inventoryBytes],
  ].map(([path, bytes]) => ({ path, checksum: checksum(bytes), sizeBytes: bytes.length }))];
  const manifest = { ...source, deliveryStage: "source", files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  assert.ok(manifestBytes.length > 2 * 1024 * 1024);
  await writeFile(join(root, "manifest.json"), manifestBytes, { flag: "wx" });
  // A source-only diagnostic verifies all bytes, but never authorizes their execution.
  const script = `const {verifyBundledSkillSource}=await import(${JSON.stringify(verifier)});
    const bundle=await verifyBundledSkillSource({rootPath:process.argv[1],
      expectedUpstreamRevision:${JSON.stringify(lock.revision)},
      expectedManifestChecksum:${JSON.stringify(checksum(manifestBytes))},
      expectedSkillIds:${JSON.stringify(lock.skillIds)}});
    const bodies=await Promise.all(${JSON.stringify(lock.skillIds)}.map(id=>bundle.readSkill(id)));
    try { await verifyBundledSkillSource({rootPath:process.argv[1],
      expectedUpstreamRevision:${JSON.stringify(lock.revision)},
      expectedSkillIds:${JSON.stringify(lock.skillIds)}, requireExecutable:true});
      throw new Error('diagnostic source promoted');
    } catch(error) { if(error.code!=='bundle_not_executable') throw error; }
    console.log(JSON.stringify({stage:bundle.manifest.deliveryStage,
      files:bundle.manifest.files.length, bodies:bodies.length,
      maxRSS:process.resourceUsage().maxRSS}));`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", script, root], {
    cwd: temporary, env: { PATH: "/usr/bin:/bin", HOME: temporary, TMPDIR: temporary },
    encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.stage, "source");
  assert.equal(observed.files, files.length);
  assert.equal(observed.bodies, 57);
  assert.ok(observed.maxRSS < 256 * 1024, `Verification used ${observed.maxRSS} KiB RSS`);
  t.diagnostic(JSON.stringify({ ...observed, manifestBytes: manifestBytes.length,
    manifestChecksum: checksum(manifestBytes), resourceReceiptChecksum: checksum(receiptBytes),
    inventoryBytes: files.reduce((total, file) => total + file.sizeBytes, 0) }));
  assert.equal(await fileChecksum(join(stage, "resource-stage.json")), checksum(receiptBytes));
  assert.equal(await fileChecksum(join(stage, "resource-inventory.json")), checksum(inventoryBytes));
});

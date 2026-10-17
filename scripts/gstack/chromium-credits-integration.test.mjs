import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { decodeChromiumResource, parseChromiumDataPack } from "./chromium-data-pack.mjs";
import { inspectChromiumCredits, readSelectedChromiumPack } from "./inspect-chromium-credits.mjs";

const snapshot = process.env.LING_GSTACK_CHROMIUM_SNAPSHOT && resolve(process.env.LING_GSTACK_CHROMIUM_SNAPSHOT);
const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE);
const creditsRoot = process.env.LING_GSTACK_CHROMIUM_CREDITS && resolve(process.env.LING_GSTACK_CHROMIUM_CREDITS);
const skip = !(snapshot && stage && creditsRoot) && "Set real snapshot, resource stage and compiled-credit evidence paths";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const snapshotChecksum = "sha256:7ea4fafa26816906e2bf256093ad38c50ffb681d01731bca5fe8926c99ccb707";
const receiptChecksum = "sha256:2910794ddcd8c93837b05c71a12a8dc355576d120b78f36dbe6f8bbd35751592";
const pin = JSON.parse(await readFile(new URL("./chromium-credits-pin.json", import.meta.url), "utf8"));

async function receipt() {
  const bytes = await readFile(join(creditsRoot, "credits-candidate.json"));
  assert.equal(checksum(bytes), receiptChecksum);
  const data = JSON.parse(bytes);
  for (const input of data.inputChecksums) assert.equal(checksum(await readFile(new URL(input.path, import.meta.url))), input.checksum);
  return data;
}

test("actual Chromium pack is independently rehashed and every original and decoded resource agrees with retained evidence", { skip }, async () => {
  const evidence = await receipt(), snapshotBytes = await readFile(join(snapshot, "snapshot-candidate.json"));
  assert.equal(checksum(snapshotBytes), snapshotChecksum);
  const source = await verifyBrowserArchiveSource({ resourceStagePath: stage, target: { platform: "darwin", arch: "arm64" },
    expectedResourceStageChecksum: "sha256:a6d344a6675c34486db326801d86be736ccb1a3835afd19bc871af9923b640e1" });
  assert.deepEqual(source.provenance, evidence.source);
  const { yauzl } = createRequire(join(source.root, "runtime/package.json"))(join(source.packagePath, "lib/utilsBundle.js"));
  const archiveBytes = await readFile(join(snapshot, "chrome-mac.zip"));
  assert.equal(archiveBytes.length, 167624451);
  assert.equal(checksum(archiveBytes), "sha256:c17f3d106bb3a0df4f7be5cae04f3f18b20649a3e8b34882301f1e40e896285e");
  const members = JSON.parse(await readFile(join(snapshot, "snapshot-members.json"), "utf8")).members;
  const packBytes = await readSelectedChromiumPack({ archiveBytes, yauzl, member: members.find(m => m.path === pin.pack.path) });
  assert.equal(checksum(packBytes), pin.pack.checksum); assert.equal(packBytes.length, 18528780);
  const parsed = parseChromiumDataPack(packBytes), inventoryBytes = await readFile(join(creditsRoot, "pack-resources.json"));
  assert.equal(checksum(inventoryBytes), "sha256:4cb84dd0b640ac1819a614f66a7fa2d2aaea77d43947cd796f5a35ed4987a5df");
  const inventory = JSON.parse(inventoryBytes), resources = [];
  for (const resource of parsed.resources) {
    const decoded = decodeChromiumResource(resource.bytes);
    resources.push({ id: resource.id, offset: resource.offset, storedSizeBytes: resource.bytes.length,
      storedChecksum: checksum(resource.bytes), compression: decoded.format, sizeBytes: decoded.bytes.length, checksum: checksum(decoded.bytes) });
  }
  assert.deepEqual(resources, inventory.resources); assert.deepEqual(parsed.aliases, inventory.aliases);
  assert.equal(resources.length, 5143); assert.equal(parsed.aliases.length, 365);
  assert.equal(resources.reduce((total, resource) => total + resource.sizeBytes, 0), 56891952);
  const credits = resources.find(resource => resource.id === 40571);
  assert.equal(credits.compression, "brotli"); assert.equal(credits.sizeBytes, 401); assert.equal(credits.checksum, pin.credits.checksum);
});

test("compiled credits equal the exact historical sample and cannot be mistaken for a complete redistributable browser", { skip }, async () => {
  const data = await receipt(), credits = await readFile(join(creditsRoot, "compiled-credits.html.txt"));
  assert.equal(checksum(credits), pin.credits.checksum);
  assert.equal(data.candidateDisposition, "rejected-for-delivery"); assert.equal(data.releaseEligible, false);
  assert.equal(data.credits.classification, "upstream-sample-placeholder");
  assert.match(credits.toString("utf8"), /This is sample credits page/);
  assert.match(credits.toString("utf8"), /generate_about_credits=true/);
  for (const reference of pin.references) assert.equal(checksum(await readFile(join(creditsRoot, reference.output))), reference.checksum);
  assert.deepEqual(await readFile(join(creditsRoot, "reference-sample-credits.html.txt")), credits);
  const names = (await readdir(creditsRoot)).sort();
  assert.deepEqual(names, ["compiled-credits.html.txt", "credits-candidate.json", "pack-resources.json", ...pin.references.map(r => r.output)].sort());
  for (const name of names) assert.equal((await lstat(join(creditsRoot, name))).mode & 0o111, 0);
  assert.equal((await lstat(join(snapshot, "chrome-mac.zip"))).mode & 0o111, 0);
  await assert.rejects(lstat(join(snapshot, "chrome-mac")), { code: "ENOENT" });
});

test("actual compiled-credit evidence replays offline without overwrites and rejects stale source or altered reference text", { skip }, async t => {
  const original = await receipt(), temporary = await mkdtemp(join(tmpdir(), "ling chromium credit replay "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outputPath = join(temporary, "diagnostic"), references = new Map(original.references.map(r => [r.path, r]));
  const referenceReader = async record => ({ ...references.get(record.path),
    bytes: await readFile(join(creditsRoot, record.output)), output: "../../must-not-be-used.txt" });
  const options = { snapshotPath: snapshot, resourceStagePath: stage, outputPath, expectedSnapshotChecksum: snapshotChecksum, referenceReader };
  const actual = await inspectChromiumCredits(options);
  assert.deepEqual(actual, original);
  assert.equal(checksum(await readFile(join(outputPath, "credits-candidate.json"))), receiptChecksum);
  await assert.rejects(inspectChromiumCredits(options), /output_exists/);
  await assert.rejects(inspectChromiumCredits({ ...options, outputPath: join(temporary, "wrong-receipt"),
    expectedSnapshotChecksum: `sha256:${"0".repeat(64)}` }), /file_checksum_mismatch/);
  await assert.rejects(inspectChromiumCredits({ ...options, outputPath: join(temporary, "changed-reference"),
    referenceReader: async record => ({ ...await referenceReader(record), bytes: Buffer.from("altered reference") }) }), /reference_changed/);
  await assert.rejects(inspectChromiumCredits({ ...options, outputPath: join(snapshot, "unsafe-overlap") }), /output_overlap/);
  assert.deepEqual((await readdir(temporary)).sort(), ["diagnostic"]);
  assert.equal(checksum(await readFile(join(creditsRoot, "credits-candidate.json"))), receiptChecksum);
});

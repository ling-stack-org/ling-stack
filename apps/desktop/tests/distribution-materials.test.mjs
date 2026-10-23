import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSpdx, declaredLicenseMaterials, filesBelow, hasCompleteReadmeGrant, lockedPackageKeys, noticePattern, parseArguments, sha256, validateBunSourceRevision, verifyMaterials, writeMaterials } from "../scripts/distribution/materials.mjs";
import { createHash } from "node:crypto";
import { packageIntegrity, validateNoticeRestoration } from "../scripts/distribution/restored-notices.mjs";

const sourceSha = "d".repeat(40);
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
function fixture(t, gaps = []) {
  const root = mkdtempSync(join(tmpdir(), "ling-distribution-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "prepared"), resources = join(root, "resources");
  const material = new Map([["licenses/example/LICENSE", Buffer.from("An exact supplier license\n")], ["THIRD_PARTY_NOTICES.md", Buffer.from("Fixture notices\n")]]);
  const files = [...material].map(([path, bytes]) => ({ path, sizeBytes: bytes.length, sha256: sha256(bytes) }));
  const manifest = { schemaVersion: 1, kind: "desktop-distribution-materials", platform: "darwin-arm64", sourceSha, status: gaps.length ? "blocked" : "collected", gaps, files };
  material.set("distribution-manifest.json", Buffer.from(encode(manifest)));
  material.set("SHA256SUMS.txt", Buffer.from([...material].map(([path, bytes]) => `${sha256(bytes)}  ${path}`).sort().join("\n") + "\n"));
  writeMaterials({ manifest, material }, output);
  mkdirSync(resources);
  cpSync(output, join(resources, "distribution"), { recursive: true });
  return { root, output, resources, manifest, material };
}
function rewriteChecksums(directory) {
  const files = filesBelow(directory).filter(path => !path.endsWith("/SHA256SUMS.txt"));
  writeFileSync(join(directory, "SHA256SUMS.txt"), files.map(path => `${sha256(readFileSync(path))}  ${path.slice(directory.length + 1).replaceAll("\\", "/")}`).sort().join("\n") + "\n");
}

test("CLI rejects unspecified target, duplicate options and ambiguous flags", () => {
  assert.deepEqual(parseArguments(["inspect", "--platform", "win32-x64"]), { command: "inspect", platform: "win32-x64" });
  for (const args of [["inspect"], ["prepare", "--platform", "linux-x64"], ["inspect", "--platform", "win32-x64", "--platform", "win32-x64"], ["verify", "--platform", "win32-x64"], ["prepare", "--platform", "win32-x64", "--skip-notices", "yes"]]) assert.throws(() => parseArguments(args));
});

test("pnpm package identity is checked in packages, not an importer or snapshot", () => {
  const keys = lockedPackageKeys("lockfileVersion: '9.0'\nimporters:\n  pkg:\n    specifier: 'foo@9.0.0'\npackages:\n  '@scope/pkg@1.2.3':\n    resolution: {integrity: sha512-test}\n  unscoped@2.0.0:\n    resolution: {integrity: sha512-test}\nsnapshots:\n  ghost@99.0.0:\n");
  assert.deepEqual([...keys], ["@scope/pkg@1.2.3", "unscoped@2.0.0"]);
  assert.equal(keys.has("ghost@99.0.0"), false);
  assert.throws(() => lockedPackageKeys("snapshots:\n  foo@1.0.0:\n"), /packages_missing/u);
});

test("README fallback requires the full grant and disclaimer, never merely an MIT link", () => {
  assert.equal(hasCompleteReadmeGrant("MIT License: https://example.invalid/LICENSE"), false);
  assert.equal(hasCompleteReadmeGrant("Permission is hereby granted, free of charge, to any person. THE SOFTWARE IS PROVIDED AS IS WITHOUT WARRANTY OR LIABILITY"), true);
  assert.equal(hasCompleteReadmeGrant("Permission is hereby granted, free of charge"), false);
});

test("vendor notice discovery retains plural and joined Chromium/ThirdParty filenames", () => {
  for (const name of ["LICENSES.chromium.html", "ThirdPartyNotices.txt", "THIRD-PARTY-LICENSES", "COPYING.LESSER"]) assert.equal(noticePattern.test(name), true, name);
  assert.equal(noticePattern.test("license-checker.js"), true);
  assert.equal(noticePattern.test("readme.md"), false);
});

test("Bun's actual nine-character version output binds the fixed full source revision", () => {
  const revision = "38afee6c84fcf48c0edb2466aa4b27d287a59c30";
  assert.equal(validateBunSourceRevision("1.4.4", revision, "1.4.4+38afee6c8"), undefined);
  for (const reported of ["1.4.4+38afee6c", "1.4.4+38afee6c9", "1.4.5+38afee6c8", "1.4.4", `1.4.4+${revision}`]) assert.throws(() => validateBunSourceRevision("1.4.4", revision, reported), /source_revision_mismatch/u);
  assert.throws(() => validateBunSourceRevision("1.4.4", "38afee6c8", "1.4.4+38afee6c8"), /source_revision_mismatch/u);
});

test("explicit published SPDX terms retain original metadata and identify generic standard texts", () => {
  const metadata = { name: "a-published-package", version: "1.2.3", license: "Apache-2.0", author: "Original publisher" };
  const bytes = Buffer.from(encode(metadata)), material = new Map();
  const files = declaredLicenseMaterials(metadata, bytes, "licenses/example", (path, bytes) => { material.set(path, bytes); return path; });
  assert.deepEqual(files, ["licenses/example/standard-Apache-2.0.txt"]);
  assert.deepEqual(material.get("licenses/example/published-package.json"), bytes);
  const evidence = JSON.parse(material.get("licenses/example/declared-license-evidence.json"));
  assert.equal(evidence.declaration, "published-package.json#license");
  assert.match(evidence.standardText.revision, /^[a-f0-9]{40}$/u);
  assert.equal(sha256(material.get(files[0])), evidence.standardText.sha256);
  assert.deepEqual(declaredLicenseMaterials({ ...metadata, license: "SEE LICENSE IN README" }, bytes, "licenses/example", () => {}), []);
  assert.throws(() => declaredLicenseMaterials(metadata, Buffer.from(encode({ ...metadata, version: "1.2.4" })), "licenses/example", () => {}), /identity_mismatch/u);
});

function noticeRestoration() {
  const revision = "a".repeat(40), repository = "publisher/source", integrity = `sha512-${Buffer.from("tarball digest").toString("base64")}`;
  const record = (path, text) => { const bytes = Buffer.from(text); return { path, url: `https://raw.githubusercontent.com/${repository}/${revision}/${path}`, contentBase64: bytes.toString("base64"), sha256: sha256(bytes), gitBlob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") }; };
  const metadata = { name: "example", version: "1.2.3" };
  const entry = { ...metadata, repository, revision, registry: { gitHead: revision, integrity }, sourcePackage: record("package.json", encode(metadata)), licenseText: record("LICENSE", "Original copyright and grant\n") };
  const lockfile = `packages:\n  example@1.2.3:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n`;
  return { entry, metadata, lockfile, integrity, revision };
}

test("restored original notice binds lock SRI, package identity, source URL and unchanged text", () => {
  const { entry, metadata, lockfile, integrity } = noticeRestoration();
  assert.equal(packageIntegrity(lockfile, "example@1.2.3"), integrity);
  assert.equal(validateNoticeRestoration(entry, metadata, lockfile).license.toString(), "Original copyright and grant\n");
  assert.throws(() => validateNoticeRestoration(entry, metadata, lockfile.replace(integrity, "sha512-other")), /lock_identity_mismatch/u);
  for (const change of [record => { record.licenseText.contentBase64 = Buffer.from("replacement").toString("base64"); }, record => { record.sourcePackage.url = "https://example.invalid/package.json"; }, record => { record.revision = "main"; }]) {
    const copy = structuredClone(entry); change(copy);
    assert.throws(() => validateNoticeRestoration(copy, metadata, lockfile));
  }
});

test("provenance restoration needs matching published subject and exact source commit", () => {
  const { entry, metadata, lockfile, integrity, revision } = noticeRestoration();
  entry.registry.gitHead = null;
  entry.provenance = { statement: { predicateType: "https://slsa.dev/provenance/v1", subject: [{ digest: { sha512: Buffer.from(integrity.split("-")[1], "base64").toString("hex") } }], predicate: { buildDefinition: { resolvedDependencies: [{ uri: `git+https://github.com/${entry.repository}@refs/heads/main`, digest: { gitCommit: revision } }] } } } };
  assert.ok(validateNoticeRestoration(entry, metadata, lockfile).license);
  for (const change of [record => { record.provenance.statement.subject[0].digest.sha512 = "00"; }, record => { record.provenance.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); }, record => { record.provenance.statement.predicateType = "untrusted"; }]) {
    const copy = structuredClone(entry); change(copy);
    assert.throws(() => validateNoticeRestoration(copy, metadata, lockfile), /provenance_mismatch/u);
  }
});

test("embedded material verification binds prepared bytes and lists final native/font digests", t => {
  const input = fixture(t);
  mkdirSync(join(input.resources, "browser-host"));
  writeFileSync(join(input.resources, "browser-host", "ling-browser-host"), "native fixture");
  const result = verifyMaterials({ ...input, platform: "darwin-arm64", sourceSha });
  assert.equal(result.status, "verified");
  assert.equal(result.materialFiles, 4);
  assert.equal(result.nativeAndFontInventory[0].sha256, sha256("native fixture"));
  assert.equal(result.nativeAndFontInventory[0].path, "browser-host/ling-browser-host");
});

test("missing, added or changed final notices cannot pass verification", t => {
  for (const mode of ["missing", "added", "changed"]) {
    const input = fixture(t), directory = join(input.resources, "distribution");
    if (mode === "missing") rmSync(join(directory, "licenses/example/LICENSE"));
    if (mode === "added") writeFileSync(join(directory, "unexpected-LICENSE"), "extra");
    if (mode === "changed") writeFileSync(join(directory, "licenses/example/LICENSE"), "changed");
    assert.throws(() => verifyMaterials({ ...input, platform: "darwin-arm64", sourceSha }), /material_(?:set|digest)_mismatch/u);
  }
});

test("self-consistent tampering cannot bypass comparison with prepared materials", t => {
  const input = fixture(t), directory = join(input.resources, "distribution");
  const path = join(directory, "licenses/example/LICENSE");
  writeFileSync(path, "replacement notice text");
  const manifest = JSON.parse(readFileSync(join(directory, "distribution-manifest.json")));
  const file = manifest.files.find(file => file.path === "licenses/example/LICENSE");
  file.sha256 = sha256(readFileSync(path)); file.sizeBytes = readFileSync(path).length;
  writeFileSync(join(directory, "distribution-manifest.json"), encode(manifest));
  rewriteChecksums(directory);
  assert.throws(() => verifyMaterials({ ...input, platform: "darwin-arm64", sourceSha }), /differ_from_prepared/u);
});

test("blocked materials, stale source and wrong target fail before acceptance", t => {
  const blocked = fixture(t, [{ component: "vendor", reason: "missing exact terms" }]);
  assert.throws(() => verifyMaterials({ ...blocked, platform: "darwin-arm64", sourceSha }), /materials_blocked/u);
  const collected = fixture(t);
  assert.throws(() => verifyMaterials({ ...collected, platform: "darwin-arm64", sourceSha: "e".repeat(40) }), /identity_mismatch/u);
  assert.throws(() => verifyMaterials({ ...collected, platform: "win32-x64", sourceSha }), /identity_mismatch/u);
});

test("checksum paths and inventory membership are validated before any path read", t => {
  const input = fixture(t), directory = join(input.resources, "distribution");
  writeFileSync(join(directory, "SHA256SUMS.txt"), `${"a".repeat(64)}  ../../outside\n`);
  assert.throws(() => verifyMaterials({ ...input, platform: "darwin-arm64", sourceSha }), /checksum_manifest_invalid/u);
  const another = fixture(t), second = join(another.resources, "distribution");
  const manifest = JSON.parse(readFileSync(join(second, "distribution-manifest.json")));
  manifest.files.push({ path: "../../outside" });
  writeFileSync(join(second, "distribution-manifest.json"), encode(manifest));
  rewriteChecksums(second);
  assert.throws(() => verifyMaterials({ resources: another.resources, platform: "darwin-arm64", sourceSha }), /inventory_manifest_mismatch/u);
});

test("material generation refuses stale nonempty outputs and symbolic-link substitutions", t => {
  const input = fixture(t);
  assert.throws(() => writeMaterials(input, input.output), /must_be_empty/u);
  const directory = join(input.resources, "distribution");
  rmSync(join(directory, "licenses/example/LICENSE"));
  symlinkSync(join(input.output, "licenses/example/LICENSE"), join(directory, "licenses/example/LICENSE"));
  assert.throws(() => verifyMaterials({ ...input, platform: "darwin-arm64", sourceSha }), /symlink_not_allowed/u);
});

test("SPDX uses stable identity, UTC and current-file hashes without asserting a legal conclusion", () => {
  const manifest = { platform: "win32-x64", sourceSha, lockfileSha256: "f".repeat(64), created: "2026-10-23T00:00:00Z", scope: "technical only", components: [{ identifier: "npm:one@1.0.0", name: "one", version: "1.0.0", license: "MIT", licenseFiles: ["licenses/one/LICENSE"] }] };
  const material = new Map([["licenses/one/LICENSE", Buffer.from("notice")]]);
  const document = createSpdx(manifest, material);
  assert.deepEqual(document, createSpdx(manifest, material));
  assert.equal(document.spdxVersion, "SPDX-2.3");
  assert.equal(document.packages[0].licenseConcluded, "NOASSERTION");
  assert.equal(document.files[0].checksums[0].checksumValue, sha256("notice"));
  const ids = new Set([document.SPDXID, ...document.packages.map(pkg => pkg.SPDXID), ...document.files.map(file => file.SPDXID)]);
  assert.equal(document.relationships.every(row => ids.has(row.spdxElementId) && ids.has(row.relatedSpdxElement)), true);
});

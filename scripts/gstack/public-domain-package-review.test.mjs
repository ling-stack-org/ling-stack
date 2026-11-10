import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadReviewedPublicDomainPackages, reviewExactPublicDomainRuntimePackage,
  REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM } from "./public-domain-package-review.mjs";
import { auditGstackRuntimeDependencies } from "./runtime-dependency-audit.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const catalogBytes = await readFile(new URL("./reviewed-public-domain-packages.json", import.meta.url));
const catalog = JSON.parse(catalogBytes.toString("utf8"));
const reviewed = catalog.entries[0];
const target = { platform: "darwin", arch: "arm64" };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-public-domain-review-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = "lib/diagram-render/node_modules/fractional-indexing";
  const packageRoot = join(root, path);
  for (const file of reviewed.installedFiles) {
    await mkdir(dirname(join(packageRoot, file.path)), { recursive: true });
    await writeFile(join(packageRoot, file.path), Buffer.from(file.contentBase64, "base64"));
  }
  return { root, path, packageRoot, options: { packageRoot, name: reviewed.name, version: reviewed.version, license: reviewed.license } };
}

test("the frozen public-domain record retains exact original package, source and complete CC0 terms", async () => {
  assert.equal(checksum(catalogBytes), REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM);
  const result = await loadReviewedPublicDomainPackages();
  assert.equal(result.size, 1);
  const entry = result.get("fractional-indexing@3.2.0");
  assert.equal(entry.source.revision, "9e55f979db216df7d20e2be17fbe185d881e3c90");
  assert.equal(entry.installedFiles.length, 5);
  assert.equal(entry.source.notice.checksum, "sha256:a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499");
  assert.equal(catalog.releaseEligible, false);
});

test("only the reviewed unchanged package clears its package-policy review and preserves original notices", async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.packageRoot, "LICENSE"));
  const evidence = await reviewExactPublicDomainRuntimePackage(f.options);
  assert.equal(evidence.method, "exact-reviewed-public-domain-package");
  assert.equal(evidence.installedFileCount, 5);
  assert.equal(evidence.catalogChecksum, REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM);
  assert.deepEqual(await reviewExactPublicDomainRuntimePackage(f.options), evidence);
  const audit = await auditGstackRuntimeDependencies({ runtimeRoot: f.root, target });
  assert.equal(audit.blockers.length, 0);
  assert.equal(audit.packages[0].license, "CC0-1.0");
  assert.equal(audit.packages[0].metadataLicense, "CC0-1.0");
  assert.equal(audit.packages[0].licenseEvidence[0].method, evidence.method);
  assert.equal(audit.releaseEligible, false);
  assert.equal(audit.reviewStatus, "pending");
  assert.deepEqual(await readFile(join(f.packageRoot, "LICENSE")), before);
});

test("changed metadata, code, declarations, notices or inventories keep the review unresolved", async t => {
  for (const change of ["metadata", "code", "declaration", "notice", "missing", "extra", "link"]) {
    const f = await fixture(t);
    if (change === "metadata") await writeFile(join(f.packageRoot, "package.json"), JSON.stringify({ name: reviewed.name, version: reviewed.version, license: "CC0-1.0", extra: "unreviewed" }));
    if (change === "code") await writeFile(join(f.packageRoot, "src/index.js"), "unreviewed code");
    if (change === "declaration") await writeFile(join(f.packageRoot, "src/index.d.ts"), "unreviewed declaration");
    if (change === "notice") await writeFile(join(f.packageRoot, "LICENSE"), "CC0 1.0 Universal heading only");
    if (change === "missing") await rm(join(f.packageRoot, "README.md"));
    if (change === "extra") await writeFile(join(f.packageRoot, "extra.js"), "unreviewed file");
    if (change === "link") {
      await rm(join(f.packageRoot, "src/index.js"));
      await symlink(join(f.root, "owner.js"), join(f.packageRoot, "src/index.js"));
    }
    assert.equal(await reviewExactPublicDomainRuntimePackage(f.options), undefined, change);
    const report = await auditGstackRuntimeDependencies({ runtimeRoot: f.root, target });
    assert.equal(report.blockers.some(b => b.code === "dependency_license_review" && b.path === f.path), true, change);
    assert.deepEqual(report.packages[0].licenseEvidence, [], change);
  }
});

test("a CC0 label, neighboring version, proprietary package or LGPL component cannot borrow this decision", async t => {
  const f = await fixture(t);
  for (const changes of [{ name: "unreviewed" }, { version: "3.2.1" }, { license: "MIT" },
    { license: "LGPL-3.0-or-later" }, { license: "SEE LICENSE IN README.md" }]) {
    assert.equal(await reviewExactPublicDomainRuntimePackage({ ...f.options, ...changes }), undefined);
  }
  const path = join(f.root, "node_modules/unreviewed");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "unreviewed", version: "1.0.0", license: "CC0-1.0" }));
  await writeFile(join(path, "LICENSE"), Buffer.from(reviewed.source.notice.contentBase64, "base64"));
  const report = await auditGstackRuntimeDependencies({ runtimeRoot: f.root, target });
  assert.deepEqual(report.blockers.filter(b => b.code === "dependency_license_review").map(b => b.path), ["node_modules/unreviewed"]);
});

test("modified catalog bytes cannot replace the frozen review and malformed self-hashed records also reject", async t => {
  const f = await fixture(t), catalogPath = join(f.root, "modified.json");
  for (const mutate of [
    c => { c.releaseEligible = true; },
    c => { c.reviewStatus = "candidate-only"; },
    c => { c.entries[0].license = "MIT"; },
    c => { c.entries[0].source.revision = "b".repeat(40); },
    c => { c.entries[0].source.notice.contentBase64 = Buffer.from("CC0 heading only").toString("base64"); },
    c => { c.entries[0].installedFiles.pop(); },
    c => { c.entries[0].installedFiles[0].path = "../LICENSE"; },
    c => { c.entries[0].tarball.integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`; },
  ]) {
    const changed = structuredClone(catalog); mutate(changed);
    const bytes = Buffer.from(JSON.stringify(changed));
    await writeFile(catalogPath, bytes);
    await assert.rejects(loadReviewedPublicDomainPackages({ catalogPath }), /gstack_public_domain_catalog_checksum_mismatch/);
    await assert.rejects(loadReviewedPublicDomainPackages({ catalogPath, expectedCatalogChecksum: checksum(bytes) }), /gstack_public_domain_/);
  }
});

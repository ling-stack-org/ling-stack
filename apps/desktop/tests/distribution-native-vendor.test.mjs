import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectSharpLibvipsMaterials, validateSharpSourceMaterials, validateWindowsLibvipsMaterials } from "../scripts/distribution/native-vendor-materials.mjs";
import { collectCanvasMaterials, validateCanvasSourceMaterials } from "../scripts/distribution/canvas-materials.mjs";

const record = JSON.parse(readFileSync(new URL("../scripts/distribution/vendor-notices/sharp-libvips-sources.json", import.meta.url)));
const metadata = { name: record.name, version: record.version };
const versions = Buffer.from(record.versionsContentBase64, "base64");

test("libvips notices bind the actual version table, exact published source and all recipe downloads", t => {
  const directory = mkdtempSync(join(tmpdir(), "ling-libvips-source-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "versions.json"), versions);
  const material = new Map(), components = [];
  const result = collectSharpLibvipsMaterials(metadata, directory, (path, bytes) => { material.set(path, Buffer.from(bytes)); return path; }, components);
  assert.equal(result.sourceMaterialsCollected, true);
  assert.equal(result.licenseFiles.length, record.sources.reduce((count, source) => count + source.notices.length, 0));
  assert.ok(result.licenseFiles.length > 60);
  assert.ok(result.licenseFiles.some(path => /COPYING/u.test(path)));
  assert.ok([...material.keys()].some(path => path.includes("frozen-patches/")));
  assert.ok(material.get("sources/gstack/sharp-libvips-source-access.md").includes(Buffer.from("modify and rebuild")));
  assert.equal(components.length, 1);
  assert.equal(collectSharpLibvipsMaterials({ ...metadata, version: "other" }, directory, () => {}, []), undefined);
  writeFileSync(join(directory, "versions.json"), Buffer.concat([versions, Buffer.from(" ")]));
  assert.throws(() => collectSharpLibvipsMaterials(metadata, directory, () => {}, []), /source_identity_mismatch/u);
});

test("native source review cannot silently change original notices, package identity, URLs or patches", () => {
  assert.ok(validateSharpSourceMaterials(record, metadata, versions).has("build/posix.sh"));
  for (const change of [
    copy => { copy.files[0].contentBase64 = Buffer.from("replacement grant").toString("base64"); },
    copy => { copy.files[0].url = "https://example.invalid/LICENSE"; },
    copy => { copy.sources[0].url = "https://example.invalid/latest-source.tar.gz"; },
    copy => { copy.sources[0].notices[0].path = "../escape"; },
    copy => { copy.sources.find(source => source.kind === "source-patch").contentBase64 = Buffer.from("changed patch").toString("base64"); },
    copy => { copy.sources.pop(); },
  ]) {
    const copy = structuredClone(record); change(copy);
    assert.throws(() => validateSharpSourceMaterials(copy, metadata, versions));
  }
  assert.throws(() => validateSharpSourceMaterials(record, { ...metadata, version: "1.3.3" }, versions), /source_identity_mismatch/u);
});

test("Windows libvips uses its own supplier DLL and original version/license binding", () => {
  const windows = JSON.parse(readFileSync(new URL("../scripts/distribution/vendor-notices/sharp-libvips-windows.json", import.meta.url)));
  const metadata = { name: windows.name, version: windows.version };
  const binaryDigests = Object.fromEntries(windows.binaries.map(file => [file.path, { sha256: file.sha256, sizeBytes: file.sizeBytes }]));
  assert.equal(validateWindowsLibvipsMaterials(windows, metadata, versions, binaryDigests), undefined);
  assert.throws(() => validateWindowsLibvipsMaterials(windows, metadata, versions, {}), /supplier_binary_mismatch/u);
  assert.throws(() => validateWindowsLibvipsMaterials(windows, metadata, Buffer.concat([versions, Buffer.from(" ")]), binaryDigests), /source_identity_mismatch/u);
  for (const change of [
    copy => { copy.sourcePackage.contentBase64 = Buffer.from("{}").toString("base64"); },
    copy => { copy.registry.gitHead = "f".repeat(40); },
    copy => { copy.binaries[0].sha256 = "f".repeat(64); },
    copy => { copy.originalSupplierFiles[0].contentBase64 = Buffer.from("changed license").toString("base64"); },
  ]) {
    const copy = structuredClone(windows); change(copy);
    assert.throws(() => validateWindowsLibvipsMaterials(copy, metadata, versions, binaryDigests));
  }
});

const canvasSources = JSON.parse(readFileSync(new URL("../scripts/distribution/vendor-notices/canvas-native-sources.json", import.meta.url))).entries;
function canvasFixture(version) {
  const record = canvasSources.find(record => record.version === version), metadata = { name: "@napi-rs/canvas-darwin-arm64", version };
  const binding = { ...metadata, repository: record.repository, revision: record.revision };
  const sbom = { metadata: { component: metadata }, components: record.crates.map(crate => ({ name: crate.name, version: crate.version, purl: `pkg:cargo/${crate.name}@${crate.version}`, hashes: [{ alg: "SHA-256", content: crate.sha256 }] })) };
  return { record, metadata, binding, sbom };
}

test("Canvas supplier records bind native SBOM crate hashes and retain old historical limits", t => {
  for (const version of ["0.1.80", "1.0.11"]) {
    const { record, metadata, binding, sbom } = canvasFixture(version);
    assert.equal(validateCanvasSourceMaterials(record, binding, metadata, version === "1.0.11" ? sbom : undefined), undefined);
    const nativeDirectory = mkdtempSync(join(tmpdir(), "ling-canvas-source-test-"));
    t.after(() => rmSync(nativeDirectory, { recursive: true, force: true }));
    writeFileSync(join(nativeDirectory, "package.json"), JSON.stringify(metadata));
    if (version === "1.0.11") writeFileSync(join(nativeDirectory, "sbom.cdx.json"), JSON.stringify(sbom));
    const material = new Map(), components = [];
    const result = collectCanvasMaterials({ metadata: { name: "@napi-rs/canvas", version }, nativeDirectory, sourceBinding: binding }, (path, bytes) => { material.set(path, bytes); return path; }, components);
    assert.ok(result.licenseFiles.length > 20);
    assert.equal(result.historicalRustResolutionPublished, version === "1.0.11");
    assert.equal(result.limitations.length, version === "0.1.80" ? 1 : 0);
    if (version === "0.1.80") {
      assert.equal(record.crates.length, 0, "never substitute newer Rust crates for the historical binary");
      assert.match(components[0].rustDependencyEvidence, /not published/u);
      assert.equal(result.limitations[0].reason, "historical_native_rust_resolution_not_published");
      assert.match(result.limitations[0].details, /cannot be reconstructed/u);
    }
  }
});

test("Canvas original blobs, source pins, SBOM identities and crate checksums fail closed", () => {
  const { record, metadata, binding, sbom } = canvasFixture("1.0.11");
  for (const change of [
    copy => { copy.files[0].contentBase64 = Buffer.from("modified source").toString("base64"); },
    copy => { copy.skiaGitlink.sha = "f".repeat(40); },
    copy => { copy.vendors[0].version = "f".repeat(40); },
    copy => { copy.crates[0].sha256 = "f".repeat(64); },
    copy => { copy.crates.find(crate => crate.sourceRestoration).sourceRestoration.revision = "f".repeat(40); },
  ]) {
    const copy = structuredClone(record); change(copy);
    assert.throws(() => validateCanvasSourceMaterials(copy, binding, metadata, sbom));
  }
  assert.throws(() => validateCanvasSourceMaterials(record, binding, metadata, undefined), /supplier_sbom_missing/u);
  assert.throws(() => validateCanvasSourceMaterials(record, { ...binding, version: "other" }, metadata, sbom), /source_identity_mismatch/u);
});

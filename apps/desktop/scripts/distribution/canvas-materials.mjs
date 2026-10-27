/** Supplier-published Canvas/Skia attribution; historical build gaps stay explicit. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Modern Canvas releases ship Cargo.lock and a supplier binary SBOM; older releases stay evidence-limited. */
const MODERN_CANVAS_VERSIONS = ["1.0.11", "1.0.13"];
const SUPPORTED_CANVAS_VERSIONS = ["0.1.80", ...MODERN_CANVAS_VERSIONS];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function original(file) {
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (!file.path || /[\\:\0]/u.test(file.path) || file.path.split("/").some(part => ["", ".", ".."].includes(part))
    || sha256(bytes) !== file.sha256 || bytes.length !== file.sizeBytes
    || (file.gitBlob && createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob)) throw new Error("distribution_canvas_original_digest_or_path_mismatch");
  return bytes;
}

export function validateCanvasSourceMaterials(record, sourceBinding, metadata, sbom) {
  if (record.version !== metadata.version || sourceBinding?.name !== metadata.name || sourceBinding.version !== metadata.version
    || record.revision !== sourceBinding.revision || record.repository !== sourceBinding.repository
    || !/^[a-f0-9]{40}$/u.test(record.revision) || record.skiaGitlink?.type !== "commit" || record.skiaGitlink?.path !== "skia"
    || record.skiaGitlink.sha !== record.skiaRevision) throw new Error("distribution_canvas_source_identity_mismatch");
  for (const file of record.files) {
    original(file);
    if (file.url !== `https://raw.githubusercontent.com/${record.repository}/${record.revision}/${file.path}`) throw new Error("distribution_canvas_source_origin_mismatch");
  }
  if (!["LICENSE", "Cargo.toml", ".gitmodules", ...(MODERN_CANVAS_VERSIONS.includes(record.version) ? ["Cargo.lock"] : [])].every(path => record.files.some(file => file.path === path))) throw new Error("distribution_canvas_source_contract_missing");
  const deps = record.vendors.find(vendor => vendor.kind === "skia-source" && vendor.files.some(file => file.path === "DEPS"));
  if (!deps || deps.version !== record.skiaRevision) throw new Error("distribution_canvas_skia_deps_missing");
  const depsText = original(deps.files.find(file => file.path === "DEPS")).toString("utf8");
  for (const vendor of record.vendors) {
    if (!/^[a-f0-9]{40}$/u.test(vendor.version) || !vendor.files.length
      || (vendor.kind === "skia-vendor" && !depsText.includes(`${vendor.repository}@${vendor.version}`))) throw new Error("distribution_canvas_vendor_source_pin_mismatch");
    for (const file of vendor.files) {
      original(file);
      const expected = vendor.kind === "skia-source"
        ? `https://raw.githubusercontent.com/google/skia/${record.skiaRevision}/${file.path}`
        : `${vendor.repository}/+/${vendor.version}/${file.path}?format=TEXT`;
      if (file.url !== expected) throw new Error("distribution_canvas_vendor_notice_origin_mismatch");
    }
  }
  for (const crate of record.crates) {
    if (crate.url !== `https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate` || !/^[a-f0-9]{64}$/u.test(crate.sha256)) throw new Error("distribution_canvas_crate_source_invalid");
    for (const file of crate.files) {
      original(file);
      if (file.sourcePath) {
        const restoration = crate.sourceRestoration;
        const vcs = JSON.parse(original(restoration.vcsInfo));
        if (vcs.git?.sha1 !== restoration.revision || vcs.path_in_vcs !== restoration.pathInVcs
          || file.url !== `https://raw.githubusercontent.com/${restoration.repository}/${restoration.revision}/${file.sourcePath}`) throw new Error("distribution_canvas_crate_restoration_origin_mismatch");
      } else if (file.url !== crate.url) throw new Error("distribution_canvas_crate_notice_origin_mismatch");
    }
  }
  if (MODERN_CANVAS_VERSIONS.includes(record.version)) {
    if (!sbom || sbom.metadata?.component?.name !== metadata.name || sbom.metadata?.component?.version !== metadata.version
      || !sbom.components?.some(component => component.purl?.startsWith("pkg:cargo/") && component.hashes?.length)) throw new Error("distribution_canvas_supplier_sbom_missing_or_stale");
    for (const component of sbom.components ?? []) {
      if (component.purl?.startsWith("pkg:cargo/") && component.hashes?.length) {
        const digest = component.hashes.find(hash => hash.alg === "SHA-256")?.content;
        if (!record.crates.some(crate => crate.name === component.name && crate.version === component.version && crate.sha256 === digest)) throw new Error("distribution_canvas_crate_sbom_digest_mismatch");
      } else if (component["bom-ref"]?.startsWith("skia-vendored:")) {
        const repository = component.properties?.find(property => property.name === "cdx:skia:repositoryUrl")?.value;
        if (!record.vendors.some(vendor => vendor.name === component.name && vendor.version === component.version && vendor.repository === repository)) throw new Error("distribution_canvas_vendor_sbom_pin_mismatch");
      }
    }
  }
}

export function collectCanvasMaterials({ metadata, nativeDirectory, sourceBinding }, add, components) {
  if (metadata.name !== "@napi-rs/canvas" || !SUPPORTED_CANVAS_VERSIONS.includes(metadata.version) || !nativeDirectory) return undefined;
  const manifest = JSON.parse(readFileSync(new URL("./vendor-notices/canvas-native-sources.json", import.meta.url)));
  const record = manifest.entries.find(entry => entry.version === metadata.version);
  const nativeMetadata = JSON.parse(readFileSync(join(nativeDirectory, "package.json")));
  const sbomPath = join(nativeDirectory, "sbom.cdx.json"), sbom = existsSync(sbomPath) ? JSON.parse(readFileSync(sbomPath)) : undefined;
  validateCanvasSourceMaterials(record, sourceBinding, nativeMetadata, sbom);
  if (sbom) for (const file of (sbom.components ?? []).filter(component => component.type === "file")) {
    if (basename(file.name) !== file.name || file.name.includes("\\") || file.name === ".."
      || sha256(readFileSync(join(nativeDirectory, file.name))) !== file.hashes?.find(hash => hash.alg === "SHA-256")?.content) throw new Error("distribution_canvas_supplier_binary_digest_mismatch");
  }
  const prefix = `canvas-${record.version}`, licenseFiles = [];
  for (const file of record.files) add(`sources/native/${prefix}/${file.path}`, original(file));
  for (const vendor of record.vendors) for (const file of vendor.files) {
    const path = `${vendor.name}-${vendor.version}/${file.path}`;
    if (file.path === "DEPS") add(`sources/native/${prefix}/${path}`, original(file));
    else licenseFiles.push(add(`licenses/native/${prefix}/${path}`, original(file)));
  }
  for (const crate of record.crates) for (const file of crate.files) {
    const path = `${crate.name}-${crate.version}/${file.path}`;
    if (file.path.endsWith("/Cargo.toml")) add(`sources/native/${prefix}/crates/${path}`, original(file));
    else licenseFiles.push(add(`licenses/native/${prefix}/crates/${path}`, original(file)));
  }
  add(`inputs/native/${prefix}-source-receipt.json`, json({ ...record, files: record.files.map(({ contentBase64, ...file }) => file), vendors: record.vendors.map(vendor => ({ ...vendor, files: vendor.files.map(({ contentBase64, ...file }) => file) })), crates: record.crates.map(crate => ({ ...crate, files: crate.files.map(({ contentBase64, ...file }) => file) })) }));
  add(`sources/native/${prefix}/SOURCE_ACCESS.md`, `# Canvas native source access\n\n- Canvas source: https://github.com/${record.repository}/tree/${record.revision}\n- Skia source: https://github.com/google/skia/tree/${record.skiaRevision}\n\nThe exact Skia vendor source repositories/revisions and Rust crate source archive URLs/checksums are listed in inputs/native/${prefix}-source-receipt.json. Original upstream grants and attributions accompany these records in licenses/native/${prefix}.\n\nRust dependency evidence: ${record.rustDependencyEvidence}. ${record.version === "0.1.80" ? "The historical Rust resolution is not reconstructed, and newer crate sources are not represented as that older binary's exact dependency graph." : "The candidate binary digest and each supplier-SBOM crate/vendor pin are checked before collection."}\n\nThis is collection of supplier-published evidence and source access, not a claim of reproducible native builds or exhaustive legal clearance.\n`);
  components.push({ identifier: `native:canvas:${record.version}`, name: "Canvas Skia and native supplier dependencies", version: record.version, kind: "native-supplier-source-materials", license: "NOASSERTION", licenseFiles, sourceRevision: record.revision, rustDependencyEvidence: record.rustDependencyEvidence });
  const limitations = record.version === "0.1.80" ? [{
    component: `@napi-rs/canvas@${record.version}`,
    reason: "historical_native_rust_resolution_not_published",
    details: "Original Canvas source, fixed Skia source/vendor grants and source access are collected. The 0.1.80 supplier published neither Cargo.lock nor a binary SBOM; its historical Rust build graph cannot be reconstructed from public metadata. This collection does not claim a complete historical Rust dependency graph or a reproducible native build.",
  }] : [];
  return { licenseFiles, historicalRustResolutionPublished: MODERN_CANVAS_VERSIONS.includes(record.version), limitations };
}

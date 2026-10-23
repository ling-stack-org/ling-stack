/** Original native supplier notices and fixed source access, separate from npm grants. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const safePath = value => typeof value === "string" && !value.startsWith("/") && !/[\\:\0]/u.test(value) && !value.split("/").some(part => ["", ".", ".."].includes(part));
const originalBytes = file => {
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (!safePath(file.path) || sha256(bytes) !== file.sha256 || bytes.length !== file.sizeBytes) throw new Error("distribution_native_original_notice_digest_mismatch");
  return bytes;
};

/** Interpret only the fixed recipe's URL substitutions; never execute supplier shell code. */
export function sharpSourceUrls(recipe, properties) {
  for (const [, name, value] of properties.matchAll(/^(VERSION_\w+)=(.+)$/gmu)) {
    recipe = recipe.replaceAll(`\${${name}}`, value)
      .replaceAll(`\${${name}//./-}`, value.replaceAll(".", "-"))
      .replaceAll(`\${${name}//./_}`, value.replaceAll(".", "_"))
      .replaceAll(`$(without_patch $${name})`, value.split(".").slice(0, 2).join("."))
      .replaceAll(`$(without_prerelease $${name})`, value.split("-")[0]);
  }
  return [...new Set([...recipe.matchAll(/\$CURL (https:\/\/\S+)/gu)].map(match => match[1]))];
}

export function validateSharpSourceMaterials(record, metadata, versionsBytes) {
  if (record.schemaVersion !== 1 || record.kind !== "sharp-libvips-exact-upstream-source-materials"
    || record.name !== metadata.name || record.version !== metadata.version || record.registry?.gitHead !== record.revision
    || !/^[a-f0-9]{40}$/u.test(record.revision) || sha256(versionsBytes) !== record.versionsSha256) throw new Error("distribution_libvips_source_identity_mismatch");
  const files = new Map();
  for (const file of record.files) {
    const bytes = originalBytes(file);
    if (file.url !== `https://raw.githubusercontent.com/${record.repository}/${record.revision}/${file.path}`
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob) throw new Error("distribution_libvips_source_origin_mismatch");
    files.set(file.path, bytes);
  }
  const sourcePackage = JSON.parse(files.get("npm/darwin-arm64/package.json"));
  if (sourcePackage.name !== metadata.name || sourcePackage.version !== metadata.version) throw new Error("distribution_libvips_source_package_mismatch");
  const urls = sharpSourceUrls(files.get("build/posix.sh").toString("utf8"), files.get("versions.properties").toString("utf8"));
  if (urls.length !== record.sources.length || new Set(record.sources.map(source => source.url)).size !== urls.length
    || record.sources.some(source => !urls.includes(source.url) || !/^[a-f0-9]{64}$/u.test(source.sha256) || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0)) throw new Error("distribution_libvips_source_recipe_mismatch");
  for (const source of record.sources) {
    if (source.kind === "source-patch") {
      const bytes = Buffer.from(source.contentBase64, "base64");
      if (sha256(bytes) !== source.sha256 || bytes.length !== source.sizeBytes) throw new Error("distribution_libvips_source_patch_digest_mismatch");
    } else if (source.kind !== "source-archive" || !source.notices?.length) throw new Error("distribution_libvips_archive_notices_missing");
    for (const file of source.notices) originalBytes(file);
  }
  return files;
}

export function validateWindowsLibvipsMaterials(record, metadata, versionsBytes, binaryDigests) {
  if (record.schemaVersion !== 1 || record.kind !== "sharp-windows-libvips-upstream-binding" || record.name !== metadata.name || record.version !== metadata.version
    || record.registry?.gitHead !== record.revision || !/^[a-f0-9]{40}$/u.test(record.revision)
    || sha256(versionsBytes) !== record.versionsSha256 || !/^sha256:[a-f0-9]{64}$/u.test(record.supplierRelease?.digest ?? "")
    || !/^[a-f0-9]{40}$/u.test(record.supplierSourceRevision)) throw new Error("distribution_windows_libvips_source_identity_mismatch");
  const file = record.sourcePackage, bytes = originalBytes(file), sourcePackage = JSON.parse(bytes);
  if (sourcePackage.name !== metadata.name || sourcePackage.version !== metadata.version
    || file.url !== `https://raw.githubusercontent.com/${record.repository}/${record.revision}/${file.path}`
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob) throw new Error("distribution_windows_libvips_source_origin_mismatch");
  for (const file of record.originalSupplierFiles) originalBytes(file);
  const originalVersions = record.originalSupplierFiles.find(file => file.path.endsWith("/versions.json"));
  if (!originalVersions || !originalBytes(originalVersions).equals(versionsBytes)) throw new Error("distribution_windows_libvips_supplier_version_mismatch");
  if (!record.binaries.length || record.binaries.some(file => !safePath(file.path) || binaryDigests[file.path]?.sha256 !== file.sha256
    || binaryDigests[file.path]?.sizeBytes !== file.sizeBytes)) throw new Error("distribution_windows_libvips_supplier_binary_mismatch");
}

export function collectSharpLibvipsMaterials(metadata, directory, add, components) {
  const windows = metadata.name === "@img/sharp-win32-x64" && metadata.version === "0.35.5";
  if (!windows && (metadata.name !== "@img/sharp-libvips-darwin-arm64" || metadata.version !== "1.3.4")) return undefined;
  const record = JSON.parse(readFileSync(new URL("./vendor-notices/sharp-libvips-sources.json", import.meta.url)));
  const versions = readFileSync(join(directory, "versions.json"));
  // Both suppliers publish an identical version table. Windows gets its own
  // binary/source binding and recipe; only corresponding original grants are shared.
  const files = validateSharpSourceMaterials(record, windows ? { name: record.name, version: record.version } : metadata, versions);
  const windowsRecord = windows && JSON.parse(readFileSync(new URL("./vendor-notices/sharp-libvips-windows.json", import.meta.url)));
  if (windowsRecord) {
    const binaryDigests = Object.fromEntries(windowsRecord.binaries.map(file => {
      if (!safePath(file.path)) throw new Error("distribution_windows_libvips_binary_path_invalid");
      const bytes = readFileSync(join(directory, file.path));
      return [file.path, { sha256: sha256(bytes), sizeBytes: bytes.length }];
    }));
    validateWindowsLibvipsMaterials(windowsRecord, metadata, versions, binaryDigests);
  }
  const licenseFiles = [];
  for (const [path, bytes] of files) if (!windows || ["LICENSE", "versions.properties", "build/win.sh"].includes(path)) add(`sources/gstack/sharp-libvips/${path}`, bytes);
  for (const source of record.sources) {
    const id = sha256(source.url).slice(0, 16);
    if (source.kind === "source-patch" && !windows) add(`sources/gstack/sharp-libvips/frozen-patches/${id}.patch`, Buffer.from(source.contentBase64, "base64"));
    for (const file of source.notices) licenseFiles.push(add(`licenses/gstack/sharp-libvips/${id}/${file.path}`, originalBytes(file)));
  }
  if (windowsRecord) {
    for (const file of windowsRecord.originalSupplierFiles) if (!file.path.endsWith("/versions.json")) licenseFiles.push(add(`licenses/gstack/sharp-libvips/windows-supplier/${file.path}`, originalBytes(file)));
    add("inputs/gstack/sharp-libvips-windows-binding.json", json(windowsRecord));
  }
  add("inputs/gstack/sharp-libvips-source-receipt.json", json({ ...record, files: record.files.map(({ contentBase64, ...file }) => file), sources: record.sources.map(({ contentBase64, notices, ...source }) => ({ ...source, notices: notices.map(({ contentBase64, ...file }) => file) })) }));
  const sourceDirections = windowsRecord
    ? `The candidate's libvips-42.dll is byte-identical to the official Windows supplier release recorded in inputs/gstack/sharp-libvips-windows-binding.json. Its exact original version table matches the original source-archive notice set below. Windows build source and patches: https://github.com/${windowsRecord.supplierRepository}/tree/${windowsRecord.supplierSourceRevision}. Obtain that fixed tree and follow its build.sh instructions to modify and rebuild vips-web for x86_64. The macOS recipe and its patches are not Windows rebuild instructions. The original LGPL supplier license accompanies this record.`
    : `The accompanying source recipe is ${record.repository}@${record.revision}, selected by the published ${metadata.name}@${metadata.version} npm revision and the candidate's exact versions.json digest. Obtain the exact sources to inspect, modify and rebuild the shared library using the supplied original build recipe. Use the included frozen patch bytes when reproducing the recipe; moving upstream patch URLs must not replace those bytes.`;
  add("sources/gstack/sharp-libvips-source-access.md", `# libvips source access\n\n${sourceDirections}\n\nThe original LGPL and other component notices are in licenses/gstack/sharp-libvips. Each complete upstream source archive and its observed SHA-256 is listed in inputs/gstack/sharp-libvips-source-receipt.json. The shared libvips library remains a separate file in the packaged sharp lib directory.\n\n${record.sources.filter(source => source.kind === "source-archive").map(source => `- [${source.url}](${source.url}), SHA-256 ${source.sha256}`).join("\n")}\n\nThis records source access and original attribution for the supplier's declared dependency set. It does not assert reproducible native builds, signature verification or exhaustive legal approval.\n`);
  components.push({ identifier: `gstack:libvips-source:${metadata.version}`, name: "libvips and declared native dependencies", version: metadata.version, kind: "native-supplier-source-materials", license: "NOASSERTION", licenseFiles, sourceRevision: record.revision,
    scope: windowsRecord ? "Windows supplier DLL and original version table are byte-verified against the official release; corresponding source-version notices, original LGPL grant and pinned Windows source/build access are collected. The macOS patches are not applied to Windows."
      : "Original notices from every source archive selected by the exact published macOS supplier recipe, frozen patch bytes, and fixed source-download digests. Large source archives are accessed through the supplied exact source index." });
  return { licenseFiles, sourceMaterialsCollected: true };
}

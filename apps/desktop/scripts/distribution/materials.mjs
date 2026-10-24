#!/usr/bin/env node
/** Exact-input collection, not a legal clearance or release-eligibility grant. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateNoticeRestoration } from "./restored-notices.mjs";
import { builderVersion, originalTemplates, patchInstallerTemplate } from "./installer-builder.mjs";
import { collectSharpLibvipsMaterials } from "./native-vendor-materials.mjs";
import { collectCanvasMaterials } from "./canvas-materials.mjs";
import { verifyPackagedBrowser } from "../../../../packages/core/src/bundled-skill-browser.ts";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const platformTargets = Object.freeze({ "darwin-arm64": "aarch64-apple-darwin", "win32-x64": "x86_64-pc-windows-msvc" });
export const noticePattern = /^(?:licen[cs]es?|copying|copyright|notices?|third[-_ ]?party[-_ ]?(?:notices?|licenses?))(?:[._-]|$)/iu;
const binaryPattern = /\.(?:node|dll|exe|dylib|so|a|woff2?|ttf|otf)$/iu;
const posix = value => value.split(sep).join("/");
export const sha256 = value => createHash("sha256").update(value).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const safeName = value => `${value.replace(/[^a-zA-Z0-9.-]/gu, "_")}-${sha256(value).slice(0, 10)}`;

export function parseArguments(values) {
  const [command, ...rest] = values;
  if (!["inspect", "prepare", "verify"].includes(command)) throw new Error("distribution_command_required:inspect|prepare|verify");
  const result = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = { "--platform": "platform", "--gstack-workspace": "gstackWorkspace", "--resources": "resources", "--output": "output", "--source-sha": "sourceSha", "--root": "root" }[rest[index]];
    if (!key || !rest[index + 1] || rest[index + 1].startsWith("--") || Object.hasOwn(result, key)) throw new Error(`distribution_argument_invalid:${rest[index]}`);
    result[key] = rest[index + 1];
  }
  if (!Object.hasOwn(platformTargets, result.platform)) throw new Error("distribution_platform_invalid");
  if (command === "verify" && !result.resources) throw new Error("distribution_resources_required");
  return result;
}

export function filesBelow(directory, { symlinks = false } = {}) {
  const files = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (!symlinks) throw new Error(`distribution_symlink_not_allowed:${posix(relative(directory, path))}`);
      } else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("distribution_special_file_not_allowed");
    }
  }
  visit(directory);
  return files;
}

export function lockedPackageKeys(lockfile) {
  const section = /^packages:\r?\n([\s\S]*?)(?=^snapshots:|$(?![\s\S]))/mu.exec(lockfile)?.[1];
  if (!section) throw new Error("distribution_lockfile_packages_missing");
  return new Set([...section.matchAll(/^ {2}([^ \r\n].*):\r?$/gmu)].map(match => {
    const key = match[1];
    return key.startsWith("'") ? key.slice(1, -1).replaceAll("''", "'") : key.startsWith('"') ? JSON.parse(key) : key;
  }));
}

export function resolveInstalledPackage(from, name) {
  if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/u.test(name)) throw new Error(`distribution_package_name_invalid:${name}`);
  for (let current = from; ; current = dirname(current)) {
    const path = join(current, "node_modules", name);
    if (existsSync(join(path, "package.json"))) return realpathSync(path);
    if (dirname(current) === current) return undefined;
  }
}

export function collectInstalledClosure(root, platform) {
  const wanted = { os: platform.split("-")[0], cpu: platform.split("-")[1] };
  const queue = ["apps/desktop", "apps/web", "apps/chrome-extension", "packages/daemon"].map(path => join(root, path));
  const font = resolveInstalledPackage(join(root, "apps/desktop"), "@fontsource-variable/inter");
  if (!font) throw new Error("distribution_inter_font_missing");
  queue.push(font);
  const packages = [], seen = new Set(), gaps = [];
  const supports = (rule, value) => !Array.isArray(rule) || (!rule.includes(`!${value}`) && (rule.every(item => item.startsWith("!")) || rule.includes(value)));
  for (let index = 0; index < queue.length; index++) {
    const path = realpathSync(queue[index]);
    if (seen.has(path)) continue;
    seen.add(path);
    const metadata = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    if (!supports(metadata.os, wanted.os) || !supports(metadata.cpu, wanted.cpu)) continue;
    packages.push({ path, metadata });
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies }).sort()) {
      const installed = resolveInstalledPackage(path, name);
      const optional = Object.hasOwn(metadata.optionalDependencies ?? {}, name) || metadata.peerDependenciesMeta?.[name]?.optional;
      if (installed) queue.push(installed);
      else if (!optional) gaps.push({ component: `${metadata.name}@${metadata.version}`, reason: "installed_dependency_missing", dependency: name });
    }
  }
  return { packages, gaps };
}

function noticeFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!noticePattern.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && !entry.isSymbolicLink()) files.push(path);
    else if (entry.isDirectory()) files.push(...filesBelow(path));
  }
  return files.sort();
}

export function hasCompleteReadmeGrant(text) {
  return /Permission is hereby granted[\s\S]+THE SOFTWARE IS PROVIDED[\s\S]+(?:LIABILITY|DEALINGS IN THE SOFTWARE)/iu.test(text)
    || /Redistribution and use in source and binary forms[\s\S]+THIS SOFTWARE IS PROVIDED/iu.test(text)
    || /DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE[\s\S]+You just DO WHAT THE FUCK YOU WANT TO/iu.test(text);
}

export function declaredLicenseMaterials(metadata, packageJsonBytes, prefix, add) {
  const sourcePath = new URL("./vendor-notices/standard/sources.json", import.meta.url);
  const sources = JSON.parse(readFileSync(sourcePath));
  const declaration = typeof metadata.license === "string" ? { value: metadata.license, path: "license" }
    : typeof metadata.license?.type === "string" ? { value: metadata.license.type, path: "license.type" }
    : metadata.licenses?.length === 1 && typeof metadata.licenses[0].type === "string" ? { value: metadata.licenses[0].type, path: "licenses[0].type" } : undefined;
  const entry = sources.entries.find(entry => entry.id === declaration?.value);
  if (!entry) return [];
  const bytes = readFileSync(new URL(`./vendor-notices/standard/${entry.path}`, import.meta.url));
  if (sha256(bytes) !== entry.sha256) throw new Error("distribution_standard_license_digest_mismatch");
  const published = JSON.parse(packageJsonBytes);
  if (published.name !== metadata.name || published.version !== metadata.version || JSON.stringify([published.license, published.licenses]) !== JSON.stringify([metadata.license, metadata.licenses])) throw new Error("distribution_declared_license_package_identity_mismatch");
  add(`${prefix}/published-package.json`, packageJsonBytes);
  add(`${prefix}/declared-license-evidence.json`, json({ schemaVersion: 1, package: `${metadata.name}@${metadata.version}`, declaredLicense: entry.id, declaration: `published-package.json#${declaration.path}`, standardText: { ...entry, repository: sources.repository, revision: sources.revision },
    scope: "Exact published SPDX declaration plus canonical standard license text. Package-specific attribution remains verbatim in the published metadata and all supplied notice files; no missing author or copyright notice is invented. This does not establish native/vendor source compliance." }));
  return [add(`${prefix}/standard-${entry.id}.txt`, bytes)];
}

function run(command, args, root) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function collectMaterials(options) {
  const root = realpathSync(options.root ?? repositoryRoot);
  const sourceSha = options.sourceSha ?? process.env.DESKTOP_SOURCE_SHA ?? run("git", ["rev-parse", "HEAD"], root);
  if (!/^[a-f0-9]{40}$/u.test(sourceSha) || run("git", ["rev-parse", "HEAD"], root) !== sourceSha) throw new Error("distribution_source_sha_mismatch");
  const lockBytes = readFileSync(join(root, "pnpm-lock.yaml"));
  const keys = lockedPackageKeys(lockBytes.toString("utf8"));
  const epoch = Number(run("git", ["show", "-s", "--format=%ct", sourceSha], root));
  const created = new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const material = new Map(), components = [], gaps = [], limitations = [], identities = new Map();
  function add(path, bytes) {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => ["..", "", "."].includes(part))) throw new Error("distribution_material_path_invalid");
    const content = Buffer.from(bytes);
    if (material.has(path) && !material.get(path).equals(content)) throw new Error(`distribution_material_collision:${path}`);
    material.set(path, content);
    return path;
  }
  function copy(path, target) { return add(target, readFileSync(path)); }
  function copySource(directory, prefix) {
    if (!existsSync(directory)) { gaps.push({ component: prefix, reason: "native_source_missing" }); return []; }
    const result = [];
    function visit(current) {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        if (["target", "node_modules", ".git", "bin", "obj", ".DS_Store"].includes(entry.name)) continue;
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`distribution_source_symlink:${prefix}/${entry.name}`);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) result.push(copy(path, `${prefix}/${posix(relative(directory, path))}`));
      }
    }
    visit(directory);
    return result;
  }
  add("inputs/pnpm-lock.yaml", lockBytes);
  copy(join(root, "LICENSE"), "LICENSE");
  copy(join(root, "THIRD_PARTY_NOTICES.md"), "inputs/source-tree-notices.md");
  copy(join(root, "docs/maintenance/asset-provenance.md"), "inputs/asset-provenance.md");
  const restorationPath = new URL("./notice-sources.json", import.meta.url);
  const restorations = existsSync(restorationPath) ? JSON.parse(readFileSync(restorationPath)) : { entries: [] };
  const closure = collectInstalledClosure(root, options.platform);
  gaps.push(...closure.gaps);
  for (const { path, metadata } of closure.packages) {
    if (metadata.name.startsWith("@ling-stack/")) continue;
    const identity = `${metadata.name}@${metadata.version}`;
    if (!keys.has(identity)) { gaps.push({ component: identity, reason: "package_absent_from_current_lockfile" }); continue; }
    const input = { name: metadata.name, version: metadata.version, license: typeof metadata.license === "string" ? metadata.license : "NOASSERTION", repository: metadata.repository ?? null, integritySource: "inputs/pnpm-lock.yaml", packageJsonSha256: sha256(readFileSync(join(path, "package.json"))) };
    const licenses = noticeFiles(path);
    const prefix = `licenses/npm/${safeName(identity)}`;
    const copied = licenses.map(file => copy(file, `${prefix}/${posix(relative(path, file))}`));
    if (copied.length === 0) {
      const readme = readdirSync(path).find(name => /^readme(?:\.|$)/iu.test(name));
      if (readme && hasCompleteReadmeGrant(readFileSync(join(path, readme), "utf8"))) copied.push(copy(join(path, readme), `${prefix}/${readme}`));
      else {
        const restoration = restorations.entries.find(entry => entry.name === metadata.name && entry.version === metadata.version);
        if (restoration) {
          const restored = validateNoticeRestoration(restoration, metadata, lockBytes.toString("utf8"));
          copied.push(add(`${prefix}/restored-LICENSE`, restored.license));
          add(`${prefix}/source-package.json`, restored.sourcePackage);
          add(`${prefix}/notice-restoration.json`, json(restoration));
        } else {
          copied.push(...declaredLicenseMaterials(metadata, readFileSync(join(path, "package.json")), prefix, add));
          if (!copied.length) gaps.push({ component: identity, reason: "license_text_missing_from_exact_installed_package", declaredLicense: metadata.license ?? null });
        }
      }
    }
    if (existsSync(join(path, "sbom.cdx.json"))) {
      const sbomBytes = readFileSync(join(path, "sbom.cdx.json"));
      const sbom = JSON.parse(sbomBytes);
      if (sbom.metadata?.component?.name !== metadata.name || sbom.metadata?.component?.version !== metadata.version) throw new Error("distribution_vendor_sbom_identity_mismatch");
      for (const file of (sbom.components ?? []).filter(component => component.type === "file")) {
        if (file.name.includes("/") || file.name.includes("\\") || file.name === "..") throw new Error("distribution_vendor_sbom_file_invalid");
        const expected = file.hashes?.find(hash => hash.alg === "SHA-256")?.content;
        if (!expected || sha256(readFileSync(join(path, file.name))) !== expected) throw new Error("distribution_vendor_sbom_binary_mismatch");
      }
      add(`inputs/vendor/${safeName(identity)}/sbom.cdx.json`, sbomBytes);
    }
    const identifier = `npm:${identity}`;
    const current = { ...input, kind: "npm", identifier, licenseFiles: copied.sort(), scope: "conservative-installed-production-and-peer-closure" };
    if (identities.has(identifier)) {
      if (JSON.stringify(current) !== JSON.stringify(identities.get(identifier))) gaps.push({ component: identity, reason: "same_version_notice_metadata_differs_between_installed_variants" });
    } else { identities.set(identifier, current); components.push(current); }
    if (metadata.name === "@napi-rs/canvas") {
      const nativeName = `@napi-rs/canvas-${options.platform === "darwin-arm64" ? "darwin-arm64" : "win32-x64-msvc"}`;
      const nativeDirectory = resolveInstalledPackage(path, nativeName);
      const sourceBinding = restorations.entries.find(entry => entry.name === nativeName && entry.version === metadata.version);
      const collected = collectCanvasMaterials({ metadata, nativeDirectory, sourceBinding }, add, components);
      if (!collected) gaps.push({ component: identity, reason: "native_vendor_source_and_notice_materials_missing" });
      else limitations.push(...collected.limitations);
    }
  }
  // Keep current copied vendor/protocol attribution independently from npm pruning.
  for (const path of ["packages/daemon/src/runtime/adapters/codex/protocol", "packages/daemon/native/image-sanitizer", "packages/browser-host/native", options.platform === "win32-x64" ? "packages/daemon/native/engine-supervisor" : "native/sandbox"]) {
    const directory = join(root, path);
    copySource(directory, `sources/repository/${path}`);
    if (existsSync(join(directory, "Cargo.toml"))) {
      try {
        const metadata = JSON.parse(run("cargo", ["metadata", "--offline", "--locked", "--format-version", "1", "--filter-platform", platformTargets[options.platform], "--manifest-path", join(directory, "Cargo.toml")], root));
        const active = new Set(metadata.resolve.nodes.map(node => node.id));
        for (const pkg of metadata.packages.filter(pkg => active.has(pkg.id))) {
          const identifier = `cargo:${pkg.name}@${pkg.version}`;
          if (identities.has(identifier)) continue;
          const pkgRoot = dirname(pkg.manifest_path);
          const prefix = `licenses/cargo/${safeName(`${pkg.name}@${pkg.version}`)}`;
          const copied = noticeFiles(pkgRoot).map(file => copy(file, `${prefix}/${posix(relative(pkgRoot, file))}`));
          if (!copied.length && !pkg.source) copied.push("LICENSE");
          if (!copied.length) gaps.push({ component: identifier, reason: "cargo_license_text_missing" });
          // Actual sources of statically linked crates accompany the candidate; no source-availability guess.
          copySource(pkgRoot, `sources/cargo/${safeName(`${pkg.name}@${pkg.version}`)}`);
          const component = { identifier, kind: "cargo", name: pkg.name, version: pkg.version, license: pkg.license ?? "NOASSERTION", source: pkg.source ?? `repository:${path}`, licenseFiles: copied.sort() };
          identities.set(identifier, component); components.push(component);
        }
      } catch (cause) {
        gaps.push({ component: path, reason: "locked_offline_cargo_materials_unavailable", details: `cargo metadata --offline --locked failed for the selected target (exit ${cause.status ?? "unavailable"}); required exact downloaded crate inputs must already exist after the native build.` });
      }
    }
  }
  for (const path of ["apps/desktop/scripts/native/office-driver", "apps/desktop/scripts/native/locked-control", "apps/desktop/scripts/native/human-evaluation", ...(options.platform === "darwin-arm64" ? ["native/office-local"] : [])]) {
    if (existsSync(join(root, path))) copySource(join(root, path), `sources/repository/${path}`);
  }
  const electron = resolveInstalledPackage(join(root, "apps/desktop"), "electron");
  if (!electron) gaps.push({ component: "electron", reason: "electron_distribution_missing" });
  else {
    for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
      const file = join(electron, "dist", name);
      if (existsSync(file)) copy(file, `licenses/electron/${name}`);
      else gaps.push({ component: "electron", reason: `electron_distribution_${name}_missing` });
    }
    const version = JSON.parse(readFileSync(join(electron, "package.json"))).version;
    components.push({ identifier: `electron:${version}`, kind: "runtime", name: "Electron with Chromium notices", version, license: "NOASSERTION", licenseFiles: ["licenses/electron/LICENSE", "licenses/electron/LICENSES.chromium.html"] });
  }
  if (options.platform === "win32-x64") {
    const audit = inspectInstallerTemplates(root);
    add("inputs/installer-template-audit.json", json(audit));
    gaps.push(...audit.gaps);
    collectInstallerMaterials(root, add, components, gaps);
    collectDotnetRuntimeMaterials(root, add, components, gaps);
  }
  collectGstack(options.gstackWorkspace, add, components, gaps, root, options.platform);
  components.sort((a, b) => a.identifier.localeCompare(b.identifier, "en"));
  for (const entries of [gaps, limitations]) {
    entries.splice(0, entries.length, ...new Map(entries.map(entry => [JSON.stringify(entry), entry])).values());
    entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  }
  const base = { schemaVersion: 1, kind: "desktop-distribution-materials", platform: options.platform, sourceSha, lockfileSha256: sha256(lockBytes), created, status: gaps.length ? "blocked" : "collected", releaseEligible: false,
    scope: "Technical collection from current installed production/peer inputs, native source graph and supplied gstack resources. No exhaustive legal approval or application acceptance claim.", components, gaps, limitations };
  add("THIRD_PARTY_NOTICES.md", createThirdPartyNotices(base));
  add("distribution.spdx.json", json(createSpdx(base, material)));
  const entries = [...material].map(([path, bytes]) => ({ path, sizeBytes: bytes.length, sha256: sha256(bytes) })).sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifest = { ...base, files: entries };
  add("distribution-manifest.json", json(manifest));
  add("SHA256SUMS.txt", [...material].map(([path, bytes]) => `${sha256(bytes)}  ${path}`).sort().join("\n") + "\n");
  return { manifest, material };
}

export function collectGstackBundleNotices(name, directory, add) {
  const notices = filesBelow(directory, { symlinks: true }).filter(file => noticePattern.test(basename(file)));
  const files = notices.map(file => {
    const sourcePath = posix(relative(directory, file)), bytes = readFileSync(file);
    // Original .app/.framework ancestors are provenance, not executable
    // bundles. Keep them in the index so the signer sees only notice files.
    const materialPath = add(`licenses/gstack/${name}/${sha256(sourcePath)}/${basename(file)}`, bytes);
    return { sourcePath, materialPath, sizeBytes: bytes.length, sha256: sha256(bytes) };
  });
  if (files.length) add(`inputs/gstack/${name}-notice-paths.json`, json({ schemaVersion: 1, group: name,
    scope: "Copy mapping for selected original notice bytes; archive provenance remains in the existing candidate inputs.", files }));
  return files;
}

export function collectBrowserAcquisitionMaterial(directory, selection, target, add, components) {
  if (selection?.activation !== "download-required") return false;
  const descriptor = verifyPackagedBrowser(directory, selection, target);
  const bytes = readFileSync(descriptor.entry), recipe = JSON.parse(bytes);
  descriptor.assertCurrent();
  add("inputs/gstack/browser-acquisition.json", bytes);
  components.push({ identifier: `external-browser:chrome-for-testing@${recipe.browserVersion}:${target.platform}-${target.arch}`,
    kind: "external-browser-reference", name: "Google Chrome for Testing", version: recipe.browserVersion,
    license: "NOASSERTION", licenseFiles: [],
    scope: "Fixed official URL, archive and member hashes only. Chrome is downloaded directly from the official source into the user's cache on first browser use; no browser binary is redistributed in this candidate. Copyright references do not establish a redistribution grant." });
  return true;
}

export function collectGstack(workspace, add, components, gaps, repository = repositoryRoot, platform) {
  if (!workspace) { gaps.push({ component: "gstack", reason: "gstack_workspace_required" }); return; }
  if (!existsSync(workspace)) { gaps.push({ component: "gstack", reason: "gstack_workspace_missing" }); return; }
  const root = realpathSync(workspace);
  for (const path of ["desktop-candidate.json", "artifacts/resource/desktop-resources/dependency-audit.json", "artifacts/resource/desktop-resources/third-party-notice-installation.json", "artifacts/resource/desktop-resources/shell-parser-build.json", "artifacts/browser/desktop-inspection/browser-license-candidates.json", "artifacts/browser/desktop-inspection/browser-member-inventory.json"]) {
    if (existsSync(join(root, path))) add(`inputs/gstack/${basename(path)}`, readFileSync(join(root, path)));
    else gaps.push({ component: "gstack", reason: "gstack_evidence_missing", path });
  }
  const bundle = join(root, "artifacts/native/desktop-executable/gstack");
  const browser = join(root, "artifacts/native/desktop-executable/gstack-browser");
  const resource = join(root, "artifacts/resource/desktop-resources");
  const auditPath = join(resource, "dependency-audit.json");
  if (existsSync(auditPath)) {
    const audit = JSON.parse(readFileSync(auditPath));
    if (!Array.isArray(audit.packages) || !Array.isArray(audit.blockers)
      || (platform && `${audit.target?.platform}-${audit.target?.arch}` !== platform)) throw new Error("distribution_gstack_dependency_audit_invalid");
    const runtime = join(existsSync(bundle) ? bundle : resource, "runtime");
    const safeRuntimeFile = path => {
      if (typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => ["..", ".", ""].includes(part))) throw new Error("distribution_gstack_audit_path_invalid");
      const file = join(runtime, path);
      if (!existsSync(file) || !realpathSync(file).startsWith(`${realpathSync(runtime)}${sep}`)) throw new Error("distribution_gstack_audit_file_missing_or_outside_runtime");
      return file;
    };
    for (const pkg of audit.packages) {
      const bytes = readFileSync(safeRuntimeFile(`${pkg.path}/package.json`));
      const metadata = JSON.parse(bytes);
      if (metadata.name !== pkg.name || metadata.version !== pkg.version || `sha256:${sha256(bytes)}` !== pkg.metadataChecksum) throw new Error("distribution_gstack_package_identity_mismatch");
      const licenseFiles = (pkg.noticePaths ?? []).map(path => {
        const bytes = readFileSync(safeRuntimeFile(path));
        if (`sha256:${sha256(bytes)}` !== pkg.noticeChecksums?.[path]) throw new Error("distribution_gstack_notice_digest_mismatch");
        return add(`licenses/gstack/packages/${path}`, bytes);
      });
      if (!licenseFiles.length) licenseFiles.push(...declaredLicenseMaterials(metadata, bytes, `licenses/gstack/packages/${pkg.path}`, add));
      const nativeMaterials = collectSharpLibvipsMaterials(metadata, dirname(safeRuntimeFile(`${pkg.path}/package.json`)), add, components);
      if (nativeMaterials) licenseFiles.push(...nativeMaterials.licenseFiles);
      components.push({ identifier: `gstack:npm:${pkg.name}@${pkg.version}:${sha256(pkg.path).slice(0, 12)}`, name: pkg.name, version: pkg.version, kind: "gstack-npm", license: pkg.license ?? "NOASSERTION", licenseFiles, runtimePath: pkg.path,
        nativeSourceMaterialsCollected: Boolean(nativeMaterials?.sourceMaterialsCollected),
        scope: "Exact metadata and notice digests from retained candidate dependency audit; restrictive/native terms remain explicit unresolved items." });
    }
    for (const blocker of audit.blockers) {
      const pkg = audit.packages.find(pkg => pkg.path === blocker.path);
      // A missing standalone file can be satisfied by the package's explicit
      // standard-SPDX declaration and the corresponding original standard text.
      if (blocker.code === "dependency_notice_missing" && pkg && components.some(component => component.runtimePath === pkg.path && component.licenseFiles.length)) continue;
      if (blocker.code === "dependency_license_review" && ["@img/sharp-libvips-darwin-arm64", "@img/sharp-win32-x64"].includes(pkg?.name)
        && components.some(component => component.runtimePath === pkg.path && component.nativeSourceMaterialsCollected)) continue;
      gaps.push({ component: pkg ? `gstack/${pkg.name}@${pkg.version}` : `gstack/${blocker.path}`, reason: blocker.code, path: blocker.path,
        ...(pkg ? { declaredLicense: pkg.license } : {}) });
    }
  }
  const executableReceipt = existsSync(join(bundle, "executable-build.json"))
    ? JSON.parse(readFileSync(join(bundle, "executable-build.json"))) : undefined;
  for (const [name, directory] of [["gstack", bundle], ["gstack-browser", browser]]) {
    if (!existsSync(directory)) { gaps.push({ component: name, reason: "gstack_bundle_missing" }); continue; }
    if (name === "gstack-browser" && collectBrowserAcquisitionMaterial(directory, executableReceipt?.browser,
      { platform: platform?.split("-")[0], arch: platform?.split("-")[1] }, add, components)) continue;
    const notices = collectGstackBundleNotices(name, directory, add);
    if (!notices.length) gaps.push({ component: name, reason: "gstack_bundle_notice_texts_missing" });
  }
  if (existsSync(join(bundle, "native-build.json"))) add("inputs/gstack/native-build.json", readFileSync(join(bundle, "native-build.json")));
  for (const path of ["runtime/browser-cache"]) {
    const directory = join(bundle, path);
    if (!existsSync(directory)) gaps.push({ component: `gstack/${path}`, reason: "required_gstack_runtime_resource_missing" });
  }
  const runtime = join(existsSync(bundle) ? bundle : resource, "runtime");
  collectToolchainMaterials(runtime, add, components, gaps);
  const pinBytes = readFileSync(join(repository, "scripts/gstack/testsavant-model-pin.json"));
  const pin = JSON.parse(pinBytes);
  add("inputs/gstack/testsavant-model-pin.json", pinBytes);
  const acquisition = join(runtime, "testsavant-model-acquisition.json");
  if (existsSync(acquisition)) {
    const bytes = readFileSync(acquisition), record = JSON.parse(bytes);
    if (record.schemaVersion !== 1 || record.mode !== "download-required" || record.pinChecksum !== `sha256:${sha256(JSON.stringify(pin))}`
      || record.repository !== pin.repository || record.revision !== pin.revision || JSON.stringify(record.files) !== JSON.stringify(pin.files)
      || record.totalBytes !== pin.files.reduce((sum, file) => sum + file.sizeBytes, 0)) throw new Error("distribution_testsavant_acquisition_pin_mismatch");
    if (existsSync(join(runtime, "models"))) throw new Error("distribution_external_model_weights_must_not_be_bundled");
    add("inputs/gstack/testsavant-model-acquisition.json", bytes);
    add("inputs/gstack/testsavant-source-observations.json", readFileSync(new URL("./vendor-notices/testsavant-source-observations.json", import.meta.url)));
    components.push({ identifier: `external-model:${pin.repository}@${pin.revision}`, kind: "external-model-reference", name: pin.repository, version: pin.revision, license: "NOASSERTION", licenseFiles: [],
      scope: "Fixed official source and hash metadata only. Weights are acquired into the user's cache on first use and are not redistributed in this candidate. Public availability does not establish a model redistribution grant." });
  } else if (existsSync(join(runtime, "models/testsavant-small"))) {
    gaps.push({ component: `gstack/model:${pin.repository}@${pin.revision}`, reason: "bundled_model_redistribution_grant_unavailable" });
  } else gaps.push({ component: "gstack/testsavant", reason: "model_acquisition_metadata_missing" });
  const parserNotice = readFileSync(join(repository, "scripts/gstack/shell-ast/THIRD-PARTY-NOTICES"));
  const parserReceipt = join(resource, "shell-parser-build.json");
  if (existsSync(parserReceipt)) {
    const record = JSON.parse(readFileSync(parserReceipt));
    if (!record.inputs?.some(file => file.path === "THIRD-PARTY-NOTICES" && file.checksum === `sha256:${sha256(parserNotice)}`)) throw new Error("distribution_shell_parser_notice_digest_mismatch");
    add("licenses/gstack/shell-ast/THIRD-PARTY-NOTICES", parserNotice);
  }
  const browserCandidates = join(root, "artifacts/browser/desktop-inspection/browser-license-candidates.json");
  if (existsSync(browserCandidates)) {
    const record = JSON.parse(readFileSync(browserCandidates));
    const candidates = Array.isArray(record) ? record : record.notices;
    if (!Array.isArray(candidates)) throw new Error("distribution_browser_notice_candidates_invalid");
    for (const candidate of candidates) {
      if (typeof candidate.text !== "string" || candidate.checksum !== `sha256:${sha256(candidate.text)}`) throw new Error("distribution_browser_notice_candidate_digest_mismatch");
      const referenceOnly = executableReceipt?.browser?.activation === "download-required" && candidate.archive !== "ffmpeg";
      add(`${referenceOnly ? "inputs/gstack/browser-source-references" : "licenses/gstack/browser-originals"}/${safeName(`${candidate.archive}/${candidate.path}`)}`, candidate.text);
    }
  }
  components.push({ identifier: "gstack:desktop-candidate", kind: "bundled-runtime", name: "gstack with native tools, FFmpeg and fixed browser/model acquisition metadata", version: "candidate", license: "NOASSERTION", licenseFiles: [] });
}

export function validateBunSourceRevision(version, sourceRevision, reportedRevision) {
  // Bun 1.4.4 prints a nine-character git revision, not its full source SHA.
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision) || reportedRevision !== `${version}+${sourceRevision.slice(0, 9)}`) throw new Error("distribution_bun_source_revision_mismatch");
}

export function collectToolchainMaterials(runtime, add, components, gaps) {
  const manifestBytes = readFileSync(new URL("./vendor-notices/toolchain-sources.json", import.meta.url));
  const manifest = JSON.parse(manifestBytes), selected = [];
  for (const [name, file] of [["Node.js", "node"], ["Bun", "bun"]]) {
    const executable = join(runtime, "tools", `${file}${process.platform === "win32" ? ".exe" : ""}`);
    if (!existsSync(executable)) { gaps.push({ component: `gstack/${name}`, reason: "runtime_executable_missing" }); continue; }
    const version = run(executable, ["--version"], runtime);
    const source = manifest.entries.find(entry => entry.name === name && entry.version === version);
    if (!source) { gaps.push({ component: `gstack/${name}@${version}`, reason: "exact_upstream_toolchain_notice_record_missing" }); continue; }
    if (name === "Bun") validateBunSourceRevision(version, source.revision, run(executable, ["--revision"], runtime));
    selected.push(source);
    if (name === "Bun") selected.push(manifest.entries.find(entry => entry.name === "Bun patched JavaScriptCore/WebKit"));
    add(`inputs/gstack/toolchain/${file}-binary.json`, json({ name, version, sizeBytes: lstatSync(executable).size, sha256: sha256(readFileSync(executable)), sourceRevision: source.revision,
      scope: "Exact candidate runtime bytes and self-reported version/revision, paired with original upstream notices. No official binary-download provenance is asserted." }));
  }
  for (const source of selected) {
    if (!source || !/^[a-f0-9]{40}$/u.test(source.revision)) throw new Error("distribution_toolchain_source_record_invalid");
    const licenseFiles = [];
    for (const file of source.files) {
      const bytes = Buffer.from(file.contentBase64, "base64");
      const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (sha256(bytes) !== file.sha256 || blob !== file.gitBlob || bytes.length !== file.sizeBytes
        || file.url !== `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${file.path}` || file.path.split("/").includes("..")) throw new Error("distribution_toolchain_notice_digest_or_origin_mismatch");
      licenseFiles.push(add(`licenses/gstack/toolchain/${safeName(`${source.name}@${source.version}`)}/${file.path}`, bytes));
    }
    components.push({ identifier: `gstack:toolchain:${source.name}@${source.version}`, name: source.name, version: source.version, kind: "native-toolchain", license: "NOASSERTION", licenseFiles, sourceRevision: source.revision, sourceArchive: source.sourceArchive });
  }
  const sourceAccess = selected.map(source => `- ${source.name} ${source.version}: [exact source archive](${source.sourceArchive}); [source tree](https://github.com/${source.repository}/tree/${source.revision}).`).join("\n");
  add("sources/gstack/toolchain-source-access.md", `# Native runtime source access\n\n${sourceAccess}\n\nThe original Bun LICENSE.md supplied in the licenses directory describes static JavaScriptCore linking and rebuilding/relinking. Its exact build/deps/webkit.ts pins the accompanying patched WebKit revision. To modify that library, obtain both exact source trees above, follow the original pinned build scripts, and use Bun's documented local WebKit build mode. These source links and instructions do not assert that our original local tool executables were officially downloaded or that an arbitrary latest source tree corresponds to these bytes.\n`);
}

export function collectDotnetRuntimeMaterials(root, add, components, gaps) {
  const project = join(root, "apps/desktop/scripts/native/office-driver/windows");
  const assetsPath = join(project, "obj/project.assets.json");
  if (!existsSync(assetsPath)) { gaps.push({ component: "office-driver-dotnet", reason: "published_dotnet_restore_assets_missing" }); return; }
  const assets = JSON.parse(readFileSync(assetsPath));
  const dependencies = Object.values(assets.project?.frameworks ?? {}).flatMap(framework => framework.downloadDependencies ?? []);
  const selected = dependencies.filter(dependency => /^Microsoft\.NETCore\.App\.Runtime\.win-x64$/iu.test(dependency.name));
  if (!selected.length) { gaps.push({ component: "office-driver-dotnet", reason: "exact_restored_runtime_pack_identity_missing" }); return; }
  for (const dependency of selected) {
    const range = /^\[([^,\]]+),\s*\1\]$/u.exec(dependency.version ?? "");
    const version = range?.[1];
    if (!version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version)) throw new Error("distribution_dotnet_runtime_version_not_exact");
    const directories = Object.keys(assets.packageFolders ?? {}).map(folder => join(folder, dependency.name.toLowerCase(), version));
    const directory = directories.find(directory => existsSync(directory));
    if (!directory) { gaps.push({ component: `${dependency.name}@${version}`, reason: "restored_runtime_pack_missing" }); continue; }
    const prefix = `licenses/dotnet/${safeName(`${dependency.name}@${version}`)}`;
    const licenses = noticeFiles(directory).map(file => add(`${prefix}/${posix(relative(directory, file))}`, readFileSync(file)));
    if (!licenses.some(path => /third[-_ ]?party/iu.test(path)) || !licenses.some(path => /license/iu.test(path))) gaps.push({ component: `${dependency.name}@${version}`, reason: "restored_runtime_original_license_or_third_party_notices_missing" });
    const nuspec = readdirSync(directory).find(file => file.endsWith(".nuspec"));
    if (nuspec) add(`${prefix}/${nuspec}`, readFileSync(join(directory, nuspec)));
    components.push({ identifier: `dotnet:${dependency.name}@${version}`, name: dependency.name, version, kind: "self-contained-runtime", license: "NOASSERTION", licenseFiles: licenses,
      source: `https://github.com/dotnet/runtime/tree/v${version}`, scope: "Original restored runtime-pack notices selected by the actual Office project publish restore assets. Raw machine-specific restore paths are not published." });
  }
}

export function inspectInstallerTemplates(root) {
  const config = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"))).build?.nsis;
  const lane = readFileSync(join(root, "apps/desktop/scripts/cua-driver-electron-package.mjs"), "utf8");
  const builder = resolveInstalledPackage(join(root, "apps/desktop"), "electron-builder");
  const library = builder && resolveInstalledPackage(builder, "app-builder-lib");
  const files = [], gaps = [];
  if (config?.script || !lane.includes("prepareDistributionBuilder({ desktopRoot: appRoot, outputRoot: toolingRoot })")) gaps.push({ component: "windows-installer", reason: "reviewed_private_stock_template_overlay_not_selected" });
  if (!library || JSON.parse(readFileSync(join(library, "package.json"))).version !== builderVersion) {
    gaps.push({ component: "windows-installer", reason: "reviewed_installer_builder_version_mismatch" });
  } else for (const file of Object.keys(originalTemplates)) {
    const before = readFileSync(join(library, file), "utf8"), after = patchInstallerTemplate(file, before);
    files.push({ path: file, originalSha256: sha256(before), modifiedSha256: sha256(after) });
    if (/\b(?:SpiderBanner|WinShell)::/u.test(after)) throw new Error("distribution_removed_installer_plugin_still_referenced");
  }
  return { schemaVersion: 1, kind: "installer-template-audit", status: gaps.length ? "blocked" : "checked", builderVersion, files, retainedPlugins: ["System", "nsExec", "StdUtils", "nsis7z"], scope: "Stock install, upgrade, atomic rename/rollback, uninstall and 7z extraction are retained. Only SpiderBanner display calls and WinShell calls are replaced in private tooling copies.", gaps };
}

export function collectInstallerMaterials(root, add, components, gaps) {
  const receiptBytes = readFileSync(new URL("./vendor-notices/nsis-source.json", import.meta.url));
  const receipt = JSON.parse(receiptBytes);
  const licenseBytes = readFileSync(new URL("./vendor-notices/NSIS-COPYING", import.meta.url));
  if (sha256(licenseBytes) !== receipt.licenseSha256) throw new Error("distribution_nsis_license_digest_mismatch");
  const builder = resolveInstalledPackage(join(root, "apps/desktop"), "electron-builder");
  const library = builder && resolveInstalledPackage(builder, "app-builder-lib");
  if (!library || JSON.parse(readFileSync(join(library, "package.json"))).version !== receipt.appBuilderLibVersion
    || sha256(readFileSync(join(library, "out/toolsets/windows.js"))) !== receipt.toolsetModuleSha256) {
    gaps.push({ component: "windows-installer", reason: "nsis_source_receipt_does_not_match_current_builder" });
    return;
  }
  const licenseFile = add("licenses/nsis/COPYING", licenseBytes);
  add("inputs/nsis-source.json", receiptBytes);
  for (const file of filesBelow(join(library, "templates/nsis"))) add(`sources/electron-builder/${posix(relative(library, file))}`, readFileSync(file));
  for (const file of Object.keys(originalTemplates)) add(`sources/electron-builder-overlay/${file}`, patchInstallerTemplate(file, readFileSync(join(library, file), "utf8")));
  for (const file of ["installer-builder.mjs", "LingShell.nsh"]) add(`sources/repository/apps/desktop/scripts/distribution/${file}`, readFileSync(new URL(`./${file}`, import.meta.url)));
  for (const [name, directory] of [["electron-builder", builder], ["app-builder-lib", library]]) {
    const licenseFiles = noticeFiles(directory).map(file => add(`licenses/nsis/${name}/${posix(relative(directory, file))}`, readFileSync(file)));
    if (!licenseFiles.length) {
      const bytes = readFileSync(join(directory, "package.json"));
      licenseFiles.push(...declaredLicenseMaterials(JSON.parse(bytes), bytes, `licenses/nsis/${name}`, add));
    }
    components.push({ identifier: `npm:${name}@${builderVersion}`, kind: "installer-template", name, version: builderVersion, license: "MIT", licenseFiles });
  }
  const plugins = JSON.parse(readFileSync(new URL("./vendor-notices/nsis-plugins/sources.json", import.meta.url)));
  const pluginNotices = JSON.parse(readFileSync(new URL("./vendor-notices/nsis-plugins/original-notices.json", import.meta.url)));
  add("inputs/nsis-plugin-sources.json", json(plugins));
  for (const source of plugins.entries) {
    if (basename(source.file) !== source.file) throw new Error("distribution_nsis_source_archive_path_invalid");
    const bytes = readFileSync(new URL(`./vendor-notices/nsis-plugins/${source.file}`, import.meta.url));
    if (sha256(bytes) !== source.sha256 || bytes.length !== source.sizeBytes) throw new Error("distribution_nsis_source_archive_digest_mismatch");
    const archive = add(`sources/nsis-plugins/${source.file}`, bytes);
    const notice = pluginNotices.entries.find(entry => entry.name === source.name && entry.version === source.version && entry.sourceArchiveSha256 === source.sha256);
    if (!notice?.files?.length) throw new Error("distribution_nsis_original_notices_missing");
    const licenseFiles = notice.files.map(file => {
      const content = Buffer.from(file.contentBase64, "base64");
      if (sha256(content) !== file.sha256 || content.length !== file.sizeBytes) throw new Error("distribution_nsis_original_notice_digest_mismatch");
      return add(`licenses/nsis-plugins/${safeName(`${source.name}@${source.version}`)}/${file.path}`, content);
    });
    components.push({ identifier: `nsis-plugin:${source.name}@${source.version}`, name: source.name, version: source.version, kind: "installer-plugin", license: "NOASSERTION", licenseFiles, source: source.url, sourceArchive: archive, sourceArchiveSha256: source.sha256, reviewedBinarySha256: source.binarySha256,
      scope: "Complete unmodified upstream paired source archive, including original applicable license and third-party notices. LGPL components are not described as public domain. Reviewed binary digest is recorded for final-installer verification." });
  }
  components.push({ identifier: `nsis:${receipt.releaseName}`, kind: "installer-runtime", name: receipt.component, version: receipt.releaseName, license: "NOASSERTION", licenseFiles: [licenseFile], source: receipt.archive, sourceArchiveSha256: receipt.archiveSha256,
    scope: "Original compiler-archive COPYING, stock installer templates and narrowly modified private template sources; compiler choice is bound to the exact installed app-builder-lib toolset module. System/nsExec use the compiler terms; StdUtils/nsis7z paired original source archives accompany the installer." });
}

export function createThirdPartyNotices(manifest) {
  const limitations = manifest.limitations ?? [];
  return `# Third-party materials for Ling Stack ${manifest.platform}\n\nSource: ${manifest.sourceSha}\nLockfile SHA-256: ${manifest.lockfileSha256}\n\n${manifest.scope}\n\nStatus: ${manifest.status}. See distribution-manifest.json for unresolved items.\n\n${limitations.length ? `## Evidence limitations\n\n${limitations.map(item => `- ${item.component}: ${item.details}`).join("\n")}\n\n` : ""}${manifest.components.map(component => `- ${component.name} ${component.version ?? ""}: ${component.license ?? "NOASSERTION"}; ${(component.licenseFiles ?? []).join(", ") || "see component evidence"}`).join("\n")}\n`;
}

export function createSpdx(manifest, material) {
  const documentName = `ling-stack-${manifest.platform}-${manifest.sourceSha}`;
  const packages = manifest.components.map(component => ({ SPDXID: `SPDXRef-${safeName(component.identifier)}`, name: component.name, ...(component.version ? { versionInfo: component.version } : {}), downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION", comment: `Input scope: ${component.scope ?? component.kind}; license texts: ${(component.licenseFiles ?? []).join(", ")}` }));
  const files = [...material].map(([path, bytes]) => ({ SPDXID: `SPDXRef-File-${sha256(path).slice(0, 24)}`, fileName: `./${path}`, checksums: [{ algorithm: "SHA256", checksumValue: sha256(bytes) }], licenseConcluded: "NOASSERTION", copyrightText: "NOASSERTION" }));
  return { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: documentName, documentNamespace: `https://github.com/ling-stack-org/ling-stack/spdx/${documentName}-${manifest.lockfileSha256}`, creationInfo: { created: manifest.created, creators: ["Tool: ling-stack-desktop-distribution-1"] }, documentComment: manifest.scope, packages, files,
    relationships: [...packages, ...files].map(item => ({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: item.SPDXID })) };
}

export function writeMaterials(result, output) {
  if (existsSync(output) && readdirSync(output).length) throw new Error("distribution_output_must_be_empty");
  for (const [path, bytes] of result.material) { mkdirSync(dirname(join(output, path)), { recursive: true }); writeFileSync(join(output, path), bytes); }
  return result.manifest;
}

export function verifyMaterials({ resources, output, platform, sourceSha }) {
  const directory = resolve(resources, "distribution");
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) throw new Error("distribution_packaged_materials_missing");
  const manifest = JSON.parse(readFileSync(join(directory, "distribution-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.kind !== "desktop-distribution-materials" || manifest.platform !== platform || !/^[a-f0-9]{40}$/u.test(manifest.sourceSha ?? "") || (sourceSha && manifest.sourceSha !== sourceSha)) throw new Error("distribution_packaged_identity_mismatch");
  if (manifest.status !== "collected" || !Array.isArray(manifest.gaps) || manifest.gaps.length) throw new Error("distribution_packaged_materials_blocked");
  const limitations = manifest.limitations ?? [];
  if (!Array.isArray(limitations) || limitations.some(item => !item || ["component", "reason", "details"].some(key => typeof item[key] !== "string" || !item[key]))) throw new Error("distribution_packaged_limitations_invalid");
  const sums = readFileSync(join(directory, "SHA256SUMS.txt"), "utf8").trim().split("\n");
  const expected = new Map();
  for (const line of sums) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    if (!match || match[2].split("/").some(part => ["..", "", "."].includes(part)) || isAbsolute(match[2]) || match[2].includes("\\") || expected.has(match[2])) throw new Error("distribution_checksum_manifest_invalid");
    expected.set(match[2], match[1]);
  }
  const actual = filesBelow(directory).map(path => posix(relative(directory, path))).filter(path => path !== "SHA256SUMS.txt");
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error("distribution_packaged_material_set_mismatch");
  for (const [path, digest] of expected) if (sha256(readFileSync(join(directory, path))) !== digest) throw new Error(`distribution_packaged_material_digest_mismatch:${path}`);
  if (!Array.isArray(manifest.files) || manifest.files.length !== expected.size - 1 || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error("distribution_inventory_manifest_mismatch");
  for (const file of manifest.files) if (typeof file.path !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "") || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || expected.get(file.path) !== file.sha256 || readFileSync(join(directory, file.path)).length !== file.sizeBytes) throw new Error("distribution_inventory_manifest_mismatch");
  if (output) {
    const sourceFiles = filesBelow(output).map(path => posix(relative(output, path)));
    if (sourceFiles.length !== actual.length + 1 || sourceFiles.some(path => !existsSync(join(directory, path)) || sha256(readFileSync(join(output, path))) !== sha256(readFileSync(join(directory, path))))) throw new Error("distribution_packaged_materials_differ_from_prepared");
  }
  // Inventory the final expanded resources as evidence. No extension-based license clearance.
  const runtimeFiles = filesBelow(resources, { symlinks: true }).filter(path => !path.startsWith(`${directory}${sep}`));
  const nativeAndFontInventory = runtimeFiles.filter(path => binaryPattern.test(path) || /\/(?:ling-browser-host|ling-image-sanitizer|ling-sandbox-runner|ling-human-evaluation-helper)$/u.test(posix(path))).map(path => ({ path: posix(relative(resources, path)), sizeBytes: lstatSync(path).size, sha256: sha256(readFileSync(path)) }));
  return { schemaVersion: 1, kind: "desktop-distribution-verification", status: "verified", platform, sourceSha: manifest.sourceSha, materialFiles: actual.length + 1, manifestSha256: sha256(readFileSync(join(directory, "distribution-manifest.json"))), limitations, nativeAndFontInventory, scope: "Byte and set verification of embedded collected materials plus inventory of final native/font files; no legal approval or full runtime acceptance claim." };
}

export function runCli(values = process.argv.slice(2)) {
  const options = parseArguments(values);
  const output = resolve(options.output ?? join(options.root ?? repositoryRoot, "apps/desktop/dist/distribution"));
  if (options.command === "verify") {
    const result = verifyMaterials({ ...options, output, sourceSha: options.sourceSha ?? process.env.DESKTOP_SOURCE_SHA });
    process.stdout.write(json(result));
    return result;
  }
  const result = collectMaterials(options);
  if (options.command === "prepare") writeMaterials(result, output);
  process.stdout.write(json({ ...result.manifest, files: undefined, components: undefined, componentCount: result.manifest.components.length, materialFileCount: result.material.size }));
  if (options.command === "prepare" && result.manifest.gaps.length) process.exitCode = 1;
  return result.manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runCli(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

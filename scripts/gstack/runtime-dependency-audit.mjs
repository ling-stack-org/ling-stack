import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget } from "./build-native-runtime.mjs";
import { reviewExactPublicDomainRuntimePackage } from "./public-domain-package-review.mjs";

// Same permissive expressions as the repository policy, not a legal approval.
const allowed = new Set(["0BSD", "Apache-2.0", "BSD", "BSD-2-Clause", "BSD-3-Clause",
  "BlueOak-1.0.0", "CC-BY-4.0", "ISC", "MIT", "MPL-2.0", "OFL-1.1", "Python-2.0",
  "Unlicense", "WTFPL", "WTFPL OR ISC", "(BSD-3-Clause OR GPL-2.0)", "(MIT AND Zlib)",
  "(MIT OR Apache-2.0)", "(MIT OR CC0-1.0)", "(MIT OR GPL-3.0-or-later)",
  "(MPL-2.0 OR Apache-2.0)", "(WTFPL OR MIT)"]);
const inside = (root, path) => {
  const value = relative(root, path);
  return !value || !isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\");
};
const portable = (path) => path.split("\\").join("/");
const checksum = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export async function auditGstackRuntimeDependencies({ runtimeRoot, target }) {
  const requested = resolve(runtimeRoot);
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gstack_dependency_audit_root_invalid");
  if (!["darwin", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch)) {
    throw new Error("gstack_dependency_audit_target_invalid");
  }
  const root = await realpath(requested);
  const report = { schemaVersion: 1, reviewStatus: "pending", releaseEligible: false, target,
    packages: [], nativeComponents: [], links: [], blockers: [] };
  const block = (code, path) => report.blockers.push({ code, path });

  async function scanPackage(path) {
    const bytes = await readFile(join(root, path, "package.json"));
    const metadata = JSON.parse(bytes.toString("utf8"));
    if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
      block("dependency_metadata_invalid", path); return;
    }
    const metadataLicense = typeof metadata.license === "string" ? metadata.license
      : Array.isArray(metadata.licenses) ? metadata.licenses.map(l => l.type).join(" OR ") : "Unknown";
    const noticePaths = [];
    const noticeChecksums = {};
    const mitEvidence = [];
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(entry.name)) continue;
      const location = `${path}/${entry.name}`;
      noticePaths.push(location);
      const notice = await readFile(join(root, location));
      noticeChecksums[location] = checksum(notice);
      if (completeMitNotice(notice.toString("utf8"))) {
        mitEvidence.push({ path: location, checksum: noticeChecksums[location], method: "complete-mit-text" });
      }
    }
    const license = metadataLicense === "Unknown" && mitEvidence.length ? "MIT" : metadataLicense;
    const publicDomain = await reviewExactPublicDomainRuntimePackage({ packageRoot: join(root, path),
      name: metadata.name, version: metadata.version, license });
    const licenseEvidence = metadataLicense === "Unknown" && license === "MIT" ? mitEvidence : [];
    if (publicDomain) licenseEvidence.push({ ...publicDomain, path: `${path}/${publicDomain.path}` });
    report.packages.push({ name: metadata.name, version: metadata.version, path, license,
      metadataLicense, licenseEvidence,
      metadataChecksum: checksum(bytes), noticePaths: noticePaths.sort(), noticeChecksums });
    if (!allowed.has(license) && !publicDomain) block("dependency_license_review", path);
    if (!noticePaths.length) block("dependency_notice_missing", path);
  }

  async function walk(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const location = `${path}/${entry.name}`;
      const absolute = join(root, location);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(absolute).catch(() => undefined);
        if (!resolved || !inside(root, resolved)) {
          block("dependency_link_escape", location);
        } else {
          report.links.push({ path: location, target: portable(relative(dirname(absolute), resolved)) });
          block("dependency_link_materialization_required", location);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (await lstat(join(absolute, "package.json")).then(s => s.isFile() && !s.isSymbolicLink(), e => {
          if (e.code === "ENOENT") return false; throw e;
        }) && /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/.test(location)) await scanPackage(location);
        await walk(location);
      } else if (entry.isFile() && /\.(?:node|dylib|dll|exe|so(?:\.\d+)*)$|\/rg$/.test(location)) {
        const targetMatch = await matchesNativeDependency(absolute, target);
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(absolute)) hash.update(bytes);
        report.nativeComponents.push({ path: location, checksum: `sha256:${hash.digest("hex")}`, targetMatch });
        if (!targetMatch) block("dependency_native_target_mismatch", location);
      } else if (!entry.isFile()) block("dependency_resource_kind_invalid", location);
    }
  }
  for (const path of ["node_modules", "lib/diagram-render/node_modules"]) {
    const stat = await lstat(join(root, path)).catch(error => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) { block("dependency_resource_kind_invalid", path); continue; }
    await walk(path);
  }
  for (const name of ["packages", "nativeComponents", "links", "blockers"]) {
    report[name].sort((a, b) => a.path.localeCompare(b.path, "en"));
  }
  report.checksPassed = report.blockers.length === 0;
  return report;
}

function completeMitNotice(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return /^(?:The )?MIT License(?: \(MIT\))? Copyright /i.test(normalized) &&
    /Permission is hereby granted, free of charge, to any person obtaining a copy of this software/i.test(normalized) &&
    /subject to the following conditions/i.test(normalized) &&
    /above copyright notice and this permission notice shall be included in all copies or substantial portions/i.test(normalized) &&
    /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/i.test(normalized) &&
    /IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE/i.test(normalized) &&
    !/GNU (?:LESSER |AFFERO )?GENERAL PUBLIC LICENSE|Apache License/i.test(normalized);
}

export async function matchesNativeDependency(path, target) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const read = async (offset, length) => {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, offset);
      return bytes.subarray(0, bytesRead);
    };
    const header = await read(0, Math.min(size, 4096));
    try { assertNativeTarget(header, target); return true; } catch { /* Check universal libraries below. */ }
    if (target.platform !== "darwin" || header.length < 8) return false;
    const magic = header.readUInt32BE(0);
    if (![0xcafebabe, 0xcafebabf].includes(magic)) return false;
    const count = header.readUInt32BE(4);
    const entrySize = magic === 0xcafebabe ? 20 : 32;
    const tableSize = 8 + count * entrySize;
    if (!count || count > 64 || tableSize > header.length) return false;
    const cpu = target.arch === "arm64" ? 0x0100000c : 0x01000007;
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * entrySize;
      if (header.readUInt32BE(entry) !== cpu) continue;
      const offset = magic === 0xcafebabe ? header.readUInt32BE(entry + 8) : Number(header.readBigUInt64BE(entry + 8));
      const length = magic === 0xcafebabe ? header.readUInt32BE(entry + 12) : Number(header.readBigUInt64BE(entry + 16));
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < tableSize || length < 32 || length > size - offset) return false;
      try { assertNativeTarget(await read(offset, 32), target); return true; } catch { return false; }
    }
    return false;
  } finally { await file.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, platform = process.platform, arch = process.arch] = process.argv.slice(2);
  if (!runtimeRoot) throw new Error("Usage: runtime-dependency-audit.mjs <runtime> [platform] [arch]");
  const report = await auditGstackRuntimeDependencies({ runtimeRoot, target: { platform, arch } });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.checksPassed) process.exitCode = 1;
}

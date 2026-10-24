import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const desktopTargets = Object.freeze({
  "macos-arm64": ["macos-arm64.dmg", "macos-arm64.zip"],
  "windows-x64": ["windows-x64-setup.exe"],
});

export function prereleaseVersion(tag) {
  if (typeof tag !== "string" || tag.length > 128) throw new Error("Invalid prerelease tag");
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))$/u.exec(tag);
  if (!match || match[2].split(".").some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error("Use an immutable SemVer prerelease tag, such as v0.1.2-alpha.2");
  }
  return match[1];
}

export function validateCandidate({ sha, tag, versionFile, rootVersion, desktopVersion }) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? "")) throw new Error("Source must be a complete lowercase commit SHA");
  const version = prereleaseVersion(tag);
  if ([versionFile, rootVersion, desktopVersion].some(value => value !== version)) {
    throw new Error("Release tag, VERSION, root package and Desktop package versions must match");
  }
  return Object.freeze({ schemaVersion: 1, sourceSha: sha, tag, version,
    signingTier: "unsigned_dev", distributionChannel: "development", releaseReady: false });
}

function git(args, root) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function readCandidate({ root = repositoryRoot, sha, tag, requireMain = false }) {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const desktopPackage = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
  const candidate = validateCandidate({ sha, tag,
    versionFile: (await readFile(join(root, "VERSION"), "utf8")).trim(),
    rootVersion: rootPackage.version, desktopVersion: desktopPackage.version });
  if (git(["rev-parse", "HEAD"], root) !== sha) throw new Error("Checkout does not match the chosen source SHA");
  if (git(["status", "--porcelain", "--untracked-files=no"], root)) throw new Error("Release source must be clean");
  if (requireMain) {
    git(["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], root);
    // Published tags and even earlier source-only tags are never repointed.
    if (git(["tag", "--list", tag], root)) throw new Error("Tag already exists; choose a new prerelease version");
  }
  return candidate;
}

export async function fileRecord(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Missing plain nonempty release file: ${basename(path)}`);
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return { name: basename(path), sizeBytes: stat.size, sha256: digest.digest("hex") };
}

export function targetAssets(candidate, target) {
  const suffixes = desktopTargets[target];
  if (!suffixes) throw new Error("Unsupported Desktop target");
  return suffixes.map(suffix => `Ling-Stack-${candidate.version}-${suffix}`);
}

export function targetEvidence(target) {
  if (!desktopTargets[target]) throw new Error("Unsupported Desktop target");
  return ["prerequisites.json", "package-verification.json", "distribution.tar.gz"]
    .map(name => `desktop-${target}-${name}`);
}

function assertPackageReport(report, candidate, target, artifacts) {
  if (report.sourceSha !== candidate.sourceSha || report.version !== candidate.version || report.target !== target
    || report.status !== "passed" || report.acceptance !== "archive_contents_and_unsigned_structure_only") {
    throw new Error("Missing matching package verification; runtime acceptance cannot be inferred from archive checks");
  }
  if (!Array.isArray(report.archives) || report.archives.length !== artifacts.length
    || report.archives.some((archive, index) => archive.name !== artifacts[index].name
      || archive.sizeBytes !== artifacts[index].sizeBytes || archive.sha256 !== artifacts[index].sha256)) {
    throw new Error("Package verification archives do not match the release artifact bytes");
  }
}

function assertPrerequisites(prerequisites, candidate, target) {
  if (prerequisites.sourceSha !== candidate.sourceSha || prerequisites.target !== target
    || prerequisites.buildPrerequisitesPass !== true) throw new Error("Missing matching successful build prerequisites");
}

function assertDistributionArchive(report, record) {
  const verified = report.distributionArchive;
  if (verified?.name !== "distribution.tar.gz" || verified.sizeBytes !== record.sizeBytes || verified.sha256 !== record.sha256) {
    throw new Error("Distribution archive does not match the verified embedded materials");
  }
}

export async function collectTarget({ candidate, target, releaseRoot, evidenceRoot, outputRoot }) {
  const names = targetAssets(candidate, target);
  const report = JSON.parse(await readFile(join(evidenceRoot, "package-verification.json"), "utf8"));
  const prerequisites = JSON.parse(await readFile(join(evidenceRoot, "prerequisites.json"), "utf8"));
  assertPrerequisites(prerequisites, candidate, target);
  const originalArtifacts = await Promise.all(names.map(name => fileRecord(join(releaseRoot, name))));
  assertPackageReport(report, candidate, target, originalArtifacts);
  assertDistributionArchive(report, await fileRecord(join(evidenceRoot, "distribution.tar.gz")));
  // A fresh output directory prevents stale candidates from joining a later run.
  await mkdir(outputRoot);
  const artifacts = [];
  for (const name of names) {
    const record = await fileRecord(join(releaseRoot, name));
    await copyFile(join(releaseRoot, name), join(outputRoot, name));
    const copied = await fileRecord(join(outputRoot, name));
    if (JSON.stringify(copied) !== JSON.stringify(record)) throw new Error("Release artifact changed while collecting");
    artifacts.push(record);
  }
  assertPackageReport(report, candidate, target, artifacts);
  const evidence = [];
  for (const [index, name] of ["prerequisites.json", "package-verification.json", "distribution.tar.gz"].entries()) {
    const source = await fileRecord(join(evidenceRoot, name));
    const outputName = targetEvidence(target)[index];
    await copyFile(join(evidenceRoot, name), join(outputRoot, outputName));
    const copied = await fileRecord(join(outputRoot, outputName));
    if (copied.sha256 !== source.sha256 || copied.sizeBytes !== source.sizeBytes) throw new Error("Release evidence changed while collecting");
    evidence.push(copied);
  }
  const copiedReport = JSON.parse(await readFile(join(outputRoot, targetEvidence(target)[1]), "utf8"));
  assertPackageReport(copiedReport, candidate, target, artifacts);
  assertDistributionArchive(copiedReport, evidence[2]);
  assertPrerequisites(JSON.parse(await readFile(join(outputRoot, targetEvidence(target)[0]), "utf8")), candidate, target);
  const manifest = { ...candidate, target, artifacts, evidence };
  await writeFile(join(outputRoot, `desktop-${target}.json`), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}

export async function verifyTargetInputs({ candidate, inputRoot }) {
  const manifests = [];
  const expectedFiles = new Set();
  for (const target of Object.keys(desktopTargets)) {
    const name = `desktop-${target}.json`;
    const manifest = JSON.parse(await readFile(join(inputRoot, name), "utf8"));
    const expected = { ...candidate, target };
    for (const [key, value] of Object.entries(expected)) {
      if (manifest[key] !== value) throw new Error(`Mixed release provenance: ${target}/${key}`);
    }
    const names = targetAssets(candidate, target);
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== names.length) throw new Error("Incomplete target artifact set");
    const evidenceNames = targetEvidence(target);
    if (!Array.isArray(manifest.evidence) || manifest.evidence.length !== evidenceNames.length) throw new Error("Incomplete target evidence set");
    const files = [...manifest.artifacts, ...manifest.evidence];
    const allowedNames = [...names, ...evidenceNames];
    for (const [index, artifact] of files.entries()) {
      if (artifact.name !== allowedNames[index]) throw new Error("Unexpected release asset name");
      const current = await fileRecord(join(inputRoot, artifact.name));
      if (current.sizeBytes !== artifact.sizeBytes || current.sha256 !== artifact.sha256) throw new Error("Release asset checksum mismatch");
      expectedFiles.add(artifact.name);
    }
    const report = JSON.parse(await readFile(join(inputRoot, evidenceNames[1]), "utf8"));
    assertPackageReport(report, candidate, target, manifest.artifacts);
    assertDistributionArchive(report, manifest.evidence[2]);
    assertPrerequisites(JSON.parse(await readFile(join(inputRoot, evidenceNames[0]), "utf8")), candidate, target);
    expectedFiles.add(name);
    manifests.push(manifest);
  }
  return { manifests, expectedFiles };
}

export async function assembleRelease({ candidate, inputRoot, outputRoot }) {
  const { manifests, expectedFiles } = await verifyTargetInputs({ candidate, inputRoot });
  const actual = await readdir(inputRoot);
  if (actual.length !== expectedFiles.size || actual.some(name => !expectedFiles.has(name))) throw new Error("Unexpected or duplicated target files");
  await mkdir(outputRoot);
  for (const name of expectedFiles) await copyFile(join(inputRoot, name), join(outputRoot, name));
  const copied = await verifyTargetInputs({ candidate, inputRoot: outputRoot });
  if (JSON.stringify(copied.manifests) !== JSON.stringify(manifests)) throw new Error("Target manifests changed while assembling");
  const files = await Promise.all([...expectedFiles].sort().map(name => fileRecord(join(outputRoot, name))));
  await writeFile(join(outputRoot, "checksums.txt"), files.map(file => `${file.sha256}  ${file.name}\n`).join(""), { flag: "wx" });
  const combined = { ...candidate, targets: manifests };
  await writeFile(join(outputRoot, "release-manifest.json"), JSON.stringify(combined, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(outputRoot, "release-notes.md"), [
    `Unsigned development prerelease built from \`${candidate.sourceSha}\`.`, "",
    "- macOS: Apple Silicon arm64; ad-hoc signed, without Developer ID or notarization.",
    "- Windows: x64; without Authenticode publisher signing.",
    "- Installation, model, Office and Computer Use acceptance must be recorded before publication.",
    "- This Draft does not establish production readiness, platform trust or automatic-update eligibility.", "",
    "Verify downloaded installers with checksums.txt. See the attached per-platform evidence and distribution materials.", "",
  ].join("\n"), { flag: "wx" });
  return combined;
}

async function main() {
  const [command] = process.argv.slice(2);
  const candidate = await readCandidate({ sha: process.env.DESKTOP_SOURCE_SHA, tag: process.env.DESKTOP_RELEASE_TAG,
    requireMain: process.env.DESKTOP_CREATE_DRAFT === "true" });
  if (command === "candidate") {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `source-sha=${candidate.sourceSha}\ntag=${candidate.tag}\nversion=${candidate.version}\n`);
    console.log(JSON.stringify(candidate, null, 2));
  } else if (command === "collect") {
    await collectTarget({ candidate, target: process.env.DESKTOP_TARGET,
      releaseRoot: join(repositoryRoot, "apps/desktop/release"), evidenceRoot: join(repositoryRoot, ".codex-artifacts/desktop-release"),
      outputRoot: resolve(process.env.DESKTOP_OUTPUT_ROOT) });
  } else if (command === "assemble") {
    await assembleRelease({ candidate, inputRoot: resolve(process.env.DESKTOP_INPUT_ROOT), outputRoot: resolve(process.env.DESKTOP_OUTPUT_ROOT) });
  } else throw new Error("Use candidate, collect, or assemble");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

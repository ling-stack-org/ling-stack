import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateLingPluginCatalog,
  validateLingPluginPackageManifest,
} from "../../packages/plugin-sdk/dist/index.js";
import {
  OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY,
  OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT,
} from "../../packages/core/dist/official-plugin-runtime.js";
import JSZip from "../../packages/daemon/node_modules/jszip/lib/index.js";
import { cuaDriverArtifactLayoutFor, cuaDriverArtifactPlatformForRuntime } from "../../apps/desktop/shared/cua-driver-artifact-layout.mjs";
import { validateCuaDriverProviderLockContract } from "../../apps/desktop/shared/cua-driver-provider-lock-contract.mjs";
import { CUA_DRIVER_PACKAGE_REVISION } from "../../apps/desktop/scripts/cua-driver-package-staging-contract.mjs";

const repositories = new Map([
  ["official:chrome-browser", "ling-stack-org/ling-plugin-chrome-browser"],
  ["official:office-documents", "ling-stack-org/ling-plugin-office-documents"],
  ["official:cua-driver", "ling-stack-org/ling-plugin-cua-driver"],
]);
const targets = [["darwin", "arm64"], ["win32", "x64"]];
const manifestPath = ".ling-plugin/plugin.json";
const checksumsPath = ".ling-plugin/checksums.json";
const provenancePath = ".ling-plugin/provenance.json";

const sources = JSON.parse(process.env.LING_PLUGIN_RELEASE_SOURCES ?? "null");
if (sources === null || typeof sources !== "object" || Array.isArray(sources)
  || Object.keys(sources).length !== repositories.size
  || [...repositories.keys()].some((id) => !Object.hasOwn(sources, id))) {
  throw new Error("Release sources must identify each of the three official plugins.");
}
const key = process.env.LING_PLUGIN_ARTIFACT_PRIVATE_KEY;
const pinnedKey = createPublicKey(OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY).export({ type: "spki", format: "der" });
if (!key || !createPublicKey(key).export({ type: "spki", format: "der" }).equals(pinnedKey)) {
  throw new Error("The release artifact signing key does not match the client public key.");
}

const root = await mkdtemp(join(tmpdir(), "ling-plugin-releases-"));
try {
  const plugins = [];
  for (const [pluginId, repository] of repositories) {
    const pin = sources[pluginId];
    if (!pin || !/^v\d+\.\d+\.\d+$/u.test(pin.tag) || !/^[a-f0-9]{40}$/u.test(pin.sourceSha)
      || !pin.sha256 || targets.some(([platform, arch]) => !/^[a-f0-9]{64}$/u.test(pin.sha256[`${platform}-${arch}`]))) {
      throw new Error(`A stable tag, exact source commit and reviewed asset digests are required for ${pluginId}.`);
    }
    const published = github(["release", "view", pin.tag, "--repo", repository, "--json", "tagName,isDraft,isPrerelease"]);
    const commit = github(["api", `repos/${repository}/commits/${pin.tag}`]);
    if (published.tagName !== pin.tag || published.isDraft || published.isPrerelease || commit.sha !== pin.sourceSha) {
      throw new Error(`Release ${repository}@${pin.tag} does not match the reviewed source.`);
    }
    const slug = pluginId.replace(":", "-");
    const version = pin.tag.slice(1);
    const artifacts = [];
    let metadata;
    for (const [platform, arch] of targets) {
      const name = `${slug}-${version}-${platform}-${arch}.ling-plugin.zip`;
      const path = join(root, name);
      github(["release", "download", pin.tag, "--repo", repository, "--pattern", name, "--dir", root], false);
      const info = await stat(path);
      if (info.size < 1 || info.size > 1024 ** 3) throw new Error(`Unexpected artifact size for ${name}.`);
      const bytes = await readFile(path);
      const digest = sha256(bytes);
      if (digest !== pin.sha256[`${platform}-${arch}`]) throw new Error(`Reviewed artifact digest does not match ${name}.`);
      const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
      const checksums = await readMember(archive, checksumsPath);
      const manifest = JSON.parse((await readMember(archive, manifestPath)).toString("utf8"));
      const provenance = JSON.parse((await readMember(archive, provenancePath)).toString("utf8"));
      validateLingPluginPackageManifest(manifest);
      const artifactId = `${pluginId}-${version}-${platform}-${arch}`;
      if (manifest.id !== pluginId || manifest.version !== version || manifest.artifactId !== artifactId
        || manifest.sourceKind !== "official-remote" || manifest.platform !== platform || manifest.arch !== arch
        || provenance.schemaVersion !== 1 || provenance.artifactId !== artifactId || provenance.sourceSha !== pin.sourceSha) {
        throw new Error(`Manifest or source identity does not match ${name}.`);
      }
      await verifyRuntimeMembers(archive, JSON.parse(checksums.toString("utf8")), pluginId, platform);
      artifacts.push({
        artifactId, pluginId, version, platform, arch,
        channel: "stable",
        url: `https://github.com/${repository}/releases/download/${pin.tag}/${name}`,
        sizeBytes: bytes.length,
        sha256: digest,
        signature: signature(bytes),
        runtimeChecksumSignature: signature(Buffer.concat([Buffer.from(OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT), checksums])),
        minLingVersion: manifest.minLingVersion,
        maxLingVersion: manifest.maxLingVersion,
        rollbackAllowed: manifest.rollbackAllowed,
      });
      metadata ??= manifest;
    }
    plugins.push({
      pluginId,
      displayName: metadata.displayName,
      description: metadata.description,
      homepageUrl: `https://github.com/${repository}`,
      trustSummary: metadata.trustSummary,
      latestStableVersion: version,
      manifest: {
        contributions: metadata.contributions,
        requiredSecrets: metadata.requiredSecrets,
        defaultApprovals: metadata.defaultApprovals,
        healthChecks: metadata.healthChecks,
      },
      artifacts,
    });
  }
  const catalog = {
    schemaVersion: 1,
    source: {
      repository: "ling-stack-org/ling-stack",
      releaseTag: "official-plugin-catalog",
      sourceSha: process.env.GITHUB_SHA,
    },
    generatedAt: new Date().toISOString(),
    plugins,
  };
  validateLingPluginCatalog(catalog);
  await writeFile(resolve(process.argv[2] ?? "plugins/catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function readMember(zip, path) {
  const entry = zip.file(path);
  if (!entry) throw new Error(`Missing plugin file ${path}.`);
  return entry.async("nodebuffer");
}

async function verifyRuntimeMembers(zip, index, pluginId, platform) {
  if (index.algorithm !== "sha256" || !index.files || !Object.hasOwn(index.files, manifestPath)) {
    throw new Error("Plugin checksums do not cover the manifest.");
  }
  const names = Object.keys(index.files);
  const isWindows = platform === "win32";
  const cuaRoot = `runtime/providers/cua-driver/${CUA_DRIVER_PACKAGE_REVISION}`;
  const cuaLayout = cuaDriverArtifactLayoutFor(cuaDriverArtifactPlatformForRuntime(platform));
  const required = pluginId === "official:chrome-browser"
    ? ["runtime/ling-for-chrome.zip", `runtime/ling-browser-host${isWindows ? ".exe" : ""}`]
    : pluginId === "official:office-documents"
      ? isWindows ? ["runtime/office-driver/win32-x64/ling-office-driver.exe"] : [
        "runtime/office-driver/darwin-arm64/OfficeDriver.app/Contents/MacOS/ling-office-driver",
        "runtime/office-driver/darwin-arm64/OfficeDriver.app/Contents/Info.plist",
        "runtime/office-driver/darwin-arm64/OfficeDriver.app/Contents/_CodeSignature/CodeResources",
      ]
      : [
          `${cuaRoot}/provider-lock.json`, `${cuaRoot}/LICENSE.md`, `${cuaRoot}/THIRD_PARTY_NOTICES.md`,
          `${cuaRoot}/${cuaLayout.packagedExecutableRelativePath}`, `${cuaRoot}/${cuaLayout.providerSealRelativePath}`,
          ...(isWindows ? [`${cuaRoot}/win32-x64/provider-integrity.cat`] : []),
        ];
  if (required.length === 0 || required.some((path) => !Object.hasOwn(index.files, path))) {
    throw new Error(`Plugin runtime is incomplete for ${pluginId} on ${platform}.`);
  }
  for (const path of names) {
    if (!path.split("/").every((part) => /^[A-Za-z0-9_. -]+$/u.test(part) && part !== "." && part !== "..")
      || sha256(await readMember(zip, path)) !== index.files[path]) {
      throw new Error(`Plugin checksum mismatch for ${path}.`);
    }
  }
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if ((entry.unsafeOriginalName ?? entry.name) !== entry.name
      || !Object.hasOwn(index.files, entry.name) && entry.name !== checksumsPath && entry.name !== provenancePath) {
      throw new Error(`Plugin archive contains an unexpected member ${entry.name}.`);
    }
  }
  if (pluginId === "official:cua-driver") {
    const lockPath = `${cuaRoot}/provider-lock.json`;
    const lock = validateCuaDriverProviderLockContract(JSON.parse((await readMember(zip, lockPath)).toString("utf8")), {
      platform, architecture: cuaLayout.architecture, requireReleaseEvidence: true,
    });
    const seal = JSON.parse((await readMember(zip, `${cuaRoot}/${cuaLayout.providerSealRelativePath}`)).toString("utf8"));
    const executableDigest = index.files[`${cuaRoot}/${cuaLayout.packagedExecutableRelativePath}`];
    if (names.some((path) => path.startsWith("runtime/") && !required.includes(path))
      || lock.upstream.licenseSha256 !== index.files[`${cuaRoot}/LICENSE.md`]
      || seal.platform !== platform || seal.signingTier !== "production_signed"
      || seal.distributionChannel !== "production" || seal.productionEligible !== true
      || seal.lockSha256 !== index.files[lockPath]
      || (isWindows ? seal.main?.sha256 : seal.executableSha256) !== executableDigest) {
      throw new Error(`Cua Driver production lock, seal and runtime tree do not agree for ${platform}.`);
    }
  }
}

function github(args, json = true) {
  const output = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return json ? JSON.parse(output) : undefined;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function signature(bytes) { return `ed25519:${sign(null, bytes, key).toString("base64")}`; }

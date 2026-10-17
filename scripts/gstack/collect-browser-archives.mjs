import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesNativeDependency } from "./runtime-dependency-audit.mjs";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";

const lockBytes = await readFile(new URL("./upstream-lock.json", import.meta.url));
const lock = JSON.parse(lockBytes.toString("utf8"));
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const inside = (root, path) => {
  const value = relative(root, path);
  return !value || !isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\");
};
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const browserNames = ["chromium", "ffmpeg", "chromium-headless-shell"];
const maximumArchiveBytes = 512 * 1024 * 1024;
const collectorInputNames = ["collect-browser-archives.mjs", "upstream-lock.json", "runtime-dependency-audit.mjs",
  "build-native-runtime.mjs", "public-domain-package-review.mjs", "reviewed-public-domain-packages.json"];
async function collectorInputs() {
  return Promise.all(collectorInputNames.map(async path => ({ path,
    checksum: checksum(await readFile(new URL(path, import.meta.url))) })));
}

async function plainBytes(root, path, maximum = 32 * 1024 * 1024) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("gstack_browser_source_path_invalid");
  }
  const absolute = join(root, path), stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || await realpath(absolute) !== absolute) {
    throw new Error("gstack_browser_source_file_invalid");
  }
  return readFile(absolute);
}

async function ownFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await ownFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error("gstack_browser_source_resource_invalid");
  }
  return files.sort();
}

export async function verifyBrowserArchiveSource({ resourceStagePath, expectedResourceStageChecksum, target }) {
  if (!digest(expectedResourceStageChecksum)) throw new Error("gstack_browser_source_receipt_required");
  const requested = resolve(resourceStagePath), stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gstack_browser_source_root_invalid");
  const root = await realpath(requested);
  const receiptBytes = await plainBytes(root, "resource-stage.json");
  if (checksum(receiptBytes) !== expectedResourceStageChecksum) throw new Error("gstack_browser_source_receipt_mismatch");
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (receipt.schemaVersion !== 1 || receipt.deliveryStage !== "resource-prerequisites" || receipt.releaseEligible !== false ||
    receipt.upstreamRevision !== lock.revision || receipt.upstreamVersion !== lock.version ||
    receipt.target?.platform !== target.platform || receipt.target?.arch !== target.arch || !digest(receipt.inventoryChecksum)) {
    throw new Error("gstack_browser_source_identity_mismatch");
  }
  const inventoryBytes = await plainBytes(root, "resource-inventory.json");
  if (checksum(inventoryBytes) !== receipt.inventoryChecksum) throw new Error("gstack_browser_source_inventory_mismatch");
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files)) throw new Error("gstack_browser_source_inventory_invalid");
  const packagePrefix = "runtime/node_modules/playwright-core/";
  const nodePath = `runtime/tools/node${target.platform === "win32" ? ".exe" : ""}`;
  const required = [nodePath, `${packagePrefix}package.json`, `${packagePrefix}browsers.json`,
    `${packagePrefix}lib/coreBundle.js`, `${packagePrefix}lib/utilsBundle.js`];
  const files = inventory.files.filter(file => file.path === nodePath || file.path?.startsWith(packagePrefix));
  const paths = new Set();
  for (const file of files) {
    if (paths.has(file.path) || !digest(file.checksum)) throw new Error("gstack_browser_source_inventory_invalid");
    paths.add(file.path);
    const bytes = await plainBytes(root, file.path, 128 * 1024 * 1024);
    if (bytes.length !== file.sizeBytes || checksum(bytes) !== file.checksum) throw new Error(`gstack_browser_source_changed:${file.path}`);
  }
  if (required.some(path => !paths.has(path))) throw new Error("gstack_browser_source_incomplete");
  const actual = await ownFiles(join(root, packagePrefix));
  const expected = files.filter(file => file.path.startsWith(packagePrefix)).map(file => file.path.slice(packagePrefix.length)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("gstack_browser_source_extra_artifacts");
  if (!await matchesNativeDependency(join(root, nodePath), target)) throw new Error("gstack_browser_node_target_mismatch");
  const pkg = JSON.parse((await plainBytes(root, `${packagePrefix}package.json`)).toString("utf8"));
  const browserBytes = await plainBytes(root, `${packagePrefix}browsers.json`);
  const browsers = JSON.parse(browserBytes.toString("utf8")).browsers;
  if (pkg.name !== "playwright-core" || !/^\d+\.\d+\.\d+$/.test(pkg.version) || !Array.isArray(browsers)) {
    throw new Error("gstack_browser_playwright_identity_invalid");
  }
  const selected = browserNames.map(name => {
    const entries = browsers.filter(browser => browser.name === name);
    if (entries.length !== 1 || !/^\d+$/.test(entries[0].revision) ||
      name !== "ffmpeg" && !/^\d+\.\d+\.\d+\.\d+$/.test(entries[0].browserVersion)) throw new Error("gstack_browser_revision_invalid");
    return { name, revision: entries[0].revision, ...(entries[0].browserVersion ? { browserVersion: entries[0].browserVersion } : {}) };
  });
  return { root, nodePath: join(root, nodePath), packagePath: join(root, packagePrefix),
    provenance: { resourceStageChecksum: expectedResourceStageChecksum, inventoryChecksum: receipt.inventoryChecksum,
      adaptationRevision: receipt.adaptationRevision, playwrightVersion: pkg.version,
      browsersChecksum: checksum(browserBytes), verifiedSourceFileCount: files.length }, browsers: selected };
}

export function validateBrowserArchivePlan(plan, source, target) {
  const slug = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "win64" }[`${target.platform}-${target.arch}`];
  if (!slug || !Array.isArray(plan) || plan.length !== browserNames.length) throw new Error("gstack_browser_archive_plan_invalid");
  return source.browsers.map(browser => {
    const entries = plan.filter(entry => entry.name === browser.name);
    if (entries.length !== 1 || !Array.isArray(entries[0].downloadURLs) || !entries[0].downloadURLs.length) {
      throw new Error("gstack_browser_archive_plan_incomplete");
    }
    const filename = browser.name === "ffmpeg" ? `ffmpeg-${slug}.zip`
      : `${browser.name === "chromium" ? "chrome" : "chrome-headless-shell"}-${slug}.zip`;
    const url = browser.name === "ffmpeg"
      ? `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${browser.revision}/${filename}`
      : `https://cdn.playwright.dev/builds/cft/${browser.browserVersion}/${slug}/${filename}`;
    if (entries[0].downloadURLs[0] !== url) throw new Error("gstack_browser_archive_url_mismatch");
    return { ...browser, filename, url };
  });
}

function registryPlan(source, home) {
  const code = `const b=require(process.argv[1]+"/lib/coreBundle.js");
    console.log(JSON.stringify(${JSON.stringify(browserNames)}.map(name=>{const e=b.registry.registry.findExecutable(name);
      return {name:e.name,downloadURLs:e.downloadURLs};})));`;
  return JSON.parse(execFileSync(source.nodePath, ["-e", code, source.packagePath], {
    cwd: home, env: { PATH: process.platform === "win32" ? process.env.SystemRoot ?? "" : "/usr/bin:/bin",
      HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
      PLAYWRIGHT_BROWSERS_PATH: join(home, "unused-browser-cache"), PLAYWRIGHT_SKIP_BROWSER_GC: "1",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }));
}

function validDownloadEndpoint(url, archive) {
  const hosts = ["cdn.playwright.dev", "playwright.download.prss.microsoft.com", "storage.googleapis.com"];
  const versionPath = archive.name === "ffmpeg" ? `/ffmpeg/${archive.revision}/` : `/${archive.browserVersion}/`;
  return url.protocol === "https:" && !url.username && !url.password && !url.port && hosts.includes(url.hostname) &&
    url.pathname.includes(versionPath) && url.pathname.endsWith(`/${archive.filename}`);
}

export async function downloadBrowserArchive(archive, outputPath) {
  let endpoint = new URL(archive.url), response;
  for (let count = 0; count < 6; count++) {
    if (!validDownloadEndpoint(endpoint, archive)) throw new Error("gstack_browser_download_endpoint_invalid");
    response = await fetch(endpoint, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || count === 5) throw new Error("gstack_browser_download_redirect_invalid");
    endpoint = new URL(location, endpoint);
  }
  if (!response.ok || !response.body) throw new Error(`gstack_browser_download_http_${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumArchiveBytes)) {
    await response.body.cancel(); throw new Error("gstack_browser_download_size_invalid");
  }
  const file = await open(outputPath, "wx"), hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const part of response.body) {
      sizeBytes += part.length;
      if (sizeBytes > maximumArchiveBytes) throw new Error("gstack_browser_download_too_large");
      hash.update(part); await file.writeFile(part);
    }
  } finally { await file.close(); }
  if (!sizeBytes || declared !== null && sizeBytes !== Number(declared)) throw new Error("gstack_browser_download_truncated");
  return { checksum: `sha256:${hash.digest("hex")}`, sizeBytes,
    endpoint: `${endpoint.origin}${endpoint.pathname}` };
}

async function canonicalDestination(path) {
  const suffix = [basename(path)]; let parent = dirname(path);
  while (!await exists(parent)) { suffix.unshift(basename(parent)); parent = dirname(parent); }
  const base = await realpath(parent);
  if (!(await lstat(base)).isDirectory()) throw new Error("gstack_browser_output_parent_invalid");
  return join(base, ...suffix);
}

// Archive acquisition is isolated and non-executing. Its receipt cannot authorize
// extraction, redistribution, browser execution or publication as a Ling bundle.
export async function collectGstackBrowserArchives({ resourceStagePath, outputPath, expectedResourceStageChecksum,
  target = { platform: process.platform, arch: process.arch }, registryReader = registryPlan,
  downloader = downloadBrowserArchive, onProgress = () => {} }) {
  if (target.platform !== process.platform || target.arch !== process.arch) throw new Error("gstack_browser_collection_requires_matching_host");
  const options = { resourceStagePath, expectedResourceStageChecksum, target };
  const source = await verifyBrowserArchiveSource(options);
  const requested = resolve(outputPath);
  if (await exists(requested)) throw new Error("gstack_browser_output_exists");
  const output = await canonicalDestination(requested);
  if (inside(source.root, output) || inside(output, source.root)) throw new Error("gstack_browser_source_output_overlap");
  const inputs = await collectorInputs();
  if (inputs.find(input => input.path === "upstream-lock.json").checksum !== checksum(lockBytes)) throw new Error("gstack_browser_collector_changed");
  const lease = await managedResourceWrite(output, { kind: "browser", additionalBytes: 2 * 1024 ** 3 });
  await mkdir(dirname(output), { recursive: true });
  const temporary = await realpath(await mkdtemp(join(dirname(output), ".gstack-browser-acquisition-")));
  let reserved = false;
  try {
    const home = join(temporary, "home"), candidate = join(temporary, "candidate");
    await mkdir(home); await mkdir(candidate);
    const plan = validateBrowserArchivePlan(await registryReader(source, home), source, target);
    const archives = [];
    for (const archive of plan) {
      await resourceCheckpoint(lease.root, maximumArchiveBytes);
      await verifyBrowserArchiveSource(options);
      onProgress(`download exact ${archive.name} ${archive.browserVersion ?? archive.revision}`);
      const path = join(candidate, archive.filename), downloaded = await downloader(archive, path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumArchiveBytes ||
        !digest(downloaded.checksum) || stat.size !== downloaded.sizeBytes || await realpath(path) !== path) {
        throw new Error("gstack_browser_download_artifact_invalid");
      }
      const hash = createHash("sha256"); let signature = Buffer.alloc(0);
      for await (const bytes of createReadStream(path)) {
        if (signature.length < 4) signature = Buffer.concat([signature, bytes.subarray(0, 4 - signature.length)]);
        hash.update(bytes);
      }
      if (`sha256:${hash.digest("hex")}` !== downloaded.checksum) throw new Error("gstack_browser_download_checksum_mismatch");
      if (!signature.equals(Buffer.from("504b0304", "hex"))) throw new Error("gstack_browser_download_not_zip");
      archives.push({ ...archive, ...downloaded });
    }
    await verifyBrowserArchiveSource(options);
    if (JSON.stringify(await collectorInputs()) !== JSON.stringify(inputs)) throw new Error("gstack_browser_collector_changed");
    const receipt = { schemaVersion: 1, deliveryStage: "browser-archive-candidates", reviewStatus: "candidate-only",
      releaseEligible: false, hostAcceptance: "pending", packageAcceptance: "pending",
      upstreamRevision: lock.revision, upstreamVersion: lock.version, target, source: source.provenance,
      collectorInputChecksums: inputs, archives,
      pendingGates: ["archive-member-and-native-target-review", "exact-archive-license-review",
        "owned-resource-materialization", "real-browser-execution", "installed-client-acceptance"] };
    await writeFile(join(candidate, "browser-archives.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    await resourceCheckpoint(lease.root);
    await mkdir(output); reserved = true;
    await rename(candidate, output); reserved = false;
    return receipt;
  } finally {
    try { if (reserved) await rmdir(output); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [resourceStagePath, outputPath, expectedResourceStageChecksum] = process.argv.slice(2);
  if (!resourceStagePath || !outputPath) throw new Error("Usage: collect-browser-archives.mjs <resource-stage> <new-output> <detached-resource-receipt-sha256>");
  const receipt = await collectGstackBrowserArchives({ resourceStagePath, outputPath, expectedResourceStageChecksum,
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

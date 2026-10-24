import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { fileRecord, readCandidate, targetAssets } from "./desktop-release.mjs";
import { extractCuaDriverFinalArtifact } from "../../apps/desktop/scripts/cua-driver-signing/final-artifact-extractor.mjs";
import { readExecutableBundle } from "../gstack/executable-bundle.mjs";
import { extractedApplicationPath, inventoryApplicationTree } from "./desktop-payload.mjs";
import { smokeWindowsInstaller } from "./windows-installer-smoke.mjs";
import { createVerifiedDistributionArchive, inventoryDistribution } from "./distribution-archive.mjs";
import { verifyNsisPlugins } from "./verify-nsis-plugins.mjs";
import { runManagedNode } from "../gstack/run-managed.mjs";
import { prepareBrowserSmokeWorkspace } from "./browser-acquisition-smoke.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const desktopRoot = join(root, "apps/desktop");
const requireDesktop = createRequire(join(desktopRoot, "package.json"));
const asar = requireDesktop("@electron/asar");

export function assertNativeBinary(bytes, target, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512) throw new Error(`Truncated native file: ${label}`);
  if (target === "macos-arm64") {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) throw new Error(`Expected arm64 Mach-O: ${label}`);
  } else if (target === "windows-x64") {
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString("ascii", 0, 2) !== "MZ" || pe > bytes.length - 6
      || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error(`Expected x64 PE: ${label}`);
  } else throw new Error("Unsupported native target");
}

async function inspectApplication(app, candidate, target, expectedDistribution) {
  const mac = target === "macos-arm64";
  const resources = mac ? join(app, "Contents/Resources") : join(app, "resources");
  const exe = mac ? join(app, "Contents/MacOS/Ling Stack") : join(app, "Ling Stack.exe");
  const archive = join(resources, "app.asar");
  const metadata = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  if (metadata.version !== candidate.version || !metadata.lingPackagedGstack) throw new Error("Packaged version or bundled gstack identity is missing");
  const bundle = await readExecutableBundle(join(resources, "gstack"), metadata.lingPackagedGstack);
  if (bundle.identity.target.platform !== (mac ? "darwin" : "win32") || bundle.identity.target.arch !== (mac ? "arm64" : "x64")) throw new Error("Packaged gstack target mismatch");
  const distribution = await inventoryDistribution(join(resources, "distribution"));
  if (distribution.length === 0 || !isDeepStrictEqual(distribution, expectedDistribution)) throw new Error("Packaged distribution materials differ from this build");
  execFileSync(process.execPath, [join(desktopRoot, "scripts/distribution/materials.mjs"), "verify", "--platform", mac ? "darwin-arm64" : "win32-x64",
    "--resources", resources], { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const required = [exe, archive, join(resources, "web/index.html"), join(resources, "browser-extension/ling-for-chrome.zip"),
    join(resources, "browser-host", mac ? "ling-browser-host" : "ling-browser-host.exe"),
    join(resources, "image-sanitizer", mac ? "ling-image-sanitizer" : "ling-image-sanitizer.exe"),
    mac ? join(resources, "office-driver/darwin-arm64/OfficeDriver.app/Contents/MacOS/ling-office-driver")
      : join(resources, "office-driver/win32-x64/ling-office-driver.exe"),
    ...(mac ? [join(resources, "office-local/office-local.node"), join(resources, "restricted-command/ling-sandbox-runner")]
      : [join(resources, "engine-supervisor/ling-engine-supervisor.exe")])];
  const files = [];
  for (const path of required) files.push({ ...await fileRecord(path), name: path.slice(app.length + 1).replaceAll("\\", "/") });
  for (const path of required.filter(path => path.endsWith(".exe") || mac && !path.endsWith(".asar") && !path.endsWith(".html") && !path.endsWith(".zip"))) {
    assertNativeBinary(await readFile(path), target, path);
  }
  if (mac) {
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 60_000, stdio: "pipe" });
    const details = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", app], { timeout: 30_000, encoding: "utf8" });
    if (details.error || details.status !== 0 || !/^Signature=adhoc$/mu.test(details.stderr)
      || /^Authority=/mu.test(details.stderr)) throw new Error("Expected ad-hoc development signing without publisher identity");
  } else {
    const env = { ...process.env, LING_DESKTOP_VERIFY_FILE: exe };
    const state = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-AuthenticodeSignature -LiteralPath $env:LING_DESKTOP_VERIFY_FILE).Status.ToString()"],
      { env, timeout: 30_000, encoding: "utf8" }).trim();
    if (state !== "NotSigned") throw new Error("Expected a Windows development executable without publisher signing");
  }
  return { files, payload: await inventoryApplicationTree(app, { allowLinks: mac }),
    gstack: bundle.identity, distributionFileCount: distribution.length };
}

/** Archive verification is intentionally distinct from installed-user acceptance. */
export async function verifyDesktopPackage() {
  const candidate = await readCandidate({ sha: process.env.DESKTOP_SOURCE_SHA, tag: process.env.DESKTOP_RELEASE_TAG });
  const target = process.env.DESKTOP_TARGET, mac = target === "macos-arm64";
  if ((mac ? "darwin:arm64" : "win32:x64") !== `${process.platform}:${process.arch}`) throw new Error("Use the native target host");
  const evidenceRoot = join(root, ".codex-artifacts/desktop-release");
  await mkdir(evidenceRoot, { recursive: true });
  const distribution = await inventoryDistribution(join(desktopRoot, "dist/distribution"));
  const releaseRoot = join(desktopRoot, "release");
  const unpacked = mac ? join(releaseRoot, "mac-arm64/Ling Stack.app") : join(releaseRoot, "win-unpacked");
  const baseline = await inspectApplication(unpacked, candidate, target, distribution);
  const archives = [];
  let installerPlugins;
  for (const name of targetAssets(candidate, target)) {
    const path = join(releaseRoot, name), original = await fileRecord(path);
    if (!mac) {
      const state = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "(Get-AuthenticodeSignature -LiteralPath $env:LING_DESKTOP_VERIFY_FILE).Status.ToString()"],
      { env: { ...process.env, LING_DESKTOP_VERIFY_FILE: path }, timeout: 30_000, encoding: "utf8" }).trim();
      if (state !== "NotSigned") throw new Error("Expected an unsigned Windows development installer");
      const builderRequire = createRequire(requireDesktop.resolve("electron-builder/package.json"));
      installerPlugins = await verifyNsisPlugins({ installer: path,
        sevenZipPath: await builderRequire("app-builder-lib/out/toolsets/7zip.js").getPath7za() });
    }
    const extracted = await extractCuaDriverFinalArtifact(path, {
      platform: mac ? "darwin" : "win32",
      artifactRole: mac ? (name.endsWith(".zip") ? "outer-zip" : "outer-dmg") : "outer-nsis",
    });
    try {
      const app = await extractedApplicationPath(extracted.artifactRoot, target);
      const actual = await inspectApplication(app, candidate, target, distribution);
      if (!isDeepStrictEqual(actual, baseline)) throw new Error("Final archive payload differs from the unpacked application");
    } finally { await extracted.cleanup(); }
    if (!isDeepStrictEqual(await fileRecord(path), original)) throw new Error("Final archive changed during verification");
    archives.push(original);
  }
  const executable = mac ? join(unpacked, "Contents/MacOS/Ling Stack") : join(unpacked, "Ling Stack.exe");
  const probe = execFileSync(executable, ["-e", 'console.log("LING_DESKTOP_RUNTIME="+JSON.stringify(process.versions))'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  const runtime = JSON.parse(probe.split(/\r?\n/u).find(line => line.startsWith("LING_DESKTOP_RUNTIME="))?.slice(21) ?? "null");
  const expectedElectron = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")).devDependencies.electron;
  if (runtime?.electron !== expectedElectron) throw new Error("Packaged Electron runtime did not start with the pinned version");
  const runnerInstallerSmoke = mac ? { status: "not_run" }
    : await smokeWindowsInstaller({ installer: join(releaseRoot, targetAssets(candidate, target)[0]), unpacked, candidate });
  const browserSmokePath = join(evidenceRoot, "browser-acquisition-smoke.json");
  const browserSmoke = await runManagedNode({ root: await prepareBrowserSmokeWorkspace(),
    args: [join(root, "scripts/release/browser-acquisition-smoke.mjs"),
      join(unpacked, mac ? "Contents/Resources/gstack" : "resources/gstack"), browserSmokePath],
    additionalBytes: 2 * 1024 ** 3, timeoutMs: 8 * 60000 });
  if (browserSmoke.exitCode !== 0) throw new Error(`desktop_browser_acquisition_smoke_failed:${browserSmoke.reason ?? browserSmoke.exitCode}`);
  const runnerBrowserSmoke = JSON.parse(await readFile(browserSmokePath));
  for (const record of archives) {
    if (!isDeepStrictEqual(await fileRecord(join(releaseRoot, record.name)), record)) throw new Error("Final archive changed during installer smoke");
  }
  const distributionArchive = await createVerifiedDistributionArchive({ directory: join(desktopRoot, "dist/distribution"),
    archivePath: join(evidenceRoot, "distribution.tar.gz"), expected: distribution });
  const report = { ...candidate, target, status: "passed", acceptance: "archive_contents_and_unsigned_structure_only",
    archives, distributionArchive, ...(installerPlugins ? { installerPlugins } : {}), ...baseline,
    electronRuntime: runtime, runnerInstallerSmoke, runnerBrowserSmoke, runtimeAcceptance: "not_run", installedUserAcceptance: "not_run" };
  await writeFile(join(evidenceRoot, "package-verification.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await verifyDesktopPackage(), null, 2));

import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { verifyBundledBrowser } from "../../packages/core/src/bundled-skill-browser.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { bundleFile, digest, resourcePath } from "./executable-bundle.mjs";
import { resourceCheckpoint } from "./resource-workspace.mjs";

// Local technical admission only. This is not a redistribution approval.
export const localBrowserPin = Object.freeze({ version: "154.0.8037.97", target: { platform: "darwin", arch: "arm64" },
  transportChecksum: "sha256:84e1ed115fa82008eece8cf0f858621d7aa2333ff3ea9c2e0f37f5a99078783d",
  inventoryChecksum: "sha256:428c1a50dbc058dc41514916adad7c69f4feb56fcad1bef897d1d4aea984a81c",
  appEntry: "Chromium.app/Contents/MacOS/Chromium" });

export async function materializeLocalBrowser({ inspectionRoot, runtimeRoot, outputRoot, managedRoot }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("gstack_browser_local_target_unsupported");
  if (await realpath(inspectionRoot) !== inspectionRoot) throw new Error("gstack_browser_inspection_alias");
  const zip = join(inspectionRoot, "inspection-members.zip"), inventoryBytes = await readFile(join(inspectionRoot, "members.json"));
  if (digest(inventoryBytes) !== localBrowserPin.inventoryChecksum || (await bundleFile(inspectionRoot, "inspection-members.zip")).checksum
    !== localBrowserPin.transportChecksum) throw new Error("gstack_browser_local_pin_mismatch");
  const require = createRequire(join(runtimeRoot, "package.json"));
  const { yauzl } = require(join(dirname(require.resolve("playwright-core/package.json")), "lib/utilsBundle.js"));
  const inspected = await inspectBrowserZip({ zipPath: zip, yauzl, target: localBrowserPin.target, rootPrefix: "Chromium.app" });
  const expected = JSON.parse(inventoryBytes); delete expected.schemaVersion;
  if (JSON.stringify(inspected) !== JSON.stringify(expected)) throw new Error("gstack_browser_member_inventory_changed");
  await resourceCheckpoint(managedRoot, 2 * 1024 ** 3);
  await extractInspectedArchive({ zip, yauzl, inspected, outputRoot, managedRoot });
  if ((await bundleFile(inspectionRoot, "inspection-members.zip")).checksum !== localBrowserPin.transportChecksum) throw new Error("gstack_browser_local_pin_mismatch");
  const files = inspected.members.filter(row => row.kind === "file").map(({ path, checksum, sizeBytes }) => ({ path, checksum, sizeBytes }));
  const links = inspected.members.filter(row => row.kind === "link").map(({ path, linkTarget, resolvedTarget }) => ({ path, linkTarget, resolvedTarget }));
  const component = Buffer.from(`${JSON.stringify({ schemaVersion: 1, target: localBrowserPin.target,
    entryPath: localBrowserPin.appEntry, files, links }, null, 2)}\n`);
  await writeFile(join(outputRoot, "browser-component.json"), component, { flag: "wx" });
  verifyBundledBrowser(outputRoot, digest(component), localBrowserPin.target);
  const app = join(outputRoot, "Chromium.app");
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8", timeout: 15000 });
  return { activation: "package-relative-only", localOnly: true, releaseEligible: false, ...localBrowserPin,
    componentChecksum: digest(component), signing: "upstream-signature-preserved",
    entryPath: `../../gstack-browser/${localBrowserPin.appEntry}`,
    entryChecksum: (await bundleFile(outputRoot, localBrowserPin.appEntry)).checksum };
}

async function extractInspectedArchive({ zip, yauzl, inspected, outputRoot, managedRoot }) {
  const records = new Map(inspected.members.map(row => [row.path, row]));
  await mkdir(outputRoot);
  const archive = await new Promise((resolve, reject) => yauzl.open(zip, { lazyEntries: true, autoClose: false },
    (error, value) => error ? reject(error) : resolve(value)));
  try {
    await new Promise((resolve, reject) => {
      archive.once("error", reject); archive.once("end", resolve);
      archive.on("entry", entry => { (async () => {
        const path = resourcePath(entry.fileName.replace(/\/$/, "")), record = records.get(path);
        if (!record) throw new Error("gstack_browser_unlisted_member");
        if (record.kind === "directory") await mkdir(join(outputRoot, path), { recursive: true });
        else if (record.kind === "file") {
          await mkdir(dirname(join(outputRoot, path)), { recursive: true });
          const stream = await new Promise((resolve, reject) => archive.openReadStream(entry,
            (error, value) => error ? reject(error) : resolve(value)));
          await pipeline(stream, createWriteStream(join(outputRoot, path), { flags: "wx", mode: 0o600 }));
          const actual = await bundleFile(outputRoot, path);
          if (actual.checksum !== record.checksum || actual.sizeBytes !== record.sizeBytes) throw new Error("gstack_browser_member_changed");
          await chmod(join(outputRoot, path), record.mode & 0o111 ? 0o755 : 0o644);
        }
        archive.readEntry();
      })().catch(reject); });
      archive.readEntry();
    });
  } finally { archive.close(); }
  // Preserve only independently inspected platform framework aliases. These
  // live outside the link-free skill/dependency resource component.
  for (const row of inspected.members.filter(row => row.kind === "link")) {
    resourcePath(row.path); resourcePath(row.resolvedTarget);
    if (!row.resolvedTarget.startsWith("Chromium.app/") || !records.has(row.resolvedTarget)) throw new Error("gstack_browser_link_target_invalid");
    const to = join(outputRoot, row.path);
    await mkdir(dirname(to), { recursive: true });
    await symlink(row.linkTarget, to);
    await resourceCheckpoint(managedRoot);
  }
}

export async function materializeLocalFfmpeg({ archiveRoot, runtimeRoot, cacheRoot, managedRoot }) {
  const path = "ffmpeg-mac-arm64.zip", checksum = "sha256:7d77eb0d44b59acc4065faa2476c0df1a242cc904c346f820626818c953c5277";
  if ((await bundleFile(archiveRoot, path)).checksum !== checksum) throw new Error("gstack_ffmpeg_archive_changed");
  const require = createRequire(join(runtimeRoot, "package.json"));
  const { yauzl } = require(join(dirname(require.resolve("playwright-core/package.json")), "lib/utilsBundle.js"));
  const inspected = await inspectBrowserZip({ zipPath: join(archiveRoot, path), yauzl, target: localBrowserPin.target });
  if (inspected.members.some(row => row.kind === "link") || !inspected.members.some(row => row.path === "ffmpeg-mac")) {
    throw new Error("gstack_ffmpeg_members_changed");
  }
  await mkdir(cacheRoot);
  await extractInspectedArchive({ zip: join(archiveRoot, path), yauzl, inspected,
    outputRoot: join(cacheRoot, "ffmpeg-1011"), managedRoot });
  if ((await bundleFile(archiveRoot, path)).checksum !== checksum) throw new Error("gstack_ffmpeg_archive_changed");
  return { revision: "1011", archiveChecksum: checksum, entryPath: "browser-cache/ffmpeg-1011/ffmpeg-mac",
    entryChecksum: (await bundleFile(join(cacheRoot, "ffmpeg-1011"), "ffmpeg-mac")).checksum };
}

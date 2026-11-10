import { createHash } from "node:crypto";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function browserAcquisitionFixture(target = { platform: "win32", arch: "x64" }) {
  const slug = target.platform === "win32" ? "win64" : `mac-${target.arch}`, prefix = `chrome-${slug}`;
  const browserVersion = "151.0.7893.0", content = Buffer.from("synthetic browser; never downloaded or executed\n");
  const entryPath = target.platform === "win32" ? `${prefix}/chrome.exe`
    : `${prefix}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  const member = (path, kind, bytes = Buffer.alloc(0)) => ({ path, kind,
    mode: kind === "directory" ? 0o40755 : kind === "link" ? 0o120777 : 0o100755,
    sizeBytes: bytes.length, compressedSizeBytes: bytes.length, compressionMethod: 0,
    checksum: hash(bytes), crc32: "00000000" });
  const members = [member(prefix, "directory"), { ...member(entryPath, "file", content),
    native: { format: target.platform === "win32" ? "pe" : "mach-o", architectures: [target.arch], fileType: "executable" } }];
  const links = [];
  if (target.platform === "darwin") {
    const framework = `${prefix}/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework`;
    members.push(member(`${framework}/Versions/A`, "directory"));
    for (let index = 0; index < 5; index++) {
      const link = { path: `${framework}/alias-${index}`, linkTarget: "Versions/A", resolvedTarget: `${framework}/Versions/A` };
      links.push(link);
      members.push({ ...member(link.path, "link", Buffer.from(link.linkTarget)), ...link, targetKind: "directory" });
    }
  }
  const component = { schemaVersion: 1, source: "playwright-registry", target, entryPath,
    files: [{ path: entryPath, checksum: hash(content), sizeBytes: content.length }], links };
  const recipe = { schemaVersion: 1, mode: "download-required", source: "playwright-registry", target, browserVersion,
    archive: { url: `https://cdn.playwright.dev/builds/cft/${browserVersion}/${slug}/chrome-${slug}.zip`,
      checksum: hash("synthetic archive; never fetched"), sizeBytes: 1024 },
    component, componentChecksum: hash(`${JSON.stringify(component, null, 2)}\n`), members };
  const bytes = Buffer.from(`${JSON.stringify(recipe, null, 2)}\n`), checksum = hash(bytes);
  const selection = { activation: "download-required", source: "playwright-registry", target,
    entryPath: "../../gstack-browser/browser-acquisition.json", entryChecksum: hash(content),
    componentChecksum: checksum, acquisitionChecksum: checksum };
  return { recipe, bytes, checksum, selection };
}

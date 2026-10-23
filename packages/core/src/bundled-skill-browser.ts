import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const fail = (): never => { throw new Error("bundled_browser_component_invalid"); };
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const same = (a: BigIntStats, b: BigIntStats) => ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs", "nlink"]
  .every(key => Reflect.get(a, key) === Reflect.get(b, key));
function logical(value: unknown): string {
  if (typeof value !== "string" || !value || /[\\:\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some(part => !part || part === "." || part === "..")) return fail();
  return value;
}
export interface VerifiedBundledBrowser {
  readonly root: string;
  readonly entry: string;
  readonly checksum: string;
  readonly assertCurrent: () => void;
}

/** Separate platform component: macOS framework aliases are authenticated;
 * Windows resources stay link-free. Skill/dependency resources stay link-free. */
export function verifyBundledBrowser(root: string, checksum: string, target: { platform: string; arch: string }): VerifiedBundledBrowser {
  root = resolve(root);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || !/^sha256:[a-f0-9]{64}$/.test(checksum)) fail();
  const manifestPath = join(root, "browser-component.json"), manifestStat = lstatSync(manifestPath, { bigint: true });
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 2n * 1024n ** 2n) fail();
  const bytes = readFileSync(manifestPath);
  if (digest(bytes) !== checksum) fail();
  const manifest = JSON.parse(bytes.toString());
  const legacy = target.platform === "darwin" && target.arch === "arm64" &&
    manifest.entryPath === "Chromium.app/Contents/MacOS/Chromium" && manifest.source === undefined;
  const slug = target.platform === "darwin" && ["arm64", "x64"].includes(target.arch)
    ? `mac-${target.arch}` : target.platform === "win32" && target.arch === "x64" ? "win64" : undefined;
  const app = slug && `chrome-${slug}/Google Chrome for Testing.app`;
  const playwright = slug && manifest.source === "playwright-registry" && manifest.entryPath ===
    (target.platform === "win32" ? "chrome-win64/chrome.exe" : `${app}/Contents/MacOS/Google Chrome for Testing`);
  const prefix = legacy ? "Chromium.app/" : `chrome-${slug}/`;
  const framework = legacy ? "Chromium.app/Contents/Frameworks/Chromium Framework.framework/"
    : `${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework/`;
  if (manifest.schemaVersion !== 1 || manifest.target?.platform !== target.platform || manifest.target?.arch !== target.arch ||
    (!legacy && !playwright) ||
    !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 5000 ||
    !Array.isArray(manifest.links) || manifest.links.length !== (target.platform === "win32" ? 0 : 5)) fail();
  const files = new Map<string, { path: string; checksum: string; sizeBytes: number }>();
  const links = new Map<string, { path: string; linkTarget: string; resolvedTarget: string }>();
  for (const row of manifest.files) {
    const path = logical(row.path);
    if (!path.startsWith(prefix) || files.has(path) || !/^sha256:[a-f0-9]{64}$/.test(row.checksum) ||
      !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > 512 * 1024 ** 2) fail();
    files.set(path, row);
  }
  for (const row of manifest.links) {
    const path = logical(row.path), destination = logical(row.resolvedTarget);
    if (!path.startsWith(framework) ||
      !destination.startsWith(prefix) || files.has(path) || links.has(path) || typeof row.linkTarget !== "string" ||
      row.linkTarget.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(row.linkTarget)) fail();
    links.set(path, row);
  }
  if (!files.has(manifest.entryPath)) fail();
  const facts: { path: string; stat: BigIntStats }[] = [{ path: manifestPath, stat: manifestStat }];
  const directories: { path: string; stat: BigIntStats }[] = [];
  let count = 0, total = 0;
  function walk(path: string): void {
    const full = join(root, path), stat = lstatSync(full, { bigint: true });
    if (++count > 6000) fail();
    if (stat.isSymbolicLink()) {
      const row = links.get(path);
      const resolved = realpathSync(full), suffix = relative(root, resolved);
      if (!row || readlinkSync(full) !== row.linkTarget || suffix.startsWith(`..${sep}`) || suffix === ".." ||
        resolved !== join(root, row.resolvedTarget)) fail();
      facts.push({ path: full, stat }); links.delete(path);
    } else if (stat.isDirectory()) {
      if (realpathSync(full) !== full) fail();
      directories.push({ path: full, stat });
      for (const child of readdirSync(full)) walk(path ? `${path}/${child}` : child);
      if (!same(stat, lstatSync(full, { bigint: true }))) fail();
    } else if (stat.isFile() && path === "browser-component.json") {
      if (!same(stat, manifestStat)) fail();
    } else if (stat.isFile()) {
      const row = files.get(path);
      if (!row || BigInt(row.sizeBytes) !== stat.size || realpathSync(full) !== full) return fail();
      total += row.sizeBytes;
      if (total > 2 * 1024 ** 3) fail();
      const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!same(stat, fstatSync(fd, { bigint: true }))) fail();
        const hash = createHash("sha256"), buffer = Buffer.alloc(128 * 1024);
        let observed = 0;
        for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; observed += size; hash.update(buffer.subarray(0, size)); }
        if (observed !== row.sizeBytes || `sha256:${hash.digest("hex")}` !== row.checksum || !same(stat, fstatSync(fd, { bigint: true }))) fail();
      } finally { closeSync(fd); }
      facts.push({ path: full, stat }); files.delete(path);
    } else fail();
  }
  walk("");
  if (files.size || links.size) fail();
  const assertCurrent = () => {
    for (const { path, stat } of directories) if (realpathSync(path) !== path || !same(lstatSync(path, { bigint: true }), stat)) fail();
    for (const fact of facts) if (!same(lstatSync(fact.path, { bigint: true }), fact.stat)) fail();
    if (digest(readFileSync(manifestPath)) !== checksum) fail();
  };
  assertCurrent();
  return Object.freeze({ root, entry: join(root, manifest.entryPath), checksum, assertCurrent });
}

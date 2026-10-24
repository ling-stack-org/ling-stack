import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

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

function acquisitionRecipe(value: unknown, target: { platform: string; arch: string }): void {
  if (!value || typeof value !== "object") fail();
  const recipe = value as Record<string, any>;
  const slug = target.platform === "darwin" && ["arm64", "x64"].includes(target.arch) ? `mac-${target.arch}`
    : target.platform === "win32" && target.arch === "x64" ? "win64" : undefined;
  const component = recipe.component, archive = recipe.archive;
  const hash = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
  const targetMatches = (value: { platform?: unknown; arch?: unknown } | undefined) =>
    value?.platform === target.platform && value?.arch === target.arch;
  if (!slug || recipe.schemaVersion !== 1 || recipe.mode !== "download-required" || recipe.source !== "playwright-registry"
    || !targetMatches(recipe.target) || !/^\d+\.\d+\.\d+\.\d+$/.test(recipe.browserVersion ?? "")
    || !archive || archive.url !== `https://cdn.playwright.dev/builds/cft/${recipe.browserVersion}/${slug}/chrome-${slug}.zip`
    || !hash(archive.checksum) || !Number.isSafeInteger(archive.sizeBytes) || archive.sizeBytes < 1 || archive.sizeBytes > 512 * 1024 ** 2
    || !component || component.schemaVersion !== 1 || component.source !== "playwright-registry" || !targetMatches(component.target)
    || !hash(recipe.componentChecksum) || digest(Buffer.from(`${JSON.stringify(component, null, 2)}\n`)) !== recipe.componentChecksum
    || !Array.isArray(component.files) || !component.files.length || !Array.isArray(component.links)
    || !Array.isArray(recipe.members) || !recipe.members.length || recipe.members.length > 5000) fail();
  const prefix = `chrome-${slug}`, app = `${prefix}/Google Chrome for Testing.app`;
  const entry = target.platform === "win32" ? `${prefix}/chrome.exe` : `${app}/Contents/MacOS/Google Chrome for Testing`;
  const framework = `${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework/`;
  if (component.entryPath !== entry || component.links.length !== (target.platform === "win32" ? 0 : 5)) fail();
  const members = new Map<string, Record<string, any>>(), folded = new Map<string, string>();
  const nodes = new Map<string, string>();
  let total = 0;
  for (const row of recipe.members) {
    const path = logical(row?.path), parts = path.split("/");
    const type = row.mode & 0xf000;
    if (path.length > 4096 || path !== prefix && !path.startsWith(`${prefix}/`) || members.has(path)
      || parts.some(part => /[. ]$|[<>"|?*]/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))
      || !["file", "directory", "link"].includes(row.kind) || !hash(row.checksum)
      || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > 512 * 1024 ** 2
      || !Number.isSafeInteger(row.compressedSizeBytes) || row.compressedSizeBytes < 0 || row.compressedSizeBytes > archive.sizeBytes
      || ![0, 8].includes(row.compressionMethod) || !/^[a-f0-9]{8}$/.test(row.crc32 ?? "")
      || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0xffff || row.mode & 0o7000
      || row.kind === "directory" && (row.sizeBytes !== 0 || ![0, 0x4000].includes(type))
      || row.kind === "file" && ![0, 0x8000].includes(type)
      || row.kind === "link" && (type !== 0xa000 || row.sizeBytes > 4096)
      || row.sizeBytes > Math.max(row.compressedSizeBytes, 1) * 10000) fail();
    total += row.sizeBytes;
    if (total > 2 * 1024 ** 3) fail();
    members.set(path, row);
    for (let index = 1; index <= parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/"), key = ancestor.normalize("NFC").toLowerCase();
      if (folded.has(key) && folded.get(key) !== ancestor) fail();
      folded.set(key, ancestor);
      const kind = index === parts.length ? row.kind : "directory", previous = nodes.get(ancestor);
      if (previous && previous !== kind) fail();
      nodes.set(ancestor, kind);
    }
  }
  const executable = members.get(entry);
  if (executable?.kind !== "file" || executable.native?.fileType !== "executable"
    || !Array.isArray(executable.native.architectures) || !executable.native.architectures.includes(target.arch)) fail();
  const listed = new Set<string>();
  for (const row of component.files) {
    const member = members.get(logical(row?.path));
    if (!member || member.kind !== "file" || listed.has(row.path) || row.checksum !== member.checksum || row.sizeBytes !== member.sizeBytes) fail();
    listed.add(row.path);
  }
  for (const row of component.links) {
    const member = members.get(logical(row?.path));
    if (!member || member.kind !== "link" || listed.has(row.path) || !row.path.startsWith(framework)
      || row.linkTarget !== member.linkTarget || row.resolvedTarget !== member.resolvedTarget) fail();
    listed.add(row.path);
  }
  for (const row of members.values()) {
    if (row.kind !== "directory" && !listed.has(row.path)) fail();
    if (row.kind !== "link") continue;
    if (target.platform !== "darwin" || typeof row.linkTarget !== "string" || !row.linkTarget || row.linkTarget.length > 4096
      || row.linkTarget.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(row.linkTarget)) fail();
    const resolved = logical(row.resolvedTarget);
    if (!resolved.startsWith(`${prefix}/`)) fail();
    let path = row.path;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(path) || seen.size > 40) fail();
      seen.add(path);
      const parts = path.split("/");
      let redirected = false;
      for (let index = 1; index <= parts.length; index++) {
        const ancestor = parts.slice(0, index).join("/"), link = members.get(ancestor);
        if (link?.kind !== "link") continue;
        if (typeof link.linkTarget !== "string" || !link.linkTarget || link.linkTarget.startsWith("/")
          || /[\\:\x00-\x1f\x7f]/.test(link.linkTarget)) fail();
        path = posix.normalize(posix.join(posix.dirname(ancestor), link.linkTarget, ...parts.slice(index)));
        if (path === ".." || path.startsWith("../") || path.startsWith("/")) fail();
        redirected = true; break;
      }
      if (redirected) continue;
      if (path !== resolved || !["file", "directory"].includes(nodes.get(path) ?? "") || nodes.get(path) !== row.targetKind) fail();
      break;
    }
  }
}

/** Admit immutable download instructions without acquiring or executing a browser. */
export function verifyBrowserAcquisitionDescriptor(root: string, checksum: string,
  target: { platform: string; arch: string }): VerifiedBundledBrowser {
  root = resolve(root);
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root || !/^sha256:[a-f0-9]{64}$/.test(checksum)
    || JSON.stringify(readdirSync(root)) !== '["browser-acquisition.json"]') fail();
  const entry = join(root, "browser-acquisition.json");
  const read = () => {
    const stat = lstatSync(entry, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1n || stat.size > 4n * 1024n ** 2n || realpathSync(entry) !== entry) fail();
    const fd = openSync(entry, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!same(stat, fstatSync(fd, { bigint: true }))) fail();
      const bytes = readFileSync(fd);
      if (BigInt(bytes.length) !== stat.size || digest(bytes) !== checksum || !same(stat, fstatSync(fd, { bigint: true }))
        || !same(stat, lstatSync(entry, { bigint: true }))) fail();
      return { stat, bytes };
    } finally { closeSync(fd); }
  };
  const initial = read();
  try { acquisitionRecipe(JSON.parse(initial.bytes.toString("utf8")), target); } catch { fail(); }
  const assertCurrent = () => {
    if (realpathSync(root) !== root || !same(rootStat, lstatSync(root, { bigint: true }))
      || JSON.stringify(readdirSync(root)) !== '["browser-acquisition.json"]' || !same(initial.stat, read().stat)) fail();
  };
  assertCurrent();
  return Object.freeze({ root, entry, checksum, assertCurrent });
}

/** The authenticated receipt selects exactly one local resource admission mode. */
export function verifyPackagedBrowser(root: string, selection: unknown,
  target: { platform: string; arch: string }): VerifiedBundledBrowser {
  if (!selection || typeof selection !== "object") fail();
  const browser = selection as Record<string, any>;
  if (browser.activation === "download-required") {
    if (browser.source !== "playwright-registry" || browser.entryPath !== "../../gstack-browser/browser-acquisition.json"
      || browser.componentChecksum !== browser.acquisitionChecksum || browser.target?.platform !== target.platform
      || browser.target?.arch !== target.arch) fail();
    return verifyBrowserAcquisitionDescriptor(root, browser.componentChecksum, target);
  }
  if (browser.activation !== "package-relative-only") fail();
  return verifyBundledBrowser(root, browser.componentChecksum, target);
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

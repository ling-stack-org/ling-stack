import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsPromises, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { browserAcquisitionBytes, ensureBrowserAcquisition, validateBrowserAcquisition } from "./browser-acquisition.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";

// Dev parser only in fixtures. The launcher supplies its authenticated parser
// to the production module; no third-party resolution happens in that module.
const desktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const playwright = createRequire(desktop.resolve("@playwright/test/package.json"));
const core = createRequire(playwright.resolve("playwright/package.json"));
const parserPath = join(dirname(core.resolve("playwright-core/package.json")), "lib/utilsBundle.js");
const { yauzl, yazl } = core(parserPath);
const target = { platform: process.platform, arch: process.arch };
const supported = ["darwin-arm64", "darwin-x64", "win32-x64"].includes(`${target.platform}-${target.arch}`);
const skip = !supported && "Acquisition requires a native supported macOS or Windows host";
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const version = "151.0.7922.34";

function nativeBytes(forTarget, library = false) {
  const bytes = Buffer.alloc(128);
  if (forTarget.platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(forTarget.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(library ? 6 : 2, 12);
  } else {
    bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(2, 84);
    bytes.writeUInt16LE(library ? 0x2002 : 2, 86); bytes.writeUInt16LE(0x20b, 88);
  }
  return bytes;
}

async function fixture(t, forTarget = supported ? target : { platform: "win32", arch: "x64" }) {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "gstack-browser-acquisition-")));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const slug = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "win64" }[`${forTarget.platform}-${forTarget.arch}`];
  const prefix = `chrome-${slug}`, app = `${prefix}/Google Chrome for Testing.app`;
  const framework = `${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework`, versionRoot = `${framework}/Versions/${version}`;
  const entryPath = forTarget.platform === "win32" ? `${prefix}/chrome.exe` : `${app}/Contents/MacOS/Google Chrome for Testing`;
  const sourceFiles = new Map([[entryPath, nativeBytes(forTarget)]]);
  const entries = [[entryPath, sourceFiles.get(entryPath), 0o100755]];
  if (forTarget.platform === "win32") entries.push([`${prefix}/ABOUT`, Buffer.from("Original copyright reference\r\n")]);
  else entries.push([`${versionRoot}/Google Chrome for Testing Framework`, nativeBytes(forTarget, true), 0o100755],
    [`${versionRoot}/Libraries/WidevineCdm/LICENSE`, Buffer.from("Original license\r\n原始声明\r\n")],
    [`${versionRoot}/Resources/resource.txt`, Buffer.from("original browser data")], [`${versionRoot}/Helpers/helper.txt`, Buffer.from("original helper data")],
    ...["Google Chrome for Testing Framework", "Helpers", "Libraries", "Resources"].map(name =>
      [`${framework}/${name}`, Buffer.from(`Versions/Current/${name}`), 0o120755]),
    [`${framework}/Versions/Current`, Buffer.from(version), 0o120755]);
  const zip = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => { zip.outputStream.on("data", part => chunks.push(part)); zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject); });
  for (const [path, bytes, mode = 0o100644] of entries) zip.addBuffer(bytes, path, { mode, compress: false });
  zip.addEmptyDirectory(`${prefix}/empty`, { mode: 0o40755 });
  zip.end(); await done;
  const payload = Buffer.concat(chunks), zipPath = join(stateRoot, "source.zip"); await writeFile(zipPath, payload);
  const inspected = await inspectBrowserZip({ zipPath, yauzl, target: forTarget });
  const component = { schemaVersion: 1, source: "playwright-registry", target: forTarget, entryPath,
    files: inspected.members.filter(row => row.kind === "file").map(({ path, checksum, sizeBytes }) => ({ path, checksum, sizeBytes })),
    links: inspected.members.filter(row => row.kind === "link").map(({ path, linkTarget, resolvedTarget }) => ({ path, linkTarget, resolvedTarget })) };
  const acquisition = { schemaVersion: 1, mode: "download-required", source: "playwright-registry", target: forTarget, browserVersion: version,
    archive: { url: `https://cdn.playwright.dev/builds/cft/${version}/${slug}/chrome-${slug}.zip`, checksum: digest(payload), sizeBytes: payload.length },
    component, componentChecksum: digest(json(component)), members: inspected.members };
  const key = digest(browserAcquisitionBytes(acquisition)).slice(7), registry = join(stateRoot, "browser-cache/playwright"), final = join(registry, key);
  const calls = [];
  const request = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, "manual"); assert.equal(options.credentials, "omit");
    assert.equal(options.headers["accept-encoding"], "identity");
    return new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
  };
  const acquire = (options = {}) => ensureBrowserAcquisition({ stateRoot, acquisition, yauzl, request, ...options });
  return { stateRoot, target: forTarget, acquisition, payload, sourceFiles, calls, request, acquire, registry, final, key, framework };
}

function rebind(recipe) {
  recipe.component.files = recipe.members.filter(row => row.kind === "file").map(({ path, checksum, sizeBytes }) => ({ path, checksum, sizeBytes }));
  recipe.component.links = recipe.members.filter(row => row.kind === "link").map(({ path, linkTarget, resolvedTarget }) => ({ path, linkTarget, resolvedTarget }));
  recipe.componentChecksum = digest(json(recipe.component));
  return recipe;
}

test("recipes bind official fixed URL, exact target, full members and canonical component bytes", async t => {
  for (const forTarget of [{ platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" }, { platform: "win32", arch: "x64" }]) {
    const f = await fixture(t, forTarget);
    assert.equal(validateBrowserAcquisition(f.acquisition, forTarget), f.acquisition);
    assert.deepEqual(browserAcquisitionBytes(f.acquisition), json(f.acquisition));
    const mutations = [r => { r.mode = "bundled"; }, r => { r.source = "custom"; }, r => { r.target.arch = "unknown"; },
      r => { r.archive.url = r.archive.url.replace("cdn.playwright.dev", "untrusted.invalid"); },
      r => { r.archive.url += "?url=custom"; }, r => { r.archive.url = r.archive.url.replace("https:", "http:"); },
      r => { r.archive.sizeBytes = 512 * 1024 ** 2 + 1; }, r => { r.archive.checksum = "sha256:bad"; },
      r => { r.componentChecksum = `sha256:${"0".repeat(64)}`; }, r => { r.component.entryPath += "-other"; },
      r => { r.component.files.pop(); }, r => { r.members.push(structuredClone(r.members[0])); },
      r => { r.extra = "x".repeat(4 * 1024 ** 2); }, r => { r.members[0] = null; },
      r => { r.members[0].path = "../escape"; rebind(r); }, r => { r.members[0].path = "C:/escape"; rebind(r); },
      r => { r.members[0].mode |= 0o4000; }, r => { r.members[0].sizeBytes = 2 ** 32; }];
    for (const mutate of mutations) { const recipe = structuredClone(f.acquisition); mutate(recipe); assert.throws(() => validateBrowserAcquisition(recipe, forTarget), /gstack_browser_/); }
    assert.throws(() => validateBrowserAcquisition(f.acquisition, { platform: "win32", arch: "arm64" }), /recipe_invalid/);
  }
});

test("only the five authenticated macOS framework aliases are admitted", async t => {
  const f = await fixture(t, { platform: "darwin", arch: "arm64" });
  for (const mutate of [r => { r.members.find(row => row.kind === "link").linkTarget = "../../../../escape"; },
    r => { const row = r.members.find(row => row.kind === "link" && row.path.endsWith("/Helpers")); row.path = row.path.replace("Helpers", "Unreviewed"); },
    r => { r.members.find(row => row.kind === "link").resolvedTarget = "chrome-mac-arm64/other"; }]) {
    const recipe = structuredClone(f.acquisition); mutate(recipe); rebind(recipe);
    assert.throws(() => validateBrowserAcquisition(recipe), /gstack_browser_/);
  }
});

test("first acquisition authenticates all bytes and aliases; the verified cache works offline", { skip }, async t => {
  const f = await fixture(t), browser = await f.acquire();
  assert.equal(browser.root, join(f.final, "browser")); assert.equal(browser.entry, join(browser.root, f.acquisition.component.entryPath));
  assert.equal(browser.checksum, f.acquisition.componentChecksum); browser.assertCurrent();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readFile(join(f.final, "acquisition.json")), browserAcquisitionBytes(f.acquisition));
  assert.deepEqual(await readFile(join(browser.root, "browser-component.json")), json(f.acquisition.component));
  assert.deepEqual(await readdir(f.registry), [f.key]);
  for (const file of f.acquisition.component.files) assert.equal(digest(await readFile(join(browser.root, file.path))), file.checksum);
  const cached = await f.acquire({ request: () => assert.fail("cache hits must be offline") }); cached.assertCurrent();
  if (target.platform === "darwin") assert.ok((await lstat(cached.entry)).mode & 0o111);
});

test("concurrent callers share one complete acquisition and never expose staging as a cache", { skip }, async t => {
  const f = await fixture(t), request = async (...args) => { await delay(10); return f.request(...args); };
  const results = await Promise.all([f.acquire({ request }), f.acquire({ request }), f.acquire({ request })]);
  assert.ok(results.every(result => result.root === join(f.final, "browser")));
  assert.equal(f.calls.length, 1); assert.deepEqual(await readdir(f.registry), [f.key]);
});

for (const mode of ["truncated", "wrong-hash", "oversize", "size-header", "encoding", "redirect", "redirect-loop", "http", "network"]) {
  test(`${mode} fails without publishing and a later retry succeeds`, { skip }, async t => {
    const f = await fixture(t);
    const request = async () => {
      if (mode === "network") throw Error("offline");
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/browser.zip" } });
      if (mode === "redirect-loop") return new Response(null, { status: 302, headers: { location: f.acquisition.archive.url } });
      if (mode === "http") return new Response("not available", { status: 503 });
      const bytes = Buffer.from(f.payload);
      if (mode === "wrong-hash") bytes[20] ^= 1;
      const headers = mode === "size-header" ? { "content-length": "1" } : mode === "encoding" ? { "content-encoding": "gzip" } : {};
      return new Response(mode === "truncated" ? bytes.subarray(1) : mode === "oversize" ? Buffer.concat([bytes, bytes]) : bytes, { headers });
    };
    await assert.rejects(f.acquire({ request }), /gstack_browser_acquisition_/);
    assert.deepEqual(await readdir(f.registry), []);
    (await f.acquire()).assertCurrent();
  });
}

test("official redirects retain version, platform and filename constraints", { skip }, async t => {
  const f = await fixture(t); let calls = 0;
  const suffix = new URL(f.acquisition.archive.url).pathname.slice("/builds/cft".length);
  const result = await f.acquire({ request: async (url, options) => {
    if (!calls++) return new Response(null, { status: 307, headers: { location: `https://storage.googleapis.com/chrome-for-testing-public${suffix}` } });
    assert.equal(url, `https://storage.googleapis.com/chrome-for-testing-public${suffix}`);
    return f.request(url, options);
  } });
  result.assertCurrent(); assert.equal(calls, 2);
  for (const location of [`https://cdn.playwright.dev/wrong-version/chrome.zip`, f.acquisition.archive.url.replace("https://", "https://user@"),
    f.acquisition.archive.url.replace(".dev/", ".dev:444/"), `${f.acquisition.archive.url}#fragment`]) {
    const other = await fixture(t);
    await assert.rejects(other.acquire({ request: async () => new Response(null, { status: 302, headers: { location } }) }), /endpoint_invalid/);
  }
});

test("archive metadata disagreements cannot be hidden by a valid archive digest", { skip }, async t => {
  const f = await fixture(t), recipe = structuredClone(f.acquisition);
  const file = recipe.members.find(row => row.kind === "file"); file.crc32 = file.crc32 === "0" ? "1" : "0";
  await assert.rejects(f.acquire({ acquisition: recipe }), /archive_inventory_mismatch/);
  assert.deepEqual(await readdir(f.registry), []);
  (await f.acquire()).assertCurrent();
});

for (const mutation of ["file", "component", "receipt", "extra-file", "container-extra", "empty-directory", "alias"]) {
  test(`a cache with changed ${mutation} fails closed without replacement or download`, { skip: skip || mutation === "alias" && target.platform !== "darwin" }, async t => {
    const f = await fixture(t), browser = await f.acquire();
    if (mutation === "file") await writeFile(browser.entry, Buffer.alloc((await readFile(browser.entry)).length));
    if (mutation === "component") await writeFile(join(browser.root, "browser-component.json"), "{}");
    if (mutation === "receipt") await writeFile(join(f.final, "acquisition.json"), "{}");
    if (mutation === "extra-file") await writeFile(join(browser.root, "unlisted"), "unauthenticated");
    if (mutation === "container-extra") await writeFile(join(f.final, "unlisted"), "unauthenticated");
    if (mutation === "empty-directory") await rm(join(browser.root, `chrome-${target.platform === "win32" ? "win64" : `mac-${target.arch}`}/empty`), { recursive: true });
    if (mutation === "alias") { const path = join(browser.root, f.acquisition.component.links[0].path); await unlink(path); await symlink(tmpdir(), path); }
    assert.throws(() => browser.assertCurrent());
    await assert.rejects(f.acquire({ request: () => assert.fail("corruption must not be silently replaced") }));
    assert.equal(f.calls.length, 1);
  });
}

test("dead-owner and empty-lock recovery preserve unrelated partial directories", { skip }, async t => {
  const f = await fixture(t), child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise(resolve => child.once("close", resolve));
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  await mkdir(f.registry, { recursive: true, mode: 0o700 });
  const token = randomUUID(), lock = `${f.final}.lock`, partial = join(f.registry, `.${f.key}.${token}.partial`), unrelated = join(f.registry, ".unrelated.partial");
  await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: child.pid, token }));
  await mkdir(partial, { mode: 0o700 }); await writeFile(join(partial, "incomplete"), "not a browser");
  await mkdir(unrelated, { mode: 0o700 });
  (await f.acquire()).assertCurrent();
  assert.deepEqual((await readdir(f.registry)).sort(), [".unrelated.partial", f.key].sort());
  const other = await fixture(t); await mkdir(other.registry, { recursive: true, mode: 0o700 }); await mkdir(`${other.final}.lock`, { mode: 0o700 });
  const originalRename = fsPromises.rename;
  const mocked = t.mock.method(fsPromises, "rename", async (from, to) => {
    if (to === `${other.final}.lock` && await lstat(to).catch(() => undefined)) throw Object.assign(Error("NTFS existing directory"), { code: "EPERM" });
    return originalRename(from, to);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  (await other.acquire({ pollMs: 1 })).assertCurrent();
  assert.deepEqual(await readdir(other.registry), [other.key]);
});

test("network and live-owner waiting both have bounded deadlines", { skip }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.acquire({ timeoutMs: 20, request: async (_url, { signal }) => {
    await delay(5000, undefined, { signal }); return new Response("late");
  } }), /timeout/);
  assert.deepEqual(await readdir(f.registry), []);
  const token = randomUUID(), lock = `${f.final}.lock`; await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ pid: process.pid, token }));
  await assert.rejects(f.acquire({ timeoutMs: 20, pollMs: 1 }), /cache_busy_timeout/);
  assert.deepEqual(await readdir(f.registry), [`${f.key}.lock`]);
});

test("unbounded response bodies are interrupted before any cache is published", { skip }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.acquire({ timeoutMs: 30, request: async () => new Response(new ReadableStream({ start() {} })) }), /timeout/);
  assert.deepEqual(await readdir(f.registry), []);
});

test("an isolated process keeps the acquisition deadline alive through abort and lock cleanup", { skip }, async t => {
  const f = await fixture(t), recipe = join(f.stateRoot, "recipe.json");
  await writeFile(recipe, browserAcquisitionBytes(f.acquisition));
  const code = `import{readFile}from'node:fs/promises';import{createRequire}from'node:module';
    import{ensureBrowserAcquisition}from${JSON.stringify(new URL("./browser-acquisition.mjs", import.meta.url).href)};
    const{yauzl}=createRequire(import.meta.url)(${JSON.stringify(parserPath)});
    try{await ensureBrowserAcquisition({stateRoot:process.argv[1],acquisition:JSON.parse(await readFile(process.argv[2])),
      yauzl,timeoutMs:30,request:async()=>new Response(new ReadableStream({start(){}}))});throw Error('unexpected acquisition');}
    catch(error){if(!String(error).includes('acquisition_timeout'))throw error;console.log('deadline-and-cleanup-completed');}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.stateRoot, recipe], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", part => { stdout += part; }); child.stderr.on("data", part => { stderr += part; });
  const guard = setTimeout(() => child.kill(), 5000);
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
    .finally(() => clearTimeout(guard));
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), "deadline-and-cleanup-completed");
  assert.deepEqual(await readdir(f.registry), []);
});

test("the shared deadline also rejects expiry after extraction without publishing partial content", { skip }, async t => {
  const f = await fixture(t), originalWrite = fsPromises.writeFile;
  const mocked = t.mock.method(fsPromises, "writeFile", async (path, ...args) => {
    if (basename(String(path)) === "browser-component.json") await delay(150);
    return originalWrite(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(f.acquire({ timeoutMs: 100 }), /timeout/);
  assert.deepEqual(await readdir(f.registry), []);
  mocked.mock.restore(); syncBuiltinESMExports();
  (await f.acquire()).assertCurrent();
});

test("canonical owned private cache parents are required and remain bound after admission", { skip: skip || process.platform === "win32" }, async t => {
  const f = await fixture(t), alias = `${f.stateRoot}-alias`;
  await symlink(f.stateRoot, alias); t.after(() => rm(alias, { force: true }));
  await assert.rejects(f.acquire({ stateRoot: alias }), /cache_directory_invalid/);
  await assert.rejects(f.acquire({ stateRoot: `${f.stateRoot}/../unknown` }), /state_root_required/);
  await mkdir(join(f.stateRoot, "browser-cache"), { mode: 0o755 });
  await assert.rejects(f.acquire(), /cache_directory_invalid/);
  await chmod(join(f.stateRoot, "browser-cache"), 0o700);
  const browser = await f.acquire(); await chmod(f.registry, 0o755);
  assert.throws(() => browser.assertCurrent(), /cache_directory_changed/);
});

test("independent processes serialize the download and publish one immutable browser", { skip }, async t => {
  const f = await fixture(t), recipePath = join(f.stateRoot, "recipe.json"), calls = join(f.stateRoot, "requests.log");
  await writeFile(recipePath, browserAcquisitionBytes(f.acquisition));
  const script = `import{createRequire}from'node:module';import{readFile,appendFile}from'node:fs/promises';
    import{ensureBrowserAcquisition}from${JSON.stringify(new URL("./browser-acquisition.mjs", import.meta.url).href)};
    const r=createRequire(import.meta.url),{yauzl}=r(${JSON.stringify(parserPath)});
    const root=process.argv[1],acquisition=JSON.parse(await readFile(process.argv[2])),bytes=await readFile(root+'/source.zip');
    const result=await ensureBrowserAcquisition({stateRoot:root,acquisition,yauzl,pollMs:5,request:async()=>{
      await appendFile(process.argv[3],'download\\n');await new Promise(r=>setTimeout(r,50));return new Response(bytes);}});
    result.assertCurrent();console.log(result.root);`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.stateRoot, recipePath, calls], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", part => stdout += part); child.stderr.on("data", part => stderr += part);
    child.once("error", reject); child.once("close", code => code ? reject(Error(stderr)) : resolve(stdout.trim()));
  });
  assert.deepEqual(await Promise.all([run(), run()]), [join(f.final, "browser"), join(f.final, "browser")]);
  assert.equal(await readFile(calls, "utf8"), "download\n"); assert.deepEqual(await readdir(f.registry), [f.key]);
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

// GHSA-3g3m-2fjr-6pw4: upstream 4682e8c9babee1b385202ede36389634e12076d7.
// Resolve from real consumers and follow the installed public export declarations.
const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const mobileRequire = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const mcpRequire = createRequire(expoRequire.resolve("expo-mcp/package.json"));
const asarEntry = desktopRequire.resolve("@electron/asar");
const asarRequire = createRequire(asarEntry);
const legacyAsarEntry = appBuilderRequire.resolve("@electron/asar");
const legacyAsarRequire = createRequire(legacyAsarEntry);
const consumers = [
  { name: "electron-builder -> app-builder-lib", require: appBuilderRequire, version: "14.0.2" },
  { name: "Expo -> CLI", require: cliRequire, version: "14.0.2" },
  { name: "Expo -> expo-mcp", require: mcpRequire, version: "14.0.2" },
  { name: "Desktop -> ASAR", require: asarRequire, version: "14.0.2" },
];
const timeout = 5_000;
const readJson = path => JSON.parse(fs.readFileSync(path, "utf8"));
const posix = path => path.replaceAll("\\", "/");
const sorted = paths => paths.map(posix).sort();

function newDirectory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ling-glob-security-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, contents = name) {
  const path = join(root, name);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, contents);
}

function tree(t) {
  const root = newDirectory(t);
  function branch(path, depth) {
    write(root, join(path, "file.txt"));
    if (depth > 0) for (const child of ["a", "b"]) branch(join(path, child), depth - 1);
  }
  branch("", 3);
  return root;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Queue actual directory entries, then release callbacks explicitly. Once this
// finite queue and its microtasks drain, no hidden filesystem work remains.
function controlledFs(onRead = () => {}) {
  const callbacks = [];
  const first = deferred();
  let reads = 0;
  const record = () => {
    reads++;
    onRead(reads);
    first.resolve();
  };
  const api = {
    ...fs,
    promises: {
      ...fs.promises,
      lstat: async (...args) => fs.lstatSync(...args),
    },
    readdir(path, options, cb) {
      record();
      let entries, error;
      try { entries = fs.readdirSync(path, options); }
      catch (err) { error = err; }
      callbacks.push(() => cb(error, entries));
    },
    readdirSync(...args) {
      record();
      return fs.readdirSync(...args);
    },
  };
  return {
    fs: api,
    firstRead: first.promise,
    get reads() { return reads; },
    get pending() { return callbacks.length; },
    async releaseOne() {
      assert.ok(callbacks.length > 0, "a directory callback must be pending");
      callbacks.shift()();
      await nextTurn();
    },
    async drain() {
      let delivered = 0;
      do {
        while (callbacks.length) {
          assert.ok(++delivered <= 64, "bounded fixture must not schedule an unbounded traversal");
          callbacks.shift()();
          await nextTurn();
        }
        await nextTurn();
      } while (callbacks.length);
    },
  };
}

function streamResult(stream) {
  const settled = deferred();
  const values = [];
  let error;
  stream.on("data", value => { values.push(value); });
  stream.on("error", err => { error = err; settled.resolve(); });
  stream.on("end", () => settled.resolve());
  return { values, get error() { return error; }, done: settled.promise };
}

const variants = [];
for (const consumer of [consumers[2], consumers[0], consumers[1], consumers[3]]) {
  const manifestPath = consumer.require.resolve("glob/package.json");
  const manifest = readJson(manifestPath);
  assert.equal(manifest.version, consumer.version);
  for (const raw of manifest.version === "14.0.2" ? [false, true] : [false]) {
    const specifier = raw ? "glob/raw" : "glob";
    const declaration = manifest.exports[raw ? "./raw" : "."];
    for (const format of ["require", "import"]) {
      const entry = resolve(dirname(manifestPath), declaration[format].default);
      if (format === "require") assert.equal(entry, consumer.require.resolve(specifier));
      const variant = {
        label: `glob@${manifest.version} ${format === "require" ? "CJS" : "ESM"}${raw ? " /raw" : " default"}`,
        api: format === "require" ? consumer.require(specifier) : await import(pathToFileURL(entry).href),
      };
      if (consumer === consumers[2] || consumer === consumers[0]) variants.push(variant);
    }
  }
}

test("glob consumers resolve the official cancellation fix", { timeout }, async () => {
  const lock = appBuilderRequire("js-yaml").load(fs.readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
  for (const consumer of consumers) {
    const installedManifest = consumer.require.resolve("glob/package.json");
    const globManifest = readJson(installedManifest);
    assert.equal(globManifest.version, consumer.version, consumer.name);
    assert.equal(consumer.version, "14.0.2");
    assert.ok(lock.packages[`glob@${consumer.version}`], "lock retains the official fixed release");
    assert.equal(installedManifest.includes("patch_hash="), false, `${consumer.name} uses the official release`);
    for (const format of ["require", "import"]) {
      const entry = resolve(dirname(installedManifest), globManifest.exports["."][format].default);
      assert.equal(entry.includes("patch_hash="), false, `${consumer.name} ${format} entry uses the official release`);
      assert.ok(fs.statSync(entry).isFile());
    }
    assert.equal(globManifest.exports["."].require.default, "./dist/commonjs/index.min.js");
    assert.equal(globManifest.exports["."].import.default, "./dist/esm/index.min.js");
    assert.equal(globManifest.exports["./raw"].require.default, "./dist/commonjs/index.js");
    assert.equal(globManifest.exports["./raw"].import.default, "./dist/esm/index.js");
  }
  assert.equal(legacyAsarRequire("glob/package.json").version, "7.2.3", "legacy ASAR is not forced across glob majors");
});

for (const { label, api } of variants) {
  test(`behavior: ${label} stops all asynchronous reads after first-read abort`, { timeout }, async t => {
    const cwd = tree(t);
    const abort = new AbortController();
    const reason = new Error("first-directory-aborted");
    const io = controlledFs(reads => { if (reads === 1) abort.abort(reason); });
    let atReject;
    const result = api.glob("**", { cwd, signal: abort.signal, fs: io.fs }).then(
      () => ({ fulfilled: true }),
      error => { atReject = io.reads; return { error }; },
    );
    await io.firstRead;
    await io.drain();
    assert.equal((await result).error, reason, "original cancellation reason is preserved");
    t.diagnostic(JSON.stringify({ readsAtRejection: atReject, readsAfterDrain: io.reads }));
    assert.equal(io.reads, 1, "abort must not read any descendant directories");
    assert.equal(io.reads, atReject, "rejection must not leave background traversal running");
  });

  for (const sync of [false, true]) {
    test(`behavior: ${label} ${sync ? "sync" : "async"} stream stops after first-read abort`, { timeout }, async t => {
      const cwd = tree(t);
      const abort = new AbortController();
      const reason = new Error("stream-directory-aborted");
      const io = controlledFs(reads => { if (reads === 1) abort.abort(reason); });
      const stream = api[sync ? "globStreamSync" : "globStream"]("**", { cwd, signal: abort.signal, fs: io.fs });
      const result = streamResult(stream);
      t.after(() => stream.destroy());
      stream.resume();
      if (!sync) await io.firstRead;
      await io.drain();
      await result.done;
      t.diagnostic(JSON.stringify({ directoryReads: io.reads }));
      assert.equal(result.error, reason);
      assert.equal(io.reads, 1, "stream cancellation must not traverse the remaining tree");
    });
  }

  test(`behavior: ${label} already-aborted promise, sync walk and streams perform no reads`, { timeout }, async t => {
    const cwd = tree(t);
    const abort = new AbortController();
    const reason = new Error("aborted-before-walk");
    abort.abort(reason);
    const io = controlledFs();
    const options = { cwd, signal: abort.signal, fs: io.fs };
    await assert.rejects(api.glob("**", options), error => error === reason);
    assert.throws(() => api.globSync("**", options), error => error === reason);
    for (const name of ["globStream", "globStreamSync"]) {
      const stream = api[name]("**", options);
      const result = streamResult(stream);
      t.after(() => stream.destroy());
      stream.resume();
      await io.drain();
      await result.done;
      assert.equal(result.error, reason);
    }
    assert.equal(io.reads, 0);
  });

  test(`behavior: ${label} aborting a synchronous walk preserves its reason and stops reading`, { timeout }, t => {
    const cwd = tree(t);
    const abort = new AbortController();
    const reason = new Error("sync-directory-aborted");
    const io = controlledFs(reads => { if (reads === 1) abort.abort(reason); });
    assert.throws(() => api.globSync("**", { cwd, signal: abort.signal, fs: io.fs }), error => error === reason);
    assert.equal(io.reads, 1);
  });

  test(`behavior: ${label} a paused stream resumes after pending directory callbacks`, { timeout }, async t => {
    const cwd = tree(t);
    const io = controlledFs();
    const stream = api.globStream("**/*", { cwd, fs: io.fs });
    t.after(() => stream.destroy());
    stream.pause();
    await io.firstRead;
    assert.equal(io.pending, 1, "root read is deliberately pending while the stream is paused");
    await io.releaseOne();
    assert.equal(stream.flowing, false);
    assert.equal(io.pending, 2, "both child reads were started before their matches applied backpressure");
    await io.drain();
    assert.equal(io.reads, 3, "pending reads finish, but backpressure suspends their descendants");
    const result = streamResult(stream);
    stream.resume();
    await io.drain();
    await result.done;
    assert.equal(result.error, undefined);
    assert.deepEqual(sorted(result.values), sorted(api.globSync("**/*", { cwd })));
  });

  test(`behavior: ${label} abort during a pending paused read settles and later resume cannot restart traversal`, { timeout }, async t => {
    const cwd = tree(t);
    const abort = new AbortController();
    const reason = new Error("paused-pending-directory-aborted");
    const io = controlledFs();
    const stream = api.globStream("**/*", { cwd, signal: abort.signal, fs: io.fs });
    const result = streamResult(stream);
    t.after(() => stream.destroy());
    stream.pause();
    await io.firstRead;
    assert.equal(io.pending, 1);
    abort.abort(reason);
    await result.done;
    stream.resume();
    await io.drain();
    assert.equal(result.error, reason);
    assert.equal(io.reads, 1);
    assert.equal(stream.destroyed, true);
  });

  test(`behavior: ${label} normal, dot, symlink and Windows-separator enumeration remains compatible`, { timeout }, async t => {
    const cwd = newDirectory(t);
    write(cwd, "root.txt");
    write(cwd, ".hidden");
    write(cwd, "nested/file.txt");
    write(cwd, "nested/.secret");
    fs.mkdirSync(join(cwd, "empty"));
    fs.symlinkSync("root.txt", join(cwd, "root-link"), "file");
    fs.symlinkSync("nested", join(cwd, "dir-link"), process.platform === "win32" ? "junction" : "dir");
    const expected = ["dir-link", "empty", "nested", "nested/file.txt", "root-link", "root.txt"];
    assert.deepEqual(sorted(await api.glob("**/*", { cwd })), expected);
    assert.deepEqual(sorted(api.globSync("**/*", { cwd })), expected);
    assert.deepEqual(sorted(await api.glob("**/*", { cwd, dot: true })), [...expected, ".hidden", "nested/.secret"].sort());
    assert.deepEqual(sorted(await api.glob("**/*.txt", { cwd, follow: true, nodir: true })), ["dir-link/file.txt", "nested/file.txt", "root.txt"]);
    const entries = await api.glob("*", { cwd, withFileTypes: true });
    assert.equal(entries.find(entry => entry.name === "dir-link").isSymbolicLink(), true);
    assert.equal(entries.find(entry => entry.name === "empty").isDirectory(), true);
    assert.deepEqual(sorted(await api.glob("nested\\*.txt", { cwd, windowsPathsNoEscape: true })), ["nested/file.txt"]);
    assert.deepEqual(sorted(await api.glob("nested/*ILE.TXT", { cwd, nocase: true })), ["nested/file.txt"]);
    assert.deepEqual(sorted(await api.glob("nested/*.txt", { cwd, dotRelative: true })), ["./nested/file.txt"]);
  });
}

for (const [name, entry, globVersion] of [
  ["Desktop ASAR 4.3.1 (glob 14)", asarEntry, "14.0.2"],
  ["builder ASAR 3.4.1 (legacy glob 7)", legacyAsarEntry, "7.2.3"],
]) {
  test(`behavior: ${name} packs, unpacks and extracts real files and links`, { timeout }, async t => {
    const asar = await import(pathToFileURL(entry).href);
    assert.equal(createRequire(entry)("glob/package.json").version, globVersion);
    const root = newDirectory(t);
    const source = join(root, "source");
    write(source, "main.js", "module.exports = 42;\n");
    write(source, ".env", "TEST_FIXTURE=1\n");
    write(source, "native/addon.node", "fixture native bytes\n");
    write(source, "assets/data.txt", "fixture asset bytes\n");
    fs.symlinkSync("main.js", join(source, "linked.js"), "file");
    fs.symlinkSync("assets", join(source, "asset-link"), process.platform === "win32" ? "junction" : "dir");
    const archive = join(root, "app.asar");
    t.after(() => asar.uncache(archive));
    await asar.createPackageWithOptions(source, archive, { unpack: "**/*.node", unpackDir: "assets" });
    const names = asar.listPackage(archive).map(name => posix(name).replace(/^\//, ""));
    for (const name of ["main.js", ".env", "native/addon.node", "assets/data.txt", "linked.js", "asset-link"]) {
      assert.ok(names.includes(name), `archive retains ${name}`);
    }
    assert.equal(names.some(name => name.startsWith("asset-link/")), false, "directory links remain links, not duplicate packed descendants");
    assert.equal(asar.statFile(archive, "linked.js", false).link, "main.js");
    assert.equal(asar.statFile(archive, "asset-link", false).link, "assets");
    for (const name of ["native/addon.node", "assets/data.txt"]) {
      assert.equal(asar.statFile(archive, name).unpacked, true);
      assert.deepEqual(fs.readFileSync(join(`${archive}.unpacked`, name)), fs.readFileSync(join(source, name)));
      assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(join(source, name)));
    }
    assert.deepEqual(asar.extractFile(archive, "linked.js"), fs.readFileSync(join(source, "main.js")));
    const destination = join(root, "extracted");
    asar.extractAll(archive, destination);
    for (const name of ["main.js", ".env", "native/addon.node", "assets/data.txt", "linked.js"]) {
      assert.deepEqual(fs.readFileSync(join(destination, name)), fs.readFileSync(join(source, name)));
    }
    if (process.platform !== "win32") {
      assert.equal(fs.lstatSync(join(destination, "linked.js")).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(join(destination, "linked.js")), join(destination, "main.js"));
      assert.equal(fs.lstatSync(join(destination, "asset-link")).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(join(destination, "asset-link")), join(destination, "assets"));
    }
  });
}

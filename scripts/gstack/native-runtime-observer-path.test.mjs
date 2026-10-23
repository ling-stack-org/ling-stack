import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";

// Execute the checked-in hooks with a stub native loader. Windows filesystem
// identities are synthetic; the POSIX symlink test below uses real filesystem IO.
const sources = Object.fromEntries([
  ["security", "security-sidecar-runtime-probe.mjs"], ["testsavant", "testsavant-quality-observer.mjs"],
].map(([name, file]) => [name, fs.readFileSync(new URL(file, import.meta.url), "utf8")]));
function hooks(kind, root, paths, disk, platform = "win32") {
  const calls = [], nativeResult = { loaded: true };
  const process = { argv: ["node", "probe", root], platform, execPath: paths.join(root, "tools/node"),
    report: { getReport: () => ({ sharedObjects: [] }) },
    dlopen(...args) { calls.push(args); return nativeResult; } };
  const context = { ...disk, ...paths, createHash, Buffer, process, fileURLToPath, pathToFileURL,
    registerHooks: () => ({ deregister() {} }), syncBuiltinESMExports() {}, createRequire: () => () => ({}) };
  let source = sources[kind].replace(/^import .*;\r?\n/gmu, "").replace("export function observeTestsavantQualityRuntime", "function observeTestsavantQualityRuntime");
  source = kind === "security" ? source.slice(0, source.indexOf("const transformersEntry =")) +
    "\nglobalThis.finish = () => ({ inputs: [...inputs.values()], addons: [...addons] });" :
    source + `\nglobalThis.observer = observeTestsavantQualityRuntime(${JSON.stringify(root)}); globalThis.finish = () => observer.finish();`;
  vm.runInNewContext(source, context, { filename: `${kind}-checked-in-hook.mjs` });
  return { load: filename => process.dlopen({ id: "fixture" }, filename, 42),
    finish: () => JSON.parse(JSON.stringify(context.finish())), calls, nativeResult };
}
function windowsFixture(kind) {
  const root = "D:\\fixture\\runtime", canonical = win32.join(root, "node_modules/native/binding.node");
  const files = new Map(), resolutions = new Map([[root, root]]), descriptors = new Map();
  const missing = () => { throw Object.assign(new Error("fixture missing"), { code: "ENOENT" }); };
  const entry = path => files.get(path) ?? missing();
  const stats = file => ({ dev: 1, ino: 2, size: file.size ?? file.bytes.length, mtimeMs: file.changeAfterRead && file.read ? 2 : 1,
    ctimeMs: 1, isFile: () => true, isSymbolicLink: () => false });
  const disk = { constants: fs.constants,
    realpathSync: path => resolutions.get(path) ?? missing(), lstatSync: path => stats(entry(path)),
    readFileSync: path => { const file = entry(path); file.read = true; return file.bytes; },
    openSync: path => { const id = descriptors.size + 1; descriptors.set(id, { file: entry(path), offset: 0 }); return id; },
    fstatSync: fd => stats(descriptors.get(fd).file), closeSync: fd => descriptors.delete(fd),
    readSync: (fd, buffer) => { const state = descriptors.get(fd), size = state.file.bytes.copy(buffer, 0, state.offset);
      state.offset += size; state.file.read = true; return size; },
  };
  function add(path, bytes = Buffer.from("native input bytes")) {
    files.set(path, { bytes }); resolutions.set(path, path); resolutions.set(win32.toNamespacedPath(path), path);
  }
  add(canonical);
  return { ...hooks(kind, root, win32, disk), root, canonical, files, resolutions, add };
}

for (const kind of ["security", "testsavant"]) {
  test(`${kind}: Windows native hook admits only canonical or its exact namespace spelling`, () => {
    const fixture = windowsFixture(kind), namespaced = win32.toNamespacedPath(fixture.canonical);
    for (const filename of [fixture.canonical, namespaced]) assert.equal(fixture.load(filename), fixture.nativeResult);
    const observation = fixture.finish();
    assert.deepEqual(observation.addons, ["node_modules/native/binding.node"]);
    assert.deepEqual(observation.inputs, [{ path: "node_modules/native/binding.node", sizeBytes: 18,
      checksum: `sha256:${createHash("sha256").update("native input bytes").digest("hex")}` }]);
    assert.deepEqual(fixture.calls.map(call => call.slice(1)), [[fixture.canonical, 42], [namespaced, 42]], "native loader receives the original filename and flags");
  });

  test(`${kind}: Windows native aliases, links, parent and external roots remain rejected`, () => {
    const fixture = windowsFixture(kind), namespaced = win32.toNamespacedPath(fixture.canonical);
    for (const alias of [win32.join(fixture.root, "linked.node"), win32.toNamespacedPath(win32.join(fixture.root, "linked.node")),
      namespaced.replace("D:", "d:"), namespaced.replaceAll("\\", "/"),
      fixture.canonical.replace("\\native\\", "\\native\\..\\native\\"), "node_modules\\native\\binding.node"]) {
      fixture.resolutions.set(alias, fixture.canonical);
      assert.throws(() => fixture.load(alias), /external_or_linked_input|dependency_invalid/u, alias);
    }
    for (const outside of ["D:\\fixture\\outside.node", "E:\\outside.node"]) {
      fixture.add(outside);
      assert.throws(() => fixture.load(outside), /external_or_linked_input|dependency_invalid/u);
      assert.throws(() => fixture.load(win32.toNamespacedPath(outside)), /external_or_linked_input|dependency_invalid/u);
    }
    assert.equal(fixture.calls.length, 0);
  });

  test(`${kind}: admitted spelling still enforces file size and read metadata`, () => {
    for (const failure of ["oversized", "changed"]) {
      const fixture = windowsFixture(kind), file = fixture.files.get(fixture.canonical);
      if (failure === "oversized") file.size = 128 * 1024 ** 2 + 1;
      else file.changeAfterRead = true;
      assert.throws(() => fixture.load(win32.toNamespacedPath(fixture.canonical)),
        failure === "oversized" ? /input_invalid|dependency_invalid/u : /input_changed|dependency_changed/u);
      assert.equal(fixture.calls.length, 0);
    }
  });

  test(`${kind}: real POSIX symlink is refused before calling the stub native loader`, { skip: process.platform === "win32" }, t => {
    const root = fs.realpathSync(fs.mkdtempSync(posix.join(tmpdir(), "ling-observer-path-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const canonical = posix.join(root, "binding.node"), link = posix.join(root, "linked.node");
    fs.writeFileSync(canonical, "actual filesystem bytes"); fs.symlinkSync(canonical, link);
    const fixture = hooks(kind, root, posix, fs, process.platform);
    assert.equal(fixture.load(canonical), fixture.nativeResult);
    assert.throws(() => fixture.load(link), /external_or_linked_input|dependency_invalid/u);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.finish().inputs[0].checksum, `sha256:${createHash("sha256").update("actual filesystem bytes").digest("hex")}`);
  });
}

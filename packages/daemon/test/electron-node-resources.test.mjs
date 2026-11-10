import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { digestElectronNodeResource, ELECTRON_NODE_RESOURCE_PATHS, verifyElectronNodeResources } from "../dist/runtime/sandbox/electron-node-resources.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-electron-resources-")));
  const contents = join(root, "Fixture.app", "Contents"), executable = join(contents, "MacOS", "Fixture");
  mkdirSync(join(contents, "MacOS"), { recursive: true, mode: 0o700 });
  writeFileSync(executable, "fixture-only", { mode: 0o700 });
  writeFileSync(join(contents, "Info.plist"), "fixture-info", { mode: 0o600 });
  for (const path of ELECTRON_NODE_RESOURCE_PATHS.slice(1)) {
    const framework = join(contents, path);
    mkdirSync(join(framework, "Versions", "A", "Resources"), { recursive: true, mode: 0o700 });
    writeFileSync(join(framework, "Versions", "A", "Runtime"), "fixture-runtime", { mode: 0o600 });
    symlinkSync("A", join(framework, "Versions", "Current"));
    symlinkSync("Versions/Current/Resources", join(framework, "Resources"));
  }
  const pin = { kind: "electron_node_v1", resources: ELECTRON_NODE_RESOURCE_PATHS.map(relativePath =>
    ({ relativePath, sha256: digestElectronNodeResource(join(contents, relativePath)) })) };
  return { root, contents, executable, pin, framework: join(contents, ELECTRON_NODE_RESOURCE_PATHS[1]) };
}

test("fixed Electron bundle roots verify with internal version aliases", () => {
  const f = fixture(), actual = verifyElectronNodeResources(f.executable, f.pin);
  assert.deepEqual(actual.readRoots, ELECTRON_NODE_RESOURCE_PATHS.map(path => join(f.contents, path)));
  assert.match(actual.resourceIdentitySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyElectronNodeResources(f.executable, { ...f.pin, resources: [...f.pin.resources].reverse() }), actual);
});
test("runtime resources must exactly cover the fixed closure, with no extra environment or roots", () => {
  const f = fixture();
  for (const pin of [
    { ...f.pin, resources: f.pin.resources.slice(1) },
    { ...f.pin, resources: [...f.pin.resources.slice(0, -1), f.pin.resources[0]] },
    { ...f.pin, resources: [...f.pin.resources.slice(0, -1), { relativePath: "../../private", sha256: "a".repeat(64) }] },
    { ...f.pin, environment: { NODE_OPTIONS: "not-allowed" } },
    { ...f.pin, resources: [{ ...f.pin.resources[0], ignored: true }, ...f.pin.resources.slice(1)] },
  ]) assert.throws(() => verifyElectronNodeResources(f.executable, pin), /electron_node_resource_invalid/);
});
test("same size modified content invalidates a pinned framework", () => {
  const f = fixture();
  writeFileSync(join(f.framework, "Versions", "A", "Runtime"), "modified-value!");
  assert.throws(() => verifyElectronNodeResources(f.executable, f.pin), /electron_node_resource_changed/);
});
test("adding a runtime resource invalidates the full directory digest", () => {
  const f = fixture();
  writeFileSync(join(f.framework, "extra.dylib"), "injected", { mode: 0o600 });
  assert.throws(() => verifyElectronNodeResources(f.executable, f.pin), /electron_node_resource_changed/);
});
test("external symlink targets and substituted resource roots are rejected", () => {
  const f = fixture();
  symlinkSync(f.root, join(f.framework, "escape"));
  assert.throws(() => verifyElectronNodeResources(f.executable, f.pin), /electron_node_resource_alias_escape/);
  unlinkSync(join(f.contents, "Info.plist"));
  writeFileSync(join(f.root, "outside-info"), "fixture-info", { mode: 0o600 });
  symlinkSync("../../outside-info", join(f.contents, "Info.plist"));
  assert.throws(() => verifyElectronNodeResources(f.executable, f.pin), /electron_node_resource_alias_escape/);
});
test("hardlinks and writable resource content cannot become trusted runtime inputs", () => {
  const f = fixture(), target = join(f.framework, "Versions", "A", "Runtime");
  linkSync(target, join(f.root, "alias"));
  assert.throws(() => verifyElectronNodeResources(f.executable, f.pin), /electron_node_resource_invalid/);
  unlinkSync(join(f.root, "alias"));
  chmodSync(target, 0o666);
  assert.throws(() => verifyElectronNodeResources(f.executable, f.pin), /electron_node_resource_invalid/);
});
test("non-bundle executables cannot request Electron resource discovery", () => {
  const f = fixture();
  assert.throws(() => verifyElectronNodeResources(join(f.root, "node"), f.pin), /electron_node_resource_invalid/);
});

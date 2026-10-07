import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ELECTRON_NODE_RESOURCE_PATHS } from "../dist/runtime/sandbox/electron-node-resources.js";
import { readPackagedRestrictedCommandConfig } from "../dist/runtime/sandbox/packaged-restricted-command-bootstrap.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";

function fixture() {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-packaged-command-"));
  const app = join(root, "Ling Test.app"), contents = join(app, "Contents");
  const executable = join(contents, "MacOS", "Ling Test");
  const resourceRoot = join(contents, "Resources", "restricted-command");
  mkdirSync(join(contents, "MacOS"), { recursive: true, mode: 0o700 });
  mkdirSync(resourceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(executable, "fixture-electron", { mode: 0o700 });
  writeFileSync(join(contents, "Info.plist"), "fixture-info", { mode: 0o600 });
  for (const path of ELECTRON_NODE_RESOURCE_PATHS.slice(1)) {
    const framework = join(contents, path);
    mkdirSync(join(framework, "Versions", "A", "Resources"), { recursive: true, mode: 0o700 });
    writeFileSync(join(framework, "Versions", "A", "Runtime"), "fixture-runtime", { mode: 0o600 });
    symlinkSync("A", join(framework, "Versions", "Current"));
    symlinkSync("Versions/Current/Resources", join(framework, "Resources"));
  }
  const helper = join(resourceRoot, "ling-sandbox-runner");
  writeFileSync(helper, "fixture-helper", { mode: 0o700 });
  const manifest = {
    schemaVersion: 1, helperName: "ling-sandbox-runner", helperVersion: "0.1.0",
    target: "aarch64-apple-darwin",
    binary: { filename: "ling-sandbox-runner", sha256: "build-evidence-not-runtime-authority", sizeBytes: 14 },
  };
  writeFileSync(join(resourceRoot, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { root, app, contents, executable, helper, manifest };
}
const environment = { LING_STACK_PACKAGED_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" };

test("ordinary CLI and development Desktop do not discover a privileged runtime", () => {
  assert.equal(readPackagedRestrictedCommandConfig({ environment: {}, executablePath: "/missing" }), undefined);
});
test("packaged bootstrap verifies the fixed App before deriving immutable command pins", () => {
  const f = fixture(), verified = [];
  const config = readPackagedRestrictedCommandConfig({
    environment, executablePath: f.executable, architecture: "arm64",
    verifyBundle: path => verified.push(path),
  });
  assert.deepEqual(verified, [f.app]);
  assert.equal(config.inputHelper.path, f.helper);
  assert.equal(config.inputHelper.version, "0.1.0");
  assert.match(config.inputHelper.sha256, /^[a-f0-9]{64}$/);
  assert.equal(config.executables.node.path, f.executable);
  assert.deepEqual(config.executables.node.runtime.resources.map(item => item.relativePath), ELECTRON_NODE_RESOURCE_PATHS);
  assert.deepEqual(new NativeRestrictedCommandRuntime(config).assertAvailable("node --version").argv,
    [f.executable, "--version"]);
});
test("packaged bootstrap fails closed when final bundle authority is rejected", () => {
  const f = fixture();
  assert.throws(() => readPackagedRestrictedCommandConfig({
    environment, executablePath: f.executable, architecture: "arm64",
    verifyBundle: () => { throw new Error("invalid signature"); },
  }), /invalid signature/);
});
test("manifest architecture, helper identity, and fixed layout cannot be substituted", () => {
  for (const mutate of [
    f => writeFileSync(join(f.contents, "Resources", "restricted-command", "manifest.json"),
      JSON.stringify({ ...f.manifest, target: "x86_64-apple-darwin" })),
    f => writeFileSync(f.helper, "wrong-size"),
    f => chmodSync(f.helper, 0o666),
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => readPackagedRestrictedCommandConfig({
      environment, executablePath: f.executable, architecture: "arm64", verifyBundle: () => {},
    }), /restricted_command_/);
  }
});
test("an unsupported architecture never inherits a nearby executable", () => {
  const f = fixture();
  assert.throws(() => readPackagedRestrictedCommandConfig({
    environment, executablePath: f.executable, architecture: "riscv64", verifyBundle: () => {},
  }), /restricted_command_packaged_architecture_invalid/);
});

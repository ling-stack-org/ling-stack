import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

export const BOOTSTRAP_SOURCE_GATE_CODE = "protected_host_actor_unbound_with_active_stage";
export const BOOTSTRAP_SECRET_REF = "keychain:LING_SOURCE_HOOKS_FIXTURE_ONLY";

/**
 * Source-placement observer only. It never reads a real keychain, verifies a
 * real signature, launches fixture bytes, or certifies a process/profile.
 * Install before dynamically importing the two original producer modules.
 */
export function observeBootstrapOriginalProcesses(t) {
  const originalSpawnSync = childProcess.spawnSync, calls = [];
  let securityHandler = successfulSecurityResult, codesignHandler = successfulCodesignResult;
  const securityPatch = t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    assert.equal(command, "/usr/bin/security", "no real keychain or other execFileSync is allowed");
    const call = { kind: "execFileSync", command, args: [...args], options };
    calls.push(call); return securityHandler(call);
  });
  const codesignPatch = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "/usr/bin/codesign", "no real codesign or other spawnSync is allowed");
    const call = { kind: "spawnSync", command, args: [...args], options };
    calls.push(call); return codesignHandler(call);
  });
  syncBuiltinESMExports();
  t.after(() => {
    securityPatch.mock.restore(); codesignPatch.mock.restore(); syncBuiltinESMExports();
  });
  return { calls,
    setSecurityHandler(handler = successfulSecurityResult) { securityHandler = handler; },
    setCodesignHandler(handler = successfulCodesignResult) { codesignHandler = handler; },
    runChildTest(file, name) {
      const env = { ...process.env, LING_BOOTSTRAP_SOURCE_HOOKS_CASE: name };
      // A new runner must not silently inherit its parent's child-v8 context.
      delete env.NODE_TEST_CONTEXT;
      return originalSpawnSync(process.execPath, ["--test", "--test-reporter=tap", file], {
        env, encoding: "utf8", timeout: 30000,
      });
    },
  };
}

/** Legacy dist binds no substitute entries and must fail real public zero-call assertions. */
export async function loadBootstrapSourceHarness() {
  const fixture = await import("./protected-host-source-hooks-fixture.mjs");
  const keychain = await fixture.loadSourceHookModule("features/providers/keychain-secret-store.js");
  const bootstrap = await fixture.loadSourceHookModule("runtime/sandbox/packaged-restricted-command-bootstrap.js");
  const resources = await fixture.loadSourceHookModule("runtime/sandbox/electron-node-resources.js");
  const inventory = await fixture.loadSourceHookModule("runtime/sandbox/protected-host-actor-inventory.js");
  const core = await import("@ling-stack/core");
  const entries = [keychain.KEYCHAIN_SECURITY_ACTOR_ENTRY, bootstrap.PACKAGED_CODESIGN_ACTOR_ENTRY]
    .filter(entry => entry !== undefined);
  return { ...fixture, keychain, bootstrap, resources, inventory, core, entries,
    bind(f) { f.registry.bindOriginalActorEntries(entries); } };
}

/**
 * Disposable fixed-layout bytes permit the public bootstrap to reach its
 * original codesign placement. They are not trusted signed resources.
 */
export function createBootstrapBundleFixture(t, resourcePaths) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-bootstrap-source-hooks-"));
  const app = join(root, "Source Hooks Fixture.app"), contents = join(app, "Contents");
  const executable = join(contents, "MacOS", "Source Hooks Fixture");
  const nativeResources = join(contents, "Resources", "restricted-command");
  mkdirSync(join(contents, "MacOS"), { recursive: true, mode: 0o700 });
  mkdirSync(nativeResources, { recursive: true, mode: 0o700 });
  writeFileSync(executable, "fixture-electron", { mode: 0o700 });
  writeFileSync(join(contents, "Info.plist"), "fixture-info", { mode: 0o600 });
  for (const relative of resourcePaths.slice(1)) {
    const resource = join(contents, relative);
    mkdirSync(resource, { recursive: true, mode: 0o700 });
    writeFileSync(join(resource, "Runtime"), "fixture-runtime", { mode: 0o600 });
  }
  const helper = join(nativeResources, "ling-sandbox-runner");
  writeFileSync(helper, "fixture-helper", { mode: 0o700 });
  writeFileSync(join(nativeResources, "manifest.json"), JSON.stringify({
    schemaVersion: 1, helperName: "ling-sandbox-runner", helperVersion: "0.1.0",
    target: "aarch64-apple-darwin", binary: { filename: "ling-sandbox-runner", sizeBytes: 14 },
  }), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { app, contents, executable, helper, dependencies: { executablePath: executable, architecture: "arm64",
    environment: { LING_STACK_PACKAGED_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" } } };
}

/** Observe the actual private source gate outcome; do not replace its authorization. */
export function recordBootstrapGateRefusals(t, registry) {
  const original = registry.assertActorEntryLaunchCurrent, errors = [];
  t.mock.method(registry, "assertActorEntryLaunchCurrent", function (...args) {
    try { return Reflect.apply(original, this, args); }
    catch (error) { errors.push(error); throw error; }
  });
  return errors;
}

export function successfulSecurityResult(call) {
  return call.args.includes("-w") && call.args[0] === "find-generic-password" ? "fixture-safe-secret\n" : Buffer.alloc(0);
}
function successfulCodesignResult() {
  return { status: 0, signal: null, error: undefined, stdout: "", stderr: "" };
}

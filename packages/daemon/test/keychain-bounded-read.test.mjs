import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scenarios = ["bounded-reads", "status-timeout", "value-timeout", "unchanged-defaults-and-writes"];

if (process.argv[2] === "--keychain-fixture") {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3], process.argv[4])));
} else {
  for (const target of ["src", "dist"]) {
    for (const scenario of scenarios) {
      test(`keychain ${target}: ${scenario}`, { timeout: 10_000 }, async () => {
        const { stdout } = await promisify(execFile)(process.execPath,
          [fileURLToPath(import.meta.url), "--keychain-fixture", target, scenario],
          { env: {}, timeout: 8000, maxBuffer: 64 * 1024 });
        const observation = JSON.parse(stdout);
        if (scenario === "bounded-reads") {
          assert.equal(observation.statusConfigured, true);
          assert.equal(observation.resolvedConfigured, true);
          assert.equal(observation.valueMatches, true);
          assert.deepEqual(observation.calls.map((call) => call.credentialRead), [false, false, true]);
          for (const call of observation.calls) {
            assert.equal(call.action, "find-generic-password");
            assert.equal(call.timeout, 1500);
            assert.equal(call.killSignal, "SIGKILL");
          }
        } else if (scenario === "unchanged-defaults-and-writes") {
          assert.deepEqual(observation.calls.map((call) => call.action), [
            "find-generic-password", "find-generic-password", "find-generic-password",
            "add-generic-password", "delete-generic-password", "add-generic-password", "delete-generic-password",
          ]);
          for (const call of observation.calls) {
            assert.equal(call.timeout, undefined);
            assert.equal(call.killSignal, undefined);
          }
        } else {
          assert.equal(observation.timeoutInjected, true, "the read must receive a bound before the transport can time out");
          assert.equal(observation.resolvedConfigured, false);
          assert.equal(observation.hasValue, false);
          assert.equal(observation.errorCode, scenario === "status-timeout" ? "secret_store_unavailable" : "secret_access_denied");
          assert.deepEqual(observation.calls.map((call) => call.credentialRead), scenario === "status-timeout" ? [false] : [false, true]);
        }
      });
    }
  }
}

async function runFixture(target, scenario) {
  assert.ok(["src", "dist"].includes(target));
  assert.ok(scenarios.includes(scenario));
  const extension = target === "src" ? "ts" : "js";
  const storeUrl = new URL(`../${target}/features/providers/keychain-secret-store.${extension}`, import.meta.url).href;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];
  let timeoutInjected = false;
  globalThis.__lingKeychainReadFixture = (file, args, options) => {
    assert.equal(file, "/usr/bin/security");
    assert.ok(args.includes("-s"));
    assert.equal(args[args.indexOf("-s") + 1], "ling-stack");
    const credentialRead = args[0] === "find-generic-password" && args.includes("-w");
    calls.push({ action: args[0], credentialRead, timeout: options.timeout, killSignal: options.killSignal });
    if (options.timeout === 1500 && (scenario === "status-timeout" || scenario === "value-timeout" && credentialRead)) {
      timeoutInjected = true;
      throw Object.assign(new Error("fixture keychain read timed out"), { code: "ETIMEDOUT", signal: "SIGKILL" });
    }
    return credentialRead ? "fixture-keychain-value\n" : "";
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === storeUrl && specifier === "node:child_process") return {
        url: `data:text/javascript,${encodeURIComponent("export const execFileSync = globalThis.__lingKeychainReadFixture;")}`, shortCircuit: true,
      };
      if (target === "src" && context.parentURL === storeUrl
        && specifier === "../../runtime/sandbox/protected-host-actor-inventory.js") return {
        url: `data:text/javascript,${encodeURIComponent(`
          export function defineProtectedHostActorEntry(entryId, producer, consume) {
            return Object.freeze({ entryId, assertMayInvoke() {}, invoke(_actor, ...args) {
              consume?.(...args);
              return producer(...args);
            } });
          }
          export function isProtectedHostActorEntryLaunchRefusal() { return false; }
        `)}`,
        shortCircuit: true,
      };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (target === "src" && url === storeUrl) return { format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
      return next(url, context);
    },
  });
  try {
    // Worker-only platform override exercises the macOS reader without ever invoking Keychain, including on Windows.
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const { createSystemKeychainSecretStore } = await import(storeUrl);
    const ref = "keychain:LING_BOUNDED_READ_FIXTURE";
    const bounded = createSystemKeychainSecretStore({ readTimeoutMs: 1500 });
    if (scenario === "unchanged-defaults-and-writes") {
      const shared = createSystemKeychainSecretStore();
      assert.equal(shared.status(ref).configured, true);
      assert.equal(shared.resolve(ref).configured, true);
      assert.equal(shared.setSecret(ref, "fixture-write-value").configured, true);
      assert.equal(shared.deleteSecret(ref).configured, false);
      assert.equal(bounded.setSecret(ref, "fixture-write-value").configured, true);
      assert.equal(bounded.deleteSecret(ref).configured, false);
      return { calls };
    }
    const status = scenario === "bounded-reads" ? bounded.status(ref) : undefined;
    const resolved = bounded.resolve(ref);
    return { calls, timeoutInjected, statusConfigured: status?.configured, resolvedConfigured: resolved.configured,
      hasValue: resolved.value !== undefined, valueMatches: resolved.value === "fixture-keychain-value", errorCode: resolved.status?.errorCode };
  } finally {
    Object.defineProperty(process, "platform", platform);
    hooks.deregister();
    delete globalThis.__lingKeychainReadFixture;
  }
}

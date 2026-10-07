import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSourceHookFixture } from "./support/protected-host-source-hooks-fixture.mjs";
import { createCodesignHostSimulation, SIMULATED_APP, SIMULATED_CODESIGN, SIMULATED_HELPER }
  from "./support/packaged-codesign-host-simulation-fixture.mjs";
import {
  BOOTSTRAP_SECRET_REF, BOOTSTRAP_SOURCE_GATE_CODE, createBootstrapBundleFixture,
  loadBootstrapSourceHarness, observeBootstrapOriginalProcesses,
  recordBootstrapGateRefusals, successfulSecurityResult,
} from "./support/bootstrap-original-source-hooks-fixture.mjs";

const childCase = process.env.LING_BOOTSTRAP_SOURCE_HOOKS_CASE;
const nativeOnly = { skip: process.platform !== "darwin" };

if (childCase) {
  test("isolated original bootstrap pre-binding history: " + childCase, nativeOnly, async t => {
    const observed = observeBootstrapOriginalProcesses(t), harness = await loadBootstrapSourceHarness();
    const keychain = harness.keychain.createSystemKeychainSecretStore();
    const bundle = createBootstrapBundleFixture(t, harness.resources.ELECTRON_NODE_RESOURCE_PATHS);
    const source = childCase === "keychain"
      ? () => keychain.resolve(BOOTSTRAP_SECRET_REF)
      : () => harness.bootstrap.readPackagedRestrictedCommandConfig(bundle.dependencies);
    // The real public default source executes before a registry is created or
    // attached. Native OS calls are observed, never allowed to reach the OS.
    const first = source(); assert.ok(first);
    assert.equal(observed.calls.length, childCase === "keychain" ? 2 : 1);
    const f = await harness.createSourceHookFixture(t); harness.bind(f);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    source();
    assert.equal(observed.calls.length, childCase === "keychain" ? 4 : 2);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    t.diagnostic("Observed bootstrap placement is sticky history, not trusted bootstrap identity or isolation evidence.");
  });
} else {
  test("original keychain and codesign source boundaries without bootstrap-label exemptions", nativeOnly, async t => {
    const observed = observeBootstrapOriginalProcesses(t), harness = await loadBootstrapSourceHarness();
    const keychain = harness.keychain.createSystemKeychainSecretStore();
    let originalKeychainRefusal;

    for (const operation of ["status", "resolve", "setSecret", "deleteSecret"]) {
      await t.test("public default keychain " + operation + " refuses before its producer and does not convert the gate error", async t => {
        const f = await harness.createSourceHookFixture(t), stage = f.register(); harness.bind(f);
        const errors = recordBootstrapGateRefusals(t, f.registry), before = observed.calls.length;
        let refusal;
        try { keychain[operation](BOOTSTRAP_SECRET_REF, "fixture-write-only-value"); }
        catch (error) { refusal = error; }
        assert.equal(observed.calls.length, before, "the original /usr/bin/security producer never entered");
        assert.ok(refusal); assert.equal(refusal.message, BOOTSTRAP_SOURCE_GATE_CODE);
        assert.equal(refusal, errors[0], "an original refusal is not secret_missing/unavailable/access_denied");
        originalKeychainRefusal = refusal;
        f.registry.closeStage(stage);
        const resumed = f.register(); f.registry.closeStage(resumed);
        assert.equal(observed.calls.length, before, "genuine zero-start refusal leaves stage admission usable");
      });
    }

    await t.test("public packaged default reaches the original codesign gate before spawnSync", async t => {
      const f = await harness.createSourceHookFixture(t), stage = f.register(); harness.bind(f);
      const bundle = createBootstrapBundleFixture(t, harness.resources.ELECTRON_NODE_RESOURCE_PATHS);
      const errors = recordBootstrapGateRefusals(t, f.registry), before = observed.calls.length;
      let refusal;
      try { harness.bootstrap.readPackagedRestrictedCommandConfig(bundle.dependencies); }
      catch (error) { refusal = error; }
      assert.equal(observed.calls.length, before, "the original /usr/bin/codesign producer never entered");
      assert.ok(refusal); assert.equal(refusal.message, BOOTSTRAP_SOURCE_GATE_CODE);
      assert.equal(refusal, errors[0]);
      f.registry.closeStage(stage);
      const resumed = f.register(); f.registry.closeStage(resumed);
    });

    for (const activeIndex of [0, 1]) {
      await t.test("registry " + activeIndex + " blocks both real sources without poisoning the earlier inactive registry", async t => {
        const fixtures = [await harness.createSourceHookFixture(t), await harness.createSourceHookFixture(t)];
        const stage = fixtures[activeIndex].register();
        for (const f of fixtures) harness.bind(f);
        const before = observed.calls.length, bundle = createBootstrapBundleFixture(t, harness.resources.ELECTRON_NODE_RESOURCE_PATHS);
        assert.throws(() => keychain.status(BOOTSTRAP_SECRET_REF), error => error.message === BOOTSTRAP_SOURCE_GATE_CODE);
        assert.throws(() => harness.bootstrap.readPackagedRestrictedCommandConfig(bundle.dependencies),
          error => error.message === BOOTSTRAP_SOURCE_GATE_CODE);
        assert.equal(observed.calls.length, before);
        fixtures[activeIndex].registry.closeStage(stage);
        for (const f of fixtures) { const resumed = f.register(); f.registry.closeStage(resumed); }
        assert.equal(observed.calls.length, before);
      });
    }

    await t.test("invalid/non-keychain refs and development bootstrap never create native history", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f); const before = observed.calls.length;
      assert.equal(keychain.status("not-a-ref").errorCode, "invalid_secret_ref");
      assert.equal(keychain.status("env:FIXTURE").errorCode, "invalid_secret_ref");
      assert.equal(keychain.resolve("env:FIXTURE").status.errorCode, "invalid_secret_ref");
      assert.equal(keychain.setSecret("env:FIXTURE", "fixture-value").errorCode, "invalid_secret_ref");
      assert.equal(keychain.deleteSecret("env:FIXTURE").errorCode, "invalid_secret_ref");
      assert.throws(() => keychain.setSecret("not-a-ref", "fixture-value"));
      assert.throws(() => keychain.deleteSecret("not-a-ref"));
      assert.equal(harness.bootstrap.readPackagedRestrictedCommandConfig({ environment: {}, executablePath: "/missing" }), undefined);
      assert.equal(observed.calls.length, before);
      const stage = f.register(); f.registry.closeStage(stage);
    });

    await t.test("exact source entries are controlled and immutable; caller records cannot fabricate original launch authority", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f); const before = observed.calls.length;
      for (const [entry, entryId] of [[harness.keychain.KEYCHAIN_SECURITY_ACTOR_ENTRY, "keychain_security"],
        [harness.bootstrap.PACKAGED_CODESIGN_ACTOR_ENTRY, "packaged_codesign"]]) {
        assert.ok(entry, "the public default producer exports its exact source-owned wrapper");
        assert.deepEqual(harness.inventory.readProtectedHostActorEntry(entry), { entryId, kind: "controlled" });
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.hasOwn(entry, "capture"), false); assert.equal(Object.hasOwn(entry, "producer"), false);
        assert.throws(() => harness.inventory.readProtectedHostActorEntry({ ...entry }), /protected_host_actor_entry_invalid/u);
        for (const record of [{}, Object.freeze({ command: "/usr/bin/security", argv: [], producerEntered: true })]) {
          assert.throws(() => entry.invoke(undefined, record));
        }
      }
      assert.equal(observed.calls.length, before);
      const stage = f.register(); f.registry.closeStage(stage);
      assert.throws(() => f.registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
      const manifest = await harness.loadSourceHookModule("runtime/sandbox/protected-host-original-entry-manifest.js");
      const originalEntries = manifest.readOriginalProtectedHostActorEntries();
      assert.equal(originalEntries.length, 20, "the fixed source list is complete, not this two-entry fixture inventory");
      assert.ok(originalEntries.includes(harness.keychain.KEYCHAIN_SECURITY_ACTOR_ENTRY));
      assert.ok(originalEntries.includes(harness.bootstrap.PACKAGED_CODESIGN_ACTOR_ENTRY));
    });

    await t.test("the Daemon's custom composite resolver path keeps custom semantics and does not enter default keychain", async t => {
      const f = await harness.createSourceHookFixture(t), stage = f.register(); harness.bind(f);
      const before = observed.calls.length, calls = [];
      const custom = {
        status(ref, purpose) { calls.push(["status", ref, purpose]); return { ref, kind: "keychain", configured: true }; },
        resolve(ref, purpose) { calls.push(["resolve", ref, purpose]); return { ref, configured: true, value: "custom-fixture-value" }; },
      };
      const resolver = harness.core.createCompositeSecretResolver({ keychainResolver: custom, env: {} });
      assert.equal(resolver.status(BOOTSTRAP_SECRET_REF, "github_token").configured, true);
      assert.equal(resolver.resolve(BOOTSTRAP_SECRET_REF, "github_token").value, "custom-fixture-value");
      assert.deepEqual(calls, [["status", BOOTSTRAP_SECRET_REF, "github_token"], ["resolve", BOOTSTRAP_SECRET_REF, "github_token"]]);
      assert.equal(observed.calls.length, before, "a custom resolver is not evidence about the default /usr/bin/security source");
      f.registry.closeStage(stage); const resumed = f.register(); f.registry.closeStage(resumed);
      assert.throws(() => f.registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
    });

    await t.test("public custom bundle verification preserves result/error semantics without borrowing default codesign proof", async t => {
      const f = await harness.createSourceHookFixture(t), stage = f.register(); harness.bind(f);
      const bundle = createBootstrapBundleFixture(t, harness.resources.ELECTRON_NODE_RESOURCE_PATHS), before = observed.calls.length;
      const verified = [], customFailure = new Error(BOOTSTRAP_SOURCE_GATE_CODE);
      const config = harness.bootstrap.readPackagedRestrictedCommandConfig({ ...bundle.dependencies,
        verifyBundle(path) { verified.push(path); } });
      assert.deepEqual(verified, [bundle.app]); assert.equal(config.inputHelper.path, bundle.helper);
      assert.throws(() => harness.bootstrap.readPackagedRestrictedCommandConfig({ ...bundle.dependencies,
        verifyBundle() { throw customFailure; } }), error => error === customFailure);
      assert.equal(observed.calls.length, before);
      f.registry.closeStage(stage); const resumed = f.register(); f.registry.closeStage(resumed);
      assert.throws(() => f.registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
    });

    for (const name of ["keychain", "codesign"]) {
      await t.test("public " + name + " before late binding leaves sticky unknown despite later success", () => {
        const result = observed.runChildTest(fileURLToPath(import.meta.url), name);
        assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /isolated original bootstrap pre-binding history/u);
        for (const statistic of ["tests 1", "pass 1", "fail 0", "cancelled 0", "skipped 0", "todo 0"]) {
          assert.match(result.stdout, new RegExp("^# " + statistic + "$", "m"), "child runner actually executed " + statistic);
        }
      });
    }

    // All active-stage cases above run before any default source enters native.
    // Every observed no-stage launch below irreversibly closes later admission.
    await t.test("no-stage keychain operations preserve their exact fixed argv, encoding, and status semantics", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f); const before = observed.calls.length;
      assert.equal(keychain.status(BOOTSTRAP_SECRET_REF).configured, true);
      const resolved = keychain.resolve(BOOTSTRAP_SECRET_REF);
      assert.equal(resolved.configured, true); assert.equal(resolved.value, "fixture-safe-secret");
      assert.equal(keychain.setSecret(BOOTSTRAP_SECRET_REF, "fixture-write-only-value").configured, true);
      assert.equal(keychain.deleteSecret(BOOTSTRAP_SECRET_REF).errorCode, "secret_missing");
      const calls = observed.calls.slice(before), account = "LING_SOURCE_HOOKS_FIXTURE_ONLY";
      assert.equal(calls.length, 5);
      assert.equal(calls.every(call => call.kind === "execFileSync" && call.command === "/usr/bin/security"), true);
      assert.deepEqual(calls.map(call => call.args), [
        ["find-generic-password", "-s", "ling-stack", "-a", account],
        ["find-generic-password", "-s", "ling-stack", "-a", account],
        ["find-generic-password", "-s", "ling-stack", "-a", account, "-w"],
        ["add-generic-password", "-U", "-s", "ling-stack", "-a", account, "-w", "fixture-write-only-value"],
        ["delete-generic-password", "-s", "ling-stack", "-a", account],
      ]);
      assert.deepEqual(calls[2].options, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      for (const index of [0, 1, 3, 4]) assert.deepEqual(calls[index].options, { stdio: ["ignore", "ignore", "pipe"] });
      assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    });

    for (const [name, operation, missing, expected] of [
      ["missing status", "status", true, "secret_missing"],
      ["ordinary status OS error", "status", false, "secret_store_unavailable"],
      ["ordinary resolve value error", "resolve", false, "secret_access_denied"],
      ["ordinary set OS error", "setSecret", false, "secret_access_denied"],
      ["ordinary delete OS error", "deleteSecret", false, "secret_access_denied"],
      ["missing delete is idempotent", "deleteSecret", true, "secret_missing"],
    ]) {
      await t.test(name + " is not a branded no-start refusal even when error text/code resembles the gate", async t => {
        const f = await harness.createSourceHookFixture(t); harness.bind(f);
        const ordinary = Object.assign(new Error(BOOTSTRAP_SOURCE_GATE_CODE), {
          code: BOOTSTRAP_SOURCE_GATE_CODE,
          stderr: missing ? Buffer.from("The specified item could not be found in the keychain.") : BOOTSTRAP_SOURCE_GATE_CODE,
        });
        const before = observed.calls.length;
        observed.setSecurityHandler(call => {
          if (operation === "resolve" && !call.args.includes("-w")) return successfulSecurityResult(call);
          throw ordinary;
        });
        try {
          const result = keychain[operation](BOOTSTRAP_SECRET_REF, "fixture-write-only-value");
          assert.equal(operation === "resolve" ? result.status.errorCode : result.errorCode, expected);
          assert.equal(result.configured, false);
          assert.equal(observed.calls.length - before, operation === "resolve" ? 2 : 1);
          assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
        } finally { observed.setSecurityHandler(); }
      });
    }

    await t.test("a previous genuine keychain refusal reused by the original native producer cannot remain a no-start error", async t => {
      assert.ok(originalKeychainRefusal);
      const f = await harness.createSourceHookFixture(t); harness.bind(f); const before = observed.calls.length;
      observed.setSecurityHandler(() => { throw originalKeychainRefusal; });
      try {
        const result = keychain.status(BOOTSTRAP_SECRET_REF);
        assert.equal(result.errorCode, "secret_store_unavailable"); assert.equal(result.configured, false);
        assert.equal(observed.calls.length, before + 1);
        assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
      } finally { observed.setSecurityHandler(); }
    });

    await t.test("resolve value-stage refusal passes its second catch unchanged after a first observed status read", async t => {
      const f = await harness.createSourceHookFixture(t), errors = recordBootstrapGateRefusals(t, f.registry);
      const before = observed.calls.length; let stage;
      // This is intentional late attachment, not front-door protection proof.
      observed.setSecurityHandler(call => {
        assert.equal(call.args.includes("-w"), false);
        stage = f.register(); harness.bind(f);
        return successfulSecurityResult(call);
      });
      try {
        let refusal;
        try { keychain.resolve(BOOTSTRAP_SECRET_REF); } catch (error) { refusal = error; }
        assert.equal(observed.calls.length, before + 1, "the value read is refused before its original producer");
        assert.ok(stage); assert.equal(refusal, errors[0]); assert.equal(refusal.message, BOOTSTRAP_SOURCE_GATE_CODE);
        f.registry.closeStage(stage);
        assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
      } finally { observed.setSecurityHandler(); }
      t.diagnostic("The first native status read is intentionally entered before attachment; only second-catch placement is verified.");
    });

    await t.test("no-stage packaged default preserves codesign argv/options and closes later staging", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f);
      const bundle = createBootstrapBundleFixture(t, harness.resources.ELECTRON_NODE_RESOURCE_PATHS), before = observed.calls.length;
      const config = harness.bootstrap.readPackagedRestrictedCommandConfig(bundle.dependencies);
      assert.equal(config.inputHelper.path, bundle.helper); assert.equal(config.executables.node.path, bundle.executable);
      assert.deepEqual(observed.calls.slice(before), [{ kind: "spawnSync", command: "/usr/bin/codesign",
        args: ["--verify", "--deep", "--strict", bundle.app], options: { encoding: "utf8", timeout: 30000, windowsHide: true } }]);
      assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    });

    for (const [name, result] of [
      ["nonzero status", { status: 1, signal: null }],
      ["terminated process", { status: null, signal: "SIGTERM" }],
      ["ordinary OS error", { status: null, signal: null, error: Object.assign(new Error(BOOTSTRAP_SOURCE_GATE_CODE), { code: BOOTSTRAP_SOURCE_GATE_CODE }) }],
    ]) {
      await t.test("default codesign " + name + " retains original bundle-identity failure, not bootstrap exemption", async t => {
        const f = await harness.createSourceHookFixture(t); harness.bind(f);
        const bundle = createBootstrapBundleFixture(t, harness.resources.ELECTRON_NODE_RESOURCE_PATHS), before = observed.calls.length;
        observed.setCodesignHandler(() => result);
        try {
          assert.throws(() => harness.bootstrap.readPackagedRestrictedCommandConfig(bundle.dependencies),
            /restricted_command_bundle_identity_invalid/u);
          assert.equal(observed.calls.length, before + 1);
          assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
        } finally { observed.setCodesignHandler(); }
      });
    }
    t.diagnostic("All native security/codesign calls were observers; dummy secrets and App resources do not prove keychain access, valid signatures, certified profiles, or descendant closure.");
  });

  // Independent of the original global bootstrap observer above. Real temporary
  // SQLite/registry fixtures are created before virtual FS hooks, and enrollment
  // happens only after the awaited child restores its hooks. Native calls remain
  // simulated; a platform skip is not a passing macOS containment observation.
  test("native original codesign entry keeps pre-binding history unknown after identity cleanup", nativeOnly, async t => {
    for (const outcome of ["success", "typed_error", "identity_loss", "raw"]) {
      await t.test(outcome + " cannot be retired by late registry enrollment", async t => {
        const fixture = await createSourceHookFixture(t);
        let savedEntry;
        await t.test("query-isolated original entry and virtual native call", async child => {
          const f = await createCodesignHostSimulation(child), api = await f.loadSource();
          savedEntry = api.readOriginalPackagedCodesignActorEntry();
          assert.equal(savedEntry.entryId, "packaged_codesign");
          if (outcome === "raw") {
            const record = api.createUnverifiedPackagedCodesignInvocation(["--verify", "--deep", "--strict", SIMULATED_APP]);
            f.hooks.native = call => {
              assert.equal(call.command, SIMULATED_CODESIGN);
              assert.deepEqual(call.args, ["--verify", "--deep", "--strict", SIMULATED_APP]);
              return { pid: 987654, status: 0, signal: null, stdout: "", stderr: "", output: [null, "", ""] };
            };
            assert.equal(savedEntry.invoke(undefined, record).status, 0);
            assert.throws(() => savedEntry.invoke(undefined, record), /record_invalid/u);
            assert.deepEqual(f.originalFiles(), []);
          } else {
            const owned = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(owned);
            f.hooks.native = call => {
              assert.equal(call.command, SIMULATED_HELPER);
              if (outcome === "typed_error") {
                const body = Buffer.from(JSON.stringify({ type: "error", protocolVersion: 1,
                  code: "codesign_cleanup_unknown", enforcementReady: false }));
                const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
                const stdout = Buffer.concat([header, body]), stderr = Buffer.alloc(0);
                return { pid: 987654, status: 2, signal: null, stdout, stderr, output: [null, stdout, stderr] };
              }
              const result = f.completed(call);
              if (outcome === "identity_loss") f.helper.bytes = Buffer.from("changed-helper-same-size---");
              return result;
            };
            try {
              if (outcome === "identity_loss") assert.throws(() => savedEntry.invoke(undefined, record), /original_file_changed/u);
              else {
                const result = savedEntry.invoke(undefined, record);
                assert.equal(result.status, outcome === "success" ? 0 : 2);
                if (outcome === "typed_error") assert.equal(result.error.code, "codesign_cleanup_unknown");
              }
              const observation = api.readOriginalPackagedCodesignExecutionObservation(owned);
              assert.equal(observation.protection, "candidate_unverified"); assert.equal(observation.descendantDrain, "not_verified");
              assert.throws(() => savedEntry.invoke(undefined, record), /record_invalid/u);
            } finally {
              api.closeOriginalPackagedCodesignIdentity(owned); assert.deepEqual(f.originalFiles(), []);
            }
          }
          assert.equal(f.nativeCalls.length, 1, "only the exact original producer entered, without replay");
        });
        assert.ok(savedEntry, "retain the exact original entry, not a new synthetic entry or copied facts");
        fixture.registry.bindOriginalActorEntries([savedEntry]);
        assert.throws(() => fixture.register(), /protected_host_actor_coverage_unknown/u);
        assert.throws(() => fixture.register(), /protected_host_actor_coverage_unknown/u,
          "successful cleanup or a second admission attempt cannot clear unknown process history");
      });
    }
    t.diagnostic("The real disposable SQLite/registry checks only sticky source history. All codesign/helper/Host observations remain virtual; no source certificate, trusted App, kernel denial, signal delivery or descendant drain is proved.");
  });
}

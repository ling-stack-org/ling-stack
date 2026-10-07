import assert from "node:assert/strict";
import childProcess from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSourceHookFixture, loadSourceHookModule } from "./support/protected-host-source-hooks-fixture.mjs";
import { observeGitSourceProcesses } from "./support/protected-host-git-source-hooks-fixture.mjs";

const nativeOnly = { skip: process.platform !== "darwin" };
const gateCode = "protected_host_actor_unbound_with_active_stage";
const childCase = process.env.LING_DOCKER_ORIGINAL_HOOKS_CASE;
// Capture only the isolated Node test launcher before the physical-source
// observer replaces execFileSync. No Docker command ever reaches a real process.
const runIsolatedNode = childProcess.execFileSync;

function enabledInput(workspaceRoot, config = {}) {
  return { workspaceRoot, config: { enabled: true, image: "ling-sandbox:test", ...config } };
}

function diagnosticCodes(check) {
  return check.diagnostics.map(diagnostic => diagnostic.code);
}

/** Record the original gate's result; never substitute permission or manufacture a refusal. */
function observeRegistryGate(t, registry) {
  const original = registry.assertActorEntryLaunchCurrent, calls = [], errors = [];
  t.mock.method(registry, "assertActorEntryLaunchCurrent", function (...args) {
    calls.push(args);
    try { return Reflect.apply(original, this, args); }
    catch (error) { errors.push(error); throw error; }
  });
  return { calls, errors };
}

if (childCase === "late-attach") {
  test("isolated original Docker default source retains pre-binding history", nativeOnly, async t => {
    const observed = observeGitSourceProcesses(t);
    observed.setAsyncHandler(() => "observed-only\n");
    // Import after the execFile/promisify observer, before any Registry is bound.
    const docker = await loadSourceHookModule("runtime/sandbox/docker.js");
    const first = await docker.checkDockerSandboxBackend(enabledInput("/observed-only/docker-prebinding"));
    assert.equal(first.ok, true);
    assert.equal(observed.calls.length, 2);
    assert.equal(observed.calls.every(call => call.kind === "execFile" && call.command === "docker"), true);
    const f = await createSourceHookFixture(t);
    f.registry.bindOriginalActorEntries([docker.DOCKER_PROBE_ACTOR_ENTRY]);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    const later = await docker.checkDockerSandboxBackend(enabledInput(f.cwd));
    assert.equal(later.ok, true);
    assert.equal(observed.calls.length, 4);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    assert.throws(() => f.registry.assertActorInventoryCurrent(), /protected_host_actor_inventory_incomplete/u);
  });
} else {
  // The production source captures promisify(execFile) at import time. This
  // observer preserves that contract but never executes Docker. It proves
  // original call placement, not native isolation, descendants or a safe manifest.
  test("the original Docker default probe gates physical launch and preserves catch boundaries", async t => {
    const observed = observeGitSourceProcesses(t);
    const docker = await loadSourceHookModule("runtime/sandbox/docker.js");
    const inventory = await loadSourceHookModule("runtime/sandbox/protected-host-actor-inventory.js");
    const entry = docker.DOCKER_PROBE_ACTOR_ENTRY;
    const isRefusal = error => inventory.isProtectedHostActorEntryLaunchRefusal(entry, error);
    let genuineRefusal;

    await t.test("the source export is immutable and clones are not original controlled entries", () => {
      assert.deepEqual(inventory.readProtectedHostActorEntry(entry), { entryId: "docker_probe", kind: "controlled" });
      assert.equal(Object.isFrozen(entry), true);
      for (const clone of [{ ...entry }, Object.create(entry), new Proxy(entry, {})]) {
        assert.throws(() => inventory.readProtectedHostActorEntry(clone), /protected_host_actor_entry_invalid/u);
      }
      assert.throws(() => { entry.invoke = () => undefined; }, TypeError);
      assert.throws(() => { entry.assertMayInvoke = () => undefined; }, TypeError);
      for (const key of ["capture", "producer", "registry", "launches"]) assert.equal(Object.hasOwn(entry, key), false);
      assert.equal(docker.runDockerCommand, undefined);
      assert.equal(observed.calls.length, 0);
    });

    // Complete every zero-producer case before a no-stage original call creates
    // permanent history. No fake inventory or source record is installed here.
    await t.test("cloned enrollment and forged records are refused without sticky coverage pollution", nativeOnly, async t => {
      const f = await createSourceHookFixture(t);
      assert.throws(() => f.registry.bindOriginalActorEntries([{ ...entry }]), /protected_host_actor_entry_invalid/u);
      f.registry.bindOriginalActorEntries([entry]);
      let propertyReads = 0;
      const accessor = Object.defineProperty({}, "file", { get() { propertyReads++; throw new Error("forged_record_read"); } });
      const pretend = { file: "docker", args: ["info"], consumed: true, producerEntered: true, policyVerified: true };
      for (const record of [undefined, null, {}, Object.freeze({}), pretend, { ...pretend },
        new Proxy(pretend, {}), Object.create(null), accessor]) {
        assert.throws(() => entry.invoke(undefined, record), error => {
          assert.equal(error.message, "docker_probe_record_invalid");
          assert.equal(isRefusal(error), false);
          return true;
        });
      }
      assert.equal(propertyReads, 0);
      assert.equal(observed.calls.length, 0);
      const stage = f.register(); f.registry.closeStage(stage);
      assert.throws(() => f.registry.assertActorInventoryCurrent(), /protected_host_actor_inventory_incomplete/u);
    });

    await t.test("public default readiness preserves the exact active-stage refusal before its producer", nativeOnly, async t => {
      const f = await createSourceHookFixture(t), stage = f.register();
      f.registry.bindOriginalActorEntries([entry]);
      const gate = observeRegistryGate(t, f.registry);
      await assert.rejects(docker.checkDockerSandboxBackend(enabledInput(f.cwd)), error => {
        assert.equal(error, gate.errors[0]);
        assert.equal(error.message, gateCode);
        assert.equal(isRefusal(error), true);
        genuineRefusal = error;
        return true;
      });
      assert.equal(gate.calls.length, 1);
      assert.deepEqual(gate.calls[0], [entry, undefined, false]);
      assert.equal(observed.calls.length, 0);
      f.registry.closeStage(stage);
      const resumed = f.register(); f.registry.closeStage(resumed);
    });

    for (const activeIndex of [0, 1]) {
      await t.test("Registry order " + activeIndex + " refuses before any partial history commit", nativeOnly, async t => {
        const fixtures = [await createSourceHookFixture(t), await createSourceHookFixture(t)];
        const stage = fixtures[activeIndex].register();
        for (const f of fixtures) f.registry.bindOriginalActorEntries([entry]);
        const gates = fixtures.map(f => observeRegistryGate(t, f.registry));
        await assert.rejects(docker.checkDockerSandboxBackend(enabledInput(fixtures[1 - activeIndex].cwd)), error => {
          assert.equal(error, gates[activeIndex].errors[0]);
          assert.equal(error.message, gateCode);
          assert.equal(isRefusal(error), true);
          return true;
        });
        assert.deepEqual(gates.map(gate => gate.calls.length), activeIndex === 0 ? [1, 0] : [1, 1]);
        for (const gate of gates) for (const call of gate.calls) assert.deepEqual(call, [entry, undefined, false]);
        assert.equal(observed.calls.length, 0);
        fixtures[activeIndex].registry.closeStage(stage);
        for (const f of fixtures) { const resumed = f.register(); f.registry.closeStage(resumed); }
      });
    }

    await t.test("disabled, image-missing and custom checks do not enter the default native source", nativeOnly, async t => {
      const f = await createSourceHookFixture(t), stage = f.register();
      f.registry.bindOriginalActorEntries([entry]);
      const disabled = await docker.checkDockerSandboxBackend(enabledInput(f.cwd, { enabled: false }));
      assert.equal(disabled.ok, false); assert.deepEqual(diagnosticCodes(disabled), ["docker_disabled"]);
      const missing = await docker.checkDockerSandboxBackend(enabledInput(f.cwd, { image: undefined }));
      assert.equal(missing.ok, false); assert.deepEqual(diagnosticCodes(missing), ["docker_image_missing"]);
      const injected = [];
      const custom = await docker.checkDockerSandboxBackend(enabledInput(f.cwd), async (file, args) => {
        injected.push({ file, args: [...args] });
        return { stdout: "custom-only\n", stderr: "" };
      });
      assert.equal(custom.ok, true);
      assert.deepEqual(injected, [
        { file: "docker", args: ["info", "--format", "{{json .ServerVersion}}"] },
        { file: "docker", args: ["image", "inspect", "ling-sandbox:test", "--format", "{{.Id}}"] },
      ]);
      assert.equal(observed.calls.length, 0);
      assert.throws(() => f.registry.assertActorInventoryCurrent(), /protected_host_actor_inventory_incomplete/u);
      f.registry.closeStage(stage);
      const resumed = f.register(); f.registry.closeStage(resumed);
    });

    await t.test("custom injection cannot borrow the default source's still-branded refusal", nativeOnly, async t => {
      const f = await createSourceHookFixture(t), stage = f.register();
      f.registry.bindOriginalActorEntries([entry]);
      assert.ok(genuineRefusal); assert.equal(isRefusal(genuineRefusal), true);
      let injectedCalls = 0;
      const check = await docker.checkDockerSandboxBackend(enabledInput(f.cwd), async () => {
        injectedCalls++; throw genuineRefusal;
      });
      assert.equal(check.ok, false);
      assert.deepEqual(diagnosticCodes(check), ["docker_daemon_unreachable"]);
      assert.equal(injectedCalls, 1); assert.equal(observed.calls.length, 0);
      assert.equal(isRefusal(genuineRefusal), true, "an injected failure neither enters nor retires the original source");
      f.registry.closeStage(stage);
      const resumed = f.register(); f.registry.closeStage(resumed);
    });

    // Every original producer below is observed only. Completion, ordinary
    // failure and old refusal reuse cannot retire the resulting unknown history.
    await t.test("stage-free public default probes preserve argv and native options with sticky history", nativeOnly, async t => {
      const f = await createSourceHookFixture(t), before = observed.calls.length;
      f.registry.bindOriginalActorEntries([entry]);
      observed.setAsyncHandler(() => "observed-only\n");
      try {
        const check = await docker.checkDockerSandboxBackend(enabledInput(f.cwd, {
          dockerBinary: " /observed-only/docker ", image: " ling-sandbox:test ",
        }));
        assert.equal(check.ok, true); assert.deepEqual(check.diagnostics, []);
        assert.equal(check.dockerBinary, "/observed-only/docker"); assert.equal(check.image, "ling-sandbox:test");
        const calls = observed.calls.slice(before);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map(call => call.args), [
          ["info", "--format", "{{json .ServerVersion}}"],
          ["image", "inspect", "ling-sandbox:test", "--format", "{{.Id}}"],
        ]);
        for (const call of calls) {
          assert.equal(call.kind, "execFile"); assert.equal(call.command, "/observed-only/docker");
          assert.deepEqual(call.options, { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
        }
        assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
      } finally { observed.setAsyncHandler(); }
    });

    for (const [phase, diagnostic, count] of [["info", "docker_daemon_unreachable", 1], ["image", "docker_image_unavailable", 2]]) {
      await t.test("ordinary same-message " + phase + " producer errors retain diagnostics, not denial provenance", nativeOnly, async t => {
        const f = await createSourceHookFixture(t), before = observed.calls.length;
        f.registry.bindOriginalActorEntries([entry]);
        const ordinary = Object.assign(new Error(gateCode), { code: gateCode });
        observed.setAsyncHandler(call => { if (call.args[0] === phase) throw ordinary; return "observed-only\n"; });
        try {
          const check = await docker.checkDockerSandboxBackend(enabledInput(f.cwd));
          assert.equal(check.ok, false); assert.deepEqual(diagnosticCodes(check), [diagnostic]);
          assert.equal(isRefusal(ordinary), false);
          assert.equal(observed.calls.length, before + count);
          assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
        } finally { observed.setAsyncHandler(); }
      });
    }

    await t.test("an earlier real refusal reused by the original producer loses brand but keeps sticky history", nativeOnly, async t => {
      const f = await createSourceHookFixture(t), before = observed.calls.length;
      f.registry.bindOriginalActorEntries([entry]);
      assert.ok(genuineRefusal); assert.equal(isRefusal(genuineRefusal), true);
      observed.setAsyncHandler(() => { throw genuineRefusal; });
      try {
        const check = await docker.checkDockerSandboxBackend(enabledInput(f.cwd));
        assert.equal(check.ok, false); assert.deepEqual(diagnosticCodes(check), ["docker_daemon_unreachable"]);
        assert.equal(observed.calls.length, before + 1);
        assert.equal(isRefusal(genuineRefusal), false);
        assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
      } finally { observed.setAsyncHandler(); }
    });

    await t.test("late attachment cannot retire a real public default probe's pre-binding history", nativeOnly, () => {
      const env = { ...process.env, LING_DOCKER_ORIGINAL_HOOKS_CASE: "late-attach" };
      // A fresh runner must not inherit its parent's binary child-v8 context.
      delete env.NODE_TEST_CONTEXT;
      const stdout = runIsolatedNode(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
        env,
        encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      });
      assert.match(stdout, /isolated original Docker default source retains pre-binding history/u);
      for (const statistic of ["tests 1", "pass 1", "fail 0", "cancelled 0", "skipped 0", "todo 0"]) {
        assert.match(stdout, new RegExp("^# " + statistic + "$", "m"));
      }
    });
  });
}

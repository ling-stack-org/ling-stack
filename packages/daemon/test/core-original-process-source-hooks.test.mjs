import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CORE_SOURCE_GATE_CODE, createPlainCoreWorkspace, loadCoreOriginalSourceHarness,
  makeExternalPoll, makeOfficialCache, observeCoreOriginalProcesses,
  recordRegistryRefusals, waitForPublicScheduler,
} from "./support/core-original-process-source-hooks-fixture.mjs";

const childCase = process.env.LING_CORE_ORIGINAL_HOOKS_CASE;
const nativeOnly = { skip: process.platform !== "darwin" };

if (childCase) {
  test("isolated original Core source pre-binding history: " + childCase, nativeOnly, async t => {
    const observed = observeCoreOriginalProcesses(t);
    // Do not import Daemon registry/manifest before this real public default
    // source has entered its captured original native producer.
    const core = await import("@ling-stack/core"), plain = createPlainCoreWorkspace(t, core);
    const source = childCase === "official"
      ? () => core.refreshManagedOfficialGstackSource(makeOfficialCache(t, plain.cwd))
      : makeExternalPoll(core, plain.store, plain.cwd).poll;
    const first = await source();
    assert.ok(first);
    assert.ok(observed.calls.length > 0, "pre-binding history came from a public default native producer");
    const harness = await loadCoreOriginalSourceHarness();
    const entry = childCase === "official" ? core.CORE_OFFICIAL_SKILL_GIT_ENTRY : core.CORE_EXTERNAL_WORK_SCHEDULER_ENTRY;
    assert.equal(core.readCoreOriginalProcessEntry(entry).enteredBeforeBinding, true);
    const f = await harness.createSourceHookFixture(t); harness.bind(f);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    await source();
    assert.equal(core.readCoreOriginalProcessEntry(entry).enteredBeforeBinding, true);
    assert.equal(core.readCoreOriginalProcessEntry(entry).nativeEntryEntered, true);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
  });
} else {
  test("original Core default sources gate launch and preserve truthful catch boundaries", nativeOnly, async t => {
    const observed = observeCoreOriginalProcesses(t), harness = await loadCoreOriginalSourceHarness();
    const { core, factory } = harness;
    const official = core.CORE_OFFICIAL_SKILL_GIT_ENTRY, schedulerEntry = core.CORE_EXTERNAL_WORK_SCHEDULER_ENTRY;

    await t.test("public default official refresh refuses before execFile and preserves the exact real gate error", async t => {
      const f = await harness.createSourceHookFixture(t), before = observed.calls.length;
      f.register(); harness.bind(f);
      const errors = recordRegistryRefusals(t, f.registry);
      let refusal;
      try { await core.refreshManagedOfficialGstackSource(makeOfficialCache(t, f.cwd)); }
      catch (error) { refusal = error; }
      assert.equal(observed.calls.length, before, "active Host staging prevents the actual default native producer");
      assert.ok(refusal);
      assert.equal(refusal.message, CORE_SOURCE_GATE_CODE);
      assert.equal(refusal, errors[0], "official catch must not wrap a source refusal as refresh_failed");
      assert.equal(core.isCoreOriginalLaunchRefusal(refusal), true);
      assert.equal(core.readCoreOriginalProcessEntry(official).nativeEntryEntered, false);
    });

    for (const kind of ["github", "linear"]) {
      await t.test("direct Core " + kind + " poll cannot bypass the bound source gate or turn refusal into retry_wait", async t => {
        const f = await harness.createSourceHookFixture(t), before = observed.calls.length;
        f.register(); harness.bind(f);
        const errors = recordRegistryRefusals(t, f.registry), external = makeExternalPoll(core, f.store, f.cwd, kind);
        let refusal;
        try { await external.poll(); } catch (error) { refusal = error; }
        assert.equal(observed.calls.length, before, "public poll reached the source gate before native spawn");
        assert.ok(refusal); assert.equal(refusal.message, CORE_SOURCE_GATE_CODE);
        assert.equal(refusal, errors[0], "processCandidate catch must preserve the original source refusal object");
        assert.equal(core.isCoreOriginalLaunchRefusal(refusal), true);
        assert.equal(core.readCoreOriginalProcessEntry(schedulerEntry).nativeEntryEntered, false);
        const records = f.store.listExternalWorkRecords({ channelId: external.channel.id });
        assert.equal(records.length, 1);
        const state = f.store.getExternalWorkSchedulerState(records[0].id);
        assert.notEqual(state.schedulerStatus, "retry_wait");
        assert.equal(state.lastErrorCode, undefined);
        assert.equal(state.nextAttemptAt, undefined);
      });
    }

    for (const activeIndex of [0, 1]) {
      await t.test("an active stage in bound registry " + activeIndex + " blocks both original Core sources", async t => {
        const fixtures = [await harness.createSourceHookFixture(t), await harness.createSourceHookFixture(t)];
        const activeStage = fixtures[activeIndex].register();
        for (const f of fixtures) harness.bind(f);
        const f = fixtures[1 - activeIndex], before = observed.calls.length;
        await assert.rejects(core.refreshManagedOfficialGstackSource(makeOfficialCache(t, f.cwd)), error =>
          error.message === CORE_SOURCE_GATE_CODE && core.isCoreOriginalLaunchRefusal(error));
        await assert.rejects(makeExternalPoll(core, f.store, f.cwd).poll(), error =>
          error.message === CORE_SOURCE_GATE_CODE && core.isCoreOriginalLaunchRefusal(error));
        assert.equal(observed.calls.length, before, "any attached registry participates; caller cwd is not an exemption");
        assert.equal(core.readCoreOriginalProcessEntry(official).nativeEntryEntered, false);
        assert.equal(core.readCoreOriginalProcessEntry(schedulerEntry).nativeEntryEntered, false);
        fixtures[activeIndex].registry.closeStage(activeStage);
        // Preflight across every registry is readonly: an inactive registry
        // visited before an active one must not gain unknown native history.
        // Zero-start refusal leaves both registries usable once the stage closes.
        for (const fixture of fixtures) {
          const resumedStage = fixture.register();
          fixture.registry.closeStage(resumedStage);
        }
        assert.equal(observed.calls.length, before);
        assert.equal(core.readCoreOriginalProcessEntry(official).nativeEntryEntered, false);
        assert.equal(core.readCoreOriginalProcessEntry(schedulerEntry).nativeEntryEntered, false);
      });
    }

    await t.test("background public start reports branded source refusal as failed and does not enqueue another timer", async t => {
      const f = await harness.createSourceHookFixture(t); f.register(); harness.bind(f);
      const before = observed.calls.length, external = makeExternalPoll(core, f.store, f.cwd);
      const { ExternalWorkBackgroundSchedulerRegistry } = await harness.loadSourceHookModule("features/external-work/background-scheduler.js");
      const background = new ExternalWorkBackgroundSchedulerRegistry({ getStore() { return f.store; } },
        { resolve() { throw new Error("fixture has no secretRef"); } }, external.fetch);
      t.after(() => background.stopAll());
      let scheduled = 0;
      const originalSetTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", function (...args) {
        scheduled += 1; return Reflect.apply(originalSetTimeout, this, args);
      });
      const result = await background.start(f.cwd, { channelId: external.channel.id,
        workflowPath: external.workflowPath, executeHooks: true, runImmediately: true });
      assert.equal(observed.calls.length, before);
      assert.equal(result.scheduler.status, "failed");
      assert.equal(result.scheduler.lastErrorCode, CORE_SOURCE_GATE_CODE);
      assert.equal(result.scheduler.tickCount, 1);
      assert.equal(result.scheduler.nextPollAt, undefined);
      assert.equal(scheduled, 0, "failed source admission must not requeue a background tick");
      assert.equal(background.list(f.cwd)[0].status, "failed");
    });

    await t.test("scheduled timer consumes a branded source refusal without unhandled rejection or requeue", async t => {
      const f = await harness.createSourceHookFixture(t); f.register(); harness.bind(f);
      const before = observed.calls.length, external = makeExternalPoll(core, f.store, f.cwd, "github",
        "printf observed-core-source", { pollIntervalMs: 25 });
      const { ExternalWorkBackgroundSchedulerRegistry } = await harness.loadSourceHookModule("features/external-work/background-scheduler.js");
      const background = new ExternalWorkBackgroundSchedulerRegistry({ getStore() { return f.store; } },
        { resolve() { throw new Error("fixture has no secretRef"); } }, external.fetch);
      t.after(() => background.stopAll());
      const unhandled = [], onUnhandled = error => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      t.after(() => process.removeListener("unhandledRejection", onUnhandled));
      t.mock.timers.enable({ apis: ["setTimeout"] });
      await background.start(f.cwd, { channelId: external.channel.id, workflowPath: external.workflowPath,
        executeHooks: true, runImmediately: false });
      t.mock.timers.tick(25);
      const failed = await waitForPublicScheduler(background, f.cwd, state => state.tickCount === 1);
      assert.equal(failed.status, "failed"); assert.equal(failed.lastErrorCode, CORE_SOURCE_GATE_CODE);
      assert.equal(failed.nextPollAt, undefined);
      t.mock.timers.tick(100);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(background.list(f.cwd)[0].tickCount, 1);
      assert.equal(observed.calls.length, before); assert.deepEqual(unhandled, []);
    });

    await t.test("a same-message ordinary background fetch error retains running and the original retry timer", async t => {
      const f = await harness.createSourceHookFixture(t); f.register(); harness.bind(f);
      const before = observed.calls.length, external = makeExternalPoll(core, f.store, f.cwd);
      const ordinary = Object.assign(new Error(CORE_SOURCE_GATE_CODE), { code: CORE_SOURCE_GATE_CODE });
      const { ExternalWorkBackgroundSchedulerRegistry } = await harness.loadSourceHookModule("features/external-work/background-scheduler.js");
      const background = new ExternalWorkBackgroundSchedulerRegistry({ getStore() { return f.store; } },
        { resolve() { throw new Error("fixture has no secretRef"); } }, async () => { throw ordinary; });
      t.after(() => background.stopAll());
      const result = await background.start(f.cwd, { channelId: external.channel.id,
        workflowPath: external.workflowPath, executeHooks: true, runImmediately: true });
      assert.equal(core.isCoreOriginalLaunchRefusal(ordinary), false);
      assert.equal(result.scheduler.status, "running");
      assert.equal(result.scheduler.lastErrorCode, "background_tick_failed");
      assert.equal(result.scheduler.lastErrorMessage, CORE_SOURCE_GATE_CODE);
      assert.equal(typeof result.scheduler.nextPollAt, "string");
      assert.equal(result.scheduler.tickCount, 1); assert.equal(observed.calls.length, before);
    });

    await t.test("custom official Git injection is not default-source producer or isolation proof", async t => {
      const f = await harness.createSourceHookFixture(t); f.register(); harness.bind(f);
      const before = observed.calls.length, cache = makeOfficialCache(t, f.cwd), injected = [];
      const result = await core.refreshManagedOfficialGstackSource({ ...cache, git: {
        async run(args, options) {
          injected.push({ args: [...args], options });
          if (args.includes("--show-toplevel")) return cache.cacheRoot;
          if (args.includes("remote.origin.url")) return core.OFFICIAL_GSTACK_ORIGIN_URL;
          if (args.includes("HEAD")) return "custom-revision";
          return "";
        },
      } });
      assert.equal(result.revision, "custom-revision"); assert.equal(injected.length, 6);
      assert.equal(observed.calls.length, before);
      assert.equal(core.readCoreOriginalProcessEntry(official).nativeEntryEntered, false);
      assert.throws(() => f.registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
    });

    await t.test("public entries are frozen, source-owned, and cannot accept clones or borrowed opaque records", () => {
      assert.equal(typeof factory.createCoreOriginalProcessEntry, "function");
      assert.equal(core.createCoreOriginalProcessEntry, undefined, "the Core barrel does not expose input factories");
      const borrowed = factory.createCoreOriginalProcessEntry("official_skill_git", () => undefined).capture({});
      for (const [entry, sourceId] of [[official, "official_skill_git"], [schedulerEntry, "external_work_scheduler"]]) {
        assert.equal(Object.isFrozen(entry), true);
        assert.deepEqual(core.readCoreOriginalProcessEntry(entry), {
          sourceId, guardBound: true, enteredBeforeBinding: false, nativeEntryEntered: false,
        });
        assert.equal(Object.hasOwn(entry, "capture"), false); assert.equal(Object.hasOwn(entry, "producer"), false);
        assert.throws(() => core.readCoreOriginalProcessEntry({ ...entry }), /core_original_process_entry_invalid/u);
        assert.throws(() => core.bindCoreOriginalProcessGuard({ ...entry }, {
          assertMayLaunch() {}, nativeEntryEntered() {},
        }), /core_original_process_entry_invalid/u);
        for (const record of [{}, Object.freeze({}), borrowed, { ...borrowed }]) {
          assert.throws(() => entry.invoke(record), /core_original_process_record_invalid/u);
        }
      }
    });

    await t.test("a genuine refusal preserves error identity, never enters native, and consumes its invocation record", () => {
      let producerCalls = 0, guardCalls = 0, enteredCalls = 0;
      const unit = factory.createCoreOriginalProcessEntry("official_skill_git", () => { producerCalls += 1; });
      const refusal = new Error("fixture-real-source-refusal");
      core.bindCoreOriginalProcessGuard(unit.entry, { assertMayLaunch() { guardCalls += 1; throw refusal; },
        nativeEntryEntered() { enteredCalls += 1; } });
      const record = unit.capture({});
      assert.throws(() => unit.entry.invoke(record), error => error === refusal);
      assert.equal(core.isCoreOriginalLaunchRefusal(refusal), true);
      assert.throws(() => unit.entry.invoke(record), /core_original_process_record_consumed/u);
      assert.deepEqual([producerCalls, guardCalls, enteredCalls], [0, 1, 0]);
      assert.deepEqual(core.readCoreOriginalProcessEntry(unit.entry), { sourceId: "official_skill_git",
        guardBound: true, enteredBeforeBinding: false, nativeEntryEntered: false });
    });

    await t.test("a reentrant guard cannot replay the record before native entry", () => {
      let producerCalls = 0, enteredCalls = 0, record;
      const unit = factory.createCoreOriginalProcessEntry("external_work_scheduler", input => { producerCalls += 1; return input; });
      core.bindCoreOriginalProcessGuard(unit.entry, {
        assertMayLaunch() { assert.throws(() => unit.entry.invoke(record), /core_original_process_record_consumed/u); },
        nativeEntryEntered() { enteredCalls += 1; },
      });
      record = unit.capture("source-owned-input");
      assert.equal(unit.entry.invoke(record), "source-owned-input");
      assert.deepEqual([producerCalls, enteredCalls], [1, 1]);
      assert.throws(() => unit.entry.invoke(record), /core_original_process_record_consumed/u);
    });

    await t.test("async installation and duplicate binding are rejected without entering a producer", () => {
      const unit = factory.createCoreOriginalProcessEntry("official_skill_git", () => assert.fail("producer must not run"));
      assert.throws(() => core.bindCoreOriginalProcessGuard(unit.entry, {
        async assertMayLaunch() {}, nativeEntryEntered() {},
      }), /core_original_process_guard_must_be_synchronous/u);
      assert.equal(core.readCoreOriginalProcessEntry(unit.entry).guardBound, false);
      core.bindCoreOriginalProcessGuard(unit.entry, { assertMayLaunch() {}, nativeEntryEntered() {} });
      assert.throws(() => core.bindCoreOriginalProcessGuard(unit.entry, {
        assertMayLaunch() {}, nativeEntryEntered() {},
      }), /core_original_process_guard_already_bound/u);
      assert.equal(core.readCoreOriginalProcessEntry(unit.entry).nativeEntryEntered, false);
    });

    for (const [name, assertion, code] of [
      ["native Promise", () => Promise.resolve(), "core_original_process_guard_must_be_synchronous"],
      ["thenable", () => ({ then(resolve) { resolve(); } }), "core_original_process_guard_must_be_synchronous"],
      ["non-void result", () => true, "core_original_process_guard_must_return_undefined"],
    ]) {
      await t.test("a " + name + " guard result fails closed and consumes its record", async () => {
        const unit = factory.createCoreOriginalProcessEntry("official_skill_git", () => assert.fail("producer must not run"));
        core.bindCoreOriginalProcessGuard(unit.entry, { assertMayLaunch: assertion, nativeEntryEntered() {} });
        const record = unit.capture({});
        assert.throws(() => unit.entry.invoke(record), error => error.code === code && core.isCoreOriginalLaunchRefusal(error));
        assert.equal(core.readCoreOriginalProcessEntry(unit.entry).nativeEntryEntered, false);
        assert.throws(() => unit.entry.invoke(record), /core_original_process_record_consumed/u);
        await new Promise(resolve => setImmediate(resolve));
      });
    }

    await t.test("mutating an installed guard cannot replace its captured decision", () => {
      const unit = factory.createCoreOriginalProcessEntry("official_skill_git", () => assert.fail("producer must not run"));
      const guard = { assertMayLaunch() {}, nativeEntryEntered() {} };
      core.bindCoreOriginalProcessGuard(unit.entry, guard); guard.assertMayLaunch = () => undefined;
      assert.throws(() => unit.entry.invoke(unit.capture({})), /core_original_process_guard_changed/u);
      assert.equal(core.readCoreOriginalProcessEntry(unit.entry).nativeEntryEntered, false);
    });

    for (const mode of ["producer_throw", "producer_reject", "entered_throw"]) {
      await t.test("an Error reused by " + mode + " loses refusal branding but keeps irreversible native history", async () => {
        const shared = new Error("reused-error");
        const refusing = factory.createCoreOriginalProcessEntry("official_skill_git", () => undefined);
        core.bindCoreOriginalProcessGuard(refusing.entry, { assertMayLaunch() { throw shared; }, nativeEntryEntered() {} });
        assert.throws(() => refusing.entry.invoke(refusing.capture({})), error => error === shared);
        assert.equal(core.isCoreOriginalLaunchRefusal(shared), true);
        const entered = factory.createCoreOriginalProcessEntry("external_work_scheduler", () => {
          if (mode === "producer_reject") return Promise.reject(shared);
          if (mode === "producer_throw") throw shared;
          return undefined;
        });
        core.bindCoreOriginalProcessGuard(entered.entry, { assertMayLaunch() {},
          nativeEntryEntered() { if (mode === "entered_throw") throw shared; } });
        if (mode === "producer_reject") {
          await assert.rejects(entered.entry.invoke(entered.capture({})), error => error === shared);
        } else assert.throws(() => entered.entry.invoke(entered.capture({})), error => error === shared);
        assert.equal(core.isCoreOriginalLaunchRefusal(shared), false, "an entered failure is not a no-start refusal");
        assert.deepEqual(core.readCoreOriginalProcessEntry(entered.entry), { sourceId: "external_work_scheduler",
          guardBound: true, enteredBeforeBinding: false, nativeEntryEntered: true });
      });
    }

    await t.test("pre-binding producer failure is sticky and a later successful binding cannot clear it", () => {
      let calls = 0;
      const ordinary = new Error("producer-entered-before-binding");
      const unit = factory.createCoreOriginalProcessEntry("external_work_scheduler", () => {
        calls += 1; if (calls === 1) throw ordinary; return "later-success";
      });
      assert.throws(() => unit.entry.invoke(unit.capture({})), error => error === ordinary);
      assert.equal(core.isCoreOriginalLaunchRefusal(ordinary), false);
      core.bindCoreOriginalProcessGuard(unit.entry, { assertMayLaunch() {}, nativeEntryEntered() {} });
      assert.equal(unit.entry.invoke(unit.capture({})), "later-success");
      assert.deepEqual(core.readCoreOriginalProcessEntry(unit.entry), { sourceId: "external_work_scheduler",
        guardBound: true, enteredBeforeBinding: true, nativeEntryEntered: true });
    });

    for (const isolatedCase of ["official", "scheduler"]) {
      await t.test("public " + isolatedCase + " pre-binding launch closes later staging even after binding and success", () => {
        const env = { ...process.env, LING_CORE_ORIGINAL_HOOKS_CASE: isolatedCase };
        // This is a separate Node runner, not a recursive run in the parent
        // child-v8 context. Inheriting it silently skips the child test files.
        delete env.NODE_TEST_CONTEXT;
        const result = childProcess.spawnSync(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
          env, encoding: "utf8", timeout: 30000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /isolated original Core source pre-binding history/u);
        for (const statistic of ["# tests 1", "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"]) {
          assert.ok(result.stdout.includes(statistic), "child suite actually ran: " + statistic);
        }
      });
    }

    // Every stage-backed refusal above must finish before these original
    // default source producers enter native code. Their coverage is sticky.
    await t.test("stage-free default official Git preserves physical placement and cannot retire unknown coverage", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f);
      const cache = makeOfficialCache(t, f.cwd), before = observed.calls.length;
      const result = await core.refreshManagedOfficialGstackSource(cache);
      assert.equal(result.revision, "core-original-observed-revision");
      const calls = observed.calls.slice(before);
      assert.equal(calls.length, 6);
      assert.equal(calls.every(call => call.kind === "execFile" && call.command === "git"
        && call.options.cwd === cache.cacheRoot && call.options.encoding === "utf8"), true);
      assert.deepEqual(calls.map(call => call.args), [
        ["-c", "core.hooksPath=/dev/null", "rev-parse", "--show-toplevel"],
        ["-c", "core.hooksPath=/dev/null", "config", "--get", "remote.origin.url"],
        ["-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", "origin", "main"],
        ["-c", "core.hooksPath=/dev/null", "checkout", "--force", "--detach", "FETCH_HEAD"],
        ["-c", "core.hooksPath=/dev/null", "clean", "-ffdq"],
        ["-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"],
      ]);
      assert.equal(core.readCoreOriginalProcessEntry(official).nativeEntryEntered, true);
      assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    });

    for (const [nativeCode, expectedCode] of [["ENOENT", "git_unavailable"], ["EIO", "refresh_failed"]]) {
      await t.test("ordinary default Git " + nativeCode + " remains the original business error even with gate-like text", async t => {
        const f = await harness.createSourceHookFixture(t); harness.bind(f);
        const ordinary = Object.assign(new Error(CORE_SOURCE_GATE_CODE), { code: nativeCode });
        observed.setGitHandler(() => { throw ordinary; });
        try {
          await assert.rejects(core.refreshManagedOfficialGstackSource(makeOfficialCache(t, f.cwd)), error =>
            error.code === expectedCode && error.cause === ordinary);
          assert.equal(core.isCoreOriginalLaunchRefusal(ordinary), false);
          assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
        } finally { observed.setGitHandler(); }
      });
    }

    await t.test("ordinary scheduler producer failure retains retry_wait rather than borrowing source refusal branding", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f);
      const ordinary = Object.assign(new Error(CORE_SOURCE_GATE_CODE), { code: CORE_SOURCE_GATE_CODE });
      observed.setSpawnError(ordinary);
      try {
        const result = await makeExternalPoll(core, f.store, f.cwd).poll();
        assert.equal(result.retryScheduled, 1);
        assert.equal(result.schedulerStates[0].schedulerStatus, "retry_wait");
        assert.equal(result.schedulerStates[0].lastErrorCode, "poll_candidate_failed");
        assert.equal(result.schedulerStates[0].nextAttemptAt, "2026-10-06T00:00:01.000Z");
        assert.equal(core.isCoreOriginalLaunchRefusal(ordinary), false);
        assert.equal(core.readCoreOriginalProcessEntry(schedulerEntry).nativeEntryEntered, true);
        assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
      } finally { observed.setSpawnError(undefined); }
    });

    await t.test("a nonzero ordinary hook exit preserves failed evidence and capped retry", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f);
      observed.setSpawnExitCode(7);
      try {
        const result = await makeExternalPoll(core, f.store, f.cwd).poll();
        assert.equal(result.retryScheduled, 1);
        assert.equal(result.schedulerStates[0].schedulerStatus, "retry_wait");
        const artifact = result.artifacts.find(value => value.title === "External work hook: beforeRun");
        assert.ok(artifact);
        const content = readFileSync(resolve(f.store.paths.artifactsDir, artifact.path), "utf8");
        assert.match(content, /exitCode/u); assert.match(content, /observed-source-hook-error/u);
      } finally { observed.setSpawnExitCode(); }
    });

    await t.test("a stage-free original scheduler executes one real harmless local shell and persists its output artifact", async t => {
      const f = await harness.createSourceHookFixture(t); harness.bind(f);
      const before = observed.calls.length;
      observed.enableRealShell(f.cwd);
      try {
        const result = await makeExternalPoll(core, f.store, f.cwd, "github", "printf 'core-original-shell-positive'").poll();
        assert.equal(result.claimed, 1); assert.equal(result.schedulerStates[0].schedulerStatus, "ready");
        const artifact = result.artifacts.find(value => value.title === "External work hook: beforeRun");
        assert.ok(artifact);
        const content = readFileSync(resolve(f.store.paths.artifactsDir, artifact.path), "utf8");
        assert.match(content, /core-original-shell-positive/u);
        const calls = observed.calls.slice(before);
        assert.equal(calls.length, 1); assert.equal(calls[0].kind, "spawn");
        assert.equal(calls[0].command, "printf 'core-original-shell-positive'");
        assert.equal(calls[0].options.shell, true);
        assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
        assert.equal(calls[0].options.cwd, result.schedulerStates[0].workspacePath);
        assert.equal(core.readCoreOriginalProcessEntry(schedulerEntry).nativeEntryEntered, true);
        assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
      } finally { observed.disableRealShell(); }
    });
  });
}

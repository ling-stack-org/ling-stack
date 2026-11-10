import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createHostCommandPreflightFixture } from "./support/host-command-preflight-fixture.mjs";

function assertNoStart(f) {
  if (f.host) {
    assert.equal(f.store.getHostOperation(f.host.operationId).phase, "admitted");
    assert.equal(f.store.getHostOperation(f.host.operationId).launchedAt, undefined);
  }
  assert.equal(f.store.settleHostCommandExecution(f.command, { kind: "not_started" }).data.outcome, "not_started");
  assert.deepEqual(f.store.listHostCommandWriteBlockers(f.cwd), []);
  if (f.host) {
    assert.equal(f.store.settleHostOperation(f.host, { kind: "known_no_start" }).phase, "safe");
    assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
  }
}

for (const mode of ["tracked", "untracked"]) {
  for (const problem of ["throw", "async", "thenable", "sql_write", "value", "non_function"]) {
    test(`${mode} preflight ${problem} rejects before claim and can settle genuine no-start`, async t => {
      const f = await createHostCommandPreflightFixture(t, mode), target = join(f.cwd, "must-not-exist.txt");
      let producers = 0, assertions = 0;
      const preflight = problem === "async" ? async () => { ++assertions; throw new Error("must not enter async preflight"); }
        : problem === "non_function" ? true : () => {
          ++assertions;
          if (problem === "throw") throw new Error("preflight_policy_denied");
          if (problem === "thenable") return Promise.reject(new Error("no async source authority"));
          if (problem === "sql_write") return f.store.database.prepare("INSERT INTO launch_preflight_probe VALUES('forbidden')").run();
          return "not void";
        };
      assert.throws(() => f.launch(() => { ++producers; writeFileSync(target, "effect"); }, preflight));
      assert.equal(producers, 0); assert.equal(existsSync(target), false);
      assert.equal(assertions, ["async", "non_function"].includes(problem) ? 0 : 1);
      assert.equal(f.store.database.isTransaction, false);
      assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 0);
      assert.equal(f.other.database.prepare("SELECT count(*) n FROM launch_preflight_probe").get().n, 0);
      assertNoStart(f);
    });
  }

  test(`${mode} rejected preflight does not consume the original live launch ticket`, async t => {
    const f = await createHostCommandPreflightFixture(t, mode);
    assert.throws(() => f.launch(() => assert.fail("denied producer"), () => { throw new Error("deny"); }), /deny/);
    let calls = 0;
    assert.equal(f.launch(() => { ++calls; return "launched"; }, () => undefined), "launched");
    assert.equal(calls, 1);
    assert.throws(() => f.launch(() => assert.fail("double launch"), () => undefined), /already.*launch|launch.*claimed/);
  });

  test(`${mode} preflight and native producer retain the same writer lock and read-only projections`, async t => {
    const f = await createHostCommandPreflightFixture(t, mode), target = join(f.cwd, "actual-native-effect.txt");
    const controls = [], originalExec = f.store.database.exec.bind(f.store.database);
    f.store.database.exec = sql => { if (["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(sql)) controls.push(sql); return originalExec(sql); };
    t.after(() => { f.store.database.exec = originalExec; });
    let preflight = false;
    const assertLocked = () => {
      assert.equal(f.store.database.isTransaction, true);
      assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 1);
      assert.equal(f.store.readSnapshot(() => f.store.getRun(f.run.id).id), f.run.id);
      assert.throws(() => f.other.database.exec("BEGIN IMMEDIATE"), /locked|busy/);
      assert.throws(() => f.store.database.prepare("INSERT INTO launch_preflight_probe VALUES('forbidden')").run(), /readonly|read.only/);
    };
    const result = f.launch(() => {
      assert.equal(preflight, true); assertLocked();
      if (f.host) assert.equal(f.store.getHostOperation(f.host.operationId).phase, "launched");
      const child = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'physical')", target], { timeout: 10_000 });
      assert.equal(child.error, undefined); assert.equal(child.status, 0);
      return "native";
    }, () => {
      assertLocked();
      if (f.host) assert.equal(f.store.getHostOperation(f.host.operationId).phase, "admitted");
      preflight = true;
    });
    assert.equal(result, "native"); assert.equal(readFileSync(target, "utf8"), "physical");
    assert.deepEqual(controls, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.equal(f.store.database.isTransaction, false);
    assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 0);
  });

  test(`${mode} preflight is not run for a stale owner and does not adopt unrelated transactions`, async t => {
    const f = await createHostCommandPreflightFixture(t, mode);
    f.store.database.exec("BEGIN IMMEDIATE");
    f.store.database.prepare("INSERT INTO launch_preflight_probe VALUES('caller-owned')").run();
    let assertions = 0;
    assert.throws(() => f.launch(() => assert.fail("nested producer"), () => { ++assertions; }));
    assert.equal(assertions, 0); assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.database.prepare("SELECT id FROM launch_preflight_probe").get().id, "caller-owned");
    assert.equal(f.other.database.prepare("SELECT count(*) n FROM launch_preflight_probe").get().n, 0);
    f.store.database.exec("ROLLBACK");
    f.replace();
    assert.throws(() => f.launch(() => assert.fail("stale producer"), () => { ++assertions; }), /stale.*owner|stale.*execution/);
    assert.equal(assertions, 0);
  });

  for (const failure of ["throw", "thenable", "commit"]) {
    test(`${mode} entered producer ${failure} still consumes its ticket and leaves blocking evidence`, async t => {
      const f = await createHostCommandPreflightFixture(t, mode), target = join(f.cwd, "actual-effect.txt");
      const originalExec = f.store.database.exec.bind(f.store.database);
      t.after(() => { f.store.database.exec = originalExec; });
      if (failure === "commit") f.store.database.exec = sql => {
        if (sql === "COMMIT") { f.store.database.exec = originalExec; throw new Error("after_effect_commit_failed"); }
        return originalExec(sql);
      };
      let assertions = 0, effects = 0;
      assert.throws(() => f.launch(() => {
        ++effects; writeFileSync(target, "real effect");
        if (failure === "throw") throw new Error("after_effect_callback_failed");
        return failure === "thenable" ? Promise.reject(new Error("not a closure receipt")) : "effect";
      }, () => { ++assertions; }));
      assert.equal(assertions, 1); assert.equal(effects, 1); assert.equal(readFileSync(target, "utf8"), "real effect");
      assert.throws(() => f.launch(() => assert.fail("post-effect retry"), () => { ++assertions; }), /already.*launch|launch.*claimed/);
      assert.equal(assertions, 1);
      assert.equal(f.other.listHostCommandWriteBlockers(f.cwd).length, 1);
      if (f.host) {
        assert.throws(() => f.store.settleHostOperation(f.host, { kind: "known_no_start" }), /launched.*no.start/);
        assert.equal(f.store.settleHostOperation(f.host, { kind: "unknown_outcome", code: "physical_scope_unverified" }).phase, "unknown_outcome");
        assert.equal(f.other.listHostOperationBlockers(f.source).length, 1);
      }
    });
  }
}

for (const problem of ["missing_binding", "forged_command", "changed_digest", "admission_closed"]) {
  test(`tracked ${problem} is checked before caller preflight and claim`, async t => {
    const f = await createHostCommandPreflightFixture(t, "tracked", problem !== "missing_binding");
    let assertions = 0, effects = 0;
    if (problem === "changed_digest") {
      // This isolated fixture deliberately simulates durable corruption beyond
      // the SQL immutability guard; no production connection is modified.
      f.store.database.exec("DROP TRIGGER host_operations_immutable_binding");
      f.store.database.prepare("UPDATE host_operations SET domain_identity_digest=? WHERE operation_id=?")
        .run("f".repeat(64), f.host.operationId);
    }
    if (problem === "admission_closed") f.ask();
    assert.throws(() => f.store.launchTrackedHostCommandExecution(f.host,
      problem === "forged_command" ? { ...f.command } : f.command, () => { ++effects; }, () => { ++assertions; }));
    assert.equal(assertions, 0); assert.equal(effects, 0);
    assert.equal(f.store.getHostOperation(f.host.operationId).phase, "admitted");
    if (problem === "forged_command" || problem === "admission_closed") assertNoStart(f);
  });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import test from "node:test";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";
import { createRestrictedCommandFixture } from "./support/restricted-command-fixture.mjs";

assert.equal(process.platform, "darwin", "This contract requires an actual macOS Host.");
assert.ok(process.argv[2] && isAbsolute(process.argv[2]), "A fresh real helper is required.");
const pin = path => ({ path: realpathSync(path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
const config = { inputHelper: { ...pin(process.argv[2]), version: "0.1.0-dev.0" }, executables: { node: pin(process.execPath) } };

// Value: protects=atomic authority reads share the Core writer transaction;
// fails_when=the restricted preflight starts a second SQLite view or can write;
// why_new=restricted dispatch now reuses its existing check in atomic preflight;
// seam=readSnapshot observer only, not a replacement backend or launch grant
test("restricted preflight reads the actual nested Core read-only launch window", async t => {
  const f = await createRestrictedCommandFixture(t, `node -e "console.log('nested-preflight-ok')"`);
  const readSnapshot = f.store.readSnapshot.bind(f.store);
  let lockedReads = 0;
  f.store.readSnapshot = read => {
    const nested = f.store.database.isTransaction && f.store.database.prepare("PRAGMA query_only").get().query_only === 1;
    return readSnapshot(() => {
      if (nested) {
        lockedReads++;
        assert.throws(() => f.store.database.exec("CREATE TABLE forbidden_preflight_write(value TEXT)"), /readonly|read.only/iu);
      }
      return read();
    });
  };
  const approval = await f.approve(new NativeRestrictedCommandRuntime(config));
  const result = approval.handledResult.details.unifiedExec;
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.stdout.preview, "nested-preflight-ok\n");
  assert.equal(result.isolation.backend, "macos_seatbelt");
  assert.ok(lockedReads >= 2, "both the atomic preflight and native spawn must retain locked read-only authority checks");
  assert.equal(f.store.database.isTransaction, false);
  assert.equal(f.store.database.prepare("PRAGMA query_only").get().query_only, 0);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

// Value: protects=entered native work without a returned handle remains unknown;
// fails_when=early authority preflight washes a post-entry throw into no-start;
// why_new=the preflight fix must not weaken conservative native settlement;
// seam=post-real-spawn return fault, actual helper, sandbox and child unchanged
test("a throw after real native spawn stays stop_unconfirmed without a returned handle", async t => {
  const f = await createRestrictedCommandFixture(t, `node -e "console.log('native-entered')"`);
  const runtime = new NativeRestrictedCommandRuntime(config), prepare = runtime.prepare.bind(runtime);
  let prepared, child, closed;
  t.after(async () => { if (closed) await closed; if (prepared) prepared.dispose(); });
  runtime.prepare = async input => {
    prepared = await prepare(input);
    return { ...prepared, spawn() {
      child = prepared.spawn();
      closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      child.stdout.resume(); child.stderr.resume();
      throw new Error("fixture_throw_after_real_native_spawn");
    } };
  };
  const approval = await f.approve(runtime);
  const result = approval.handledResult.details.unifiedExec;
  assert.equal(result.status, "failed");
  assert.match(result.stderr.preview, /fixture_throw_after_real_native_spawn/u);
  assert.ok(child && Number.isInteger(child.pid), "the test must enter the real native producer");
  await closed;
  const settled = f.store.listEvents(f.run.id, { limit: 1000 }).findLast(event => event.type === "host_command_settled");
  assert.equal(settled.data.outcome, "stop_unconfirmed");
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd)[0].state, "stop_unconfirmed");
  await access(prepared.evidence.executionCwd);
});

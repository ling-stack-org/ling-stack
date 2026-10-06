import assert from "node:assert/strict";
import test from "node:test";
import {
  createOriginalOfficeHostBridgeForComposition as create,
  captureOriginalOfficeHostBridgeReader as capture,
  sealOriginalOfficeHostBridgeForComposition as seal,
  mintOriginalOfficeDirectoryAuthorityV2 as mint,
  assertOriginalOfficeHostBridgeForCompositionCurrent as assertComposition,
  retireOriginalOfficeHostBridgeForComposition as retireComposition,
} from "../dist/original-office-host-bridge.js";
import { SqliteRunStore } from "../dist/index.js";
import { verifyHostOfficeReceipt } from "../dist/storage/sqlite/host-office-local-journal-evidence.js";
import { readHostOperation } from "../dist/storage/sqlite/host-operation-journal-evidence.js";
import { directoryV2StoreFixture } from "./support/host-office-local-directory-v2-fixture.mjs";

// Mechanism fixtures only. No native syscall, genuine Host issuer or Core-safe certificate.
const code = expected => error => error?.code === expected;
const endpoint = callback => Object.freeze({ assertBinding: callback });
const copies = value => [JSON.parse(JSON.stringify(value)), { ...value }, new Proxy(value, {})];
function channel(callback = () => undefined) {
  const pair = create(), owner = {}, bridge = capture(pair.reader, owner);
  seal(pair.setup, owner, endpoint(callback));
  return { ...pair, owner, bridge, authority: mint(pair.setup, Object.freeze({})) };
}

test("composition lifecycle reader rejects wrong owner and cloned setup without retiring an original channel", () => {
  const original = channel();
  for (const setup of copies(original.setup)) {
    assert.throws(() => assertComposition(setup, original.owner), code("host_office_local_bridge_owner_invalid"));
    assert.throws(() => retireComposition(setup, original.owner), code("host_office_local_bridge_owner_invalid"));
  }
  assert.throws(() => assertComposition(original.setup, {}), code("host_office_local_bridge_owner_invalid"));
  assert.throws(() => retireComposition(original.setup, {}), code("host_office_local_bridge_owner_invalid"));
  assertComposition(original.setup, original.owner); original.bridge.assertAuthorityOwned(original.authority);
  retireComposition(original.setup, original.owner); retireComposition(original.setup, original.owner);
  assert.throws(() => assertComposition(original.setup, original.owner), code("host_office_local_bridge_unavailable"));
  assert.throws(() => original.bridge.assertAuthorityOwned(original.authority), code("host_office_local_bridge_unavailable"));
  assert.throws(() => mint(original.setup, {}), code("host_office_local_bridge_unavailable"));
});

test("composition cannot enroll or retire an unsealed channel and failed lifecycle checks never seal it", () => {
  const pair = create(), owner = {}; capture(pair.reader, owner);
  assert.throws(() => assertComposition(pair.setup, owner), code("host_office_local_bridge_unavailable"));
  assert.throws(() => retireComposition(pair.setup, owner), code("host_office_local_bridge_unavailable"));
  seal(pair.setup, owner, endpoint(() => undefined)); assertComposition(pair.setup, owner);
});
async function fixture(t, callback = () => undefined, { sealed = true } = {}) {
  const pair = create(), f = await directoryV2StoreFixture(t, { originalOfficeHostBridge: pair.reader });
  if (sealed) seal(pair.setup, f.store, endpoint((custody, expected) => callback(f, custody, expected)));
  return { ...f, ...pair, authority: () => mint(pair.setup, Object.freeze({})) };
}

test("Host composition retirement closes already-bound Core effect admission while SQLite remains open", async t => {
  const f = await fixture(t), authority = f.authority();
  f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, authority);
  retireComposition(f.setup, f.store);
  assert.throws(() => f.store.prepareHostOfficeLocalDirectoryEffectV2(f.ticket,
    { effectId: "after-root-retirement", ordinal: 0, kind: "capture_parents", mode: "forward", preparedAt: f.now() }),
    code("host_office_local_bridge_unavailable"));
  assert.deepEqual(f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId), []);
  assert.equal(f.store.getRun(f.source.runId).status, "running");
});

test("bridge tokens are frozen opaque handles and cloned/spread/proxy readers never capture", () => {
  const pair = create();
  assert.deepEqual(Reflect.ownKeys(pair.reader), []);
  assert.deepEqual(Reflect.ownKeys(pair.setup), []);
  assert.ok(Object.isFrozen(pair.reader) && Object.isFrozen(pair.setup));
  for (const reader of copies(pair.reader)) {
    assert.throws(() => capture(reader, {}), code("host_office_local_bridge_invalid"));
  }
  const owner = {}, bridge = capture(pair.reader, owner);
  assert.throws(() => capture(pair.reader, {}), code("host_office_local_bridge_owner_invalid"));
  seal(pair.setup, owner, endpoint(() => undefined));
  bridge.bindAuthority(mint(pair.setup, {}), {});
});

test("fake setup and foreign channel authority cannot reach the fixed Host endpoint", () => {
  const pair = create(), owner = {}; capture(pair.reader, owner);
  for (const setup of copies(pair.setup)) {
    assert.throws(() => seal(setup, owner, endpoint(() => undefined)), code("host_office_local_bridge_invalid"));
    assert.throws(() => mint(setup, {}), code("host_office_local_bridge_invalid"));
  }
  let calls = 0;
  const original = channel(() => { calls++; }), foreign = channel();
  for (const authority of [...copies(original.authority), foreign.authority]) {
    assert.throws(() => original.bridge.bindAuthority(authority, {}), code("host_office_local_authority_invalid"));
  }
  assert.equal(calls, 0);
  original.bridge.bindAuthority(original.authority, {}); assert.equal(calls, 1);
  assert.throws(() => original.bridge.bindAuthority(original.authority, {}), code("host_office_local_authority_already_entered"));
});

test("unsealed bridge cannot mint or bind and wrong owner permanently consumes sealing", () => {
  const pair = create(), owner = {}, bridge = capture(pair.reader, owner);
  assert.throws(() => mint(pair.setup, {}), code("host_office_local_bridge_unavailable"));
  assert.throws(() => bridge.bindAuthority({}, {}), code("host_office_local_bridge_unavailable"));
  assert.throws(() => seal(pair.setup, {}, endpoint(() => undefined)), code("host_office_local_bridge_owner_invalid"));
  assert.throws(() => seal(pair.setup, owner, endpoint(() => undefined)), code("host_office_local_bridge_seal_closed"));
});

for (const [label, make] of [
  ["mutable endpoint", () => ({ assertBinding: () => undefined })],
  ["accessor", () => Object.freeze({ get assertBinding() { throw Error("getter must not run"); } })],
  ["extra method", () => Object.freeze({ assertBinding: () => undefined, replace: () => undefined })],
  ["async function", () => endpoint(async () => undefined)],
]) test(`sealing rejects ${label} and never permits replacement`, () => {
  const pair = create(), owner = {}; capture(pair.reader, owner);
  assert.throws(() => seal(pair.setup, owner, make()), /host_office_local_bridge/);
  assert.throws(() => seal(pair.setup, owner, endpoint(() => undefined)), code("host_office_local_bridge_seal_closed"));
});

test("descriptor trap reentry or throw cannot reopen a sealing channel", () => {
  for (const throws of [false, true]) {
    const pair = create(), owner = {}; capture(pair.reader, owner);
    let trap = false;
    const proxy = new Proxy(endpoint(() => undefined), {
      isExtensible(target) {
        trap = true;
        assert.throws(() => seal(pair.setup, owner, target), code("host_office_local_bridge_seal_closed"));
        if (throws) throw Error("descriptor observation lost");
        return false;
      },
    });
    if (throws) {
      assert.throws(() => seal(pair.setup, owner, proxy), /descriptor observation lost/);
      assert.throws(() => seal(pair.setup, owner, endpoint(() => undefined)), code("host_office_local_bridge_seal_closed"));
    } else {
      seal(pair.setup, owner, proxy);
      assert.throws(() => seal(pair.setup, owner, endpoint(() => undefined)), code("host_office_local_bridge_seal_closed"));
    }
    assert.equal(trap, true);
  }
});

test("authority entry survives endpoint throw and recursive binding", () => {
  let calls = 0, original;
  original = channel(() => { calls++; original.bridge.bindAuthority(original.authority, {}); });
  assert.throws(() => original.bridge.bindAuthority(original.authority, {}), code("host_office_local_authority_already_entered"));
  assert.throws(() => original.bridge.bindAuthority(original.authority, {}), code("host_office_local_authority_already_entered"));
  assert.equal(calls, 1);
  const thrown = channel(() => { throw Error("original return lost"); });
  assert.throws(() => thrown.bridge.bindAuthority(thrown.authority, {}), /original return lost/);
  assert.throws(() => thrown.bridge.bindAuthority(thrown.authority, {}), code("host_office_local_authority_already_entered"));
});

test("non-void and native rejected Promise results fail without executing arbitrary thenables", async () => {
  let thenCalls = 0;
  const thenable = Object.freeze({ get then() { thenCalls++; throw Error("untrusted then"); } });
  for (const result of [true, {}, thenable, Promise.reject(Error("handled native rejection"))]) {
    const original = channel(() => result);
    assert.throws(() => original.bridge.bindAuthority(original.authority, {}), code("host_office_local_bridge_endpoint_result_invalid"));
    assert.throws(() => original.bridge.bindAuthority(original.authority, {}), code("host_office_local_authority_already_entered"));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(thenCalls, 0);
});

test("retirement during endpoint and after successful binding permanently disables the channel", () => {
  let original;
  original = channel(() => original.bridge.retire());
  assert.throws(() => original.bridge.bindAuthority(original.authority, {}), code("host_office_local_bridge_unavailable"));
  assert.throws(() => mint(original.setup, {}), code("host_office_local_bridge_unavailable"));
  const completed = channel(); completed.bridge.bindAuthority(completed.authority, {}); completed.bridge.retire();
  assert.throws(() => completed.bridge.assertAuthorityOwned(completed.authority), code("host_office_local_bridge_unavailable"));
});

test("Host private custody map rejects a matching caller-created token", () => {
  const custody = Object.freeze({}), privateCustody = new WeakSet([custody]); let calls = 0;
  const original = channel(value => { calls++; assert.ok(privateCustody.has(value), "not original Host custody"); });
  assert.throws(() => original.bridge.bindAuthority(mint(original.setup, { ...custody }), {}), /not original Host custody/);
  original.bridge.bindAuthority(mint(original.setup, custody), {});
  assert.equal(calls, 2, "Core minting alone is never evidence of genuine Host custody");
});

test("constructor rejects counterfeit readers before filesystem access and a reopened Store cannot adopt the original reader", async t => {
  const pair = create();
  for (const reader of copies(pair.reader)) {
    assert.throws(() => new SqliteRunStore({ cwd: "/must-not-create-a-bridge-directory", originalOfficeHostBridge: reader }), code("host_office_local_bridge_invalid"));
  }
  const f = await directoryV2StoreFixture(t, { originalOfficeHostBridge: pair.reader });
  assert.throws(() => new SqliteRunStore({ cwd: f.cwd, originalOfficeHostBridge: pair.reader }), code("host_office_local_bridge_owner_invalid"));
});

test("real original SQLite binding gives Host a frozen owning record and permits nested read-only snapshots", async t => {
  let calls = 0;
  const f = await fixture(t, (current, custody, expected) => {
    calls++; assert.ok(custody);
    assert.deepEqual(expected, current.execution());
    assert.ok(Object.isFrozen(expected) && Object.isFrozen(expected.source) && Object.isFrozen(expected.members[0]));
    assert.throws(() => { expected.source.runId = "forged"; }, TypeError);
    assert.deepEqual(current.store.readSnapshot(() => current.store.readSnapshot(() => current.execution())), expected);
    assert.throws(() => current.store.database.exec("CREATE TABLE forbidden_bridge_write (value TEXT)"), /readonly/i);
  });
  const before = f.store.listHostOperationBlockers(f.source), authority = f.authority();
  f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, authority);
  assert.equal(calls, 1); assert.deepEqual(f.store.listHostOperationBlockers(f.source), before);
  assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), code("host_office_local_scope_binding_closed"));
  assert.throws(() => verifyHostOfficeReceipt(f.store.database, readHostOperation(f.store.database, f.parent.operationId)), code("host_office_local_directory_v2_safe_unavailable"));
  f.prepare(); // Binding is not an effect and does not block ordinary fact preparation.
});

test("copied/foreign ticket or channel authority never invokes the original endpoint", async t => {
  let calls = 0;
  const f = await fixture(t, () => { calls++; }), foreign = channel();
  for (const ticket of copies(f.ticket)) {
    assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(ticket, f.authority()), code("host_office_local_invalid_ticket"));
  }
  assert.throws(() => f.other.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), code("host_office_local_invalid_ticket"));
  for (const authority of [...copies(f.authority()), foreign.authority]) {
    assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, authority), code("host_office_local_authority_invalid"));
  }
  assert.equal(calls, 0); f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()); assert.equal(calls, 1);
});

test("replacement attempt owner rejects binding before calling Host", async t => {
  let calls = 0;
  const f = await fixture(t, () => { calls++; });
  f.store.createWorkUnitAttempt({ workUnitId: f.source.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: f.now() });
  assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), code("host_operation_stale_owner"));
  assert.equal(calls, 0);
});

test("entered or uncertain effects reject late binding while unbound native-only facts retain their behavior", async t => {
  for (const throws of [false, true]) {
    let calls = 0;
    const f = await fixture(t, () => { calls++; }), effect = f.prepare();
    if (throws) assert.throws(() => f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => { throw Error("effect unknown"); }), /effect unknown/);
    else f.store.launchHostOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => undefined);
    assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), code("host_office_local_scope_binding_closed"));
    assert.equal(calls, 0); assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
  }
});

test("binding reentry cannot mutate facts or seal a terminal and Host failure cannot reopen admission", async t => {
  let calls = 0;
  const f = await fixture(t, current => {
    calls++;
    assert.throws(() => current.prepare(), code("host_office_local_scope_binding_closed"));
    assert.throws(() => current.store.sealHostOfficeLocalDirectoryTerminalV2(current.ticket, {}), code("host_office_local_scope_binding_closed"));
    throw Error("original Host binding failed");
  });
  assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), /original Host binding failed/);
  assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), code("host_office_local_scope_binding_closed"));
  assert.throws(() => f.prepare(), code("host_office_local_scope_binding_closed"));
  assert.equal(calls, 1); assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

for (const commitFirst of [false, true]) test(`real outer COMMIT ${commitFirst ? "return loss" : "failure"} cannot make an entered binding reusable or effect-admissible`, async t => {
  let calls = 0;
  const f = await fixture(t, () => { calls++; }), exec = f.store.database.exec.bind(f.store.database);
  let injected = false, committed = false;
  f.store.database.exec = sql => {
    if (sql === "COMMIT" && !injected) {
      injected = true;
      if (commitFirst) { exec(sql); committed = true; }
      throw Error("binding COMMIT return lost");
    }
    return exec(sql);
  };
  try { assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), /binding COMMIT return lost|no transaction/i); }
  finally { f.store.database.exec = exec; }
  assert.equal(injected, true); assert.equal(committed, commitFirst); assert.equal(calls, 1);
  assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority()), code("host_office_local_scope_binding_closed"));
  assert.throws(() => f.prepare(), code("host_office_local_scope_binding_closed"));
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("retired original bridge rejects bound effects even when database close throws and remains open", async t => {
  const f = await fixture(t), close = f.store.database.close.bind(f.store.database);
  f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, f.authority());
  f.store.database.close = () => { throw Error("database close return lost"); };
  try { assert.throws(() => f.store.close(), /database close return lost/); }
  finally { f.store.database.close = close; }
  assert.equal(f.store.database.isOpen, true);
  assert.throws(() => f.prepare(), code("host_office_local_bridge_unavailable"));
  assert.throws(() => f.authority(), code("host_office_local_bridge_unavailable"));
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("default Store has no permissive bridge and closing the owning Store retires minting", async t => {
  const f = await directoryV2StoreFixture(t);
  assert.throws(() => f.store.bindHostOfficeLocalDirectoryScopeAuthorityV2(f.ticket, channel().authority), code("host_office_local_bridge_unavailable"));
  const owned = await fixture(t); owned.store.close();
  assert.throws(() => owned.authority(), code("host_office_local_bridge_unavailable"));
});

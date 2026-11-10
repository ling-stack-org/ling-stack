import assert from "node:assert/strict";
import test from "node:test";
import { createCodesignHostSimulation, SIMULATED_APP, SIMULATED_HELPER } from "./support/packaged-codesign-host-simulation-fixture.mjs";
import { isProtectedHostCommandArenaPath } from "../dist/runtime/sandbox/protected-host-domain-paths.js";

const close = (api, source) => api.closeOriginalPackagedCodesignIdentity(source);
const appHeld = f => [...f.descriptors.values()].filter(slot => slot.row.directory
  && (slot.path === SIMULATED_APP || SIMULATED_APP.startsWith(slot.path === "/" ? "/" : slot.path + "/")));
test("original codesign issuer source/record/custody mechanisms (synthetic, not Host certification)", async t => {
  await t.test("canonical record binds review and retains App ancestors while closing transient files", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
    const inventory = await f.loadInventory(), { ProtectedHostStageRegistry } = await f.loadRegistry();
    const source = api.prepareOriginalPackagedCodesignSource(), entry = api.readOriginalPackagedCodesignActorEntry();
    const record = api.createOriginalPackagedCodesignInvocation(source), registry = new ProtectedHostStageRegistry();
    registry.bindOriginalActorEntries([entry]);
    let commits = 0;
    const original = registry.commitOriginalHostProofBatch;
    t.mock.method(registry, "commitOriginalHostProofBatch", function (...args) { commits++; return Reflect.apply(original, this, args); });
    f.hooks.native = call => f.completed(call);
    assert.equal(entry.invoke(undefined, record).status, 0);
    assert.equal(f.nativeCalls.length, 1); assert.equal(commits, 1);
    close(api, source);
    assert.ok(appHeld(f).length > 0, "permanent original directory lifetimes stay retained after finally");
    assert.equal([...f.descriptors.values()].some(slot => slot.path === SIMULATED_HELPER), false);
    const late = new ProtectedHostStageRegistry(); late.bindOriginalActorEntries([entry]);
    assert.throws(() => entry.invoke(undefined, record), /record_invalid/u);
    assert.equal(inventory.readProtectedHostActorEntry(entry).entryId, "packaged_codesign");
    assert.throws(() => registry.assertActorInventoryCurrent(), /inventory_incomplete/u,
      "a codesign certificate is not the whole original source manifest");
  });
  await t.test("a later registry refusal does not commit or retain an earlier approved registry", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
    const { ProtectedHostStageRegistry } = await f.loadRegistry(), entry = api.readOriginalPackagedCodesignActorEntry();
    const first = new ProtectedHostStageRegistry(), second = new ProtectedHostStageRegistry();
    first.bindOriginalActorEntries([entry]); second.bindOriginalActorEntries([entry]);
    let commits = 0;
    t.mock.method(first, "commitOriginalHostProofBatch", () => { commits++; });
    const refusal = new Error("synthetic_second_registry_readonly_refusal");
    t.mock.method(second, "assertOriginalHostProofBatch", () => { throw refusal; });
    const source = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(source);
    assert.throws(() => entry.invoke(undefined, record), error => error === refusal);
    assert.equal(commits, 0); assert.equal(f.nativeCalls.length, 0);
    close(api, source); assert.equal(f.descriptors.size, 0);
    assert.throws(() => entry.invoke(undefined, record), /record_invalid/u);
    const late = new ProtectedHostStageRegistry(); late.bindOriginalActorEntries([entry]);
  });
  await t.test("same-name factory and public Run actor cannot borrow original source proof", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
    const inventory = await f.loadInventory(), source = api.prepareOriginalPackagedCodesignSource();
    const record = api.createOriginalPackagedCodesignInvocation(source), real = api.readOriginalPackagedCodesignActorEntry();
    const fake = inventory.defineProtectedHostActorEntry("packaged_codesign", () => undefined);
    assert.equal(api.readConsumedOriginalPackagedCodesignHostProof(fake, [record]), undefined);
    assert.throws(() => api.readConsumedOriginalPackagedCodesignHostProof(real, [record]), /record_invalid/u);
    assert.throws(() => real.invoke({}, record), /entry_invalid/u);
    assert.equal(f.nativeCalls.length, 0); close(api, source);
  });
  await t.test("runtime manifest corruption cannot be accepted as unsupported review", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true });
    f.alterPublishedReview(value => { value.manifestSha256 = "b".repeat(64); });
    const api = await f.loadSource(), source = api.prepareOriginalPackagedCodesignSource();
    const record = api.createOriginalPackagedCodesignInvocation(source), entry = api.readOriginalPackagedCodesignActorEntry();
    assert.throws(() => entry.invoke(undefined, record), /host_source_invalid/u);
    assert.equal(f.nativeCalls.length, 0); close(api, source); assert.equal(f.descriptors.size, 0);
  });
  await t.test("postlaunch helper drift with unchanged App inode irreversibly refuses late binding", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
    const { ProtectedHostStageRegistry } = await f.loadRegistry(), entry = api.readOriginalPackagedCodesignActorEntry();
    const source = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(source);
    const appInode = api.readOriginalPackagedCodesignSource(source).appIdentity.at(-1).inode;
    f.hooks.native = call => { const completed = f.completed(call); f.helper.bytes[0] ^= 1; return completed; };
    assert.throws(() => entry.invoke(undefined, record), /host_source_invalid|original_file_changed/u);
    assert.equal(f.nativeCalls.length, 1);
    assert.equal(appHeld(f).at(-1).row.ino.toString(), appInode);
    close(api, source);
    const late = new ProtectedHostStageRegistry();
    assert.throws(() => late.bindOriginalActorEntries([entry]), /host_source_invalid/u);
    assert.ok(appHeld(f).length > 0, "unknown permanent custody is not silently retired");
  });
  await t.test("transient identity cleanup failure irreversibly refuses retained proof late binding", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
    const { ProtectedHostStageRegistry } = await f.loadRegistry(), entry = api.readOriginalPackagedCodesignActorEntry();
    const source = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(source);
    f.hooks.native = call => f.completed(call); entry.invoke(undefined, record);
    f.hooks.close = slot => { if (slot.path === SIMULATED_HELPER) throw Object.assign(new Error("synthetic_close_EIO"), { code: "EIO" }); };
    assert.throws(() => close(api, source), /identity_close_unknown/u);
    const late = new ProtectedHostStageRegistry();
    assert.throws(() => late.bindOriginalActorEntries([entry]), /host_source_invalid/u);
    assert.ok(appHeld(f).length > 0, "unknown App custody is not silently retired after cleanup failure");
  });
  await t.test("normal inner failure and helper timeout do not imply integrity loss or retire custody", async t => {
    for (const outcome of ["inner_failure", "timeout"]) {
      await t.test(outcome, async t => {
        const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
        const { ProtectedHostStageRegistry } = await f.loadRegistry(), entry = api.readOriginalPackagedCodesignActorEntry();
        const source = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(source);
        f.hooks.native = call => outcome === "inner_failure" ? f.completed(call, { exitCode: 7 })
          : { pid: 987654, status: null, signal: "SIGKILL", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
            stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)] };
        const result = entry.invoke(undefined, record);
        if (outcome === "inner_failure") assert.equal(result.status, 7); else assert.equal(result.error.code, "ETIMEDOUT");
        close(api, source);
        const late = new ProtectedHostStageRegistry(); late.bindOriginalActorEntries([entry]);
        assert.ok(appHeld(f).length > 0);
      });
    }
  });
  await t.test("unknown App FD reuse remains sticky and never closes a foreign integer", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
    const { ProtectedHostStageRegistry } = await f.loadRegistry(), entry = api.readOriginalPackagedCodesignActorEntry();
    const source = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(source);
    f.hooks.native = call => f.completed(call); entry.invoke(undefined, record); close(api, source);
    const fd = appHeld(f).at(-1); f.replaceWithForeign(fd);
    const late = new ProtectedHostStageRegistry();
    assert.throws(() => late.bindOriginalActorEntries([entry]), /stage_identity_changed/u);
    assert.equal(f.closeCount(fd.fd), 0);
    assert.throws(() => late.bindOriginalActorEntries([entry]), /host_source_invalid/u);
  });
  await t.test("custody budget refuses new proof without evicting history or entering raw fallback", async t => {
    const f = await createCodesignHostSimulation(t, { reviewedPublication: true }), api = await f.loadSource();
    const { ProtectedHostStageRegistry } = await f.loadRegistry(), entry = api.readOriginalPackagedCodesignActorEntry();
    f.hooks.native = call => f.completed(call);
    for (let index = 0; index < 16; index++) {
      const source = api.prepareOriginalPackagedCodesignSource();
      entry.invoke(undefined, api.createOriginalPackagedCodesignInvocation(source)); close(api, source);
    }
    const before = f.nativeCalls.length, source = api.prepareOriginalPackagedCodesignSource();
    assert.throws(() => entry.invoke(undefined, api.createOriginalPackagedCodesignInvocation(source)), /host_source_invalid/u);
    assert.equal(f.nativeCalls.length, before); close(api, source);
    const late = new ProtectedHostStageRegistry(); late.bindOriginalActorEntries([entry]);
    assert.ok(appHeld(f).length >= 16);
  });
  t.diagnostic("All Host/native/review inputs are explicitly virtual. These tests prove binding and conservative lifetime mechanisms only, not signatures, native controls, published trust or packaged GUI acceptance.");
});
test("the permanent original App domain cannot inhabit a writable command arena", () => {
  for (const path of ["/private/tmp/ling-command-ABC123/workspace/Host.app",
    "/private/tmp/ling-command-ABC123/scratch/Parent/Host.app", "/private/tmp/ling-command-ABC123"]) {
    assert.equal(isProtectedHostCommandArenaPath(path), true);
  }
  assert.equal(isProtectedHostCommandArenaPath("/private/tmp/ling-command-ABC1234/Host.app"), false);
  assert.equal(isProtectedHostCommandArenaPath("/Applications/Host.app"), false);
  assert.equal(isProtectedHostCommandArenaPath("/private/tmp/ling-codesign-host-simulation/Host.app"), false);
});

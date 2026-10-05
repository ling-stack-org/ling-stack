/** Reviewed-addon bootstrap cleanup only; not portable test:ci or actor/safe issuance evidence. */
import assert from "node:assert/strict";
import { fstatSync, lstatSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assertOriginalStageDescriptorsClosed, closeFixtureReplacement, createNativeBootstrapFixture,
  observeBootstrapStageDescriptors } from "./support/office-local-native-bootstrap-fixture.mjs";

function displaceBeforeStageFacts(t, fixture) {
  const original = fixture.registry.readStageIdentityFacts.bind(fixture.registry);
  t.mock.method(fixture.registry, "readStageIdentityFacts", token => {
    const stage = fixture.stages.find(value => value.token === token), displaced = join(fixture.root, "displaced-stage");
    renameSync(stage.path, displaced);
    return original(token); // Real existing path assertion raises ENOENT/identity loss.
  });
  return join(fixture.root, "displaced-stage");
}

test("normal bootstrap retains original stage FDs until explicit close and never deletes the stage directory", t => {
  const fixture = createNativeBootstrapFixture(t);
  observeBootstrapStageDescriptors(({ created, acquired, closes }) => {
    const scope = fixture.runtime.bootstrapStage(fixture.input), facts = fixture.runtime.scopeFacts(scope);
    assert.deepEqual(created, [facts.stagePath]);
    assert.ok(acquired.length >= 4);
    assert.equal(fixture.closeAttempts.length, 0); assert.deepEqual(closes, []);
    for (const { fd } of acquired) assert.ok(fstatSync(fd).isDirectory());
    assert.equal(facts.scopeBinding, "unbound"); assert.equal(facts.coreSafe, false); assert.equal(facts.packaged, false);
    fixture.runtime.closeStage(scope);
    assert.deepEqual(fixture.closeAttempts, [fixture.stages[0].token]);
    assertOriginalStageDescriptorsClosed(acquired, closes);
    assert.ok(lstatSync(facts.stagePath).isDirectory());
    fixture.runtime.closeStage(scope); assert.equal(fixture.closeAttempts.length, 1);
    assert.throws(() => fixture.runtime.scopeFacts(scope), /office_local_native_scope_closed/u);
  });
});

test("post-register real stage displacement closes every original FD without deleting the moved directory", t => {
  const fixture = createNativeBootstrapFixture(t), displaced = displaceBeforeStageFacts(t, fixture);
  observeBootstrapStageDescriptors(({ acquired, closes }) => {
    let failure;
    assert.throws(() => { try { fixture.runtime.bootstrapStage(fixture.input); } catch (error) { failure = error; throw error; } },
      error => error.code === "ENOENT" || error.message === "protected_host_stage_identity_changed");
    assert.ok(!(failure instanceof AggregateError)); assert.equal(fixture.stages.length, 1);
    assert.deepEqual(fixture.closeAttempts, [fixture.stages[0].token]);
    assertOriginalStageDescriptorsClosed(acquired, closes);
    assert.ok(lstatSync(displaced).isDirectory());
    assert.throws(() => fixture.registry.assertStageCurrent(fixture.stages[0].token), /protected_host_stage_closed/u);
  });
});

test("source revocation between registration and scope facts cannot prevent original FD cleanup", t => {
  const fixture = createNativeBootstrapFixture(t), original = fixture.registry.readStageIdentityFacts.bind(fixture.registry);
  t.mock.method(fixture.registry, "readStageIdentityFacts", token => {
    fixture.store.markRunSucceeded(fixture.input.run.id, new Date().toISOString());
    return original(token);
  });
  observeBootstrapStageDescriptors(({ acquired, closes }) => {
    assert.throws(() => fixture.runtime.bootstrapStage(fixture.input), /protected_host_source_obsolete/u);
    assert.deepEqual(fixture.closeAttempts, [fixture.stages[0].token]);
    assertOriginalStageDescriptorsClosed(acquired, closes);
    assert.ok(lstatSync(fixture.stages[0].path).isDirectory());
  });
});

test("post-registration scope clone failure preserves its primary exception and releases originals", t => {
  const fixture = createNativeBootstrapFixture(t);
  fixture.register.mock.mockImplementation(value => {
    fixture.stagePaths.add(value.stagePath);
    const token = fixture.originalRegister(value); fixture.stages.push({ token, path: value.stagePath });
    fixture.input.run.taskSnapshot = { notCloneable: () => {} }; return token;
  });
  observeBootstrapStageDescriptors(({ acquired, closes }) => {
    assert.throws(() => fixture.runtime.bootstrapStage(fixture.input), error => error.name === "DataCloneError");
    assert.deepEqual(fixture.closeAttempts, [fixture.stages[0].token]);
    assertOriginalStageDescriptorsClosed(acquired, closes);
    assert.ok(lstatSync(fixture.stages[0].path).isDirectory());
  });
});

test("registration failure has no returned stage token to close and still preserves the created directory", t => {
  const fixture = createNativeBootstrapFixture(t);
  fixture.register.mock.mockImplementation(value => {
    fixture.stagePaths.add(value.stagePath);
    fixture.store.markRunSucceeded(fixture.input.run.id, new Date().toISOString());
    return fixture.originalRegister(value);
  });
  observeBootstrapStageDescriptors(({ acquired, closes }) => {
    assert.throws(() => fixture.runtime.bootstrapStage(fixture.input), /protected_host_source_obsolete/u);
    assert.deepEqual(fixture.closeAttempts, []); assert.deepEqual(fixture.stages, []);
    assert.deepEqual(acquired, []); assert.deepEqual(closes, []);
    assert.equal(fixture.stagePaths.size, 1);
    for (const path of fixture.stagePaths) assert.ok(lstatSync(path).isDirectory());
  });
});

test("unknown entered stage close preserves both errors, closes other originals and never retries a reused FD", t => {
  const fixture = createNativeBootstrapFixture(t), displaced = displaceBeforeStageFacts(t, fixture);
  observeBootstrapStageDescriptors(({ acquired, closes }) => {
    let failure;
    assert.throws(() => { try { fixture.runtime.bootstrapStage(fixture.input); } catch (error) { failure = error; throw error; } },
      error => error instanceof AggregateError && error.message === "office_local_native_bootstrap_cleanup_unknown");
    assert.equal(failure.errors.length, 2);
    assert.ok(failure.errors[0].code === "ENOENT" || failure.errors[0].message === "protected_host_stage_identity_changed");
    assert.equal(failure.errors[1].message, "protected_host_stage_close_unknown");
    assert.equal(failure.errors[1].errors[0].message, "fixture_stage_close_reply_unknown");
    assertOriginalStageDescriptorsClosed(acquired, closes);
    const original = acquired[0].fd, replacement = openSync(join(fixture.root, "replacement-fd"), "wx+", 0o600);
    try {
      assert.equal(replacement, original);
      assert.throws(() => fixture.registry.closeStage(fixture.stages[0].token), /protected_host_stage_close_unknown/u);
      assert.equal(closes.filter(value => value === original).length, 1);
      assert.ok(fstatSync(replacement).isFile());
      assert.ok(lstatSync(displaced).isDirectory());
    } finally { closeFixtureReplacement(replacement); }
  }, { closeFault: (fd, acquired) => fd === acquired[0]?.fd });
});

test("the real empty actor inventory still fails closed before stage creation without the test-only bypass", t => {
  const fixture = createNativeBootstrapFixture(t, { bypassInventory: false });
  observeBootstrapStageDescriptors(({ created, acquired, closes }) => {
    assert.throws(() => fixture.runtime.bootstrapStage(fixture.input), /protected_host_actor_inventory_incomplete/u);
    assert.deepEqual(created, []);
    assert.equal(fixture.stagePaths.size, 0); assert.deepEqual(fixture.stages, []);
    assert.deepEqual(acquired, []); assert.deepEqual(closes, []); assert.deepEqual(fixture.closeAttempts, []);
  });
});

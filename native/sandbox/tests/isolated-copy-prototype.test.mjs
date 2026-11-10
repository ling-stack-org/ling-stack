import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureIsolatedCopy, createIsolatedCopyFixture, importSingleFixtureChange, proposeIsolatedChanges } from "../prototypes/isolated-copy.mjs";

const put = (root, path, text) => writeFileSync(join(root, path), text, { flag: "wx" });
const read = (root, path) => readFileSync(join(root, path), "utf8");

test("fresh bytes split preexisting external and internal hardlink aliases", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.outside, "sentinel", "external-original");
  linkSync(join(fixture.outside, "sentinel"), join(fixture.origin, "app.js"));
  linkSync(join(fixture.origin, "app.js"), join(fixture.origin, "alias.js"));
  assert.equal(captureIsolatedCopy(fixture).fileCount, 2);
  for (const path of ["app.js", "alias.js"]) {
    assert.notEqual(statSync(join(fixture.origin, path)).ino, statSync(join(fixture.execution, path)).ino);
  }
  writeFileSync(join(fixture.execution, "app.js"), "changed");
  assert.equal(read(fixture.execution, "alias.js"), "external-original");
  assert.equal(read(fixture.origin, "app.js"), "external-original");
  assert.equal(read(fixture.outside, "sentinel"), "external-original");
});

test("a frozen single-file fixture import replaces the alias, never writes through it", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.outside, "sentinel", "original");
  linkSync(join(fixture.outside, "sentinel"), join(fixture.origin, "app.js"));
  captureIsolatedCopy(fixture);
  writeFileSync(join(fixture.execution, "app.js"), "replacement");
  const proposal = proposeIsolatedChanges(fixture);
  // A later untrusted change cannot replace the already-frozen import bytes.
  writeFileSync(join(fixture.execution, "app.js"), "late-output");
  assert.equal(importSingleFixtureChange(fixture, proposal).productionReady, false);
  assert.equal(read(fixture.origin, "app.js"), "replacement");
  assert.equal(read(fixture.outside, "sentinel"), "original");
  assert.throws(() => importSingleFixtureChange(fixture, proposal), /fixture_proposal_invalid/);
});

test("a user edit since capture conflicts without overwriting the user's bytes", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.origin, "app.js", "base");
  captureIsolatedCopy(fixture);
  writeFileSync(join(fixture.execution, "app.js"), "agent");
  const proposal = proposeIsolatedChanges(fixture);
  writeFileSync(join(fixture.origin, "app.js"), "user");
  assert.throws(() => importSingleFixtureChange(fixture, proposal), /fixture_source_conflict/);
  assert.equal(read(fixture.origin, "app.js"), "user");
});

test("same-byte replacement still conflicts on original identity", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.origin, "app.js", "base");
  captureIsolatedCopy(fixture);
  writeFileSync(join(fixture.execution, "app.js"), "agent");
  const proposal = proposeIsolatedChanges(fixture);
  put(fixture.origin, "new.js", "base");
  renameSync(join(fixture.origin, "new.js"), join(fixture.origin, "app.js"));
  assert.throws(() => importSingleFixtureChange(fixture, proposal), /fixture_source_conflict/);
});

test("two proposals cannot silently overwrite the first accepted fixture change", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.origin, "app.js", "base");
  captureIsolatedCopy(fixture);
  writeFileSync(join(fixture.execution, "app.js"), "agent-a");
  const first = proposeIsolatedChanges(fixture);
  writeFileSync(join(fixture.execution, "app.js"), "agent-b");
  const second = proposeIsolatedChanges(fixture);
  importSingleFixtureChange(fixture, first);
  assert.throws(() => importSingleFixtureChange(fixture, second), /fixture_source_conflict/);
  assert.equal(read(fixture.origin, "app.js"), "agent-a");
});

test("foreign and fabricated proposal objects cannot be imported", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.origin, "app.js", "base");
  captureIsolatedCopy(fixture);
  writeFileSync(join(fixture.execution, "app.js"), "agent");
  const proposal = proposeIsolatedChanges(fixture);
  assert.throws(() => importSingleFixtureChange(fixture, { ...proposal }), /fixture_proposal_invalid/);
  assert.throws(() => importSingleFixtureChange(createIsolatedCopyFixture(), proposal), /fixture_proposal_invalid/);
  assert.equal(read(fixture.origin, "app.js"), "base");
});

test("input and output symlinks are explicitly unsupported, never silently dereferenced", () => {
  for (const beforeCapture of [true, false]) {
    const fixture = createIsolatedCopyFixture();
    put(fixture.outside, "sentinel", "external");
    if (beforeCapture) {
      symlinkSync(join(fixture.outside, "sentinel"), join(fixture.origin, "link"));
      assert.throws(() => captureIsolatedCopy(fixture), /fixture_symlink_unsupported/);
    } else {
      captureIsolatedCopy(fixture);
      symlinkSync(join(fixture.outside, "sentinel"), join(fixture.execution, "link"));
      assert.throws(() => proposeIsolatedChanges(fixture), /fixture_symlink_unsupported/);
    }
    assert.equal(read(fixture.outside, "sentinel"), "external");
  }
});

test("replaced origin directory and duplicate capture are rejected", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.origin, "app.js", "base");
  captureIsolatedCopy(fixture);
  assert.throws(() => captureIsolatedCopy(fixture), /fixture_already_captured/);
  renameSync(fixture.origin, fixture.origin + "-saved");
  mkdirSync(fixture.origin, { mode: 0o700 });
  assert.throws(() => proposeIsolatedChanges(fixture), /fixture_directory_changed/);
});

test("multiple changes remain review-only and cannot partially import", () => {
  const fixture = createIsolatedCopyFixture();
  for (const path of ["a.js", "b.js"]) put(fixture.origin, path, "base");
  captureIsolatedCopy(fixture);
  for (const path of ["a.js", "b.js"]) writeFileSync(join(fixture.execution, path), "agent");
  const proposal = proposeIsolatedChanges(fixture);
  assert.equal(proposal.changes.length, 2);
  assert.throws(() => importSingleFixtureChange(fixture, proposal), /fixture_single_change_only/);
  for (const path of ["a.js", "b.js"]) assert.equal(read(fixture.origin, path), "base");
});

test("nested source and output text retain newlines and code bytes", () => {
  const fixture = createIsolatedCopyFixture();
  mkdirSync(join(fixture.origin, "src"));
  put(fixture.origin, "src/app.js", "const a = 1;\n\nconsole.log(a);\n");
  captureIsolatedCopy(fixture);
  assert.equal(read(fixture.execution, "src/app.js"), read(fixture.origin, "src/app.js"));
  writeFileSync(join(fixture.execution, "src/app.js"), "const a = 2;\n\nconsole.log(a);\n");
  const proposal = proposeIsolatedChanges(fixture);
  assert.deepEqual(proposal.changes.map(change => change.path), ["src/app.js"]);
  importSingleFixtureChange(fixture, proposal);
  assert.equal(read(fixture.origin, "src/app.js"), "const a = 2;\n\nconsole.log(a);\n");
});

test("unknown sessions and pre-capture proposals reject without side effects", () => {
  assert.throws(() => captureIsolatedCopy({}), /unknown_fixture/);
  assert.throws(() => proposeIsolatedChanges(createIsolatedCopyFixture()), /fixture_not_captured/);
});

test("oversized input is rejected before it can be treated as a ready execution copy", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.origin, "large", Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => captureIsolatedCopy(fixture), /fixture_file_unsupported/);
  assert.throws(() => proposeIsolatedChanges(fixture), /fixture_not_captured/);
});

test("a prepopulated execution directory is never reused", () => {
  const second = createIsolatedCopyFixture();
  put(second.execution, "unexpected", "existing");
  assert.throws(() => captureIsolatedCopy(second), /fixture_already_captured/);
  assert.equal(read(second.execution, "unexpected"), "existing");
});

test("new files are proposed but the limited fixture importer cannot publish them", () => {
  const fixture = createIsolatedCopyFixture();
  captureIsolatedCopy(fixture);
  put(fixture.execution, "created", "result");
  const proposal = proposeIsolatedChanges(fixture);
  assert.equal(proposal.changes[0].kind, "create");
  assert.throws(() => importSingleFixtureChange(fixture, proposal), /fixture_replace_only/);
  assert.throws(() => read(fixture.origin, "created"), { code: "ENOENT" });
});

test("an identical tree has no changes and an empty proposal cannot import", () => {
  const fixture = createIsolatedCopyFixture();
  put(fixture.origin, "unchanged", "base");
  captureIsolatedCopy(fixture);
  const proposal = proposeIsolatedChanges(fixture);
  assert.deepEqual(proposal.changes, []);
  assert.throws(() => importSingleFixtureChange(fixture, proposal), /fixture_single_change_only/);
});

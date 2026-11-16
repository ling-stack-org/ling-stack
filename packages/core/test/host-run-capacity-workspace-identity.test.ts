import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { captureHostRunCapacityWorkspaceIdentity, isCurrentHostRunCapacityWorkspaceIdentity,
  openHostCapacityWorkspaceDatabase, isHostCapacityWorkspaceDatabaseConnectionCurrent }
  from "../dist/host-run-capacity-workspace-identity.js";

type IdentityInput = Parameters<typeof captureHostRunCapacityWorkspaceIdentity>[0];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ling-host-capacity-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"), state = join(root, "state");
  mkdirSync(cwd);
  mkdirSync(state);
  const databasePath = join(state, "workspace.sqlite");
  writeFileSync(databasePath, "workspace-database");
  const input = { workspaceId: "workspace-default", cwd, databasePath };
  return { root, input, capture: (overrides: Partial<IdentityInput> = {}) => captureHostRunCapacityWorkspaceIdentity({ ...input, ...overrides }) };
}

test("capacity workspace identity is immutable and stable across directory and database symlink aliases", t => {
  const f = fixture(t), cwdAlias = join(f.root, "workspace-alias"), databaseAlias = join(f.root, "database-alias");
  symlinkSync(f.input.cwd, cwdAlias, "dir");
  symlinkSync(f.input.databasePath, databaseAlias, "file");
  const original = f.capture(), alias = f.capture({ cwd: cwdAlias, databasePath: databaseAlias });
  assert.deepEqual(alias, original);
  assert.match(original.workspaceKey, /^[0-9a-f]{64}$/u);
  assert.match(original.databaseFileIdentity, /^\d+:\d+$/u);
  assert.ok(Object.isFrozen(original));
  assert.ok(isCurrentHostRunCapacityWorkspaceIdentity(original));
  assert.throws(() => {
    // @ts-expect-error Deliberately mutate an immutable captured identity.
    original.workspaceKey = "another-key";
  }, TypeError);
});

test("database contents may change without granting another workspace identity", t => {
  const f = fixture(t), before = f.capture();
  writeFileSync(f.input.databasePath, "legitimate-sqlite-content-update");
  assert.deepEqual(f.capture(), before);
  assert.ok(isCurrentHostRunCapacityWorkspaceIdentity(before));
});

test("replacing a database at the same pathname invalidates its original capacity identity", t => {
  const f = fixture(t), before = f.capture(), replacement = join(f.root, "replacement.sqlite");
  copyFileSync(f.input.databasePath, replacement);
  renameSync(replacement, f.input.databasePath);
  const after = f.capture();
  assert.notEqual(after.databaseFileIdentity, before.databaseFileIdentity);
  assert.notEqual(after.workspaceKey, before.workspaceKey);
  assert.equal(isCurrentHostRunCapacityWorkspaceIdentity(before), false);
  assert.ok(isCurrentHostRunCapacityWorkspaceIdentity(after));
});

test("a moved original file does not validate a new database at its former path", t => {
  const f = fixture(t), before = f.capture();
  renameSync(f.input.databasePath, join(f.root, "retained.sqlite"));
  writeFileSync(f.input.databasePath, "workspace-database");
  assert.equal(isCurrentHostRunCapacityWorkspaceIdentity(before), false);
});

test("a retargeted path alias cannot validate a canonical receipt", t => {
  const f = fixture(t), original = f.capture(), second = join(f.root, "second.sqlite");
  writeFileSync(second, "second-workspace-database");
  renameSync(f.input.databasePath, join(f.root, "retained.sqlite"));
  symlinkSync(second, f.input.databasePath, "file");
  assert.equal(isCurrentHostRunCapacityWorkspaceIdentity(original), false);
  assert.notEqual(f.capture().workspaceKey, original.workspaceKey);
});

test("workspace and database boundaries participate in capacity identity", t => {
  const f = fixture(t), original = f.capture(), secondCwd = join(f.root, "second-workspace");
  mkdirSync(secondCwd);
  assert.notEqual(f.capture({ workspaceId: "other-workspace" }).workspaceKey, original.workspaceKey);
  assert.notEqual(f.capture({ cwd: secondCwd }).workspaceKey, original.workspaceKey);
  const secondDatabase = join(f.root, "second.sqlite");
  copyFileSync(f.input.databasePath, secondDatabase);
  assert.notEqual(f.capture({ databasePath: secondDatabase }).workspaceKey, original.workspaceKey);
});

test("hard-linked database aliases fail closed instead of creating independent pathname identities", t => {
  const f = fixture(t), original = f.capture(), alias = join(f.root, "database-hard-link");
  linkSync(f.input.databasePath, alias);
  assert.throws(() => f.capture(), /workspace_identity_unsupported/u);
  assert.throws(() => f.capture({ databasePath: alias }), /workspace_identity_unsupported/u);
  assert.equal(isCurrentHostRunCapacityWorkspaceIdentity(original), false);
});

test("missing paths, directories in place of databases and files in place of cwd do not validate", t => {
  const f = fixture(t), original = f.capture();
  assert.throws(() => f.capture({ databasePath: f.input.cwd }), /workspace_identity_unsupported/u);
  assert.throws(() => f.capture({ cwd: f.input.databasePath }), /workspace_identity_unsupported/u);
  rmSync(f.input.databasePath);
  assert.equal(isCurrentHostRunCapacityWorkspaceIdentity(original), false);
  assert.throws(() => f.capture());
});

test("workspace identity rejects relative, empty and non-string inputs", t => {
  const f = fixture(t);
  for (const invalid of [null, {}, { cwd: "relative" }, { databasePath: "relative.sqlite" },
    { workspaceId: "" }, { workspaceId: " " }, { workspaceId: 7 }, { databasePath: "\0" }, { cwd: false }]) {
    assert.throws(() => invalid === null
      // @ts-expect-error Exercise null identity input validation.
      ? captureHostRunCapacityWorkspaceIdentity(null)
      // @ts-expect-error Exercise missing required identity fields.
      : invalid && Object.keys(invalid).length === 0 ? captureHostRunCapacityWorkspaceIdentity({}) : f.capture(invalid as Partial<IdentityInput>), TypeError);
  }
});

test("changed credential fields are not accepted as the captured physical identity", t => {
  const f = fixture(t), original = f.capture();
  for (const overrides of [{ workspaceKey: "a".repeat(64) }, { databaseFileIdentity: "1:2" },
    { workspaceId: "another-workspace" }, { canonicalCwd: "relative" }, { databasePath: "relative.sqlite" }]) {
    assert.equal(isCurrentHostRunCapacityWorkspaceIdentity({ ...original, ...overrides }), false);
  }
  // @ts-expect-error A null credential must fail closed at runtime.
  assert.equal(isCurrentHostRunCapacityWorkspaceIdentity(null), false);
});

test("tracked SQLite open creates a database and binds its connection to the original inode", t => {
  const f = fixture(t), databasePath = join(f.root, "new.sqlite");
  const database = openHostCapacityWorkspaceDatabase(databasePath);
  t.after(() => database.close());
  database.exec("CREATE TABLE observed(value TEXT)");
  const identity = f.capture({ databasePath });
  assert.ok(isHostCapacityWorkspaceDatabaseConnectionCurrent(database, identity));
  database.exec("INSERT INTO observed VALUES('same-file')");
  assert.ok(isHostCapacityWorkspaceDatabaseConnectionCurrent(database, identity));
});

test("a new credential for a replaced database cannot rebind the old SQLite connection", t => {
  const f = fixture(t), databasePath = join(f.root, "open.sqlite");
  const original = openHostCapacityWorkspaceDatabase(databasePath);
  t.after(() => original.close());
  original.exec("CREATE TABLE observed(value TEXT)");
  const before = f.capture({ databasePath });
  renameSync(databasePath, join(f.root, "retained.sqlite"));
  const replacement = openHostCapacityWorkspaceDatabase(databasePath);
  t.after(() => replacement.close());
  replacement.exec("CREATE TABLE observed(value TEXT)");
  const after = f.capture({ databasePath });
  assert.notEqual(before.workspaceKey, after.workspaceKey);
  assert.equal(isHostCapacityWorkspaceDatabaseConnectionCurrent(original, before), false);
  assert.equal(isHostCapacityWorkspaceDatabaseConnectionCurrent(original, after), false);
  assert.ok(isHostCapacityWorkspaceDatabaseConnectionCurrent(replacement, after));
});

test("an untracked connection cannot claim a pathname credential, even for a valid current file", t => {
  const f = fixture(t), databasePath = join(f.root, "untracked.sqlite"), database = new DatabaseSync(databasePath);
  t.after(() => database.close());
  assert.equal(isHostCapacityWorkspaceDatabaseConnectionCurrent(database, f.capture({ databasePath })), false);
});

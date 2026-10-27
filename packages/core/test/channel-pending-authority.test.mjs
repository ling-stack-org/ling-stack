import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as core from "../dist/index.js";
import { applyChannelPendingAuthorityMigration } from "../dist/storage/sqlite/channel-pending-authority.js";

const now = "2026-10-28T04:00:00.000Z";
const owner = "teammate_builtin_qa";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ling-pending-authority-"));
  const cwd = join(directory, "workspace");
  const paths = core.resolveStoragePaths(cwd, { homeDir: join(directory, "isolated-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store = core.createSqliteRunStore(cwd, paths);
  t.after(async () => { if (store.database.isOpen) store.close(); await rm(directory, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Isolated authority", boundPath: cwd, allowedTools: ["read", "bash"] }, now);
  store.replaceTeammateChannelMemberships(owner, [{ channelId: channel.id }], now);
  const input = { workspaceId: core.DEFAULT_WORKSPACE_ID, channelId: channel.id, participantIds: [owner, core.LING_AGENT_ID] };
  return { channel, input, paths, cwd, get store() { return store; },
    read: () => store.getChannelPendingAuthorityVersions(input),
    reopen() { store.close(); store = core.createSqliteRunStore(cwd, paths); } };
}

test("production port reads exact scoped durable versions, includes Ling, and never changes data", async t => {
  const f = await fixture(t);
  assert.equal(typeof f.store.getChannelPendingAuthorityVersions, "function");
  const before = f.store.database.prepare("SELECT total_changes() AS count").get().count;
  const first = f.read();
  assert.deepEqual(first.participants.map(row => row.participantId), [...f.input.participantIds].sort());
  for (const revision of [first.workspaceRevision, first.channelRevision, ...first.participants.map(row => row.revision)]) {
    assert(Number.isSafeInteger(revision) && revision >= 0);
  }
  assert.deepEqual(f.read(), first);
  assert.equal(f.store.database.prepare("SELECT total_changes() AS count").get().count, before);
  f.reopen(); assert.deepEqual(f.read(), first);
});

test("same timestamp permission ABA advances durable workspace authority across reopen", async t => {
  const f = await fixture(t), before = f.read(), old = f.store.getWorkspaceSettings();
  f.store.updateWorkspaceSettings({ defaultAuthorizationMode: "ask", defaultWorkspaceAccessMode: "read_only" }, now);
  f.store.updateWorkspaceSettings({ defaultAuthorizationMode: old.defaultAuthorizationMode,
    defaultWorkspaceAccessMode: old.defaultWorkspaceAccessMode }, now);
  f.reopen();
  assert.equal(f.read().workspaceRevision, before.workspaceRevision + 2);
});

test("first theme write and equal permissions are no-ops for authority", async t => {
  const f = await fixture(t), before = f.read(), old = f.store.getWorkspaceSettings();
  f.store.updateWorkspaceSettings({ theme: "dark" }, now);
  f.store.updateWorkspaceSettings({ defaultAuthorizationMode: old.defaultAuthorizationMode,
    defaultWorkspaceAccessMode: old.defaultWorkspaceAccessMode }, now);
  f.reopen(); assert.deepEqual(f.read(), before);
});

for (const scope of ["channel", "approval", "participant", "membership"]) {
  test(`same timestamp ${scope} ABA is durable and scoped`, async t => {
    const f = await fixture(t), before = f.read();
    if (scope === "channel") {
      f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, now);
      f.store.updateChannel(f.channel.id, { allowedTools: ["read", "bash"] }, now);
    } else if (scope === "approval") {
      const old = f.store.getApprovalPolicy();
      f.store.updateApprovalPolicy({ toolDecisions: { bash: "deny" } }, old.updatedAt);
      f.store.updateApprovalPolicy({ toolDecisions: old.toolDecisions }, old.updatedAt);
    } else if (scope === "participant") {
      const old = f.store.getAiTeammate(owner);
      f.store.updateAiTeammate(owner, { allowedTools: ["read"] }, old.updatedAt);
      f.store.updateAiTeammate(owner, { allowedTools: old.allowedTools }, old.updatedAt);
    } else {
      f.store.replaceTeammateChannelMemberships(owner, [], now);
      f.store.replaceTeammateChannelMemberships(owner, [{ channelId: f.channel.id }], now);
    }
    f.reopen(); const after = f.read();
    if (scope === "approval") assert.equal(after.workspaceRevision, before.workspaceRevision + 2);
    else if (scope === "participant") assert.equal(after.participants.find(row => row.participantId === owner).revision,
      before.participants.find(row => row.participantId === owner).revision + 2);
    else assert(after.channelRevision >= before.channelRevision + 2);
  });
}

test("timestamp-only and exact-value updates do not advance channel, policy, participant or membership", async t => {
  const f = await fixture(t), before = f.read();
  f.store.updateChannel(f.channel.id, {}, now);
  f.store.updateApprovalPolicy({}, now);
  f.store.updateAiTeammate(owner, {}, now);
  f.store.database.prepare("UPDATE teammate_channel_memberships SET is_default=is_default,updated_at=? WHERE channel_id=?").run(now, f.channel.id);
  f.reopen(); assert.deepEqual(f.read(), before);
});

test("the same transaction rolls authority back with policy changes", async t => {
  const f = await fixture(t), before = f.read();
  f.store.database.exec("BEGIN IMMEDIATE");
  f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, now);
  f.store.updateWorkspaceSettings({ defaultAuthorizationMode: "ask", defaultWorkspaceAccessMode: "read_only" }, now);
  assert(f.read().channelRevision > before.channelRevision);
  assert(f.read().workspaceRevision > before.workspaceRevision);
  f.store.database.exec("ROLLBACK");
  assert.deepEqual(f.read(), before);
  assert.deepEqual(f.store.getChannel(f.channel.id).allowedTools, ["read", "bash"]);
  f.reopen(); assert.deepEqual(f.read(), before);
});

test("unrelated channel and participant changes cannot invalidate the selected owner closure", async t => {
  const f = await fixture(t), before = f.read();
  const other = f.store.createChannel({ name: "Unrelated", boundPath: f.cwd }, now);
  f.store.updateChannel(other.id, { allowedTools: ["read", "bash"] }, now);
  f.store.updateAiTeammate("teammate_builtin_engineer", { appendSystemPrompt: ["Unrelated fixture"] }, now);
  assert.deepEqual(f.read(), before);
  const duplicated = f.store.getChannelPendingAuthorityVersions({ ...f.input, participantIds: [...f.input.participantIds, owner] });
  assert.deepEqual(duplicated, before);
});

test("channel delete/recreate retains its tombstone and cannot reset authority to zero", async t => {
  const f = await fixture(t), before = f.read();
  assert.equal(f.store.deleteChannel(f.channel.id), true);
  const tombstone = f.store.database.prepare("SELECT revision FROM channel_pending_authority_versions WHERE scope='channel' AND owner_id=?").get(f.channel.id);
  assert(tombstone.revision > before.channelRevision);
  assert.throws(f.read, /channel_pending_authority/u);
  f.store.createChannel({ id: f.channel.id, name: "Recreated", boundPath: f.cwd, allowedTools: ["read", "bash"] }, now);
  f.store.replaceTeammateChannelMemberships(owner, [{ channelId: f.channel.id }], now);
  assert(f.read().channelRevision > tombstone.revision);
  f.reopen(); assert(f.read().channelRevision > before.channelRevision);
});

test("participant delete/recreate retains revision independently of current values", async t => {
  const f = await fixture(t), before = f.read();
  const row = f.store.database.prepare("SELECT * FROM ai_teammates WHERE id=?").get(owner);
  f.store.database.prepare("DELETE FROM ai_teammates WHERE id=?").run(owner);
  const tombstone = f.store.database.prepare("SELECT revision FROM channel_pending_authority_versions WHERE scope='participant' AND owner_id=?").get(owner);
  assert(tombstone.revision > before.participants.find(value => value.participantId === owner).revision);
  assert.throws(f.read, /channel_pending_authority/u);
  const columns = Object.keys(row);
  f.store.database.prepare(`INSERT INTO ai_teammates(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]));
  const value = f.read().participants.find(value => value.participantId === owner);
  assert(value.revision > tombstone.revision);
});

test("protocol override delete/recreate and real config updates advance channel authority", async t => {
  const f = await fixture(t);
  const input = { channelId: f.channel.id, defaultWorkflowPreference: "manual", visibleMultiReplyMaxParticipants: 3,
    privacyRules: [], reviewRules: [], updatedBy: "local-user" };
  const before = f.read();
  f.store.upsertChannelCollaborationProtocolOverride(input, now);
  const inserted = f.read(); assert(inserted.channelRevision > before.channelRevision);
  f.store.upsertChannelCollaborationProtocolOverride({ ...input, privacyRules: ["narrow"] }, now);
  f.store.upsertChannelCollaborationProtocolOverride(input, now);
  assert(f.read().channelRevision > inserted.channelRevision);
  const prior = f.read();
  f.store.deleteChannelCollaborationProtocolOverride(f.channel.id);
  f.store.upsertChannelCollaborationProtocolOverride(input, now);
  assert(f.read().channelRevision >= prior.channelRevision + 2);
  f.reopen(); assert(f.read().channelRevision > prior.channelRevision);
});

for (const change of ["policy", "member", "status"]) test(`referenced council ${change} ABA advances only referencing channels`, async t => {
  const f = await fixture(t);
  const council = f.store.createAiCouncil({ displayName: "Referenced fixture", description: "Only isolated channels" }, now);
  f.store.replaceAiCouncilMembers(council.id, [{ teammateId: owner, enabled: true }], now);
  f.store.upsertChannelCouncilPolicy(f.channel.id, { attachedCouncilIds: [council.id], preferredCouncilId: council.id }, now);
  const before = f.read();
  const other = f.store.createChannel({ name: "Not attached", boundPath: f.cwd }, now);
  const otherInput = { ...f.input, channelId: other.id, participantIds: [core.LING_AGENT_ID] };
  const otherBefore = f.store.getChannelPendingAuthorityVersions(otherInput);
  if (change === "policy") {
    f.store.upsertChannelCouncilPolicy(f.channel.id, { attachedCouncilIds: [], preferredCouncilId: null }, now);
    f.store.upsertChannelCouncilPolicy(f.channel.id, { attachedCouncilIds: [council.id], preferredCouncilId: council.id }, now);
  } else if (change === "member") {
    f.store.replaceAiCouncilMembers(council.id, [], now);
    f.store.replaceAiCouncilMembers(council.id, [{ teammateId: owner, enabled: true }], now);
  } else {
    f.store.updateAiCouncil(council.id, { status: "paused" }, now);
    f.store.updateAiCouncil(council.id, { status: council.status }, now);
  }
  f.reopen();
  assert(f.read().channelRevision > before.channelRevision);
  assert.deepEqual(f.store.getChannelPendingAuthorityVersions(otherInput), otherBefore);
});

test("safe-integer exhaustion rejects and rolls back the business write", async t => {
  const f = await fixture(t);
  f.store.database.prepare("UPDATE channel_pending_authority_versions SET revision=? WHERE scope='channel' AND owner_id=?")
    .run(Number.MAX_SAFE_INTEGER, f.channel.id);
  const before = f.store.getChannel(f.channel.id);
  assert.throws(() => f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, now), /CHECK constraint failed/u);
  assert.deepEqual(f.store.getChannel(f.channel.id), before);
  assert.equal(f.read().channelRevision, Number.MAX_SAFE_INTEGER);
});

for (const value of [-1, 1.5, "corrupt"]) test(`corrupt revision ${value} fails closed without resetting it`, async t => {
  const f = await fixture(t);
  f.store.database.exec("PRAGMA ignore_check_constraints=ON");
  f.store.database.prepare("UPDATE channel_pending_authority_versions SET revision=? WHERE scope='channel' AND owner_id=?").run(value, f.channel.id);
  f.store.database.exec("PRAGMA ignore_check_constraints=OFF");
  assert.throws(f.read, /channel_pending_authority/u);
  assert.equal(f.store.database.prepare("SELECT revision FROM channel_pending_authority_versions WHERE scope='channel' AND owner_id=?").get(f.channel.id).revision, value);
});

for (const corrupt of ["missing owner revision", "missing trigger", "drifted trigger", "missing table", "missing marker", "conflicting marker"]) {
  test(`${corrupt} is refused, not silently repaired on read or reopen`, async t => {
    const f = await fixture(t);
    if (corrupt === "missing owner revision") f.store.database.prepare("DELETE FROM channel_pending_authority_versions WHERE scope='channel' AND owner_id=?").run(f.channel.id);
    else if (corrupt === "missing trigger") f.store.database.exec("DROP TRIGGER pending_authority_channel_update");
    else if (corrupt === "drifted trigger") f.store.database.exec("DROP TRIGGER pending_authority_channel_update; CREATE TRIGGER pending_authority_channel_update AFTER UPDATE ON channels BEGIN SELECT 1; END");
    else if (corrupt === "missing table") f.store.database.exec("DROP TABLE channel_pending_authority_versions");
    else if (corrupt === "missing marker") f.store.database.exec("DELETE FROM schema_migrations WHERE version=192");
    else f.store.database.exec("UPDATE schema_migrations SET name='conflicting_authority_fixture' WHERE version=192");
    assert.throws(f.read, /channel_pending_authority/u);
    if (corrupt === "missing owner revision") { f.reopen(); assert.throws(f.read, /channel_pending_authority/u); }
    else assert.throws(f.reopen, /channel_pending_authority/u);
  });
}

test("unknown or foreign owners never produce a usable partial authority snapshot", async t => {
  const f = await fixture(t);
  for (const input of [{ ...f.input, workspaceId: "foreign-workspace" }, { ...f.input, channelId: "missing-channel" },
    { ...f.input, participantIds: ["missing-agent"] }, { ...f.input, participantIds: [] },
    { ...f.input, participantIds: [owner, " "] }]) {
    assert.throws(() => f.store.getChannelPendingAuthorityVersions(input), /channel_pending_authority/u);
  }
});

function migrationInput(database) {
  return { database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(version, name, now) };
}

function removeIsolatedAuthorityMigration(database) {
  for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'pending_authority_*'").all()) {
    database.exec(`DROP TRIGGER ${name}`);
  }
  database.exec("DROP TABLE channel_pending_authority_versions; DELETE FROM schema_migrations WHERE version=192");
}

function businessRows(database) {
  return Object.fromEntries(["workspaces", "channels", "ai_teammates", "workspace_settings", "approval_policies", "teammate_channel_memberships",
    "channel_collaboration_protocols", "channel_council_policies", "ai_councils", "ai_council_members"].map(table =>
    [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test("migration backfills pre-existing owners at zero without changing business data or older markers", async t => {
  const f = await fixture(t);
  f.store.updateWorkspaceSettings({ theme: "dark", defaultAuthorizationMode: "ask" }, now);
  removeIsolatedAuthorityMigration(f.store.database);
  const beforeRows = businessRows(f.store.database);
  const beforeMarkers = f.store.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  applyChannelPendingAuthorityMigration(migrationInput(f.store.database));
  const expected = [
    ...beforeRows.workspaces.map(row => ({ scope: "workspace", owner_id: row.id, revision: 0 })),
    ...beforeRows.channels.map(row => ({ scope: "channel", owner_id: row.id, revision: 0 })),
    ...beforeRows.ai_teammates.map(row => ({ scope: "participant", owner_id: row.id, revision: 0 })),
  ].sort((a, b) => `${a.scope}\0${a.owner_id}`.localeCompare(`${b.scope}\0${b.owner_id}`, "en"));
  const actual = f.store.database.prepare("SELECT scope,owner_id,revision FROM channel_pending_authority_versions").all()
    .map(row => ({ ...row })).sort((a, b) => `${a.scope}\0${a.owner_id}`.localeCompare(`${b.scope}\0${b.owner_id}`, "en"));
  assert.deepEqual(actual, expected);
  assert.deepEqual(businessRows(f.store.database), beforeRows);
  assert.deepEqual(f.store.database.prepare("SELECT * FROM schema_migrations WHERE version<>192 ORDER BY version").all(), beforeMarkers);
  assert.equal(f.store.database.prepare("SELECT name FROM schema_migrations WHERE version=192").get().name, "add_channel_pending_authority_versions");
  assert.deepEqual(f.read(), { workspaceRevision: 0, channelRevision: 0,
    participants: [...f.input.participantIds].sort().map(participantId => ({ participantId, revision: 0 })) });
  f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, now);
  const changed = f.read();
  applyChannelPendingAuthorityMigration({ ...migrationInput(f.store.database), recordMigration() { assert.fail("must not rewrite migration"); } });
  assert.deepEqual(f.read(), changed);
  f.reopen(); assert.deepEqual(f.read(), changed);
});

for (const fault of ["create-trigger", "record-before", "record-after", "marker-no-op"]) {
  test(`migration ${fault} failure rolls back schema, backfill and marker atomically`, async t => {
    const f = await fixture(t);
    removeIsolatedAuthorityMigration(f.store.database);
    const beforeRows = businessRows(f.store.database);
    const beforeMarkers = f.store.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const input = migrationInput(f.store.database);
    const database = fault === "create-trigger" ? new Proxy(f.store.database, {
      get(target, key) {
        if (key === "exec") return sql => {
          if (sql.includes("CREATE TRIGGER pending_authority_channel_update")) throw new Error("fixture-create-trigger-failure");
          return target.exec(sql);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) : f.store.database;
    assert.throws(() => applyChannelPendingAuthorityMigration({ ...input, database, recordMigration(version, name) {
      if (fault === "record-before") throw new Error("fixture-record-before-failure");
      if (fault !== "marker-no-op") input.recordMigration(version, name);
      if (fault === "record-after") throw new Error("fixture-record-after-failure");
    } }), /fixture-|channel_pending_authority/u);
    assert.deepEqual(f.store.database.prepare("SELECT name FROM sqlite_master WHERE name='channel_pending_authority_versions' OR name GLOB 'pending_authority_*'").all(), []);
    assert.deepEqual(f.store.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), beforeMarkers);
    assert.deepEqual(businessRows(f.store.database), beforeRows);
    applyChannelPendingAuthorityMigration(input);
    assert.equal(f.read().workspaceRevision, 0);
    assert.equal(f.read().channelRevision, 0);
  });
}

test("partial unmarked authority schema is refused without altering existing data", async t => {
  const f = await fixture(t);
  removeIsolatedAuthorityMigration(f.store.database);
  f.store.database.exec("CREATE TABLE channel_pending_authority_versions(legacy_value TEXT); INSERT INTO channel_pending_authority_versions VALUES('untouched')");
  const beforeRows = businessRows(f.store.database);
  const beforeSchema = f.store.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  const beforeMarkers = f.store.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.throws(() => applyChannelPendingAuthorityMigration(migrationInput(f.store.database)), /channel_pending_authority.schema_conflict/u);
  assert.deepEqual(f.store.database.prepare("SELECT * FROM channel_pending_authority_versions").all().map(row => ({ ...row })), [{ legacy_value: "untouched" }]);
  assert.deepEqual(businessRows(f.store.database), beforeRows);
  assert.deepEqual(f.store.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), beforeSchema);
  assert.deepEqual(f.store.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), beforeMarkers);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteRunStore } from "../dist/index.js";
import { SqliteTeammateAssociationStore } from "../dist/storage/sqlite/teammate-association-store.js";

for (const boundary of ["memberships", "scopes"]) {
  test(`default Memory scope bootstrap owns the write reservation before reading ${boundary}`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-memory-bootstrap-race-"));
    const store = createSqliteRunStore(cwd);
    const writer = createSqliteRunStore(cwd);
    t.after(async () => { writer.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
    const now = new Date().toISOString();
    const teammate = store.createAiTeammate({ roleKey: "engineer", displayName: "Bootstrap fixture", description: "Concurrent bootstrap fixture",
      approvalProfile: { mode: "standard" }, status: "active" }, now);
    const channel = store.createChannel({ name: "Bootstrap scope", boundPath: cwd }, now);
    store.replaceTeammateChannelMemberships(teammate.id, [{ channelId: channel.id, isDefault: false }], now);
    store.database.prepare("UPDATE teammate_memory_scopes SET enabled = 0 WHERE teammate_id = ?").run(teammate.id);
    writer.database.exec("PRAGMA busy_timeout=0");
    let attempted = false;
    let competingError;
    const match = boundary === "memberships" ? /SELECT channel_id FROM teammate_channel_memberships/ : /SELECT id, channel_id, kind/;
    // Both are real SQLite connections. Interleave a competing write exactly after the source SELECT.
    const database = new Proxy(store.database, { get(target, key) {
      if (key !== "prepare") { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; }
      return sql => {
        const statement = target.prepare(sql);
        if (!match.test(sql)) return statement;
        return new Proxy(statement, { get(stmt, member) {
          if (member !== "all") { const value = Reflect.get(stmt, member); return typeof value === "function" ? value.bind(stmt) : value; }
          return (...args) => {
            const result = stmt.all(...args);
            if (!attempted) {
              attempted = true;
              try {
                if (boundary === "memberships") writer.database.prepare("DELETE FROM teammate_channel_memberships WHERE teammate_id = ? AND channel_id = ?").run(teammate.id, channel.id);
                else writer.database.prepare("UPDATE ai_teammates SET updated_at = ? WHERE id = ?").run("2026-09-09T09:00:00.000Z", teammate.id);
              } catch (error) { competingError = error; }
            }
            return result;
          };
        } });
      };
    } });
    const associations = new SqliteTeammateAssociationStore({ database }, {
      hasTable: () => true, getAiTeammate: id => store.getAiTeammate(id), getChannel: id => store.getChannel(id),
    });
    assert.doesNotThrow(() => associations.ensureDefaultTeammateMemoryScopes(teammate.id, now));
    assert.equal(attempted, true);
    assert.equal(competingError?.errcode, 5, "competing write waits instead of invalidating the bootstrap read snapshot");
    const scopes = store.listTeammateMemoryScopes(teammate.id);
    assert.ok(scopes.length > 0);
    assert.ok(scopes.every(scope => scope.enabled));
    assert.ok(scopes.some(scope => scope.channelId === channel.id));
    // The reservation is released after commit; later membership changes are still respected.
    writer.database.prepare("DELETE FROM teammate_channel_memberships WHERE teammate_id = ? AND channel_id = ?").run(teammate.id, channel.id);
    associations.ensureDefaultTeammateMemoryScopes(teammate.id, now);
    assert.equal(store.listTeammateMemoryScopes(teammate.id).some(scope => scope.channelId === channel.id), false);
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, LING_AGENT_ID, LING_AGENT_SYSTEM_PROMPT, resolveStoragePaths } from "../dist/index.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-bootstrap-idempotence-"));
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const opened = [];
  t.after(async () => {
    for (const store of opened) if (store.database.isOpen) store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const open = () => { const store = createSqliteRunStore(cwd, paths); opened.push(store); return store; };
  return { open };
}

test("reopening an unchanged protected Ling profile preserves its entire stored row and authority revision", async t => {
  const f = await fixture(t), first = f.open();
  first.updateAiTeammate(LING_AGENT_ID, { displayName: "Personal Ling", appendSystemPrompt: ["Keep this personal input."] }, "2020-01-01T00:00:00.000Z");
  const before = first.database.prepare("SELECT * FROM ai_teammates WHERE id=?").get(LING_AGENT_ID);
  first.close();
  const second = f.open();
  assert.deepEqual(second.database.prepare("SELECT * FROM ai_teammates WHERE id=?").get(LING_AGENT_ID), before);
  assert.equal(second.getAiTeammate(LING_AGENT_ID).updatedAt, "2020-01-01T00:00:00.000Z");
});

test("reopening still repairs real protected-field drift and advances its revision once", async t => {
  const f = await fixture(t), first = f.open();
  // Corrupt only this isolated fixture to exercise the migration/repair path.
  first.database.prepare("UPDATE ai_teammates SET system_prompt=?,hidden=1,updated_at=? WHERE id=?")
    .run("obsolete protected prompt", "2020-01-01T00:00:00.000Z", LING_AGENT_ID);
  first.close();
  const second = f.open(), repaired = second.getAiTeammate(LING_AGENT_ID);
  assert.equal(repaired.systemPrompt, LING_AGENT_SYSTEM_PROMPT); assert.equal(repaired.hidden, false);
  assert.notEqual(repaired.updatedAt, "2020-01-01T00:00:00.000Z");
  const row = second.database.prepare("SELECT * FROM ai_teammates WHERE id=?").get(LING_AGENT_ID);
  second.close();
  const third = f.open();
  assert.deepEqual(third.database.prepare("SELECT * FROM ai_teammates WHERE id=?").get(LING_AGENT_ID), row);
});

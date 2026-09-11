import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "../src/storage/sqlite/read-snapshot.ts";

test("read snapshot pins WAL reads against another connection and restores write access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ling-n03-snapshot-test-"));
  const reader = new DatabaseSync(join(directory, "fixture.sqlite"));
  const writer = new DatabaseSync(join(directory, "fixture.sqlite"));
  t.after(async () => { writer.close(); reader.close(); await rm(directory, { recursive: true, force: true }); });
  reader.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts (value INTEGER); INSERT INTO facts VALUES (1)");
  const readValue = () => reader.prepare("SELECT value FROM facts").get().value;
  const captured = readSqliteSnapshot(reader, () => {
    const first = readValue();
    writer.exec("UPDATE facts SET value=2");
    return [first, readValue()];
  });
  assert.deepEqual(captured, [1, 1]);
  assert.equal(readValue(), 2);
  reader.exec("UPDATE facts SET value=3");
  assert.equal(readValue(), 3);
});

test("read snapshot rejects writes and async callbacks and releases the transaction on exceptions", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE facts (value INTEGER)");
    assert.throws(() => readSqliteSnapshot(database, () => database.exec("INSERT INTO facts VALUES (1)")), /readonly/i);
    assert.throws(() => readSqliteSnapshot(database, () => Promise.resolve(1)), /synchronous/i);
    assert.throws(() => readSqliteSnapshot(database, () => { throw new Error("read failed"); }), /read failed/);
    database.exec("INSERT INTO facts VALUES (2)");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM facts").get().count, 1);
    database.exec("PRAGMA query_only=ON");
    readSqliteSnapshot(database, () => 1);
    assert.throws(() => database.exec("INSERT INTO facts VALUES (3)"), /readonly/i);
  } finally { database.close(); }
});

test("nested read snapshots reuse the same WAL view and never end the outer transaction", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ling-nested-read-snapshot-"));
  const reader = new DatabaseSync(join(directory, "fixture.sqlite"));
  const writer = new DatabaseSync(join(directory, "fixture.sqlite"));
  t.after(async () => { writer.close(); reader.close(); await rm(directory, { recursive: true, force: true }); });
  reader.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts (value INTEGER); INSERT INTO facts VALUES (1)");
  const value = () => reader.prepare("SELECT value FROM facts").get().value;
  const captured = readSqliteSnapshot(reader, () => {
    const first = value();
    const inner = readSqliteSnapshot(reader, () => {
      writer.exec("UPDATE facts SET value=2");
      assert.throws(() => reader.exec("UPDATE facts SET value=3"), /readonly/i);
      return value();
    });
    assert.throws(() => readSqliteSnapshot(reader, () => { throw new Error("inner failed"); }), /inner failed/);
    assert.throws(() => reader.exec("UPDATE facts SET value=4"), /readonly/i);
    return [first, inner, value()];
  });
  assert.deepEqual(captured, [1, 1, 1]);
  assert.equal(value(), 2);
  reader.exec("UPDATE facts SET value=5");
  assert.equal(value(), 5);
});

test("snapshot nesting does not adopt or commit an unrelated caller-owned write transaction", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE facts (value INTEGER); BEGIN; INSERT INTO facts VALUES (1)");
    assert.throws(() => readSqliteSnapshot(database, () => 1), /transaction/i);
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM facts").get().count, 0);
    assert.equal(readSqliteSnapshot(database, () => readSqliteSnapshot(database, () => 7)), 7);
  } finally { database.close(); }
});

test("explicit Host launch read window permits nested evidence reads without writing or committing its owner", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE facts (value INTEGER); BEGIN IMMEDIATE; INSERT INTO facts VALUES (1)");
    const value = readSqliteWithinTransaction(database, () => readSqliteSnapshot(database, () => {
      assert.throws(() => database.exec("INSERT INTO facts VALUES (2)"), /readonly/i);
      return database.prepare("SELECT value FROM facts").get().value;
    }));
    assert.equal(value, 1);
    assert.throws(() => readSqliteSnapshot(database, () => 2), /transaction/i,
      "leaving the explicit window must not mark unrelated reads as nested");
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM facts").get().count, 0);
    database.exec("INSERT INTO facts VALUES (3)");
    assert.throws(() => readSqliteSnapshot(database, () => { throw Error("fixture"); }), /fixture/);
    assert.equal(readSqliteSnapshot(database, () => 4), 4);
  } finally { database.close(); }
});

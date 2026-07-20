import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { configureSqliteRunStoreDatabase } from "../dist/storage/sqlite/migrations.js";

test("sqlite configuration waits for an existing writer before switching to WAL", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-sqlite-config-"));
  const databasePath = resolve(cwd, "run-store.sqlite");
  const worker = new Worker(`
    const { DatabaseSync } = require("node:sqlite");
    const { parentPort, workerData } = require("node:worker_threads");

    const database = new DatabaseSync(workerData.databasePath);
    database.exec("CREATE TABLE lock_fixture (value INTEGER); BEGIN EXCLUSIVE; INSERT INTO lock_fixture VALUES (1);");
    parentPort.postMessage("locked");
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
      parentPort.postMessage("released");
    }, 100);
  `, {
    eval: true,
    workerData: { databasePath },
  });

  let database;
  try {
    const [state] = await once(worker, "message");
    assert.equal(state, "locked");

    database = new DatabaseSync(databasePath);
    assert.doesNotThrow(() => configureSqliteRunStoreDatabase(database));
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5_000);

    const [released] = await once(worker, "message");
    assert.equal(released, "released");
  } finally {
    database?.close();
    await worker.terminate();
    await rm(cwd, { recursive: true, force: true });
  }
});

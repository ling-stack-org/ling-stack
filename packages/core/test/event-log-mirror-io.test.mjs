import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as eventLog from "../dist/storage/event-log.js";

const event = { id: "mirror-fact", runId: "mirror-run", seq: 1,
  ts: "2026-10-19T00:00:00.000Z", type: "run_created", data: { taskId: "mirror-task" } };

for (const [method, operation] of [["mkdirSync", "prepare_directory"], ["readFileSync", "read"],
  ["appendFileSync", "append"]]) {
  for (const code of ["EDQUOT", "ESTALE", "ETIMEDOUT"]) {
    test(`event mirror classifies ${operation} ${code} at its filesystem boundary`, async t => {
      const root = await mkdtemp(join(tmpdir(), "ling-mirror-io-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const path = join(root, "events.jsonl");
      const fault = Object.assign(new Error("Synthetic filesystem fault"), { code });
      const original = fs[method];
      const mocked = t.mock.method(fs, method, (...args) => {
        if (args[0] === (method === "mkdirSync" ? dirname(path) : path)) throw fault;
        return Reflect.apply(original, fs, args);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(() => eventLog.ensureEventLogLine(path, event), error =>
          typeof eventLog.RunEventLogIoError === "function" && error instanceof eventLog.RunEventLogIoError
          && error.cause === fault && error.operation === operation);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
}

test("event mirror serialization failure is not disguised as filesystem I/O", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-mirror-serialization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = {}; data.circular = data;
  assert.throws(() => eventLog.ensureEventLogLine(join(root, "events.jsonl"), { ...event, data }), TypeError);
});

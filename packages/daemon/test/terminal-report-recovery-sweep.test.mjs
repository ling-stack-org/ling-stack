import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalReportRecoverySweep } from "../dist/features/channels/terminal-report-recovery-sweep.js";
import { TerminalReportPublicationError } from "../dist/features/channels/terminal-report-publisher.js";

test("recovery isolates and deduplicates failed sources but still rejects the partial sweep", async () => {
  const events = [];
  const sweep = createTerminalReportRecoverySweep({ paths: { cwd: "/scope" }, appendControlPlaneEvent: event => events.push(event) });
  const failure = new TerminalReportPublicationError("item_conflict", "private command/provider text");
  const visited = [];
  await sweep.attempt({ kind: "workflow", id: "bad" }, () => { visited.push("bad"); throw failure; });
  await sweep.attempt({ kind: "workflow", id: "bad" }, () => { visited.push("duplicate bad"); });
  for (const kind of ["run", "turn", "workflow"]) {
    await sweep.attempt({ kind, id: "good" }, () => { visited.push(kind); });
  }
  assert.deepEqual(visited, ["bad", "run", "turn", "workflow"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.code, "item_conflict");
  assert.equal(events[0].cwd, "/scope");
  assert.doesNotMatch(JSON.stringify(events), /private command|provider text/u);
  assert.throws(() => sweep.finish(), error => error === failure);
});

test("successful replay does not prevent a new evidence generation for the same source", async () => {
  const sweep = createTerminalReportRecoverySweep({ paths: { cwd: "/scope" }, appendControlPlaneEvent() { assert.fail("no diagnostic expected"); } });
  let calls = 0;
  const source = { kind: "workflow", id: "workflow" };
  await sweep.attempt(source, () => { calls += 1; });
  await sweep.attempt(source, () => { calls += 1; });
  assert.equal(calls, 2);
  sweep.finish();
});

test("diagnostic storage failure does not block unrelated recovery or leak exception text", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", value => warnings.push(value));
  const sweep = createTerminalReportRecoverySweep({ paths: { cwd: "/scope" }, appendControlPlaneEvent() { throw new Error("private database details"); } });
  const failure = new Error("private provider details");
  await sweep.attempt({ kind: "turn", id: "bad" }, () => { throw failure; });
  let recovered = false;
  await sweep.attempt({ kind: "turn", id: "good" }, () => { recovered = true; });
  assert.equal(recovered, true);
  assert.deepEqual(warnings, ["terminal_report_recovery_diagnostic_failed"]);
  assert.throws(() => sweep.finish(), error => error === failure);
});

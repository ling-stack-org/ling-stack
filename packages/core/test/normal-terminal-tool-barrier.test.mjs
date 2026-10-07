import assert from "node:assert/strict";
import test from "node:test";
import { readNormalTerminalToolBarrier } from "../dist/index.js";

const run = { id: "run-fenced", status: "failed" };
const event = (seq, type, toolCallId = "call") => ({ id: `event-${seq}`, runId: run.id, seq, type,
  ts: "2026-10-02T00:00:00.000Z", data: { ...(toolCallId === undefined ? {} : { toolCallId }) } });
const store = events => ({ listEvents: (_runId, { afterSeq = 0, limit = 1000 } = {}) =>
  events.filter(event => event.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit) });

test("Run failure fences an open tool but is not its completion receipt", () => {
  const events = [event(1, "tool_start"), event(2, "run_error")];
  const result = readNormalTerminalToolBarrier(store(events), run);
  assert.deepEqual(result.unsettledTools, [{ runId: run.id, toolCallId: "call", startEventId: "event-1", terminalEventId: "event-2" }]);
  assert.equal(result.malformed, false);
});

test("tool completion before Run failure remains settled", () => {
  const result = readNormalTerminalToolBarrier(store([event(1, "tool_start"), event(2, "tool_end"), event(3, "run_error")]), run);
  assert.equal(result.unsettledTools.length, 0);
});

test("late tool completion after Run failure cannot erase unknown effects", () => {
  const result = readNormalTerminalToolBarrier(store([event(1, "tool_start"), event(2, "run_error"), event(3, "tool_end")]), run);
  assert.equal(result.unsettledTools.length, 1);
  assert.equal(result.unsettledTools[0].terminalEventId, "event-2");
});

test("terminal row without matching durable boundary cannot fence a tool", () => {
  const result = readNormalTerminalToolBarrier(store([event(1, "tool_start"), event(2, "run_cancelled")]), run);
  assert.equal(result.unsettledTools[0].terminalEventId, undefined);
  const foreign = { ...event(2, "run_error"), runId: "foreign" };
  assert.equal(readNormalTerminalToolBarrier(store([event(1, "tool_start"), foreign]), run).unsettledTools[0].terminalEventId, undefined);
});

test("old failure boundary before a tool start cannot fence the new call", () => {
  const result = readNormalTerminalToolBarrier(store([event(1, "run_error"), event(2, "tool_start")]), run);
  assert.equal(result.unsettledTools[0].terminalEventId, undefined);
});

test("missing tool identity fails the lifecycle barrier", () => {
  const malformed = { ...event(1, "tool_start"), data: {} };
  assert.equal(readNormalTerminalToolBarrier(store([malformed]), run).malformed, true);
});

test("normal report lifecycle reads past the first page", () => {
  const events = Array.from({ length: 1000 }, (_, index) => event(index + 1, "assistant_text_delta"));
  events.push(event(1001, "tool_start"), event(1002, "run_error"));
  const result = readNormalTerminalToolBarrier(store(events), run);
  assert.equal(result.events.length, 1002);
  assert.equal(result.unsettledTools[0].terminalEventId, "event-1002");
});

test("cancelled Run accepts only its cancellation boundary", () => {
  const result = readNormalTerminalToolBarrier(store([event(1, "tool_start"), event(2, "run_error"), event(3, "run_cancelled")]), { ...run, status: "cancelled" });
  assert.equal(result.unsettledTools[0].terminalEventId, "event-3");
});

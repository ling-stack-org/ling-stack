import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("sqlite run events keep typed payloads across reopen and reject malformed payloads", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-typed-events-"));
  const now = "2026-08-25T00:00:00.000Z";
  try {
    const store = createSqliteRunStore(cwd);
    store.createRun({
      id: "run_typed_events",
      cwd,
      taskId: "task_typed_events",
      providerName: "test",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: now,
    });
    store.appendEvent("run_typed_events", "assistant_text_delta", { text: "hello" });
    store.appendEvent("run_typed_events", "tool_end", {
      toolCallId: "call-1",
      toolName: "bash",
      result: { stdout: "ok" },
      isError: false,
    });
    assert.throws(
      () => store.appendEvent("run_typed_events", "assistant_text_delta", { text: 42 }),
      /Invalid run event payload/,
    );
    assert.deepEqual(store.listEvents("run_typed_events", { limit: 10 }).map((event) => [event.type, event.data]), [
      ["assistant_text_delta", { text: "hello" }],
      ["tool_end", { toolCallId: "call-1", toolName: "bash", result: { stdout: "ok" }, isError: false }],
    ]);
    store.close();

    const reopened = createSqliteRunStore(cwd);
    try {
      const events = reopened.listEvents("run_typed_events", { limit: 10 });
      assert.equal(events[0].type, "assistant_text_delta");
      assert.equal(events[0].data.text, "hello");
      assert.equal(events[1].type, "tool_end");
      assert.equal(events[1].data.isError, false);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

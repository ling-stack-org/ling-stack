import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPreparedPiTaskInput, PiRunnerAdapter, rebindPreparedPiTaskInput } from "../dist/index.js";

test("packages/runner-pi/src/prepared-input.ts preserves actual SDK prompt, model and tool assembly", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-prepared-rebind-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = { id: "source", title: "Original", prompt: "Frozen input", channelId: "channel" };
  const prepared = await new PiRunnerAdapter().prepareTaskInput({ cwd, agentDir: join(cwd, "agent"), task: source,
    provider: { provider: "rebind-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1", api: "openai-completions" },
    tools: ["read", "ls"], appendSystemPrompt: ["Frozen context"] });
  const target = { ...source, id: "target" };
  const rebound = rebindPreparedPiTaskInput(prepared, source, target);
  assertPreparedPiTaskInput(rebound, target);
  assert.notEqual(rebound.fingerprint, prepared.fingerprint);
  assert.deepEqual({ ...rebound, taskId: source.id, fingerprint: prepared.fingerprint }, prepared);
  assert.equal(prepared.taskId, source.id);
  for (const changed of [{ ...target, title: "Changed" }, { ...target, prompt: "Changed" },
    { ...target, channelId: "foreign" }, { ...target, id: source.id }]) {
    assert.throws(() => rebindPreparedPiTaskInput(prepared, source, changed), /rebind mismatch/u);
  }
  assert.throws(() => rebindPreparedPiTaskInput({ ...prepared, systemPrompt: "tampered" }, source, target), /fingerprint/u);
});

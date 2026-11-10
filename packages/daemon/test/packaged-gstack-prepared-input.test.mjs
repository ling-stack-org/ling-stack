import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { capturePreparedRunnerInput, readPreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";

test("prepared package bindings reject forged or cross-source serialized values", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-packaged-input-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "packaged-input-task", title: "Inspect", prompt: "Inspect the packaged input." };
  const options = { cwd, agentDir: join(cwd, "agent"), task,
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
    tools: [] };
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(options);
  const digest = value => `sha256:${value.repeat(64)}`;
  const context = { loaded: true, runtimeViewKind: "original_source", sourceKind: "gstack-skill-directory",
    skillId: "qa", sourceChecksum: digest("a"), truncated: false,
    referencedFiles: [{ path: "manifest.json", checksum: digest("b"), kind: "other", includedInSnapshot: false }],
    resourceBinding: { manifestChecksum: digest("b"), upstreamRevision: "c".repeat(40),
      adaptationRevision: "ling-test", sourceChecksum: digest("a") } };
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput, skillSourceContext: context });
  assert.deepEqual(readPreparedRunnerInput(payload, options).skillSourceContext, context);
  for (const mutate of [
    value => { value.skillSourceContext.resourceBinding.sourceChecksum = digest("d"); },
    value => { value.skillSourceContext.resourceBinding.extra = "forged"; },
    value => { value.skillSourceContext.resourceBinding.upstreamRevision = "not-a-revision"; },
    value => { value.skillSourceContext.sourceKind = "manual-markdown"; },
    value => { value.skillSourceContext.truncated = true; },
  ]) {
    const forged = structuredClone(payload); mutate(forged);
    assert.throws(() => readPreparedRunnerInput(forged, options), /Invalid prepared skill resource binding/);
  }
});

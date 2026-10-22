import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DELEGATION_TOOL_NAMES, PiRunnerAdapter } from "@ling-stack/runner-pi";
import { capturePreparedRunnerInput, readPreparedRunnerInput, restorePreparedRunnerOptions } from "../dist/features/runs/prepared-runner-input.js";

async function fixture(t, selected = true, delegation = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-surface-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { cwd, agentDir: join(cwd, "agent"), task: { id: "surface-task", title: "Inspect", prompt: "Inspect the surface." },
    provider: { provider: "surface-fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
    tools: [], initialToolSurface: { mediaGeneration: false, toolHydration: false, userInput: selected, delegation } };
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(options);
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  return { options, payload };
}

test("prepared user-input capability cannot be revived after the internal Host gate closes", async t => {
  const f = await fixture(t);
  assert.throws(() => restorePreparedRunnerOptions(f.payload, { ...f.options,
    initialToolSurface: { ...f.options.initialToolSurface, userInput: false } }), error => error.code === "prepared_tool_capability_changed");
  assert.throws(() => restorePreparedRunnerOptions(f.payload, { ...f.options, initialToolSurface: undefined }),
    error => error.code === "prepared_tool_capability_changed");
});

test("a frozen disabled user-input surface does not inherit a later Host opt-in", async t => {
  const f = await fixture(t, false);
  const restored = restorePreparedRunnerOptions(f.payload, { ...f.options,
    initialToolSurface: { ...f.options.initialToolSurface, userInput: true } });
  assert.equal(restored.initialToolSurface.userInput, false);
  assert.equal(restored.preparedInput.tools.some(tool => tool.name === "request_user_input"), false);
});

test("prepared user-input selection must match the sealed SDK tool descriptors", async t => {
  const f = await fixture(t);
  for (const selected of [false, "true"]) {
    const forged = structuredClone(f.payload);
    forged.input.initialToolSurface.userInput = selected;
    assert.throws(() => readPreparedRunnerInput(forged, f.options), /Invalid prepared user-input tool surface/);
  }
  assert.deepEqual(restorePreparedRunnerOptions(f.payload, f.options).preparedInput, f.payload.preparedInput);
});

test("prepared surface rejects unknown or non-boolean selectors instead of treating them as activation", async t => {
  const f = await fixture(t);
  for (const surface of [{ ...f.options.initialToolSurface, extra: true }, { ...f.options.initialToolSurface, toolHydration: "true" }]) {
    const forged = structuredClone(f.payload);
    forged.input.initialToolSurface = surface;
    assert.throws(() => readPreparedRunnerInput(forged, f.options), /Invalid prepared user-input tool surface/);
  }
});

test("prepared delegation capability cannot survive Host workflow revocation", async t => {
  const f = await fixture(t, false, true);
  assert.throws(() => restorePreparedRunnerOptions(f.payload, { ...f.options,
    initialToolSurface: { ...f.options.initialToolSurface, delegation: false } }),
  error => error.code === "prepared_tool_capability_changed");
});

test("a frozen run without delegation never gains the five tools after later selection", async t => {
  const f = await fixture(t, false, false);
  const restored = restorePreparedRunnerOptions(f.payload, { ...f.options,
    initialToolSurface: { ...f.options.initialToolSurface, delegation: true } });
  assert.equal(restored.initialToolSurface.delegation, false);
  assert.deepEqual(restored.preparedInput.tools.filter(tool => DELEGATION_TOOL_NAMES.includes(tool.name)), []);
});

test("prepared delegation selection exactly matches all five sealed SDK descriptors", async t => {
  const f = await fixture(t, false, true);
  assert.deepEqual(f.payload.preparedInput.tools.filter(tool => DELEGATION_TOOL_NAMES.includes(tool.name)).map(tool => tool.name),
    DELEGATION_TOOL_NAMES);
  for (const selected of [false, "true"]) {
    const forged = structuredClone(f.payload);
    forged.input.initialToolSurface.delegation = selected;
    assert.throws(() => readPreparedRunnerInput(forged, f.options), /Invalid prepared user-input tool surface/);
  }
});

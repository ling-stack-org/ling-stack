import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { CONVERSATION_RESPONSE_STYLE_PROMPT as style, appendConversationResponseStyle } from "../dist/shared/conversation-response-style.js";
import { capturePreparedRunnerInput, restorePreparedRunnerOptions } from "../dist/features/runs/prepared-runner-input.js";

test("shared response style is an adaptive default, not a blanket list or detail ban", () => {
  assert.match(style, /Prefer natural paragraphs for short answers/);
  assert.match(style, /simple definition, factual question, confirmation, or small completed task/);
  assert.match(style, /default to one or two short paragraphs/);
  assert.match(style, /Do not expand it into an unrequested catalogue/);
  assert.match(style, /Use bullets for genuinely independent points/);
  assert.match(style, /numbered lists for ordered steps or choices/);
  assert.match(style, /Follow the user's explicitly requested format and level of detail/);
  assert.match(style, /Preserve useful Markdown lists, code blocks, and links/);
});

test("concise final narration does not hide failures or replace evidence with prose", () => {
  assert.match(style, /intermediate edits, or every tool action/);
  assert.match(style, /full command lines, per-file diff counts, or successful exit codes/);
  assert.match(style, /unless requested or necessary/);
  assert.match(style, /Never shorten away failures, blocked or partial work/);
  assert.match(style, /pending approvals or questions, unverified results, or material risks/);
  assert.match(style, /claim success only from tool results and Host evidence/);
});

test("style applies to all agent narration without reformatting structured data", () => {
  assert.match(style, /main agents and delegated teammates/);
  assert.match(style, /only to conversational narration/);
  assert.match(style, /Do not rewrite quoted text, file contents, tool arguments, or machine-readable structured outputs/);
});

test("shared style preserves caller fragments without mutation and is idempotent", () => {
  const fragments = Object.freeze(["Custom teammate profile", "Selected skill details", "User asked for a detailed numbered report"]);
  const first = appendConversationResponseStyle(fragments);
  assert.deepEqual(first, [...fragments, style]);
  assert.deepEqual(appendConversationResponseStyle(first), first);
  assert.deepEqual(appendConversationResponseStyle([style, ...fragments, style]), first);
  assert.deepEqual(fragments, ["Custom teammate profile", "Selected skill details", "User asked for a detailed numbered report"]);
});

test("an empty profile receives style but a partial marker cannot suppress it", () => {
  assert.deepEqual(appendConversationResponseStyle([]), [style]);
  assert.deepEqual(appendConversationResponseStyle(["Ling conversation response style v1: user data"]), ["Ling conversation response style v1: user data", style]);
});

test("restoring a pre-style SDK snapshot preserves its exact input instead of adding new defaults", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-response-style-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const oldOptions = {
    cwd, agentDir: join(cwd, "agent"), tools: [],
    task: { id: "style-recovery", title: "Existing run", prompt: "Return JSON only: {\"ok\":true}" },
    systemPrompt: "Existing custom profile", appendSystemPrompt: ["Existing accepted instruction"],
    provider: { provider: "style-fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
  };
  const adapter = new PiRunnerAdapter();
  const preparedInput = await adapter.prepareTaskInput(oldOptions);
  const saved = capturePreparedRunnerInput({ runnerId: "pi", options: oldOptions, preparedInput });
  const restored = restorePreparedRunnerOptions(saved, { ...oldOptions, appendSystemPrompt: appendConversationResponseStyle(oldOptions.appendSystemPrompt) });
  assert.deepEqual(restored.appendSystemPrompt, oldOptions.appendSystemPrompt);
  assert.doesNotMatch(restored.preparedInput.systemPrompt, /Ling conversation response style v1/);
  assert.equal((await adapter.prepareTaskInput(restored)).fingerprint, preparedInput.fingerprint);
  assert.equal(saved.input.task.prompt, oldOptions.task.prompt);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, resolveStoragePaths } from "../../../core/dist/index.js";
import {
  collectRunTerminalReportEvidence, collectTurnTerminalReportEvidence, collectWorkflowTerminalReportEvidence,
} from "../../dist/features/channels/terminal-report-evidence.js";
import { configureTerminalReportStore, processRunTerminalReport } from "../../dist/features/channels/terminal-report-coordinator.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";

/** Only owned SQLite/files and local runner substitutes; no live app or transport. */
export async function taskTerminalFixture(t, { status = "cancelled", language = "en-US", synthesis = "unavailable",
  contribution, surface = "task" } = {}) {
  assert.ok(["cancelled", "failed", "succeeded", "blocked"].includes(status));
  const directory = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b010-empty-contribution-")));
  const cwd = join(directory, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${directory}/`));
  const store = createSqliteRunStore(cwd, paths);
  t.after(async () => {
    if (store.database.isOpen) store.close();
    assert.ok(directory.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b010-empty-contribution-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const now = new Date().toISOString(), teammateId = "teammate_builtin_engineer";
  const channel = store.createChannel({ name: "B010 owned backing channel", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Read the owned evidence", prompt: "Read evidence then continue the assignment",
    assigneeTeammateId: teammateId }, now);
  const channelScope = surface === "task" ? { channelId: channel.id } : {};
  const thread = store.createLingThread({ kind: surface, ...channelScope,
    ...(surface === "task" ? { taskId: task.id } : surface === "teammate_direct" ? { teammateId } : {}),
    title: task.title, objective: task.prompt }, now);
  const accepted = store.appendConversationUserTurn({ threadId: thread.id, ...channelScope,
    ...(surface === "teammate_direct" ? { teammateId } : {}), title: task.title,
    userInstruction: task.prompt, idempotencyKey: "b010-source", payload: { body: task.prompt,
      format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  let workflow, step;
  if (status === "blocked") {
    assert.equal(surface, "task");
    workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Blocked owned assignment", objective: task.prompt,
      status: "blocked", createdBy: "local-user", metadata: { responseLanguage: language } }, now);
    step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Blocked contribution", prompt: task.prompt,
      toParticipantId: teammateId, toParticipantLabel: "Engineer", status: "blocked" }, now);
  }
  const run = store.createRun({ id: "b010-owned-run", cwd, taskId: task.id, ...channelScope, teammateId,
    threadId: thread.id, turnId: accepted.turnId, ...(step ? { workflowStepId: step.id } : {}),
    providerName: "b010-fixture", providerModel: "no-network", taskSnapshot: task, providerSnapshot: {},
    requestSnapshot: { cwd, responseLanguage: language }, createdAt: now });
  store.markRunStarted(run.id, now);
  let executionCalls = 0, synthesisCalls = 0;
  await fs.writeFile(join(cwd, "evidence.txt"), "B010 actual local fixture evidence\n");
  const runner = {
    async runTask(options) {
      executionCalls++;
      if (status === "blocked") {
        // A valid blocked Workflow can have a produced artifact but no textual
        // contribution. Do not invent an illegal Run status or a typed action.
        store.createArtifact({ runId: run.id, type: "file", path: "evidence.txt", title: "Owned evidence", createdAt: now });
      } else {
        options.onEvent({ type: "tool_start", toolName: "read", toolCallId: "b010-read", args: { path: "evidence.txt" } });
        const text = await fs.readFile(join(cwd, "evidence.txt"), "utf8");
        options.onEvent({ type: "tool_end", toolName: "read", toolCallId: "b010-read", isError: false,
          result: { content: [{ type: "text", text }] } });
      }
      if (contribution !== undefined) options.onEvent({ type: "assistant_text_delta", text: contribution });
      return { taskId: task.id, messages: contribution === undefined ? [] : [contribution], events: [] };
    },
  };
  await runner.runTask({ onEvent({ type, ...data }) { store.appendEvent(run.id, type, data); } });
  const endedAt = new Date().toISOString();
  const terminal = status === "blocked" ? "failed" : status;
  const transition = store.transitionRunStatus({ runId: run.id, expectedStatus: "running",
    event: terminal === "succeeded" ? "runner_succeeded" : terminal === "failed" ? "runner_failed" : "cancel",
    actor: "runner", now: endedAt, endedAt, errorMessage: null });
  assert.equal(transition.ok, true, JSON.stringify(transition));
  assert.equal(store.database.prepare("SELECT error_message FROM run_sessions WHERE id=?").get(run.id).error_message, null);
  assert.equal(store.getRun(run.id).errorMessage, undefined, "the public mapper represents SQL NULL as undefined");
  if (step) store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId: run.id }, endedAt);
  const settings = { enabled: true };
  if (synthesis === "request-failed") {
    const provider = store.createProviderPreset({ kind: "openai-compatible", displayName: "B010 nontransport synthesis",
      providerId: "b010-static", model: "fixture", api: "openai-responses", capabilities: ["chat"],
      input: ["text"], authHeader: false, enabled: true }, endedAt);
    store.recordProviderCheckResult(provider.id, { ok: true, code: "static_check", message: "Owned static fixture", checkedAt: endedAt });
    store.updateChannel(channel.id, { defaultProviderPresetId: provider.id }, endedAt);
    settings.runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "B010 synthesis fixture", status: "enabled",
      supportedProviderApis: ["openai-responses"], supportedTools: [], adapter: { async runTask() {
        synthesisCalls++;
        throw new Error("B010 local synthesis failure; no network request was made");
      } } }]);
    settings.secretResolver = { resolve(ref) { return { ref, configured: false }; } };
  } else assert.equal(synthesis, "unavailable");
  configureTerminalReportStore(store, settings);
  const collect = () => status === "blocked"
    ? collectWorkflowTerminalReportEvidence(store, workflow.id, { language })
    : surface === "task" ? collectRunTerminalReportEvidence(store, run.id, { language })
      : collectTurnTerminalReportEvidence(store, accepted.turnId, { language });
  return { cwd, paths, store, task, thread, run: store.getRun(run.id), workflow, step, collect,
    get executionCalls() { return executionCalls; }, get synthesisCalls() { return synthesisCalls; },
    process: () => processRunTerminalReport(store, run.id), reopen: () => createSqliteRunStore(cwd, paths) };
}

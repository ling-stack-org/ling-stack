import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, toRuntimeAttemptFence } from "@ling-stack/core";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { startRuntimeWorkUnit } from "../../dist/runtime/work-units.js";
import { captureLearningEvidence } from "../../dist/features/learning/evidence.js";
export async function learningFixture(t, { correction, selectedSkillId, terminal = "succeeded" } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-learning-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  const now = new Date().toISOString();
  const supervisor = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd, runners: {}, runtimeTools: {}, transports: { providerWebSocketFallback: true, localWebSocketRpc: true }, channels: {} });
  t.after(async () => { supervisor.releaseAll(); database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Amber ledger", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Amber receipt reconciliation", prompt: "Compare both receipt totals and verify the ledger sum." }, now);
  const run = store.createRun({ id: "source", cwd, taskId: task.id, channelId: channel.id, teammateId: "ling_agent", selectedSkillId,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now });
  store.appendEvent(run.id, "tool_start", { toolName: "read", toolCallId: "receipt", args: { path: "receipt.csv" } }, now);
  store.appendEvent(run.id, "tool_end", { toolName: "read", toolCallId: "receipt", isError: false, result: "Receipt total 42; ledger total 42." }, now);
  store.appendEvent(run.id, "tool_start", { toolName: "bash", toolCallId: "sum", args: { command: "sum-ledger --verify" } }, now);
  store.appendEvent(run.id, "tool_end", { toolName: "bash", toolCallId: "sum", isError: false, result: "Verified sum 42; exit code 0." }, now);
  if (terminal === "succeeded") store.appendEvent(run.id, "run_end", { taskId: task.id }, now);
  store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: terminal === "succeeded" ? "runner_succeeded" : terminal === "failed" ? "runner_failed" : "cancel",
    actor: "runner", now, endedAt: now });
  const published = [];
  const hub = { publish(event) { published.push(event); } };
  const evidence = captureLearningEvidence(store, run.id, correction);
  const source = evidence.items.find(item => item.verified);
  const second = evidence.items.filter(item => item.verified)[1];
  const cite = item => ({ evidenceId: item.id, quote: item.text.includes("Receipt total") ? "Receipt total 42" : "Verified sum 42" });
  const draft = { kind: "procedure", destination: "skill", title: "Amber receipt reconciliation", summary: "Compare the signed receipt and validate the ledger sum.",
    appliesWhen: ["Reconcile the amber ledger with a signed receipt"], doesNotApplyWhen: ["No signed receipt is available"], prerequisites: ["The receipt and ledger cover the same period"],
    steps: [{ instruction: "Read the signed receipt total and the ledger total for the same period.", evidence: cite(source) },
      { instruction: "Compare both totals and verify the ledger sum with the recorded check.", evidence: cite(second) }],
    checks: [{ check: "Compare the recorded totals and verified sum", expected: "Both totals and the verified sum equal 42", evidence: cite(second) }] };
  const enqueue = (mode = "explicit", e = evidence) => store.enqueueLearningReview({ mode, evidence: e, providerPresetId: "fixture" }, new Date().toISOString());
  const claim = job => {
    const started = startRuntimeWorkUnit({ store, runtimeSupervisor: supervisor, kind: "learning_review", ownerType: "learning_review", ownerId: job.id,
      idempotencyKey: job.id, effectiveRunnerId: "learning-extractor", request: { jobId: job.id } });
    const fence = toRuntimeAttemptFence(started.attempt);
    return { fence, job: store.claimLearningReviewJob(job.id, fence, new Date().toISOString()) };
  };
  return { cwd, channel, store, database, supervisor, task, run, evidence, draft, hub, published, enqueue, claim, now };
}

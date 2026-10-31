// Bounded public Host lineage and real QA-file hashes. Never edits the QA store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { LingDaemonClient } from "../../packages/api-client/dist/index.js";

const [label, workflowId] = process.argv.slice(2);
assert.ok(/^[a-z][a-z0-9-]{1,55}$/.test(label ?? ""));
assert.ok(workflowId === undefined || /^workflow_[a-zA-Z0-9-]+$/.test(workflowId));
const cwd = new URL("./h09-packaged-human-qa-20261010/profile/workspace/", import.meta.url).pathname;
const output = new URL("./p3-live-20261025/", import.meta.url);
await mkdir(output, { recursive: true, mode: 0o700 });
const originals = ["brief.md", "constraints.md", "records.csv",
  ...["package.json", "ledger.js", "cli.js", "ledger.test.js", "README.md"].map(p => `qinglan-ledger/${p}`)];
const files = [];
for (const path of [...originals, "qinglan-ledger/constraints-check.test.js", "qinglan-ledger-audit.md"]) {
  try {
    const bytes = await readFile(new URL(`p3-live-20261023/${path}`, `file://${cwd}`));
    files.push({ path, original: originals.includes(path), size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assert.equal(originals.includes(path), false);
    files.push({ path, original: false, exists: false });
  }
}
const record = { capturedAt: new Date().toISOString(), label,
  source: "real dedicated QA files and public packaged Host APIs; no DB mutation", files };
if (workflowId) {
  const client = new LingDaemonClient({ baseUrl: "http://127.0.0.1:17928" });
  const evidence = await client.getChannelWorkflowEvidence(cwd.replace(/\/$/, ""), workflowId);
  const workflow = (await client.getChannelWorkflow(cwd.replace(/\/$/, ""), workflowId)).workflow;
  record.workflow = { id: workflow.id, status: workflow.status, channelId: workflow.channelId };
  record.steps = evidence.steps.map(({ step }) => ({ id: step.id, status: step.status, runId: step.runId,
    participantId: step.toParticipantId, required: step.required, dependsOn: step.dependsOn, blocker: step.blocker }));
  record.runs = [];
  for (const { step } of evidence.steps) {
    if (!step.runId) continue;
    const response = await client.getRun(step.runId, cwd.replace(/\/$/, "")), run = response.run ?? response;
    const events = (await client.getRunEvents(run.id, cwd.replace(/\/$/, ""))).events;
    const workEvents = run.workUnitId ? (await client.getWorkUnitEvents(cwd.replace(/\/$/, ""), run.workUnitId)).events : [];
    record.runs.push({ id: run.id, status: run.status, threadId: run.threadId, workflowStepId: run.workflowStepId,
      workUnitId: run.workUnitId, teammateId: run.teammateId, startedAt: run.startedAt, endedAt: run.endedAt,
      counts: Object.fromEntries([...new Set(events.map(e => e.type))].map(type => [type, events.filter(e => e.type === type).length])),
      events: events.filter(e => ["tool_start", "tool_end", "approval_requested", "approval_approved", "host_command_prepared",
        "host_command_settled", "run_error", "run_end", "result"].includes(e.type)).map(e => ({ id: e.id, seq: e.seq,
          type: e.type, ts: e.ts, toolName: e.data?.toolName, toolCallId: e.data?.toolCallId, attemptId: e.data?.attemptId,
          code: e.data?.code, isError: e.data?.isError })),
      webEvents: workEvents.filter(e => e.data?.toolSurface === "web" || e.type === "web_evidence_recorded")
        .map(e => ({ id: e.id, seq: e.seq, type: e.type })) });
  }
  record.actions = evidence.actions.map(a => ({ id: a.id, runId: a.runId, status: a.status, revision: a.revision,
    actionType: a.actionType, participantId: a.participantId, attemptId: a.attemptId,
    workflowStepId: a.workflowStepId, sourceRefs: a.sourceRefs }));
  record.approvals = evidence.approvals.map(a => ({ id: a.id, status: a.status, runId: a.runId }));
}
record.limits = ["Public projection, file hashes and genuine GUI screenshots are different evidence",
  "No single stage establishes full two-file project or dynamic delegation acceptance"];
const serialized = JSON.stringify(record, null, 2) + "\n";
assert.ok(!/\bsk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]{12,}/.test(serialized));
const path = new URL(`c01-r3-${label}-host-lineage.json`, output);
await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ path: path.pathname, sha256: createHash("sha256").update(serialized).digest("hex"),
  workflow: record.workflow, steps: record.steps,
  runs: record.runs?.map(({ id, status, counts, webEvents }) => ({ id, status, counts, webEvents })), files }));

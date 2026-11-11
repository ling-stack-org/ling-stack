import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assessHostReadiness, collectHostReadiness, parseHostReadinessEvidence, renderHostReadinessMarkdown } from "./host-readiness.mjs";
import { runCli } from "./index.mjs";
import { parseJson } from "./manifest.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = fileURLToPath(new URL("../../fixtures/framework-assurance/execution-evidence/host-ready-shape.json", import.meta.url));
const ready = parseJson(await readFile(fixturePath), "Host readiness fixture");
const clone = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown): boolean => (error as { code?: string })?.code === expected;

async function temporary(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ling-host-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("complete Host evidence requires all five readiness domains and preserves recovery lineage", () => {
  const parsed = parseHostReadinessEvidence(ready);
  assert.equal(parsed.lifecycle.oldAttemptCount, 1);
  assert.equal(parsed.lifecycle.currentAttemptId, parsed.execution.attemptId);
  const report = assessHostReadiness(parsed);
  assert.equal(report.status, "ready-for-trial-review");
  assert.equal(report.executionAuthorized, false);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.domains.lifecycle.reusable, true);
  assert.equal(report.domains.budget.status, "within");
  assert.equal(report.domains.isolation.applyStatus, "applied");
  assert.equal(report.domains.admission.toolBrokerMode, "enforce");
  assert.doesNotMatch(JSON.stringify(report), /fence-host-ready|claimToken|sealedPayload/u);
  assert.match(renderHostReadinessMarkdown(report), /read-only Host projection gate/u);
});

test("readiness rejects a base live response without lifecycle, budget and admission evidence", () => {
  const base = clone(ready) as Record<string, unknown>;
  for (const key of ["lifecycle", "completion", "budget", "isolation", "admission"]) delete base[key];
  assert.throws(() => parseHostReadinessEvidence(base), code("host_readiness_evidence_incomplete"));
});

test("readiness rejects cross-domain Attempt identity drift before assessing status", () => {
  const drift = clone(ready) as { execution: { attemptId: string } };
  drift.execution.attemptId = "attempt-foreign-001";
  assert.throws(() => assessHostReadiness(drift), code("host_readiness_lineage_mismatch"));
});

test("unknown budget and unconfirmed cancellation remain blocked without execution authority", () => {
  const unknown = clone(ready) as {
    budget: { status: string; usage: { tokenStatus: string; costStatus: string }; blockers: string[] };
    admission: { status: string; blockers: string[] };
  };
  unknown.budget.status = "unknown";
  unknown.budget.usage.tokenStatus = "unknown";
  unknown.budget.usage.costStatus = "unknown";
  unknown.budget.blockers = ["delegation.usage_unknown"];
  unknown.admission.status = "blocked";
  unknown.admission.blockers = ["workflow_admission.delegation_budget_not_within"];
  const unknownReport = assessHostReadiness(unknown);
  assert.equal(unknownReport.status, "blocked");
  assert.equal(unknownReport.executionAuthorized, false);
  assert.ok(unknownReport.blockers.includes("host_readiness.budget_not_within"));

  const cancelled = clone(ready) as {
    execution: { runStatus: string; workUnitStatus: string; attemptStatus: string; effectStatus: string };
    lifecycle: { status: string; stop: { effects: string; reusable: boolean } };
    admission: { status: string; blockers: string[] };
  };
  cancelled.execution.runStatus = "cancelled";
  cancelled.execution.workUnitStatus = "cancelled";
  cancelled.execution.attemptStatus = "cancelled";
  cancelled.execution.effectStatus = "unknown";
  cancelled.lifecycle.status = "cancelling";
  cancelled.lifecycle.stop.effects = "unknown";
  cancelled.lifecycle.stop.reusable = false;
  cancelled.admission.status = "blocked";
  cancelled.admission.blockers = ["workflow_admission.execution_effects_unconfirmed"];
  const cancelledReport = assessHostReadiness(cancelled);
  assert.equal(cancelledReport.status, "blocked");
  assert.ok(cancelledReport.blockers.includes("host_readiness.effects_unconfirmed"));
  assert.ok(cancelledReport.blockers.includes("host_readiness.lifecycle_not_drained"));
});

test("client collection performs one read-only evidence call and never changes authorization", async () => {
  const calls: Array<{ runId: string; cwd: string }> = [];
  const report = await collectHostReadiness({
    cwd: "/workspace/host-readiness",
    runId: "run-host-ready-001",
    client: {
      getRunAssuranceEvidence: async (runId: string, cwd: string) => {
        calls.push({ runId, cwd });
        return clone(ready);
      },
    },
  });
  assert.deepEqual(calls, [{ runId: "run-host-ready-001", cwd: "/workspace/host-readiness" }]);
  assert.equal(report.status, "ready-for-trial-review");
  assert.equal(report.executionAuthorized, false);
});

test("host-readiness CLI publishes a review-only JSON and Markdown report", async t => {
  const output = await temporary(t);
  const result = await runCli(["host-readiness", "--input", fixturePath, "--output", output], { repoRoot });
  assert.equal(result.exitCode, 0);
  const summary = JSON.parse(result.text) as { files: { result: string; markdown: string } };
  const report = JSON.parse(await readFile(summary.files.result, "utf8")) as { status: string; executionAuthorized: boolean };
  assert.equal(report.status, "ready-for-trial-review");
  assert.equal(report.executionAuthorized, false);
  assert.match(await readFile(summary.files.markdown, "utf8"), /Execution authorized: `false`/u);
});

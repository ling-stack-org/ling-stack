import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDeterministicTerminalReport, captureNormalTerminalReportBasis, createSqliteRunStore, validateTerminalReport } from "../../core/dist/index.js";
import { projectCanonicalConversationTimeline } from "../../conversation-ui-core/dist/index.js";
import { formatSynchronousCatalogMessage, loadCatalog } from "../../localization/dist/index.js";
import { collectTurnTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
import { configureTerminalReportStore, processTurnTerminalReport } from "../dist/features/channels/terminal-report-coordinator.js";
import { catalogConsumerHarness } from "../../../apps/web/test/support/catalog-consumer-harness.mjs";

const now = "2026-10-17T00:00:00.000Z";
const later = "2026-10-17T00:01:00.000Z";
const warningKey = "terminal_report.evidence.execution_unconfirmed";

function assertBothUnconfirmed(text) {
  assert.match(text, /(?:工具)?(?:進程|程序|流程)(?:是否)?停止[^。；;]{0,14}(?:未確認|尚未確認|未獲確認)/u,
    "a stopped logical Run cannot substitute for an unconfirmed physical tool-process stop");
  assert.match(text, /(?:實際)?(?:影響|效果)[^。；;]{0,14}(?:未確認|尚未確認|未獲確認)/u);
  assert.match(text, /重試前[^。]{0,16}(?:核實|驗證)/u);
}

async function fixture(t, locale, status, receipt) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-c014-interruption-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  configureTerminalReportStore(store, { enabled: true });
  const channel = store.createChannel({ name: "C014 isolated backing task", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Inspect interruption", prompt: "Inspect the interruption evidence" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: task.title, objective: task.prompt }, now);
  const accepted = store.appendConversationUserTurn({ threadId: thread.id, itemId: "c014-input", turnId: "c014-turn",
    title: task.title, userInstruction: task.prompt, actorType: "local_user", actorId: "local-user", idempotencyKey: "c014-input",
    payload: { body: task.prompt, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, now);
  const run = store.createRun({ id: "c014-run", cwd, taskId: task.id, threadId: thread.id, turnId: accepted.turnId,
    providerName: "offline-fixture", providerModel: "no-model-call",
    taskSnapshot: { id: task.id, title: task.title }, providerSnapshot: { provider: "offline-fixture", model: "no-model-call" },
    requestSnapshot: { cwd, responseLanguage: locale }, createdAt: now });
  store.appendEvent(run.id, "tool_start", { toolCallId: "unfinished", toolName: "bash", args: { command: "node --version" } });
  const end = () => store.appendEvent(run.id, "tool_end", { toolCallId: "unfinished", toolName: "bash", isError: false });
  if (receipt === "before-fence") end();
  store.appendEvent(run.id, status === "failed" ? "run_error" : "run_cancelled", { message: "runtime_interrupted_no_checkpoint" });
  if (status === "failed") store.markRunFailed(run.id, later, "runtime_interrupted_no_checkpoint");
  else store.markRunCancelled(run.id, later);
  if (receipt === "after-fence") end();
  return { store, thread, turnId: accepted.turnId, run };
}

function project(f, record) {
  const items = f.store.listConversationItemsPage({ threadId: f.thread.id, effectiveOnly: true }).items;
  const projection = projectCanonicalConversationTimeline({
    scope: { surface: "normal", workspaceId: f.thread.workspaceId, threadId: f.thread.id, depth: 0 },
    sourceSequence: Math.max(...items.map(item => item.sequence)), sourceRevision: record.evidenceFingerprint,
    items, actions: [], turnRuns: [{ runId: f.run.id, turnId: f.turnId, attemptNumber: 1, role: "primary" }],
    terminalReports: [{ report: record.report, resultItemId: record.resultItemId, generation: record.generation }],
  });
  const item = projection.items.find(entry => entry.kind === "terminalReport");
  assert.ok(item, JSON.stringify(projection.diagnostics));
  assert.equal(item.resultItemId, record.resultItemId);
  return item;
}

for (const locale of ["zh-HK", "zh-TW"]) {
  for (const status of ["failed", "cancelled"]) {
    for (const receipt of ["missing", "after-fence"]) {
      test(`C014 ${locale} ${status}/${receipt}: Host warning survives snapshot, validation, publication and canonical renderer`, async t => {
        const f = await fixture(t, locale, status, receipt);
        const basis = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turnId });
        assert.equal(basis.settled, false);
        assert.equal(basis.failurePublicationAllowed, true);
        assert.equal(basis.unsettledTools.length, 1);
        const snapshot = collectTurnTerminalReportEvidence(f.store, f.turnId, { generatedAt: later });
        assert.equal(snapshot.language, locale);
        const riskId = `execution-unconfirmed:${f.run.id}:unfinished`;
        const warning = snapshot.risks.find(risk => risk.id === riskId);
        assert.ok(warning);
        assert.equal(warning.severity, "critical");
        assert.equal(warning.status, "unverified");
        const authored = JSON.parse(await readFile(new URL(`../../localization/catalogs/${locale}.json`, import.meta.url), "utf8"));
        const compiled = await loadCatalog(locale);
        assert.equal(compiled.messages[warningKey], authored.messages[warningKey]);
        assert.equal(warning.summary, formatSynchronousCatalogMessage(locale, warningKey));
        assert.equal(warning.summary, compiled.messages[warningKey]);
        const fallback = buildDeterministicTerminalReport(snapshot, { id: "c014-fallback", createdAt: now, committedAt: later });
        assert.equal(fallback.risks.find(risk => risk.id === riskId).summary, warning.summary);
        assert.equal(validateTerminalReport(fallback, snapshot).ok, true);
        const published = await processTurnTerminalReport(f.store, f.turnId, { now: later });
        assert.ok(published.record.resultItemId);
        assert.notEqual(published.record.report.outcome.status, "succeeded");
        const item = project(f, published.record);
        assert.equal(item.risks.find(risk => risk.id === riskId).summary, warning.summary);
        const harness = await catalogConsumerHarness(t, { exports: {
          "shared/conversation/timeline/ConversationTimelineTerminalReportRenderer.tsx": ["ConversationTimelineTerminalReportRenderer"],
          "shared/conversation/timeline/terminal-report-copy-text.ts": ["terminalReportCopyText"],
        } });
        await harness.select(locale);
        const markup = harness.render(harness.module.ConversationTimelineTerminalReportRenderer, { item, depth: 0 });
        assert.ok(markup.includes(warning.summary), "the current shared canonical renderer displays the immutable Host summary");
        assert.ok(harness.module.terminalReportCopyText(item).includes(warning.summary));
        // Keep semantic RED last: this test also proves the current actual consumer path before it fails.
        assertBothUnconfirmed(warning.summary);
      });
    }

    test(`C014 ${locale} ${status}: a valid pre-fence terminal receipt does not invent an unfinished-tool warning`, async t => {
      const f = await fixture(t, locale, status, "before-fence");
      const basis = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: f.turnId });
      assert.equal(basis.settled, true);
      assert.equal(basis.unsettledTools.length, 0);
      const snapshot = collectTurnTerminalReportEvidence(f.store, f.turnId, { generatedAt: later });
      assert.equal(snapshot.risks.some(risk => risk.id.startsWith("execution-unconfirmed:")), false);
      const published = await processTurnTerminalReport(f.store, f.turnId, { now: later });
      assert.equal(project(f, published.record).risks.some(risk => risk.id.startsWith("execution-unconfirmed:")), false);
    });
  }

  test(`C014 ${locale}: synthesized prose cannot remove, downgrade or rewrite the Host interruption warning`, async t => {
    const f = await fixture(t, locale, "failed", "missing");
    const snapshot = collectTurnTerminalReportEvidence(f.store, f.turnId, { generatedAt: later });
    const original = buildDeterministicTerminalReport(snapshot, { id: "c014-immutable", createdAt: now, committedAt: later });
    for (const change of ["remove", "rewrite", "mitigate"]) {
      const report = structuredClone(original);
      const risk = report.risks.find(entry => entry.id.startsWith("execution-unconfirmed:"));
      assert.ok(risk);
      if (change === "remove") report.risks = report.risks.filter(entry => entry !== risk);
      if (change === "rewrite") risk.summary = "The tool process has definitely stopped and no effects occurred.";
      if (change === "mitigate") risk.status = "mitigated";
      assert.equal(validateTerminalReport(report, snapshot).ok, false, change);
    }
  });
}

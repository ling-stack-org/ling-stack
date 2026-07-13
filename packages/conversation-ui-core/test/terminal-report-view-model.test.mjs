import assert from "node:assert/strict";
import test from "node:test";
import { terminalReportToViewModel } from "../dist/index.js";

test("terminal report projection keeps semantic sections and removes private developer refs", () => {
  const report = terminalReportToViewModel({
    id: "terminal_report_1",
    status: "committed",
    language: "zh-CN",
    outcome: {
      status: "succeeded",
      title: "会话总结已完成",
      summary: "接入结构化结果并保留过程记录。",
      corrections: [],
      sourceRefs: [{ kind: "workflow", id: "workflow_1", label: "Workflow", visibility: "conversation" }],
    },
    changes: [{
      id: "change_1",
      title: "接入会话 UI",
      summary: "展示最终总结。",
      paths: ["apps/web/src/view.tsx"],
      addedLines: 12,
      deletedLines: 2,
      sourceRefs: [],
    }],
    verification: [{
      id: "check_1",
      title: "Web typecheck",
      status: "passed",
      command: "pnpm typecheck",
      sourceRefs: [],
    }],
    participants: [{
      agentId: "qa",
      displayName: "QA",
      status: "completed",
      contribution: "验证会话结果和恢复路径。",
      sourceRefs: [],
    }],
    artifacts: [
      { id: "artifact_1", title: "view.tsx", path: "apps/web/src/view.tsx", sourceRefs: [] },
      { id: "artifact_metadata", title: "Generated file metadata: view.tsx", path: "run_1/metadata.txt", sourceRefs: [] },
      { id: "artifact_preview", title: "Action preview: bash", path: "run_1/actions/approval_1/preview.json", sourceRefs: [] },
    ],
    risks: [],
    references: [
      { kind: "artifact", id: "artifact_1", label: "view.tsx", visibility: "conversation" },
      { kind: "artifact", id: "artifact_metadata", label: "Generated file metadata: view.tsx", visibility: "conversation" },
      { kind: "file", id: "apps/web/src/view.tsx", label: "apps/web/src/view.tsx", visibility: "conversation" },
      { kind: "memory", id: "memory_1", label: "Conversation UI decision", visibility: "conversation" },
      { kind: "operation", id: "operation_secret", label: "internal", visibility: "developer_only" },
    ],
    evidenceFingerprint: "fingerprint_1",
    committedAt: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(report.rows[0].reportSection, "outcome");
  assert.equal(report.rows.some((row) => row.reportSection === "change"), true);
  assert.equal(report.rows.some((row) => row.reportSection === "verification"), true);
  assert.equal(report.rows.find((row) => row.reportSection === "participant")?.participantId, "qa");
  assert.equal(report.rows.find((row) => row.reportSection === "change")?.meta, "1 个文件 +12 -2");
  assert.deepEqual(report.rows.find((row) => row.reportSection === "change")?.detailLines, [{
    kind: "file_ref",
    text: "apps/web/src/view.tsx",
    path: "apps/web/src/view.tsx",
  }]);
  assert.equal(report.rows.find((row) => row.reportSection === "verification")?.meta, "已通过");
  assert.equal(report.rows.find((row) => row.reportSection === "participant")?.meta, "已完成");
  assert.deepEqual(report.evidenceLinks.map((link) => link.id), [
    "terminal_report_1:ref:artifact:artifact_1",
    "terminal_report_1:ref:file:apps/web/src/view.tsx",
    "terminal_report_1:ref:memory:memory_1",
  ]);
  assert.equal(report.artifactStripItems.length, 2);
  assert.deepEqual(report.artifactStripItems[0], {
    id: "terminal_report_1:changed",
    kind: "changed",
    label: "已编辑 1 个文件",
    changeArtifacts: [{
      id: "terminal_report_1:changed:apps/web/src/view.tsx",
      label: "apps/web/src/view.tsx",
      path: "apps/web/src/view.tsx",
      previewable: false,
    }],
    tone: "neutral",
  });
  assert.equal(report.artifactStripItems[1]?.label, "view.tsx");
  assert.equal(report.revisionKey, "terminal_report_1:fingerprint_1");
});

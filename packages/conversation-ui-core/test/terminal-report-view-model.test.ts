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
    changes: [
      {
        id: "change_artifact_storage",
        title: "run_1/001-read-content.md",
        summary: "已更新 run_1/001-read-content.md",
        paths: ["run_1/001-read-content.md"],
        sourceRefs: [],
      },
      {
        id: "change_1",
        title: "接入会话 UI",
        summary: "展示最终总结。",
        paths: ["apps/web/src/view.tsx"],
        addedLines: 12,
        deletedLines: 2,
        sourceRefs: [],
      },
    ],
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
      {
        id: "artifact_1",
        kind: "file",
        title: "view.tsx",
        path: "apps/web/src/view.tsx",
        sourceRefs: [{ kind: "file", id: "apps/web/src/view.tsx", visibility: "conversation" }],
      },
      { id: "artifact_metadata", kind: "other", title: "Generated file metadata: view.tsx", path: "run_1/metadata.txt", sourceRefs: [] },
      { id: "artifact_preview", kind: "other", title: "Action preview: bash", path: "run_1/actions/approval_1/preview.json", sourceRefs: [] },
    ],
    risks: [],
    references: [
      { kind: "run", id: "run_1", label: "Ling Agent run", visibility: "conversation" },
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
  assert.equal(report.rows.filter((row) => row.reportSection === "change").length, 1);
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
  assert.equal(report.artifactStripItems[1]?.workspaceFilePath, "apps/web/src/view.tsx");
  assert.equal(report.revisionKey, "terminal_report_1:fingerprint_1");
});

test("terminal report projection keeps Markdown summaries and bounds model titles", () => {
  const longTitle = `这是一段错误地回显到标题里的 workflow 提示词。${"继续执行要求。".repeat(40)}`;
  const report = terminalReportToViewModel({
    id: "terminal_report_markdown",
    status: "committed",
    language: "zh-CN",
    outcome: {
      status: "succeeded",
      title: longTitle,
      summary: "完成说明：\n\n- 已创建文件\n- 已验证内容\n\n```bash\nnode app.js\n```",
      corrections: [],
      sourceRefs: [],
    },
    changes: [],
    verification: [],
    participants: [{
      agentId: "engineer",
      displayName: "Engineer",
      status: "completed",
      contribution: "实现完成。\n\n```ts\nconst ok = true;\n```",
      sourceRefs: [],
    }],
    artifacts: [],
    risks: [],
    references: [],
    evidenceFingerprint: "fingerprint_markdown",
    committedAt: "2026-07-11T00:00:00.000Z",
  });

  const outcome = report.rows.find((row) => row.reportSection === "outcome");
  const participant = report.rows.find((row) => row.reportSection === "participant");
  assert.equal(outcome?.description, "完成说明：\n\n- 已创建文件\n- 已验证内容\n\n```bash\nnode app.js\n```");
  assert.equal(outcome?.title.endsWith("..."), true);
  assert.equal(outcome?.title.includes("这是一段错误地回显到标题里的"), true);
  assert.match(participant?.description ?? "", /```ts\nconst ok = true;/u);
});

test("terminal report title extraction handles long protocol whitespace", () => {
  const title = `Original request${" ".repeat(100_000)}: concise result Requested objective ignored wrapper`;
  const report = terminalReportToViewModel({
    id: "terminal_report_long_wrapper",
    status: "committed",
    language: "en-US",
    outcome: { status: "succeeded", title, summary: "done", corrections: [], sourceRefs: [] },
    changes: [], verification: [], participants: [], artifacts: [], risks: [], references: [],
    evidenceFingerprint: "fingerprint_long_wrapper",
    committedAt: "2026-10-21T00:00:00.000Z",
  });
  assert.equal(report.rows.find((row) => row.reportSection === "outcome")?.title, "concise result");
});

test("terminal report artifact workspace paths require one trusted changed-file source ref", () => {
  const report = terminalReportToViewModel({
    id: "terminal_report_workspace_files",
    status: "committed",
    language: "en-US",
    outcome: {
      status: "succeeded",
      title: "Workspace files updated",
      summary: "The changed files are available for review.",
      corrections: [],
      sourceRefs: [],
    },
    changes: [{
      id: "change_workspace_files",
      title: "Update files",
      summary: "Updated workspace files.",
      paths: ["apps/web/src/view.tsx", "docs/view.tsx", "docs/notes.md", "run_1/internal.txt"],
      sourceRefs: [],
    }],
    verification: [],
    participants: [],
    artifacts: [
      {
        id: "trusted_exact",
        kind: "diff",
        title: "view.tsx",
        path: "apps/web/src/view.tsx",
        sourceRefs: [{ kind: "file", id: "apps/web/src/view.tsx", visibility: "conversation" }],
      },
      {
        id: "trusted_internal_copy",
        kind: "document",
        title: "notes.md",
        path: "run_1/notes-output.md",
        sourceRefs: [{ kind: "file", id: "docs/notes.md", visibility: "conversation" }],
      },
      {
        id: "exact_without_file_ref",
        kind: "file",
        title: "view.tsx",
        path: "apps/web/src/view.tsx",
        sourceRefs: [],
      },
      {
        id: "artifact_ref_only",
        kind: "file",
        title: "internal.txt",
        path: "run_1/internal.txt",
        sourceRefs: [{ kind: "artifact", id: "run_1/internal.txt", visibility: "conversation" }],
      },
      {
        id: "ambiguous_file_refs",
        kind: "document",
        title: "view.tsx",
        path: "run_1/view-output.tsx",
        sourceRefs: [
          { kind: "file", id: "apps/web/src/view.tsx", visibility: "conversation" },
          { kind: "file", id: "docs/view.tsx", visibility: "conversation" },
        ],
      },
      {
        id: "developer_only_file_ref",
        kind: "file",
        title: "notes.md",
        path: "docs/private-notes.md",
        sourceRefs: [{ kind: "file", id: "docs/private-notes.md", visibility: "developer_only" }],
      },
      {
        id: "unsupported_kind",
        kind: "other",
        title: "notes.md",
        path: "docs/notes.md",
        sourceRefs: [{ kind: "file", id: "docs/notes.md", visibility: "conversation" }],
      },
    ],
    risks: [],
    references: [],
    evidenceFingerprint: "fingerprint_workspace_files",
    committedAt: "2026-07-14T00:00:00.000Z",
  });

  const artifacts = report.artifactStripItems.filter((item) => item.kind === "artifact");
  assert.equal(artifacts.find((item) => item.id.endsWith(":trusted_exact"))?.workspaceFilePath, "apps/web/src/view.tsx");
  assert.equal(artifacts.find((item) => item.id.endsWith(":trusted_internal_copy"))?.workspaceFilePath, "docs/notes.md");
  assert.equal(artifacts.find((item) => item.id.endsWith(":exact_without_file_ref"))?.workspaceFilePath, undefined);
  assert.equal(artifacts.find((item) => item.id.endsWith(":artifact_ref_only"))?.workspaceFilePath, undefined);
  assert.equal(artifacts.find((item) => item.id.endsWith(":ambiguous_file_refs"))?.workspaceFilePath, undefined);
  assert.equal(artifacts.find((item) => item.id.endsWith(":developer_only_file_ref"))?.workspaceFilePath, undefined);
  assert.equal(artifacts.find((item) => item.id.endsWith(":unsupported_kind"))?.workspaceFilePath, undefined);
});

test("terminal report renders approval decision instead of hiding it behind risk status", () => {
  const report = terminalReportToViewModel({
    id: "terminal_report_approval",
    status: "fallback",
    language: "zh-CN",
    outcome: {
      status: "blocked",
      title: "任务未完成",
      summary: "命令未执行。",
      corrections: [],
      sourceRefs: [],
    },
    changes: [],
    verification: [],
    participants: [],
    artifacts: [],
    risks: [{
      id: "approval-risk-1",
      severity: "critical",
      status: "unresolved",
      approvalDecision: "denied",
      summary: "Approval denied: git push",
      nextAction: "The requested action was not executed.",
      sourceRefs: [{ kind: "approval", id: "approval-1", visibility: "conversation" }],
    }],
    references: [],
    evidenceFingerprint: "fingerprint_approval",
    committedAt: "2026-08-20T00:00:00.000Z",
  });

  const risk = report.rows.find((row) => row.reportSection === "risk");
  assert.equal(risk?.meta, "已拒绝");
  assert.equal(risk?.description, "The requested action was not executed.");
});

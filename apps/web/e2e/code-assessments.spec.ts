import type { CodeAssessmentComment, CodeAssessmentDetail, CodeAssessmentFreshness, CodeAssessmentOverview, CodeFindingCloseReason, CodeFindingDisposition, CreateCodeAssessmentCommentRequest, CreateCodeAssessmentRequest } from "@ling-stack/contracts";
import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockDaemon } from "./support/mock-daemon";
import { openEngineeringChannel } from "./support/test-helpers";
import { createBaseState, createChatProvider } from "./support/mock-state";

async function openAssessmentDock(page: Page, kind: "review" | "security" = "review") {
  await openEngineeringChannel(page);
  await page.getByRole("toolbar", { name: /^(Workspace task toolbar|工作区任务工具栏)$/u })
    .getByRole("button", { name: /^(Show details|显示详情)$/u }).click();
  const dock = page.getByRole("complementary", { name: /^(Channel workspace dock|频道工作区面板)$/u });
  if (kind === "security") {
    await dock.getByRole("button", { name: /^(Security scan|安全扫描)$/u }).click();
  } else {
    await dock.getByRole("button", { name: /^(Review|复核)$/u }).click();
    await dock.getByRole("button", { name: /^(Code review|代码审查)$/u }).click();
  }
  await expect(dock.getByRole("region", { name: /^(Code review and security|代码审查与安全扫描)$/u })).toBeVisible();
  return dock;
}

test("Code review workbench starts a review, filters findings, shows Diff, and records a dismissal", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_review", displayName: "Review Model" })];
  await mockDaemon(page, state);
  const model = await assessmentRoutes(page, assessmentFixture(), { created: false });
  await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { schemaVersion: 1, notifications: [] } }));
  await page.goto("/");
  await openAssessmentDock(page);
  await expect(page.getByLabel("Model")).toHaveValue("provider_review");
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByText("Changed exported value")).toBeVisible();
  await expect(page.getByText("Findings (1)")).toBeVisible();
  await page.getByLabel("Severity").selectOption("high");
  await page.getByRole("button", { name: /src\/app\.ts:1/u }).click();
  await expect(page.getByRole("heading", { name: "Captured Diff" })).toBeVisible();
  await expect(page.locator(".diff-viewer")).toContainText("export const value = 2;");
  await page.getByRole("button", { name: "Ignore", exact: true }).last().click();
  await page.getByLabel("Dismissal reason").fill("Expected for this change.");
  await page.getByRole("button", { name: "Ignore", exact: true }).last().click();
  await page.getByLabel("Finding status").selectOption("dismissed");
  await expect(page.getByText("Expected for this change.")).toBeVisible();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByLabel("Finding status").selectOption("open");
  await expect(page.getByText("Changed exported value")).toBeVisible();
  await expect(page.getByText("Expected for this change.")).toHaveCount(0);
  expect(model.dispositions.map(input => input.disposition)).toEqual(["dismissed", "open"]);
  expect(model.fileRequests).toContain("src/app.ts");
  expect(model.overviews.every(detail => detail.snapshot.files.every(file => !("diff" in file)))).toBe(true);
  await page.screenshot({ path: "/tmp/ling-code-assessment-workbench.png", fullPage: false });
});

test("The security scan stays readable in a narrow dock", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" }); state.providers = [createChatProvider({ id: "provider_security", displayName: "Security Model" })]; await mockDaemon(page, state);
  await page.route("**/workspace/code-assessments**", async route => { const request = route.request(); const url = new URL(request.url()); if (request.method() === "GET" && !url.pathname.includes("/workspace/code-assessments/")) { await route.fulfill({ json: { assessments: [] } }); return; } await route.fulfill({ status: 202, json: { assessments: [] } }); });
  await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { schemaVersion: 1, notifications: [] } }));
  await page.goto("/");
  const dock = await openAssessmentDock(page, "security");
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(dock.getByRole("button", { name: "Start security scan" })).toBeVisible();
  await expect(dock.getByRole("region", { name: "Code review and security" })).toHaveCSS("min-width", "0px");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1000);
  await page.screenshot({ path: "/tmp/ling-code-assessment-narrow.png", fullPage: false });
});

test("finding order follows severity, confidence, path and line with stable ties", async ({ page }) => {
  const fixture = assessmentFixture();
  const base = fixture.findings[0]!;
  const findings: CodeAssessmentDetail["findings"] = [
    { ...base, id: "info", title: "Informational finding", severity: "info" },
    { ...base, id: "low", title: "Low severity finding", severity: "low" },
    { ...base, id: "medium", title: "Medium severity finding", severity: "medium" },
    { ...base, id: "high_low", title: "High severity low confidence", confidence: "low" },
    { ...base, id: "high_medium", title: "High severity medium confidence", confidence: "medium" },
    { ...base, id: "path_z", title: "Later path", path: "src/z.ts" },
    { ...base, id: "line_later", title: "Later line", startLine: 2, endLine: 2 },
    { ...base, id: "range_longer", title: "Longer range", endLine: 2 },
    { ...base, id: "tie_first", title: "First equal anchor" },
    { ...base, id: "tie_second", title: "Second equal anchor" },
    { ...base, id: "path_a", title: "Earlier path", path: "src/a.ts" },
    { ...base, id: "critical", title: "Critical finding", severity: "critical", confidence: "low" },
  ];
  const sourceFile = { ...fixture.snapshot.files[0]!, diff: "@@ -1,2 +1,2 @@\n-export const value = 1;\n+export const value = 2;\n tail\n" };
  const detail: CodeAssessmentDetail = { ...fixture, assessment: { ...fixture.assessment, findingCount: findings.length, diagnosticArtifactId: "artifact_diagnostic_ui" }, findings,
    snapshot: { ...fixture.snapshot, totalFileCount: 3, files: [sourceFile, { ...sourceFile, path: "src/a.ts" }, { ...sourceFile, path: "src/z.ts" }] } };
  await openAssessment(page, detail);
  const headings = page.locator(".code-assessment-findings h4");
  const highConfidenceOrder = ["Earlier path", "First equal anchor", "Second equal anchor", "Longer range", "Later line", "Later path"];
  const ordered = ["Critical finding", ...highConfidenceOrder, "High severity medium confidence", "High severity low confidence", "Medium severity finding", "Low severity finding", "Informational finding"];
  await expect(headings).toHaveText(ordered);
  await page.getByLabel("Confidence", { exact: true }).selectOption("high");
  await expect(headings).toHaveText([...highConfidenceOrder, "Medium severity finding", "Low severity finding", "Informational finding"]);
  await page.getByLabel("Confidence", { exact: true }).selectOption("medium");
  await expect(headings).toHaveText(["High severity medium confidence"]);
  await page.getByLabel("Confidence", { exact: true }).selectOption("low");
  await expect(headings).toHaveText(["Critical finding", "High severity low confidence"]);
  await page.getByLabel("Severity", { exact: true }).selectOption("info");
  await expect(page.getByText("No findings match these filters.", { exact: true })).toBeVisible();
  await page.getByLabel("Confidence", { exact: true }).selectOption("");
  await expect(headings).toHaveText(["Informational finding"]);
  await expect(page.locator("#finding-info").getByText("Info", { exact: true })).toBeVisible();
  await page.getByLabel("Severity", { exact: true }).selectOption("");
  await expect(headings).toHaveText(ordered);
  await page.getByLabel("Confidence", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/ling-code-assessment-confidence-order.png" });
  await page.getByText("Coverage and technical details", { exact: true }).click();
  await expect(page.locator(".code-assessment-technical")).toContainText("artifact_diagnostic_ui");
  await page.getByLabel("Confidence", { exact: true }).selectOption("low");
  await page.locator(".diff-viewer").getByRole("button", { name: "First equal anchor", exact: true }).click();
  await expect(page.getByLabel("Confidence", { exact: true })).toHaveValue("");
  await expect(headings).toHaveText(ordered);
  await expect(page.locator("#finding-tie_first")).toHaveClass(/selected/u);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1000);
  await page.getByLabel("Confidence", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/ling-code-assessment-confidence-order-narrow.png" });
});

function assessmentFixture(): CodeAssessmentDetail {
  const snapshot = { id: "snapshot_ui", digest: "d".repeat(64), capturedAt: "2026-11-16T00:00:00Z", target: { type: "working_tree" as const }, branchName: "feature/review", headSha: "e".repeat(40), files: [{ path: "src/app.ts", kind: "modified" as const, diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n", contentDigest: "f".repeat(64), redacted: false }], totalFileCount: 1, coverage: "complete" as const, exclusions: [] };
  const assessment: CodeAssessmentDetail["assessment"] = { id: "assessment_ui", kind: "review", status: "completed", phase: "completed", phaseHistory: [
    { phase: "preparing", enteredAt: "2026-11-16T00:00:00Z" }, { phase: "collecting_diff", enteredAt: "2026-11-16T00:00:01Z" },
    { phase: "reviewing_code", enteredAt: "2026-11-16T00:00:02Z" }, { phase: "validating_output", enteredAt: "2026-11-16T00:00:03Z" },
    { phase: "validating_candidates", enteredAt: "2026-11-16T00:00:04Z", status: "skipped", reason: "Candidate validation requires execution and was not run." },
    { phase: "synthesizing_findings", enteredAt: "2026-11-16T00:00:05Z" }, { phase: "completed", enteredAt: "2026-11-16T00:01:00Z" },
  ], metrics: { captureDurationMs: 12, snapshotBytes: 512, diffBytes: 96, timeToSummaryMs: 140, timeToFirstFindingMs: 140, timeToFinalMs: 180, reportBytes: 256 },
    validation: { state: "not_run", reason: "Candidate validation requires execution and was not run." },
    snapshotId: snapshot.id, snapshotDigest: snapshot.digest, target: snapshot.target, branchName: snapshot.branchName, providerPresetId: "provider_review", runId: "run_ui", reportArtifactId: "artifact_ui", summary: "One changed behavior needs review.", findingCount: 1, createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:01:00Z",
    reviewRules: { baseSha: snapshot.headSha, sources: [{
      path: "src/AGENTS.md", scope: "src", digest: "a".repeat(64), guidance: "Check compatibility for existing callers.",
    }], omitted: [] },
  };
  const finding = { id: "finding_ui", assessmentId: assessment.id, snapshotDigest: snapshot.digest, fingerprint: "1".repeat(64), title: "Changed exported value", body: "Every caller now observes a different value.", severity: "high" as const, confidence: "high" as const, path: "src/app.ts", side: "new" as const, startLine: 1, endLine: 1, evidence: "export const value = 2;", validation: "unverified" as const, disposition: "open" as const };
  return { assessment, snapshot, findings: [finding] };
}

for (const themeId of ["ling-light", "ling-dark", "ling-breeze", "ling-ocean", "ling-night", "ling-journey"]) {
  test(`assessment result renders with ${themeId} and no page errors`, async ({ page }) => {
    await page.addInitScript(theme => {
      const selection = JSON.stringify({ mode: "fixed", themeId: theme });
      localStorage.setItem("ling-stack.locale", "en-US");
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    }, themeId);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const state = createBaseState({ approvalStatus: "expired" }); state.providers = [createChatProvider()];
    await mockDaemon(page, state);
    const detail = assessmentFixture();
    await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { schemaVersion: 1, notifications: [] } }));
    await assessmentRoutes(page, detail);
    await page.goto("/");
    await expect(page).toHaveTitle(/Ling/u);
    await openAssessmentDock(page);
    await expect(page.getByText("Changed exported value")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(await page.locator(".code-assessment-page").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/ling-code-assessment-${themeId}.png` });
  });
}

test("Right Dock keeps change previews and opens review/security assessments", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" }); state.providers = [createChatProvider({ id: "provider_dock" })];
  await mockDaemon(page, state);
  await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { schemaVersion: 1, notifications: [] } }));
  const fixture = assessmentFixture();
  await assessmentRoutes(page, fixture, { created: false });
  await page.route("**/workspace/code-assessments?**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("kind") === "security") {
      await route.fulfill({ json: { assessments: [] } });
    } else await route.fallback();
  });
  await page.goto("/"); await openEngineeringChannel(page);
  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  await toolbar.getByRole("button", { name: "Show details" }).click();
  const panel = page.getByRole("complementary", { name: "Channel workspace dock" });
  await panel.getByRole("button", { name: "Review", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Changed files", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Code review", exact: true }).click();
  await panel.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(panel.getByText("Changed exported value", { exact: true })).toBeVisible();
  const instructions = panel.locator("details").filter({ has: page.getByText("src/AGENTS.md", { exact: true }) });
  await instructions.getByText("Review instructions", { exact: true }).click();
  await expect(instructions.getByText("src/AGENTS.md", { exact: true })).toBeVisible();
  await expect(instructions.getByText("Check compatibility for existing callers.", { exact: true })).toBeVisible();
  await expect(instructions.getByText(fixture.snapshot.headSha!, { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await panel.getByRole("button", { name: "Security scan", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Start security scan" })).toBeVisible();
  await expect(panel.getByLabel("Model")).toHaveValue("provider_dock");
  await expect(panel.getByRole("button", { name: "Start security scan" })).toBeEnabled();
  await expect(panel.getByText("No assessments yet.")).toBeVisible();
  await page.screenshot({ path: "/tmp/ling-code-assessment-dock.png" });
});

for (const status of ["failed", "cancelled", "interrupted", "partial"] as const) {
  test(`${status} assessment preserves its coverage and never claims a clean review`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const state = createBaseState({ approvalStatus: "expired" });
    state.providers = [createChatProvider()];
    await mockDaemon(page, state);
    const fixture = assessmentFixture();
    const detail: CodeAssessmentDetail = {
      ...fixture,
      assessment: { ...fixture.assessment, status, phase: status, phaseHistory: [...fixture.assessment.phaseHistory.slice(0, -1), { phase: status, enteredAt: "2026-11-16T00:01:00Z" }], findingCount: 0, summary: undefined, errorMessage: status === "failed" ? "Model response was invalid." : undefined },
      snapshot: { ...fixture.snapshot, coverage: status === "partial" ? "partial" : "complete", exclusions: status === "partial" ? [{ path: ".env", reason: "sensitive" }] : [] },
      findings: [],
    };
    await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { schemaVersion: 1, notifications: [] } }));
    await assessmentRoutes(page, detail);
    await page.goto("/");
    await openAssessmentDock(page);
    await expect(page.getByRole("button", { name: "Run again", exact: true })).toBeVisible();
    if (status === "partial") {
      await expect(page.getByText("Coverage is partial", { exact: true })).toBeVisible();
      await expect(page.getByText("Excluded or redacted content was not fully assessed.")).toBeVisible();
    } else {
      await expect(page.getByText("No report was produced. Run again to try a fresh snapshot.")).toBeVisible();
      await expect(page.getByText("No supported findings were reported in the assessed content.")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Export result" })).toHaveCount(0);
    }
  });
}

test("Chinese workbench submits a security branch target with the selected model", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_branch" })];
  await mockDaemon(page, state);
  const fixture = assessmentFixture();
  const target = { type: "branch" as const, baseRef: "origin/release" };
  const detail: CodeAssessmentDetail = {
    ...fixture,
    assessment: { ...fixture.assessment, kind: "security", target },
    snapshot: { ...fixture.snapshot, target },
  };
  await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { schemaVersion: 1, notifications: [] } }));
  const model = await assessmentRoutes(page, detail, { created: false });
  await page.goto("/");
  await openAssessmentDock(page, "security");
  await page.getByLabel("目标", { exact: true }).selectOption("branch");
  await page.getByLabel("基线分支").fill(target.baseRef);
  await page.getByRole("button", { name: "开始安全扫描" }).click();
  await expect(page.getByText("Changed exported value")).toBeVisible();
  await expect(page.getByText("发现项仍未验证。忽略发现项不会修复问题。")).toBeVisible();
  expect(model.creates).toEqual([{ kind: "security", target, providerPresetId: "provider_branch" }]);
  await expect(page.getByRole("button", { name: "开始安全扫描", exact: true })).toBeEnabled();
  await page.screenshot({ path: "/tmp/ling-code-assessment-zh-CN.png" });
});

type DispositionInput = { snapshotDigest: string; disposition: CodeFindingDisposition; reason?: string; closeReason?: CodeFindingCloseReason };
function assessmentOverview(detail: CodeAssessmentDetail): CodeAssessmentOverview {
  return { ...detail, snapshot: { ...detail.snapshot, files: detail.snapshot.files.map(({ diff, ...file }) => ({ ...file,
    additions: diff.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: diff.split("\n").filter(line => line.startsWith("-") && !line.startsWith("---")).length })) } };
}
async function assessmentRoutes(page: Page, initial: CodeAssessmentDetail, options: {
  created?: boolean;
  file?: (route: Route, path: string, detail: CodeAssessmentDetail) => boolean | Promise<boolean>;
} = {}) {
  const model = { detail: initial, created: options.created ?? true, freshness: "current" as CodeAssessmentFreshness["state"],
    creates: [] as CreateCodeAssessmentRequest[], dispositions: [] as DispositionInput[], comments: [] as CodeAssessmentComment[],
    fileRequests: [] as string[], overviews: [] as CodeAssessmentOverview[] };
  const overview = () => {
    const detail = assessmentOverview(model.detail);
    model.overviews.push(detail);
    return detail;
  };
  await page.route("**/workspace/code-assessments**", async route => {
    const request = route.request(), url = new URL(request.url());
    const collection = url.pathname.endsWith("/workspace/code-assessments");
    if (collection && request.method() === "GET") {
      await route.fulfill({ json: { assessments: model.created ? [model.detail.assessment] : [] } }); return;
    }
    if (collection && request.method() === "POST") {
      const input = request.postDataJSON() as CreateCodeAssessmentRequest;
      model.creates.push(input); model.created = true;
      model.detail = { ...model.detail, assessment: { ...model.detail.assessment, kind: input.kind, target: input.target,
        providerPresetId: input.providerPresetId, instructions: input.instructions }, snapshot: { ...model.detail.snapshot, target: input.target } };
      await route.fulfill({ status: 202, json: url.searchParams.get("view") === "overview" ? overview() : model.detail }); return;
    }
    if (url.pathname.endsWith("/snapshot-file") && request.method() === "GET") {
      const path = url.searchParams.get("path") ?? "";
      model.fileRequests.push(path);
      if (await options.file?.(route, path, model.detail)) return;
      const file = model.detail.snapshot.files.find(file => file.path === path);
      await route.fulfill({ status: file ? 200 : 404, json: file ? { snapshotDigest: model.detail.snapshot.digest, file } : { error: "file_not_found" } }); return;
    }
    if (url.pathname.endsWith("/freshness") && request.method() === "POST") {
      const freshness = { state: model.freshness, checkedAt: "2026-11-16T00:02:00Z" };
      model.detail = { ...model.detail, assessment: { ...model.detail.assessment, freshness },
        findings: model.detail.findings.map(finding => ({ ...finding, ...(freshness.state === "unknown" ? {} : { freshnessState: freshness.state }) })) };
      await route.fulfill({ json: freshness }); return;
    }
    if (url.pathname.endsWith("/cancel") && request.method() === "POST") {
      model.detail = { ...model.detail, assessment: { ...model.detail.assessment, status: "cancelled", phase: "cancelled",
        phaseHistory: [...model.detail.assessment.phaseHistory, { phase: "cancelled", enteredAt: "2026-11-16T00:02:00Z" }],
        metrics: { ...model.detail.assessment.metrics, cancelLatencyMs: 40 } } };
      await route.fulfill({ json: model.detail }); return;
    }
    const findingRoute = /\/findings\/([^/]+)(\/comments)?$/u.exec(url.pathname);
    if (findingRoute) {
      const finding = model.detail.findings.find(finding => finding.id === decodeURIComponent(findingRoute[1]!));
      expect(finding).toBeDefined();
      if (!finding) throw new Error("Unknown finding fixture.");
      if (findingRoute[2]) {
        if (request.method() === "GET") { await route.fulfill({ json: { comments: model.comments.filter(comment => comment.findingId === finding.id) } }); return; }
        const input = request.postDataJSON() as CreateCodeAssessmentCommentRequest;
        expect(input).toMatchObject({ snapshotDigest: finding.snapshotDigest, path: finding.path, side: finding.side, startLine: finding.startLine, endLine: finding.endLine });
        const comment: CodeAssessmentComment = { ...input, id: `comment_${model.comments.length + 1}`, assessmentId: finding.assessmentId, findingId: finding.id, createdAt: "2026-11-16T00:02:00Z" };
        model.comments.push(comment);
        await route.fulfill({ status: 201, json: comment }); return;
      }
      const input = request.postDataJSON() as DispositionInput;
      expect(input.snapshotDigest).toBe(model.detail.snapshot.digest);
      model.dispositions.push(input);
      const next = { ...finding, disposition: input.disposition, dispositionReason: input.reason, closeReason: input.closeReason };
      model.detail = { ...model.detail, findings: model.detail.findings.map(item => item.id === finding.id ? next : item) };
      await route.fulfill({ json: next }); return;
    }
    if (request.method() === "GET") {
      await route.fulfill({ json: url.searchParams.get("view") === "overview" ? overview() : model.detail }); return;
    }
    await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return model;
}

async function openAssessment(page: Page, detail = assessmentFixture(), options?: Parameters<typeof assessmentRoutes>[2]) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_review", displayName: "Review Model" })];
  await mockDaemon(page, state);
  await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { schemaVersion: 1, notifications: [] } }));
  const model = await assessmentRoutes(page, detail, options);
  await page.goto("/");
  await openAssessmentDock(page);
  return model;
}

for (const baseRef of [undefined, "release~1"]) {
  test(`Commit target submits a full SHA, ${baseRef ? "an explicit base" : "the default parent"}, and review guidance`, async ({ page }) => {
    const model = await openAssessment(page, assessmentFixture(), { created: false });
    await page.getByLabel("Target", { exact: true }).selectOption("commit");
    await expect(page.getByRole("button", { name: "Start review", exact: true })).toBeDisabled();
    await page.getByLabel("Commit SHA").fill("123abcd");
    await expect(page.getByRole("button", { name: "Start review", exact: true })).toBeDisabled();
    const commitSha = "a".repeat(40);
    await page.getByLabel("Commit SHA").fill(commitSha);
    await expect(page.getByLabel("Base revision (optional)", { exact: true })).toHaveValue("");
    if (baseRef) await page.getByLabel("Base revision (optional)", { exact: true }).fill(baseRef);
    await page.locator(".code-assessment-start summary").filter({ hasText: "Review instructions" }).click();
    await page.getByLabel("Review instructions", { exact: true }).fill("Check migration rollback and error paths.");
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await expect(page.getByText("Changed exported value", { exact: true })).toBeVisible();
    expect(model.creates).toEqual([{ kind: "review", providerPresetId: "provider_review", target: { type: "commit", commitSha, ...(baseRef ? { baseRef } : {}) }, instructions: "Check migration rollback and error paths." }]);
    await expect(page.getByRole("list", { name: "Assessment progress" })).toContainText("Checking evidence");
    await expect(page.getByRole("list", { name: "Assessment progress" })).toContainText("Not run");
    await page.getByText("Coverage and technical details", { exact: true }).click();
    await expect(page.locator(".code-assessment-technical")).toContainText("timeToFinalMs");
    await expect(page.locator(".code-assessment-technical")).toContainText("Candidate validation requires execution and was not run.");
  });
}

test("finding comments preserve exact old/new anchors and Diff markers work from the keyboard", async ({ page }) => {
  const fixture = assessmentFixture();
  const oldFinding = { ...fixture.findings[0]!, id: "finding_old", side: "old" as const, title: "Removed exported value", evidence: "export const value = 1;" };
  const model = await openAssessment(page, { ...fixture, assessment: { ...fixture.assessment, findingCount: 2 }, findings: [oldFinding, ...fixture.findings] });
  const oldCard = page.locator("#finding-finding_old");
  await oldCard.getByRole("button", { name: /src\/app\.ts:1/u }).click();
  await page.getByLabel("Diff layout").selectOption("split");
  const oldLine = page.locator('.diff-line[data-diff-side="old"][data-old-line="1"]');
  await expect(oldLine).toHaveAttribute("data-annotation-selected", "true");
  await expect(oldLine).toBeFocused();
  await expect(oldLine.getByRole("button", { name: oldFinding.title, exact: true })).toHaveCount(1);
  await expect(page.locator('[data-diff-side="new"]').getByRole("button", { name: oldFinding.title, exact: true })).toHaveCount(0);
  await oldCard.getByRole("button", { name: "Comments", exact: true }).click();
  await oldCard.getByLabel("Finding comment").fill("The previous exported value is part of the public contract.");
  await oldCard.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(oldCard.getByText("The previous exported value is part of the public contract.", { exact: true })).toBeVisible();
  expect(model.comments[0]).toMatchObject({ snapshotDigest: fixture.snapshot.digest, path: oldFinding.path, side: "old", startLine: 1, endLine: 1 });
  const newMarker = page.locator('[data-diff-side="new"]').getByRole("button", { name: "Changed exported value", exact: true });
  await newMarker.focus(); await newMarker.press("Enter");
  const newCard = page.locator("#finding-finding_ui");
  await expect(newCard).toHaveClass(/selected/u);
  await newCard.getByRole("button", { name: "Comments", exact: true }).click();
  await newCard.getByLabel("Finding comment").fill("Confirm the new contract with callers.");
  await newCard.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(newCard.getByText("Confirm the new contract with callers.", { exact: true })).toBeVisible();
  expect(model.comments[1]).toMatchObject({ snapshotDigest: fixture.snapshot.digest, path: "src/app.ts", side: "new", startLine: 1, endLine: 1 });
});

test("acknowledgement, typed resolution and stale gating remain separate finding states", async ({ page }) => {
  const model = await openAssessment(page);
  const card = page.locator("#finding-finding_ui");
  await expect(page.locator(".code-assessment-result-heading").getByText("Read only", { exact: true })).toBeVisible();
  await page.getByLabel("Finding status").selectOption("stale");
  await expect(page.getByText("No findings match these filters.", { exact: true })).toBeVisible();
  await page.getByLabel("Finding status").selectOption("open");
  await expect(card.getByRole("button", { name: "Mark resolved", exact: true })).toBeDisabled();
  await card.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await page.getByLabel("Finding status").selectOption("acknowledged");
  await expect(card.getByText("Acknowledged", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check for changes", exact: true }).click();
  await expect(page.getByText("Snapshot matches", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Mark resolved", exact: true }).click();
  await expect(card.getByRole("button", { name: "Mark resolved", exact: true })).toBeDisabled();
  await card.getByLabel("Close reason", { exact: true }).selectOption("accepted_risk");
  await card.getByLabel("Dismissal reason").fill("The compatibility change is accepted by the owner.");
  await card.getByRole("button", { name: "Mark resolved", exact: true }).click();
  await page.getByLabel("Finding status").selectOption("resolved");
  await expect(card.getByText("Resolved", { exact: true })).toBeVisible();
  await expect(card.getByText("Close reason: Accepted risk", { exact: true })).toBeVisible();
  expect(model.dispositions.at(-1)).toEqual({ snapshotDigest: model.detail.snapshot.digest, disposition: "resolved", closeReason: "accepted_risk", reason: "The compatibility change is accepted by the owner." });
  await card.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByLabel("Finding status").selectOption("open");
  model.freshness = "stale";
  await page.getByRole("button", { name: "Check for changes", exact: true }).click();
  await expect(page.getByText("Snapshot is outdated", { exact: true })).toBeVisible();
  await page.getByLabel("Finding status").selectOption("stale");
  await expect(card.getByText("Stale", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Mark resolved", exact: true })).toBeDisabled();
  expect(model.dispositions.map(input => input.disposition)).toEqual(["acknowledged", "resolved", "open"]);
});

test("Diff layout aligns both revisions and auto responds to container width", async ({ page }) => {
  await page.setViewportSize({ width: 2240, height: 1100 });
  const fixture = assessmentFixture();
  const diff = "@@ -1,3 +1,3 @@\n context\n-export const value = 1;\n+export const value = 2;\n tail\n@@ -10 +10 @@\n-before\n+after\n";
  await openAssessment(page, { ...fixture, snapshot: { ...fixture.snapshot, files: [{ ...fixture.snapshot.files[0]!, diff }] },
    findings: [{ ...fixture.findings[0]!, startLine: 2, endLine: 2 }] });
  const viewer = page.locator(".diff-viewer");
  await expect(viewer).toHaveAttribute("data-diff-layout", "unified");
  const handle = page.getByRole("separator", { name: "Resize workspace dock" });
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  const { x, y, width, height } = bounds!;
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x - 900, y + height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(viewer).toHaveAttribute("data-diff-layout", "split");
  const replacement = viewer.locator(".diff-split-row").filter({ hasText: "export const value = 1;" });
  await expect(replacement.locator('[data-diff-side="old"]')).toContainText("export const value = 1;");
  await expect(replacement.locator('[data-diff-side="new"]')).toContainText("export const value = 2;");
  const oldBox = await replacement.locator('[data-diff-side="old"]').boundingBox();
  const newBox = await replacement.locator('[data-diff-side="new"]').boundingBox();
  expect(oldBox && newBox && oldBox.y === newBox.y && oldBox.x < newBox.x).toBe(true);
  const context = viewer.locator(".diff-split-row").filter({ hasText: "context" });
  await expect(context.locator("code")).toHaveCount(2);
  const fold = viewer.locator(".diff-fold");
  expect(await fold.evaluate(element => element.clientWidth >= element.parentElement!.clientWidth - 2)).toBe(true);
  await viewer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/ling-code-assessment-split.png" });
  await page.getByLabel("Diff layout").selectOption("unified");
  await expect(viewer).toHaveAttribute("data-diff-layout", "unified");
  await expect(viewer.locator(".diff-split-row")).toHaveCount(0);
  await expect(viewer.locator("code").filter({ hasText: "context" })).toHaveCount(1);
  await page.getByLabel("Diff layout").selectOption("auto");
  await expect(viewer).toHaveAttribute("data-diff-layout", "split");
  await page.setViewportSize({ width: 1000, height: 1000 });
  await expect(viewer).toHaveAttribute("data-diff-layout", "unified");
  await viewer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/ling-code-assessment-auto-narrow.png" });
  await page.getByLabel("Diff layout").selectOption("split");
  await expect(viewer).toHaveAttribute("data-diff-layout", "split");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1000);
});

test("a selected finding expands a collapsed hunk and focuses its exact revision line", async ({ page }) => {
  const fixture = assessmentFixture();
  const diff = `@@ -1,181 +1,181 @@\n${Array.from({ length: 179 }, (_, index) => ` context ${index + 1}\n`).join("")}-export const value = 1;\n+export const value = 2;\n tail\n`;
  await openAssessment(page, { ...fixture, snapshot: { ...fixture.snapshot, files: [{ ...fixture.snapshot.files[0]!, diff }] },
    findings: [{ ...fixture.findings[0]!, startLine: 180, endLine: 180 }] });
  const viewer = page.locator(".diff-viewer");
  await expect(viewer.locator('[data-new-line="180"]')).toHaveCount(0);
  await page.getByRole("button", { name: /src\/app\.ts:180/u }).click();
  const selected = viewer.locator('.diff-line[data-new-line="180"][data-annotation-selected="true"]');
  await expect(selected).toContainText("export const value = 2;");
  await expect(selected).toBeFocused();
  await expect(page.getByRole("button", { name: "Collapse diff ranges", exact: true })).toBeVisible();
});

test("late file responses cannot replace the currently selected captured file", async ({ page }) => {
  const fixture = assessmentFixture();
  const secondFile = { ...fixture.snapshot.files[0]!, path: "src/second.ts", diff: "@@ -1 +1 @@\n-before second\n+after second\n" };
  const releaseFirst: (() => Promise<void>)[] = [];
  const model = await openAssessment(page, { ...fixture, snapshot: { ...fixture.snapshot, totalFileCount: 2, files: [...fixture.snapshot.files, secondFile] } }, {
    file: (route, path, detail) => {
      if (path !== "src/app.ts") return false;
      releaseFirst.push(() => route.fulfill({ json: { snapshotDigest: detail.snapshot.digest, file: detail.snapshot.files[0] } }));
      return true;
    },
  });
  await expect.poll(() => releaseFirst.length).toBeGreaterThan(0);
  await page.getByRole("navigation", { name: "Captured files" }).getByRole("button", { name: /second\.ts/u }).click();
  await expect(page.locator(".diff-viewer")).toContainText("after second");
  const lateResponse = page.waitForResponse(response => response.url().includes("/snapshot-file") && new URL(response.url()).searchParams.get("path") === "src/app.ts");
  await Promise.all(releaseFirst.map(release => release())); await (await lateResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(page.locator(".diff-viewer")).toContainText("after second");
  await expect(page.locator(".diff-viewer")).not.toContainText("export const value = 2;");
  expect(new Set(model.fileRequests)).toEqual(new Set(["src/app.ts", "src/second.ts"]));
});

test("an active assessment can be cancelled, rerun with its guidance, and exported as a complete download", async ({ page }) => {
  const fixture = assessmentFixture();
  const instructions = "Keep public exports stable.";
  const model = await openAssessment(page, { ...fixture, assessment: { ...fixture.assessment, status: "analyzing", phase: "reviewing_code",
    phaseHistory: fixture.assessment.phaseHistory.slice(0, 3), summary: undefined, reportArtifactId: undefined, findingCount: 0, instructions }, findings: [] });
  await expect(page.getByRole("button", { name: "Start review", exact: true })).toBeDisabled();
  await expect(page.getByRole("list", { name: "Assessment progress" })).toContainText("Reviewing code");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("No report was produced. Run again to try a fresh snapshot.")).toBeVisible();
  const runAgain = page.getByRole("button", { name: "Run again", exact: true });
  await expect(runAgain).toBeEnabled();
  expect(model.detail.assessment.status).toBe("cancelled");
  model.detail = { ...fixture, assessment: { ...fixture.assessment, instructions } };
  await runAgain.click();
  await expect(page.getByText("Changed exported value", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run again", exact: true })).toBeEnabled();
  expect(model.creates).toEqual([{ kind: "review", target: fixture.snapshot.target, providerPresetId: "provider_review", instructions }]);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export result", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("review-report.json");
  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = JSON.parse(await readFile(path!, "utf8")) as CodeAssessmentDetail;
  expect(exported.assessment.instructions).toBe(instructions);
  expect(exported.snapshot.digest).toBe(fixture.snapshot.digest);
  expect(exported.snapshot.files[0]?.diff).toBe(fixture.snapshot.files[0]?.diff);
  expect(exported.findings[0]).toEqual(fixture.findings[0]);
  expect(exported.assessment.validation.state).toBe("not_run");
});

test("Load more appends history pages once and preserves the selected report", async ({ page }) => {
  const fixture = assessmentFixture();
  await openAssessment(page, fixture);
  await expect(page.getByText("Changed exported value", { exact: true })).toBeVisible();
  const second = { ...fixture.assessment, id: "assessment_second", target: { type: "branch" as const, baseRef: "main" } };
  const offsets: number[] = [];
  await page.route("**/workspace/code-assessments?**", async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/code-assessments") || route.request().method() !== "GET") { await route.fallback(); return; }
    const offset = Number(url.searchParams.get("offset") ?? 0); offsets.push(offset);
    await route.fulfill({ json: offset === 0 ? { assessments: [fixture.assessment], nextOffset: 1 } : { assessments: [fixture.assessment, second] } });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  const history = page.getByRole("listbox", { name: "Assessment history" });
  await expect(history.locator(".ling-ui-data-row")).toHaveCount(2);
  await expect(history.getByText("Working tree", { exact: true })).toHaveCount(1);
  await expect(history.getByText("Branch Diff", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  await expect(page.getByText("Changed exported value", { exact: true })).toBeVisible();
  expect(offsets).toEqual([0, 1]);
});

test("late responses cannot replace the current assessment after switching dock tools", async ({ page }) => {
  const review = assessmentFixture();
  await openAssessment(page, review);
  await expect(page.getByText("Changed exported value", { exact: true })).toBeVisible();
  const security: CodeAssessmentDetail = { ...review, assessment: { ...review.assessment, id: "security_current", kind: "security" },
    findings: [{ ...review.findings[0]!, assessmentId: "security_current", id: "security_finding", title: "Current security candidate" }] };
  const other: CodeAssessmentDetail = { ...security, assessment: { ...security.assessment, id: "security_other", target: { type: "branch", baseRef: "release" } },
    findings: [{ ...security.findings[0]!, assessmentId: "security_other", id: "other_finding", title: "Late security candidate" }] };
  let releaseReview: (() => Promise<void>) | undefined, releaseOther: (() => Promise<void>) | undefined;
  const requestedDetails: string[] = [];
  await page.route("**/workspace/code-assessments**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") { await route.fallback(); return; }
    if (url.pathname.endsWith("/code-assessments")) {
      if (url.searchParams.get("kind") === "review") { releaseReview = () => route.fulfill({ json: { assessments: [review.assessment] } }); return; }
      await route.fulfill({ json: { assessments: [security.assessment, other.assessment] } }); return;
    }
    const match = /\/code-assessments\/([^/]+)(\/snapshot-file)?$/u.exec(url.pathname);
    const detail = match?.[1] === security.assessment.id ? security : match?.[1] === other.assessment.id ? other : undefined;
    if (!detail) { await route.fallback(); return; }
    if (match?.[2]) { await route.fulfill({ json: { snapshotDigest: detail.snapshot.digest, file: detail.snapshot.files[0] } }); return; }
    requestedDetails.push(detail.assessment.id);
    if (detail.assessment.id === other.assessment.id) { releaseOther = () => route.fulfill({ json: assessmentOverview(detail) }); return; }
    await route.fulfill({ json: assessmentOverview(detail) });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => Boolean(releaseReview)).toBe(true);
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  await dock.getByRole("button", { name: "Back", exact: true }).click();
  await dock.getByRole("button", { name: "Security scan", exact: true }).click();
  await expect(page.getByText("Current security candidate", { exact: true })).toBeVisible();
  const oldList = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/code-assessments") && new URL(response.url()).searchParams.get("kind") === "review");
  await releaseReview!(); await (await oldList).finished();
  const history = page.getByRole("listbox", { name: "Assessment history" });
  await expect(history.locator(".ling-ui-data-row")).toHaveCount(2);
  await expect(page.getByText("Current security candidate", { exact: true })).toBeVisible();
  await history.getByText("Branch Diff", { exact: true }).click();
  await expect.poll(() => Boolean(releaseOther)).toBe(true);
  await history.getByText("Working tree", { exact: true }).click();
  await expect(page.getByText("Current security candidate", { exact: true })).toBeVisible();
  const oldDetail = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/code-assessments/security_other"));
  await releaseOther!(); await (await oldDetail).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(page.getByText("Current security candidate", { exact: true })).toBeVisible();
  await expect(page.getByText("Late security candidate", { exact: true })).toHaveCount(0);
  expect(requestedDetails).toContain("security_other");
  expect(requestedDetails.at(-1)).toBe("security_current");
});

test("HTTP failures retain the setup form and allow captured-file Retry", async ({ page }) => {
  const model = await openAssessment(page, assessmentFixture(), { created: false });
  let createAttempts = 0, fileUnavailable = true;
  const requests: CreateCodeAssessmentRequest[] = [];
  await page.route("**/workspace/code-assessments**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/code-assessments") && route.request().method() === "POST") {
      requests.push(route.request().postDataJSON() as CreateCodeAssessmentRequest);
      if (++createAttempts === 1) { await route.fulfill({ status: 503, json: { error: "unavailable", message: "Temporary assessment outage." } }); return; }
    }
    if (url.pathname.endsWith("/snapshot-file") && fileUnavailable) {
      await route.fulfill({ status: 503, json: { error: "unavailable", message: "Temporary captured-file outage." } }); return;
    }
    await route.fallback();
  });
  await page.getByLabel("Target", { exact: true }).selectOption("branch");
  await page.getByLabel("Base branch", { exact: true }).fill("origin/retry");
  await page.locator(".code-assessment-start summary").filter({ hasText: "Review instructions" }).click();
  await page.getByLabel("Review instructions", { exact: true }).fill("Keep the current setup on failure.");
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(page.getByText("Temporary assessment outage.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Target", { exact: true })).toHaveValue("branch");
  await expect(page.getByLabel("Base branch", { exact: true })).toHaveValue("origin/retry");
  await expect(page.getByLabel("Review instructions", { exact: true })).toHaveValue("Keep the current setup on failure.");
  await expect(page.getByRole("button", { name: "Start review", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  const captured = page.locator(".code-assessment-snapshot");
  await expect(captured.getByText("Diff unavailable", { exact: true })).toBeVisible();
  fileUnavailable = false;
  await captured.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(captured.locator(".diff-viewer")).toContainText("export const value = 2;");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(model.creates).toEqual([requests[1]]);
});

import { expect, test } from "@playwright/test";
import type { WorkspaceChangeReview } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { attachCommittedChannelReportItem, completedTerminalReport, installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

const paths = ["src/shared.ts", "tests/shared.ts", "docs/readme.md", "src/extra.ts", "src/last.ts"];
function reviewFor(kind: WorkspaceChangeReview["scope"]["kind"], id: string): WorkspaceChangeReview {
  const files = paths.map((path, index) => {
    const additions = index + 1; const deletions = index % 2;
    return { id: `${id}:${path}`, path, kind: deletions ? "modified" as const : "added" as const, state: "exact" as const, additions, deletions,
      diff: `diff --git a/${path} b/${path}\n--- ${deletions ? `a/${path}` : "/dev/null"}\n+++ b/${path}\n@@ -${deletions ? "1,1" : "0,0"} +1,${additions} @@\n${deletions ? "-baseline\n" : ""}${Array.from({ length: additions }, (_, row) => `+${path} exact line ${row + 1}`).join("\n")}\n` };
  });
  return { scope: { kind, id }, workspaceId: "workspace_default", runIds: [], revision: `${kind}:${id}:net-v1`, state: "exact", coveredPaths: paths, files,
    additions: 15, deletions: 2 };
}

test("child file review reuses the root right dock but requests only its own Run", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("ling-stack.locale", "en-US"); localStorage.setItem("ling-stack.workCellDemo", "true"); });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", templateId: "ling_agent", kind: "system_teammate", systemRole: "ling_agent", roleKey: "custom", displayName: "Ling Agent" }),
    ...(["architect", "designer", "engineer", "qa"] as const).map((roleKey) => createMockTeammate({ id: `teammate_builtin_${roleKey}`, templateId: roleKey, roleKey, displayName: `Ling ${roleKey}` }))];
  await mockDaemon(page, state);
  const requests: string[] = [];
  await page.route(/\/(runs|turns|workflows)\/[^/]+\/workspace-changes(?:\?.*)?$/u, async (route) => {
    const url = new URL(route.request().url()); const [, collection, encodedId] = url.pathname.split("/");
    const kind = collection === "runs" ? "run" : collection === "turns" ? "turn" : "workflow";
    const id = decodeURIComponent(encodedId!); requests.push(`${kind}:${id}`);
    const ownPaths = id.endsWith("_run_engineer") ? ["apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx", "apps/web/src/styles/components.css"] : [];
    const files = ownPaths.map((path) => ({ id: `${id}:${path}`, path, kind: "modified", state: "exact", additions: 1, deletions: 1,
      diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+owned child ${path}\n` }));
    await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), state: "unavailable", canUndo: false, canReapply: false,
      files: [], summary: { fileCount: 0 }, runId: kind === "run" ? id : undefined, turnId: kind === "turn" ? id : undefined, workflowId: kind === "workflow" ? id : undefined,
      review: { scope: { kind, id }, workspaceId: "workspace_default", runIds: [id], revision: `${id}:1`, state: "exact", files, coveredPaths: ownPaths, additions: files.length, deletions: files.length } } });
  });
  await page.goto("/"); await openEngineeringChannel(page);
  const timeline = page.locator('[data-conversation-timeline-scope="channel_root"]');
  await timeline.locator('[data-conversation-timeline-kind="subAgentActivity"][data-conversation-participant-id="engineer"] .conversation-timeline-sub-agent-head').click();
  const card = timeline.locator('[data-conversation-timeline-scope="child"] [data-conversation-response-files]').first();
  await expect(card.locator("header .conversation-response-file-stats")).toHaveText("+2 −2");
  await card.getByRole("button", { name: "View changes", exact: true }).click();
  const review = page.locator(".workspace-change-review-page");
  await expect(review).toHaveAttribute("data-workspace-change-review-scope", "run");
  await expect(review).toHaveAttribute("data-workspace-change-review-id", "demo_work_cell_channel_engineering_run_engineer");
  await expect(review.locator(".workspace-change-file-section")).toHaveCount(2);
  await expect(review).not.toContainText("channel.spec.ts");
  for (const name of ["ConversationWorkCell.tsx", "components.css"]) {
    await card.getByRole("button", { name, exact: true }).click();
    await expect(review.locator(".workspace-change-file-section.selected strong")).toHaveText(name);
  }
  await expect(timeline.locator("[data-conversation-timeline]")).toHaveCount(0);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(requests.some((id) => id === "run:demo_work_cell_channel_engineering_run_engineer")).toBeTruthy();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("simulation-channel-child-run-review.png") });
});

test("a late normal review cannot overwrite a private scope after switching conversations", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state); const normalReports = state.terminalReports;
  const teammate = installTeammateWorkCellFixture(state);
  state.terminalReports = [...normalReports, ...state.terminalReports].map((value) => ({ ...(value as object), changes: paths.map((path) => ({ id: path, kind: "code", title: path, summary: "Updated", paths: [path], sourceRefs: [] })) }));
  await mockDaemon(page, state);
  let normalRequested = false; let normalReturned = false;
  let releaseNormal: (() => void) | undefined;
  const normalGate = new Promise<void>((resolve) => { releaseNormal = resolve; });
  await page.route(/\/(runs|turns)\/[^/]+\/workspace-changes(?:\?.*)?$/u, async (route) => {
    const url = new URL(route.request().url()); const [, collection, encodedId] = url.pathname.split("/");
    const kind = collection === "runs" ? "run" : "turn"; const id = decodeURIComponent(encodedId!);
    if (id.includes("normal")) { normalRequested = true; await normalGate; }
    await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), state: "unavailable", canUndo: false, canReapply: false, summary: { fileCount: 5 }, files: [],
      turnId: kind === "turn" ? id : undefined, runId: kind === "run" ? id : undefined, review: reviewFor(kind, id) } });
    if (id.includes("normal")) normalReturned = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  await expect.poll(() => normalRequested).toBe(true);
  await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
  const card = page.locator("[data-conversation-response-files]");
  await expect(card).toHaveAttribute("data-change-review-revision", "turn:turn_ui2_teammate_work_cell:net-v1");
  releaseNormal!(); await expect.poll(() => normalReturned).toBe(true);
  await expect(card).toHaveAttribute("data-change-review-revision", "turn:turn_ui2_teammate_work_cell:net-v1");
  await card.getByRole("button", { name: "View changes", exact: true }).click();
  await expect(page.locator(".workspace-change-review-page")).toHaveAttribute("data-workspace-change-review-id", "turn_ui2_teammate_work_cell");
});

for (const surface of ["normal", "private", "channel"] as const) for (const locale of ["en-US", "zh-CN"] as const) {
  test(`${surface} ${locale} net file card opens one scoped right review and locates each file`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value) => localStorage.setItem("ling-stack.locale", value), locale);
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") {
      const { threadId, runId } = installChannelWorkCellFixture(state, "net-review");
      const turnId = state.turnRunLinks.find((link) => link.runId === runId)?.turnId;
      const report = { ...completedTerminalReport({ id: "report_net_review", threadId, runId, turnId, title: "Files updated" }), channelId: "channel_engineering" };
      state.terminalReports = [report]; attachCommittedChannelReportItem(state, report);
    }
    state.terminalReports = state.terminalReports.map((report) => ({ ...(report as object), changes: paths.map((path, index) => ({ id: `change_${index}`, kind: "code", title: "Updated", summary: "Applied", paths: [path], sourceRefs: [] })) }));
    await mockDaemon(page, state);
    const reviewReads: string[] = []; const workspaceGitReads: string[] = [];
    page.on("request", (request) => { if (/\/workspace\/changes(?:\?|$)/u.test(request.url())) workspaceGitReads.push(request.url()); });
    await page.route(/\/(runs|turns|workflows)\/[^/]+\/workspace-changes(?:\?.*)?$/u, async (route) => {
      if (route.request().method() !== "GET") { await route.abort(); return; }
      const url = new URL(route.request().url()); const parts = url.pathname.split("/");
      const kind = parts[1] === "runs" ? "run" : parts[1] === "turns" ? "turn" : "workflow";
      const id = decodeURIComponent(parts[2]!); reviewReads.push(`${kind}:${id}`);
      await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), runId: kind === "run" ? id : undefined, turnId: kind === "turn" ? id : undefined,
        workflowId: kind === "workflow" ? id : undefined, state: "unavailable", canUndo: false, canReapply: false,
        summary: { fileCount: 5 }, files: [], updatedAt: "2026-10-01T00:00:00.000Z", review: reviewFor(kind, id) } });
    });
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+|打开最近对话 \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);
    const card = page.locator("[data-conversation-response-files]");
    await expect(card).toHaveCount(1);
    await expect(card.locator("header .conversation-response-file-stats")).toHaveText("+15 −2");
    await expect(card.locator(".conversation-response-file")).toHaveCount(3);
    await expect(card.locator(".conversation-response-file").nth(1).locator(".conversation-response-file-stats")).toHaveText("+2 −1");
    await expect(card.getByRole("button", { name: "shared.ts src", exact: true })).toHaveAttribute("title", "src/shared.ts");
    const gitReadCount = workspaceGitReads.length;
    await card.getByRole("button", { name: locale === "zh-CN" ? "查看变更" : "View changes", exact: true }).click();
    const review = page.locator(".workspace-change-review-page");
    await expect(review).toBeVisible(); await expect(review.locator(".workspace-change-file-section")).toHaveCount(5);
    await expect(review).toHaveAttribute("data-workspace-change-review-scope", "turn");
    await expect(review.locator(".workspace-change-review-summary")).toContainText("+15−2");
    await expect(review).not.toContainText("unrelated WIP");
    await expect(page.locator("[data-conversation-response-file-diffs]")).toHaveCount(0);
    for (const path of paths.slice(0, 2)) {
      await card.getByRole("button", { name: path.startsWith("src/") ? "shared.ts src" : "shared.ts tests", exact: true }).click();
      await expect(review.locator(`.workspace-change-file-section[data-workspace-change-path="${path}"]`)).toHaveClass(/selected/u);
      await expect(review.locator(".workspace-change-file-section.selected")).toHaveCount(1);
      await expect(review.locator(".workspace-change-file-section.selected")).toContainText(`${path} exact line 1`);
    }
    expect(workspaceGitReads.length).toBe(gitReadCount);
    expect(reviewReads.length).toBeGreaterThan(0); expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`simulation-${surface}-${locale}-scoped-net-review.png`) });
    await page.reload();
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+|打开最近对话 \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);
    await expect(card.locator("header .conversation-response-file-stats")).toHaveText("+15 −2");
    if (surface === "normal" && locale === "zh-CN") {
      await page.setViewportSize({ width: 980, height: 760 });
      await card.getByRole("button", { name: "查看变更", exact: true }).click();
      await expect(review).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("simulation-normal-zh-narrow-net-review.png") });
    }
  });
}

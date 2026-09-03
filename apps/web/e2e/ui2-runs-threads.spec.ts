import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  buildTurnContextByRunId,
  buildWorkHistoryGroupTree,
  buildWorkHistoryTurnGroups,
  buildWorkHistoryTurnLoadRequests,
  deriveThreadsFromRuns,
  normalizeWorkHistorySearchQuery,
  reconcileSelectedId,
  turnStateKey,
} from "../src/features/runs/runs-thread-view-models.js";
import type { LingThread, LingTurn, LingTurnRun, RunSession } from "../src/types.js";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
  openThreadsPage,
} from "./support/runs-threads-fixture";
import { triggerFocusRevalidation } from "./support/focus-revalidation";

const cwd = "/tmp/ling-stack-runs-characterization";
const evidenceDirectory = fileURLToPath(new URL("../../../docs/design/ui2.0升级/evidence/features/runs-threads/", import.meta.url));
const expectedInjected503 = "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

function run(id: string, threadId: string | undefined, status: RunSession["status"], updatedAt: string): RunSession {
  return {
    id,
    status,
    cwd,
    taskId: `task_${id}`,
    providerName: "Local",
    providerModel: "fixture-model",
    taskSnapshot: { title: `Task ${id}`, prompt: `Prompt ${id}` },
    providerSnapshot: {},
    requestSnapshot: { workspaceCwd: cwd },
    eventLogPath: `${cwd}/${id}.jsonl`,
    ...(threadId ? { threadId } : {}),
    createdAt: updatedAt,
    updatedAt,
  };
}

function thread(id: string, updatedAt: string, parentThreadId?: string): LingThread {
  return {
    id,
    workspaceId: "workspace_default",
    kind: "task",
    title: `Thread ${id}`,
    objective: `Objective ${id}`,
    status: "succeeded",
    conversationMode: { mode: "default" },
    ...(parentThreadId ? { parentThreadId } : {}),
    createdAt: updatedAt,
    updatedAt,
  };
}

test("P11.2 characterization: durable attempts, legacy fallback, lineage and selection stay stable", () => {
  const parent = { ...thread("parent", "2026-07-23T01:00:00.000Z"), pinnedAt: "2026-07-23T01:01:00.000Z" };
  const child = thread("child", "2026-07-23T02:00:00.000Z", parent.id);
  const runs = [
    run("run_parent_1", parent.id, "failed", "2026-07-23T01:00:00.000Z"),
    run("run_parent_2", parent.id, "succeeded", "2026-07-23T01:02:00.000Z"),
    run("run_child_legacy", child.id, "succeeded", "2026-07-23T02:00:00.000Z"),
  ];
  const turn: LingTurn = {
    id: "turn_parent",
    workspaceId: "workspace_default",
    threadId: parent.id,
    kind: "initial_request",
    status: "succeeded",
    title: "Durable parent turn",
    userInstruction: "Characterize grouping",
    activeRunId: undefined,
    lastRunId: "run_parent_2",
    createdByActor: "local-user",
    createdAt: "2026-07-23T01:00:00.000Z",
    updatedAt: "2026-07-23T01:02:00.000Z",
  };
  const links: LingTurnRun[] = [
    { turnId: turn.id, runId: "run_parent_1", attemptNumber: 1, role: "primary", createdAt: runs[0].createdAt },
    { turnId: turn.id, runId: "run_parent_2", attemptNumber: 2, role: "retry", createdAt: runs[1].createdAt },
  ];
  const groups = buildWorkHistoryTurnGroups({
    cwd,
    runs,
    visibleThreads: [parent, child],
    turnStateByThreadKey: {
      [turnStateKey(cwd, parent.id)]: { status: "loaded", turns: [turn], runLinks: links, signature: "parent-v1" },
      [turnStateKey(cwd, child.id)]: { status: "failed", error: "legacy only", signature: "child-v1" },
    },
  });

  expect(groups.map((group) => [group.id, group.latestRunId, group.attemptCount])).toEqual([
    ["thread:child", "run_child_legacy", 1],
    ["turn:turn_parent", "run_parent_2", 2],
  ]);
  expect(groups.find((group) => group.id === "turn:turn_parent")?.attempts.map((attempt) => [attempt.run.id, attempt.attemptNumber, attempt.role])).toEqual([
    ["run_parent_1", 1, "primary"],
    ["run_parent_2", 2, "retry"],
  ]);
  expect(buildWorkHistoryGroupTree(groups).map((row) => [row.group.threadId, row.depth, row.parentHidden])).toEqual([
    ["parent", 0, false],
    ["child", 1, false],
  ]);
  expect(buildTurnContextByRunId("run_parent_1", groups, {
    [turnStateKey(cwd, parent.id)]: { status: "loaded", turns: [turn], runLinks: links, signature: "parent-v1" },
  }, cwd)?.turn.id).toBe(turn.id);
  expect(reconcileSelectedId("run_parent_2", ["run_parent_1", "run_child_legacy"], ["run_parent_1", "run_parent_2", "run_child_legacy"]))
    .toBe("run_child_legacy");
});

test("P11.2 characterization: fallback projection, request cap and search normalization stay bounded", () => {
  const runs = Array.from({ length: 105 }, (_, index) => run(`run_${index}`, `thread_${index}`, index === 0 ? "queued" : "succeeded", `2026-07-23T03:${String(index % 60).padStart(2, "0")}:00.000Z`));
  const fallback = deriveThreadsFromRuns(runs);
  expect(fallback).toHaveLength(105);
  expect(fallback.find((item) => item.id === "thread_0")?.activeRunId).toBe("run_0");
  expect(buildWorkHistoryTurnLoadRequests(cwd, fallback, runs, runs[104])).toHaveLength(100);
  expect(normalizeWorkHistorySearchQuery("  durable   retry ")).toBe("durable retry");
  expect(normalizeWorkHistorySearchQuery(" x ")).toBeUndefined();
});

test("RUN-INSPECTOR-001: persisted run lookup is reachable, loads evidence, and reports failures", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  const state = createRunsThreadsFixture();
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  await openMainRunHistory(page);

  const inspector = page.getByLabel("Run inspector");
  await expect(inspector).toBeVisible();
  const runId = inspector.getByLabel("Run ID");
  await runId.fill("");
  await inspector.getByRole("button", { name: "Load persisted run" }).click();
  await expect(inspector.getByRole("alert")).toHaveText("Enter a Run ID");

  await runId.fill("run_ui2_failed");
  await runId.press("Enter");
  await expect(inspector.getByText("failed", { exact: true })).toBeVisible();
  await expect(inspector.getByText("local-relay/gpt-5.5", { exact: true })).toBeVisible();

  await runId.fill("missing_run");
  await inspector.getByRole("button", { name: "Load persisted run" }).click();
  await expect(inspector.getByRole("alert")).toBeVisible();
});

test("RUN-HISTORY-001: 100 groups, keyboard, no-result, retained stale and dual-theme ledger", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  const state = createRunsThreadsFixture(100);
  let failThreadList = false;
  await installRunsThreadsFixture(page, state);
  await page.route(/\/threads\?/u, async (route) => {
    const url = new URL(route.request().url());
    if (failThreadList && route.request().method() === "GET" && url.searchParams.get("limit") === "100" && url.searchParams.has("archived")) {
      await route.fulfill({ status: 503, json: { error: "focused_list_failure", message: "Focused list refresh failed" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openMainRunHistory(page);
  const shell = page.locator(".runs-page-shell");
  const rows = shell.locator(".work-history-branch-row");
  await expect(rows).toHaveCount(100);
  await rows.nth(1).focus();
  await rows.nth(1).press("Enter");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => shell.locator(".runs-list-scroll").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await assertNoOverflow(page);
  await captureLedger(page, "1440x960-ling-light-history-thread-groups.png", "history_100_groups", "RUN-HISTORY-001", errors);

  const search = shell.getByRole("searchbox", { name: "Search thread bindings" });
  await search.fill("no matching durable thread");
  await expect(shell.getByText("No active branches match")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  failThreadList = true;
  await expect(shell.locator(".runs-page-header").getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  await expect(shell.getByText("Some information may be out of date. Reconnect to continue.")).toBeVisible();
  await applyThemeWithoutReload(page, "ling-dark");
  await page.setViewportSize({ width: 1280, height: 800 });
  await assertNoOverflow(page);
  await captureLedger(page, "1280x800-ling-dark-history-stale.png", "history_retained_stale", "RUN-HISTORY-001", errors, [expectedInjected503]);
});

test("RUN-DETAIL-001: running approval, failed repair and long technical evidence", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await initPage(page, "zh-CN", "ling-light", { width: 1440, height: 960 });
  const state = createRunsThreadsFixture();
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel(/运行详情|Run detail/);
  await expect(detail.getByRole("button", { name: /停止|Stop/, exact: true })).toBeVisible();
  await expect(detail).toContainText(/等待.*审批|Waiting for/);
  await assertNoOverflow(page);
  await captureLedger(page, "1440x960-ling-light-run-running-approval.png", "run_running_pending_approval", "RUN-DETAIL-001", errors);

  await page.evaluate(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.reload();
  await openMainRunHistory(page, "Failed provider repair run");
  const englishDetail = page.getByLabel("Run detail");
  const providerRepair = englishDetail.getByText("Provider repair needed");
  await expect(providerRepair).toBeVisible();
  await expect(englishDetail.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(englishDetail.getByRole("button", { name: "Rerun snapshot" })).toBeDisabled();
  await applyThemeWithoutReload(page, "ling-dark");
  await page.setViewportSize({ width: 1280, height: 800 });
  await providerRepair.scrollIntoViewIfNeeded();
  await captureLedger(page, "1280x800-ling-dark-run-failure-repair.png", "run_failed_provider_repair", "RUN-DETAIL-001", errors);
  await englishDetail.getByText("Debug details").click();
  const longTechnicalEvidence = englishDetail.getByText("x".repeat(100)).first();
  await longTechnicalEvidence.scrollIntoViewIfNeeded();
  await expect(longTechnicalEvidence).toBeVisible();
  await assertNoOverflow(page);
  await captureLedger(page, "1280x800-ling-dark-technical-details-long.png", "run_long_raw_technical", "RUN-DETAIL-001", errors);
});

test("THREAD-LIST-001: lineage, preview, pin/archive payload and active-run guards", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  const state = createRunsThreadsFixture();
  const requests: Array<{ path: string; body: string | null }> = [];
  await installRunsThreadsFixture(page, state);
  page.on("request", (request) => {
    if (/\/threads\/thread_ui2_main\/(resume-preview|pin|archive)/u.test(new URL(request.url()).pathname)) requests.push({ path: new URL(request.url()).pathname, body: request.postData() });
  });
  await page.goto("/");
  await openThreadsPage(page);
  const list = page.locator(".runs-thread-list");
  await list.getByRole("button", { name: /Main evidence lineage/ }).click();
  const detail = page.getByLabel("Thread detail");
  await detail.getByRole("button", { name: "Preview resume" }).click();
  await expect(detail.locator(".compact-json")).toContainText("Source run");
  await detail.getByRole("button", { name: "Pin" }).click();
  await expect(detail.getByRole("button", { name: "Unpin" })).toBeVisible();
  await expect.poll(() => requests.some((request) => request.path.endsWith("/resume-preview"))).toBe(true);
  await captureLedger(page, "1440x960-ling-light-thread-lineage-resume.png", "thread_lineage_resume_preview", "THREAD-LIST-001", errors);
  await detail.getByRole("button", { name: "Archive" }).click();
  await expect.poll(() => state.threads.find((thread) => thread.id === "thread_ui2_main")?.archivedAt).toBeTruthy();

  await list.getByRole("button", { name: /Active thread audit/ }).click();
  await expect(detail.getByRole("button", { name: "Resume thread" })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Fork" })).toBeDisabled();
  await applyThemeWithoutReload(page, "ling-dark");
  await page.setViewportSize({ width: 1280, height: 800 });
  await assertNoOverflow(page);
  await captureLedger(page, "1280x800-ling-dark-thread-active-run-disabled.png", "thread_active_run_guard", "THREAD-LIST-001", errors);
});

test("RUN-INTERVENTION-001 and recording: scoped failure, promote, focus, validation and reduced motion", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 }, true);
  const state = createRunsThreadsFixture();
  let failNextGuidance = true;
  await installRunsThreadsFixture(page, state);
  await page.route(/\/runs\/run_ui2_failed\/interventions(?:\?|$)/u, async (route) => {
    if (route.request().method() === "POST" && failNextGuidance) {
      failNextGuidance = false;
      await route.fulfill({ status: 503, json: { message: "Injected focused guidance failure" } });
      return;
    }
    await route.fallback();
  });
  await page.route(/\/run-interventions\/([^/]+)\/promote(?:\?|$)/u, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    const intervention = state.runInterventions.find((item) => item.id === id);
    if (intervention) intervention.status = "started";
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", intervention } });
  });
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");
  const detail = page.getByLabel("Run detail");
  const guidance = detail.locator(".run-guidance-panel");
  const draft = guidance.getByPlaceholder("Tell this run what to do next...");
  await draft.fill("Retain this draft across a scoped failure.");
  await guidance.getByRole("button", { name: "Queue guidance" }).click();
  await expect(guidance).toContainText("Injected focused guidance failure");
  await expect(draft).toHaveValue("Retain this draft across a scoped failure.");
  await guidance.getByRole("button", { name: "Queue guidance" }).click();
  await guidance.getByRole("button", { name: "Start handling" }).click();
  await expect(guidance).toContainText("Started");

  const trigger = detail.getByRole("button", { name: /^Use as skill evidence/ });
  await trigger.click();
  let dialog = detail.getByRole("dialog", { name: "Review recording" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  dialog = detail.getByRole("dialog", { name: "Review recording" });
  await dialog.getByLabel("Validation steps").fill("");
  const validationError = dialog.getByText("Add at least one validation step before submitting.");
  await dialog.locator(".runs-recording-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await validationError.scrollIntoViewIfNeeded();
  await expect(validationError).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Create candidate|Append evidence/ })).toBeDisabled();
  await assertNoOverflow(page);
  await captureLedger(page, "1440x960-ling-light-recording-validation.png", "recording_validation_reduced_motion", "RUN-DETAIL-001", errors, [expectedInjected503]);
});

test("request identity: a late thread response cannot overwrite the latest search", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  const state = createRunsThreadsFixture();
  let targetedCalls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await installRunsThreadsFixture(page, state);
  await page.route(/\/threads\?/u, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("limit") !== "100" || !url.searchParams.has("archived")) { await route.fallback(); return; }
    targetedCalls += 1;
    if (targetedCalls === 1) {
      await firstGate;
      await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", threads: [state.threads[0]] } });
      return;
    }
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", threads: [state.threads[2]], matches: [{ threadId: state.threads[2].id, field: "thread_title", snippet: state.threads[2].title }] } });
  });
  await page.goto("/");
  await openMainRunHistory(page);
  const search = page.getByRole("searchbox", { name: "Search thread bindings" });
  await search.fill("Active thread audit");
  await expect(page.locator(".thread-list")).toContainText("Active thread audit");
  releaseFirst();
  await expect.poll(() => targetedCalls).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".thread-list")).not.toContainText("Main evidence lineage");
});

async function initPage(page: Page, locale: "en-US" | "zh-CN", themeId: "ling-light" | "ling-dark", viewport: { readonly width: number; readonly height: number }, reducedMotion = false): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript(({ savedLocale, savedTheme }) => {
    const selection = { mode: "fixed", themeId: savedTheme };
    if (!localStorage.getItem("ling-stack.locale")) localStorage.setItem("ling-stack.locale", savedLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    sessionStorage.setItem("ling-stack.e2eThemeSelection", JSON.stringify(selection));
  }, { savedLocale: locale, savedTheme: themeId });
}

async function applyThemeWithoutReload(page: Page, themeId: "ling-light" | "ling-dark"): Promise<void> {
  await page.evaluate((savedTheme) => {
    const selection = { mode: "fixed", themeId: savedTheme };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    document.documentElement.dataset.uiTheme = savedTheme;
    document.documentElement.dataset.theme = savedTheme === "ling-dark" ? "dark" : "light";
  }, themeId);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

async function assertNoOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    shell: (() => { const element = document.querySelector<HTMLElement>(".runs-page-shell"); return element ? element.scrollWidth - element.clientWidth : 0; })(),
    detail: (() => { const element = document.querySelector<HTMLElement>(".runs-detail-workspace"); return element ? element.scrollWidth - element.clientWidth : 0; })(),
  }));
  expect(metrics).toEqual({ document: 0, shell: 0, detail: 0 });
}

async function captureLedger(
  page: Page,
  fileName: string,
  fixtureId: string,
  functionIds: string,
  consoleErrors: readonly string[],
  expectedConsoleErrors: readonly string[] = [],
): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  expect(consoleErrors).toEqual(expectedConsoleErrors);
  await mkdir(evidenceDirectory, { recursive: true });
  const path = `${evidenceDirectory}${fileName}`;
  const buffer = await page.screenshot({ animations: "disabled", path });
  const metrics = await page.evaluate(() => {
    const read = (selector: string) => { const element = document.querySelector<HTMLElement>(selector); return element ? { clientHeight: element.clientHeight, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth } : null; };
    return { document: read("html"), list: read(".runs-list-scroll"), detail: read(".runs-detail-workspace"), locale: document.documentElement.lang || null, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, theme: document.documentElement.dataset.uiTheme ?? document.documentElement.dataset.theme };
  });
  await writeFile(path.replace(/\.png$/u, ".metadata.json"), `${JSON.stringify({ file: fileName, fixtureId, functionIds, url: page.url(), servedArtifact: "Vite source via Playwright webServer", viewport: page.viewportSize(), verification: "focused scenario passed; suite and artifact audit pending", partialReason: "Global legacy CSS deletion and packaged macOS/Windows acceptance remain outside this slice.", consoleErrors: [], expectedConsoleErrors, sha256: createHash("sha256").update(buffer).digest("hex"), ...metrics }, null, 2)}\n`, "utf8");
}

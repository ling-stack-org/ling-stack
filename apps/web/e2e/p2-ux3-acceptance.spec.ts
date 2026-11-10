import { expect, test } from "@playwright/test";
import type { TurnWorkspaceChangesResponse } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { attachCommittedChannelReportItem, completedTerminalReport, installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

for (const theme of ["light", "dark"] as const) {
  for (const size of [{ width: 1280, height: 800 }, { width: 1440, height: 960 }]) {
    for (const surface of ["normal", "private", "channel"] as const) {
      test(`${surface} ${theme} ${size.width}x${size.height} preserves process, result, files and keyboard actions`, async ({ page }, info) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        page.on("response", response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript(theme => {
          localStorage.setItem("ling-stack.locale", "en-US");
          const selection = JSON.stringify({ mode: "fixed", themeId: `ling-${theme}` });
          localStorage.setItem("ling-stack.themeSelection", selection);
          localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
          localStorage.setItem("ling-stack.themePreference", theme);
          localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
        }, theme);
        const state = createBaseState({ approvalStatus: "expired" });
        const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
        if (title) {
          // The mock derives the reply timestamp from Run creation. Keep its
          // causal order explicit instead of letting equal-time ids sort it first.
          state.runs = state.runs.map(run => run.id === "run_ui2_normal_work_cell"
            ? { ...run, createdAt: "2026-07-24T02:00:00.001Z" } : run);
        }
        const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
        if (surface === "channel") {
          const { runId, threadId } = installChannelWorkCellFixture(state, "p2-ux3-matrix");
          const turnId = state.turnRunLinks.find(link => link.runId === runId)!.turnId;
          state.terminalReports = [{ ...completedTerminalReport({ id: "report-p2-ux3", runId, threadId, turnId, title: "Completed" }), channelId: "channel_engineering" }];
          attachCommittedChannelReportItem(state, state.terminalReports[0]!);
        }
        state.terminalReports = state.terminalReports.map(report => ({ ...report,
          verification: [{ id: "not-requested", title: "Tests not requested", status: "not_run", expectation: "informational", sourceRefs: [] }],
          changes: [{ id: "file", kind: "code", title: "Edited file", summary: "Updated", paths: ["src/example.ts"], sourceRefs: [] }],
        }));
        await mockDaemon(page, state);
        await page.route(/\/turns\/[^/]+\/workspace-changes(?:\?.*)?$/u, async route => {
          const url = new URL(route.request().url());
          const turnId = decodeURIComponent(url.pathname.split("/")[2]!);
          const response: TurnWorkspaceChangesResponse = {
            cwd: url.searchParams.get("cwd")!, turnId, threadId: state.turns.find(turn => turn.id === turnId)!.threadId,
            runIds: [], provenanceComplete: false, state: "unavailable", canUndo: false, canReapply: false,
            files: [], summary: { fileCount: 0, addCount: 0, updateCount: 0, deleteCount: 0, moveCount: 0, addedLines: 0, removedLines: 0 },
            updatedAt: "2026-10-16T00:00:00.000Z",
            review: { scope: { kind: "turn", id: turnId }, workspaceId: "workspace_default", runIds: [],
              revision: `${turnId}:1`, state: "exact", coveredPaths: ["src/example.ts"], additions: 1, deletions: 0,
              files: [{ id: "example", path: "src/example.ts", kind: "added", state: "exact", additions: 1, deletions: 0,
                diff: "diff --git a/src/example.ts b/src/example.ts\n--- /dev/null\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+export const example = true;\n" }] },
          };
          await route.fulfill({ json: response });
        });
        await page.goto("/");
        if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
        if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
        if (surface === "channel") await openEngineeringChannel(page);
        await expect(page.locator("html")).toHaveAttribute("data-ui-theme", `ling-${theme}`);
        const timeline = page.locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]');
        await expect(timeline).toHaveCount(1);
        await expect(timeline.locator("[data-feed-item-kind]").first()).toHaveAttribute("data-feed-item-kind", "userMessage");
        const process = timeline.locator('[data-conversation-process-header]').first();
        await expect(process).toHaveAttribute("aria-expanded", "false");
        await expect(timeline.locator('[data-conversation-response-files]')).toHaveCount(1);
        await expect(timeline.locator('[data-conversation-response-footer]')).toHaveCount(1);
        await page.screenshot({ path: info.outputPath("process-collapsed.png") });
        await process.focus();
        await process.press("Enter");
        await expect(process).toBeFocused();
        await expect(process).toHaveAttribute("aria-expanded", "true");
        const batch = timeline.locator(".conversation-command-batch-header").first();
        await batch.focus();
        await batch.press("Space");
        await expect(batch).toHaveAttribute("aria-expanded", "true");
        const command = timeline.locator('[data-conversation-timeline-kind="commandExecution"] .conversation-timeline-activity-main').first();
        await command.focus();
        await command.press("Enter");
        await expect(command).toBeFocused();
        await expect(command).toHaveAttribute("aria-expanded", "true");
        await expect(timeline.locator('[data-conversation-process-group] [data-conversation-response-footer]')).toHaveCount(0);
        await expect(timeline.locator('[data-conversation-timeline="true"], .conversation-timeline-virtualizer .conversation-timeline-virtualizer')).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath("process-expanded-command.png") });
        await process.focus();
        await process.press("Space");
        await expect(process).toHaveAttribute("aria-expanded", "false");
        await expect(process).toBeFocused();
        await expect(timeline.locator('[data-conversation-response-files]')).toHaveCount(1);
        expect(errors).toEqual([]);
      });
    }
  }
}

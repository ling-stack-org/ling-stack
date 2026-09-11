import { expect, test } from "@playwright/test";
import type { ConversationTerminalReportProjectionDto } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";

// Simulation: API fixtures exercise AppShell adapters and the real shared renderer.
// No model requests, real secrets, persisted history, or packaged acceptance claims.
for (const surface of ["normal", "private", "channel"] as const) {
  for (const restrictedOutcome of [false, true]) {
    test(`${surface} report privacy: ${restrictedOutcome ? "restricted" : "public"} outcome`, async ({ page }, testInfo) => {
      await page.addInitScript(() => {
        localStorage.setItem("ling-stack.locale", "en-US");
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
          writeText: async (text: string) => { Object.assign(globalThis, { __privacyCopy: text }); },
        } });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const state = createBaseState({ approvalStatus: "expired" });
      const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
      const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
      if (surface === "channel") {
        const { threadId, runId } = installChannelWorkCellFixture(state, "privacy");
        const turnId = state.turnRunLinks.find((link) => link.runId === runId)!.turnId;
        state.terminalReports = [baseReport(threadId, turnId)];
      }
      const original = state.terminalReports[0] as ConversationTerminalReportProjectionDto;
      const report = withPrivacySections(original, restrictedOutcome);
      state.terminalReports = [report];
      const untouched = JSON.stringify(report);
      await mockDaemon(page, state);
      await page.goto("/");
      if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
      if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
      if (surface === "channel") await openEngineeringChannel(page);

      const result = page.locator(`[data-conversation-terminal-response="${report.id}"]`);
      await expect(result).toHaveCount(1);
      await expect(result).toBeVisible();
      await expect(result).not.toContainText("PRIVACY_SENTINEL");
      if (!restrictedOutcome) await expect(result).toContainText("Public report summary");
      const toggle = result.locator(".conversation-timeline-activity-main");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      const actions = result.locator(".message-action-bar");
      await page.mouse.move(0, 0);
      await expect(actions).toHaveCSS("opacity", "0");
      await result.hover();
      await expect(actions).toHaveCSS("opacity", "1");
      await actions.getByRole("button", { name: "Copy message", exact: true }).click();
      const copied = await page.evaluate(() => Reflect.get(globalThis, "__privacyCopy") as string);
      expect(copied).toContain("Public check");
      expect(copied).not.toMatch(/PRIVACY_SENTINEL|hidden-private|private-proof/u);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(result).toContainText("Public check");
      await expect(result).toContainText("Public change");
      await expect(result.locator('[data-terminal-report-section="changes"] .conversation-timeline-terminal-entry')).toHaveCount(1);
      const publicFile = result.locator('[data-terminal-report-section="changes"] .conversation-timeline-file-ref');
      await expect(publicFile).toHaveCount(1);
      await expect(publicFile).toHaveAttribute("title", "docs/public.txt");
      const artifactFile = result.locator('[data-terminal-report-section="artifacts"] .conversation-timeline-file-ref');
      await expect(artifactFile).toHaveCount(1);
      await expect(artifactFile).toHaveAttribute("title", "docs/public.txt");
      expect(await page.locator("body").innerHTML()).not.toMatch(/PRIVACY_SENTINEL|hidden-private|private-proof/u);
      await actions.getByRole("button", { name: "Copy message", exact: true }).click();
      expect(await page.evaluate(() => Reflect.get(globalThis, "__privacyCopy"))).toBe(copied);
      expect(JSON.stringify(report)).toBe(untouched);
      expect(errors).toEqual([]);
      await result.screenshot({ path: testInfo.outputPath(`simulation-${surface}-${restrictedOutcome ? "restricted" : "public"}-privacy.png`) });
    });
  }
}

function baseReport(threadId: string, turnId: string): ConversationTerminalReportProjectionDto {
  return {
    schemaVersion: 1, id: "report-channel-privacy", workspaceId: "workspace_default",
    channelId: "channel_engineering", threadId, turnId, source: { kind: "turn", id: turnId },
    generation: 1, resultItemId: "result-channel-privacy", status: "committed", language: "en-US",
    outcome: { status: "succeeded", title: "Completed", summary: "Public report summary", corrections: [], sourceRefs: [] },
    changes: [], verification: [], participants: [], artifacts: [], risks: [], references: [],
    evidenceSnapshotId: "snapshot-channel-privacy", evidenceFingerprint: "fingerprint-channel-privacy",
    synthesis: { mode: "deterministic_fallback", promptVersion: "terminal-report-v1", attemptCount: 0, validationCodes: [] },
    createdAt: "2026-07-24T02:01:00.000Z", committedAt: "2026-07-24T02:01:00.000Z",
  };
}

function withPrivacySections(report: ConversationTerminalReportProjectionDto, restrictedOutcome: boolean): ConversationTerminalReportProjectionDto {
  const privateRef = { kind: "file", id: "hidden-private.txt", label: "PRIVACY_SENTINEL label", visibility: "developer_only", sensitivity: "secret_adjacent" } as const;
  const publicAlias = { ...privateRef, visibility: "conversation", sensitivity: "normal" } as const;
  const publicRef = { kind: "file", id: "docs/public.txt", label: "public.txt", visibility: "conversation" } as const;
  const mixed = [publicRef, publicAlias];
  return {
    ...report,
    outcome: { ...report.outcome,
      title: restrictedOutcome ? "PRIVACY_SENTINEL outcome" : "Public result completed",
      summary: restrictedOutcome ? "PRIVACY_SENTINEL summary" : "Public report summary",
      sourceRefs: restrictedOutcome ? mixed : report.outcome.sourceRefs,
      corrections: [{ id: "private-correction", originalAssumption: "PRIVACY_SENTINEL assumption", correctedFact: "PRIVACY_SENTINEL correction", confidence: "high", sourceRefs: mixed }],
    },
    changes: [
      { id: "public-change", kind: "documentation", title: "Public change", summary: "Public details", paths: ["docs/public.txt"], sourceRefs: [publicRef] },
      { id: "private-change", kind: "code", title: "PRIVACY_SENTINEL change", summary: "PRIVACY_SENTINEL details", paths: ["hidden-private.txt"], sourceRefs: mixed },
    ],
    verification: [
      { id: "public-check", title: "Public check", status: "passed", command: "node --test public.test.mjs", sourceRefs: [publicRef] },
      { id: "private-check", title: "PRIVACY_SENTINEL check", status: "passed", command: "PRIVACY_SENTINEL command", sourceRefs: mixed },
    ],
    participants: [{ agentId: "private-agent", displayName: "PRIVACY_SENTINEL agent", status: "failed", contribution: "PRIVACY_SENTINEL contribution", sourceRefs: mixed }],
    artifacts: [
      { id: "public-proof", kind: "file", title: "Public file", path: "docs/public.txt", sourceRefs: [publicRef] },
      { id: "private-proof", kind: "file", title: "PRIVACY_SENTINEL artifact", path: "hidden-private.txt", summary: "PRIVACY_SENTINEL artifact body", sourceRefs: mixed },
    ],
    risks: [{ id: "private-risk", severity: "warning", status: "unresolved", summary: "PRIVACY_SENTINEL risk", nextAction: "PRIVACY_SENTINEL next", sourceRefs: mixed }],
    references: [privateRef, publicAlias, publicRef],
  };
}

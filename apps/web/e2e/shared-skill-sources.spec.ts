import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const roots = [{ id: "shared-agents-workspace", rootPath: "/private/workspace/.agents/skills", sourceKind: "workspace-skill-directory", label: "/private/workspace" }];
const record = (state: "new" | "unchanged" | "blocked" | "orphaned", skillId: string) => ({
  state, skillId, sourceRootId: roots[0].id, sourcePath: `${roots[0].rootPath}/${skillId}/SKILL.md`,
  upstreamSkillPath: `${skillId}/SKILL.md`, frontMatter: { name: skillId, description: `A ${skillId} skill` },
  referencedFiles: state === "new" ? [{ path: "references/guide.md", kind: "reference", checksum: "sha256:guide", sizeBytes: 42, includedInSnapshot: false }] : [], warnings: state === "blocked" ? [{ severity: "error", code: "skill_id_conflict", message: "This name belongs to another owner." }] : state === "orphaned" ? [{ severity: "warning", code: "orphaned_snapshot", message: "This snapshot has no active skill." }] : [],
  semanticDiff: [], contextFindings: [], diff: [], snapshotPreview: { rawSkillMarkdown: `# ${skillId}\n\nReview this source.` },
});

test("shared skill folders scan on demand, confirm publish, and restore ignored candidates", async ({ page }, testInfo) => {
  let scans = 0;
  let published = false;
  let publishAttempts = 0;
  let publishedRequest: Record<string, unknown> | undefined;
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.route(/127\.0\.0\.1:17891\/skills\/sync\/shared\/(preview|publish)/, async (route) => {
    if (route.request().url().includes("/preview")) {
      scans += 1;
      await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", scannedAt: "2026-10-27T00:00:00Z", preview: {
        generatedAt: "2026-10-27T00:00:00Z", roots, upstreamVersions: [],
        summary: { totalRecords: 3, new: Number(!published), unchanged: Number(published), blocked: 1, drifted: 0, attachable: 0, missing: 0, orphaned: 1 },
        records: [record(published ? "unchanged" : "new", "sample-skill"), record("blocked", "built-in-id"), record("orphaned", "old-skill")],
      } } });
      return;
    }
    publishAttempts += 1;
    publishedRequest = route.request().postDataJSON() as Record<string, unknown>;
    if (publishAttempts === 1) {
      await route.fulfill({ status: 500, json: { error: "publish failed" } });
      return;
    }
    published = true;
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", publishedAt: "2026-10-27T00:00:01Z", preview: {}, skills: [], snapshots: [], artifacts: [] } });
  });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Skill library/ }).click();
  await expect(page.getByRole("tab", { name: /My skills/ })).toHaveAttribute("aria-selected", "true");
  expect(scans).toBe(0);
  await page.getByRole("tab", { name: /Local skill folders/ }).click();
  await expect(page.getByText("sample-skill", { exact: true }).first()).toBeVisible();
  expect(scans).toBe(1);
  const panel = page.locator("[data-ui2-shared-skills]");
  await expect(panel).not.toContainText("/private/workspace");
  await expect(panel).toContainText("Workspace · .agents/skills");
   await expect(panel.getByText("old-skill", { exact: true })).toHaveCount(0);
  await expect(panel.locator("[data-state=\"blocked\"]").getByRole("button", { name: "Add skill" })).toHaveCount(0);
   await expect(panel.locator("[data-state=\"blocked\"]").getByRole("button", { name: "Ignore" })).toHaveCount(0);
  await panel.getByText("View source and changes").first().click();
  await expect(panel.locator('[data-state="new"] pre')).toContainText("Review this source.");
   await expect(panel.locator('[data-state="new"]')).toContainText("references/guide.md");
   await expect(panel.locator('[data-state="new"]')).toContainText("42 bytes");
   await panel.getByRole("button", { name: /Show orphaned/ }).click();
   await expect(panel.getByText("old-skill", { exact: true })).toBeVisible();
   await expect(panel.locator('[data-state="orphaned"]').getByRole("button", { name: "Ignore" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Ignore" }).first().click();
  await expect(panel.getByText("sample-skill", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: /Show ignored/ }).click();
  await panel.locator('[data-state="ignored"]').getByRole("button", { name: "Restore" }).click();
  await panel.locator('[data-state="new"]').getByRole("button", { name: "Add skill" }).click();
  const confirmation = page.locator("[data-ui2-shared-skill-confirm]");
  await expect(confirmation.getByRole("button", { name: "Publish selected" })).toBeDisabled();
  await confirmation.getByRole("checkbox", { name: /I confirm adding new skills/ }).check();
  await page.screenshot({ path: testInfo.outputPath("shared-skill-sources.png"), fullPage: true });
  await confirmation.getByRole("button", { name: "Publish selected" }).click();
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("checkbox", { name: /I confirm adding new skills/ })).toBeChecked();
  await confirmation.getByRole("button", { name: "Publish selected" }).click();
  await expect(panel.locator('[data-state="unchanged"]')).toBeVisible();
  expect(publishedRequest).toMatchObject({ selectedSkillIds: ["sample-skill"], allowNewSkills: true, publishArtifacts: true });
});

import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";

test("Automations displays the registered GitHub intake policy and reads its admission receipts", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route("**/workspace/github-intake?*", async route => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { cwd, sources: [{
        repository: "example/ling", revision: "fixture-policy", providerAvailable: true,
        policy: { mode: "auto_start", enabled: true, requiredLabel: "agent-ready",
          quietHours: { start: "22:00", end: "08:00", timeZone: "Asia/Shanghai" },
          budget: { maxConcurrent: 1, maxStartsPerWindow: 3, windowMs: 3_600_000 } },
      }] } });
    } else {
      expect(request.postDataJSON()).toMatchObject({ repository: "example/ling", retryKey: expect.any(String) });
      await route.fulfill({ json: { cwd, receipts: [{
        receiptId: "quiet-receipt", subject: { number: 21, kind: "issue" }, outcome: "suppressed", reasonCode: "quiet_hours",
      }] } });
    }
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: "Sidebar display" }).getByRole("button", { name: "Automation", exact: true }).click();
  await page.getByText("GitHub intake", { exact: true }).click();
  const source = page.getByRole("region", { name: "example/ling" });
  await expect(source).toContainText("agent-ready");
  await expect(source).toContainText("22:00–08:00 Asia/Shanghai");
  await expect(source).toContainText("Up to 1 active and 3 starts per 60 min");
  await source.getByRole("button", { name: "Check GitHub inbox" }).click();
  await expect(source.getByRole("listitem")).toContainText("#21");
  await expect(source.getByRole("listitem")).toContainText("Skipped");
});

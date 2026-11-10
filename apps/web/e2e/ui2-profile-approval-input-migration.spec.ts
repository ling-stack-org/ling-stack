import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openChannelChatTools } from "./support/test-helpers";
import { isViteClientTransportError } from "./support/vite-client-console-error";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const screenshotDirectory = `${repositoryDirectory}docs/design/ui2.0升级/evidence/features/raw-text-controls/second-wave`;
const profileSourceUrl = new URL("../src/features/profile/ProfilePage.tsx", import.meta.url);
const profileCssUrl = new URL("../src/styles/profile.css", import.meta.url);
const appShellSourceUrl = new URL("../src/app/AppShell.tsx", import.meta.url);
const approvalSourceUrl = new URL("../src/features/workspace/ChannelDetailOverlays.tsx", import.meta.url);
const approvalCssUrl = new URL("../src/styles/channel-overlays.css", import.meta.url);

test("retained standalone Profile and channel approval sources use the shared form contract", async () => {
  const [profileSource, profileCss, appShellSource, approvalSource, approvalCss] = await Promise.all([
    readFile(profileSourceUrl, "utf8"),
    readFile(profileCssUrl, "utf8"),
    readFile(appShellSourceUrl, "utf8"),
    readFile(approvalSourceUrl, "utf8"),
    readFile(approvalCssUrl, "utf8"),
  ]);

  expect(findRawTextControls(profileSource)).toEqual([]);
  expect(findRawTextControls(approvalSource)).toEqual([]);
  expect(profileSource).toContain('Field className="profile-identity-field"');
  expect(profileSource).toContain("<Input");
  expect(profileSource).toContain('data-profile-handle-readonly="true"');
  expect(profileSource).toContain("handle: profile?.handle ?? null");
  expect(profileSource).not.toContain("setHandle");
  expect(profileSource).not.toContain("normalizeHandle(");
  expect(profileCss).not.toMatch(/\.profile-identity-form\s+input\b/u);

  expect(appShellSource).toContain('activeView === "profile"');
  expect(appShellSource).toContain("<ProfilePage cwd={form.cwd} onProfileChange={setUserProfile} />");
  expect(approvalSource).toContain("Field, IconButton, InspectorSection, Textarea");
  expect(approvalSource).toContain("required={requiresReason}");
  expect(approvalSource).toContain("disabled={isResolving}");
  expect(approvalSource).toContain('onResolve(currentApproval.id, decision, trimmedReason || undefined)');
  expect(approvalSource).toContain('t("Required before approving high-risk requests")');
  expect(approvalSource).toContain('t("Optional note for the audit log")');
  expect(approvalCss).not.toMatch(/\.approval-reason-field\s+(?:textarea|\.ling-ui-textarea)\b/u);
  expect(approvalCss).not.toContain(".approval-reason-error");
});

for (const surface of [
  { theme: "light", width: 1440, height: 960 },
  { theme: "dark", width: 1280, height: 800 },
] as const) {
  test(`high-risk channel approval stays in its Composer decision owner in ${surface.theme}`, async ({ page }) => {
    await prepareSurface(page, surface);
    const runtimeErrors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "pending" });
    state.approvals[0].risk = "high";
    await mockDaemon(page, state);

    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    let decisionBody: unknown;
    let decisionRequests = 0;
    await page.route(/\/approvals\/approval_1\/approve(?:\?|$)/u, async (route) => {
      decisionRequests += 1;
      decisionBody = route.request().postDataJSON();
      await decisionGate;
      await route.fallback();
    });

    try {
      await page.goto("/");
      await openChannelChatTools(page);
      const gate = page.getByRole("region", { name: "Allow this action?" });
      await expect(gate).toBeVisible();
      await expect(gate).toHaveAttribute("data-runtime-approval-id", "approval_1");
      await expect(gate).toHaveAttribute("data-surface", "channel");
      await gate.getByRole("button", { name: "Deny" }).focus();
      await expect(gate.getByRole("button", { name: "Deny" })).toBeFocused();
      await expect(gate.getByLabel("Decision reason")).toHaveCount(0);
      await expect(page.getByLabel("Channel composer")).toHaveCount(0);
      await expectNoHorizontalOverflow(gate);

      await gate.getByRole("button", { name: "Allow once" }).click();
      await expect.poll(() => decisionRequests).toBe(1);
      await expect(gate.getByRole("button", { name: "Allowing" })).toBeDisabled();
      await expect(gate.getByRole("button", { name: "Deny" })).toBeDisabled();
      expect(decisionBody).toEqual({ decisionKind: "approve_once" });

      await captureScreenshot(
        page,
        `${surface.width}x${surface.height}-ling-${surface.theme}-approval-composer-busy.png`,
      );
      releaseDecision();
      await expect.poll(() => state.approvals[0].status).toBe("approved");
      await expect(gate).toHaveCount(0);
      await expect(page.getByLabel("Channel composer")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", surface.theme);
      expect(runtimeErrors).toEqual([]);
    } finally {
      releaseDecision();
    }
  });
}

function findRawTextControls(source: string): string[] {
  return (source.match(/<(?:input|textarea)\b[^>]*>/gsu) ?? []).filter((control) => {
    if (control.startsWith("<textarea")) return true;
    const type = /\btype\s*=\s*["']([^"']+)["']/u.exec(control)?.[1]?.toLowerCase();
    return type !== "file";
  });
}

async function prepareSurface(
  page: Page,
  surface: { readonly theme: "dark" | "light"; readonly width: number; readonly height: number },
): Promise<void> {
  await page.setViewportSize({ width: surface.width, height: surface.height });
  await page.addInitScript((theme) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, surface.theme);
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !isViteClientTransportError(message)) errors.push(message.text());
  });
  return errors;
}

async function captureScreenshot(page: Page, fileName: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", caret: "hide", path: `${screenshotDirectory}/${fileName}` });
}

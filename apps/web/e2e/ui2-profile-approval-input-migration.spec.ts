import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openChannelChatTools } from "./support/test-helpers";

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
  test(`high-risk channel approval keeps validation, audit payload, and contained focus in ${surface.theme}`, async ({ page }) => {
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
      const approvalBubble = page.locator(".message-bubble")
        .filter({ hasText: "Approval event" })
        .filter({ hasText: "Approve shell command" });
      await approvalBubble.getByRole("button", { name: "Open approval" }).click();

      const overlay = page.locator(".conversation-detail-overlay");
      await expect(overlay).toBeVisible();
      const field = overlay.locator(".approval-reason-field");
      const reason = overlay.getByLabel("Decision reason");
      await expect(field).toHaveClass(/ling-ui-field/u);
      await expect(reason).toHaveClass(/ling-ui-textarea/u);
      await expect(reason).toHaveAttribute("data-ling-control-native", "true");
      expect(await reason.evaluate((element) => (element as HTMLTextAreaElement).required)).toBe(true);
      await expect(reason).toBeEnabled();
      await expect(reason).toHaveAttribute("placeholder", "Required before approving high-risk requests");
      await expect(overlay.getByRole("button", { name: "Approve" })).toBeVisible();
      await expect(overlay.getByRole("button", { name: "Deny" })).toBeVisible();

      await expectContainedTextareaFocus(reason, field);
      await overlay.getByRole("button", { name: "Approve" }).click();
      await expect.poll(() => decisionRequests).toBe(0);
      await expect(reason).toHaveAttribute("aria-invalid", "true");
      const error = overlay.getByText("High-risk approvals need a decision reason.");
      await expect(error).toBeVisible();
      const describedBy = await reason.getAttribute("aria-describedby");
      expect(describedBy).toContain(await error.getAttribute("id"));
      await expect(overlay.getByRole("button", { name: "Confirm approve" })).toBeVisible();

      const auditReason = `${surface.theme} approval audit reason`;
      await reason.fill(auditReason);
      await expect(error).toHaveCount(0);
      await overlay.getByRole("button", { name: "Confirm approve" }).click();
      await expect.poll(() => decisionRequests).toBe(1);
      await expect(reason).toBeDisabled();
      await expect(overlay.getByRole("button", { name: "Approving" })).toBeDisabled();
      await expect(overlay.getByRole("button", { name: "Deny" })).toBeDisabled();
      expect(decisionBody).toEqual({ reason: auditReason });

      await captureScreenshot(
        page,
        `${surface.width}x${surface.height}-ling-${surface.theme}-approval-reason-focus-busy.png`,
      );
      releaseDecision();
      await expect.poll(() => state.approvals[0].status).toBe("approved");
      await expect(reason).toHaveCount(0);
      await expectNoHorizontalOverflow(overlay);
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

async function expectContainedTextareaFocus(textarea: Locator, field: Locator): Promise<void> {
  const before = await textarea.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { height: box.height, width: box.width };
  });
  await textarea.focus();
  const after = await textarea.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parentBox = element.parentElement?.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      boxShadow: styles.boxShadow,
      bottom: box.bottom,
      height: box.height,
      left: box.left,
      outlineStyle: styles.outlineStyle,
      parentBottom: parentBox?.bottom ?? 0,
      parentLeft: parentBox?.left ?? 0,
      parentRight: parentBox?.right ?? 0,
      parentTop: parentBox?.top ?? 0,
      right: box.right,
      top: box.top,
      width: box.width,
    };
  });

  expect(after.height).toBe(before.height);
  expect(after.width).toBe(before.width);
  expect(after.boxShadow).toContain("inset");
  expect(after.outlineStyle).toBe("none");
  expect(after.left).toBeGreaterThanOrEqual(after.parentLeft);
  expect(after.right).toBeLessThanOrEqual(after.parentRight);
  expect(after.top).toBeGreaterThanOrEqual(after.parentTop);
  expect(after.bottom).toBeLessThanOrEqual(after.parentBottom);
  await expectNoHorizontalOverflow(field);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function captureScreenshot(page: Page, fileName: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", caret: "hide", path: `${screenshotDirectory}/${fileName}` });
}

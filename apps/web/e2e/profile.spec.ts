import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";

const avatarDataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="#0e7a63"/></svg>').toString("base64")}`;

test("profile avatar crop exports a transparent circular image", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /^User profile$/ }).click();
  await expect(page.getByRole("heading", { name: "User profile", level: 1 })).toHaveCount(0);
  await expect(page.locator('[data-profile-section="identity"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save profile" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Identity information" })).toHaveCount(0);
  await expect(page.getByLabel("Handle")).toHaveCount(0);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  await expect(page.getByText(`@${state.userProfile.handle ?? "local-user"}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Display preview" })).toHaveCount(0);
  await expect(page.getByLabel("Profile display preview")).toHaveCount(0);
  await expect(page.locator(".profile-preview-card")).toHaveCount(0);
  await expect(page.locator(".profile-usage-details summary")).toHaveCount(0);
  await expect(page.locator(".profile-usage-details .profile-settings-heatmap")).toBeVisible();
  await expect(page.locator(".profile-usage-streak-grid .profile-usage-metric")).toHaveCount(3);

  await page.getByRole("button", { name: "Edit display name" }).click();
  const displayNameInput = page.getByLabel("Display name", { exact: true });
  await expect(displayNameInput).toBeVisible();
  await displayNameInput.fill("Tian Xiao");
  await page.locator('[data-profile-section="usage"]').click();
  await expect.poll(() => state.userProfile.displayName).toBe("Tian Xiao");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-profile-name-row="true"]', { hasText: "Tian Xiao" })).toBeVisible();
  const profileSavedTip = page.locator('.ling-ui-toast[data-scope="profile:save"]', { hasText: "Profile saved" });
  await expect(profileSavedTip).toBeVisible();
  await expect(page.locator('[data-profile-section="identity"] .ling-ui-toast')).toHaveCount(0);
  await expect(profileSavedTip).toHaveCount(0, { timeout: 5000 });

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "avatar.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#d71920"/></svg>'),
  });

  await expect(page.getByRole("dialog", { name: "Adjust avatar" })).toHaveClass(/ling-ui-dialog-content/u);
  await page.getByRole("button", { name: "Use avatar" }).click();

  const avatarImage = page.locator(".profile-settings-avatar img");
  await expect(avatarImage).toBeVisible();
  const avatarChrome = await page.locator(".profile-settings-avatar").evaluate((element) => {
    const buttonRect = element.getBoundingClientRect();
    const editElement = element.querySelector(".profile-settings-avatar-edit");
    if (!(editElement instanceof HTMLElement)) {
      throw new Error("profile avatar edit badge did not render");
    }
    const editRect = editElement.getBoundingClientRect();
    const buttonStyle = getComputedStyle(element);
    return {
      width: buttonRect.width,
      height: buttonRect.height,
      paddingTop: buttonStyle.paddingTop,
      paddingRight: buttonStyle.paddingRight,
      paddingBottom: buttonStyle.paddingBottom,
      paddingLeft: buttonStyle.paddingLeft,
      editRightOverhang: editRect.right - buttonRect.right,
    };
  });
  expect(Math.abs(avatarChrome.width - avatarChrome.height)).toBeLessThanOrEqual(0.5);
  expect(avatarChrome.paddingTop).toBe("0px");
  expect(avatarChrome.paddingRight).toBe("0px");
  expect(avatarChrome.paddingBottom).toBe("0px");
  expect(avatarChrome.paddingLeft).toBe("0px");
  expect(avatarChrome.editRightOverhang).toBeGreaterThan(0);
  const avatarDataUrl = await avatarImage.getAttribute("src");
  if (!avatarDataUrl) {
    throw new Error("profile avatar image did not render a data URL");
  }
  expect(avatarDataUrl).toMatch(/^data:image\/(?:webp|png);base64,/);

  const alpha = await page.evaluate(async (dataUrl) => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("avatar image did not decode"));
      element.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("canvas context is unavailable");
    }
    context.drawImage(image, 0, 0);
    return {
      corner: context.getImageData(0, 0, 1, 1).data[3],
      center: context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3],
    };
  }, avatarDataUrl);
  expect(alpha.corner).toBe(0);
  expect(alpha.center).toBeGreaterThan(240);

  await expect.poll(() => state.userProfile.avatarDataUrl ?? "").toMatch(/^data:image\/(?:webp|png);base64,/);
});

test("workspace messages use the saved user profile identity", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.userProfile = {
    ...state.userProfile,
    displayName: "Tian Xiao",
    avatarDataUrl,
  };
  state.channelMessages = [
    {
      id: "msg_profile_identity",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      authorType: "local-user",
      authorId: "local-user",
      kind: "message",
      intent: "discuss",
      body: "Profile identity should render in this message.",
      status: "sent",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  const message = page.locator(".channel-message-row.local-user").filter({ hasText: "Profile identity should render in this message." });
  await expect(message).toBeVisible();
  await expect(message).not.toContainText("Tian Xiao");
  await expect(message).not.toContainText("local-user");
  await expect(message.locator(".user-profile-avatar")).toHaveAttribute("src", avatarDataUrl);
  await expect(message.locator(".avatar-initial")).toHaveCount(0);
  await expect(message.locator(".message-row-own-identity")).toHaveCount(0);

  const messageLayout = await message.evaluate((element) => {
    const bodyElement = element.querySelector(".message-body-shell");
    const avatarElement = element.querySelector(".user-profile-avatar");
    if (!(bodyElement instanceof HTMLElement) || !(avatarElement instanceof HTMLElement)) {
      throw new Error("channel user message did not render a body and avatar");
    }
    const bodyRect = bodyElement.getBoundingClientRect();
    const avatarRect = avatarElement.getBoundingClientRect();
    return {
      centerDelta: Math.abs((bodyRect.top + bodyRect.height / 2) - (avatarRect.top + avatarRect.height / 2)),
      horizontalGap: avatarRect.left - bodyRect.right,
    };
  });
  expect(messageLayout.centerDelta).toBeLessThanOrEqual(24);
  expect(messageLayout.horizontalGap).toBeGreaterThan(0);
});

test("private teammate chat messages use the saved user profile identity", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_profile_sync";
  state.userProfile = {
    ...state.userProfile,
    displayName: "Tian Xiao",
    avatarDataUrl,
  };
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer" })];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_profile_identity",
      workspaceId: "workspace_default",
      threadId: `tdthread_${teammateId}`,
      teammateId,
      authorType: "local-user",
      authorId: "local-user",
      body: "Private chat should render profile identity.",
      attachmentIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const message = page.getByLabel("Private chat", { exact: true }).locator(".teammate-message-row.local-user").filter({ hasText: "Private chat should render profile identity." });
  await expect(message).toBeVisible();
  await expect(message).not.toContainText("Tian Xiao");
  await expect(message).not.toContainText("You");
  await expect(message.locator(".user-profile-avatar")).toHaveAttribute("src", avatarDataUrl);
  await expect(message.locator(".avatar-initial")).toHaveCount(0);
  await expect(message.locator(".message-row-own-identity")).toHaveCount(0);

  const messageLayout = await message.evaluate((element) => {
    const bodyElement = element.querySelector(".message-body-shell");
    const avatarElement = element.querySelector(".user-profile-avatar");
    if (!(bodyElement instanceof HTMLElement) || !(avatarElement instanceof HTMLElement)) {
      throw new Error("local user message did not render a body and avatar");
    }
    const bodyRect = bodyElement.getBoundingClientRect();
    const avatarRect = avatarElement.getBoundingClientRect();
    return {
      centerDelta: Math.abs((bodyRect.top + bodyRect.height / 2) - (avatarRect.top + avatarRect.height / 2)),
      horizontalGap: avatarRect.left - bodyRect.right,
    };
  });
  expect(messageLayout.centerDelta).toBeLessThanOrEqual(24);
  expect(messageLayout.horizontalGap).toBeGreaterThan(0);
});

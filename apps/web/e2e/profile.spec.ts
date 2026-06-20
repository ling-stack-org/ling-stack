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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Ling User", level: 1 })).toBeVisible();

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "avatar.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#d71920"/></svg>'),
  });

  await expect(page.getByRole("dialog", { name: "调整头像" })).toBeVisible();
  await page.getByRole("button", { name: "使用头像" }).click();

  const avatarImage = page.locator(".profile-avatar-button img");
  await expect(avatarImage).toBeVisible();
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

  await page.getByRole("button", { name: "保存资料" }).click();
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

  const message = page.locator(".channel-message-row.local-user").filter({ hasText: "Profile identity should render in this message." });
  await expect(message).toContainText("Tian Xiao");
  await expect(message).not.toContainText("local-user");
  await expect(message.locator(".user-profile-avatar")).toHaveAttribute("src", avatarDataUrl);
  await expect(message.locator(".avatar-initial")).toHaveCount(0);
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
  await expect(message).toContainText("Tian Xiao");
  await expect(message).not.toContainText("You");
  await expect(message.locator(".user-profile-avatar")).toHaveAttribute("src", avatarDataUrl);
  await expect(message.locator(".avatar-initial")).toHaveCount(0);
});

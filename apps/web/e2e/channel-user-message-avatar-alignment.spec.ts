import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "@ling-stack/conversation-ui-react";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { mockDaemon } from "./support/mock-daemon";
import { installNormalConversationFixture, normalConversationFixtureTitle } from "./support/normal-conversation-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

const userBody = "C01 avatar alignment: ask Engineer and QA to inspect the workspace.\n\nRead the project files and keep the review evidence.\n\nWait for both reports before summarizing.";
const peerBody = "Confirmed: Starting now.\n\nThe peer avatar must remain beside this first paragraph.";
const avatarSelector = ":scope > :is(.avatar-initial, .user-profile-avatar, img)";
const timestamp = "2026-09-05T12:00:00.000Z";

for (const viewport of [{ width: 1440, height: 960 }, { width: 960, height: 800 }]) {
  test.describe(`${viewport.width}px document message identity`, () => {
    test.use({ viewport });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    });

    test("Channel user avatar stays right and peer avatar stays left of the document body", async ({ page }, testInfo) => {
      const state = createBaseState({ approvalStatus: "expired" });
      state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent" })];
      const base = {
        workspaceId: "workspace_default", channelId: "channel_engineering", intent: "discuss",
        mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready",
        createdAt: timestamp, updatedAt: timestamp,
      };
      state.channelMessages = [
        { ...base, id: "msg_avatar_source", kind: "message", authorType: "local-user", authorId: "local-user", body: userBody },
        { ...base, id: "msg_avatar_ack", kind: "ai_reply", authorType: "ai-teammate", authorId: "ling_agent",
          body: peerBody, createdAt: "2026-09-05T12:00:01.000Z" },
      ];
      await mockDaemon(page, state);
      await page.goto("/");
      await openEngineeringChannel(page);
      const rows = page.getByLabel("Channel message feed").locator("[data-conversation-message-row].channel-message-row");
      await expectMessageGeometry(rows.filter({ hasText: "C01 avatar alignment" }), testInfo, "channel-user", true, true);
      await expectMessageGeometry(rows.filter({ hasText: "Confirmed: Starting now." }), testInfo, "channel-peer", true, false);
    });

    test("Private user avatar stays right and peer avatar stays left of the document body", async ({ page }, testInfo) => {
      const state = createBaseState({ approvalStatus: "expired" });
      const teammateId = "teammate_avatar_alignment";
      const displayName = "Avatar Alignment Engineer";
      state.aiTeammates = [createMockTeammate({ id: teammateId, displayName })];
      const base = {
        workspaceId: "workspace_default", threadId: `tdthread_${teammateId}`, teammateId,
        attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready",
        createdAt: timestamp, updatedAt: timestamp,
      };
      state.teammateDirectMessages = [
        { ...base, id: "dm_avatar_source", authorType: "local-user", authorId: "local-user", body: userBody },
        { ...base, id: "dm_avatar_peer", authorType: "ai-teammate", authorId: teammateId, body: peerBody,
          createdAt: "2026-09-05T12:00:01.000Z" },
      ];
      await mockDaemon(page, state);
      await page.goto("/");
      await showSidebar(page);
      await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
        .getByRole("button", { name: displayName, exact: true }).click();
      const rows = page.getByLabel("Private message feed", { exact: true }).locator("[data-conversation-message-row].teammate-message-row");
      await expectMessageGeometry(rows.filter({ hasText: "C01 avatar alignment" }), testInfo, "private-user", true, true);
      await expectMessageGeometry(rows.filter({ hasText: "Confirmed: Starting now." }), testInfo, "private-peer", true, false);
    });

    test("Normal user and peer messages retain the avatar-free document lane", async ({ page }, testInfo) => {
      const state = createBaseState({ approvalStatus: "expired" });
      const threadId = installNormalConversationFixture(state);
      const turn = state.turns.find((candidate) => candidate.threadId === threadId);
      if (!turn?.lastRunId) throw new Error("Normal conversation fixture must own a completed run");
      state.turns = state.turns.map((candidate) => candidate.id === turn.id ? { ...candidate, userInstruction: userBody } : candidate);
      state.eventsByRun[turn.lastRunId] = [{
        id: "event_normal_avatar_peer", runId: turn.lastRunId, seq: 1, ts: timestamp,
        type: "assistant_text_delta", data: { text: peerBody },
      }];
      await mockDaemon(page, state);
      await page.goto("/");
      await showSidebar(page);
      await page.getByRole("button", { name: /Open recent conversation \d+/u })
        .filter({ hasText: normalConversationFixtureTitle }).click();
      const rows = page.getByLabel("Conversation page").getByLabel("Conversation messages", { exact: true })
        .locator("[data-conversation-message-row].normal-conversation-message-row");
      await expectMessageGeometry(rows.filter({ hasText: "C01 avatar alignment" }), testInfo, "normal-user", false, true);
      await expectMessageGeometry(rows.filter({ hasText: "Confirmed: Starting now." }), testInfo, "normal-peer", false, false);
    });

    test("shared own-author variant keeps identity, document body, and actions on separate rows", async ({ page }, testInfo) => {
      const surfaces = ["channel_root", "teammate_direct", "normal_conversation"] as const;
      const markup = renderToStaticMarkup(createElement("main", {
        style: { padding: 24, maxWidth: 1100, margin: "0 auto" },
      }, surfaces.map((surface) => createElement(MessageRow, {
        key: surface, id: `own-author-${surface}`, surface, authorType: "local-user",
        authorName: "You", createdAtLabel: "12:00", showOwnAuthor: true, tone: "document",
        avatar: createElement("span", { className: "avatar-initial", "aria-label": "User avatar" }, "U"),
        body: userBody,
        actionsNode: createElement("button", { type: "button" }, "Copy message"),
      }))));
      // Use the actual shared component markup and app stylesheet, without
      // changing a production route or constructing a substitute message DOM.
      await page.route("**/__message-row-avatar-fixture", (route) => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/src/styles.css"></head><body>${markup}</body></html>`,
      }));
      await page.goto("/__message-row-avatar-fixture");
      for (const surface of surfaces) {
        const row = page.locator(`#own-author-${surface}`);
        await expect(row).toHaveCSS("display", "grid");
        await expectMessageGeometry(row, testInfo, `${surface}-own-author`, surface !== "normal_conversation", true, true);
      }
    });
  });
}

async function showSidebar(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const showNavigation = page.getByRole("button", { name: /Show navigation|显示导航/u });
  await expect.poll(async () => await navigation.isVisible() || await showNavigation.isVisible()).toBe(true);
  if (!await navigation.isVisible()) await showNavigation.click();
  await expect(navigation).toBeVisible();
}

async function expectMessageGeometry(
  row: Locator,
  testInfo: TestInfo,
  artifactPrefix: string,
  hasAvatar: boolean,
  ownMessage: boolean,
  showOwnAuthor = false,
): Promise<void> {
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-has-avatar", String(hasAvatar));
  const resolvedAvatarSelector = showOwnAuthor
    ? ":scope > .message-row-own-identity > :is(.avatar-initial, .user-profile-avatar, img)"
    : avatarSelector;
  await expect(row.locator(resolvedAvatarSelector)).toHaveCount(hasAvatar ? 1 : 0);
  await expect(row.locator(":scope > .message-content")).toContainText(ownMessage ? "Wait for both reports" : "The peer avatar");
  await expect(row.locator(".message-body-paragraph")).toHaveCount(ownMessage ? 3 : 2);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await expect(row.getByRole("button", { name: "Copy message", exact: true })).toBeVisible();
  const geometry = await row.evaluate((element, selector) => {
    const content = element.querySelector<HTMLElement>(":scope > .message-content");
    if (!content) throw new Error("Message chrome must contain its body");
    const avatar = element.querySelector<HTMLElement>(selector);
    const actions = element.querySelector<HTMLElement>(":scope > .message-row-own-actions");
    const identity = element.querySelector<HTMLElement>(":scope > .message-row-own-identity");
    const rowRect = element.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const avatarRect = avatar?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const identityRect = identity?.getBoundingClientRect();
    const contentStyle = getComputedStyle(content);
    return {
      bodyInsideSameRow: content.contains(element.querySelector(".message-body-renderer")),
      rowTop: rowRect.top, rowLeft: rowRect.left, rowRight: rowRect.right,
      contentTop: contentRect.top, contentBottom: contentRect.bottom,
      contentLeft: contentRect.left, contentRight: contentRect.right,
      contentWidth: contentRect.width, rowWidth: rowRect.width,
      avatarTop: avatarRect?.top ?? null, avatarBottom: avatarRect?.bottom ?? null,
      avatarLeft: avatarRect?.left ?? null, avatarRight: avatarRect?.right ?? null,
      actionsTop: actionsRect?.top ?? null, actionsLeft: actionsRect?.left ?? null, actionsRight: actionsRect?.right ?? null,
      identityBottom: identityRect?.bottom ?? null, identityRight: identityRect?.right ?? null,
      columns: getComputedStyle(element).gridTemplateColumns.split(/\s+/u),
      contentGridRow: contentStyle.gridRow,
      contentTextAlign: contentStyle.textAlign,
      contentBorderWidth: contentStyle.borderTopWidth,
      contentBackground: contentStyle.backgroundColor,
      contentShadow: contentStyle.boxShadow,
      avatarGridRow: avatar ? getComputedStyle(avatar).gridRow : null,
      actionsGridRow: actions ? getComputedStyle(actions).gridRow : null,
      identityGridRow: identity ? getComputedStyle(identity).gridRow : null,
    };
  }, resolvedAvatarSelector);
  const geometryPath = testInfo.outputPath(`${artifactPrefix}-avatar-geometry.json`);
  await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
  await testInfo.attach(`${artifactPrefix}-avatar-geometry.json`, { path: geometryPath, contentType: "application/json" });
  await row.page().screenshot({ path: testInfo.outputPath(`${artifactPrefix}-avatar.png`) });
  expect(geometry.bodyInsideSameRow).toBe(true);
  expect(geometry.contentLeft).toBeGreaterThanOrEqual(geometry.rowLeft - 2);
  expect(geometry.contentRight).toBeLessThanOrEqual(geometry.rowRight + 2);
  expect.soft(["left", "start"]).toContain(geometry.contentTextAlign);
  expect.soft(geometry.contentBorderWidth).toBe("0px");
  expect.soft(geometry.contentBackground).toBe("rgba(0, 0, 0, 0)");
  expect.soft(geometry.contentShadow).toBe("none");
  const evidence = JSON.stringify(geometry);
  if (hasAvatar) {
    expect(geometry.avatarTop).not.toBeNull();
    if (!showOwnAuthor) {
      expect.soft(Math.abs(geometry.avatarTop! - geometry.contentTop), evidence).toBeLessThanOrEqual(2);
      if (ownMessage) {
        expect.soft(geometry.avatarLeft!, evidence).toBeGreaterThanOrEqual(geometry.contentRight - 2);
        expect.soft(Math.abs(geometry.avatarRight! - geometry.rowRight), evidence).toBeLessThanOrEqual(2);
      } else {
        expect.soft(geometry.avatarRight!, evidence).toBeLessThanOrEqual(geometry.contentLeft + 2);
        expect.soft(Math.abs(geometry.avatarLeft! - geometry.rowLeft), evidence).toBeLessThanOrEqual(2);
      }
    }
  } else {
    expect(geometry.avatarTop).toBeNull();
    expect.soft(geometry.columns, evidence).toHaveLength(1);
    const alignedEdgeGap = ownMessage ? geometry.rowRight - geometry.contentRight : geometry.contentLeft - geometry.rowLeft;
    expect.soft(Math.abs(alignedEdgeGap), evidence).toBeLessThanOrEqual(2);
  }
  if (ownMessage) {
    expect(geometry.actionsTop).not.toBeNull();
    expect.soft(geometry.actionsTop!, evidence).toBeGreaterThanOrEqual(geometry.contentBottom - 2);
    expect.soft(geometry.actionsLeft!, evidence).toBeGreaterThanOrEqual(geometry.contentLeft - 2);
    expect.soft(Math.abs(geometry.actionsRight! - geometry.contentRight), evidence).toBeLessThanOrEqual(2);
  }
  if (showOwnAuthor) {
    expect(geometry.identityBottom).not.toBeNull();
    expect.soft(geometry.columns, evidence).toHaveLength(1);
    expect.soft(geometry.contentTop, evidence).toBeGreaterThanOrEqual(geometry.identityBottom! - 2);
    expect.soft(Math.abs(geometry.identityRight! - geometry.rowRight), evidence).toBeLessThanOrEqual(2);
    expect.soft(Math.abs(geometry.contentRight - geometry.rowRight), evidence).toBeLessThanOrEqual(2);
    if (hasAvatar) expect.soft(Math.abs(geometry.avatarRight! - geometry.identityRight!), evidence).toBeLessThanOrEqual(2);
    expect.soft(geometry.identityGridRow, evidence).toBe("1");
    expect.soft(geometry.contentGridRow, evidence).toBe("2");
    expect.soft(geometry.actionsGridRow, evidence).toBe("3");
  }
}

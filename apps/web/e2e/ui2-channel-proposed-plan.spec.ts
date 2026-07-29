import type { ProposedPlanArtifact } from "@ling-stack/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const threadId = "thread_channel_main_channel_engineering";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-proposed-plan/",
  import.meta.url,
));

test("Proposed Plan contains long content and four shared actions at 1440 Light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProposedPlanState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const card = planCard(page, "Long containment plan");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Unbroken content");
  const title = card.locator(".proposed-plan-head strong");
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  const actionNames = ["Save", "Convert to workflow", "Refine plan", "Implement"] as const;
  for (const name of actionNames) {
    const action = card.getByRole("button", { name });
    await expect(action).toHaveClass(/ling-ui-button/u);
    expect((await action.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32);
  }
  const save = card.getByRole("button", { name: "Save" });
  await save.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(save).toBeFocused();
  await expect(save).toHaveCSS("outline-style", "solid");
  await expectContained(card, card.locator(".proposed-plan-body"), card.locator(".proposed-plan-actions"));
  await expectAllPlanCardsContained(page);
  await expectPageContained(page);
  expect(runtimeErrors).toEqual([]);
  await captureEvidence(page, "1440x960-ling-light-proposed-plan-long-four-actions-focus.png");
  expect(runtimeErrors).toEqual([]);
});

test("Proposed Plan shows five display states and card busy semantics at 1280 Dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProposedPlanState();
  await mockDaemon(page, state);
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route(/\/threads\/thread_channel_main_channel_engineering\/proposed-plans\/proposed_plan_msg_plan_long\/save(?:\?|$)/u, async (route) => {
    await saveGate;
    await route.fallback();
  });
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  for (const [title, status] of [
    ["Long containment plan", "Draft"],
    ["Saved plan", "Saved"],
    ["Accepted plan", "Accepted"],
    ["Superseded plan", "Superseded"],
    ["Archived plan", "Archived"],
  ] as const) {
    await expect(planCard(page, title).locator(".proposed-plan-head small")).toContainText(status);
  }

  const card = planCard(page, "Long containment plan");
  const actions = card.locator(".proposed-plan-actions").getByRole("button");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(actions).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(actions.nth(index)).toBeDisabled();
    await expect(actions.nth(index)).toHaveAttribute("aria-busy", "true");
  }
  await expect(card.locator(".ling-ui-spinner")).toHaveCount(4);
  expect(await card.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  await expectContained(card, card.locator(".proposed-plan-body"), card.locator(".proposed-plan-actions"));
  await expectAllPlanCardsContained(page);
  await expectPageContained(page);
  expect(runtimeErrors).toEqual([]);
  await captureEvidence(page, "1280x800-ling-dark-proposed-plan-five-states-busy.png");
  expect(runtimeErrors).toEqual([]);
  releaseSave();
  await expect(card.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(runtimeErrors).toEqual([]);
  const acceptedCard = planCard(page, "Accepted plan");
  await acceptedCard.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(acceptedCard).toBeVisible();
  await expectAllPlanCardsContained(page);
  await expectPageContained(page);
  expect(runtimeErrors).toEqual([]);
  await captureEvidence(page, "1280x800-ling-dark-proposed-plan-accepted-superseded.png");
  expect(runtimeErrors).toEqual([]);
  const archivedCard = planCard(page, "Archived plan");
  await archivedCard.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect(archivedCard).toBeVisible();
  await expectAllPlanCardsContained(page);
  await expectPageContained(page);
  expect(runtimeErrors).toEqual([]);
  await captureEvidence(page, "1280x800-ling-dark-proposed-plan-superseded-archived.png");
  expect(runtimeErrors).toEqual([]);
});

test("Proposed Plan reduced motion and failed action remain contained", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProposedPlanState();
  await mockDaemon(page, state);
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  await page.route(/\/threads\/thread_channel_main_channel_engineering\/proposed-plans\/proposed_plan_msg_plan_long\/save(?:\?|$)/u, async (route) => {
    await failureGate;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "plan_save_failed", message: "Plan save failed." }),
    });
  });
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const card = planCard(page, "Long containment plan");
  const save = card.getByRole("button", { name: "Save" });
  await save.click();
  await expect(card.locator(".ling-ui-spinner > svg").first()).toHaveCSS("animation-duration", "1.8s");
  await expect(save).toHaveCSS("transition-duration", "0s");
  releaseFailure();
  const failure = page.locator('.channel-composer-feedback-stack .composer-status-row.error');
  await expect(failure).toContainText("Plan save failed.");
  await expect(save).toBeEnabled();
  await expect(card).not.toContainText("Rejected");
  await expect(card).not.toContainText("Failed");
  await expectContained(card, card.locator(".proposed-plan-body"), card.locator(".proposed-plan-actions"));
  await expectAllPlanCardsContained(page);
  await expectPageContained(page);
  expect(runtimeErrors).toEqual([]);
  await captureEvidence(page, "1280x800-ling-dark-reduced-motion-proposed-plan-action-failure.png");
  expect(runtimeErrors).toEqual([]);
});

function createProposedPlanState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Main branch",
    objective: "Proposed Plan UI 2.0 fixture.",
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  }];
  const fixtures = [
    { id: "plan_long", title: "Long containment plan", status: "draft" as const },
    { id: "plan_saved", title: "Saved plan", status: "draft" as const, savedAt: "2026-07-24T00:01:00.000Z" },
    { id: "plan_accepted", title: "Accepted plan", status: "accepted" as const },
    { id: "plan_superseded", title: "Superseded plan", status: "superseded" as const },
    { id: "plan_archived", title: "Archived plan", status: "archived" as const },
  ];
  state.channelMessages = fixtures.map((fixture, index) => ({
    id: `msg_${fixture.id}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId,
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: `<proposed_plan title="${fixture.title}${fixture.id === "plan_long" ? ` ${"title ".repeat(28)}` : ""}">\n${fixture.id === "plan_long" ? longPlanBody() : `${fixture.title} body.`}\n</proposed_plan>`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: `2026-07-24T00:0${index}:00.000Z`,
    updatedAt: `2026-07-24T00:0${index}:00.000Z`,
  }));
  state.proposedPlans = fixtures.map((fixture, index): ProposedPlanArtifact => ({
    id: `proposed_plan_msg_${fixture.id}`,
    workspaceId: "workspace_default",
    threadId,
    channelId: "channel_engineering",
    sourceMessageId: `msg_${fixture.id}`,
    title: fixture.id === "plan_long" ? `${fixture.title} ${"title ".repeat(28)}` : fixture.title,
    bodyMarkdown: fixture.id === "plan_long" ? longPlanBody() : `${fixture.title} body.`,
    status: fixture.status,
    savedAt: fixture.savedAt,
    createdAt: `2026-07-24T00:0${index}:00.000Z`,
    updatedAt: `2026-07-24T00:0${index}:00.000Z`,
  }));
  return state;
}

function longPlanBody(): string {
  return [
    "Unbroken content:",
    `workspace/${"deep-segment-".repeat(36)}file.ts`,
    "",
    "| Step | Owner | Result |",
    "| --- | --- | --- |",
    "| Verify containment | Ling | Ready |",
    "",
    "```text",
    "x".repeat(240),
    "```",
  ].join("\n");
}

function planCard(page: Page, title: string): Locator {
  return page.locator(".proposed-plan-block").filter({ hasText: title }).first();
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectContained(...locators: Locator[]): Promise<void> {
  const [root, body, actions] = locators;
  if (!root || !body || !actions) throw new Error("Proposed Plan containment requires root, body, and actions");
  await expect(root).toHaveCSS("overflow-x", "hidden");
  await expect(body).toHaveCSS("overflow-x", "hidden");
  expect(await actions.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const rootBox = await root.boundingBox();
  if (!rootBox) throw new Error("Proposed Plan root geometry is unavailable");
  for (const child of [body, actions]) {
    const childBox = await child.boundingBox();
    if (!childBox) throw new Error("Proposed Plan child geometry is unavailable");
    expect(childBox.x).toBeGreaterThanOrEqual(rootBox.x - 1);
    expect(childBox.x + childBox.width).toBeLessThanOrEqual(rootBox.x + rootBox.width + 1);
  }
}

async function expectPageContained(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const feed = document.querySelector<HTMLElement>(".activity-shell .message-feed");
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      feed: feed ? feed.scrollWidth - feed.clientWidth : undefined,
    };
  });
  expect(overflow.feed).toBeDefined();
  expect(overflow.feed).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
}

async function expectAllPlanCardsContained(page: Page): Promise<void> {
  const cards = page.locator(".proposed-plan-block");
  await expect(cards).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    const card = cards.nth(index);
    await expectContained(card, card.locator(".proposed-plan-body"), card.locator(".proposed-plan-actions"));
  }
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

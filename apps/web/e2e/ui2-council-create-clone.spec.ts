import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  isRecord,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/council-create-clone/",
  import.meta.url,
));

test("Create sends selected members and routing once while every busy close path stays blocked", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilState();
  state.aiCouncilCreateDelayMs = 350;
  const createPosts = collectCouncilPosts(page, "create");
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await surface.getByLabel("Filter councils by health").selectOption("critical");
  const trigger = surface.getByRole("button", { name: "Create council" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create council" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("New council name")).toBeFocused();
  await dialog.getByLabel("New council name").fill("Release Council");
  await dialog.getByLabel("New council description").fill("Cross-functional release review");
  await dialog.getByLabel("Routing mode").selectOption("parallel_review");
  await expect(dialog.getByRole("checkbox", { name: "Paused Teammate" })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Disabled Teammate" })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Hidden Teammate" })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Ling Agent" })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Ling Engineer" }).check();
  await dialog.getByRole("checkbox", { name: "Ling QA" }).check();
  await captureEvidence(page, "1440x960-ling-light-create-members-routing.png");

  const submit = dialog.getByRole("button", { name: "Create council" });
  await submit.dblclick();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.locator('[data-ling-overlay-scrim="dialog"]').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => createPosts.length).toBe(1);
  expect(createPosts[0]).toEqual({
    displayName: "Release Council",
    description: "Cross-functional release review",
    routingPolicy: { defaultMode: "parallel_review" },
    members: [
      { teammateId: "teammate_engineer", slotKey: "engineer", position: 0, enabled: true },
      { teammateId: "teammate_qa", slotKey: "qa", position: 1, enabled: true },
    ],
  });
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="council:create"]')).toContainText("Release Council created");
  await expect(surface.locator(".council-workspace-list")).toContainText("Release Council");
  await expect(surface.getByLabel("Selected council")).toContainText("Release Council");
  await expect(surface.getByLabel("Filter councils by health")).toHaveValue("all");
  expect(runtimeErrors).toEqual([]);
});

test("Create requires explicit zero-member confirmation and preserves the draft after failure", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilState();
  state.failNextAiCouncilCreate = {
    error: "council_create_unavailable",
    message: "Synthetic council create failure",
  };
  const createPosts = collectCouncilPosts(page, "create");
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await surface.getByRole("button", { name: "Create council" }).click();
  const dialog = page.getByRole("dialog", { name: "Create council" });
  await dialog.getByLabel("New council name").fill("Empty Review Council");
  await dialog.getByLabel("New council description").fill("Draft must survive");
  await dialog.getByLabel("Routing mode").selectOption("handoff");

  await dialog.getByRole("button", { name: "Create council" }).click();
  await expect(dialog.getByText("This council has no members and will need attention before it is useful.")).toBeVisible();
  await expect.poll(() => createPosts.length).toBe(0);

  await dialog.getByRole("button", { name: "Create without members" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Synthetic council create failure");
  await expect(dialog.getByLabel("New council name")).toHaveValue("Empty Review Council");
  await expect(dialog.getByLabel("New council description")).toHaveValue("Draft must survive");
  await expect(dialog.getByLabel("Routing mode")).toHaveValue("handoff");
  await expect(dialog.getByRole("button", { name: "Create without members" })).toBeEnabled();

  await dialog.getByRole("button", { name: "Create without members" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => createPosts.length).toBe(2);
  expect(createPosts[1]).toEqual({
    displayName: "Empty Review Council",
    description: "Draft must survive",
    routingPolicy: { defaultMode: "handoff" },
    members: [],
  });
  expect(runtimeErrors).toEqual([]);
});

test("Clone reviews truthful semantics, retries in place, and submits only supported fields", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilState();
  state.channelCouncilPolicies = [{
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    attachedCouncilIds: ["council_builtin_development"],
    preferredCouncilId: "council_builtin_development",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  }];
  state.failNextAiCouncilClone = {
    error: "council_clone_unavailable",
    message: "Synthetic council clone failure",
  };
  const clonePosts = collectCouncilPosts(page, "clone");
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await surface.getByRole("tab", { name: "Council settings" }).click();
  await surface.getByText("More council actions").click();
  const trigger = surface.getByRole("button", { name: "Clone council" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review council clone" });
  await expect(dialog).toContainText("Members and routing will be copied");
  await expect(dialog).toContainText("Channel attachments will not be copied");
  await expect(dialog).toContainText("Parallel review");
  await expect(dialog).toContainText("3 current members");
  await expect(dialog).toContainText("The new council will be active");
  await dialog.getByLabel("Clone name").fill("Release Review Copy");
  await dialog.getByLabel("Clone description").fill("Editable clone description");
  await dialog.getByLabel("Pin cloned council").check();

  await dialog.getByRole("button", { name: "Clone council" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Synthetic council clone failure");
  await expect(dialog.getByLabel("Clone name")).toHaveValue("Release Review Copy");
  await expect(dialog.getByLabel("Clone description")).toHaveValue("Editable clone description");
  await expect(dialog.getByLabel("Pin cloned council")).toBeChecked();

  state.aiCouncilCloneDelayMs = 350;
  await dialog.getByRole("button", { name: "Clone council" }).dblclick();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.locator('[data-ling-overlay-scrim="dialog"]').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => clonePosts.length).toBe(2);
  expect(clonePosts[1]).toEqual({
    displayName: "Release Review Copy",
    description: "Editable clone description",
    pinned: true,
  });
  const clone = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Release Review Copy");
  expect(clone).toMatchObject({ source: "user", status: "active", pinned: true });
  expect(isRecord(clone) && isRecord(clone.routingPolicy) ? clone.routingPolicy.defaultMode : undefined).toBe("parallel_review");
  const cloneId = isRecord(clone) ? String(clone.id) : "";
  expect(state.aiCouncilMembers.filter((item) => isRecord(item) && item.councilId === cloneId)).toHaveLength(3);
  expect(state.channelCouncilPolicies[0]).toMatchObject({
    attachedCouncilIds: ["council_builtin_development"],
    preferredCouncilId: "council_builtin_development",
  });
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="council:clone"]')).toContainText("Release Review Copy cloned");
  await expect(surface.getByLabel("Selected council")).toContainText("Release Review Copy");
  expect(runtimeErrors).toEqual([]);
});

test("Create projects an authoritative council omitted from the first 100 list rows", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilState();
  const detailGets = collectCouncilDetailGets(page);
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  const source = state.aiCouncils.find(isRecord);
  expect(source).toBeTruthy();
  state.aiCouncils = [
    ...state.aiCouncils,
    ...Array.from({ length: 101 }, (_, index) => ({
      ...source,
      id: `council_pinned_${String(index).padStart(3, "0")}`,
      source: "user",
      templateId: undefined,
      displayName: `Pinned Council ${String(index).padStart(3, "0")}`,
      pinned: true,
    })),
  ];

  await surface.getByRole("button", { name: "Create council" }).click();
  const dialog = page.getByRole("dialog", { name: "Create council" });
  await dialog.getByLabel("New council name").fill("Authoritative Projection");
  await dialog.getByRole("checkbox", { name: "Ling Engineer" }).check();
  await dialog.getByRole("button", { name: "Create council" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(surface.locator(".council-workspace-list")).toContainText("Authoritative Projection");
  await expect(surface.getByLabel("Selected council")).toContainText("Authoritative Projection");
  expect(detailGets.some((path) => /^\/ai-councils\/council_custom_/u.test(path))).toBe(true);
  expect(runtimeErrors).toEqual([]);
});

test("Clone refreshes changed source members and routing before requiring a second confirmation", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilState();
  const clonePosts = collectCouncilPosts(page, "clone");
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await surface.getByRole("tab", { name: "Council settings" }).click();
  await surface.getByText("More council actions").click();
  await surface.getByRole("button", { name: "Clone council" }).click();
  const dialog = page.getByRole("dialog", { name: "Review council clone" });
  await expect(dialog).toContainText("3 current members");
  await expect(dialog).toContainText("Parallel review");
  await dialog.getByLabel("Clone name").fill("Reviewed Source Copy");
  await dialog.getByLabel("Clone description").fill("Keep this draft after refresh");
  await dialog.getByLabel("Pin cloned council").check();

  state.aiCouncils = state.aiCouncils.map((item) => isRecord(item) && item.id === "council_builtin_development"
    ? {
        ...item,
        routingPolicy: { ...(isRecord(item.routingPolicy) ? item.routingPolicy : {}), defaultMode: "handoff" },
      }
    : item);
  const sourceMembers = state.aiCouncilMembers.filter((item) => isRecord(item) && item.councilId === "council_builtin_development");
  state.aiCouncilMembers = [
    ...state.aiCouncilMembers.filter((item) => !isRecord(item) || item.councilId !== "council_builtin_development"),
    ...sourceMembers.slice(0, 2),
  ];

  await dialog.getByRole("button", { name: "Clone council" }).click();
  await expect.poll(() => clonePosts.length).toBe(0);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("2 current members");
  await expect(dialog).toContainText("Handoff");
  await expect(dialog.getByLabel("Clone name")).toHaveValue("Reviewed Source Copy");
  await expect(dialog.getByLabel("Clone description")).toHaveValue("Keep this draft after refresh");
  await expect(dialog.getByLabel("Pin cloned council")).toBeChecked();

  await dialog.getByRole("button", { name: "Clone council" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => clonePosts.length).toBe(1);
  const clone = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Reviewed Source Copy");
  expect(isRecord(clone) && isRecord(clone.routingPolicy) ? clone.routingPolicy.defaultMode : undefined).toBe("handoff");
  const cloneId = isRecord(clone) ? String(clone.id) : "";
  expect(state.aiCouncilMembers.filter((item) => isRecord(item) && item.councilId === cloneId)).toHaveLength(2);
  expect(runtimeErrors).toEqual([]);
});

test("A successful POST never fabricates a stale list projection and repair selects the real council", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await surface.getByRole("button", { name: "Create council" }).click();
  const dialog = page.getByRole("dialog", { name: "Create council" });
  await dialog.getByLabel("New council name").fill("Persisted Not Projected");
  await dialog.getByRole("checkbox", { name: "Ling Engineer" }).check();
  state.failNextAiCouncilList = {
    error: "council_list_unavailable",
    message: "Synthetic council list refresh failure",
  };
  state.failNextAiCouncilGet = {
    error: "council_get_unavailable",
    message: "Synthetic council detail refresh failure",
  };
  await dialog.getByRole("button", { name: "Create council" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(surface.locator(".council-workspace-list")).not.toContainText("Persisted Not Projected");
  const stale = surface.getByRole("status").filter({ hasText: "Council list is stale" });
  await expect(stale).toContainText("The council was saved, but this list could not be refreshed.");
  await stale.getByRole("button", { name: "Repair council list" }).click();
  await expect(stale).toHaveCount(0);
  await expect(surface.locator(".council-workspace-list")).toContainText("Persisted Not Projected");
  await expect(surface.getByLabel("Selected council")).toContainText("Persisted Not Projected");
  expect(runtimeErrors).toEqual([]);
});

test("Clone review is contained in dark Chinese and Escape restores focus", async ({ page }) => {
  await prepareSurface(page, "zh-CN", "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilState();
  state.aiTeammates.push(createMockTeammate({
    id: "teammate_long_name",
    roleKey: "custom",
    displayName: "负责超长跨团队发布验证与风险复核的 AI 队友",
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page, /智囊团工作区|Council Workspace/);
  await surface.getByRole("tab", { name: /智囊团设置|Council settings/ }).click();
  await surface.getByText(/更多智囊团操作|More council actions/).click();
  const trigger = surface.getByRole("button", { name: /克隆智囊团|Clone council/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /审阅智囊团克隆|Review council clone/ });
  await expect(dialog).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-zh-clone-review.png");
  await expectNoOverflow(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

function createCouncilState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_engineer", displayName: "Ling Engineer", roleKey: "engineer" }),
    createMockTeammate({ id: "teammate_designer", displayName: "Ling Designer", roleKey: "designer" }),
    createMockTeammate({ id: "teammate_qa", displayName: "Ling QA", roleKey: "qa" }),
    createMockTeammate({ id: "teammate_hidden", displayName: "Hidden Teammate", hidden: true }),
    createMockTeammate({ id: "teammate_disabled", displayName: "Disabled Teammate", status: "disabled" }),
    createMockTeammate({ id: "teammate_paused", displayName: "Paused Teammate", status: "paused" }),
    createMockTeammate({
      id: "ling_agent",
      displayName: "Ling Agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
    }),
  ];
  return state;
}

async function prepareSurface(
  page: Page,
  locale: "en-US" | "zh-CN",
  theme: "light" | "dark",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(({ selectedLocale, selectedTheme }) => {
    const themeId = selectedTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", selectedLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", selectedTheme);
  }, { selectedLocale: locale, selectedTheme: theme });
}

async function openCouncilWorkspace(page: Page, label: string | RegExp = "Council Workspace"): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation|Ling Stack 导航/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: label }).click();
  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".council-workspace-list")).toContainText(/Development Council|开发智囊团/);
  return surface;
}

function collectCouncilPosts(page: Page, kind: "create" | "clone"): Record<string, unknown>[] {
  const posts: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    const matches = kind === "create" ? path === "/ai-councils" : /\/ai-councils\/[^/]+\/clone$/u.test(path);
    if (matches) posts.push(request.postDataJSON() as Record<string, unknown>);
  });
  return posts;
}

function collectCouncilDetailGets(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const path = new URL(request.url()).pathname;
    if (/^\/ai-councils\/[^/]+$/u.test(path)) paths.push(path);
  });
  return paths;
}

async function expectNoOverflow(page: Page, dialog: Locator): Promise<void> {
  const pageMetrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(pageMetrics.scrollWidth).toBeLessThanOrEqual(pageMetrics.clientWidth + 1);
  expect(pageMetrics.scrollHeight).toBeLessThanOrEqual(pageMetrics.clientHeight + 1);
  const dialogMetrics = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
  }));
  expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(dialogMetrics.clientWidth + 1);
  expect(dialogMetrics.top).toBeGreaterThanOrEqual(0);
  expect(dialogMetrics.bottom).toBeLessThanOrEqual(dialogMetrics.viewportHeight);
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

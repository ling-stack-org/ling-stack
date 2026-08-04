import { expect, test, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
} from "./support/mock-state";
import { TeammateAsyncRequestStore } from "../src/features/teammates/useTeammateAsyncRequestOwner.js";

const avatarFixturePath = fileURLToPath(new URL("../public/avatars/teammates/engineer.png", import.meta.url));

test("action generations stay independent while the latest request owns shared resources", () => {
  const store = new TeammateAsyncRequestStore<"attachment-upload" | "workspace" | "runtime", "conversation">(
    "workspace:/tmp/ling:teammate_engineer",
    "teammate_engineer",
  );
  const workspace = store.beginFor(
    "workspace:/tmp/ling:teammate_engineer",
    "teammate_engineer",
    "workspace",
    ["conversation"],
  );
  const runtime = store.beginFor(
    "workspace:/tmp/ling:teammate_engineer",
    "teammate_engineer",
    "runtime",
    ["conversation"],
  );

  expect(store.isActionCurrent(workspace)).toBe(true);
  expect(store.isActionCurrent(runtime)).toBe(true);
  expect(store.ownsResource(workspace, "conversation")).toBe(false);
  expect(store.ownsResource(runtime, "conversation")).toBe(true);

  const upload = store.beginFor(
    "workspace:/tmp/ling:teammate_engineer",
    "teammate_engineer",
    "attachment-upload",
  );
  expect(store.claimAndCommit(upload, ["conversation"], () => undefined)).toBe(true);
  expect(store.ownsResource(runtime, "conversation")).toBe(false);
  expect(store.ownsResource(upload, "conversation")).toBe(true);
});

test("action errors persist across unrelated starts and successes", () => {
  const identity = "workspace:/tmp/ling:teammate_engineer";
  const store = new TeammateAsyncRequestStore<"avatar" | "persona" | "profile", never>(
    identity,
    "teammate_engineer",
  );
  const profile = store.beginFor(identity, "teammate_engineer", "profile");
  expect(store.reportError(profile, "Profile save failed")).toBe(true);

  const avatar = store.beginFor(identity, "teammate_engineer", "avatar");
  expect(store.clearError(avatar)).toBe(false);
  expect(store.latestError()?.message).toBe("Profile save failed");

  const persona = store.beginFor(identity, "teammate_engineer", "persona");
  expect(store.reportError(persona, "Persona preview failed")).toBe(true);
  expect(store.latestError()?.message).toBe("Persona preview failed");
  expect(store.clearError(persona)).toBe(true);
  expect(store.latestError()?.message).toBe("Profile save failed");
});

test("identity revisions reject old action and finally ownership after switching away and back", () => {
  const engineerIdentity = "workspace:/tmp/ling:teammate_engineer";
  const designerIdentity = "workspace:/tmp/ling:teammate_designer";
  const store = new TeammateAsyncRequestStore<"refresh", "conversation">(
    engineerIdentity,
    "teammate_engineer",
  );
  const oldEngineer = store.beginFor(engineerIdentity, "teammate_engineer", "refresh", ["conversation"]);
  store.setIdentity(designerIdentity, "teammate_designer");
  const designer = store.beginFor(designerIdentity, "teammate_designer", "refresh", ["conversation"]);
  store.setIdentity(engineerIdentity, "teammate_engineer");
  const newEngineer = store.beginFor(engineerIdentity, "teammate_engineer", "refresh", ["conversation"]);

  expect(store.isActionCurrent(oldEngineer)).toBe(false);
  expect(store.isActionCurrent(designer)).toBe(false);
  expect(store.isActionCurrent(newEngineer)).toBe(true);
});

test("late teammate workspace success cannot replace the selected teammate or clear its loading state", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  state.teammateDirectMessages = [
    directMessage("teammate_engineer", "Late Engineer response"),
    directMessage("teammate_designer", "Designer remains authoritative"),
  ];
  await mockDaemon(page, state);

  const engineerStarted = deferred<void>();
  const releaseEngineer = deferred<void>();
  const designerStarted = deferred<void>();
  const releaseDesigner = deferred<void>();
  await page.route(/\/teammates\/(teammate_engineer|teammate_designer)\/direct-messages(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (route.request().url().includes("/teammate_engineer/")) {
      engineerStarted.resolve();
      await releaseEngineer.promise;
    } else {
      designerStarted.resolve();
      await releaseDesigner.promise;
    }
    await route.fallback();
  });

  await page.goto("/");
  await openTeammate(page, "Ling Engineer", false);
  await engineerStarted.promise;

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Designer" }).click();
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();
  await designerStarted.promise;

  const engineerResponse = page.waitForResponse((response) => response.ok() && response.url().includes("/teammate_engineer/direct-messages"));
  releaseEngineer.resolve();
  await engineerResponse;
  await expect(page.getByText("Loading teammate workspace...", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Late Engineer response", { exact: true })).toHaveCount(0);

  const designerResponse = page.waitForResponse((response) => response.ok() && response.url().includes("/teammate_designer/direct-messages"));
  releaseDesigner.resolve();
  await designerResponse;
  await expect(page.getByText("Loading teammate workspace...", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Designer remains authoritative", { exact: true })).toBeVisible();
  await expect(page.getByText("Late Engineer response", { exact: true })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("late teammate guidance finally cannot clear the selected teammate guidance busy state", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  state.teammateDirectMessages = [
    directMessage("teammate_engineer", "Engineer active reply"),
    directMessage("teammate_designer", "Designer active reply"),
  ];
  state.workUnits = [
    activeReplyWorkUnit("teammate_engineer"),
    activeReplyWorkUnit("teammate_designer"),
  ];
  await mockDaemon(page, state);

  const engineerStarted = deferred<void>();
  const releaseEngineer = deferred<void>();
  const designerStarted = deferred<void>();
  const releaseDesigner = deferred<void>();
  await page.route(/\/teammate-direct-replies\/(wu_teammate_engineer|wu_teammate_designer)\/cancel(?:\?.*)?$/u, async (route) => {
    if (route.request().url().includes("wu_teammate_engineer")) {
      engineerStarted.resolve();
      await releaseEngineer.promise;
    } else {
      designerStarted.resolve();
      await releaseDesigner.promise;
    }
    await route.fallback();
  });

  await page.goto("/");
  await openTeammate(page, "Ling Engineer");
  const engineerStop = page.getByLabel("Private chat composer").getByRole("button", { name: "Stop reply" });
  await engineerStop.click();
  await engineerStarted.promise;

  await openTeammate(page, "Ling Designer");
  const designerStop = page.getByLabel("Private chat composer").getByRole("button", { name: "Stop reply" });
  await designerStop.click();
  await designerStarted.promise;
  await expect(designerStop).toHaveAttribute("aria-busy", "true");

  const engineerResponse = page.waitForResponse((response) => response.ok() && response.url().includes("wu_teammate_engineer/cancel"));
  releaseEngineer.resolve();
  await engineerResponse;
  await expect(designerStop).toHaveAttribute("aria-busy", "true");

  const designerResponse = page.waitForResponse((response) => response.ok() && response.url().includes("wu_teammate_designer/cancel"));
  releaseDesigner.resolve();
  await designerResponse;
  const designerComposer = page.getByLabel("Private chat composer");
  await expect(designerStop).toHaveCount(0);
  const send = designerComposer.getByRole("button", { name: "Send" });
  await expect(send).not.toHaveAttribute("aria-busy", "true");
  await designerComposer.getByRole("textbox").fill("Ready for the next message");
  await expect(send).toBeEnabled();
  expect(runtimeErrors).toEqual([]);
});

test("header refresh loading follows identity and rejects the previous teammate finally", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  await mockDaemon(page, state);

  await page.goto("/");
  await openTeammate(page, "Ling Engineer");
  const engineerStarted = deferred<void>();
  const releaseEngineer = deferred<void>();
  await page.route(/\/teammates\/teammate_engineer\/direct-messages(?:\?.*)?$/u, async (route) => {
    engineerStarted.resolve();
    await releaseEngineer.promise;
    await route.fallback();
  }, { times: 1 });
  await triggerFocusRevalidation(page);
  await engineerStarted.promise;

  await openTeammate(page, "Ling Designer");
  await expect(page.getByLabel("Private chat actions").getByRole("button", { name: "Refresh" })).toHaveCount(0);
  const designerStarted = deferred<void>();
  const releaseDesigner = deferred<void>();
  await page.route(/\/teammates\/teammate_designer\/direct-messages(?:\?.*)?$/u, async (route) => {
    designerStarted.resolve();
    await releaseDesigner.promise;
    await route.fallback();
  }, { times: 1 });
  await triggerFocusRevalidation(page);
  await designerStarted.promise;

  const engineerResponse = page.waitForResponse((response) => response.ok() && response.url().includes("teammate_engineer/direct-messages"));
  releaseEngineer.resolve();
  await engineerResponse;
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();

  const designerResponse = page.waitForResponse((response) => response.ok() && response.url().includes("teammate_designer/direct-messages"));
  releaseDesigner.resolve();
  await designerResponse;
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("avatar profile and persona requests settle independently", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  await mockDaemon(page, state);

  const profileStarted = deferred<void>();
  const releaseProfile = deferred<void>();
  const personaStarted = deferred<void>();
  const releasePersona = deferred<void>();
  const avatarStarted = deferred<void>();
  const releaseAvatar = deferred<void>();
  await page.route(/\/teammates\/teammate_engineer(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    profileStarted.resolve();
    await releaseProfile.promise;
    await route.fallback();
  });
  await page.route(/\/teammates\/teammate_engineer\/persona-draft(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    personaStarted.resolve();
    await releasePersona.promise;
    await route.fallback();
  });
  await page.route(/\/teammates\/teammate_engineer\/avatar(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    avatarStarted.resolve();
    await releaseAvatar.promise;
    await route.fallback();
  });

  await page.goto("/");
  const profile = await openProfile(page, "Ling Engineer");
  await profile.getByLabel("Description").fill("Concurrent profile update");
  const save = page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" });
  await save.click();
  await profileStarted.promise;

  await profile.getByText("Advanced profile", { exact: true }).click();
  await profile.getByRole("button", { name: "Import role profile" }).click();
  const persona = page.getByRole("dialog", { name: "Import role profile" });
  await persona.getByRole("radio", { name: "Paste content" }).click();
  await persona.getByLabel("Role profile content").fill("# Concurrent persona\nKeep every async owner independent.");
  const preview = persona.getByRole("button", { name: "Check content" });
  await preview.click();
  await personaStarted.promise;

  await profile.getByLabel("Upload avatar").setInputFiles(avatarFixturePath);
  const cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  const useAvatar = cropDialog.getByRole("button", { name: "Use avatar" });
  await useAvatar.click();
  await avatarStarted.promise;

  const profileResponse = page.waitForResponse((response) => response.ok() && response.request().method() === "PATCH" && new URL(response.url()).pathname === "/teammates/teammate_engineer");
  releaseProfile.resolve();
  await profileResponse;

  const personaResponse = page.waitForResponse((response) => response.ok() && response.url().includes("/teammate_engineer/persona-draft"));
  releasePersona.resolve();
  await personaResponse;

  const avatarResponse = page.waitForResponse((response) => response.ok() && response.url().includes("/teammate_engineer/avatar"));
  releaseAvatar.resolve();
  await avatarResponse;
  await expect(cropDialog).toHaveCount(0);
  await expect(preview).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Teammate profile saved", { exact: true })).toBeVisible();
  await expect(persona.getByLabel("Role profile preview")).toBeVisible();
  await expect(page.getByText("Avatar updated", { exact: true })).toBeVisible();
  await persona.getByRole("button", { name: "Cancel" }).click();
  await expect(save).not.toHaveAttribute("aria-busy", "true");
  await expect(profile.getByRole("button", { name: "Avatar options" })).not.toHaveAttribute("aria-busy", "true");
  expect(runtimeErrors).toEqual([]);
});

test("profile responses from the previous teammate are discarded after identity change", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  await mockDaemon(page, state);

  const profileStarted = deferred<void>();
  const releaseProfile = deferred<void>();
  await page.route(/\/teammates\/teammate_engineer(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    profileStarted.resolve();
    await releaseProfile.promise;
    await route.fallback();
  });

  await page.goto("/");
  const engineerProfile = await openProfile(page, "Ling Engineer");
  await engineerProfile.getByLabel("Description").fill("Late profile update");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" }).click();
  await profileStarted.promise;

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Designer" }).click();
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();
  const profileResponse = page.waitForResponse((response) => response.ok() && response.request().method() === "PATCH" && new URL(response.url()).pathname === "/teammates/teammate_engineer");
  releaseProfile.resolve();
  await profileResponse;

  await expect(page.getByText("Teammate profile saved", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();
  await expect(page.getByText("Late profile update", { exact: true })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

function createTeammateState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ready",
    displayName: "Local Relay",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_engineer",
      displayName: "Ling Engineer",
      providerPresetId: "provider_ready",
      pinned: false,
    }),
    createMockTeammate({
      id: "teammate_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      providerPresetId: "provider_ready",
      pinned: false,
    }),
  ];
  return state;
}

function directMessage(teammateId: string, body: string): Record<string, unknown> {
  const timestamp = teammateId === "teammate_engineer"
    ? "2026-07-27T09:00:00.000Z"
    : "2026-07-27T09:01:00.000Z";
  return {
    id: `message_${teammateId}`,
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function activeReplyWorkUnit(
  teammateId: string,
): ReturnType<typeof createBaseState>["workUnits"][number] {
  return {
    id: `wu_${teammateId}`,
    workspaceId: "workspace_default",
    kind: "teammate_direct_reply",
    ownerType: "teammate",
    ownerId: teammateId,
    teammateId,
    idempotencyKey: `active-reply:${teammateId}`,
    status: "running",
    priority: 50,
    attemptCount: 1,
    activeAttemptId: `wua_${teammateId}`,
    createdByActor: "user",
    request: { sourceMessageId: `message_${teammateId}` },
    timeoutPolicy: { staleAfterMs: 120_000, timeoutAfterMs: 300_000 },
    linkedMessageId: `message_${teammateId}`,
    createdAt: "2026-07-27T09:00:00.000Z",
    updatedAt: "2026-07-27T09:00:00.000Z",
    startedAt: "2026-07-27T09:00:00.000Z",
  };
}

async function openTeammate(page: Page, name: string, waitForLoad = true): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  if (waitForLoad) {
    await expect(page.getByText("Loading teammate workspace...", { exact: true })).toHaveCount(0);
  }
}

async function openProfile(page: Page, teammateName: string): Promise<Locator> {
  await openTeammate(page, teammateName);
  const header = page.locator("[data-ui2-teammate-chat-header]");
  if (await page.getByLabel("Private chat workspace dock").count() === 0) {
    await header.getByRole("button", { name: "Show details" }).click();
  }
  await page.getByLabel("Private chat workspace dock").getByRole("button", { name: "Settings" }).click();
  const profile = page.getByLabel("Teammate profile");
  await expect(profile).toBeVisible();
  return profile;
}

async function prepareSurface(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    const selection = { mode: "fixed", themeId: "ling-light" };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", "light");
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve: (value?: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createConversationDraftIdentity } from "../src/domains/conversations/conversation-surface-identity";
import { ConversationStreamBusyStore } from "../src/domains/conversations/use-conversation-stream-busy-owner";
import { buildSurfaceTimelineSnapshot } from "../src/domains/conversations/timeline-snapshot";
import {
  createNormalConversationIdentityCommitGuard,
  normalConversationIdentityOwnerKey,
  type NormalConversationIdentitySnapshot,
} from "../src/features/workspace/useNormalConversationIdentityController";
import { NormalConversationOperationStore } from "../src/features/workspace/useNormalConversationOperationOwner";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import { createBaseState, createChatProvider, cwd, type MockState } from "./support/mock-state";

const appShellSourcePath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const conversationHomeSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/ConversationHome.tsx",
  import.meta.url,
));
const conversationDomainSourcePath = fileURLToPath(new URL(
  "../src/domains/conversations/use-conversation-domain.ts",
  import.meta.url,
));
const streamPattern = /\/conversations\/stream(?:\?.*)?$/u;
const attachmentPattern = /\/conversations\/attachments(?:\?.*)?$/u;
const persistedThread = {
  id: "thread_conversation_identity_owner",
  title: "Persistent conversation owner",
} as const;

test("T13-P.9EF.C draft generations bind only their own ready thread without remounting", async () => {
  const [appShellSource, conversationHomeSource, domainSource] = await Promise.all([
    readFile(appShellSourcePath, "utf8"),
    readFile(conversationHomeSourcePath, "utf8"),
    readFile(conversationDomainSourcePath, "utf8"),
  ]);
  expect(createConversationDraftIdentity(4)).toBe("draft:4");
  expect(domainSource).toContain("conversationDraftGenerationRef.current + 1");
  expect(domainSource).not.toContain('identity: originThreadId || "draft"');
  expect(appShellSource).toContain("conversationIdentity={conversationIdentity}");
  expect(appShellSource).not.toMatch(/<ConversationHome[^>]*\bkey=/su);

  let current = identitySnapshot("draft:1");
  const guard = createNormalConversationIdentityCommitGuard({
    origin: current,
    isMounted: () => true,
    readCurrent: () => current,
  });
  expect(guard()).toBe(true);
  expect(guard("thread_from_first_draft")).toBe(true);
  current = identitySnapshot("thread_from_first_draft");
  expect(guard()).toBe(true);
  current = identitySnapshot("draft:2");
  expect(guard()).toBe(false);
});

test("T13-P.9EF.C workspace and thread transitions rotate the complete conversation owner", async () => {
  const [conversationHomeSource, domainSource] = await Promise.all([
    readFile(conversationHomeSourcePath, "utf8"),
    readFile(conversationDomainSourcePath, "utf8"),
  ]);
  const draftA = identitySnapshot("draft:3", { workspaceCwd: "/tmp/workspace-a" });
  const draftB = identitySnapshot("draft:3", { workspaceCwd: "/tmp/workspace-b" });
  const loadingThread = identitySnapshot("thread_transition", { threadId: undefined });
  const readyThread = identitySnapshot("thread_transition", { threadId: "thread_transition" });

  expect(normalConversationIdentityOwnerKey(draftA)).not.toBe(normalConversationIdentityOwnerKey(draftB));
  expect(normalConversationIdentityOwnerKey(loadingThread)).not.toBe(normalConversationIdentityOwnerKey(readyThread));
  expect(domainSource).toContain("conversationOwnerCwdRef.current === workspaceCwd");
  expect(domainSource).toContain("commitConversationSurfaceIdentity(createConversationDraftIdentity(draftGeneration))");
  expect(conversationHomeSource).toContain("[conversationIdentityController.ownerKey, initialDraft]");
  expect(conversationHomeSource).toContain("[conversationIdentityController.ownerKey, initialMessages]");
  expect(conversationHomeSource).toContain("[conversationIdentityController.ownerKey, initialProjectLabel, initialProjectPath]");
  expect(conversationHomeSource).toContain("[conversationIdentityController.ownerKey, initialProviderPresetId, initialReasoningSummary, initialThinkingLevel]");
  expect(conversationHomeSource).toContain("[conversationIdentityController.ownerKey, initialAuthorizationMode, initialPermissionMode, initialPermissionPreset, initialWorkspaceAccessMode]");
});

test("T13-P.9EF.C stream and retry loading finish only their own owner token", () => {
  const busy = new ConversationStreamBusyStore();
  const oldDraft = busy.begin({ workspaceCwd: "/tmp/workspace-a", identity: "draft:1" });
  expect(busy.isBusy({ workspaceCwd: "/tmp/workspace-a", identity: "draft:1" })).toBe(true);
  expect(busy.isBusy({ workspaceCwd: "/tmp/workspace-a", identity: "draft:2" })).toBe(false);
  expect(busy.isBusy({ workspaceCwd: "/tmp/workspace-b", identity: "draft:1" })).toBe(false);
  busy.bind(oldDraft, "thread_bound_from_draft");
  expect(busy.isBusy({ workspaceCwd: "/tmp/workspace-a", identity: "thread_bound_from_draft" })).toBe(true);

  const nextDraft = busy.begin({ workspaceCwd: "/tmp/workspace-a", identity: "draft:2" });
  busy.finish(oldDraft);
  expect(busy.isBusy({ workspaceCwd: "/tmp/workspace-a", identity: "draft:2" })).toBe(true);
  busy.finish(nextDraft);
  expect(busy.isBusy({ workspaceCwd: "/tmp/workspace-a", identity: "draft:2" })).toBe(false);

  const retries = new NormalConversationOperationStore<string>();
  const oldRetry = retries.begin("owner-a", "message-a");
  const nextRetry = retries.begin("owner-b", "message-b");
  retries.finish(oldRetry);
  expect(retries.current("owner-b")).toEqual(nextRetry);
  retries.finish(nextRetry);
  expect(retries.current("owner-b")).toBeUndefined();
});

test("T13-P.9EF.C an optimistic message renders without exposing unscoped execution evidence", () => {
  const message = {
    id: "message:user:pending",
    kind: "userMessage",
    markdown: "Pending message",
    phase: "commentary",
    revision: 1,
    threadSequence: 0,
    partIndex: 0,
    status: "pending",
    sourceRefs: [],
  } as const;
  const optimistic = buildSurfaceTimelineSnapshot({
    surface: "normal_conversation",
    items: [message],
  });
  expect(optimistic.items).toEqual([message]);

  const unscopedEvidence = buildSurfaceTimelineSnapshot({
    surface: "normal_conversation",
    items: [{ ...message, id: "unscoped-plan", kind: "plan" } as never],
  });
  expect(unscopedEvidence.items).toHaveLength(1);
  expect(unscopedEvidence.items[0]?.kind).toBe("diagnostic");
  expect(unscopedEvidence.items[0]?.id).toContain("diagnostic:scope:");
});

test("T13-P.9EF.C a late draft success cannot populate the next new conversation", async ({ page }) => {
  await prepareSurface(page);
  const state = createConversationIdentityState();
  await mockDaemon(page, state);
  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  await page.route(streamPattern, async (route) => {
    requestStarted.resolve();
    await releaseRequest.promise;
    await route.fallback();
  }, { times: 1 });

  await page.goto("/");
  const navigation = sidebar(page);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const firstComposer = page.getByLabel("New conversation composer");
  await firstComposer.getByRole("textbox", { name: "Conversation message" }).fill("Old draft must stay isolated");
  await firstComposer.getByRole("button", { name: "Send" }).click();
  await requestStarted.promise;

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const nextComposer = page.getByLabel("New conversation composer");
  const nextInput = nextComposer.getByRole("textbox", { name: "Conversation message" });
  await expect(nextInput).toHaveAttribute("data-value", "");
  await expect(page.getByText("Old draft must stay isolated", { exact: true })).toHaveCount(0);

  releaseRequest.resolve();
  await expect.poll(() => state.threads.some((thread) => thread.objective === "Old draft must stay isolated")).toBe(true);
  await expect(nextInput).toHaveAttribute("data-value", "");
  await expect(nextComposer.getByText("Old draft must stay isolated", { exact: true })).toHaveCount(0);

  await nextInput.fill("Current draft binds safely");
  await nextComposer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Conversation messages", { exact: true })).toContainText("Ling Agent response: Current draft binds safely");
});

test("T13-P.9EF.C a late draft failure cannot replace an existing thread owner", async ({ page }) => {
  await prepareSurface(page);
  const state = createConversationIdentityState();
  installPersistedThread(state);
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = sidebar(page);
  await conversationRow(navigation, persistedThread.title).click();
  await expect(page.getByRole("heading", { name: persistedThread.title, level: 1 })).toBeVisible();

  const ownerFailure = "The persisted thread keeps its refresh failure.";
  await page.route(conversationDetailPattern(persistedThread.id), async (route) => {
    await route.fulfill({ status: 503, json: { error: "persisted_refresh_failed", message: ownerFailure } });
  }, { times: 1 });
  await triggerFocusRevalidation(page);
  await expect(page.getByLabel("Conversation page").getByRole("alert")).toContainText(ownerFailure);

  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  const staleFailure = "The abandoned draft failed late.";
  await page.route(streamPattern, async (route) => {
    requestStarted.resolve();
    await releaseRequest.promise;
    await route.fulfill({ status: 503, json: { error: "abandoned_draft_failed", message: staleFailure } });
  }, { times: 1 });

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const draftComposer = page.getByLabel("New conversation composer");
  await draftComposer.getByRole("textbox", { name: "Conversation message" }).fill("Fail this abandoned draft");
  await draftComposer.getByRole("button", { name: "Send" }).click();
  await requestStarted.promise;
  await navigation.getByRole("button", { name: "New conversation" }).click();
  await conversationRow(navigation, persistedThread.title).click();
  await expect(page.getByRole("heading", { name: persistedThread.title, level: 1 })).toBeVisible();

  releaseRequest.resolve();
  const persistedPage = page.getByLabel("Conversation page");
  await expect(persistedPage.getByRole("alert")).toContainText(ownerFailure);
  await expect(persistedPage.getByText(staleFailure, { exact: true })).toHaveCount(0);
  await expect(persistedPage.getByLabel("Conversation messages", { exact: true })).not.toContainText(staleFailure);
});

test("T13-P.9EF.C a late attachment success releases its preview and cannot enter the next composer", async ({ page }) => {
  await prepareSurface(page, true);
  const state = createConversationIdentityState();
  await mockDaemon(page, state);
  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  await page.route(attachmentPattern, async (route) => {
    requestStarted.resolve();
    await releaseRequest.promise;
    await route.fallback();
  }, { times: 1 });

  await page.goto("/");
  const navigation = sidebar(page);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const firstComposer = page.getByLabel("New conversation composer");
  await firstComposer.locator('input[type="file"]').setInputFiles({
    name: "old-draft-preview.png",
    mimeType: "image/png",
    buffer: onePixelPng(),
  });
  await requestStarted.promise;
  await expect(firstComposer.getByLabel("Pending message assets")).toContainText("old-draft-preview.png");

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const nextComposer = page.getByLabel("New conversation composer");
  await expect(nextComposer.getByLabel("Pending message assets")).toHaveCount(0);
  await expect.poll(() => revokedPreviewCount(page)).toBe(1);

  releaseRequest.resolve();
  await expect.poll(() => state.conversationAttachments.length).toBe(0);
  await expect(nextComposer.getByLabel("Pending message assets")).toHaveCount(0);
  await expect(nextComposer).not.toContainText("old-draft-preview.png");
});

test("T13-P.9EF.C a late attachment failure stays with its abandoned draft", async ({ page }) => {
  await prepareSurface(page, true);
  const state = createConversationIdentityState();
  await mockDaemon(page, state);
  const requestStarted = createDeferred();
  const releaseRequest = createDeferred();
  const staleFailure = "Old attachment upload failed late.";
  await page.route(attachmentPattern, async (route) => {
    requestStarted.resolve();
    await releaseRequest.promise;
    await route.fulfill({ status: 503, json: { error: "old_attachment_failed", message: staleFailure } });
  }, { times: 1 });

  await page.goto("/");
  const navigation = sidebar(page);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const firstComposer = page.getByLabel("New conversation composer");
  await firstComposer.locator('input[type="file"]').setInputFiles({
    name: "old-failed-preview.png",
    mimeType: "image/png",
    buffer: onePixelPng(),
  });
  await requestStarted.promise;

  await navigation.getByRole("button", { name: "New conversation" }).click();
  releaseRequest.resolve();
  const nextComposer = page.getByLabel("New conversation composer");
  await expect.poll(() => revokedPreviewCount(page)).toBe(1);
  await expect(nextComposer.getByLabel("Pending message assets")).toHaveCount(0);
  await expect(page.getByText(staleFailure, { exact: true })).toHaveCount(0);
});

test("T13-P.9EF.C selecting a loading thread removes the previous draft's late upload and deletes from its source cwd", async ({ page }) => {
  await prepareSurface(page, true);
  const state = createConversationIdentityState();
  installPersistedThread(state);
  await mockDaemon(page, state);
  const detailStarted = createDeferred();
  const releaseDetail = createDeferred();
  const uploadStarted = createDeferred();
  const releaseUpload = createDeferred();
  const deletionCwds: string[] = [];
  await page.route(conversationDetailPattern(persistedThread.id), async (route) => {
    detailStarted.resolve();
    await releaseDetail.promise;
    await route.fallback();
  }, { times: 1 });
  await page.route(attachmentPattern, async (route) => {
    uploadStarted.resolve();
    await releaseUpload.promise;
    await route.fallback();
  }, { times: 1 });
  await page.route(/\/attachments\/[^/]+(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "DELETE") {
      deletionCwds.push(new URL(route.request().url()).searchParams.get("cwd") ?? "");
    }
    await route.fallback();
  });

  await page.goto("/");
  const navigation = sidebar(page);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const composer = page.getByLabel("New conversation composer");
  await expect(composer.locator('input[type="file"]')).toBeEnabled();
  await composer.locator('input[type="file"]').setInputFiles({
    name: "thread-transition.png",
    mimeType: "image/png",
    buffer: onePixelPng(),
  });
  await uploadStarted.promise;
  await expect(composer.getByLabel("Pending message assets")).toContainText("thread-transition.png");

  await conversationRow(navigation, persistedThread.title).click();
  await detailStarted.promise;
  await expect(composer.locator('input[type="file"]')).toBeDisabled();
  await expect(composer.getByLabel("Pending message assets")).toHaveCount(0);

  releaseDetail.resolve();
  await expect(page.getByRole("heading", { name: persistedThread.title, level: 1 })).toBeVisible();
  await expect(page.getByLabel("New conversation composer").getByLabel("Pending message assets")).toHaveCount(0);
  releaseUpload.resolve();
  await expect.poll(() => state.conversationAttachments.length).toBe(0);
  await expect.poll(() => deletionCwds).toContain(cwd);
  await expect.poll(() => revokedPreviewCount(page)).toBe(1);
});

test("T13-P.9EF.C unmount deletes a ready unsent attachment", async ({ page }) => {
  await prepareSurface(page, true);
  const state = createConversationIdentityState();
  await mockDaemon(page, state);
  await page.goto("/");
  const navigation = sidebar(page);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const composer = page.getByLabel("New conversation composer");
  await composer.locator('input[type="file"]').setInputFiles({
    name: "ready-before-unmount.png",
    mimeType: "image/png",
    buffer: onePixelPng(),
  });
  await expect.poll(() => state.conversationAttachments.length).toBe(1);
  await expect(composer.getByLabel("Pending message assets")).toContainText("ready-before-unmount.png");

  await navigation.getByRole("button").filter({ hasText: "Engineering" }).first().click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect.poll(() => state.conversationAttachments.length).toBe(0);
  await expect.poll(() => revokedPreviewCount(page)).toBe(1);
});

test("T13-P.9EF.C abandoned send cleans attachments and does not keep the next draft busy", async ({ page }) => {
  await prepareSurface(page, true);
  const state = createConversationIdentityState();
  await mockDaemon(page, state);
  const streamStarted = createDeferred();
  const releaseStream = createDeferred();
  await page.route(streamPattern, async (route) => {
    streamStarted.resolve();
    await releaseStream.promise;
    await route.fulfill({ status: 503, json: { error: "abandoned_send", message: "Old send failed late." } });
  }, { times: 1 });

  await page.goto("/");
  const navigation = sidebar(page);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const oldComposer = page.getByLabel("New conversation composer");
  await oldComposer.locator('input[type="file"]').setInputFiles({
    name: "abandoned-send.png",
    mimeType: "image/png",
    buffer: onePixelPng(),
  });
  await expect.poll(() => state.conversationAttachments.length).toBe(1);
  await oldComposer.getByRole("textbox", { name: "Conversation message" }).fill("Abandon this send");
  await oldComposer.getByRole("button", { name: "Send" }).click();
  await streamStarted.promise;
  await expect(oldComposer.getByRole("button", { name: "Send" }).locator(".ling-ui-spinner")).toHaveCount(1);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const nextComposer = page.getByLabel("New conversation composer");
  const nextInput = nextComposer.getByRole("textbox", { name: "Conversation message" });
  await nextInput.fill("The next draft stays independent");
  await expect(nextComposer.getByRole("button", { name: "Send" })).toBeEnabled();
  releaseStream.resolve();

  await expect.poll(() => state.conversationAttachments.length).toBe(0);
  await expect(nextInput).toHaveAttribute("data-value", "The next draft stays independent");
  await expect(page.getByText("Old send failed late.", { exact: true })).toHaveCount(0);
  await expect.poll(() => revokedPreviewCount(page)).toBe(1);
});

test("T13-P.9EF.C a server-bound late send keeps its attachment after the draft is left", async ({ page }) => {
  await prepareSurface(page, true);
  const state = createConversationIdentityState();
  await mockDaemon(page, state);
  const streamStarted = createDeferred();
  const releaseStream = createDeferred();
  await page.route(streamPattern, async (route) => {
    streamStarted.resolve();
    await releaseStream.promise;
    await route.fallback();
  }, { times: 1 });

  await page.goto("/");
  const navigation = sidebar(page);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const oldComposer = page.getByLabel("New conversation composer");
  await oldComposer.locator('input[type="file"]').setInputFiles({
    name: "bound-late-send.png",
    mimeType: "image/png",
    buffer: onePixelPng(),
  });
  await expect.poll(() => state.conversationAttachments.length).toBe(1);
  await oldComposer.getByRole("textbox", { name: "Conversation message" }).fill("Bind this attachment safely");
  await oldComposer.getByRole("button", { name: "Send" }).click();
  await streamStarted.promise;
  await navigation.getByRole("button", { name: "New conversation" }).click();

  releaseStream.resolve();
  await expect.poll(() => state.conversationAttachments[0]?.threadId).toMatch(/^thread_conversation_/u);
  await expect.poll(() => state.conversationAttachments.length).toBe(1);
  await expect.poll(() => revokedPreviewCount(page)).toBe(1);
  const nextComposer = page.getByLabel("New conversation composer");
  await expect(nextComposer.getByText("Bind this attachment safely", { exact: true })).toHaveCount(0);
  await expect(nextComposer.getByRole("textbox", { name: "Conversation message" })).toHaveAttribute("data-value", "");
});

function identitySnapshot(
  identity: string,
  overrides: Partial<NormalConversationIdentitySnapshot> = {},
): NormalConversationIdentitySnapshot {
  return {
    surface: "normal_conversation",
    workspaceCwd: cwd,
    threadId: identity.startsWith("thread_") ? identity : undefined,
    draftGeneration: identity.startsWith("draft:") ? Number(identity.slice("draft:".length)) : undefined,
    identity,
    ...overrides,
  };
}

function createConversationIdentityState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_conversation_draft_identity",
    displayName: "Draft Identity Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-27T03:00:00.000Z" },
  })];
  return state;
}

function installPersistedThread(state: MockState): void {
  const timestamp = "2026-07-27T03:00:00.000Z";
  state.threads.push({
    id: persistedThread.id,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: persistedThread.title,
    objective: "Keep this real thread owner isolated from drafts.",
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  state.turns.push({
    id: "turn_conversation_identity_owner",
    workspaceId: "workspace_default",
    threadId: persistedThread.id,
    kind: "initial_request",
    status: "succeeded",
    title: persistedThread.title,
    userInstruction: "Keep the persisted conversation owner visible.",
    createdByActor: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  });
}

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "Sidebar display" });
}

function conversationRow(navigation: ReturnType<typeof sidebar>, title: string) {
  return navigation.locator(".sidebar-recent-row").filter({ hasText: title });
}

function conversationDetailPattern(threadId: string): RegExp {
  return new RegExp(`/conversations/${threadId}(?:\\?.*)?$`, "u");
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function onePixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

async function revokedPreviewCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    window as typeof window & { __lingRevokedPreviewUrls?: readonly string[] }
  ).__lingRevokedPreviewUrls?.length ?? 0);
}

async function prepareSurface(page: Page, trackPreviewUrls = false): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(({ trackPreviews }) => {
    const selection = { mode: "fixed", themeId: "ling-light" };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    if (!trackPreviews) return;
    const trackedWindow = window as typeof window & { __lingRevokedPreviewUrls?: string[] };
    trackedWindow.__lingRevokedPreviewUrls = [];
    const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url): void => {
      trackedWindow.__lingRevokedPreviewUrls?.push(url);
      originalRevokeObjectUrl(url);
    };
  }, { trackPreviews: trackPreviewUrls });
}

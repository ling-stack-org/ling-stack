import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  ConversationErrorStore,
  selectConversationError,
} from "../src/domains/conversations/conversation-error-owner";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createChatProvider,
  cwd,
  type MockState,
} from "./support/mock-state";

const appShellSourcePath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const conversationDomainSourcePath = fileURLToPath(new URL(
  "../src/domains/conversations/use-conversation-domain.ts",
  import.meta.url,
));
const conversationHomeSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/ConversationHome.tsx",
  import.meta.url,
));

const alpha = { id: "thread_error_owner_alpha", title: "Error owner Alpha" } as const;
const beta = { id: "thread_error_owner_beta", title: "Error owner Beta" } as const;

test("T13-P.9EF.B Conversation releases the generic AppShell error contract", async () => {
  const [appShellSource, domainSource, conversationHomeSource] = await Promise.all([
    readFile(appShellSourcePath, "utf8"),
    readFile(conversationDomainSourcePath, "utf8"),
    readFile(conversationHomeSourcePath, "utf8"),
  ]);

  expect(domainSource).not.toContain("setErrorMessage");
  expect(readHookCall(appShellSource, "useConversationDomain")).not.toContain("setErrorMessage");
  expect(domainSource).toContain("useConversationErrorOwner");
  expect(domainSource).toContain('surface: "thread"');
  expect(domainSource).toContain('scope: "stream"');
  expect(conversationHomeSource).toContain("shouldCommit");
  expect(conversationHomeSource).toContain("useNormalConversationActionFeedback");
  expect(appShellSource).toContain("errorMessage: message.errorMessage");
});

test("T13-P.9EF.B Conversation owner isolates identity, scope, stale operations, and unrelated success", () => {
  const store = new ConversationErrorStore();
  const alphaRefresh = store.begin({
    workspaceCwd: cwd,
    surface: "thread",
    identity: alpha.id,
    scope: "refresh",
  });
  const betaSelect = store.begin({
    workspaceCwd: cwd,
    surface: "thread",
    identity: beta.id,
    scope: "select",
  });
  expect(store.report(alphaRefresh, "Alpha refresh failed")).toBe(true);
  expect(store.report(betaSelect, "Beta select failed")).toBe(true);
  expect(store.clear(betaSelect)).toBe(true);

  expect(selectConversationError(store.entries(), {
    workspaceCwd: cwd,
    surface: "thread",
    identity: alpha.id,
  })?.message).toBe("Alpha refresh failed");
  expect(selectConversationError(store.entries(), {
    workspaceCwd: cwd,
    surface: "thread",
    identity: beta.id,
  })).toBeUndefined();
  expect(selectConversationError(store.entries(), {
    workspaceCwd: cwd,
    surface: "composer",
    identity: alpha.id,
  })).toBeUndefined();

  const staleAlphaSelect = store.begin({
    workspaceCwd: cwd,
    surface: "thread",
    identity: alpha.id,
    scope: "select",
  });
  const currentAlphaSelect = store.begin({
    workspaceCwd: cwd,
    surface: "thread",
    identity: alpha.id,
    scope: "select",
  });
  expect(store.report(staleAlphaSelect, "Late Alpha response")).toBe(false);
  expect(store.report(currentAlphaSelect, "Current Alpha response")).toBe(true);
  expect(selectConversationError(store.entries(), {
    workspaceCwd: cwd,
    surface: "thread",
    identity: alpha.id,
    scopes: ["select"],
  })?.message).toBe("Current Alpha response");
  expect(selectConversationError(store.entries(), {
    workspaceCwd: cwd,
    surface: "thread",
    identity: alpha.id,
    scopes: ["refresh"],
  })?.message).toBe("Alpha refresh failed");
});

test("T13-P.9EF.B a late select response cannot replace the later selected thread", async ({ page }) => {
  await prepareSurface(page);
  const state = createConversationErrorState();
  await mockDaemon(page, state);

  const alphaRequestStarted = createDeferred<void>();
  const releaseAlpha = createDeferred<void>();
  await page.route(conversationDetailPattern(alpha.id), async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    alphaRequestStarted.resolve();
    await releaseAlpha.promise;
    await route.fallback();
  }, { times: 1 });

  await page.goto("/");
  const navigation = page.getByLabel("Ling Stack navigation");
  await conversationRow(navigation, alpha.title).click();
  await alphaRequestStarted.promise;
  await conversationRow(navigation, beta.title).click();
  await expect(page.getByRole("heading", { name: beta.title, level: 1 })).toBeVisible();

  releaseAlpha.resolve();
  await page.waitForTimeout(150);
  await expect(page.getByRole("heading", { name: beta.title, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: alpha.title, level: 1 })).toHaveCount(0);
});

test("T13-P.9EF.B refresh failure stays with its thread and survives unrelated select success", async ({ page }) => {
  await prepareSurface(page);
  const state = createConversationErrorState();
  await mockDaemon(page, state);
  await page.goto("/");
  const navigation = page.getByLabel("Ling Stack navigation");
  await openConversation(navigation, page, beta);

  const failureMessage = "Beta refresh remains owned by Beta.";
  await page.route(conversationDetailPattern(beta.id), async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "beta_refresh_failed", message: failureMessage },
    });
  }, { times: 1 });
  await triggerFocusRevalidation(page);
  await expect(page.getByLabel("Conversation page").getByRole("alert")).toContainText(failureMessage);

  await navigation.getByRole("button").filter({ hasText: "Engineering" }).first().click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByText(failureMessage, { exact: true })).toHaveCount(0);

  await openConversation(navigation, page, beta);
  await expect(page.getByLabel("Conversation page").getByRole("alert")).toContainText(failureMessage);
});

test("T13-P.9EF.B a late stream failure remains with Alpha and cannot mutate Beta", async ({ page }) => {
  await prepareSurface(page);
  const state = createConversationErrorState();
  await mockDaemon(page, state);
  await page.goto("/");
  const navigation = page.getByLabel("Ling Stack navigation");
  await openConversation(navigation, page, alpha);

  const streamStarted = createDeferred<void>();
  const releaseStream = createDeferred<void>();
  const failureMessage = "Late Alpha stream failure.";
  await page.route(/\/conversations\/stream(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    streamStarted.resolve();
    await releaseStream.promise;
    await route.fulfill({
      status: 503,
      json: { error: "late_alpha_stream_failed", message: failureMessage },
    });
  }, { times: 1 });

  const alphaPage = page.getByLabel("Conversation page");
  await alphaPage.getByRole("textbox", { name: "Conversation message" }).fill("Keep this failure with Alpha");
  await alphaPage.getByRole("button", { name: "Send" }).click();
  await streamStarted.promise;
  await openConversation(navigation, page, beta);

  releaseStream.resolve();
  await page.waitForTimeout(150);
  const betaPage = page.getByLabel("Conversation page");
  await expect(page.getByRole("heading", { name: beta.title, level: 1 })).toBeVisible();
  await expect(betaPage.getByText(failureMessage, { exact: true })).toHaveCount(0);
  await expect(betaPage.getByLabel("Conversation messages", { exact: true })).not.toContainText(failureMessage);

  await openConversation(navigation, page, alpha);
  await expect(page.getByLabel("Conversation page").getByRole("alert")).toContainText(failureMessage);
});

function createConversationErrorState(): MockState {
  const state = createBaseState({ approvalStatus: "pending" });
  const providerId = "provider_conversation_error_owner";
  state.providers = [createChatProvider({
    id: providerId,
    displayName: "Conversation Relay",
    model: "gpt-5.5",
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt: "2026-07-27T00:00:00.000Z",
    },
  })];
  state.workspaceSettings.defaultProviderPresetId = providerId;
  installConversation(state, alpha, providerId, "2026-07-27T01:00:00.000Z");
  installConversation(state, beta, providerId, "2026-07-27T02:00:00.000Z");
  return state;
}

function installConversation(
  state: MockState,
  conversation: { readonly id: string; readonly title: string },
  providerId: string,
  timestamp: string,
): void {
  const turnId = `turn_${conversation.id}`;
  const runId = `run_${conversation.id}`;
  state.threads.push({
    id: conversation.id,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: conversation.title,
    objective: `Keep ${conversation.title} isolated.`,
    status: "succeeded",
    lastRunId: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  state.turns.push({
    id: turnId,
    workspaceId: "workspace_default",
    threadId: conversation.id,
    kind: "initial_request",
    status: "succeeded",
    title: conversation.title,
    userInstruction: `${conversation.title} user message`,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  });
  state.turnRunLinks.push({ turnId, runId, attemptNumber: 1, role: "primary", createdAt: timestamp });
  state.runs.unshift({
    id: runId,
    status: "succeeded",
    cwd,
    taskId: `task_${conversation.id}`,
    providerPresetId: providerId,
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: `task_${conversation.id}`, title: conversation.title },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId: conversation.id,
    turnId,
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp,
  });
  state.eventsByRun[runId] = [{
    id: `event_${runId}`,
    runId,
    seq: 1,
    ts: timestamp,
    type: "assistant_text_delta",
    data: { text: `${conversation.title} assistant message` },
  }];
}

async function openConversation(
  navigation: ReturnType<Page["getByLabel"]>,
  page: Page,
  conversation: { readonly id: string; readonly title: string },
): Promise<void> {
  await conversationRow(navigation, conversation.title).click();
  await expect(page.getByRole("heading", { name: conversation.title, level: 1 })).toBeVisible();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

function conversationRow(navigation: ReturnType<Page["getByLabel"]>, title: string) {
  return navigation.locator(".sidebar-recent-row").filter({ hasText: title });
}

function conversationDetailPattern(threadId: string): RegExp {
  return new RegExp(`/conversations/${threadId}(?:\\?.*)?$`, "u");
}

function readHookCall(source: string, hook: string): string {
  const start = source.indexOf(`${hook}({`);
  if (start < 0) throw new Error(`Missing ${hook} call`);
  const end = source.indexOf("\n  });", start);
  if (end < 0) throw new Error(`Missing ${hook} call boundary`);
  return source.slice(start, end);
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function prepareSurface(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    const selection = { mode: "fixed", themeId: "ling-light" };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  });
}

import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createFocusedDomainErrorOwner,
  type FocusedDomainError,
} from "../src/app/use-focused-domain-error-owner.js";
import {
  createShellErrorFeedbackCoordinator,
  SHELL_ERROR_PERSISTENT_DURATION_MS,
  SHELL_ERROR_TOAST_CAPACITY,
  type ShellErrorFeedbackCommand,
  type ShellErrorFeedbackItem,
  type ShellErrorToastViewportSnapshot,
} from "../src/app/shell-error-feedback-coordinator.js";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const appShellPath = sourcePath("app/AppShell.tsx");
const feedbackGuardPath = fileURLToPath(new URL("../scripts/check-ui2-feedback.mjs", import.meta.url));
const shellFeedbackPath = sourcePath("app/use-shell-error-feedback.ts");
const shellFeedbackCoordinatorPath = sourcePath("app/shell-error-feedback-coordinator.ts");
const releasedOwnerPaths = [
  "app/use-app-navigation-controller.ts",
  "app/use-control-plane-invalidation.ts",
  "app/use-workspace-settings-controller.ts",
  "domains/external-work/use-external-work-domain.ts",
  "domains/runtime/use-runtime-domain.ts",
].map(sourcePath);

test("T13-P.9EF.E releases five shell owners from the generic AppShell error contract", async () => {
  const [appShell, guard, shellFeedback, shellFeedbackCoordinator, ...releasedOwners] = await Promise.all([
    readFile(appShellPath, "utf8"),
    readFile(feedbackGuardPath, "utf8"),
    readFile(shellFeedbackPath, "utf8"),
    readFile(shellFeedbackCoordinatorPath, "utf8"),
    ...releasedOwnerPaths.map((path) => readFile(path, "utf8")),
  ]);

  for (const source of releasedOwners) expect(source).not.toContain("setErrorMessage");
  expect(releasedOwners.join("\n")).not.toContain("latestMutationRef");
  for (const hook of [
    "useAppNavigationController",
    "useControlPlaneInvalidation",
    "useWorkspaceSettingsController",
    "useExternalWorkDomain",
    "useRuntimeDomain",
  ]) {
    expect(readHookCall(appShell, hook)).not.toContain("setErrorMessage");
  }

  expect(appShell).toContain("const controlPlaneInvalidation = useControlPlaneInvalidation({");
  expect(appShell).toContain("error: workspaceSettingsError");
  expect(appShell).toContain("error: navigationRepairError");
  expect(appShell).toContain("const runtimeError = runtimeDomain.error;");
  expect(appShell).toContain("externalWorkError={externalWorkError ? {");
  expect(appShell).toContain("useShellErrorFeedback({ dismissToast, items: shellErrorFeedbackItems, showToast });");
  expect(shellFeedback).toContain("durationMs: SHELL_ERROR_PERSISTENT_DURATION_MS");
  expect(shellFeedback).toContain("markExplicitDismiss(scope)");
  expect(shellFeedback).toContain('addEventListener("toast.swipeEnd"');
  expect(shellFeedback).toContain("observeViewport(");
  expect(shellFeedback).not.toContain("seenRequestsRef");
  expect(shellFeedbackCoordinator).toContain("new WeakSet<FocusedDomainError>()");
  expect(shellFeedbackCoordinator).toContain("new WeakMap<FocusedDomainError, string>()");
  expect(shellFeedbackCoordinator).toContain("originSurfaceByError.set(error, item.surface)");
  expect(shellFeedbackCoordinator).toContain("active?.requestKey === requestKey");
  expect(shellFeedbackCoordinator).toContain("dismissedErrors.has(error)");

  for (const path of [
    "apps/web/src/app/use-app-navigation-controller.ts",
    "apps/web/src/app/use-control-plane-invalidation.ts",
    "apps/web/src/app/use-workspace-settings-controller.ts",
    "apps/web/src/domains/external-work/use-external-work-domain.ts",
    "apps/web/src/domains/runtime/use-runtime-domain.ts",
  ]) {
    expect(guard).toContain(`  "${path}",`);
  }
  expect(appShell).not.toContain("setErrorMessage");
  expect(guard).toContain("const genericErrorWriterBudgets = new Map([\n]);");
  expect(guard).toContain("const genericErrorCompatibilityBudgets = new Map([\n]);");
  expect(guard).toContain("const genericErrorConsumerBudgets = new Map([\n]);");
  expect(appShell).toContain('const [startupStatusError, setStartupStatusError] = useState("");');
  expect(appShell).toContain("const [daemonHealthy, setDaemonHealthy] = useState<boolean | undefined>();");
});

test("T13-P.9EF.E keeps domain and object failures isolated", () => {
  const owner = createFocusedDomainErrorOwner<string, string>("workspace-a");
  const runtimeOne = owner.begin("runtime", "work-unit-1", "retry");
  const runtimeTwo = owner.begin("runtime", "work-unit-2", "cancel");
  const externalWork = owner.begin("external-work", "channel-1", "workflow");

  expect(owner.report(runtimeOne, { scope: "mutation", message: "retry failed" })).toBe(true);
  expect(owner.report(runtimeTwo, { scope: "mutation", message: "cancel failed" })).toBe(true);
  expect(owner.report(externalWork, { scope: "mutation", message: "workflow failed" })).toBe(true);

  expect(owner.errors().map((error) => `${error.domain}:${error.objectId}:${error.action}`)).toEqual([
    "runtime:work-unit-1:retry",
    "runtime:work-unit-2:cancel",
    "external-work:channel-1:workflow",
  ]);
  expect(owner.latest()?.message).toBe("workflow failed");
});

test("T13-P.9EF.E rejects late responses and stale workspace identities", () => {
  const owner = createFocusedDomainErrorOwner<"workspace-settings", string>("workspace-a");
  const oldRequest = owner.begin("workspace-settings", "workspace-a", "patch:theme");
  const currentRequest = owner.begin("workspace-settings", "workspace-a", "patch:theme");

  expect(owner.report(oldRequest, { scope: "mutation", message: "late failure" })).toBe(false);
  expect(owner.report(currentRequest, { scope: "mutation", message: "current failure" })).toBe(true);
  expect(owner.latest()?.message).toBe("current failure");

  owner.setIdentity("workspace-b");
  expect(owner.errors()).toEqual([]);
  expect(owner.report(currentRequest, { scope: "mutation", message: "old workspace failure" })).toBe(false);
  expect(owner.latest()).toBeUndefined();
});

test("T13-P.9EF.E unrelated success cannot clear another owner failure", () => {
  const owner = createFocusedDomainErrorOwner<string, string>("workspace-a");
  const failedNavigation = owner.begin("navigation-repair", "run-1", "open-task");
  const successfulSettings = owner.begin("workspace-settings", "workspace-a", "patch:locale");
  owner.report(failedNavigation, { scope: "mutation", message: "run repair failed" });
  owner.report(successfulSettings, { scope: "mutation", message: "locale save failed" });

  expect(owner.clear(successfulSettings)).toBe(true);
  expect(owner.errors()).toHaveLength(1);
  expect(owner.latest()).toMatchObject({
    domain: "navigation-repair",
    objectId: "run-1",
    action: "open-task",
    message: "run repair failed",
  });

  const successfulNavigation = owner.begin("navigation-repair", "run-2", "open-task");
  expect(owner.clear(successfulNavigation)).toBe(false);
  expect(owner.latest()?.message).toBe("run repair failed");
});

test("T13-P.9EF.F shell feedback preserves origin return without restarting an active request", () => {
  const coordinator = createShellErrorFeedbackCoordinator();
  const error = shellError({ action: "refresh", message: "runtime refresh failed", requestId: 1 });
  const visible = shellItem(error, { surface: "workspace", visible: true });

  expect(commandSummary(coordinator.reconcile([visible]))).toEqual([
    "show:runtime refresh failed:shell-error:runtime:workspace-a:refresh",
  ]);
  expect(coordinator.reconcile([visible])).toEqual([]);
  expect(commandSummary(coordinator.reconcile([
    shellItem(error, { surface: "settings", visible: false }),
  ]))).toEqual(["dismiss:shell-error:runtime:workspace-a:refresh"]);
  expect(commandSummary(coordinator.reconcile([visible]))).toEqual([
    "show:runtime refresh failed:shell-error:runtime:workspace-a:refresh",
  ]);
  expect(SHELL_ERROR_PERSISTENT_DURATION_MS).toBe(24 * 60 * 60 * 1000);
});

test("T13-P.9EF.F shell feedback restores fallback errors and replaces same-scope requests", () => {
  const coordinator = createShellErrorFeedbackCoordinator();
  const earlier = shellError({ action: "refresh", message: "earlier unresolved", requestId: 1 });
  const latest = shellError({ action: "cancel", message: "latest unresolved", requestId: 2 });
  const replacement = shellError({ action: "refresh", message: "replacement request", requestId: 3 });

  coordinator.reconcile([shellItem(earlier)]);
  expect(commandSummary(coordinator.reconcile([shellItem(latest)]))).toEqual([
    "dismiss:shell-error:runtime:workspace-a:refresh",
    "show:latest unresolved:shell-error:runtime:workspace-a:cancel",
  ]);
  expect(commandSummary(coordinator.reconcile([shellItem(earlier)]))).toEqual([
    "dismiss:shell-error:runtime:workspace-a:cancel",
    "show:earlier unresolved:shell-error:runtime:workspace-a:refresh",
  ]);
  expect(commandSummary(coordinator.reconcile([shellItem(replacement)]))).toEqual([
    "show:replacement request:shell-error:runtime:workspace-a:refresh",
  ]);
});

test("T13-P.9EF.F explicit dismiss survives surface return until the request changes", () => {
  const coordinator = createShellErrorFeedbackCoordinator();
  const first = shellError({ action: "refresh", message: "dismiss me", requestId: 1 });
  const next = shellError({ action: "refresh", message: "new request", requestId: 2 });
  const visible = shellItem(first);
  const [show] = coordinator.reconcile([visible]);

  expect(show?.type).toBe("show");
  coordinator.markExplicitDismiss("shell-error:runtime:workspace-a:refresh");
  expect(coordinator.reconcile([visible])).toEqual([]);
  expect(coordinator.reconcile([shellItem(first, { surface: "settings", visible: false })])).toEqual([]);
  expect(coordinator.reconcile([visible])).toEqual([]);
  expect(commandSummary(coordinator.reconcile([shellItem(next)]))).toEqual([
    "show:new request:shell-error:runtime:workspace-a:refresh",
  ]);
});

test("T13-P.9EF.F hidden-first failures never adopt a later surface as their origin", () => {
  const coordinator = createShellErrorFeedbackCoordinator();
  const error = shellError({ action: "refresh", message: "background failure", requestId: 1 });

  expect(coordinator.reconcile([
    shellItem(error, { surface: "settings", visible: false }),
  ])).toEqual([]);
  expect(coordinator.reconcile([
    shellItem(error, { surface: "workspace", visible: true }),
  ])).toEqual([]);
  expect(commandSummary(coordinator.reconcile([
    shellItem(error, { surface: "settings", visible: true }),
  ]))).toEqual([
    "show:background failure:shell-error:runtime:workspace-a:refresh",
  ]);
});

test("T13-P.9EF.F viewport eviction queues errors without a reshow cycle and recovers available slots", () => {
  const coordinator = createShellErrorFeedbackCoordinator();
  const errors = ["one", "two", "three", "four"].map((action, index) => shellError({
    action,
    message: `${action} failed`,
    requestId: index + 1,
  }));
  const items = errors.map((error, index) => shellItem(error, { key: `runtime-${index + 1}` }));
  const initial = coordinator.reconcile(items, toastViewport([]));

  expect(commandSummary(initial)).toEqual([
    "show:one failed:shell-error:runtime:workspace-a:one",
    "show:two failed:shell-error:runtime:workspace-a:two",
    "show:three failed:shell-error:runtime:workspace-a:three",
  ]);

  const firstThreeScopes = showScopes(initial);
  const externalScope = "profile:save";
  expect(coordinator.observeViewport(items, toastViewport([
    firstThreeScopes[1]!,
    firstThreeScopes[2]!,
    externalScope,
  ]))).toEqual([]);
  expect(coordinator.observeViewport(items, toastViewport([
    firstThreeScopes[1]!,
    firstThreeScopes[2]!,
  ]))).toMatchObject([{ type: "show", error: errors[3] }]);

  const fourthScope = "shell-error:runtime:workspace-a:four";
  expect(coordinator.observeViewport(items, toastViewport([
    firstThreeScopes[1]!,
    firstThreeScopes[2]!,
    fourthScope,
  ]))).toEqual([]);
  expect(commandSummary(coordinator.observeViewport(items, toastViewport([
    firstThreeScopes[2]!,
    fourthScope,
  ])))).toEqual([
    "show:one failed:shell-error:runtime:workspace-a:one",
  ]);
});

test("T13-P.9EF.F non-user timeout recovers while explicit dismiss remains bounded by error lifetime", () => {
  const coordinator = createShellErrorFeedbackCoordinator();
  const dismissed = shellError({ action: "refresh", message: "dismissed failure", requestId: 1 });
  const dismissedItem = shellItem(dismissed);
  const [initial] = coordinator.reconcile([dismissedItem], toastViewport([]));
  expect(initial?.type).toBe("show");

  const scope = "shell-error:runtime:workspace-a:refresh";
  expect(coordinator.observeViewport([dismissedItem], toastViewport([scope]))).toEqual([]);
  expect(commandSummary(coordinator.observeViewport([dismissedItem], toastViewport([])))).toEqual([
    "show:dismissed failure:shell-error:runtime:workspace-a:refresh",
  ]);
  coordinator.markExplicitDismiss(scope);

  for (let requestId = 2; requestId <= 140; requestId += 1) {
    const newer = shellError({ action: `action-${requestId}`, message: `failure ${requestId}`, requestId });
    coordinator.reconcile([shellItem(newer)]);
  }
  coordinator.closeAll();
  expect(coordinator.reconcile([dismissedItem])).toEqual([]);

  const replacement = shellError({ action: "refresh", message: "replacement failure", requestId: 141 });
  expect(commandSummary(coordinator.reconcile([shellItem(replacement)]))).toEqual([
    "show:replacement failure:shell-error:runtime:workspace-a:refresh",
  ]);
});

test("T13-P.9EF.F an evicted same-scope replacement waits instead of displacing another toast", () => {
  const coordinator = createShellErrorFeedbackCoordinator();
  const first = shellError({ action: "refresh", message: "first failure", requestId: 1 });
  coordinator.reconcile([shellItem(first)], toastViewport([]));

  const replacement = shellError({ action: "refresh", message: "replacement failure", requestId: 2 });
  expect(coordinator.reconcile([shellItem(replacement)], toastViewport([
    "profile:save",
    "provider:model-a:check",
    "plugin:plugin-a:install",
  ]))).toEqual([]);
  expect(commandSummary(coordinator.observeViewport([shellItem(replacement)], toastViewport([
    "provider:model-a:check",
    "plugin:plugin-a:install",
  ])))).toEqual([
    "show:replacement failure:shell-error:runtime:workspace-a:refresh",
  ]);
});

test("T13-P.9EF.F keeps Settings failures persistent and treats close, Escape, and swipe as explicit", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  const failureMessages = [
    "Workspace settings save failed.",
    "A newer workspace settings request failed.",
    "A swiped workspace settings request failed.",
  ];
  await page.route(/\/workspace-settings(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = await route.request().postDataJSON() as Record<string, unknown>;
    if (body.defaultAuthorizationMode === undefined) {
      await route.fallback();
      return;
    }
    const failureMessage = body.defaultAuthorizationMode === "ask"
      ? failureMessages[0]
      : body.defaultAuthorizationMode === "always"
        ? failureMessages[1]
        : failureMessages[2];
    await route.fulfill({
      status: 503,
      json: { error: "workspace_settings_save_failed", message: failureMessage },
    });
  });

  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const settingsNavigation = page.getByLabel("Settings sections");
  await settingsNavigation.getByRole("button", { name: "Default authorization" }).click();
  await page.getByRole("radiogroup", { name: "Authorization mode" })
    .getByRole("radio", { name: "Ask first" })
    .click();

  const scopedToast = page.locator('.ling-ui-toast[data-scope^="shell-error:workspace-settings:"]');
  await expect(scopedToast).toContainText(failureMessages[0]);
  await page.waitForTimeout(6_250);
  await expect(scopedToast).toContainText(failureMessages[0]);
  await settingsNavigation.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  await expect(settingsNavigation).toHaveCount(0);
  await expect(scopedToast).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await expect(scopedToast).toContainText(failureMessages[0]);
  await scopedToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(scopedToast).toHaveCount(0);
  await page.getByLabel("Settings sections").getByRole("button", { name: "Back to app" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await expect(scopedToast).toHaveCount(0);

  const reopenedSettingsNavigation = page.getByLabel("Settings sections");
  await reopenedSettingsNavigation.getByRole("button", { name: "Default authorization" }).click();
  const authorizationMode = page.getByRole("radiogroup", { name: "Authorization mode" });
  await authorizationMode.getByRole("radio", { name: "Always authorize" }).click();
  await expect(scopedToast).toContainText(failureMessages[1]);
  await scopedToast.focus();
  await page.keyboard.press("Escape");
  await expect(scopedToast).toHaveCount(0);
  await page.getByLabel("Settings sections").getByRole("button", { name: "Back to app" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await expect(scopedToast).toHaveCount(0);

  await page.getByLabel("Settings sections").getByRole("button", { name: "Default authorization" }).click();
  await page.getByRole("radiogroup", { name: "Authorization mode" })
    .getByRole("radio", { name: "Ask first" })
    .click();
  await expect(scopedToast).toContainText(failureMessages[0]);
  const toastBox = await scopedToast.boundingBox();
  expect(toastBox).not.toBeNull();
  await page.mouse.move(toastBox!.x + toastBox!.width / 2, toastBox!.y + toastBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(toastBox!.x + toastBox!.width / 2, toastBox!.y - 80, { steps: 6 });
  await page.mouse.up();
  await expect(scopedToast).toHaveCount(0);
  await page.getByLabel("Settings sections").getByRole("button", { name: "Back to app" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await expect(scopedToast).toHaveCount(0);
});

function sourcePath(path: string): string {
  return fileURLToPath(new URL(`../src/${path}`, import.meta.url));
}

function readHookCall(source: string, hook: string): string {
  const start = source.indexOf(`${hook}({`);
  if (start < 0) throw new Error(`Missing ${hook} call`);
  const end = source.indexOf("\n  });", start);
  if (end < 0) throw new Error(`Missing ${hook} call boundary`);
  return source.slice(start, end);
}

function shellError(input: {
  readonly action: string;
  readonly message: string;
  readonly requestId: number;
}): FocusedDomainError {
  return {
    action: input.action,
    domain: "runtime",
    identity: "workspace-a",
    message: input.message,
    objectId: "workspace-a",
    requestId: input.requestId,
    scope: "mutation",
  };
}

function shellItem(
  error: FocusedDomainError,
  input: { readonly key?: string; readonly surface?: string; readonly visible?: boolean } = {},
): ShellErrorFeedbackItem {
  return {
    key: input.key ?? "runtime",
    error,
    surface: input.surface ?? "workspace",
    visible: input.visible ?? true,
  };
}

function toastViewport(
  openScopes: readonly string[],
  openToastCount = openScopes.length,
): ShellErrorToastViewportSnapshot {
  return {
    maxVisible: SHELL_ERROR_TOAST_CAPACITY,
    openScopes: new Set(openScopes),
    openToastCount,
  };
}

function showScopes(commands: readonly ShellErrorFeedbackCommand[]): readonly string[] {
  return commands.flatMap((command) => command.type === "show" ? [command.scope] : []);
}

function commandSummary(commands: readonly ShellErrorFeedbackCommand[]): readonly string[] {
  return commands.map((command) => command.type === "dismiss"
    ? `dismiss:${command.scope}`
    : `show:${command.error.message}:${command.scope}`);
}

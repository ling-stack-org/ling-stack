import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFocusedDomainErrorOwner } from "../src/app/use-focused-domain-error-owner.js";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const appShellPath = sourcePath("app/AppShell.tsx");
const feedbackGuardPath = fileURLToPath(new URL("../scripts/check-ui2-feedback.mjs", import.meta.url));
const shellFeedbackPath = sourcePath("app/use-shell-error-feedback.ts");
const releasedOwnerPaths = [
  "app/use-app-navigation-controller.ts",
  "app/use-control-plane-invalidation.ts",
  "app/use-workspace-settings-controller.ts",
  "domains/external-work/use-external-work-domain.ts",
  "domains/runtime/use-runtime-domain.ts",
].map(sourcePath);

test("T13-P.9EF.E releases five shell owners from the generic AppShell error contract", async () => {
  const [appShell, guard, shellFeedback, ...releasedOwners] = await Promise.all([
    readFile(appShellPath, "utf8"),
    readFile(feedbackGuardPath, "utf8"),
    readFile(shellFeedbackPath, "utf8"),
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
  expect(shellFeedback).toContain("originSurfaceByRequestRef.current.set(errorKey, item.surface);");
  expect(shellFeedback).toContain("if (!item.visible || originSurface !== item.surface)");
  expect(shellFeedback).toContain("seenRequestsRef.current.add(errorKey);");
  expect(shellFeedback).toContain("if (previousScope) input.dismissToast(previousScope);");

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

test("T13-P.9EF.E dismisses a Settings-owned failure when its surface closes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  const failureMessage = "Workspace settings save failed.";
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
  await expect(scopedToast).toContainText(failureMessage);
  await settingsNavigation.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  await expect(settingsNavigation).toHaveCount(0);
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

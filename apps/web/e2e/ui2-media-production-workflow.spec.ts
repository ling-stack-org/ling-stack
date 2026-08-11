import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import { createDefaultProviderTemplates } from "./support/mock-state";
import {
  createLoadedMediaProductionFixture,
  openMediaProduction,
} from "./support/media-production-fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
});

test("MP-11 workflow load uses a shared dialog, retains refresh failures, and returns focus", async ({ page }) => {
  const state = workflowState({ includeWorkflow: true });
  const control = createWorkflowRouteControl();
  control.listDelayMs = 3_000;
  await prepare(page, state, control);

  const trigger = await openWorkflowDialog(page);
  const dialog = workflowDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-media-workflow-loading="initial"]')).toBeVisible();
  await expect(dialog.getByText("Import your first production workflow")).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: /Editorial workflow/ })).toBeVisible({ timeout: 8_000 });

  control.listDelayMs = 0;
  control.failNextConnectionList = 1;
  await expect(dialog.getByRole("button", { name: "Refresh production workflows" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  const retainedFailure = dialog.getByRole("alert").filter({ hasText: "Could not refresh production workflows" });
  await expect(retainedFailure).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Editorial workflow/ })).toBeVisible();
  await retainedFailure.getByRole("button", { name: "Retry" }).click();
  await expect(retainedFailure).toHaveCount(0);

  await dialog.getByRole("button", { name: "Close production workflows" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("MP-12 connection delete is subject single-flight, explains references, and keeps failures in the danger dialog", async ({ page }) => {
  const state = workflowState({ includeWorkflow: true, includeFreeConnection: true });
  const control = createWorkflowRouteControl();
  await prepare(page, state, control);
  await openWorkflowDialog(page);
  const dialog = workflowDialog(page);

  await dialog.getByRole("tab", { name: "Connections" }).click();
  await dialog.getByRole("option", { name: /Referenced connection/ }).click();
  const blockedDelete = dialog.getByRole("button", { name: "Delete", exact: true });
  await expect(blockedDelete).toBeDisabled();
  await expect(blockedDelete).toHaveAttribute("title", /Used by 1 production workflows/);
  expect(control.connectionDeleteCalls.referenced_connection ?? 0).toBe(0);

  await dialog.getByRole("option", { name: /Free connection/ }).click();
  const deleteTrigger = dialog.getByRole("button", { name: "Delete", exact: true });
  control.failNextConnectionDelete = 1;
  control.connectionDeleteDelayMs = 300;
  await deleteTrigger.click();
  const danger = page.getByRole("dialog", { name: "Delete Free connection?" });
  const confirm = danger.getByRole("button", { name: "Delete", exact: true });
  await confirm.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await page.keyboard.press("Escape");
  await expect(danger).toBeVisible();
  await expect(danger.getByRole("alert")).toContainText("Could not delete this connection.");
  expect(control.connectionDeleteCalls.free_connection).toBe(1);

  await danger.getByRole("button", { name: "Cancel" }).click();
  await expect(danger).toHaveCount(0);
  await expect(deleteTrigger).toBeFocused();

  control.connectionDeleteDelayMs = 0;
  await deleteTrigger.click();
  const retryDanger = page.getByRole("dialog", { name: "Delete Free connection?" });
  await retryDanger.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(retryDanger).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: /Free connection/ })).toHaveCount(0);
  expect(control.connectionDeleteCalls.free_connection).toBe(2);
});

test("MP-13 import validation stays local, failures retain the draft, and busy import blocks dismissal", async ({ page }) => {
  const state = workflowState({ includeWorkflow: false });
  const control = createWorkflowRouteControl();
  await prepare(page, state, control);
  await openWorkflowDialog(page);
  const dialog = workflowDialog(page);

  await chooseWorkflowFile(dialog, {
    name: "too-large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 32),
  });
  await expect(dialog.getByRole("alert")).toContainText("cannot exceed 5 MB");

  await chooseWorkflowFile(dialog, {
    name: "array.json",
    mimeType: "application/json",
    buffer: Buffer.from("[]"),
  });
  await expect(dialog.getByRole("alert")).toContainText("JSON object");

  await chooseWorkflowFile(dialog, validWorkflowFile("draft-one.json"));
  const workflowName = dialog.getByLabel("Workflow name");
  await expect(workflowName).toHaveValue("draft-one");
  await workflowName.fill("");
  await expect(dialog.getByRole("button", { name: "Import workflow", exact: true }).last()).toBeDisabled();
  await workflowName.fill("Retained workflow draft");

  control.failNextAnalyze = 1;
  await chooseWorkflowFile(dialog, validWorkflowFile("replacement.json"));
  await expect(dialog.getByRole("alert")).toContainText("Could not analyze this workflow file.");
  await expect(workflowName).toHaveValue("Retained workflow draft");

  control.failNextImport = 1;
  control.importDelayMs = 300;
  const importButton = dialog.getByRole("button", { name: "Import workflow", exact: true }).last();
  await importButton.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert").filter({ hasText: "Your draft is still available" })).toBeVisible();
  await expect(workflowName).toHaveValue("Retained workflow draft");

  control.importDelayMs = 0;
  await importButton.click();
  await expect(dialog.getByRole("option", { name: /Retained workflow draft/ })).toBeVisible();
  expect(control.importCalls).toBe(2);
});

test("MP-14 workflow test reflects Media Job truth before activate and archive", async ({ page }) => {
  const state = workflowState({ includeWorkflow: true });
  const control = createWorkflowRouteControl();
  await prepare(page, state, control);
  await openWorkflowDialog(page);
  const dialog = workflowDialog(page);

  await expect(dialog.getByText("Not tested")).toBeVisible();
  await dialog.getByRole("button", { name: "Run test" }).click();
  await expect(dialog.getByText(/Test (queued|running)/)).toBeVisible();
  await expect(dialog.getByText("Test passed")).toBeVisible({ timeout: 6_000 });
  const activate = dialog.getByRole("button", { name: "Activate version" });
  await expect(activate).toBeEnabled();
  await activate.click();
  await expect(dialog.getByRole("button", { name: "Active version" })).toBeDisabled();

  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog.getByRole("option", { name: /Editorial workflow/ })).toContainText("Archived");
  await expect(dialog.getByText("Select a production workflow")).toBeVisible();
});

test("MP-13 workflow add and import actions keep typed accessibility while import is busy", async ({ page }) => {
  const state = workflowState({ includeWorkflow: true });
  const control = createWorkflowRouteControl();
  control.analyzeDelayMs = 500;
  await prepare(page, state, control);
  await openWorkflowDialog(page);
  const dialog = workflowDialog(page);

  const importWorkflow = dialog.getByRole("button", { name: "Import workflow", exact: true }).first();
  await assertTypedIconButton(importWorkflow, "Import workflow");
  const chooser = page.waitForEvent("filechooser");
  await importWorkflow.click();
  await (await chooser).setFiles(validWorkflowFile("typed-contract.json"));
  await expect(importWorkflow).toBeDisabled();
  await expect(dialog.getByLabel("Workflow name")).toHaveValue("typed-contract");
  await expect(importWorkflow).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await dialog.getByRole("tab", { name: "Connections" }).click();
  const newConnection = dialog.getByRole("button", { name: "New connection" });
  await assertTypedIconButton(newConnection, "New connection");
  await expect(newConnection).toBeEnabled();
  await newConnection.click();
  await expect(dialog.getByLabel("Connection name")).toBeVisible();
  await expect(dialog.getByLabel("ComfyUI address")).toBeVisible();
});

test("MP-11 source contract has no hand overlay and guards request identity", async () => {
  const workflowRoot = new URL("../src/features/media-production/workflows/", import.meta.url);
  const sourceFiles = [
    "MediaWorkflowLibraryDialog.tsx",
    "WorkflowConnectionWorkspace.tsx",
    "WorkflowFieldRenderer.tsx",
    "WorkflowImportMappingEditor.tsx",
    "WorkflowLibraryWorkspace.tsx",
    "use-media-workflow-controller.ts",
  ];
  const source = (await Promise.all(sourceFiles.map((file) => readFile(new URL(file, workflowRoot), "utf8")))).join("\n");
  expect(source).not.toContain('role="dialog"');
  expect(source).not.toContain('addEventListener("keydown"');
  expect(source).not.toContain("onMouseDown={(event) => event.target === event.currentTarget");
  expect(source).toContain("identity.cwd === cwdRef.current");
  expect(source).toContain("identity.epoch === epochRef.current");
  expect(source).toContain("requestId !== loadRequestRef.current");
  await expect(access(fileURLToPath(new URL("MediaWorkflowLibraryOverlay.tsx", workflowRoot)))).rejects.toThrow();
});

test("MP-11 delayed old cwd responses cannot overwrite the current workflow state", async ({ page }) => {
  const requestedCwds: string[] = [];
  await mockDaemon(page, createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 1 }));
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || !["/media-workflow-connections", "/media-workflows"].includes(url.pathname)) {
      await route.fallback();
      return;
    }
    const requestCwd = url.searchParams.get("cwd") ?? "";
    requestedCwds.push(requestCwd);
    await delay(requestCwd === "/cwd-a" ? 500 : 20);
    if (url.pathname === "/media-workflow-connections") {
      await route.fulfill({ json: { cwd: requestCwd, connections: [workflowConnection(`connection_${requestCwd.slice(-1)}`, `Connection ${requestCwd.slice(-1).toUpperCase()}`)] } });
      return;
    }
    await route.fulfill({ json: { cwd: requestCwd, workflows: [] } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
    const reactModule = await dynamicImport("/@id/react") as { readonly default: typeof import("react") };
    const reactDomModule = await dynamicImport("/@id/react-dom/client") as { readonly default: { readonly createRoot: typeof import("react-dom/client")["createRoot"] } };
    const controllerModule = await dynamicImport("/src/features/media-production/workflows/use-media-workflow-controller.ts") as {
      readonly useMediaWorkflowController: typeof import("../src/features/media-production/workflows/use-media-workflow-controller")["useMediaWorkflowController"];
    };
    const React = reactModule.default;
    const host = document.createElement("div");
    host.id = "workflow-controller-probe";
    document.body.append(host);
    function Probe(): React.JSX.Element {
      const [cwdValue, setCwdValue] = React.useState("/cwd-a");
      const controller = controllerModule.useMediaWorkflowController({ cwd: cwdValue, onJobsChanged: () => undefined });
      return React.createElement("section", {},
        React.createElement("button", { id: "workflow-probe-switch", onClick: () => setCwdValue("/cwd-b") }, "Switch cwd"),
        React.createElement("pre", { id: "workflow-probe-state" }, JSON.stringify({ cwd: cwdValue, phase: controller.state.phase, connections: controller.state.connections.map((item) => item.name) })),
      );
    }
    reactDomModule.default.createRoot(host).render(React.createElement(Probe));
  });
  await expect.poll(() => requestedCwds.filter((value) => value === "/cwd-a").length).toBeGreaterThanOrEqual(2);
  await page.locator("#workflow-probe-switch").click();
  await expect(page.locator("#workflow-probe-state")).toContainText('"cwd":"/cwd-b"');
  await expect(page.locator("#workflow-probe-state")).toContainText("Connection B");
  await page.waitForTimeout(650);
  await expect(page.locator("#workflow-probe-state")).not.toContainText("Connection A");
  expect(requestedCwds).toContain("/cwd-a");
  expect(requestedCwds).toContain("/cwd-b");
});

interface WorkflowRouteControl {
  listDelayMs: number;
  analyzeDelayMs: number;
  connectionDeleteDelayMs: number;
  importDelayMs: number;
  failNextConnectionList: number;
  failNextConnectionDelete: number;
  failNextAnalyze: number;
  failNextImport: number;
  connectionDeleteCalls: Record<string, number>;
  importCalls: number;
}

function createWorkflowRouteControl(): WorkflowRouteControl {
  return { listDelayMs: 0, analyzeDelayMs: 0, connectionDeleteDelayMs: 0, importDelayMs: 0, failNextConnectionList: 0, failNextConnectionDelete: 0, failNextAnalyze: 0, failNextImport: 0, connectionDeleteCalls: {}, importCalls: 0 };
}

async function installWorkflowRoutes(page: Page, control: WorkflowRouteControl): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && (path === "/media-workflow-connections" || path === "/media-workflows")) {
      await delay(control.listDelayMs);
      if (path === "/media-workflow-connections" && control.failNextConnectionList > 0) {
        control.failNextConnectionList -= 1;
        await route.fulfill({ status: 500, json: { error: "fixture_workflow_list_failed" } });
        return;
      }
    }
    if (request.method() === "POST" && path === "/media-workflows/analyze") {
      await delay(control.analyzeDelayMs);
      if (control.failNextAnalyze > 0) {
        control.failNextAnalyze -= 1;
        await route.fulfill({ status: 422, json: { error: "fixture_workflow_analyze_failed" } });
        return;
      }
    }
    if (request.method() === "POST" && path === "/media-workflows/import") {
      control.importCalls += 1;
      await delay(control.importDelayMs);
      if (control.failNextImport > 0) {
        control.failNextImport -= 1;
        await route.fulfill({ status: 500, json: { error: "fixture_workflow_import_failed" } });
        return;
      }
    }
    const connectionMatch = /^\/media-workflow-connections\/([^/]+)$/u.exec(path);
    if (request.method() === "DELETE" && connectionMatch) {
      const connectionId = decodeURIComponent(connectionMatch[1] ?? "");
      control.connectionDeleteCalls[connectionId] = (control.connectionDeleteCalls[connectionId] ?? 0) + 1;
      await delay(control.connectionDeleteDelayMs);
      if (control.failNextConnectionDelete > 0) {
        control.failNextConnectionDelete -= 1;
        await route.fulfill({ status: 500, json: { error: "fixture_connection_delete_failed" } });
        return;
      }
    }
    await route.fallback();
  });
}

async function prepare(page: Page, state: MockState, control: WorkflowRouteControl): Promise<void> {
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installWorkflowRoutes(page, control);
  await page.goto("/");
  await openMediaProduction(page);
  await expect(page.locator(".media-production-canvas-stage")).toBeVisible();
}

async function openWorkflowDialog(page: Page) {
  const trigger = page.locator(".project-outline-workflow-entry");
  await expect(trigger).toBeVisible();
  await trigger.click();
  return trigger;
}

function workflowDialog(page: Page) {
  return page.locator('[data-media-production-dialog="workflow-library"]');
}

async function chooseWorkflowFile(dialog: ReturnType<typeof workflowDialog>, file: { readonly name: string; readonly mimeType: string; readonly buffer: Buffer }): Promise<void> {
  const chooser = dialog.page().waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Import workflow", exact: true }).first().click();
  await (await chooser).setFiles(file);
}

function validWorkflowFile(name: string) {
  return { name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ "1": { class_type: "CLIPTextEncode", inputs: { text: "Scene" } }, "9": { class_type: "SaveVideo", inputs: {} } })) };
}

function workflowState(input: { readonly includeWorkflow: boolean; readonly includeFreeConnection?: boolean }): MockState {
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 1 });
  state.mediaWorkflowConnections = [workflowConnection("referenced_connection", "Referenced connection")];
  if (input.includeFreeConnection) state.mediaWorkflowConnections.push(workflowConnection("free_connection", "Free connection"));
  state.mediaWorkflows = input.includeWorkflow ? [workflowDetail()] : [];
  return state;
}

function workflowConnection(id: string, name: string): Record<string, unknown> {
  return { id, workspaceId: "workspace_default", name, adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8188", authMode: "none", secretConfigured: false, networkPolicy: "trusted_private_network", protocolVariant: "auto", status: "ready", health: { ok: true, message: "Connected", checkedAt: "2026-07-23T00:00:00.000Z", protocolVariant: "jobs_v1" }, createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" };
}

function workflowDetail(): Record<string, unknown> {
  const version = { id: "editorial_workflow_v1", workflowDefinitionId: "editorial_workflow", version: 1, sourceFormat: "comfy_api_json", sourceDigest: "fixture", graphSnapshot: {}, inputFields: [{ id: "prompt", label: "Prompt", kind: "text", semantic: "prompt", required: true, nodeId: "1", inputName: "text", defaultValue: "Editorial scene" }], outputRules: [{ nodeId: "9", artifactType: "video", collect: "first" }], validation: { ok: true, errors: [], warnings: [], checkedAt: "2026-07-23T00:00:00.000Z" }, createdAt: "2026-07-23T00:00:00.000Z" };
  return { definition: { id: "editorial_workflow", workspaceId: "workspace_default", connectionId: "referenced_connection", name: "Editorial workflow", description: "Editorial scene generation", status: "draft", createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" }, versions: [version] };
}

async function assertTypedIconButton(button: Locator, label: string): Promise<void> {
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  await expect(button.locator('svg[data-ling-icon=""]')).toHaveCount(1);
  const geometry = await button.evaluate((element) => ({
    width: (element as HTMLElement).offsetWidth,
    height: (element as HTMLElement).offsetHeight,
  }));
  expect(geometry.width).toBeGreaterThanOrEqual(32);
  expect(geometry.height).toBeGreaterThanOrEqual(32);
  await button.hover();
  const tooltip = button.page().getByRole("tooltip").filter({ hasText: label });
  await expect(tooltip).toBeVisible();
  await button.page().mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

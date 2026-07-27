import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mockDaemon } from "./mock-daemon";
import {
  createBaseState,
  cwd,
  isRecord,
  type MockState,
} from "./mock-state";

export interface CouncilPatchRequest {
  readonly councilId: string;
  readonly payload: Record<string, unknown>;
}

export interface CouncilSettingsArchiveRouteControl {
  failNextPatchMessage?: string;
  patchDelayMs: number;
  readonly patchRequests: CouncilPatchRequest[];
}

export function createCouncilSettingsArchiveRouteControl(): CouncilSettingsArchiveRouteControl {
  return {
    patchDelayMs: 0,
    patchRequests: [],
  };
}

export function createCouncilSettingsArchiveState(count = 3): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiCouncils = [
    councilFixture({
      id: "council_settings_custom",
      displayName: "Product Review Council",
      description: "A custom Council used for settings and archive verification.",
      pinned: true,
      source: "user",
    }),
    councilFixture({
      id: "council_settings_builtin",
      displayName: "Managed Development Council",
      description: "Managed by the built-in Council source.",
      source: "builtin",
    }),
    councilFixture({
      id: "council_settings_template",
      displayName: "Template Advisory Council",
      description: "Managed by a template source.",
      source: "template",
    }),
    ...Array.from({ length: Math.max(0, count - 3) }, (_, index) => councilFixture({
      id: `council_settings_dense_${String(index).padStart(3, "0")}`,
      displayName: `Council ${String(index).padStart(3, "0")} with an intentionally long identity for bounded 100-row verification`,
      description: `Dense Council fixture ${index + 1}`,
      source: "user",
    })),
  ];
  state.aiCouncilMembers = [];
  state.channelCouncilPolicies = [
    channelPolicy("channel_engineering", ["council_settings_custom", "council_settings_builtin"], "council_settings_custom"),
    channelPolicy("channel_design", ["council_settings_custom"], "council_settings_custom"),
  ];
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: {},
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  });
  state.teammateChannelMemberships = [{
    teammateId: "teammate_direct_member",
    channelId: "channel_engineering",
    isDefault: true,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }];
  state.aiCouncilHealthGeneratedAt = "2026-07-23T00:05:00.000Z";
  return state;
}

export async function mockCouncilSettingsArchiveDaemon(
  page: Page,
  state: MockState,
  control: CouncilSettingsArchiveRouteControl,
): Promise<void> {
  await mockDaemon(page, state);
  await page.route("http://127.0.0.1:17891/ai-councils/*", async (route) => {
    const request = route.request();
    const match = /^\/ai-councils\/([^/]+)$/u.exec(new URL(request.url()).pathname);
    if (request.method() !== "PATCH" || !match) {
      await route.fallback();
      return;
    }
    control.patchRequests.push({
      councilId: decodeURIComponent(match[1]),
      payload: request.postDataJSON() as Record<string, unknown>,
    });
    if (control.patchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, control.patchDelayMs));
    }
    if (control.failNextPatchMessage) {
      const message = control.failNextPatchMessage;
      control.failNextPatchMessage = undefined;
      await route.fulfill({
        status: 503,
        json: { error: "synthetic_council_settings_failure", message },
      });
      return;
    }
    await route.fallback();
  });
}

export async function prepareCouncilSettingsSurface(
  page: Page,
  input: {
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
    readonly theme: "dark" | "light";
    readonly width: number;
  },
): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({
    colorScheme: input.theme,
    reducedMotion: input.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = theme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: input.locale, theme: input.theme });
}

export async function openCouncilSettings(
  page: Page,
  councilName: string | RegExp = /Product Review Council/,
): Promise<{ readonly panel: Locator; readonly surface: Locator }> {
  await page.getByLabel(/Ling Stack navigation|Ling Stack 导航/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Council Workspace|智囊团工作区/ }).click();
  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".council-list-health-row").first()).toBeVisible();
  const row = surface.locator(".council-list-health-row").filter({ hasText: councilName });
  await expect(row).toBeVisible();
  await row.click();
  await surface.getByRole("tab", { name: /Council settings|智囊团设置/ }).click();
  const panel = surface.locator("[data-ui2-council-settings-archive='true']");
  await expect(panel).toBeVisible();
  return { panel, surface };
}

export function collectCouncilRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      (message.type() === "error" || message.type() === "warning") &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      errors.push(`${message.type()}:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}

export async function expectCouncilSurfaceNoOverflow(page: Page, panel: Locator): Promise<void> {
  const metrics = await page.evaluate(() => ({
    documentClientHeight: document.documentElement.clientHeight,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.documentClientHeight + 1);
  const panelMetrics = await panel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(panelMetrics.scrollWidth).toBeLessThanOrEqual(panelMetrics.clientWidth + 1);
}

export async function captureCouncilSettingsEvidence(
  page: Page,
  evidenceDirectory: string,
  name: string,
): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: false, path: `${evidenceDirectory}/${name}` });
}

export function readCouncilStatus(state: MockState, councilId: string): string | undefined {
  const council = state.aiCouncils.find((item) => isRecord(item) && item.id === councilId);
  return isRecord(council) && typeof council.status === "string" ? council.status : undefined;
}

export function readCouncilName(state: MockState, councilId: string): string | undefined {
  const council = state.aiCouncils.find((item) => isRecord(item) && item.id === councilId);
  return isRecord(council) && typeof council.displayName === "string" ? council.displayName : undefined;
}

function councilFixture(input: {
  readonly description: string;
  readonly displayName: string;
  readonly id: string;
  readonly pinned?: boolean;
  readonly source: "builtin" | "template" | "user";
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    source: input.source,
    templateId: input.source === "template" ? "council_template_advisory" : undefined,
    displayName: input.displayName,
    description: input.description,
    routingPolicy: {
      defaultMode: "advisory",
      maxActiveMembers: 4,
      notes: ["Configuration only; runtime provenance is not available."],
    },
    governanceProfile: {
      permissionBoundary: "restrict_only",
      approvalBoundary: "cannot_bypass",
      toolGrantBoundary: "cannot_grant",
      credentialBoundary: "cannot_grant",
      notes: ["Council settings cannot grant authority."],
    },
    status: "active",
    pinned: input.pinned ?? false,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function channelPolicy(
  channelId: string,
  attachedCouncilIds: readonly string[],
  preferredCouncilId: string,
): Record<string, unknown> {
  return {
    workspaceId: "workspace_default",
    channelId,
    attachedCouncilIds: [...attachedCouncilIds],
    preferredCouncilId,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

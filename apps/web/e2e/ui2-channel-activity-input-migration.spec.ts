import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import {
  channelEventFilters,
  openChannelChatTools,
  openEngineeringChannel,
} from "./support/test-helpers";

const activityPanelsSource = fileURLToPath(new URL(
  "../src/features/workspace/ChannelActivityPanels.tsx",
  import.meta.url,
));
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/raw-text-controls/first-wave/",
  import.meta.url,
));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";

test("Activity search and follow-up triage use shared controls without changing retry behavior", async ({ page }) => {
  const source = await readFile(activityPanelsSource, "utf8");
  expect(source.match(/<(?:input|textarea)\b/gu) ?? []).toEqual([]);

  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTriageState();
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  await openChannelChatTools(page);

  const filters = channelEventFilters(page).first();
  const search = filters.getByRole("searchbox", { name: "Search activity" });
  await expect(search).toHaveAttribute("data-ling-input-native", "true");
  await expect(search.locator("xpath=ancestor::label[contains(@class, 'activity-search-field')][1]")).toHaveCount(1);
  await expectInputFocusContained(search, 34);

  await search.fill("activity-result-that-does-not-exist");
  await expect(page.getByText("No activity matches these filters")).toBeVisible();
  await search.fill("run_failed");

  const runEvent = activityBubble(page, "Run event", "Inspect workspace");
  await expect(runEvent).toBeVisible();
  const drawer = await openTriageEditor(page, runEvent, "Create follow-up task");
  const title = drawer.getByLabel("Triage title");
  const prompt = drawer.getByLabel("Triage prompt");
  await expectSharedEditor(title, "input");
  await expectSharedEditor(prompt, "textarea");
  await expect(prompt).toHaveAttribute("rows", "5");
  await expectInputFocusContained(title);
  await expectTextareaFocusContained(prompt);

  const titleValue = "Investigate UI2 Activity shared input migration";
  const longPrompt = `Trace-${"activity-control-".repeat(42)}end`;
  await title.fill(titleValue);
  await prompt.fill(longPrompt);
  await expect(title).toHaveValue(titleValue);
  await expect(prompt).toHaveValue(longPrompt);
  await expectContained(drawer);

  state.failNextTaskCreate = true;
  await drawer.getByRole("button", { name: "Run triage action" }).click();
  await expect(drawer.getByRole("alert")).toContainText("Triage action failed");
  await expect(title).toHaveValue(titleValue);
  await expect(prompt).toHaveValue(longPrompt);
  await captureEvidenceSurface(page, "1440x960-ling-light-activity-triage-failure.png");
  await drawer.getByRole("button", { name: "Retry" }).click();
  await expect(drawer.getByRole("status")).toContainText("Triage action created");

  await expectDocumentContained(page);
  expect(runtimeErrors).toEqual([]);
});

test("All Activity triage editor projections stay contained in dark reduced-motion mode", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, true);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTriageState();
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  await openChannelChatTools(page);

  const projections: readonly TriageProjection[] = [
    {
      action: "Create follow-up task",
      bubble: activityBubble(page, "Run event", "Inspect workspace"),
      fields: [
        ["Triage title", "Follow-up title"],
        ["Triage prompt", longValue("follow-up"), 5],
      ],
    },
    {
      action: "Create handoff",
      bubble: activityBubble(page, "Workflow step", "Blocked triage step"),
      fields: [
        ["Reason", "Escalate blocked Activity work"],
        ["To participant", "engineer"],
        ["Participant label", "Engineer"],
        ["Required input", longValue("required-input"), 5],
        ["Expected output", longValue("expected-output"), 3],
      ],
    },
    {
      action: "Record decision",
      bubble: activityBubble(page, "Approval event", "Approve shell command"),
      fields: [
        ["Triage title", "Keep approval pending"],
        ["Decision text", longValue("decision"), 4],
        ["Rationale", longValue("rationale"), 3],
      ],
    },
    {
      action: "Create context summary",
      bubble: activityBubble(page, "Workflow step", "Blocked triage step"),
      fields: [
        ["Summary", longValue("summary"), 5],
        ["Acceptance criteria", longValue("acceptance"), 3],
        ["Open questions", longValue("questions"), 3],
      ],
    },
  ];

  for (const projection of projections) {
    const drawer = await openTriageEditor(page, projection.bubble, projection.action);
    for (const [label, value, rows] of projection.fields) {
      const control = drawer.getByLabel(label);
      const tagName = await control.evaluate((element) => element.tagName.toLowerCase());
      await expectSharedEditor(control, tagName === "textarea" ? "textarea" : "input");
      if (rows !== undefined) {
        await expect(control).toHaveAttribute("rows", String(rows));
      }
      await control.fill(value);
      await expect(control).toHaveValue(value);
      if (tagName === "textarea") {
        await expectTextareaFocusContained(control);
      } else {
        await expectInputFocusContained(control);
      }
    }
    await expect(drawer.getByRole("button", { name: "Run triage action" })).toBeEnabled();
    await expectContained(drawer);
    if (projection.action === "Create context summary") {
      await captureEvidenceSurface(page, "1280x800-ling-dark-activity-context-summary.png");
    }
    await drawer.getByLabel("Close details").click();
    await expect(drawer).toHaveCount(0);
  }

  const search = channelEventFilters(page).first().getByRole("searchbox", { name: "Search activity" });
  await search.fill(longValue("search"));
  await expectInputFocusContained(search, 34);
  await expect(page.getByText("No activity matches these filters")).toBeVisible();
  await expectDocumentContained(page);
  expect(runtimeErrors).toEqual([]);
});

interface TriageProjection {
  readonly action: string;
  readonly bubble: Locator;
  readonly fields: readonly (readonly [label: string, value: string, rows?: number])[];
}

function createTriageState() {
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [
    {
      id: "msg_triage_input_migration",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Timeline source message for Activity input migration",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:02:00.000Z",
      updatedAt: "2026-05-25T00:02:00.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_triage_input_migration",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Activity input migration workflow",
      objective: "Exercise every Activity triage editor projection.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:05:00.000Z",
      updatedAt: "2026-05-25T00:06:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_triage_input_migration",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_triage_input_migration",
      position: 1,
      title: "Blocked triage step",
      prompt: "Wait for runtime recovery.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "blocked",
      blocker: "Runtime policy is waiting.",
      createdAt: "2026-05-25T00:06:00.000Z",
      updatedAt: "2026-05-25T00:07:00.000Z",
    },
  ];
  state.stateTransitions = [
    {
      id: "transition_triage_input_migration",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_inspect",
      fromStatus: "todo",
      toStatus: "failed",
      event: "task_failed",
      actor: "runner",
      createdAt: "2026-05-25T00:03:00.000Z",
    },
  ];
  return state;
}

function activityBubble(page: Page, kind: string, title: string): Locator {
  return page.locator(".message-bubble").filter({ hasText: kind }).filter({ hasText: title }).first();
}

async function openTriageEditor(page: Page, bubble: Locator, action: string): Promise<Locator> {
  await expect(bubble).toBeVisible();
  await bubble.getByRole("button", { name: "Details" }).click();
  const drawer = page.getByLabel("Activity details");
  await expect(drawer).toBeVisible();
  const triage = drawer.locator(".activity-triage-section");
  if ((await triage.getAttribute("open")) === null) {
    await triage.locator("summary").click();
  }
  await drawer.getByRole("button", { name: action }).click();
  return drawer;
}

async function expectSharedEditor(control: Locator, kind: "input" | "textarea"): Promise<void> {
  await expect(control).toHaveAttribute("data-ling-control-native", "true");
  if (kind === "input") {
    await expect(control).toHaveAttribute("data-ling-input-native", "true");
  } else {
    await expect.poll(() => control.evaluate((element) => element.tagName.toLowerCase())).toBe("textarea");
  }
  await expect(control.locator("xpath=ancestor::*[contains(@class, 'activity-triage-field')][1]")).toHaveCount(1);
}

async function expectInputFocusContained(input: Locator, expectedShellHeight?: number): Promise<void> {
  const shell = expectedShellHeight === undefined
    ? input.locator("xpath=..")
    : input.locator("xpath=ancestor::label[contains(@class, 'activity-search-field')][1]");
  const before = await readGeometry(input, shell);
  await input.focus();
  const after = await readGeometry(input, shell);
  if (expectedShellHeight !== undefined) {
    expect(Math.round(after.shellHeight)).toBe(expectedShellHeight);
  }
  expect(after.controlHeight).toBe(before.controlHeight);
  expect(after.shellHeight).toBe(before.shellHeight);
  expect(after.controlTop).toBeGreaterThanOrEqual(after.shellTop);
  expect(after.controlBottom).toBeLessThanOrEqual(after.shellBottom);
  expect(after.nativeBorderWidth).toBe("0px");
  expect(after.nativeBoxShadow).toBe("none");
  expect(after.nativeOutlineStyle).toBe("none");
}

async function expectTextareaFocusContained(textarea: Locator): Promise<void> {
  const before = await textarea.boundingBox();
  if (!before) throw new Error("Textarea geometry is unavailable");
  await textarea.focus();
  const after = await textarea.boundingBox();
  if (!after) throw new Error("Textarea focus geometry is unavailable");
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  expect(await textarea.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function readGeometry(control: Locator, shell: Locator): Promise<{
  readonly controlBottom: number;
  readonly controlHeight: number;
  readonly controlTop: number;
  readonly nativeBorderWidth: string;
  readonly nativeBoxShadow: string;
  readonly nativeOutlineStyle: string;
  readonly shellBottom: number;
  readonly shellHeight: number;
  readonly shellTop: number;
}> {
  const controlBox = await control.boundingBox();
  const shellBox = await shell.boundingBox();
  if (!controlBox || !shellBox) throw new Error("Input geometry is unavailable");
  const styles = await control.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      nativeBorderWidth: computed.borderTopWidth,
      nativeBoxShadow: computed.boxShadow,
      nativeOutlineStyle: computed.outlineStyle,
    };
  });
  return {
    ...styles,
    controlBottom: controlBox.y + controlBox.height,
    controlHeight: controlBox.height,
    controlTop: controlBox.y,
    shellBottom: shellBox.y + shellBox.height,
    shellHeight: shellBox.height,
    shellTop: shellBox.y,
  };
}

async function expectContained(locator: Locator): Promise<void> {
  expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectDocumentContained(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

async function prepareSurface(
  page: Page,
  theme: "light" | "dark",
  width: number,
  height: number,
  reducedMotion = false,
): Promise<void> {
  await page.setViewportSize({ width, height });
  if (reducedMotion) {
    await page.emulateMedia({ reducedMotion: "reduce" });
  }
  await page.addInitScript((resolvedTheme) => {
    const selection = { mode: "fixed", themeId: `ling-${resolvedTheme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureEvidenceSurface(page: Page, filename: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
  });
}

function longValue(prefix: string): string {
  return `${prefix}-${"activity-input-migration-".repeat(36)}end`;
}

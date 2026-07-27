import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  isRecord,
  type MockState,
} from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const screenshotDirectory = `${repositoryDirectory}docs/design/ui2.0升级/evidence/features/raw-text-controls/second-wave`;
const proposalCardsSource = fileURLToPath(new URL(
  "../src/features/workspace/ChannelWorkflowProposalCards.tsx",
  import.meta.url,
));
const proposalEditorSource = fileURLToPath(new URL(
  "../src/features/workspace/ChannelExecutionProposalEditor.tsx",
  import.meta.url,
));
const proposalStylesSource = fileURLToPath(new URL(
  "../src/styles/channel-execution-proposal.css",
  import.meta.url,
));

test("editable Task confirmation uses shared fields and preserves dynamic proposal save behavior", async ({ page }) => {
  const [cardsSource, editorSource, stylesSource] = await Promise.all([
    readFile(proposalCardsSource, "utf8"),
    readFile(proposalEditorSource, "utf8"),
    readFile(proposalStylesSource, "utf8"),
  ]);
  expect(cardsSource.match(/<(?:input|textarea)\b/gu) ?? []).toEqual([]);
  expect(editorSource.match(/<(?:input|textarea)\b/gu) ?? []).toEqual([]);
  expect(editorSource.match(/<Input\b/gu) ?? []).toHaveLength(1);
  expect(editorSource.match(/<Select\b/gu) ?? []).toHaveLength(3);
  expect(editorSource.match(/<Textarea\b/gu) ?? []).toHaveLength(6);
  expect(editorSource).not.toContain("SelectControl");
  expect(stylesSource).not.toContain(".ling-ui-");

  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProposalState();
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const proposal = page.getByLabel("Task confirmation");
  await expect(proposal).toBeVisible();
  const collaborationSummary = proposal.locator(".channel-proposal-collaboration summary");
  await expect(collaborationSummary).toBeVisible();
  const transition = await readTransitionStyle(collaborationSummary);
  expect(transition.properties).toEqual(["border-color", "background-color", "box-shadow"]);
  expect(transition.durations.every((duration) => duration === "0.12s")).toBe(true);
  expect(transition.timingFunctions.every((timingFunction) => timingFunction === "cubic-bezier(0.2, 0, 0, 1)")).toBe(true);
  await proposal.getByRole("button", { name: "Edit" }).click();
  const editor = proposal.locator(".channel-proposal-edit-form");
  await expect(editor).toBeVisible();

  const title = editor.getByLabel("Title");
  const scope = editor.getByLabel("Scope");
  const acceptance = editor.getByLabel("Acceptance criteria");
  const requirementSummary = editor.getByLabel("Requirement summary");
  const openQuestions = editor.getByLabel("Open questions");
  const clarifications = editor.getByLabel("User clarifications");
  await expect(title).toHaveAttribute("data-ling-input-native", "true");
  for (const textarea of [scope, acceptance, requirementSummary, openQuestions, clarifications]) {
    await expect(textarea).toHaveAttribute("data-ling-control-native", "true");
  }
  await expect(scope).toHaveAttribute("rows", "4");
  await expect(acceptance).toHaveAttribute("rows", "3");
  await expectInputFocusContained(title);
  await expectTextareaFocusContained(scope);

  const assignee = editor.getByLabel("Assignee", { exact: true });
  await expectSharedSelect(assignee, "md");
  await expect(assignee.locator("option:checked")).toHaveText("Deleted teammate");
  let steps = editor.locator(".channel-proposal-edit-step");
  await expect(steps).toHaveCount(2);
  const firstStepAssignee = steps.first().getByLabel("Assignee 1");
  await expectSharedSelect(firstStepAssignee, "sm");
  await expectSharedSelect(steps.first().getByLabel("Action 1"), "sm");
  await expect(firstStepAssignee.locator("option:checked")).toHaveText("Deleted teammate");

  await assignee.selectOption("teammate_builtin_engineer");
  await steps.first().getByRole("button", { name: "Remove" }).click();
  steps = editor.locator(".channel-proposal-edit-step");
  await expect(steps).toHaveCount(1);
  await expect(steps.first().getByRole("button", { name: "Remove" })).toBeDisabled();
  await steps.first().getByLabel("Assignee 1").selectOption("teammate_builtin_qa");

  await editor.getByRole("button", { name: "Add step" }).click();
  steps = editor.locator(".channel-proposal-edit-step");
  await expect(steps).toHaveCount(2);
  await expect(proposal.getByRole("button", { name: "Save" })).toBeDisabled();
  const addedSummary = steps.nth(1).getByLabel("Summary 2");
  await expect(addedSummary).toHaveAttribute("data-ling-control-native", "true");
  await expect(addedSummary).toHaveAttribute("rows", "2");
  await expectTextareaFocusContained(addedSummary);
  await steps.nth(1).getByLabel("Action 2").selectOption("consulted");

  const longToken = longValue("proposal");
  await title.fill(`UI2 proposal ${longToken}`);
  await scope.fill(`Scope ${longToken}`);
  await acceptance.fill(`Acceptance ${longToken}`);
  await requirementSummary.fill(`Requirement ${longToken}`);
  await openQuestions.fill(`Question ${longToken}`);
  await clarifications.fill(`Clarification ${longToken}`);
  await addedSummary.fill(`Coordinate ${longToken}`);

  await expect(proposal.getByRole("button", { name: "Save" })).toBeEnabled();
  await expectContained(editor);
  await expectDocumentContained(page);
  await captureScreenshot(page, "1440x960-ling-light-channel-proposal-inputs.png");
  await proposal.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);

  await expect.poll(() => {
    const updated = findProposal(state);
    if (!updated || !Array.isArray(updated.collaborationSteps)) {
      return "";
    }
    const [firstStep, secondStep] = updated.collaborationSteps;
    if (!isRecord(firstStep) || !isRecord(secondStep)) {
      return "";
    }
    const firstSources = Array.isArray(firstStep.sources) ? firstStep.sources.length : 0;
    return [
      updated.assigneeTeammateId,
      updated.title,
      updated.prompt,
      firstStep.teammateId,
      firstSources,
      secondStep.teammateId,
      secondStep.action,
      secondStep.summary,
    ].join("|");
  }).toBe([
    "teammate_builtin_engineer",
    `UI2 proposal ${longToken}`,
    `Scope ${longToken}`,
    "teammate_builtin_qa",
    "0",
    "teammate_builtin_engineer",
    "consulted",
    `Coordinate ${longToken}`,
  ].join("|"));

  await expectDocumentContained(page);
  expect(runtimeErrors).toEqual([]);
});

test("proposal validation and cancel reset stay contained in dark reduced-motion mode", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, true);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProposalState();
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  const proposal = page.getByLabel("Task confirmation");
  const collaborationSummary = proposal.locator(".channel-proposal-collaboration summary");
  await expect(collaborationSummary).toBeVisible();
  expect((await readTransitionStyle(collaborationSummary)).durations.every((duration) => duration === "0s")).toBe(true);
  await proposal.getByRole("button", { name: "Edit" }).click();
  const editor = proposal.locator(".channel-proposal-edit-form");
  const title = editor.getByLabel("Title");
  const save = proposal.getByRole("button", { name: "Save" });

  await title.fill(" ");
  await expect(save).toBeDisabled();
  await title.fill("Unsaved dark proposal draft");
  await editor.getByRole("button", { name: "Add step" }).click();
  const steps = editor.locator(".channel-proposal-edit-step");
  await expect(steps).toHaveCount(3);
  await expect(save).toBeDisabled();

  const thirdSummary = steps.nth(2).getByLabel("Summary 3");
  await thirdSummary.fill(longValue("dark-summary"));
  await expect(save).toBeEnabled();
  await expectInputFocusContained(title);
  await expectTextareaFocusContained(thirdSummary);
  await expectContained(editor);
  await expectDocumentContained(page);
  await captureScreenshot(page, "1280x800-ling-dark-channel-proposal-inputs-reduced-motion.png");

  await proposal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await proposal.getByRole("button", { name: "Edit" }).click();
  await expect(proposal.locator(".channel-proposal-edit-form").getByLabel("Title")).toHaveValue("Refine channel proposal inputs");
  await expect(proposal.locator(".channel-proposal-edit-step")).toHaveCount(2);
  await expectDocumentContained(page);
  expect(runtimeErrors).toEqual([]);
});

async function expectSharedSelect(select: Locator, size: "md" | "sm"): Promise<void> {
  await expect(select).toHaveClass(/ling-ui-select-native/u);
  await expect(select).toHaveAttribute("data-ling-control-native", "true");
  const shell = select.locator("xpath=..");
  await expect(shell).toHaveClass(/ling-ui-select/u);
  await expect(shell).toHaveAttribute("data-size", size);
  expect(await shell.evaluate((element) => element.hasAttribute("data-select-control"))).toBe(false);
}

function createProposalState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate(),
    createMockTeammate({
      id: "teammate_builtin_qa",
      templateId: "qa",
      roleKey: "qa",
      displayName: "Ling QA",
      description: "Validates proposal behavior.",
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: "teammate_builtin_engineer" }
      : channel,
  );
  state.teammateChannelMemberships = [
    {
      teammateId: "teammate_builtin_engineer",
      channelId: "channel_engineering",
      isDefault: true,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
    {
      teammateId: "teammate_builtin_qa",
      channelId: "channel_engineering",
      isDefault: false,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_ui2_proposal_input",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "teammate_builtin_engineer",
      body: "Review the editable execution proposal before it starts.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:01.000Z",
      updatedAt: "2026-05-25T00:18:01.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_ui2_input",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_ui2_proposal_input",
      proposedByTeammateId: "teammate_builtin_engineer",
      title: "Refine channel proposal inputs",
      prompt: "Keep proposal editing behavior while adopting shared controls.",
      assigneeTeammateId: "retired_teammate",
      acceptanceCriteria: ["The editable proposal stays valid and contained."],
      collaborationSteps: [
        {
          teammateId: "retired_teammate",
          action: "coordinated",
          summary: "Retain the deleted teammate fallback until reassignment.",
        },
        {
          teammateId: "teammate_builtin_engineer",
          action: "reviewed",
          summary: "Preserve source metadata until the teammate changes.",
          sources: [
            {
              kind: "council",
              councilId: "council_builtin_development",
              councilDisplayName: "Development Council",
              slotKey: "engineer",
              label: "Engineering review",
            },
          ],
        },
      ],
      requiredTools: ["read", "edit"],
      shaping: {
        status: "needs_user_clarification",
        summary: "Clarify the proposal edit scope.",
        openQuestions: ["Which proposal controls are in scope?"],
        clarifications: [
          {
            id: "clarification_ui2_input",
            authorType: "local-user",
            authorId: "ling-local",
            body: "Only migrate the reachable proposal editor.",
            sourceMessageId: "msg_ui2_proposal_input",
            createdAt: "2026-05-25T00:18:02.000Z",
          },
        ],
        sourceRefs: [{ type: "message", id: "msg_ui2_proposal_input" }],
        updatedAt: "2026-05-25T00:18:02.000Z",
      },
      status: "draft",
      createdAt: "2026-05-25T00:18:02.000Z",
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
  ];
  return state;
}

function findProposal(state: MockState): Record<string, unknown> | undefined {
  return state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_ui2_input") as Record<string, unknown> | undefined;
}

async function expectInputFocusContained(input: Locator): Promise<void> {
  const shell = input.locator("xpath=..");
  const before = await readGeometry(input, shell);
  await input.focus();
  const after = await readGeometry(input, shell);
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

async function readTransitionStyle(locator: Locator): Promise<{
  readonly durations: string[];
  readonly properties: string[];
  readonly timingFunctions: string[];
}> {
  return locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      durations: styles.transitionDuration.split(", "),
      properties: styles.transitionProperty.split(", "),
      timingFunctions: styles.transitionTimingFunction.match(/(?:cubic-bezier|steps)\([^)]*\)|[^,\s]+/gu) ?? [],
    };
  });
}

async function prepareSurface(
  page: Page,
  theme: "light" | "dark",
  width: number,
  height: number,
  reducedMotion = false,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
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

function longValue(prefix: string): string {
  return `${prefix}-${"channel-proposal-input-migration-".repeat(30)}end`;
}

async function captureScreenshot(page: Page, fileName: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", caret: "hide", path: `${screenshotDirectory}/${fileName}` });
}

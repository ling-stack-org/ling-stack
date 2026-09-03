import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  isRecord,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-profile/",
  import.meta.url,
));

const avatarFixturePath = fileURLToPath(new URL("../public/avatars/teammates/engineer.png", import.meta.url));

test("standard profile keeps one header action owner and scoped draft lifecycle", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProfileState(createMockTeammate({
    id: "teammate_profile_standard",
    displayName: "Interface Engineer",
    providerPresetId: "provider_ready",
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  const profile = await openProfile(page, "Interface Engineer");
  await expect(profile.getByLabel("Teammate name")).toHaveClass(/ling-ui-input/);
  await expect(profile.getByLabel("Description")).toHaveClass(/ling-ui-textarea/);
  await expect(profile.getByLabel("Status")).toHaveClass(/ling-ui-select/);
  await expect(profile.locator(".teammate-profile-advanced")).not.toHaveAttribute("open", "");
  await expect(page.getByRole("dialog", { name: "Import role profile" })).toHaveCount(0);
  const settingsHeader = page.getByLabel("Single agent settings");
  const resetAction = settingsHeader.getByRole("button", { name: "Reset profile" });
  const saveAction = settingsHeader.getByRole("button", { name: "Save changes" });
  await expect(saveAction).toBeDisabled();
  await expect(saveAction).not.toHaveAttribute("data-ling-icon-button-contract");
  await expect(profile.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);
  await expectTypedIconButton(resetAction, "Reset profile");
  await expect(resetAction).toBeDisabled();
  await captureEvidence(page, "1440x960-ling-light-standard-profile.png");

  const nameInput = profile.getByLabel("Teammate name");
  await nameInput.fill("Temporary name");
  await expect(resetAction).toBeEnabled();
  await expectTypedIconButton(resetAction, "Reset profile");
  await expectIconButtonTooltip(resetAction, "Reset profile");
  await resetAction.focus();
  await expect(resetAction).toBeFocused();
  await expectTypedIconButton(resetAction, "Reset profile");
  await resetAction.click();
  await expect(nameInput).toHaveValue("Interface Engineer");

  await nameInput.fill("Interface Systems Engineer");
  await profile.getByLabel("Description").fill("Owns compact interaction systems and visual regression coverage.");
  const advanced = profile.locator(".teammate-profile-advanced");
  await profile.getByText("Advanced profile", { exact: true }).click();
  await expect(advanced).toHaveAttribute("data-appearance", "plain");
  await expect(advanced).toHaveCSS("border-top-width", "0px");
  await expect(advanced).toHaveCSS("border-bottom-width", "0px");
  await expect(advanced.locator(".ling-ui-inspector-section-body")).toHaveCSS("padding-left", "0px");
  await expect(advanced.locator(".teammate-profile-advanced-body")).toHaveCSS("gap", "16px");
  await expect(profile.getByText("Role profile", { exact: true })).toHaveCount(0);
  const longSystemPrompt = [
    "Keep interaction behavior explicit and verifiable.",
    "Inspect long user-provided context without changing the alignment of the profile form or introducing horizontal overflow.",
    "Preserve actionable evidence after a failed save so the user can correct the draft and retry.",
  ].join("\n\n");
  await profile.getByLabel("System prompt").fill(longSystemPrompt);
  const descriptionBox = await profile.getByLabel("Description").boundingBox();
  const systemPromptBox = await profile.getByLabel("System prompt").boundingBox();
  const importActionBox = await profile.getByRole("button", { name: "Import role profile" }).boundingBox();
  expect(descriptionBox).not.toBeNull();
  expect(systemPromptBox).not.toBeNull();
  expect(importActionBox).not.toBeNull();
  expect(Math.abs((descriptionBox?.x ?? 0) - (systemPromptBox?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((systemPromptBox?.x ?? 0) - (importActionBox?.x ?? 0))).toBeLessThanOrEqual(1);
  const profileBox = await profile.boundingBox();
  const managementBox = await page.getByLabel("Manage teammate").boundingBox();
  expect(profileBox).not.toBeNull();
  expect(managementBox).not.toBeNull();
  expect(Math.abs((managementBox?.y ?? 0) - ((profileBox?.y ?? 0) + (profileBox?.height ?? 0)) - 24)).toBeLessThanOrEqual(1);
  await profile.getByRole("button", { name: "Import role profile" }).scrollIntoViewIfNeeded();
  await captureEvidence(page, "1440x960-ling-light-standard-profile-expanded-long-text.png");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Teammate profile saved", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === "teammate_profile_standard");
    return isRecord(teammate)
      ? [teammate.displayName, teammate.description, teammate.systemPrompt]
      : undefined;
  }).toEqual([
    "Interface Systems Engineer",
    "Owns compact interaction systems and visual regression coverage.",
    longSystemPrompt,
  ]);
  await expect(page.getByText("Teammate profile saved", { exact: true })).toHaveCount(0, { timeout: 5_000 });
  await expect(profile.getByText("Saved", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("protected Ling Agent exposes only approved profile fields in Chinese dark mode", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN" });
  const runtimeErrors = collectRuntimeErrors(page);
  const displayName = "Ling Agent 协调助手超长名称边界验证";
  const state = createProfileState(createMockTeammate({
    id: "ling_agent",
    kind: "system_teammate",
    systemRole: "ling_agent",
    protectedProfile: true,
    displayName,
    providerPresetId: "provider_ready",
    appendSystemPrompt: ["保留当前工作区偏好。"],
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  const profile = await openProfile(page, displayName, {
    details: "显示详情",
    dock: "私聊工作区面板",
    settings: "设置",
    profile: "队友资料",
  });
  await expect(profile.locator(".teammate-profile-protected")).toContainText("受保护的队友");
  await expect(profile.getByText("Ling Agent 的生命周期和权限由 Ling Stack 管理。", { exact: true })).toBeVisible();
  await expect(profile.locator(".teammate-profile-lifecycle")).toHaveCount(0);
  await expect(profile.locator(".teammate-profile-advanced")).toHaveCount(0);
  await expect(profile.getByLabel("附加指令")).toBeVisible();
  await expect(profile.getByLabel("队友名称")).toBeVisible();
  await expect(profile.getByLabel("描述")).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-protected-profile.png");

  await profile.getByLabel("队友名称").fill("Ling Agent 协调助手");
  await profile.getByLabel("附加指令").fill("优先用中文汇报，并保留失败证据。");
  await page.getByLabel("单个智能体设置").getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("队友资料已保存", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === "ling_agent");
    return isRecord(teammate)
      ? [teammate.displayName, teammate.status, teammate.pinned, teammate.hidden, teammate.systemPrompt, teammate.appendSystemPrompt]
      : undefined;
  }).toEqual([
    "Ling Agent 协调助手",
    "active",
    true,
    false,
    "You are the Engineering AI teammate.",
    ["优先用中文汇报，并保留失败证据。"],
  ]);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("avatar choose crop drag zoom cancel upload and remove share the verified dialog", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProfileState(createMockTeammate({
    id: "teammate_profile_avatar",
    displayName: "Avatar Engineer",
    providerPresetId: "provider_ready",
  }));
  await mockDaemon(page, state);
  const uploadGate = deferred<void>();
  await page.route(/\/teammates\/teammate_profile_avatar\/avatar(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "POST") await uploadGate.promise;
    await route.fallback();
  });
  await page.goto("/");

  const profile = await openProfile(page, "Avatar Engineer");
  const avatarOptionsAction = profile.getByRole("button", { name: "Avatar options" });
  await expect(profile.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);
  await expectTypedIconButton(avatarOptionsAction, "Avatar options");
  await expectIconButtonTooltip(avatarOptionsAction, "Avatar options");
  await avatarOptionsAction.click();
  await expect(page.getByRole("menuitem", { name: "Change avatar" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Restore default avatar" })).toBeDisabled();
  await page.keyboard.press("Escape");
  const avatarInput = profile.getByLabel("Upload avatar");
  await avatarInput.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
  await expect(profile.getByText("Choose an image file", { exact: true })).toBeVisible();

  await avatarInput.setInputFiles(avatarFixturePath);
  let cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  await expect(cropDialog).toBeVisible();
  await expect(cropDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const zoom = cropDialog.getByLabel("Zoom");
  await expect(zoom).toBeEnabled();
  await zoom.fill("1.7");
  const cropFrame = cropDialog.getByRole("img", { name: "Avatar crop preview" });
  const box = await cropFrame.boundingBox();
  expect(box).toBeTruthy();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 3 });
    await page.mouse.up();
  }
  await captureEvidence(page, "1440x960-ling-dark-avatar-crop.png");

  await page.keyboard.press("Escape");
  await expect(cropDialog).toHaveCount(0);
  await expect(avatarOptionsAction).toBeFocused();
  await expectTypedIconButton(avatarOptionsAction, "Avatar options");

  await avatarInput.setInputFiles(avatarFixturePath);
  cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  const useAvatarAction = cropDialog.getByRole("button", { name: "Use avatar" });
  await expect(useAvatarAction).toBeEnabled();
  await useAvatarAction.click();
  await expect(cropDialog).toHaveAttribute("aria-busy", "true");
  await expect(useAvatarAction).toBeDisabled();
  await expect(useAvatarAction).toHaveAttribute("aria-busy", "true");
  await expect(useAvatarAction).toHaveAttribute("data-loading", "true");
  uploadGate.resolve();
  await expect(cropDialog).toHaveCount(0);
  await expect(page.getByText("Avatar updated", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === "teammate_profile_avatar");
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : undefined;
  }).toBeTruthy();
  await avatarOptionsAction.click();
  const restoreAvatarAction = page.getByRole("menuitem", { name: "Restore default avatar" });
  await expect(restoreAvatarAction).toBeEnabled();
  await restoreAvatarAction.click();
  await expect(page.getByText("Avatar removed", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === "teammate_profile_avatar");
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : "missing";
  }).toBeUndefined();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("persona import only fills the profile draft and failed save preserves imported values", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    locale: "en-US",
    reducedMotion: "reduce",
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProfileState(createMockTeammate({
    id: "teammate_profile_persona",
    displayName: "Persona Reviewer",
    providerPresetId: "provider_ready",
  }));
  let profileUpdateRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PATCH" && path.endsWith("/teammates/teammate_profile_persona")) {
      profileUpdateRequests += 1;
    }
  });
  await mockDaemon(page, state, { failTeammateProfileUpdates: true });
  await page.goto("/");

  const profile = await openProfile(page, "Persona Reviewer");
  const saveAction = page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" });
  await expect(saveAction).toBeDisabled();
  const advancedTrigger = profile.locator(".teammate-profile-advanced > summary");
  await advancedTrigger.focus();
  await advancedTrigger.press("Enter");
  await expect(profile.locator(".teammate-profile-advanced")).toHaveAttribute("open", "");
  const importRoleProfile = profile.getByRole("button", { name: "Import role profile" });
  await importRoleProfile.focus();
  await importRoleProfile.press("Enter");
  let persona = page.getByRole("dialog", { name: "Import role profile" });
  await persona.getByRole("radio", { name: "Paste content" }).click();
  await persona.getByLabel("Role profile content").fill("# Cancelled Persona\nThis preview must not mutate the profile form.");
  await persona.getByRole("button", { name: "Check content" }).click();
  await expect(persona.getByLabel("Role profile preview")).toBeVisible();
  await persona.getByRole("button", { name: "Cancel" }).click();
  await expect(persona).toHaveCount(0);
  await expect(profile.getByLabel("Teammate name")).toHaveValue("Persona Reviewer");
  await expect(profile.getByLabel("Description")).toHaveValue("Owns scoped implementation in the Engineering channel.");
  await expect(profile.getByLabel("System prompt")).toHaveValue("You are the Engineering AI teammate.");
  await expect(saveAction).toBeDisabled();
  expect(profileUpdateRequests).toBe(0);

  await importRoleProfile.click();
  persona = page.getByRole("dialog", { name: "Import role profile" });
  await persona.getByRole("radio", { name: "Paste content" }).click();
  const importedContent = [
    "# Evidence Reviewer",
    "Review long interface evidence, preserve the user's full draft after a failed save, and keep a concise conclusion.",
    "Keep system instructions explicit across long content so wrapping can be verified without horizontal overflow.",
    "Treat the top-level Save changes action as the only durable submission path.",
    "Do not grant tools, approvals, secrets, or external send permissions.",
  ].join("\n\n");
  await persona.getByLabel("Role profile content").fill(importedContent);
  await persona.getByRole("button", { name: "Check content" }).click();
  await expect(persona.getByLabel("Role profile preview")).toBeVisible();
  await expect(persona.getByText("Permission-like persona text was ignored for authority changes.")).toBeVisible();
  await persona.getByLabel("Role profile preview").scrollIntoViewIfNeeded();
  await captureEvidence(page, "1280x800-ling-dark-persona-preview.png");

  await persona.getByRole("button", { name: "Apply to profile" }).click();
  await expect(persona).toHaveCount(0);
  await expect(profile.getByLabel("Teammate name")).toHaveValue("Evidence Reviewer");
  await expect(profile.getByLabel("Description")).toHaveValue("Review long interface evidence, preserve the user's full draft after a failed save, and keep a concise conclusion.");
  await expect(profile.getByLabel("System prompt")).toHaveValue(importedContent);
  await expect(saveAction).toBeEnabled();
  expect(profileUpdateRequests).toBe(0);
  const durableBeforeSave = state.aiTeammates.find((item) => isRecord(item) && item.id === "teammate_profile_persona");
  expect(isRecord(durableBeforeSave) ? durableBeforeSave.displayName : undefined).toBe("Persona Reviewer");
  await profile.getByRole("button", { name: "Import role profile" }).scrollIntoViewIfNeeded();
  await captureEvidence(page, "1280x800-ling-dark-persona-imported-dirty.png");

  await saveAction.click();
  await expect(profile.getByText("Profile changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expect(profile.getByLabel("Teammate name")).toHaveValue("Evidence Reviewer");
  await expect(profile.getByLabel("Description")).toHaveValue("Review long interface evidence, preserve the user's full draft after a failed save, and keep a concise conclusion.");
  await expect(profile.getByLabel("System prompt")).toHaveValue(importedContent);
  await expect(saveAction).toBeEnabled();
  expect(profileUpdateRequests).toBe(1);
  await captureEvidence(page, "1280x800-ling-dark-persona-imported-save-failure.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("profile save failure stays local, keeps the draft, and does not emit success toast", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProfileState(createMockTeammate({
    id: "teammate_profile_failure",
    displayName: "Failure State Reviewer",
    providerPresetId: "provider_ready",
  }));
  await mockDaemon(page, state, { failTeammateProfileUpdates: true });
  await page.goto("/");

  const profile = await openProfile(page, "Failure State Reviewer");
  const draft = "A deliberately long profile draft that remains editable after the server rejects the save operation.";
  await profile.getByLabel("Description").fill(draft);
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" }).click();
  await expect(profile.getByText("Profile changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expect(profile.getByLabel("Description")).toHaveValue(draft);
  await expect(page.getByText("Teammate profile saved", { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-save-failure.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("avatar and persona failures remain repairable without clearing current input", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createProfileState(createMockTeammate({
    id: "teammate_profile_operation_failure",
    displayName: "Repairable Profile",
    providerPresetId: "provider_ready",
    avatarImageAttachmentId: "avatar_existing",
  }));
  await mockDaemon(page, state, {
    failTeammateAvatarDeletes: true,
    failTeammateAvatarUploads: true,
    failTeammatePersonaDrafts: true,
  });
  await page.goto("/");

  const profile = await openProfile(page, "Repairable Profile");
  await profile.getByText("Advanced profile", { exact: true }).click();
  await profile.getByRole("button", { name: "Import role profile" }).click();
  const persona = page.getByRole("dialog", { name: "Import role profile" });
  await persona.getByRole("radio", { name: "Paste content" }).click();
  await persona.getByLabel("Role profile content").fill("# Repairable persona\nKeep this input after a preview failure.");
  await persona.getByRole("button", { name: "Check content" }).click();
  await expect(persona.getByText("Persona draft could not be prepared. Try again.", { exact: true })).toBeVisible();
  await expect(persona.getByLabel("Role profile content")).toHaveValue(/Repairable persona/u);
  await persona.getByRole("button", { name: "Cancel" }).click();

  await profile.getByLabel("Upload avatar").setInputFiles(avatarFixturePath);
  const cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  await expect(cropDialog.getByRole("button", { name: "Use avatar" })).toBeEnabled();
  await cropDialog.getByRole("button", { name: "Use avatar" }).click();
  await expect(cropDialog.getByText("Avatar changes were not saved. Try again.", { exact: true })).toBeVisible();
  await cropDialog.getByRole("button", { name: "Cancel" }).click();

  await profile.getByRole("button", { name: "Avatar options" }).click();
  await page.getByRole("menuitem", { name: "Restore default avatar" }).click();
  await expect(profile.getByText("Avatar changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createProfileState(teammate: Record<string, unknown>): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ready",
    providerId: "local-relay",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-20T00:00:00.000Z" },
  })];
  state.aiTeammates = [teammate];
  return state;
}

async function openProfile(
  page: Page,
  teammateName: string,
  labels: {
    readonly details: string;
    readonly dock: string;
    readonly settings: string;
    readonly profile: string;
  } = {
    details: "Show details",
    dock: "Private chat workspace dock",
    settings: "Settings",
    profile: "Teammate profile",
  },
): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  const header = page.locator("[data-ui2-teammate-chat-header]");
  await expect(header).toBeVisible();
  if (await page.getByLabel(labels.dock).count() === 0) {
    await header.getByRole("button", { name: labels.details }).click();
  }
  await page.getByLabel(labels.dock).getByRole("button", { name: labels.settings }).click();
  const profile = page.getByLabel(labels.profile);
  await expect(profile).toBeVisible();
  return profile;
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = theme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          className: element.className,
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          overflowY: style.overflowY,
          position: style.position,
        };
      })
      .filter((item) => item.bottom > window.innerHeight + 1 && item.position !== "fixed")
      .sort((left, right) => right.bottom - left.bottom)
      .slice(0, 12),
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function expectTypedIconButton(button: Locator, label: string): Promise<void> {
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
}

async function expectIconButtonTooltip(button: Locator, label: string): Promise<void> {
  const page = button.page();
  await button.hover();
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toHaveCount(0);
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

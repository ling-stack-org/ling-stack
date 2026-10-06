import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createDefaultProviderTemplates,
  createMediaProvider,
  isRecord,
} from "./support/mock-state";

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

async function openProviderRowMenu(row: Locator): Promise<Locator> {
  const trigger = row.getByRole("button", { name: /^(More|更多)$/ });
  await trigger.hover();
  await expect(row.page().getByRole("tooltip")).toBeHidden();
  await trigger.click();
  const menu = row.page().getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function clickProviderRowMenuItem(row: Locator, name: string | RegExp): Promise<void> {
  const menu = await openProviderRowMenu(row);
  await menu.getByRole("menuitem", { name }).click();
}

async function openModelWorkbench(page: Page): Promise<void> {
  await page.getByLabel(/^(Ling Stack navigation|Sidebar display|侧栏显示)$/).getByRole("button", { name: /^(Settings|设置)$/ }).click();
  await page.getByLabel(/^(Settings sections|设置分组)$/).getByRole("button", { name: /^(Model Workbench|模型工作台)$/ }).click();
  await expect(page.getByLabel(/^(Settings sections|设置分组)$/)).toBeVisible();
  await expect(page.getByLabel(/^(Ling Stack navigation|Sidebar display|侧栏显示)$/)).toHaveCount(0);
}

async function expectProviderModelDiscoveryLayout(page: Page): Promise<void> {
  const discovery = page.locator(".provider-model-discovery");
  await expect(discovery.locator(".provider-model-discovery-header .provider-model-actions button")).toHaveCount(1);
  await expect(discovery.locator(".provider-model-discovery-header").getByRole("button", {
    name: /^(Select visible|选择当前可见|Clear selection|清空选择)$/,
  })).toHaveCount(0);
  await expect(discovery.locator(".provider-model-search-row .provider-model-bulk-actions")).toBeVisible();
  const layout = await discovery.evaluate((element) => {
    const grid = element.querySelector(".provider-model-grid");
    const cards = Array.from(element.querySelectorAll(".provider-model-card")).slice(0, 2);
    const firstCard = cards[0];
    const secondCard = cards[1];
    const title = firstCard?.querySelector("strong");
    const usage = firstCard?.querySelector(".provider-model-usage-label");
    const info = firstCard?.querySelector(".provider-model-info");
    const gridRect = grid?.getBoundingClientRect();
    const firstRect = firstCard?.getBoundingClientRect();
    const secondRect = secondCard?.getBoundingClientRect();
    const titleRect = title?.getBoundingClientRect();
    const usageRect = usage?.getBoundingClientRect();
    const infoRect = info?.getBoundingClientRect();
    return {
      columnCount: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      gridOverflowsX: grid ? grid.scrollWidth > grid.clientWidth + 1 : true,
      firstLeft: firstRect?.left ?? 0,
      firstRight: firstRect?.right ?? 0,
      secondLeft: secondRect?.left ?? 0,
      secondTop: secondRect?.top ?? 0,
      firstTop: firstRect?.top ?? 0,
      firstBottom: firstRect?.bottom ?? 0,
      gridLeft: gridRect?.left ?? 0,
      gridRight: gridRect?.right ?? 0,
      titleLeft: titleRect?.left ?? 0,
      titleRight: titleRect?.right ?? 0,
      usageLeft: usageRect?.left ?? 0,
      usageRight: usageRect?.right ?? 0,
      infoRight: infoRect?.right ?? 0,
      cardCount: cards.length,
    };
  });
  expect(layout.columnCount).toBe(1);
  expect(layout.gridOverflowsX).toBe(false);
  expect(layout.firstLeft).toBeGreaterThanOrEqual(layout.gridLeft - 1);
  expect(layout.firstRight).toBeLessThanOrEqual(layout.gridRight + 1);
  expect(layout.titleLeft).toBeGreaterThanOrEqual(layout.firstLeft - 1);
  expect(layout.titleRight).toBeLessThanOrEqual(layout.usageLeft + 1);
  expect(layout.usageRight).toBeLessThanOrEqual(layout.infoRight + 1);
  expect(layout.infoRight).toBeLessThanOrEqual(layout.firstRight + 1);
  if (layout.cardCount > 1) {
    expect(Math.abs(layout.firstLeft - layout.secondLeft)).toBeLessThanOrEqual(1);
    expect(layout.secondTop).toBeGreaterThan(layout.firstBottom - 1);
  }
}

test("the first checked chat model becomes workspace default without replacing it later", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_first_ready",
      displayName: "First Ready Relay",
      model: "gpt-first",
      lastCheck: { ok: true, code: "ready", message: "Ready", checkedAt: "2026-07-30T00:00:00.000Z" },
    }),
    createChatProvider({
      id: "provider_later_ready",
      displayName: "Later Ready Relay",
      model: "gpt-later",
      lastCheck: { ok: true, code: "ready", message: "Ready", checkedAt: "2026-07-30T00:00:00.000Z" },
    }),
  ];
  delete state.workspaceSettings.defaultProviderPresetId;
  await mockDaemon(page, state);
  await page.goto("/");
  await openModelWorkbench(page);

  const firstRow = page.locator(".provider-row").filter({ hasText: "First Ready Relay" });
  await firstRow.getByRole("button", { name: "Check" }).click();
  await expect.poll(() => state.workspaceSettings.defaultProviderPresetId).toBe("provider_first_ready");
  await expect(page.locator(".provider-default-purpose-bar").getByLabel("Chat model")).toHaveValue("provider_first_ready");

  const laterRow = page.locator(".provider-row").filter({ hasText: "Later Ready Relay" });
  await laterRow.getByRole("button", { name: "Check" }).click();
  await expect.poll(() => state.workspaceSettings.defaultProviderPresetId).toBe("provider_first_ready");
  await expect(page.locator(".provider-default-purpose-bar").getByLabel("Chat model")).toHaveValue("provider_first_ready");
  await expect(page.locator(".provider-row").getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);
});

test("model workbench empty state offers beginner chat and generation setup paths", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await openModelWorkbench(page);
  await expect(page.getByText("Add a model route to start using Ling.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add chat model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add image generation model" })).toBeVisible();

  await page.getByRole("button", { name: "Add chat model" }).click();
  const chatEditor = page.getByRole("dialog", { name: "New chat model" });
  await expect(chatEditor).toBeVisible();
  await expect(chatEditor.getByLabel("Model supplier")).toHaveValue("openai-gpt");
  await expect(chatEditor.getByLabel("Model supplier")).not.toContainText("Seedream Image");
  await chatEditor.getByRole("button", { name: "Close model preset editor" }).click();

  await page.getByRole("button", { name: "Add image generation model" }).click();
  const generationEditor = page.getByRole("dialog", { name: "New image generation model" });
  await expect(generationEditor).toBeVisible();
  await expect(generationEditor.getByLabel("Model supplier")).toHaveValue("seedream-image");
  await expect(generationEditor.getByLabel("Model supplier")).not.toContainText("OpenAI GPT");
  await generationEditor.getByText("Advanced settings").click();
  await expect(generationEditor.getByText("Generation adapter")).toBeVisible();
});

test("model workbench Chinese mode localizes setup copy and uses an add model sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_missing_key",
      displayName: "Missing Key Gateway",
      apiKeyConfigured: false,
      apiKeyRef: "env:MISSING_GATEWAY_KEY",
    }),
  ];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await openModelWorkbench(page);
  await expect(page.getByLabel("设置分组").getByRole("button", { name: "模型工作台" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "模型工作台", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "模型预设" })).toHaveCount(0);
  await expect(page.locator(".provider-table")).toBeVisible();
  const tableOverflow = await page.locator(".provider-table-shell").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(tableOverflow.scrollWidth).toBeLessThanOrEqual(tableOverflow.clientWidth + 1);
  await expect(page.getByText("上一页")).toHaveCount(0);
  await expect(page.getByText("下一页")).toHaveCount(0);
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
  await expect(page.locator(".provider-row")).toHaveCount(1);
  await expect(page.locator(".provider-table-footer")).toContainText("1 个模型");
  const workbenchBounds = await page.locator(".provider-workbench").evaluate((workbench) => {
    const workspaceElement = workbench.closest(".settings-content-stack") ?? workbench.closest(".workspace");
    const workspace = workspaceElement?.getBoundingClientRect();
    const rect = workbench.getBoundingClientRect();
    const style = workspaceElement ? getComputedStyle(workspaceElement) : undefined;
    const contentLeft = workspace && style && workspaceElement
      ? workspace.left + workspaceElement.clientLeft + Number.parseFloat(style.paddingLeft)
      : undefined;
    const contentRight = workspace && style && workspaceElement
      ? workspace.left + workspaceElement.clientLeft + workspaceElement.clientWidth - Number.parseFloat(style.paddingRight)
      : undefined;
    return contentLeft !== undefined && contentRight !== undefined
      ? {
        workspaceContent: { left: contentLeft, right: contentRight },
        workbench: { left: rect.left, right: rect.right },
      }
      : undefined;
  });
  expect(workbenchBounds).toBeDefined();
  expect(workbenchBounds?.workbench.left).toBeGreaterThanOrEqual((workbenchBounds?.workspaceContent.left ?? 0) - 1.5);
  expect(workbenchBounds?.workbench.right).toBeLessThanOrEqual((workbenchBounds?.workspaceContent.right ?? 0) + 1.5);
  expect(workbenchBounds ? workbenchBounds.workspaceContent.right - workbenchBounds.workbench.right : 0).toBeLessThanOrEqual(12);
  await expect(page.locator(".workspace-head .status-badge")).toHaveCount(0);
  await expect(page.locator(".provider-page-meta")).toHaveCount(0);
  await expect(page.getByText("Chat-capable")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加模型" })).toBeVisible();
  await expect(page.getByText("修复队列")).toHaveCount(0);
  await expect(page.getByText("Repair queue")).toHaveCount(0);
  await expect(page.getByText("MISSING_GATEWAY_KEY")).toHaveCount(0);
  await expect(page.getByText("env:", { exact: false })).toHaveCount(0);
  await expect(page.getByText("New preset")).toHaveCount(0);
  await expect(page.getByLabel("Model Workbench context")).toHaveCount(0);
  const missingKeyGatewayRow = page.locator(".provider-row").filter({ hasText: "Missing Key Gateway" });
  await expect(missingKeyGatewayRow.getByRole("button", { name: "添加 API Key" })).toBeVisible();
  const missingKeyStatusHint = missingKeyGatewayRow.locator(".provider-status-hint");
  await expect(missingKeyStatusHint).toBeVisible();
  await missingKeyStatusHint.hover();
  await expect(page.getByRole("tooltip")).toContainText("Missing Key Gateway");
  const missingKeyMenu = await openProviderRowMenu(missingKeyGatewayRow);
  await expect(missingKeyMenu.getByRole("menuitem", { name: "停用" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(missingKeyMenu).toBeHidden();
  await expect(missingKeyGatewayRow.getByRole("button", { name: "更多" })).toBeFocused();
  await expect(missingKeyGatewayRow.getByRole("button", { name: "使用" })).toHaveCount(0);
  const tableLayout = await missingKeyGatewayRow.evaluate((row) => {
    const cells = Array.from(row.children).map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return cells;
  });
  for (let index = 0; index < tableLayout.length - 2; index += 1) {
    expect(tableLayout[index].right).toBeLessThanOrEqual(tableLayout[index + 1].left + 0.5);
  }
  await expect(missingKeyGatewayRow.locator(".provider-actions")).toBeVisible();
  await expect(missingKeyGatewayRow.locator(".provider-actions")).toHaveCSS("opacity", "1");
  await missingKeyGatewayRow.hover();
  const actionLayout = await missingKeyGatewayRow.evaluate((row) => {
    const actionCell = row.children[row.children.length - 1]?.getBoundingClientRect();
    const actions = row.querySelector(".provider-actions")?.getBoundingClientRect();
    return actionCell && actions
      ? {
        actionCell: { left: actionCell.left, right: actionCell.right },
        actions: { left: actions.left, right: actions.right },
      }
      : undefined;
  });
  expect(actionLayout).toBeDefined();
  expect(actionLayout?.actions.left).toBeGreaterThanOrEqual((actionLayout?.actionCell.left ?? 0) - 0.5);
  expect(actionLayout?.actions.right).toBeLessThanOrEqual((actionLayout?.actionCell.right ?? 0) + 0.5);
  await page.locator(".provider-table-shell").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const stickyActionLayout = await missingKeyGatewayRow.evaluate((row) => {
    const shell = row.closest(".provider-table-shell")?.getBoundingClientRect();
    const actionCell = row.children[row.children.length - 1]?.getBoundingClientRect();
    return shell && actionCell
      ? {
        shell: { left: shell.left, right: shell.right },
        actionCell: { left: actionCell.left, right: actionCell.right },
      }
      : undefined;
  });
  expect(stickyActionLayout).toBeDefined();
  expect(stickyActionLayout?.actionCell.right).toBeLessThanOrEqual((stickyActionLayout?.shell.right ?? 0) + 1);
  expect(stickyActionLayout?.actionCell.left).toBeGreaterThanOrEqual((stickyActionLayout?.shell.left ?? 0) - 1);
  const shellHeights = await page.locator(".provider-workbench").evaluate((workbench) => {
    const shell = workbench.querySelector(".provider-table-shell");
    const rect = workbench.getBoundingClientRect();
    const shellRect = shell?.getBoundingClientRect();
    return shellRect
      ? {
        workbenchHeight: rect.height,
        shellHeight: shellRect.height,
      }
      : undefined;
  });
  expect(shellHeights).toBeDefined();
  expect(shellHeights?.shellHeight ?? 0).toBeGreaterThan(64);
  expect(shellHeights?.shellHeight ?? 0).toBeLessThanOrEqual(shellHeights?.workbenchHeight ?? 0);

  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await expect(editor).toBeVisible();
  const editorBox = await editor.boundingBox();
  const viewport = page.viewportSize();
  expect(editorBox).not.toBeNull();
  expect(editorBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(editorBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(720);
  expect((editorBox?.x ?? 0) + (editorBox?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 1280);
  expect(Math.abs(
    (editorBox?.x ?? 0) - ((viewport?.width ?? 1280) - ((editorBox?.x ?? 0) + (editorBox?.width ?? 0))),
  )).toBeLessThanOrEqual(2);
  expect(editorBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((editorBox?.y ?? 0) + (editorBox?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 720);
  const editorBody = editor.locator(".provider-sheet-body");
  await expect(editorBody).toHaveCSS("overflow-y", "auto");
  const [editorHeaderBox, editorBodyBox, editorFooterBox] = await Promise.all([
    editor.locator(".provider-sheet-header").boundingBox(),
    editorBody.boundingBox(),
    editor.locator(".provider-sheet-footer").boundingBox(),
  ]);
  expect(editorHeaderBox).not.toBeNull();
  expect(editorBodyBox).not.toBeNull();
  expect(editorFooterBox).not.toBeNull();
  expect((editorHeaderBox?.y ?? 0) + (editorHeaderBox?.height ?? 0)).toBeLessThanOrEqual((editorBodyBox?.y ?? 0) + 1);
  expect((editorBodyBox?.y ?? 0) + (editorBodyBox?.height ?? 0)).toBeLessThanOrEqual((editorFooterBox?.y ?? 0) + 1);
  const editorTitle = editor.getByRole("heading", { name: "新建预设" });
  const editorCloseButton = editor.getByRole("button", { name: "关闭模型预设编辑器" });
  const savePresetButton = editor.getByRole("button", { name: "添加模型" });
  const supplierSelect = editor.getByLabel("模型供应商");

  await expect(editor.getByRole("tab")).toHaveCount(0);
  await expect(editor.locator(".provider-template-card")).toHaveCount(0);
  await expect(editor.locator(".provider-template-panel")).toHaveCount(0);
  await expect(editor.getByText("选择模型供应商")).toHaveCount(0);
  await expect(supplierSelect).toBeVisible();
  await expect(supplierSelect).toContainText("自定义");
  await expect(supplierSelect).toContainText("OpenAI GPT");
  await expect(supplierSelect).toContainText("Claude");
  await expect(supplierSelect).toContainText("豆包 Ark");
  await expect(supplierSelect).toContainText("Seedream 图片");
  await expect(supplierSelect).toContainText("阿里百炼 Qwen");
  await expect(supplierSelect).toContainText("Moonshot Kimi");
  await expect(supplierSelect).toContainText("百度千帆 ERNIE");
  await expect(supplierSelect).toContainText("腾讯混元");
  await expect(supplierSelect).toContainText("SiliconFlow");
  await expect(supplierSelect).toContainText("阶跃星辰 StepFun");
  await expect(supplierSelect).toContainText("百川智能");
  await expect(supplierSelect).toContainText("零一万物 Yi");
  await expect(editor.getByLabel("提供商 ID")).toHaveCount(0);
  await expect(editor.locator(".provider-capability-state")).toHaveCount(0);
  await expect(editor.getByRole("tab", { name: /OpenAI-compatible 中转/ })).toHaveCount(0);

  await supplierSelect.selectOption("openai-gpt");
  await editor.getByText("高级设置").click();
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await supplierSelect.selectOption("anthropic-claude");
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await expect(supplierSelect).toContainText("智谱 GLM");
  await supplierSelect.selectOption("doubao-ark");
  await expect(page.getByLabel("提供商名称")).toHaveValue("豆包 Ark");
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await supplierSelect.selectOption("alibaba-bailian-qwen");
  await expect(page.getByLabel("提供商名称")).toHaveValue("阿里百炼 Qwen");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://dashscope.aliyuncs.com/compatible-mode/v1");
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await expect(supplierSelect).toContainText("Seedance 视频");
  await supplierSelect.selectOption("seedream-image");
  await expect(page.getByLabel("提供商名称")).toHaveValue("Seedream 图片");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://ark.cn-beijing.volces.com/api/v3");
  await expect(page.getByText("运行适配器")).toBeVisible();
  await expect(page.getByText("生成适配器")).toBeVisible();
  await expect(page.getByLabel("API 协议")).toHaveCount(0);

  await supplierSelect.selectOption("custom-openai-compatible");
  await expect(supplierSelect).toHaveValue("custom-openai-compatible");
  await expect(page.getByLabel("提供商名称")).toHaveValue("自定义");
  await expect(page.getByLabel("API 协议")).toBeEnabled();
  await expect(page.getByText("高级 env/keychain")).toHaveCount(0);
  await expect(page.getByText("env:OPENAI_API_KEY")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() => getComputedStyle(document.body).overflow),
  ).toBe("hidden");

  const titleBeforeScroll = await editorTitle.boundingBox();
  const closeBeforeScroll = await editorCloseButton.boundingBox();
  const saveBeforeScroll = await savePresetButton.boundingBox();
  await editorBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(editorTitle).toBeVisible();
  await expect(editorCloseButton).toBeVisible();
  await expect(savePresetButton).toBeVisible();
  const titleAfterScroll = await editorTitle.boundingBox();
  const closeAfterScroll = await editorCloseButton.boundingBox();
  const saveAfterScroll = await savePresetButton.boundingBox();
  expect(titleBeforeScroll).not.toBeNull();
  expect(closeBeforeScroll).not.toBeNull();
  expect(saveBeforeScroll).not.toBeNull();
  expect(titleAfterScroll).not.toBeNull();
  expect(closeAfterScroll).not.toBeNull();
  expect(saveAfterScroll).not.toBeNull();
  expect(Math.abs((titleAfterScroll?.y ?? 0) - (titleBeforeScroll?.y ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((closeAfterScroll?.y ?? 0) - (closeBeforeScroll?.y ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((saveAfterScroll?.y ?? 0) - (saveBeforeScroll?.y ?? 0))).toBeLessThanOrEqual(2);
  await expect(page.getByText("Check provider")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "添加模型" })).toHaveCount(1);
  await expect(editor.getByRole("button", { name: "创建预设" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存修改" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存并检查" })).toHaveCount(0);
});

test("model workbench hides capability state row while keeping advanced overrides", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    templates: createDefaultProviderTemplates(),
  });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "Add model" }).first().click();
  const editor = page.getByRole("dialog", { name: "New preset" });
  await expect(editor).toBeVisible();
  const supplierSelect = editor.getByLabel("Model supplier");

  await expect(editor.locator(".provider-capability-state")).toHaveCount(0);
  await supplierSelect.selectOption("custom-openai-compatible");
  await expect(editor.getByLabel("Context")).toBeHidden();
  await expect(editor.getByLabel("Max tokens")).toBeHidden();

  await editor.getByText("Advanced settings").click();
  await editor.getByLabel("Context").fill("64000");
  await expect(editor.locator(".provider-capability-state")).toHaveCount(0);

  await supplierSelect.selectOption("openai-gpt");
  await expect(editor.getByLabel("Context")).toHaveValue("");
  await expect(editor.getByLabel("Max tokens")).toHaveValue("");

  await page.getByRole("textbox", { name: "Model", exact: true }).fill("gpt-family-preview-unknown");
  await expect(editor.locator(".provider-capability-state")).toHaveCount(0);
});

test("model workbench localizes unsupported daemon model discovery errors", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    templates: createDefaultProviderTemplates(),
    providerModelsUnsupported: true,
  });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "添加模型" }).first().click();
  await page.getByLabel("模型供应商").selectOption("custom-openai-compatible");
  await page.getByLabel("API Key", { exact: true }).fill("test-visible-key");
  await page.getByRole("button", { name: "获取模型" }).click();

  await expect(page.getByText("当前本地服务版本不支持获取模型，请停止旧服务后重新启动项目。")).toBeVisible();
  await expect(page.getByText("No route for POST /provider-models")).toHaveCount(0);
});

test("model workbench keeps model discovery network failures productized", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    templates: createDefaultProviderTemplates(),
  });
  await page.route("**/provider-models?*", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: "network_failed",
        message: "Provider model discovery failed: The operation was aborted due to timeout",
      }),
    });
  });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "添加模型" }).first().click();
  await page.getByLabel("模型供应商").selectOption("custom-openai-compatible");
  await page.getByLabel("API Key", { exact: true }).fill("test-visible-key");
  await page.getByRole("button", { name: "获取模型" }).click();

  await expect(page.getByText("无法连接模型供应商。请检查 Base URL、代理或本地中转后重试。")).toBeVisible();
  await expect(page.getByText("Provider model discovery failed: The operation was aborted due to timeout")).toHaveCount(0);
});

test("model import dialog keeps its footer attached without an empty trailing panel", async ({ page }) => {
  await page.setViewportSize({ width: 1426, height: 912 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    templates: createDefaultProviderTemplates(),
  });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await editor.getByLabel("模型供应商").selectOption("custom-openai-compatible");
  await editor.getByLabel("API Key", { exact: true }).fill("test-visible-key");
  await editor.getByRole("button", { name: "获取模型" }).click();

  const modelCards = editor.locator(".provider-model-card");
  await expect(modelCards).toHaveCount(10);
  await modelCards.filter({ hasText: "cliproxy-gpt-4o" }).click();
  await modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" }).click();
  await expect(editor.getByText("已选 2 个")).toBeVisible();
  await editor.locator(".provider-sheet-body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  const layout = await editor.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".provider-sheet-body");
    const footer = element.querySelector<HTMLElement>(".provider-sheet-footer");
    const modelGrid = element.querySelector<HTMLElement>(".provider-model-grid");
    if (!body || !footer || !modelGrid) return undefined;
    const dialogRect = element.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      trailingGap: dialogRect.bottom - footerRect.bottom,
      dialogHeight: dialogRect.height,
      bodyBottomGap: footerRect.top - bodyRect.bottom,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      modelGridClientHeight: modelGrid.clientHeight,
      modelGridScrollHeight: modelGrid.scrollHeight,
    };
  });

  expect(layout).toBeDefined();
  expect(layout?.trailingGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2);
  expect(Math.abs(layout?.bodyBottomGap ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1);
  expect(layout?.dialogHeight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(880);
  expect(layout?.bodyScrollHeight ?? 0).toBeGreaterThan(layout?.bodyClientHeight ?? 0);
  expect(layout?.modelGridScrollHeight ?? 0).toBeGreaterThan(layout?.modelGridClientHeight ?? 0);
});

test("model workbench save validates before persisting and keeps errors inside the sheet", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await expect(editor).toBeVisible();
  await editor.getByLabel("模型供应商").selectOption("custom-openai-compatible");
  await editor.getByRole("button", { name: "添加模型" }).click();

  await expect(editor.getByText("请填写 API Key 后再保存。")).toBeVisible();
  await expect(editor.getByText("API key missing. Add an API key before running a live check.")).toHaveCount(0);
  await expect(page.locator(".provider-list-panel > .inline-error")).toHaveCount(0);
  await expect.poll(() =>
    state.providers.some((provider) => isRecord(provider) && provider.displayName === "Custom")
  ).toBe(false);
});

test("model workbench imports Doubao supplier models without hiding media-looking IDs", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, {
    templates: createDefaultProviderTemplates(),
    providerCheckModelUnsupportedProviderIds: ["doubao"],
  });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await editor.getByLabel("模型供应商").selectOption("doubao-ark");
  await page.getByLabel("API Key", { exact: true }).fill("ark-test-key");
  await page.getByRole("button", { name: "获取模型" }).click();

  const modelCards = page.locator(".provider-model-card");
  await expect(modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-260128" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedance-1-0-pro-250528" })).toBeVisible();
  await expectProviderModelDiscoveryLayout(page);
  await modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" }).click();
  await modelCards.filter({ hasText: "doubao-seedream-5-0-260128" }).click();
  await expect(page.getByText("已选 2 个")).toBeVisible();
  await expect(page.getByText("已隐藏", { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: /导入选中模型.*2/ }).click();

  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="model-workbench:model-import"]')).toContainText("已导入 2 个模型预设。");
  await expect(page.locator(".provider-batch-result.ok")).toHaveCount(0);
  await expect(page.getByText(/Provider rejected the endpoint or model/)).toHaveCount(0);
  const doubaoChatRow = page.locator(".provider-row").filter({ hasText: "doubao-1-5-pro-32k-250115" });
  const doubaoImageRow = page.locator(".provider-row").filter({ hasText: "doubao-seedream-5-0-260128" });
  await expect(doubaoChatRow).toBeVisible();
  await expect(doubaoImageRow).toBeVisible();
  await expect(doubaoChatRow).not.toContainText("当前默认");
  await expect.poll(() =>
    state.providers.filter((provider) =>
      isRecord(provider) &&
      provider.providerId === "doubao" &&
      typeof provider.model === "string" &&
      provider.model.startsWith("doubao-") &&
      typeof provider.apiKeyRef === "string" &&
      provider.apiKeyRef.startsWith("local:")
    ).length
  ).toBe(2);
  await expect.poll(() =>
    state.channels.every((channel) =>
      !isRecord(channel) ||
      channel.defaultProviderPresetId !== state.providers.find((provider) => isRecord(provider) && provider.providerId === "doubao")?.id
    )
  ).toBe(true);
});

test("model workbench media suppliers stay in the unified supplier picker", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "添加模型" }).first().click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  const supplierSelect = page.getByLabel("模型供应商");
  await supplierSelect.selectOption("seedream-image");
  await page.getByLabel("API Key", { exact: true }).fill("ark-media-key");

  const fetchModels = page.getByRole("button", { name: "获取模型" });
  await expect(fetchModels).toBeEnabled();
  await fetchModels.click();

  const modelCards = page.locator(".provider-model-card");
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-260128" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-turbo-260128" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedance-1-0-pro-250528" })).toBeVisible();
  await expect(page.getByText("已隐藏", { exact: false })).toHaveCount(0);

  await supplierSelect.selectOption("seedance-video");
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("ark-media-key");
  await expect(page.getByLabel("提供商 ID")).toHaveCount(0);
  await expect(page.getByLabel("能力", { exact: true })).toHaveValue("video_generate");
  const refetchedModels = page.getByRole("button", { name: "获取模型" });
  await expect(refetchedModels).toBeEnabled();
  await refetchedModels.click();
  await expect(modelCards.filter({ hasText: "doubao-seedance-1-0-pro-250528" })).toHaveCount(1);
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-260128" })).toHaveCount(1);
  await expect(modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" })).toHaveCount(1);
});

test("model workbench edits media presets from the unified supplier picker", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createMediaProvider({
      id: "provider_seedream",
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      model: "doubao-seedream-5-0-260128",
    }),
    createMediaProvider({
      id: "provider_seedance",
      kind: "seedance",
      displayName: "Seedance Video",
      providerId: "seedance",
      model: "doubao-seedance-1-0-pro-250528",
      capabilities: ["video_generate"],
    }),
  ];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await openModelWorkbench(page);
  const seedreamRow = page.locator(".provider-row").filter({ hasText: "Seedream Image" });
  await seedreamRow.getByRole("button", { name: "编辑" }).click();
  const editor = page.getByRole("dialog", { name: "编辑预设" });
  await expect(editor.getByRole("tab")).toHaveCount(0);
  await expect(editor.getByLabel("模型供应商")).toHaveValue("seedream-image");
  await expect(editor.getByLabel("提供商 ID")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭模型预设编辑器" }).click();

  const seedanceRow = page.locator(".provider-row").filter({ hasText: "Seedance Video" });
  await seedanceRow.getByRole("button", { name: "编辑" }).click();
  const seedanceEditor = page.getByRole("dialog", { name: "编辑预设" });
  await expect(seedanceEditor.getByRole("tab")).toHaveCount(0);
  await expect(seedanceEditor.getByLabel("模型供应商")).toHaveValue("seedance-video");
  await expect(seedanceEditor.getByLabel("提供商 ID")).toHaveCount(0);
});

test("model workbench creates custom OpenAI-compatible presets and surfaces readiness", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_missing_key",
      displayName: "Missing Key Gateway",
      apiKeyConfigured: false,
      apiKeyRef: "env:MISSING_GATEWAY_KEY",
    }),
    createChatProvider({
      id: "provider_unchecked",
      displayName: "Unchecked Domestic Gateway",
      providerId: "domestic-gateway",
      model: "domestic-chat",
      baseUrl: "https://domestic.example.com/v1",
    }),
    createChatProvider({
      id: "provider_failed",
      displayName: "Auth Failed Gateway",
      lastCheck: {
        ok: false,
        code: "auth_failed",
        message: "Invalid API key.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Local Relay",
      updatedAt: "2026-05-25T00:05:00.000Z",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
    createChatProvider({
      id: "provider_legacy_openai",
      kind: "openai",
      displayName: "Legacy OpenAI Without Stored Endpoint",
      providerId: "openai",
      model: "gpt-5.4",
      api: "openai-completions",
      baseUrl: undefined,
    }),
    createChatProvider({
      id: "provider_openai_proxy",
      kind: "openai",
      displayName: "OpenAI Proxy Custom Endpoint",
      providerId: "openai",
      model: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "http://192.168.80.114:8317/v1",
      updatedAt: "2026-05-25T00:30:00.000Z",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
    createMediaProvider({
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Generation model configuration check passed.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  await mockDaemon(page, state, {
    templates: [
      {
        templateId: "openai-gpt",
        description: "Official OpenAI endpoint.",
        kind: "openai",
        displayName: "OpenAI GPT",
        providerId: "openai",
        model: "gpt-5.4",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        apiKeyRef: "env:OPENAI_API_KEY",
        capabilities: ["chat", "tool_call", "reasoning"],
        input: ["text"],
        enabled: false,
        authHeader: true,
        reasoning: true,
      },
      {
        templateId: "anthropic-claude",
        description: "Official Anthropic endpoint.",
        kind: "anthropic",
        displayName: "Claude",
        providerId: "anthropic",
        model: "claude-sonnet-4-5",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyRef: "env:ANTHROPIC_API_KEY",
        capabilities: ["chat", "tool_call", "reasoning"],
        input: ["text"],
        enabled: false,
        authHeader: true,
        reasoning: true,
      },
    ],
  });
  await page.goto("/");

  await openModelWorkbench(page);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.locator(".provider-page-meta")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const readyLocalRelayRow = page.locator(".provider-row").filter({ hasText: "Ready Local Relay" });
  await expect(readyLocalRelayRow).toBeVisible();

  const missingKeyGatewayRow = page.locator(".provider-row").filter({ hasText: "Missing Key Gateway" });
  await expect(missingKeyGatewayRow).toContainText("Needs API key");
  await expect(missingKeyGatewayRow.locator(".provider-state.enabled")).toHaveCount(0);
  await expect(missingKeyGatewayRow.locator(".provider-state.key-missing")).toHaveCount(1);
  await expect(missingKeyGatewayRow.locator(".provider-state.run-blocked")).toHaveCount(0);
  await expect(missingKeyGatewayRow.locator(".provider-state.check-bad")).toHaveCount(0);
  await expect(page.locator(".provider-row").filter({ hasText: "Unchecked Domestic Gateway" })).toContainText("Needs check");
  await expect(page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" })).toContainText("Needs attention");
  await expect(readyLocalRelayRow).toContainText("Ready");
  await expect(readyLocalRelayRow.locator(".provider-state.run-ready")).toHaveCount(1);
  const defaultUses = page.locator(".provider-default-purpose-bar");
  await defaultUses.getByLabel("Chat model").selectOption("provider_ready");
  await expect(defaultUses.getByLabel("Chat model")).toHaveValue("provider_ready");
  await expect(page.locator(".provider-row").getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);
  const readyLocalRelayActionCell = readyLocalRelayRow.locator("td").nth(3);
  await expect(readyLocalRelayActionCell).toHaveCSS("border-left-width", "0px");
  await expect(readyLocalRelayActionCell).toHaveCSS("box-shadow", "none");
  await defaultUses.getByLabel("Chat model").selectOption("");
  await expect.poll(() => state.workspaceSettings.defaultProviderPresetId).toBeUndefined();
  await expect.poll(() =>
    state.channels.every((channel) => !isRecord(channel) || channel.defaultProviderPresetId === "provider_ready")
  ).toBe(true);
  await expect(page.locator(".provider-row").first()).toContainText("OpenAI Proxy Custom Endpoint");
  await expect(readyLocalRelayRow.locator(".provider-state.run-ready")).toHaveCount(1);
  await expect(readyLocalRelayRow.locator(".provider-state.disabled")).toHaveCount(0);
  const seedreamRow = page.locator(".provider-row").filter({ hasText: "Seedream Image" });
  await expect(seedreamRow).not.toContainText("Media task");
  await expect(seedreamRow).toContainText("Image");
  await expect(seedreamRow).not.toContainText("not chat-capable");
  await expect(seedreamRow.locator(".provider-action-note")).toHaveCount(0);
  await expect(seedreamRow).toContainText("Ready");
  await expect(seedreamRow.getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);
  const legacyOpenAiRow = page.locator(".provider-row").filter({ hasText: "Legacy OpenAI Without Stored Endpoint" });
  await expect(legacyOpenAiRow).not.toContainText("https://api.openai.com/v1");
  await legacyOpenAiRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.openai.com/v1");
  await expect(page.getByLabel("Provider ID")).toHaveCount(0);
  await expect(page.getByLabel("API protocol")).toBeDisabled();
  await page.getByRole("button", { name: "Close model preset editor" }).click();
  const openAiProxyRow = page.locator(".provider-row").filter({ hasText: "OpenAI Proxy Custom Endpoint" });
  await openAiProxyRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await expect(page.getByLabel("Base URL")).toHaveValue("http://192.168.80.114:8317/v1");
  await expect(page.getByLabel("Provider ID")).toHaveCount(0);
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await page.getByRole("button", { name: "Close model preset editor" }).click();
  await defaultUses.getByLabel("Chat model").selectOption("provider_openai_proxy");
  await expect.poll(() => state.workspaceSettings.defaultProviderPresetId).toBe("provider_openai_proxy");
  await expect(openAiProxyRow.locator(".provider-state.run-ready")).toHaveCount(1);
  await expect(readyLocalRelayRow.locator(".provider-state.run-ready")).toHaveCount(1);

  await page.reload();
  await openModelWorkbench(page);
  const reloadedOpenAiProxyRow = page.locator(".provider-row").filter({ hasText: "OpenAI Proxy Custom Endpoint" });
  await expect(page.locator(".provider-default-purpose-bar").getByLabel("Chat model")).toHaveValue("provider_openai_proxy");
  await expect(reloadedOpenAiProxyRow.locator(".provider-state.run-ready")).toHaveCount(1);
  await clickProviderRowMenuItem(reloadedOpenAiProxyRow, "Disable");
  await expect(reloadedOpenAiProxyRow.locator(".provider-state.disabled")).toHaveCount(0);
  await expect(page.locator(".provider-default-purpose-bar").getByLabel("Chat model")).toHaveValue("provider_openai_proxy");
  await expect(page.getByText(/Provider is still used by Workspace default model/)).toBeVisible();
  await expect.poll(() => state.workspaceSettings.defaultProviderPresetId).toBe("provider_openai_proxy");
  await expect(page.getByText(/Ready: .* passed preflight/)).toHaveCount(0);
  await expect(page.getByText("All saved chat providers are either preflight-ready or intentionally out of the run path.")).toHaveCount(0);

  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByRole("dialog", { name: "New preset" })).toBeVisible();
  const supplierSelect = page.getByLabel("Model supplier");
  await expect(page.locator(".provider-template-card")).toHaveCount(0);
  await expect(page.locator(".provider-template-panel")).toHaveCount(0);
  await supplierSelect.selectOption("custom-openai-compatible");
  await expect(supplierSelect).toHaveValue("custom-openai-compatible");
  await expect(page.getByRole("tab", { name: /OpenAI-compatible relay/ })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await supplierSelect.selectOption("openai-gpt");
  await expect(supplierSelect).toContainText("Claude");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.openai.com/v1");
  await expect(page.getByLabel("API protocol")).toBeDisabled();
  await supplierSelect.selectOption("anthropic-claude");
  await expect(supplierSelect).toContainText("OpenAI GPT");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.anthropic.com/v1");
  await expect(page.getByLabel("API protocol")).toBeDisabled();
  await expect(page.getByLabel("Enabled")).toHaveCount(0);
  await supplierSelect.selectOption("custom-openai-compatible");
  await expect(supplierSelect).toHaveValue("custom-openai-compatible");
  await expect(page.getByLabel("Provider name")).toHaveValue("Custom");
  await expect(page.getByLabel("Provider ID")).toHaveCount(0);
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.example.com/v1");
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await page.getByLabel("API key", { exact: true }).fill("test-visible-key");
  const apiKeyVisibilityButton = page.getByRole("button", { name: "Show API key" });
  await expect(apiKeyVisibilityButton.locator(".lucide-eye-off")).toBeVisible();
  await apiKeyVisibilityButton.click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  const hideApiKeyButton = page.getByRole("button", { name: "Hide API key" });
  await expect(hideApiKeyButton.locator(".lucide-eye")).toBeVisible();
  await hideApiKeyButton.click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Clear API key" })).toHaveCount(0);
  const inlineClearButton = page.locator(".provider-secret-input .provider-secret-clear");
  await expect(inlineClearButton).toBeVisible();
  await expect(page.getByText("Advanced env/keychain")).toHaveCount(0);
  await expect(page.getByText("env:CUSTOM_MODEL_API_KEY")).toHaveCount(0);
  await page.getByRole("button", { name: "Fetch models" }).click();
  const modelCards = page.locator(".provider-model-card");
  await expect(modelCards).toHaveCount(10);
  await expect(modelCards.filter({ hasText: "Custom model" })).toHaveCount(0);
  await expect(modelCards.filter({ hasText: "cliproxy-gpt-4o" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "cliproxy-gpt-4o" })).toContainText("No thinking");
  await expect(modelCards.filter({ hasText: "gpt-image-2" }).locator(".provider-model-usage-label")).toContainText(/image/i);
  await expect(modelCards.filter({ hasText: "black-forest-labs/flux-2-pro" })).toContainText(/Image.*Ling catalog/i);
  await expect(modelCards.filter({ hasText: "stability-ai/stable-diffusion-3.5-large" })).toContainText(/Image.*Ling catalog/i);
  await expect(modelCards.filter({ hasText: "qwen-image-edit" })).toContainText(/Image.*Ling catalog/i);
  await expect(modelCards.filter({ hasText: "ideogram-ai/ideogram-v3-quality" })).toContainText(/Image.*Ling catalog/i);
  await expect(modelCards.filter({ hasText: "gpt-image-2" })).toContainText("No thinking");
  await expect(modelCards.filter({ hasText: "cliproxy-claude-sonnet" })).toContainText("Thinking: Low / Medium / High / XHigh");
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-260128" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedance-1-0-pro-250528" })).toBeVisible();
  await expectProviderModelDiscoveryLayout(page);
  await expect(page.getByText("media models are hidden", { exact: false })).toHaveCount(0);
  await modelCards.filter({ hasText: "cliproxy-gpt-4o" }).click();
  await modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toHaveValue("your-model-id");
  await expect(page.getByLabel("API protocol")).toHaveValue("openai-completions");
  await expect(page.getByLabel("Capabilities")).toHaveValue("chat, tool_call");

  await page.getByRole("button", { name: "Import selected models (2)" }).click();
  const customProviderRow = page.locator(".provider-row").filter({ hasText: "cliproxy-gpt-4o" });
  const customDoubaoRow = page.locator(".provider-row").filter({ hasText: "doubao-1-5-pro-32k-250115" });
  await expect(customProviderRow).not.toContainText("Saved locally");
  await expect(customProviderRow.first()).toContainText("Ready");
  await expect(customProviderRow.first().locator(".provider-primary-status")).toHaveCount(1);
  await expect(customDoubaoRow).toBeVisible();
  await expect(customProviderRow.locator(".provider-name-copy strong")).toContainText("cliproxy-gpt-4o");
  await expect(customProviderRow.locator(".provider-name-copy small")).toHaveCount(0);
  await expect(customProviderRow.locator(".provider-meta-line")).toHaveCount(0);
  await expect(customProviderRow.getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "New preset" })).toHaveCount(0);
  await expect.poll(() =>
    state.providers.filter((provider) =>
      isRecord(provider) &&
      provider.providerId === "custom-openai-compatible" &&
      typeof provider.apiKeyRef === "string" &&
      provider.apiKeyRef.startsWith("local:provider_created_") &&
      provider.apiKeyConfigured === true &&
      !("apiKey" in provider)
    ).length
  ).toBe(2);
  await expect.poll(() => {
    const importedProvider = state.providers.find((provider) => isRecord(provider) && provider.model === "cliproxy-gpt-4o");
    return isRecord(importedProvider) ? {
      reasoning: importedProvider.reasoning,
      thinkingModes: importedProvider.thinkingModes,
    } : undefined;
  }).toEqual({ reasoning: false, thinkingModes: [] });

  await customProviderRow.first().getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await expect(page.getByLabel("Provider ID")).toHaveCount(0);
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("test-visible-key");
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Show API key" }).locator(".lucide-eye-off")).toBeVisible();
  await page.getByRole("button", { name: "Fetch models" }).click();
  await expect(page.locator(".provider-model-card")).toHaveCount(10);
  await expect(page.getByText("0 selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Select visible" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear selection" })).toBeDisabled();
  const imageModelCheckbox = page.getByRole("dialog", { name: "Edit preset" }).getByLabel("Select gpt-image-2");
  await imageModelCheckbox.locator("xpath=..").click();
  await expect(imageModelCheckbox).toBeChecked();
  await expect(page.getByText("1 selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save current preset" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import selected models (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Import selected models (1)" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toHaveCount(0);
  await expect.poll(() => {
    const imageProvider = state.providers.find((provider) => isRecord(provider) && provider.model === "gpt-image-2");
    return isRecord(imageProvider) ? {
      api: imageProvider.api,
      capabilities: imageProvider.capabilities,
      transportMode: isRecord(imageProvider.compat) && isRecord(imageProvider.compat.mediaVendorTransport)
        ? imageProvider.compat.mediaVendorTransport.mode
        : undefined,
      metadataId: isRecord(imageProvider.compat) && isRecord(imageProvider.compat.modelMetadata)
        ? imageProvider.compat.modelMetadata.id
        : undefined,
      reasoning: imageProvider.reasoning,
      thinkingModes: imageProvider.thinkingModes,
    } : undefined;
  }).toEqual({
    api: "media-job",
    capabilities: ["image_generate"],
    transportMode: "live",
    metadataId: "gpt-image-2",
    reasoning: false,
    thinkingModes: [],
  });
  await customProviderRow.first().getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await page.locator(".provider-secret-input .provider-secret-clear").click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" }).getByText("API key missing. Add an API key before running a live check.")).toBeVisible();
  await expect(customProviderRow.first()).toContainText("Ready");
});

test("model discovery keeps catalog provenance compact in the dark editor", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, {
    templates: createDefaultProviderTemplates(),
    providerModelCatalogStale: true,
    providerModels: [{
      id: "gpt-5-nano",
      displayName: "GPT-5 Nano",
      capabilities: ["chat", "tool_call", "reasoning", "vision"],
      capabilitySource: "model_catalog",
      capabilityConfidence: "known",
    }],
  });
  await page.goto("/");
  await openModelWorkbench(page);
  await page.getByRole("button", { name: "Add model" }).click();
  const dialog = page.getByRole("dialog", { name: "New preset" });
  await dialog.getByLabel("Model supplier").selectOption("custom-openai-compatible");
  await dialog.getByLabel("API key", { exact: true }).fill("test-visible-key");
  await dialog.getByRole("button", { name: "Fetch models" }).click();

  const sourceDetails = dialog.locator(".provider-model-source-details");
  await expect(sourceDetails).not.toHaveAttribute("open", "");
  await expect(dialog.locator(".provider-model-card")).toHaveCount(1);
  await sourceDetails.locator("summary").click();
  await expect(sourceDetails).toContainText("models.dev:test1234");
  await expect(sourceDetails).toContainText("Fetched");
  await expect(sourceDetails).toContainText("2026-01-01");
  await expect(sourceDetails).toContainText("The Ling model catalog is stale");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  expect(runtimeErrors).toEqual([]);
});

test("model workbench status counts align with saved chat and media presets", async ({ page }) => {
  await useEnglishLocale(page);
  const readyCheck = {
    ok: true,
    code: "ready",
    message: "Provider is reachable and accepted the configured model.",
    checkedAt: "2026-05-25T00:00:00.000Z",
  };
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createMediaProvider({
      id: "provider_seedance_image",
      kind: "seedance",
      displayName: "Seedance Video",
      providerId: "seedance",
      model: "doubao-seedance-1-0-pro-250528",
      capabilities: ["video_generate"],
      lastCheck: readyCheck,
    }),
    createMediaProvider({
      id: "provider_seedream_image",
      displayName: "Seedream Image",
      lastCheck: readyCheck,
    }),
    createChatProvider({
      id: "provider_chat_ready",
      displayName: "Ready Local Relay",
      lastCheck: readyCheck,
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openModelWorkbench(page);
  const filters = page.getByLabel("Filter model presets");
  const summary = page.locator(".provider-page-meta");
  await expect(summary).toHaveCount(0);
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
  await expect(page.locator(".provider-row")).toHaveCount(3);

  await filters.selectOption("ready");
  await expect(page.locator(".provider-row")).toHaveCount(3);
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
  await filters.selectOption("needsAttention");
  await expect(page.locator(".provider-row")).toHaveCount(0);
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
});

test("model workbench row checks separate scoped success Toasts from persistent failures", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providerCheckDelayMs = 800;
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Local Relay",
      lastCheck: undefined,
    }),
    createChatProvider({
      id: "provider_failed",
      displayName: "Auth Failed Gateway",
      lastCheck: undefined,
    }),
    createMediaProvider({
      id: "provider_seedream",
      displayName: "Seedream Image",
      lastCheck: undefined,
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openModelWorkbench(page);
  const checkAllButton = page.getByRole("button", { name: "Check all" });
  const readyRow = page.locator(".provider-row").filter({ hasText: "Ready Local Relay" });
  const readyCheckButton = readyRow.getByRole("button", { name: "Check" });
  await readyCheckButton.click();
  await expect(readyCheckButton).toHaveAttribute("aria-busy", "true");
  await expect(checkAllButton).toBeDisabled();
  await expect(checkAllButton).not.toHaveAttribute("aria-busy", "true");
  const readyToast = page.locator(
    '[data-ling-overlay="toast"][data-scope="provider:provider_ready:check"]',
  );
  await expect(readyToast).toContainText("Check passed");
  await expect(readyToast).toContainText("Provider is reachable and accepted the configured model.");
  await expect(page.locator(".provider-check-feedback-row.ok")).toHaveCount(0);
  await readyToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(readyToast).toHaveCount(0);

  const failedRow = page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" });
  await failedRow.getByRole("button", { name: "Check" }).click();
  const failedFeedback = page.locator(".provider-check-feedback-row.bad").filter({ hasText: "Check failed" });
  await expect(failedFeedback).toContainText("Invalid API key.");
  await expect(page.locator(".provider-check-feedback-row")).toHaveCount(1);
  await page.waitForTimeout(2200);
  await expect(failedFeedback).toBeVisible();

  const mediaRow = page.locator(".provider-row").filter({ hasText: "Seedream Image" });
  await mediaRow.getByRole("button", { name: "Check" }).click();
  const mediaToast = page.locator(
    '[data-ling-overlay="toast"][data-scope="provider:provider_seedream:check"]',
  );
  await expect(mediaToast).toContainText("Check passed");
  await expect(mediaToast).toContainText("Generation model configuration check passed.");
  await expect(mediaToast).not.toContainText("Media vendor transport");
  await expect(mediaToast).not.toContainText("no live vendor");
  await expect(page.locator(".provider-check-feedback-row")).toHaveCount(0);
  await mediaToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(mediaToast).toHaveCount(0);

  await page.reload();
  await openModelWorkbench(page);
  await page.getByRole("button", { name: "Check all" }).click();
  await expect(checkAllButton).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".provider-check-feedback-row")).toHaveCount(0);
  await expect(page.locator(".provider-batch-result")).toContainText("Checked 3 model presets");
  await expect(page.locator(".provider-batch-result")).toContainText("2 ready, 1 failed");
  await expect(page.locator(".provider-batch-result")).not.toContainText("Chat");
  await expect(page.locator(".provider-batch-result")).not.toContainText("media");
  await page.waitForTimeout(2_200);
  await expect(page.locator(".provider-batch-result.bad")).toBeVisible();
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="model-workbench:batch-check"]')).toHaveCount(0);
});

test("save and check enables a disabled provider before checking", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_disabled",
      displayName: "Disabled Relay",
      enabled: false,
      apiKeyRef: undefined,
      apiKeyConfigured: false,
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openModelWorkbench(page);
  const disabledRow = page.locator(".provider-row").filter({ hasText: "Disabled Relay" });
  await disabledRow.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("API key", { exact: true }).fill("disabled-provider-key");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator(".provider-default-purpose-bar").getByLabel("Chat model")).toHaveValue("provider_disabled");
  await expect(disabledRow.locator(".provider-primary-status")).toHaveCount(1);
  await expect.poll(() => {
    const provider = state.providers.find((item) => isRecord(item) && item.id === "provider_disabled");
    return isRecord(provider) ? { enabled: provider.enabled, apiKeyRef: provider.apiKeyRef, checked: isRecord(provider.lastCheck) && provider.lastCheck.ok } : undefined;
  }).toEqual({ enabled: true, apiKeyRef: "local:provider_disabled", checked: true });
});

test("disabled chat providers expose enable before their row check", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_disabled",
      displayName: "Configured Disabled Relay",
      enabled: false,
      apiKeyRef: "local:provider_disabled",
      apiKeyConfigured: true,
      lastCheck: {
        ok: false,
        code: "provider_disabled",
        message: "Provider is disabled.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openModelWorkbench(page);
  const disabledRow = page.locator(".provider-row").filter({ hasText: "Configured Disabled Relay" });
  await disabledRow.getByRole("button", { name: "Enable" }).click();
  await disabledRow.getByRole("button", { name: "Check" }).click();

  await expect(disabledRow.locator(".provider-state.run-ready")).toHaveCount(1);
  await expect(page.locator(".provider-default-purpose-bar").getByLabel("Chat model")).toHaveValue("provider_disabled");
  await expect(disabledRow.getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);
  await expect.poll(() => {
    const provider = state.providers.find((item) => isRecord(item) && item.id === "provider_disabled");
    return isRecord(provider) ? { enabled: provider.enabled, checked: isRecord(provider.lastCheck) && provider.lastCheck.ok } : undefined;
  }).toEqual({ enabled: true, checked: true });
});

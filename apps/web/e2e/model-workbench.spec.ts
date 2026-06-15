import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createDefaultProviderTemplates,
  createMediaProvider,
  isRecord,
} from "./support/mock-state";

test("model workbench Chinese mode localizes setup copy and uses an add model sheet", async ({ page }) => {
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
  await expect(page.getByRole("heading", { name: "模型工作台" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "模型工作台" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "模型预设" })).toHaveCount(0);
  await expect(page.locator(".provider-table")).toBeVisible();
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
  await expect(page.locator(".provider-row")).toHaveCount(1);
  const workbenchBounds = await page.locator(".provider-workbench").evaluate((workbench) => {
    const workspaceElement = workbench.closest(".workspace");
    const workspace = workspaceElement?.getBoundingClientRect();
    const rect = workbench.getBoundingClientRect();
    const style = workspaceElement ? getComputedStyle(workspaceElement) : undefined;
    const contentLeft = workspace && style ? workspace.left + Number.parseFloat(style.paddingLeft) : undefined;
    const contentRight = workspace && style ? workspace.right - Number.parseFloat(style.paddingRight) : undefined;
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
  expect(workbenchBounds ? workbenchBounds.workspaceContent.right - workbenchBounds.workbench.right : 0).toBeLessThanOrEqual(1.5);
  await expect(page.locator(".workspace-head .status-badge")).toHaveCount(0);
  await expect(page.getByText("已保存")).toBeVisible();
  await expect(page.locator(".provider-capability-summary")).toContainText("供应商");
  await expect(page.locator(".provider-capability-summary")).not.toContainText("聊天模型");
  await expect(page.locator(".provider-capability-summary")).not.toContainText("媒体模型");
  await expect(page.getByText("Chat-capable")).toHaveCount(0);
  await expect(page.locator(".provider-capability-summary")).not.toContainText("模板");
  await expect(page.getByRole("button", { name: "添加模型" })).toBeVisible();
  await expect(page.getByText("修复队列")).toHaveCount(0);
  await expect(page.getByText("Repair queue")).toHaveCount(0);
  await expect(page.getByText("MISSING_GATEWAY_KEY")).toHaveCount(0);
  await expect(page.getByText("env:", { exact: false })).toHaveCount(0);
  await expect(page.getByText("New preset")).toHaveCount(0);
  await expect(page.getByLabel("Model Workbench context")).toHaveCount(0);
  const missingKeyGatewayRow = page.locator(".provider-row").filter({ hasText: "Missing Key Gateway" });
  await expect(missingKeyGatewayRow.getByRole("button", { name: "设为默认" })).toBeVisible();
  await expect(missingKeyGatewayRow.getByRole("button", { name: "设为默认" })).toBeDisabled();
  await expect(missingKeyGatewayRow.getByRole("button", { name: "停用" })).toBeVisible();
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

  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await expect(editor).toBeVisible();
  const editorBox = await editor.boundingBox();
  const viewport = page.viewportSize();
  expect(editorBox).not.toBeNull();
  expect((editorBox?.x ?? 0) + (editorBox?.width ?? 0)).toBeGreaterThan(1240);
  expect(editorBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((editorBox?.y ?? 0) + (editorBox?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 720);
  await expect(editor.locator(".provider-sheet-header")).toHaveCSS("border-bottom-width", "0px");
  await expect(editor.locator(".provider-sheet-footer")).toHaveCSS("border-top-width", "0px");
  const editorBody = editor.locator(".provider-sheet-body");
  const editorTitle = editor.getByRole("heading", { name: "新建预设" });
  const editorCloseButton = editor.getByRole("button", { name: "关闭模型预设编辑器" });
  const savePresetButton = editor.getByRole("button", { name: "保存" });
  const supplierSelect = editor.getByLabel("模型供应商");

  await expect(editor.getByRole("tab")).toHaveCount(0);
  await expect(editor.locator(".provider-template-card")).toHaveCount(0);
  await expect(editor.locator(".provider-template-panel")).toHaveCount(0);
  await expect(editor.getByText("选择模型供应商")).toHaveCount(0);
  await expect(supplierSelect).toBeVisible();
  await expect(supplierSelect).toContainText("自定义 OpenAI-compatible");
  await expect(supplierSelect).toContainText("OpenAI GPT");
  await expect(supplierSelect).toContainText("Claude");
  await expect(supplierSelect).toContainText("豆包 Ark");
  await expect(supplierSelect).toContainText("Seedream 图片");
  await expect(editor.getByLabel("提供商 ID")).toHaveCount(0);
  await expect(editor.locator(".provider-capability-state")).toHaveCount(0);
  await expect(editor.getByRole("tab", { name: /OpenAI-compatible 中转/ })).toHaveCount(0);

  await supplierSelect.selectOption("openai-gpt");
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await supplierSelect.selectOption("anthropic-claude");
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await expect(supplierSelect).toContainText("智谱 GLM");
  await supplierSelect.selectOption("doubao-ark");
  await expect(page.getByLabel("提供商名称")).toHaveValue("豆包 Ark");
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
  await expect(page.getByLabel("提供商名称")).toHaveValue("自定义 OpenAI-compatible");
  await expect(page.getByLabel("API 协议")).toBeEnabled();
  await expect(page.getByText("高级 env/keychain")).toHaveCount(0);
  await expect(page.getByText("env:OPENAI_API_KEY")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() => ({
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
    })),
  ).toEqual({ bodyOverflow: "hidden", htmlOverflow: "hidden" });

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
  await expect(editor.getByRole("button", { name: "保存" })).toHaveCount(1);
  await expect(editor.getByRole("button", { name: "创建预设" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存修改" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存并检查" })).toHaveCount(0);
});

test("model workbench hides capability state row while keeping advanced overrides", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    templates: createDefaultProviderTemplates(),
  });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  await page.getByRole("button", { name: "Add model" }).first().click();
  const editor = page.getByRole("dialog", { name: "New preset" });
  await expect(editor).toBeVisible();
  const supplierSelect = editor.getByLabel("Model supplier");

  await expect(editor.locator(".provider-capability-state")).toHaveCount(0);
  await supplierSelect.selectOption("custom-openai-compatible");
  await expect(editor.getByLabel("Context")).toBeHidden();
  await expect(editor.getByLabel("Max tokens")).toBeHidden();

  await editor.getByText("Advanced model limits").click();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
  await page.getByRole("button", { name: "添加模型" }).first().click();
  await page.getByLabel("模型供应商").selectOption("custom-openai-compatible");
  await page.getByLabel("API Key", { exact: true }).fill("test-visible-key");
  await page.getByRole("button", { name: "获取模型" }).click();

  await expect(page.getByText("当前本地服务版本不支持获取模型，请停止旧服务后重新启动项目。")).toBeVisible();
  await expect(page.getByText("No route for POST /provider-models")).toHaveCount(0);
});

test("model workbench save validates before persisting and keeps errors inside the sheet", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await expect(editor).toBeVisible();
  await editor.getByLabel("模型供应商").selectOption("custom-openai-compatible");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(editor.getByText("请填写 API Key 后再保存。")).toBeVisible();
  await expect(editor.getByText("API key missing. Add an API key before running a live check.")).toHaveCount(0);
  await expect(page.locator(".provider-list-panel > .inline-error")).toHaveCount(0);
  await expect.poll(() =>
    state.providers.some((provider) => isRecord(provider) && provider.displayName === "Custom OpenAI-compatible")
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await editor.getByLabel("模型供应商").selectOption("doubao-ark");
  await page.getByLabel("API Key", { exact: true }).fill("ark-test-key");
  await page.getByRole("button", { name: "获取模型" }).click();

  const modelCards = page.locator(".provider-model-card");
  await expect(modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-260128" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedance-1-0-pro-250528" })).toBeVisible();
  await modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" }).click();
  await modelCards.filter({ hasText: "doubao-seedream-5-0-260128" }).click();
  await expect(page.getByText("已选 2 个")).toBeVisible();
  await expect(page.getByText("已隐藏", { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: "保存选中模型" }).click();

  await expect(editor).toHaveCount(0);
  await expect(page.locator(".provider-batch-result.ok")).toContainText("已导入 2 个模型预设。");
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
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
  await expect(page.getByLabel("能力")).toHaveValue("video_generate");
  const refetchedModels = page.getByRole("button", { name: "获取模型" });
  await expect(refetchedModels).toBeEnabled();
  await refetchedModels.click();
  await expect(modelCards.filter({ hasText: "doubao-seedance-1-0-pro-250528" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-260128" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" })).toBeVisible();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
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
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
    createMediaProvider(),
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.getByText("Saved presets")).toBeVisible();
  await expect(page.locator(".provider-capability-summary")).toContainText("Suppliers");
  await expect(page.locator(".provider-capability-summary")).not.toContainText("Chat models");
  await expect(page.locator(".provider-capability-summary")).not.toContainText("Media models");
  await expect(page.getByText("Coding ready")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const missingKeyGatewayRow = page.locator(".provider-row").filter({ hasText: "Missing Key Gateway" });
  await expect(missingKeyGatewayRow).toContainText("key missing");
  await expect(missingKeyGatewayRow.locator(".provider-state.enabled")).toHaveCount(0);
  await expect(missingKeyGatewayRow.locator(".provider-state.key-missing")).toHaveCount(1);
  await expect(missingKeyGatewayRow.locator(".provider-state.run-blocked")).toHaveCount(0);
  await expect(missingKeyGatewayRow.locator(".provider-state.check-bad")).toHaveCount(0);
  await expect(page.locator(".provider-row").filter({ hasText: "Unchecked Domestic Gateway" })).toContainText("unchecked");
  await expect(page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" })).toContainText("auth failed");
  const readyLocalRelayRow = page.locator(".provider-row").filter({ hasText: "Ready Local Relay" });
  await expect(readyLocalRelayRow).toContainText("check ready");
  await expect(readyLocalRelayRow.locator(".provider-state.enabled")).toHaveCount(1);
  await expect(readyLocalRelayRow).toContainText("Current default");
  await expect(readyLocalRelayRow.getByRole("button", { name: "Clear default" })).toBeVisible();
  await readyLocalRelayRow.getByRole("button", { name: "Clear default" }).click();
  await expect(readyLocalRelayRow.getByRole("button", { name: "Set default" })).toBeVisible();
  await expect.poll(() =>
    state.channels.every((channel) => !isRecord(channel) || channel.defaultProviderPresetId === undefined)
  ).toBe(true);
  await expect(readyLocalRelayRow.locator(".provider-state.enabled")).toHaveCount(1);
  await expect(readyLocalRelayRow.locator(".provider-state.disabled")).toHaveCount(0);
  const seedreamRow = page.locator(".provider-row").filter({ hasText: "Seedream Image" });
  await expect(seedreamRow).not.toContainText("Media task");
  await expect(seedreamRow).toContainText("Image");
  await expect(seedreamRow).toContainText("Run readiness: blocked");
  const legacyOpenAiRow = page.locator(".provider-row").filter({ hasText: "Legacy OpenAI Without Stored Endpoint" });
  await expect(legacyOpenAiRow).toContainText("https://api.openai.com/v1");
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
  await expect(openAiProxyRow.getByRole("button", { name: "Set default" })).toBeVisible();
  await openAiProxyRow.getByRole("button", { name: "Set default" }).click();
  await expect.poll(() =>
    state.channels.some((channel) =>
      isRecord(channel) &&
      channel.id === "channel_engineering" &&
      channel.defaultProviderPresetId === "provider_openai_proxy"
    )
  ).toBe(true);
  await expect(openAiProxyRow.getByRole("button", { name: "Clear default" })).toBeVisible();
  await expect(openAiProxyRow.locator(".provider-state.enabled")).toHaveCount(1);
  await expect(readyLocalRelayRow.locator(".provider-state.enabled")).toHaveCount(1);

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const reloadedOpenAiProxyRow = page.locator(".provider-row").filter({ hasText: "OpenAI Proxy Custom Endpoint" });
  await expect(reloadedOpenAiProxyRow.getByRole("button", { name: "Clear default" })).toBeVisible();
  await expect(reloadedOpenAiProxyRow.locator(".provider-state.enabled")).toHaveCount(1);
  await reloadedOpenAiProxyRow.getByRole("button", { name: "Disable" }).click();
  await expect(reloadedOpenAiProxyRow.getByRole("button", { name: "Enable" })).toBeVisible();
  await expect(reloadedOpenAiProxyRow.locator(".provider-state.disabled")).toHaveCount(1);
  await expect(reloadedOpenAiProxyRow).not.toContainText("Current default");
  await expect.poll(() =>
    state.channels.every((channel) => !isRecord(channel) || channel.defaultProviderPresetId !== "provider_openai_proxy")
  ).toBe(true);
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
  await expect(page.getByLabel("Enabled")).toBeChecked();
  await supplierSelect.selectOption("custom-openai-compatible");
  await expect(supplierSelect).toHaveValue("custom-openai-compatible");
  await expect(page.getByLabel("Provider name")).toHaveValue("Custom OpenAI-compatible");
  await expect(page.getByLabel("Provider ID")).toHaveCount(0);
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.example.com/v1");
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  await page.getByLabel("API key", { exact: true }).fill("test-visible-key");
  const apiKeyVisibilityButton = page.getByRole("button", { name: "Hide API key" });
  await expect(apiKeyVisibilityButton.locator(".lucide-eye")).toBeVisible();
  await apiKeyVisibilityButton.click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  const showApiKeyButton = page.getByRole("button", { name: "Show API key" });
  await expect(showApiKeyButton.locator(".lucide-eye-off")).toBeVisible();
  await showApiKeyButton.click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Clear API key" })).toHaveCount(0);
  const inlineClearButton = page.locator(".provider-secret-input .provider-secret-clear");
  await expect(inlineClearButton).toBeVisible();
  await expect(page.getByText("Advanced env/keychain")).toHaveCount(0);
  await expect(page.getByText("env:CUSTOM_MODEL_API_KEY")).toHaveCount(0);
  await page.getByRole("button", { name: "Fetch models" }).click();
  const modelCards = page.locator(".provider-model-card");
  await expect(modelCards).toHaveCount(5);
  await expect(modelCards.filter({ hasText: "Custom model" })).toHaveCount(0);
  await expect(modelCards.filter({ hasText: "cliproxy-gpt-4o" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedream-5-0-260128" })).toBeVisible();
  await expect(modelCards.filter({ hasText: "doubao-seedance-1-0-pro-250528" })).toBeVisible();
  await expect(page.getByText("media models are hidden", { exact: false })).toHaveCount(0);
  await modelCards.filter({ hasText: "cliproxy-gpt-4o" }).click();
  await modelCards.filter({ hasText: "doubao-1-5-pro-32k-250115" }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toHaveValue("your-model-id");
  await expect(page.getByLabel("API protocol")).toHaveValue("openai-completions");
  await expect(page.getByLabel("Capabilities")).toHaveValue("chat, tool_call, reasoning");

  await page.getByRole("button", { name: "Save selected models" }).click();
  const customProviderRow = page.locator(".provider-row").filter({ hasText: "cliproxy-gpt-4o" });
  const customDoubaoRow = page.locator(".provider-row").filter({ hasText: "doubao-1-5-pro-32k-250115" });
  await expect(customProviderRow).not.toContainText("Saved locally");
  await expect(customProviderRow).toContainText("key ready");
  await expect(customProviderRow).toContainText("check ready");
  await expect(customDoubaoRow).toBeVisible();
  await expect(customProviderRow.locator(".provider-meta-line").first()).toContainText("Model:");
  await expect(customProviderRow.locator(".provider-meta-line").first()).toContainText("Capabilities:");
  await expect(customProviderRow.locator(".provider-meta-line").first()).not.toContainText("custom-openai-compatible");
  await expect(customProviderRow).not.toContainText("Current default");
  await expect(customProviderRow.getByRole("button", { name: "Set default" })).toBeVisible();
  await customProviderRow.getByRole("button", { name: "Set default" }).click();
  await expect(customProviderRow.getByRole("button", { name: "Clear default" })).toBeVisible();
  await customProviderRow.getByRole("button", { name: "Clear default" }).click();
  await expect(customProviderRow.getByRole("button", { name: "Set default" })).toBeVisible();
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

  await customProviderRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await expect(page.getByLabel("Provider ID")).toHaveCount(0);
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("test-visible-key");
  await expect(page.getByRole("button", { name: "Hide API key" }).locator(".lucide-eye")).toBeVisible();
  await page.locator(".provider-secret-input .provider-secret-clear").click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" }).getByText("API key missing. Add an API key before running a live check.")).toBeVisible();
  await expect(customProviderRow).toContainText("key ready");
});

test("model workbench status counts align with saved chat and media presets", async ({ page }) => {
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const statusTabs = page.locator(".provider-status-tabs");
  await expect(statusTabs.getByRole("button", { name: /Available 3/ })).toBeVisible();
  await expect(statusTabs.getByRole("button", { name: /Needs config 0/ })).toBeVisible();
  await expect(statusTabs.getByRole("button", { name: /Disabled providers 0/ })).toBeVisible();
  const summary = page.locator(".provider-capability-summary");
  await expect(summary).toContainText("Saved presets 3");
  await expect(summary).toContainText("Suppliers 3");
  await expect(summary).not.toContainText("Chat models");
  await expect(summary).not.toContainText("Media models");
  await expect(summary).toContainText("Coding ready 1");
  await expect(summary).toContainText("Missing secrets 0");
  await expect(summary).not.toContainText("Templates");
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
  await expect(page.locator(".provider-row")).toHaveCount(3);

  await statusTabs.getByRole("button", { name: /Available 3/ }).click();
  await expect(page.locator(".provider-row")).toHaveCount(3);
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
  await statusTabs.getByRole("button", { name: /Needs config 0/ }).click();
  await expect(page.locator(".provider-row")).toHaveCount(0);
  await expect(page.locator(".provider-group-row")).toHaveCount(0);
});

test("model workbench row checks show inline feedback without spinning batch check", async ({ page }) => {
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const checkAllButton = page.getByRole("button", { name: "Check all" });
  const readyRow = page.locator(".provider-row").filter({ hasText: "Ready Local Relay" });
  await readyRow.getByRole("button", { name: "Check" }).click();
  await expect(readyRow.getByRole("button", { name: "Check" }).locator(".spin")).toHaveCount(1);
  await expect(checkAllButton).toBeDisabled();
  await expect(checkAllButton.locator(".spin")).toHaveCount(0);
  const readyFeedback = page.locator(".provider-check-feedback-row.ok").filter({ hasText: "Check passed" });
  await expect(readyFeedback).toContainText("Provider is reachable and accepted the configured model.");
  await expect(readyFeedback).toContainText("Ready for run.");
  await expect(readyFeedback).toHaveCount(0, { timeout: 3500 });

  const failedRow = page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" });
  await failedRow.getByRole("button", { name: "Check" }).click();
  const failedFeedback = page.locator(".provider-check-feedback-row.bad").filter({ hasText: "Check failed" });
  await expect(failedFeedback).toContainText("Invalid API key.");
  await expect(page.locator(".provider-check-feedback-row")).toHaveCount(1);

  const mediaRow = page.locator(".provider-row").filter({ hasText: "Seedream Image" });
  await mediaRow.getByRole("button", { name: "Check" }).click();
  const mediaFeedback = page.locator(".provider-check-feedback-row.ok").filter({ hasText: "Generated a real image successfully." });
  await expect(mediaFeedback).toContainText("Check passed");
  await expect(mediaFeedback).not.toContainText("Media vendor transport");
  await expect(mediaFeedback).not.toContainText("no live vendor");
  await expect(page.locator(".provider-check-feedback-row")).toHaveCount(1);
  await expect(mediaFeedback).toHaveCount(0, { timeout: 3500 });

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  await page.getByRole("button", { name: "Check all" }).click();
  await expect(checkAllButton.locator(".spin")).toHaveCount(1);
  await expect(page.locator(".provider-check-feedback-row")).toHaveCount(0);
  await expect(page.locator(".provider-batch-result")).toContainText("Checked 3 model presets");
  await expect(page.locator(".provider-batch-result")).toContainText("2 ready, 1 failed");
  await expect(page.locator(".provider-batch-result")).not.toContainText("Chat");
  await expect(page.locator(".provider-batch-result")).not.toContainText("media");
  await expect(page.locator(".provider-batch-result")).toHaveCount(0, { timeout: 3500 });
});

test("save and check enables a disabled provider before checking", async ({ page }) => {
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const disabledRow = page.locator(".provider-row").filter({ hasText: "Disabled Relay" });
  await disabledRow.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("API key", { exact: true }).fill("disabled-provider-key");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(disabledRow).toContainText("enabled");
  await expect(disabledRow).toContainText("check ready");
  await expect.poll(() => {
    const provider = state.providers.find((item) => isRecord(item) && item.id === "provider_disabled");
    return isRecord(provider) ? { enabled: provider.enabled, apiKeyRef: provider.apiKeyRef, checked: isRecord(provider.lastCheck) && provider.lastCheck.ok } : undefined;
  }).toEqual({ enabled: true, apiKeyRef: "local:provider_disabled", checked: true });
});

test("row check enables a configured disabled chat provider before checking", async ({ page }) => {
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const disabledRow = page.locator(".provider-row").filter({ hasText: "Configured Disabled Relay" });
  await disabledRow.getByRole("button", { name: "Check" }).click();

  await expect(disabledRow.locator(".provider-state.enabled")).toHaveCount(1);
  await expect(disabledRow.getByRole("button", { name: "Set default" })).toBeVisible();
  await expect(disabledRow).toContainText("check ready");
  await expect.poll(() => {
    const provider = state.providers.find((item) => isRecord(item) && item.id === "provider_disabled");
    return isRecord(provider) ? { enabled: provider.enabled, checked: isRecord(provider.lastCheck) && provider.lastCheck.ok } : undefined;
  }).toEqual({ enabled: true, checked: true });
});

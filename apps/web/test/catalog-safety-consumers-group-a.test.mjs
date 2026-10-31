import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatCatalogMessage, loadCatalog } from "@ling-stack/localization";

// Use the same source resolution as the existing Web helper suites. No API,
// Provider, model, real workspace, or permission decision is invoked here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(`${specifier.slice(0, -3)}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { buildTeammateModelViewModel } = await import("../src/features/teammates/teammate-model-view-models.ts");
const { skillImportHasBlockingWarnings, skillImportProblemLabel } = await import("../src/features/settings/skill-import-utils.ts");
const { filterExternalTools } = await import("../src/features/teammates/teammate-external-tools-view-models.ts");
const { buildCouncilMemberCandidates } = await import("../src/features/councils/council-members-view-model.ts");
const { useApprovalDecisionController } = await import("../src/features/approvals/useApprovalDecisionController.ts");
const { buildRunRequest, buildTaskRunRequest } = await import("../src/api/run-request-builders.ts");
const { normalConversationThinkingLabel, normalConversationThinkingOptions } = await import("../src/features/workspace/normal-conversation-composer-options.ts");
const { parseWebThemePackage } = await import("../src/shared/ui/theme/package/web-theme-package-parser.ts");

const locales = ["bs-BA", "es-419", "fi-FI", "gu-IN", "hi-IN", "hu-HU", "hy-AM", "it-IT", "ka-GE", "kn-IN", "ko-KR", "mr-IN", "ms-MY", "my-MM"];
const english = (await loadCatalog("en-US")).messages;
const compiled = new Map(await Promise.all(locales.map(async locale => [locale, (await loadCatalog(locale)).messages])));
const authored = new Map(locales.map(locale => [locale, JSON.parse(readFileSync(new URL(`../../../packages/localization/catalogs/${locale}.json`, import.meta.url), "utf8")).messages]));
const source = relative => readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8");

/** A present authored key must survive compilation; fallback cannot hide its mistranslation. */
function translate(locale, key, values) {
  const messages = compiled.get(locale);
  assert.ok(Object.hasOwn(authored.get(locale), key), `authored ${locale}: ${key}`);
  assert.equal(messages[key], authored.get(locale)[key], `fresh compiled ${locale}: ${key}`);
  return formatCatalogMessage(messages, english, key, values);
}
const translator = locale => (key, values) => translate(locale, key, values);

const secretRefKey = "One per line. Store env: or keychain: refs only, not secret values.";
const artifactPathKey = "Artifacts will appear here once the daemon records files under .ling-stack/artifacts.";
const inspectKey = "Inspect the current project structure, give next implementation advice, and do not modify files.";
const unhideKey = "Create or unhide teammates before adding them to this council.";
const literalCases = [
  ...["es-419", "fi-FI", "gu-IN", "hi-IN", "hu-HU", "kn-IN", "ms-MY", "my-MM", "hy-AM"]
    .map(locale => [locale, secretRefKey, ["env:", "keychain:"], "features/providers/ProviderAdvancedSettings.tsx"]),
  ...["es-419", "fi-FI", "gu-IN", "hi-IN", "hu-HU", "kn-IN"]
    .map(locale => [locale, "View SKILL.md", ["SKILL.md"], "features/settings/SkillSourceInspector.tsx"]),
  ...["ko-KR", "it-IT"].flatMap(locale => [
    [locale, "Choose a .ling-theme file.", [".ling-theme"], "shared/ui/theme/package/web-theme-package-parser.ts"],
    [locale, "Choose another .ling-theme file", [".ling-theme"], "features/settings/theme-packages/ThemeImportDialog.tsx"],
    [locale, "Local .ling-theme, up to 20 MB", [".ling-theme"], "features/settings/theme-packages/ThemeImportDialog.tsx"],
  ]),
  ...["ms-MY", "bs-BA", "hy-AM", "mr-IN"].map(locale =>
    [locale, "Local .ling-theme, up to 20 MB", [".ling-theme"], "features/settings/theme-packages/ThemeImportDialog.tsx"]),
  ["mr-IN", "Choose a .ling-theme file.", [".ling-theme"], "shared/ui/theme/package/web-theme-package-parser.ts"],
  ["bs-BA", artifactPathKey, [".ling-stack/artifacts"], "features/runs/RunArtifactSection.tsx"],
];

for (const [locale, key, tokens, consumer] of literalCases) {
  test(`C004 ${locale}: formatter preserves technical literals in ${key}`, () => {
    // These TSX labels have no standalone injected-translation renderer. This
    // is an actual catalog/formatter and source-call contract, not GUI coverage.
    assert.ok(source(consumer).includes(JSON.stringify(key)), `current consumer still requests ${key}`);
    const text = translate(locale, key);
    for (const token of tokens) assert.ok(text.includes(token), `${locale} must preserve ${token}: ${text}`);
  });
}

test("C004 real theme parser still rejects a translated or wrong file suffix before reading bytes", async () => {
  for (const fileName of ["fixture.ling-테마", "fixture.ling-थीम", "fixture.ling", "fixture.zip"]) {
    let reads = 0;
    await assert.rejects(parseWebThemePackage({ name: fileName, size: 4, arrayBuffer() { reads += 1; throw new Error("must not read"); } }), error => {
      assert.equal(error.issues[0].code, "unsupported-extension");
      assert.equal(error.issues[0].message, "Choose a .ling-theme file.");
      return true;
    });
    assert.equal(reads, 0);
  }
});

test("C004 exact .ling-theme suffix retains its separate empty-archive guard", async () => {
  await assert.rejects(parseWebThemePackage({ name: "fixture.ling-theme", size: 0 }), error => {
    assert.equal(error.issues[0].code, "archive-empty");
    return true;
  });
});

const provider = overrides => ({
  id: "offline-provider", displayName: "Offline fixture", kind: "openai-compatible", providerId: "offline",
  api: "openai-completions", model: "offline-chat", baseUrl: "https://offline.invalid/v1", enabled: true,
  authHeader: false, capabilities: ["chat"], lastCheck: { ok: true }, ...overrides,
});
const modelView = (providers, selectedProviderId) => buildTeammateModelViewModel({
  canFollowWorkspaceDefault: false, isProtected: false, modelBindingMode: "fixed", providers, selectedProviderId, t: translator("ka-GE"),
});

test("C005 Georgian non-chat option keeps negative copy and the real disabled/incompatible state", () => {
  const view = modelView([provider({ capabilities: ["image_generate"] })], "offline-provider");
  assert.equal(view.primaryState, "incompatible");
  assert.equal(view.options[0].disabled, true);
  assert.match(view.options[0].label, /\(ჩატთან თავსებადი არ არის\)$/u);
});

test("C005 Georgian missing fixed model stays unavailable and cannot become selectable through copy", () => {
  const view = modelView([], "missing-provider");
  assert.equal(view.primaryState, "missing");
  assert.equal(view.options[0].id, "missing-provider");
  assert.equal(view.options[0].disabled, true);
  assert.match(view.options[0].label, /ხელმისაწვდომი არ არის/u);
});

test("C005 Georgian unsupported capability error stays negative while actual import remains blocked", () => {
  const warning = { severity: "error", code: "unknown_provider_capability", message: "offline fixture" };
  assert.equal(skillImportHasBlockingWarnings({ warnings: [warning], definitions: [] }), true);
  assert.match(translate("ka-GE", skillImportProblemLabel(warning.code)), /არამხარდაჭერილ/u);
});

test("C005 real ready model and nonblocking import controls are unchanged", () => {
  const view = modelView([provider()], "offline-provider");
  assert.equal(view.primaryState, "ready");
  assert.equal(view.options[0].disabled, false);
  assert.equal(skillImportHasBlockingWarnings({ warnings: [], definitions: [] }), false);
});

const failedClosedLabels = new Map([
  ["bs-BA", "Sigurnosno blokirano zbog greške"],
  ["hy-AM", "Սխալի դեպքում անվտանգ արգելափակված"],
  ["it-IT", "Bloccato per sicurezza in caso di errore"],
  ["ko-KR", "오류 시 안전 차단"],
  ["my-MM", "အမှားဖြစ်သဖြင့် ဘေးကင်းစေရန် ပိတ်ပင်ထားသည်"],
]);
for (const [locale, expected] of failedClosedLabels) {
  test(`C006 ${locale}: failed-closed formatter describes safety blocking, not a failed close action`, () => {
    // The current Outcome selectors are private in ChannelInspectorPanels.
    // Do not extract or reproduce them solely to claim a renderer test.
    assert.equal((source("features/workspace/ChannelInspectorPanels.tsx").match(/return t\("Failed closed"\)/g) ?? []).length, 2);
    assert.equal(translate(locale, "Failed closed"), expected);
    assert.notEqual(expected, translate(locale, "Close"));
  });
}

function approval(overrides = {}) {
  return { id: "offline-approval", actionType: "bash", risk: "low", title: "Offline approval", description: "No command executes",
    payload: { type: "bash", command: "node --version" }, status: "pending", createdAt: "2026-10-17T00:00:00.000Z", ...overrides };
}
function decisionController(input) {
  let controller;
  function CaptureController() { controller = useApprovalDecisionController(input); return null; }
  renderToStaticMarkup(React.createElement(CaptureController));
  return controller;
}

test("C007 Burmese Approve is a positive formatter label at the actual approve-button source", () => {
  const panel = source("features/approvals/ApprovalDecisionPanel.tsx");
  assert.ok(panel.includes('decision.requestDecision("approve")'));
  assert.ok(panel.includes('t("Approve")'));
  assert.equal(translate("my-MM", "Approve"), "အတည်ပြုပါ");
});

test("C007 actual low-risk approval controller still sends approve rather than deny", () => {
  const calls = [];
  decisionController({ approval: approval(), onResolve: (...args) => calls.push(args) }).requestDecision("approve");
  assert.deepEqual(calls, [["offline-approval", "approve", undefined, undefined]]);
});

test("C007 actual high-risk controller still requires confirmation and a reason", () => {
  const calls = [];
  const controller = decisionController({ approval: approval({ risk: "high" }), onResolve: (...args) => calls.push(args) });
  assert.equal(controller.highRisk, true);
  assert.equal(controller.reasonRequired, true);
  controller.requestDecision("approve");
  controller.submit("approve");
  assert.deepEqual(calls, []);
});

test("C007 actual resolved or busy approval controllers never send a new decision", () => {
  for (const input of [{ approval: approval({ status: "denied" }) }, { approval: approval(), resolvingDecision: "approve" }]) {
    const calls = [];
    decisionController({ ...input, onResolve: (...args) => calls.push(args) }).requestDecision("approve");
    assert.deepEqual(calls, []);
  }
});

test("C007 Burmese Allowed stays positive while the real filter selects only authorized tools", () => {
  const tools = [{ rawName: "allowed-tool", displayName: "Allowed fixture" }, { rawName: "other-tool", displayName: "Other fixture" }];
  assert.ok(source("features/teammates/TeammateExternalToolDrawer.tsx").includes('filter === "authorized") return t("Allowed")'));
  assert.equal(translate("my-MM", "Allowed"), "ခွင့်ပြုထားသည်");
  assert.deepEqual(filterExternalTools(tools, new Set(["allowed-tool"]), "", "authorized"), [tools[0]]);
  assert.deepEqual(filterExternalTools(tools, new Set(), "", "authorized"), []);
  assert.deepEqual(filterExternalTools(tools, new Set(["allowed-tool"]), "", "all"), tools);
});

function runForm(prompt, providerPresetId = "offline-provider") {
  return { cwd: "/offline-fixture", taskId: "offline-task", title: "Inspect", prompt, providerPresetId,
    provider: "offline", model: "offline-chat", baseUrl: "", apiKey: "", api: "openai-completions",
    tools: ["read", "grep"], authorizationMode: "smart", workspaceAccessMode: "read_only",
    permissionPreset: "read_only", permissionMode: "ask_everything" };
}

test("C008 Burmese default Inspect preserves no-file-modification intent through both real Run request builders", () => {
  const prompt = translate("my-MM", inspectKey);
  const direct = buildRunRequest(runForm(prompt));
  const task = { id: "offline-task", title: "Inspect", prompt, channelId: "offline-channel" };
  const channel = { id: "offline-channel", allowedTools: ["read"], boundPath: "/offline-fixture" };
  const taskRun = buildTaskRunRequest("/offline-fixture", task, channel, "offline-provider", { permissionPreset: "read_only", permissionMode: "ask_everything" });
  assert.ok(prompt.includes("ဖိုင်များကို မပြင်ဆင်ပါနှင့်"), "the actual default task content must say not to modify files");
  assert.equal(direct.task.prompt, prompt);
  assert.equal(taskRun.task.prompt, prompt);
  assert.equal(direct.permissionMode, undefined);
  assert.equal(taskRun.permissionMode, undefined);
});

test("C008 current initialization/reset/create source seams still carry the same translated default prompt", () => {
  // AppShell and the workspace Hook are not mounted here. Their actual source
  // call sites are checked separately from the executed payload builders above.
  const app = source("app/AppShell.tsx");
  const workspace = source("domains/workspace/use-workspace-domain.ts");
  assert.ok(app.includes(JSON.stringify(inspectKey)));
  assert.ok(app.includes("prompt: t(defaultForm.prompt)"));
  assert.ok(workspace.includes(JSON.stringify(inspectKey)));
  assert.equal((workspace.match(/prompt: input\.translate\(defaultTaskForm\.prompt\)/g) ?? []).length, 2);
  assert.ok(source("app/use-channel-actions-controller.ts").includes("prompt: input.taskForm.prompt,"));
});

test("C008 custom multiline task text is preserved by the real preset and explicit-provider request paths", () => {
  const prompt = "User-owned text\nDo not translate or rewrite\nconsole.log('fixture');";
  for (const preset of ["offline-provider", ""]) assert.equal(buildRunRequest(runForm(prompt, preset)).task.prompt, prompt);
  assert.equal(buildTaskRunRequest("/offline-fixture", { id: "task", title: "User text", prompt, channelId: "channel" },
    { id: "channel", allowedTools: ["read"] }, "offline-provider").task.prompt, prompt);
});

const thinkingOffLabels = new Map([
  ["my-MM", "စဉ်းစားခြင်း ပိတ်ထားသည်"], ["hy-AM", "Մտածումն անջատված է"], ["it-IT", "Ragionamento disattivato"],
]);
for (const [locale, expected] of thinkingOffLabels) {
  test(`C011 ${locale}: formatter makes the short thinking-off label explicit while the real menu keeps off`, () => {
    const t = translator(locale);
    assert.equal(t("Thinking off"), expected);
    assert.notEqual(t("Thinking off"), t("Thinking"));
    assert.equal(normalConversationThinkingLabel("off", t), t("Off"));
    assert.deepEqual(normalConversationThinkingOptions(["off", "high"]), ["off", "high"]);
    assert.deepEqual(normalConversationThinkingOptions(["off"]), []);
  });
}

test("C011 current composer label/tooltip and Home request source retain the off boundary", () => {
  // This is source-contract coverage of the unextracted Home event handler,
  // not a simulated payload builder or an assertion that GUI sending ran.
  const composer = source("features/workspace/NormalConversationComposer.tsx");
  assert.ok(composer.includes("<ConversationModelControl"));
  const modelControl = source("features/workspace/ConversationModelControl.tsx");
  assert.ok(modelControl.includes('thinkingOff ? t("Thinking off")'));
  assert.ok(modelControl.includes('t("Thinking is off; no thinking level will be sent.")'));
  assert.match(source("features/workspace/ConversationHome.tsx"), /thinkingEnabled\s*&&\s*selectedThinkingLevel\s*!==\s*"off"\s*\?\s*\{\s*thinkingLevel:\s*selectedThinkingLevel\s*\}\s*:\s*\{\s*\}/u);
});

test("C012 Marathi empty-council guidance says to restore hidden teammates, not hide more", () => {
  const t = translator("mr-IN");
  assert.ok(source("features/councils/CouncilMembersPanel.tsx").includes(`description={t(${JSON.stringify(unhideKey)})}`));
  const hidden = { id: "hidden-fixture", displayName: "Hidden teammate", hidden: true, status: "active" };
  assert.deepEqual(buildCouncilMemberCandidates([hidden], [], t), []);
  assert.ok(t(unhideKey).includes("लपवलेले टीममेट पुन्हा दाखवा"));
  assert.equal(buildCouncilMemberCandidates([{ ...hidden, hidden: false }], [], t)[0].teammate.id, hidden.id);
});

test("C012 actual council candidate exclusion still rejects disabled and existing teammates", () => {
  const t = translator("mr-IN");
  const teammate = { id: "fixture", displayName: "Visible teammate", hidden: false, status: "active" };
  assert.deepEqual(buildCouncilMemberCandidates([{ ...teammate, status: "disabled" }], [], t), []);
  assert.deepEqual(buildCouncilMemberCandidates([teammate], [{ teammateId: teammate.id }], t), []);
});

test("C004-C012 real shared formatter keeps missing-locale fallback and interpolation intact", () => {
  assert.equal(formatCatalogMessage({}, english, secretRefKey), secretRefKey);
  assert.equal(formatCatalogMessage({}, english, "{name} (not chat compatible)", { name: "Offline fixture" }), "Offline fixture (not chat compatible)");
  assert.equal(formatCatalogMessage({}, english, inspectKey), inspectKey);
});

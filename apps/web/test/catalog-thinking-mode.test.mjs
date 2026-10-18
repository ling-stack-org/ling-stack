import assert from "node:assert/strict";
import test, { after } from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";

const h = await catalogConsumerHarness({ after }, {
  exports: {
    "features/workspace/ConversationHome.tsx": ["ConversationHome"],
    "features/workspace/NormalConversationComposer.tsx": ["NormalConversationComposer"],
    "features/workspace/normal-conversation-composer-options.ts": ["normalConversationThinkingLabel", "normalConversationThinkingOptions"],
  },
  transforms: { "features/workspace/ConversationHome.tsx": [{
    anchor: "  const composerNode = (",
    replace: key => `  globalThis[${JSON.stringify(key)}].captures.submitDraft = submitDraft;\n  const composerNode = (`,
  }] },
});

const noop = () => {};
const model = { id: "qa-provider", providerId: "qa-provider", label: "Offline fixture", displayName: "Offline fixture", model: "qa-no-call",
  enabled: true, runnable: true, thinkingModes: ["off", "low", "high"] };
const composer = {
  draft: "Offline localization check", inputRef: { current: null }, inputParts: [], slashOptions: [], slashActiveIndex: 0,
  pendingAttachments: [], authorizationMode: "ask", permissionPreset: "read_only", fullAccessConfirmed: false,
  modelOptions: [model], selectedProviderPresetId: model.id, defaultProviderPresetId: model.id, defaultProviderLabel: model.label,
  selectedThinkingLevel: "off", selectedReasoningSummary: "auto", sendBusy: false, activeRun: false, stopping: false,
  canSend: true, notice: "", dragActive: false, onDraftChange: noop, onComposerKeyDown: noop, onComposerPasteFiles: noop,
  onComposerSelect: noop, onCommitSlashCommand: noop, onAttachFiles: noop, onDragOver: noop, onDragLeave: noop, onDrop: noop,
  onRemoveAttachment: noop, onAuthorizationModeChange: noop, onPermissionPresetChange: noop, onModelChange: noop,
  onThinkingLevelChange: noop, onReasoningSummaryChange: noop, onSubmit: noop,
};
const disabledMeaning = {
  "pl-PL": /wyłącz/iu, "pt-BR": /desativad|desligad/iu, "pt-PT": /desativad|desligad/iu,
  "ro-RO": /oprit|dezactivat/iu, "ru-RU": /отключ|выключ/iu, "sk-SK": /vypnut/iu,
  "sl-SI": /izklop|izključ/iu, "so-SO": /dami|demin|deman/iu, "sq-AL": /fikur|çaktiviz/iu,
  "sw-TZ": /zima|zimw/iu, "te-IN": /ఆఫ్|నిలిపి|ఆపివేయ/u, "th-TH": /ปิด/u,
  "tr-TR": /kapalı|kapatıl/iu, "uk-UA": /вимкнен|вимкну/iu, "vi-VN": /tắt/iu,
  "zh-HK": /關閉|已關/u, "es-ES": /desactivad|apagad/iu, "fr-FR": /désactiv|arrêt/iu, "mk-MK": /исклуч/iu,
};

async function sendThroughHome(level = "off", extra = {}) {
  const requests = [];
  h.render(h.module.ConversationHome, {
    initialDraft: "Do not run tools. Offline payload fixture only.", initialProviderPresetId: model.id, initialThinkingLevel: level,
    conversationIdentity: "draft:11011", defaultProviderLabel: model.label, defaultProviderPresetId: model.id,
    modelOptions: [model], slashCommands: [], workspaceCwd: "/isolated/catalog-fixture", inlineApprovalViews: [],
    approvalErrors: {}, resolvingApprovals: new Set(), onSendConversation: async request => { requests.push(request); }, ...extra,
  });
  assert.equal(typeof h.state.captures.submitDraft, "function");
  await h.state.captures.submitDraft();
  return requests;
}

for (const [locale, meaning] of Object.entries(disabledMeaning)) {
  test(`C011 ${locale}: actual off composer/aria and Home submit agree without sending a thinking level`, async () => {
    const t = await h.select(locale);
    assert.deepEqual(h.module.normalConversationThinkingOptions(["low"]), ["off", "low"]);
    const menuLabel = h.module.normalConversationThinkingLabel("off", t);
    const markup = h.render(h.module.NormalConversationComposer, composer);
    const selectedAria = t("Selected thinking mode {label}", { label: menuLabel });
    assert.ok(markup.includes(selectedAria));
    assert.ok(markup.includes(t("Thinking is off; no thinking level will be sent.")));
    assert.ok(markup.includes(t("Thinking off")));
    const requests = await sendThroughHome();
    assert.equal(requests.length, 1);
    assert.equal(Object.hasOwn(requests[0].model, "thinkingLevel"), false);
    assert.equal(requests[0].model.providerPresetId, model.id);
    assert.equal(requests[0].model.reasoningSummary, "auto");
    assert.match(t("Thinking off"), meaning, "the short label must explicitly disclose disabled thinking, not narrate thinking");
    if (locale === "zh-HK") assert.match(menuLabel, /關閉|已關/u, "Off is a mode, not leaving the conversation");
  });
}

test("C011 non-off still sends its exact level and locked Home cannot submit", async () => {
  await h.select("en-US");
  const requests = await sendThroughHome("high");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model.thinkingLevel, "high");
  assert.deepEqual(await sendThroughHome("off", { sending: true }), []);
  const markup = h.render(h.module.NormalConversationComposer, { ...composer, sendBusy: true });
  assert.ok(markup.includes("conversation-thinking-button off"));
  assert.match(markup, /disabled=""[^>]*>[^]*?Thinking off/u);
});

test("C011 selected-locale gaps and default English preserve the exact same off payload", async () => {
  for (const locale of ["zh-HK", "en-US"]) {
    const t = await h.select(locale, ["Thinking off", "Off"]);
    assert.equal(t("Thinking off"), "Thinking off");
    assert.equal(h.module.normalConversationThinkingLabel("off", t), "Off");
    const requests = await sendThroughHome();
    assert.equal(requests.length, 1);
    assert.equal(Object.hasOwn(requests[0].model, "thinkingLevel"), false);
  }
});

// sv-SE/id-ID short-label native meaning remains outside the confirmed scope; no blanket correction.

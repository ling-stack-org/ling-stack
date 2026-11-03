import assert from "node:assert/strict";
import test, { after } from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";

const h = await catalogConsumerHarness({ after }, {
  exports: {
    "features/settings/theme-packages/ThemeImportDialog.tsx": ["ThemeImportDialog"],
    "features/settings/theme-packages/theme-package-view-models.ts": ["themePackageIssueLabel"],
    "shared/ui/theme/package/web-theme-package-parser.ts": ["parseWebThemePackage"],
    "features/providers/ProviderAdvancedSettings.tsx": ["ProviderAdvancedSettings"],
    "features/settings/ExternalWorkWorkflowSection.tsx": ["ExternalWorkWorkflowSection"],
    "features/runs/RunArtifactSection.tsx": ["RunArtifactSection"],
    "features/workspace/ChannelInspectorPanels.tsx": ["ChannelRouteInspectContent", "ChannelIntentInspectContent"],
  },
  expose: { "features/workspace/ChannelInspectorPanels.tsx": ["ChannelRouteInspectContent", "ChannelIntentInspectContent"] },
});

const localThemeKey = "Local .ling-theme, up to 20 MB";
const chooseThemeKey = "Choose a .ling-theme file.";
const anotherThemeKey = "Choose another .ling-theme file";
const themeCases = {
  "pl-PL": [chooseThemeKey, anotherThemeKey, localThemeKey],
  "ro-RO": [chooseThemeKey],
  "ru-RU": [chooseThemeKey, anotherThemeKey, localThemeKey],
  "so-SO": [localThemeKey], "sv-SE": [chooseThemeKey, anotherThemeKey, localThemeKey],
  "ta-IN": [localThemeKey], "sw-TZ": [localThemeKey], "th-TH": [localThemeKey],
  "tr-TR": [chooseThemeKey, anotherThemeKey, localThemeKey],
};
const noop = () => {};

function consumed(key) {
  const lines = h.state.calls.filter(call => call.key === key);
  assert.ok(lines.length > 0, `the real consumer must select ${key}`);
  return lines.at(-1).text;
}

function renderTheme(key) {
  h.state.calls.length = 0;
  h.render(h.module.ThemeImportDialog, {
    returnFocusRef: { current: null }, state: { mode: "import", open: true, phase: "idle", issues: key === chooseThemeKey
      ? [{ code: "unsupported-extension", path: "$", message: "Choose a .ling-theme file." }] : [],
      fileName: key === anotherThemeKey ? "fixture.ling-theme" : undefined, useAfterImport: false },
    onClose: noop, onLoadFile: noop, onPreview: noop, onPublish: noop, onUseAfterImportChange: noop,
  });
  return consumed(key);
}

for (const [locale, keys] of Object.entries(themeCases)) for (const key of keys) {
  test(`C004 ${locale}: actual theme ${key} preserves the parser's literal extension`, async () => {
    await h.select(locale);
    const text = renderTheme(key);
    assert.ok(text.includes(".ling-theme"), text);
    if (key === chooseThemeKey) assert.equal(text, h.module.themePackageIssueLabel({ code: "unsupported-extension" }, h.state.t));
  });
}

const secretKey = "One per line. Store env: or keychain: refs only, not secret values.";
for (const locale of ["pl-PL", "sv-SE", "ta-IN", "te-IN", "th-TH"]) {
  test(`C004 ${locale}: real Provider field describes the actual env:/keychain: reference syntax`, async () => {
    await h.select(locale);
    const form = Object.freeze({ api: "openai-responses", displayName: "Fixture", baseUrl: "https://example.invalid/v1",
      secretHeaderRefsText: "X-Token: env:QA_TOKEN", contextWindow: "", maxTokens: "", capabilitiesText: "", enabled: false,
      authHeader: true, reasoning: false });
    h.render(h.module.ProviderAdvancedSettings, { form, editingProviderId: "", isCustomProvider: true, canEditCustomProviderFields: false, onFormChange: noop });
    const text = consumed(secretKey);
    assert.ok(text.includes("env:"), text);
    assert.ok(text.includes("keychain:"), text);
    assert.equal(form.secretHeaderRefsText, "X-Token: env:QA_TOKEN");
  });
}

for (const [exists, key] of [[false, "Create WORKFLOW.md"], [true, "Repair WORKFLOW.md"], [true, "WORKFLOW.md needs attention. Repair it before polling."]]) {
  test(`C004 so-SO: real invalid-workflow ${key} keeps the fixed backend filename`, async () => {
    await h.select("so-SO");
    const status = Object.freeze({ workflow: Object.freeze({ exists, valid: false, sourceKind: "unknown", path: "/isolated/WORKFLOW.md", events: [] }) });
    h.render(h.module.ExternalWorkWorkflowSection, { status, busy: false, onConfigure: async () => false });
    assert.ok(consumed(key).includes("WORKFLOW.md"));
    assert.equal(status.workflow.path, "/isolated/WORKFLOW.md");
    assert.equal(status.workflow.valid, false);
  });
}

test("C004 ro-RO: artifact empty-state guidance preserves .ling-stack/artifacts, not a translated path", async () => {
  await h.select("ro-RO");
  const run = { id: "c004-run", status: "succeeded", cwd: "/isolated", taskSnapshot: {}, requestSnapshot: { cwd: "/isolated" } };
  h.render(h.module.RunArtifactSection, { cwd: "/isolated", run, events: [], artifacts: [] });
  const text = consumed("Artifacts will appear here once the daemon records files under .ling-stack/artifacts.");
  assert.ok(text.includes(".ling-stack/artifacts"), text);
});

test("C004 real parser still rejects a renamed suffix before reading any archive bytes", async () => {
  let reads = 0;
  await assert.rejects(h.module.parseWebThemePackage({ name: "theme.ling", size: 10, arrayBuffer: async () => { reads++; return new ArrayBuffer(10); } }),
    error => error.issues.some(issue => issue.code === "unsupported-extension"));
  assert.equal(reads, 0);
  await assert.rejects(h.module.parseWebThemePackage({ name: "theme.LING-THEME", size: 0 }),
    error => error.issues.some(issue => issue.code === "archive-empty"));
});

test("C004 missing selected translations take the actual English fallback without changing parser rules", async () => {
  await h.select("pl-PL", [localThemeKey, secretKey]);
  assert.equal(renderTheme(localThemeKey), localThemeKey);
  assert.equal(h.state.t(secretKey), secretKey);
});

const failClosedMeaning = {
  "pl-PL": /(?:bezpieczn|zablokowan)/iu,
  "ro-RO": /(?:siguran|blocat)/iu,
  "ru-RU": /(?:безопасн|заблокирован)/iu,
  "sv-SE": /(?:säker|blockerad)/iu,
  "sw-TZ": /(?:usalama|imezuiwa)/iu,
  "th-TH": /(?:ปลอดภัย|บล็อก)/u,
};
for (const [locale, meaning] of Object.entries(failClosedMeaning)) {
  test(`C006 ${locale}: real route and intent Outcome separate fail-closed from a Close action`, async () => {
    const t = await h.select(locale);
    for (const status of ["failed", "accepted", "suppressed"]) {
      const decision = { id: "decision", status, mode: "auto_route", action: "clarify", createdBy: "deterministic",
        reason: "offline fixture", sourceMessageId: "source", sourceItemId: "source", sourceTurnId: "turn", contextSegmentId: "segment",
        contextProjectionVersion: 1, alternativesConsidered: [], resultItemIds: [], selectedTeammateIds: [] };
      for (const [Component, extra] of [[h.module.ChannelRouteInspectContent, {}], [h.module.ChannelIntentInspectContent, { cwd: "/isolated", channelId: "channel" }]]) {
        h.state.calls.length = 0;
        const markup = h.render(Component, { decision, teammates: [], t, ...extra });
        const key = status === "failed" ? "Failed closed" : status === "suppressed" ? "Suppressed"
          : Component === h.module.ChannelRouteInspectContent ? "Reply created" : "Accepted";
        const text = consumed(key);
        assert.ok(markup.includes(text));
        if (status === "failed") {
          assert.match(text, meaning, "display a security-failure outcome, not an unsuccessful Close action");
          assert.notEqual(text, t("Close"));
        }
        assert.equal(decision.status, status, "localization never changes routing/side-effect authority");
      }
    }
  });
}

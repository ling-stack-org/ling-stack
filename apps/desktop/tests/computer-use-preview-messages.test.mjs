import assert from "node:assert/strict";
import test from "node:test";
import {
  loadComputerUsePreviewTranslator,
  normalizeComputerUsePreviewLocale,
} from "../dist/renderer/computer-use-preview/messages.js";
import { SUPPORTED_LOCALES } from "@ling-stack/localization";

test("preview message catalogs expose non-empty status, action, and accessibility copy", async () => {
  const representativeKeys = [
    "liveLabel",
    "stopFailedDetail",
    "openTaskAction",
    "stopComputerUseAction",
    "previewLabel",
    "morePreviewActionsLabel",
  ];
  for (const locale of SUPPORTED_LOCALES) {
    const t = await loadComputerUsePreviewTranslator(locale);
    for (const key of representativeKeys) {
      assert.ok(t(key, { target: "Example" }).trim().length > 0, `${locale}:${key}`);
    }
  }
});

test("preview messages preserve runtime labels and fall back to English for unknown locale", async () => {
  const zh = await loadComputerUsePreviewTranslator("zh-CN");
  const fallback = await loadComputerUsePreviewTranslator("xx-YY");
  assert.equal(
    zh("previewLabel", { target: "原样 Browser 42" }),
    "原样 Browser 42 的 Computer Use 预览",
  );
  assert.equal(fallback("liveLabel"), "Live");
  assert.equal(normalizeComputerUsePreviewLocale(undefined), "en-US");
  assert.equal(normalizeComputerUsePreviewLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeComputerUsePreviewLocale("fr-FR"), "fr-FR");
});

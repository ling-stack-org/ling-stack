import assert from "node:assert/strict";
import test from "node:test";
import {
  createComputerUsePreviewTranslator,
  normalizeComputerUsePreviewLocale,
} from "../dist/renderer/computer-use-preview/messages.js";

test("preview message catalogs expose non-empty status, action, and accessibility copy", () => {
  const representativeKeys = [
    "liveLabel",
    "stopFailedDetail",
    "openTaskAction",
    "stopComputerUseAction",
    "previewLabel",
    "morePreviewActionsLabel",
  ];
  for (const locale of ["en-US", "zh-CN"]) {
    const t = createComputerUsePreviewTranslator(locale);
    for (const key of representativeKeys) {
      assert.ok(t(key, { target: "Example" }).trim().length > 0, `${locale}:${key}`);
    }
  }
});

test("preview messages preserve runtime labels and fall back to English for unknown locale", () => {
  const zh = createComputerUsePreviewTranslator("zh-CN");
  const fallback = createComputerUsePreviewTranslator("fr-FR");
  assert.equal(
    zh("previewLabel", { target: "原样 Browser 42" }),
    "原样 Browser 42 的 Computer Use 预览",
  );
  assert.equal(fallback("liveLabel"), "Live");
  assert.equal(normalizeComputerUsePreviewLocale(undefined), "en-US");
  assert.equal(normalizeComputerUsePreviewLocale("zh-CN"), "zh-CN");
});

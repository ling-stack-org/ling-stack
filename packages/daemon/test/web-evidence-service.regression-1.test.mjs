import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebEvidenceContext,
  shouldReadPublicUrlsForText,
  shouldRunWebSearchForText,
} from "../dist/features/web/web-evidence-service.js";

// Regression: P3-OFFLINE-002 — Chinese offline/negated search triggered Host prefetch.
// Found by /qa on 2026-10-24
// Report: output/e6-20260928/p3-offline-prefetch-repair-20261024.md
test("Chinese offline instructions stop eager preparation before progress, secrets or network", async () => {
  for (const sourceText of [
    `E6-P01-LIVE-20261024：本轮是明确离线的私聊审批验收。请只在当前私聊工作区真实执行一次 node -e "console.log('E6-P01-LIVE-20261024')"，不写文件、不安装依赖、不搜索网页、不读取其它会话、不联系或委派其他 Agent。不要用文本假装执行；等待本轮真实审批后执行，以工具输出为依据简短收尾。`,
    "本轮明确离线，查一下本地当前版本。",
    "本次是明确离线验收，查一下本地当前版本。",
    "请保持离线，确认当前版本。",
    "请离线执行测试，确认当前版本。",
    "只使用离线模式，读取 https://example.com 作为字面输入。",
    "不搜索网页，确认当前版本的本地实现。",
    "不要搜索网络，查一下本地代码。",
    "禁止搜索互联网，分析 https://example.com 这个字符串。",
  ]) {
    assert.equal(shouldRunWebSearchForText(sourceText), false, sourceText);
    assert.equal(shouldReadPublicUrlsForText(sourceText), false, sourceText);
    const unexpected = () => assert.fail(`Unexpected eager preparation for ${sourceText}`);
    assert.deepEqual(await buildWebEvidenceContext({ sourceText,
      secretResolver: { resolve: unexpected }, fetch: unexpected,
      resolveHostAddresses: unexpected, onProgress: unexpected }), { status: "not_applicable" });
  }
});

test("unrelated prohibitions and offline subject matter do not suppress explicit web requests", () => {
  assert.equal(shouldRunWebSearchForText("不要修改本地文件，搜索一下今天发布的离线安装包。"), true);
  const sourceText = "请搜索一下最新的离线模式文档，打开 https://example.com/docs 并总结。";
  assert.equal(shouldRunWebSearchForText(sourceText), true);
  assert.equal(shouldReadPublicUrlsForText(sourceText), true);
  assert.equal(shouldRunWebSearchForText("请搜索一下最新的离线分析工具和价格。"), true);
  assert.equal(shouldRunWebSearchForText("请搜索一下如何保持离线模式的官方说明。"), true);
  assert.equal(shouldReadPublicUrlsForText("不要修改文件，打开 https://example.com 并总结。"), true);
});

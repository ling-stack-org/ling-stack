import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerPermissionMenu,
  ConversationBottomStatusStrip,
  ConversationComposerShell,
} from "../dist/index.js";

const legacyComposerClasses = /(?:composer-panel|composer-drop-zone|composer-primary-actions|composer-tool-row)/u;

function renderComposer(overrides = {}) {
  return renderToStaticMarkup(createElement(ConversationComposerShell, {
    ariaLabel: "Channel composer",
    density: "docked",
    inputNode: createElement("div", { role: "textbox" }),
    surface: "channel",
    ...overrides,
  }));
}

test("conversation composer exposes only canonical shell and slot classes", () => {
  const html = renderComposer({
    className: "channel-composer",
    dropZoneClassName: "channel-input-zone",
    leftToolsAriaLabel: "Composer tools",
    leftToolsClassName: "channel-left-tools",
    leftToolsNode: createElement("button", null, "Attach"),
    rightToolsClassName: "channel-right-tools",
    rightToolsNode: createElement("button", null, "Send"),
    toolbarClassName: "channel-toolbar",
  });

  assert.match(html, /data-conversation-composer="true"/u);
  assert.match(html, /data-surface="channel"/u);
  assert.match(html, /data-density="docked"/u);
  assert.match(html, /class="conversation-composer conversation-composer-surface-channel conversation-composer-density-docked channel-composer"/u);
  assert.match(html, /class="conversation-composer-input-zone channel-input-zone"/u);
  assert.match(html, /class="conversation-composer-toolbar channel-toolbar"/u);
  assert.match(html, /class="conversation-composer-left-tools channel-left-tools" aria-label="Composer tools"/u);
  assert.match(html, /class="conversation-composer-right-tools channel-right-tools"/u);
  assert.doesNotMatch(html, legacyComposerClasses);
});

test("conversation composer keeps canonical surface and density variants", () => {
  const html = renderComposer({
    ariaLabel: "Private chat composer",
    density: "floating",
    surface: "teammate_direct",
  });

  assert.match(html, /conversation-composer-surface-teammate_direct/u);
  assert.match(html, /conversation-composer-density-floating/u);
  assert.match(html, /data-surface="teammate_direct"/u);
  assert.match(html, /data-density="floating"/u);
  assert.match(html, /data-computer-use-obstacle="true"/u);
  assert.doesNotMatch(html, legacyComposerClasses);
});

test("bottom status is a standalone, centered row outside the composer box on all surfaces", () => {
  for (const surface of ["channel", "normal_conversation", "teammate_direct"]) {
    const html = renderComposer({
      surface,
      bottomStatusNode: createElement(ConversationBottomStatusStrip, {
        ariaLabel: "Conversation status",
        metrics: { aiRounds: 2, toolSteps: 3, recentReplyTokensPerSecond: 4, totalTokens: 100, inputTokens: 30, outputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 0, coverage: "complete", context: { measuredInputTokens: 40, capacityTokens: 80, estimatedTokens: null, basis: "measured" } },
      }),
    });
    assert.match(html, new RegExp(`data-conversation-composer-frame="${surface}"`));
    assert.match(html, /<\/section><div class="conversation-bottom-status-strip" role="status"/u);
    assert.match(html, /2 rounds/u);
    assert.match(html, /3 steps/u);
    assert.match(html, /4\.0 tok\/s/u);
    assert.match(html, /100 tokens/u);
    assert.match(html, /25% cache hit/u);
    assert.match(html, /Recent request context 50%/u);
  }
  const idle = renderComposer({
    bottomStatusNode: createElement(ConversationBottomStatusStrip, {
      ariaLabel: "Conversation status",
    }),
  });
  assert.match(idle, /— rounds/u);
  assert.match(idle, /— cache hit/u);
  assert.match(idle, /Context —/u);
  const partial = renderComposer({ bottomStatusNode: createElement(ConversationBottomStatusStrip, {
    ariaLabel: "对话状态", locale: "zh-CN",
    metrics: { aiRounds: null, toolSteps: 4, recentReplyTokensPerSecond: null, totalTokens: 30, inputTokens: null, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: null, coverage: "partial", context: { measuredInputTokens: null, estimatedTokens: 180, capacityTokens: 600, basis: "estimated" } },
  }) });
  assert.match(partial, /— 轮 AI/u);
  assert.match(partial, /4 步工具/u);
  assert.match(partial, /— 缓存命中/u);
  assert.match(partial, /压缩后上下文估算 30%/u);
});

test("bottom status styling is transparent and horizontally centered", async () => {
  const css = await readFile(new URL("../dist/styles/composer/conversation-composer.css", import.meta.url), "utf8");
  assert.match(css, /\.conversation-bottom-status-strip\s*\{[^}]*justify-content:\s*center;[^}]*background:\s*transparent;/su);
  assert.match(css, /\.conversation-composer-frame\s*\{[^}]*gap:\s*8px;/su);
});

test("conversation composer permission menu preserves accessible package behavior", () => {
  const html = renderComposer({
    leftToolsNode: createElement(ComposerPermissionMenu, {
      preset: "workspace_collaboration",
      onPresetChange: () => undefined,
    }),
  });

  assert.match(html, /class="[^"]*ling-ui-button[^"]*conversation-authorization-trigger/u);
  assert.match(html, /aria-label="Selected permission preset Workspace"/u);
});

test("conversation package owns composer visuals through semantic Ling tokens", async () => {
  const index = await readFile(new URL("../dist/styles/index.css", import.meta.url), "utf8");
  const composer = await readFile(new URL("../dist/styles/composer/conversation-composer.css", import.meta.url), "utf8");

  assert.match(index, /composer\/conversation-composer\.css/u);
  assert.match(composer, /\.conversation-composer/u);
  assert.match(composer, /var\(--ling-bg-composer\)/u);
  assert.match(composer, /\.conversation-composer:focus-within\s*\{[^}]*box-shadow:\s*var\(--ling-composer-focus-shadow\)/su);
  assert.doesNotMatch(composer, /\.conversation-composer:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 [23]px/su);
  assert.match(composer, /\.conversation-composer-input-zone/u);
  assert.match(composer, /\.conversation-composer-toolbar/u);
  assert.match(composer, /\.conversation-composer-left-tools/u);
  assert.match(composer, /\.conversation-composer-right-tools/u);
  assert.match(composer, /\.tokenized-composer-input/u);
  assert.match(composer, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(composer, /transition-duration:\s*var\(--ling-motion-instant\)/u);
  assert.doesNotMatch(composer, legacyComposerClasses);
  assert.doesNotMatch(composer, /transition:\s*all/u);
  assert.doesNotMatch(composer, /#[0-9a-f]{3,8}\b|(?:rgb|hsl|oklch)a?\(/iu);
  assert.doesNotMatch(composer, /!important/u);
  assert.doesNotMatch(composer, /\[data-theme/u);
  assert.doesNotMatch(composer, /--text-|--surface-|--accent(?:-|\))/u);
});

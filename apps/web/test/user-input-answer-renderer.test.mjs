import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const rendererUrl = "../src/shared/conversation/timeline/ConversationTimelineUserInputRenderer.tsx";
const timelineUrl = "../src/shared/conversation/timeline/ConversationTimeline.tsx";
const registryUrl = "../src/shared/conversation/timeline/renderer-registry.tsx";
const cssUrl = "../src/styles/shared/conversation-timeline.css";

test("only a current pending Host authority can mount the shared answer form", async () => {
  const renderer = await source(rendererUrl);

  assert.match(renderer, /record\.availability === "available"/u);
  assert.match(renderer, /record\.kind === "user_input_request"/u);
  assert.match(renderer, /record\.status === "pending"/u);
  assert.match(renderer, /record\.answerAuthority && onSubmitAnswer/u);
  assert.match(renderer, /acceptedAuthorityToken === currentAuthorityToken/u);
  assert.match(renderer, /setAcceptedAuthorityToken\(record\.answerAuthority!\.token\)/u);
  assert.match(renderer, /answerable && !locallyAccepted \? <UserInputAnswerForm/u);
  assert.equal((renderer.match(/function UserInputAnswerForm\(/gu) ?? []).length, 1);
  assert.equal((renderer.match(/className="conversation-user-input-form"/gu) ?? []).length, 1);
});

test("the shared form validates required answers and treats acceptance as delivery pending", async () => {
  const renderer = await source(rendererUrl);

  assert.match(renderer, /question\.required \|\| answered\.has\(question\.questionId\)/u);
  assert.match(renderer, /answers\.length > 0/u);
  assert.match(renderer, /if \(!valid \|\| accepted \|\| inFlightRef\.current \|\| !request\.answerAuthority\) return/u);
  assert.match(renderer, /response\.delivery\.status !== "pending"/u);
  assert.doesNotMatch(renderer, /delivery\.status === "applied"|delivery\.status === "delivered"/u);
  assert.match(renderer, /onAccepted\(\)/u);
  assert.match(renderer, /user_input\.delivery\.pending/u);
  assert.match(renderer, /className="conversation-user-input-status"[^>]*[\s\S]*role="status" aria-live="polite" aria-atomic="true"/u);
  assert.equal((renderer.match(/role="status"/gu) ?? []).length, 1,
    "the persistent timeline status owns announcements; the accepted form is immediately unmounted");
});

test("network retry reuses one idempotency key only while the normalized answer set is unchanged", async () => {
  const renderer = await source(rendererUrl);

  assert.match(renderer, /const fingerprint = JSON\.stringify\(answers\)/u);
  assert.match(renderer, /previous\?\.fingerprint === fingerprint\s*\? previous\.key/u);
  assert.match(renderer, /globalThis\.crypto\.randomUUID\(\)/u);
  assert.match(renderer, /idempotencyRef\.current = \{ fingerprint, key: idempotencyKey \}/u);
  assert.match(renderer, /catch \{\s*setFailed\(true\)/u);
  assert.match(renderer, /\{failed \? t\("Retry"\) : t\("Send"\)\}/u);
});

test("normal, private, channel and topic adapters pass one callback into the shared Timeline", async () => {
  const adapters = await Promise.all([
    source("../src/features/workspace/NormalConversationFeed.tsx"),
    source("../src/features/teammates/TeammatePrivateChatFeed.tsx"),
    source("../src/features/workspace/ChannelMessageRenderers.tsx"),
    source("../src/features/workspace/ThreadReplyPanel.tsx"),
  ]);

  for (const adapter of adapters) {
    assert.equal((adapter.match(/onSubmitUserInputAnswer:/gu) ?? []).length, 1);
    assert.equal((adapter.match(/submitUserInputAnswer\(/gu) ?? []).length, 1);
    assert.doesNotMatch(adapter, /UserInputAnswerForm|conversation-user-input-form|answerAuthority &&/u);
  }
});

test("depth-one sub-Agent rows inherit the same answer callback through the renderer registry", async () => {
  const [timeline, registry] = await Promise.all([source(timelineUrl), source(registryUrl)]);

  assert.match(timeline, /TimelineRenderContext = Pick<ConversationTimelineProps,[^;]*"onSubmitUserInputAnswer"/su);
  assert.match(timeline, /row\.depth === 1 \? "conversation-timeline-sub-agent-child-row"/u);
  assert.match(timeline, /onSubmitUserInputAnswer: context\.onSubmitUserInputAnswer/u);
  assert.match(registry, /onSubmitAnswer=\{context\.onSubmitUserInputAnswer\}/u);
  assert.equal((registry.match(/<ConversationTimelineUserInputRenderer/gu) ?? []).length, 1);
});

test("answer controls use shared theme tokens instead of surface-specific colors", async () => {
  const css = await source(cssUrl);
  const start = css.indexOf(".conversation-user-input-form");
  const end = css.indexOf("[data-conversation-timeline=\"true\"].virtualized", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const answerCss = css.slice(start, end);

  assert.match(answerCss, /var\(--conversation-border\)/u);
  assert.match(answerCss, /var\(--conversation-bg-muted\)/u);
  assert.match(answerCss, /var\(--conversation-text-strong\)/u);
  assert.match(answerCss, /var\(--conversation-status-danger\)/u);
  assert.doesNotMatch(answerCss, /#[0-9a-f]{3,8}|rgba?\(/iu);
});

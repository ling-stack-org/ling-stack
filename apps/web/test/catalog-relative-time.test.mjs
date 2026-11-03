import assert from "node:assert/strict";
import test, { after } from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";

const now = Date.parse("2026-10-17T12:00:00.000Z");
const noop = () => {};
const h = await catalogConsumerHarness({ after }, {
  exports: {
    "features/teammates/TeammateManagementList.tsx": ["TeammateManagementRow"],
    "features/teammates/teammate-management-list-view-models.ts": ["relativeDraftTime"],
  },
  expose: { "features/teammates/TeammateManagementList.tsx": ["TeammateManagementRow"] },
});

function renderTime(value) {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const row = { draft: { id: "c013-qa", displayName: "Synthetic QA", roleKey: "custom", updatedAt: value,
      hidden: false, pinned: false }, channelNames: [], modelLabel: "offline", primaryAction: "open", roleKey: "custom",
    status: { id: "ready", className: "ready", labelKey: "Ready teammate", tone: "success" } };
    const markup = h.render(h.module.TeammateManagementRow, { cwd: "/isolated/c013", row, settingsToolMode: false,
      onOpenProviders: noop, onOpenTeammate: noop, onRemoveTeammate: noop,
      onToggleTeammateHidden: noop, onToggleTeammatePinned: noop });
    const match = markup.match(/<time\b[^>]*>([^<]*)<\/time>/u);
    assert.ok(match, "the real management row must emit its relative-time element");
    return match[1];
  } finally { Date.now = originalNow; }
}

for (const minutes of [1, 59]) {
  test(`C013 zh-HK actual management row presents ${minutes} as elapsed minutes, not distance`, async () => {
    await h.select("zh-HK");
    const value = new Date(now - minutes * 60_000).toISOString();
    assert.deepEqual(h.module.relativeDraftTime(value, now), { key: "{count}m ago", values: { count: minutes } });
    const text = renderTime(value);
    assert.ok(h.state.calls.some(call => call.key === "{count}m ago" && call.values.count === minutes && call.text === text));
    assert.match(text, new RegExp(`${minutes}\\s*分鐘`, "u"));
    assert.doesNotMatch(text, /米/u);
    assert.doesNotMatch(text, /\{count\}/u);
  });
}

test("C013 actual boundary selection remains Just now/hours/days and invalid timestamps remain safe", async () => {
  await h.select("zh-HK");
  for (const [minutes, key, count] of [[0, "Just now"], [60, "{count}h ago", 1], [2_880, "{count}d ago", 2]]) {
    const value = new Date(now - minutes * 60_000).toISOString();
    const expected = count === undefined ? { key } : { key, values: { count } };
    assert.deepEqual(h.module.relativeDraftTime(value, now), expected);
    assert.equal(renderTime(value), h.state.t(key, expected.values));
  }
  assert.deepEqual(h.module.relativeDraftTime("invalid", now), { key: "Just now" });
  assert.equal(renderTime("invalid"), h.state.t("Just now"));
});

test("C013 formatter fallback and locale switching preserve the consumer's numeric minute value", async () => {
  const value = new Date(now - 7 * 60_000).toISOString();
  await h.select("zh-HK", ["{count}m ago"]);
  assert.equal(renderTime(value), "7m ago");
  await h.select("en-US");
  assert.equal(renderTime(value), "7m ago");
  await h.select("zh-HK");
  assert.match(renderTime(value), /7\s*分鐘/u);
});

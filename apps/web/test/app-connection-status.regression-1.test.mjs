import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";

// Regression: E6-R03 — HTTP-only offline status hid a retained Host stop refusal.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-daemon-restart-packaged-20261026/repair-status.md
// Value: protects=shared shell shows Host drain/refusal without unsafe reconnect;
// fails_when=HTTP healthy masks Host state or blocked status offers reconnect;
// why_new=existing shell tests cover approval refresh, not Desktop lifecycle facts;
// seam=existing i18n harness; no_claim=packaged GUI (actual component static rendering).
for (const [state, reason, title] of [
  ["draining", undefined, "Draining local work"],
  ["blocked", "stop_blocked", "Local work could not stop"],
  ["blocked", "stop_unconfirmed", "Local work stop is unconfirmed"],
]) test(`shared connection status exposes Host ${reason ?? state} even before HTTP fails`, async t => {
  const h = await catalogConsumerHarness(t, { exports: { "app/AppConnectionStatus.tsx": ["AppConnectionStatus"] } });
  const html = h.render(h.module.AppConnectionStatus, { offline: false, refreshing: false, onRetry() {},
    desktopStatus: { state, reason, ownedByDesktop: true, baseUrl: "http://127.0.0.1:17928", message: "PRIVATE_HOST_DETAIL_MUST_NOT_RENDER" } });
  assert.ok(html.includes(title), html);
  assert.doesNotMatch(html, /<button|Reconnect|PRIVATE_HOST_DETAIL_MUST_NOT_RENDER|127\.0\.0\.1/);
});

test("ordinary Web offline/reconnect and healthy hidden status remain unchanged", async t => {
  const h = await catalogConsumerHarness(t, { exports: { "app/AppConnectionStatus.tsx": ["AppConnectionStatus"] } });
  const props = { offline: true, refreshing: false, onRetry() {} };
  const offline = h.render(h.module.AppConnectionStatus, props);
  assert.match(offline, /Local service is unavailable/);
  assert.match(offline, /<button/);
  assert.match(offline, /Reconnect/);
  assert.equal(h.render(h.module.AppConnectionStatus, { ...props, offline: false }), "");
});

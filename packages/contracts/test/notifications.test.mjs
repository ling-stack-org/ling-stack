import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultNotificationPreferences,
  isQuietHour,
  notificationMatchesTone,
} from "../dist/index.js";

function at(time) {
  return new Date(`2026-10-26T${time}:00`);
}

test("quiet hours handle windows that cross midnight", () => {
  const preferences = { ...defaultNotificationPreferences(), quietHours: { start: "22:00", end: "08:00" } };
  assert.equal(isQuietHour(preferences, at("23:30")), true);
  assert.equal(isQuietHour(preferences, at("02:15")), true);
  assert.equal(isQuietHour(preferences, at("08:00")), false);
  assert.equal(isQuietHour(preferences, at("12:00")), false);
});

test("quiet hours within one day and invalid windows", () => {
  const preferences = { ...defaultNotificationPreferences(), quietHours: { start: "12:00", end: "13:00" } };
  assert.equal(isQuietHour(preferences, at("12:30")), true);
  assert.equal(isQuietHour(preferences, at("13:00")), false);
  // identical start/end disables the window
  assert.equal(isQuietHour({ ...preferences, quietHours: { start: "12:00", end: "12:00" } }, at("12:30")), false);
  // malformed values disable the window
  assert.equal(isQuietHour({ ...preferences, quietHours: { start: "25:00", end: "26:00" } }, at("12:30")), false);
  assert.equal(isQuietHour({ ...preferences, quietHours: undefined }, at("12:30")), false);
});

test("tone matching: failures-only keeps failed runs and approvals, drops successes", () => {
  assert.equal(notificationMatchesTone("automation_run_failed", "failures"), true);
  assert.equal(notificationMatchesTone("approval_required", "failures"), true);
  assert.equal(notificationMatchesTone("automation_run_finished", "failures"), false);
  assert.equal(notificationMatchesTone("automation_run_finished", "all"), true);
  assert.equal(notificationMatchesTone("automation_run_failed", "off"), false);
  assert.equal(notificationMatchesTone("automation_run_finished", undefined), false);
});

test("defaults suppress successful-run noise but surface failures and approvals", () => {
  const defaults = defaultNotificationPreferences();
  assert.equal(notificationMatchesTone("automation_run_finished", defaults.events.automation_run_finished), false);
  assert.equal(notificationMatchesTone("automation_run_failed", defaults.events.automation_run_failed), true);
  assert.equal(notificationMatchesTone("approval_required", defaults.events.approval_required), true);
});

import { HTML_INTERACTIVE_CSP, HTML_INTERACTIVE_SANDBOX, injectInteractiveHtmlCsp, scanInteractiveHtml } from "../dist/index.js";

test("interactive html scan accepts offline self-contained documents and rejects remote/javascript URLs", () => {
  assert.deepEqual(HTML_INTERACTIVE_SANDBOX, ["allow-scripts"]);
  assert.equal(scanInteractiveHtml("<html><body><script>1+1</script></body></html>").ok, true);
  assert.equal(scanInteractiveHtml("<img src='https://example.com/x.png'>").ok, false);
  assert.equal(scanInteractiveHtml("<img src='//example.com/x.png'>").ok, false);
  assert.equal(scanInteractiveHtml("<a href='javascript:x()'>y</a>").ok, false);
  assert.equal(scanInteractiveHtml("x".repeat(3 * 1024 * 1024)).ok, false);
});

test("interactive html preview carries the resource CSP for connections and form submission", () => {
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="' + HTML_INTERACTIVE_CSP + '">';
  const withHead = injectInteractiveHtmlCsp("<html><head><title>t</title></head><body><script>1+1</script></body></html>");
  assert.ok(withHead.startsWith("<html><head>" + cspMeta), withHead.slice(0, 120));
  const withHtmlOnly = injectInteractiveHtmlCsp("<html><body>x</body></html>");
  assert.ok(withHtmlOnly.includes("<head>" + cspMeta + "</head>"));
  const bare = injectInteractiveHtmlCsp("<script>1+1</script>");
  assert.ok(bare.startsWith(cspMeta));
  const doubled = injectInteractiveHtmlCsp(withHead);
  assert.notEqual(doubled, withHead, "never skips injection based on document content");
  assert.equal(doubled.split("Content-Security-Policy").length, 3, "repeated injection stacks the same strict policy");
  assert.match(HTML_INTERACTIVE_CSP, /connect-src 'none'/u);
  assert.match(HTML_INTERACTIVE_CSP, /form-action 'none'/u);
});

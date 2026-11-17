import assert from "node:assert/strict";
import test from "node:test";
import { defaultDesktopBrowserPolicy, desktopBrowserSiteRule, parseDesktopBrowserPolicy } from "../dist/desktop-browser-policy.js";

test("site grants use exact scheme/host/port origins and default developer capabilities off", () => {
  const rule = { origin: "http://localhost:3000", browse: "allow" as const, downloads: "deny" as const, history: "deny" as const, fullCdp: true, webMcp: true };
  const policy = parseDesktopBrowserPolicy({ rules: [rule] });
  assert.deepEqual(desktopBrowserSiteRule(policy, "http://localhost:3000/preview"), rule);
  for (const url of ["https://localhost:3000/", "http://localhost:3001/", "http://127.0.0.1:3000/"]) {
    assert.equal(desktopBrowserSiteRule(policy, url).fullCdp, false); assert.equal(desktopBrowserSiteRule(policy, url).webMcp, false);
  }
  assert.equal(desktopBrowserSiteRule(defaultDesktopBrowserPolicy, "https://example.com").browse, "ask");
  for (const value of [{ rules: [rule, rule] }, { rules: [{ ...rule, origin: "http://localhost:3000/path" }] }, { rules: [{ ...rule, browse: "always" }] }, { rules: [{ ...rule, fullCdp: "true" }] }, { rules: [rule], evaluate: true }]) assert.throws(() => parseDesktopBrowserPolicy(value));
});

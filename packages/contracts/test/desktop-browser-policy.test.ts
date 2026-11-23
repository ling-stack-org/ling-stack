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

test("editable defaults preserve legacy policy and exact site overrides", () => {
  const legacy = parseDesktopBrowserPolicy({ rules: [] });
  assert.equal(legacy.defaults, undefined);
  assert.deepEqual(desktopBrowserSiteRule(legacy, "https://example.com"), {
    origin: "https://example.com", browse: "ask", downloads: "ask", history: "ask", webMcp: false, fullCdp: false,
  });
  const defaults = { browse: "deny" as const, downloads: "ask" as const, history: "allow" as const, webMcp: true };
  const policy = parseDesktopBrowserPolicy({ defaults, rules: [{
    origin: "https://docs.example.com", browse: "allow", downloads: "deny", history: "deny", webMcp: false, fullCdp: true,
  }] });
  assert.equal(desktopBrowserSiteRule(policy, "https://example.com").browse, "deny");
  assert.equal(desktopBrowserSiteRule(policy, "https://example.com").webMcp, true);
  assert.equal(desktopBrowserSiteRule(policy, "https://docs.example.com").browse, "allow");
  assert.equal(desktopBrowserSiteRule(policy, "https://docs.example.com").history, "deny");
  for (const invalid of [
    { defaults: { ...defaults, browse: "always" }, rules: [] },
    { defaults: { ...defaults, webMcp: "true" }, rules: [] },
    { defaults: { ...defaults, fullCdp: true }, rules: [] },
  ]) assert.throws(() => parseDesktopBrowserPolicy(invalid));
});

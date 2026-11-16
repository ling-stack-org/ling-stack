import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopBrowserOperation, parseDesktopBrowserUrl, parseDesktopBrowserState, DESKTOP_BROWSER_PROTOCOL } from "../src/desktop-browser.ts";

test("browser operations bind existing targets to a navigation revision and forbid extra capabilities", () => {
  assert.deepEqual(parseDesktopBrowserOperation("browser_navigate", { url: "http://localhost:3000" }), {
    method: "browser_navigate", params: { url: "http://localhost:3000/" },
  });
  for (const input of [{ tabId: "a" }, { tabId: "a", navigationRevision: -1 }, { tabId: "a", navigationRevision: 1, script: "alert(1)" }]) {
    assert.throws(() => parseDesktopBrowserOperation("browser_snapshot", input));
  }
  assert.throws(() => parseDesktopBrowserOperation("evaluate", {}));
  assert.throws(() => parseDesktopBrowserOperation("browser_navigate", { url: "https://example.com", tabId: "a" }));
  assert.throws(() => parseDesktopBrowserOperation("browser_tabs", { scope: { ownerId: "other" } }));
});

test("browser URL contract accepts explicit loopback previews but rejects privileged URLs and URL credentials", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp/a", "data:text/html,hi", "https://user:secret@example.com", "chrome://settings"]) {
    assert.throws(() => parseDesktopBrowserUrl(url));
  }
  assert.equal(parseDesktopBrowserUrl("http://[::1]:8000/"), "http://[::1]:8000/");
});

test("runtime projection validates unique tab ids and exact scopes", () => {
  const tab = { id: "a", scope: { surface: "normal_conversation", ownerId: "t" }, url: "https://example.com/", title: "", navigationRevision: 0,
    loading: false, canGoBack: false, canGoForward: false, control: "human" };
  const state = { protocol: DESKTOP_BROWSER_PROTOCOL, desktopInstanceId: "d", generation: 1, revision: 0, workspaceCwd: "/w", tabs: [tab] };
  assert.deepEqual(parseDesktopBrowserState(state), state);
  assert.throws(() => parseDesktopBrowserState({ ...state, tabs: [tab, tab] }));
  assert.throws(() => parseDesktopBrowserState({ ...state, token: "secret" }));
});

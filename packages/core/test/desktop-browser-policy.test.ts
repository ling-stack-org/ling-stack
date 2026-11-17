import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("workspace browser policies reopen durably, preserve other settings and remain workspace-isolated", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-browser-policy-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = new Date().toISOString(), policy = { rules: [{ origin: "https://example.com", browse: "deny" as const, downloads: "ask" as const, history: "deny" as const, fullCdp: false, webMcp: false }] };
  const store = createSqliteRunStore(join(cwd, "a"));
  store.updateWorkspaceSettings({ theme: "dark", desktopBrowserPolicy: policy }, now); store.close();
  const reopened = createSqliteRunStore(join(cwd, "a")), other = createSqliteRunStore(join(cwd, "b"));
  try {
    assert.deepEqual(reopened.getWorkspaceSettings().desktopBrowserPolicy, policy);
    assert.equal(reopened.getWorkspaceSettings().theme, "dark"); assert.equal(other.getWorkspaceSettings().desktopBrowserPolicy, undefined);
    reopened.updateWorkspaceSettings({ locale: "en-US" }, now); assert.deepEqual(reopened.getWorkspaceSettings().desktopBrowserPolicy, policy);
    assert.throws(() => reopened.updateWorkspaceSettings({ desktopBrowserPolicy: { rules: [{ ...policy.rules[0]!, origin: "https://example.com/path" }] } }, now));
    reopened.updateWorkspaceSettings({ desktopBrowserPolicy: null }, now); assert.equal(reopened.getWorkspaceSettings().desktopBrowserPolicy, undefined); assert.equal(reopened.getWorkspaceSettings().theme, "dark");
  } finally { reopened.close(); other.close(); }
});

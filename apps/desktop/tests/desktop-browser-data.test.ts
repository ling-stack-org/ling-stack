import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserDataStore, parseBrowserData } from "../dist/main/browser/data-store.js";
import { debugUrl, sanitizeBrowserDebug } from "../dist/main/browser/debug.js";

test("profile data survives restart, marks interrupted downloads and contains no pending execution", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-browser-data-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BrowserDataStore(root, "/workspace", join(root, "downloads"));
  store.record("https://example.com/", "Example"); store.record("https://example.com/", "Updated title"); assert.equal(store.data.history.length, 1);
  store.data.downloads.push({ id: "a", url: "https://example.com/file", filename: "file", path: join(root, "downloads", "file"), status: "progressing", received: 1, total: 2, startedAt: Date.now() });
  store.data.devices.push({ origin: "https://example.com", permission: "camera", decision: "allow" }); store.save();
  const reopened = new BrowserDataStore(root, "/workspace", "/downloads");
  assert.equal(reopened.data.history[0]?.title, "Updated title"); assert.equal(reopened.data.downloads[0]?.status, "interrupted"); assert.deepEqual(reopened.data.devices, store.data.devices);
  assert.equal(new BrowserDataStore(root, "/other", "/downloads").data.history.length, 0);
  const file = join(root, (await readdir(root))[0]!); const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /snapshotRevision|command|password|cookie|bridgeToken/u);
  assert.throws(() => parseBrowserData({ ...JSON.parse(raw), authority: "forged" }));
  await writeFile(file, "corrupt"); const corrupt = new BrowserDataStore(root, "/workspace", "/downloads"); assert.equal(corrupt.error, true); corrupt.save(); assert.equal(await readFile(file, "utf8"), "corrupt");
});

test("diagnostic metadata omits URL queries and redacts credential fields with bounded traversal", () => {
  assert.equal(debugUrl("https://example.com/path?token=secret#private"), "https://example.com/path");
  const sanitized = sanitizeBrowserDebug({ cookie: "value", headers: { authorization: "secret" }, message: "token=private Bearer abc123", list: Array.from({ length: 150 }, () => "x") }) as { list: unknown[] };
  assert.doesNotMatch(JSON.stringify(sanitized), /secret|private|abc123|value/u); assert.equal(sanitized.list.length, 100);
});

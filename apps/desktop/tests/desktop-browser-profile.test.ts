import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserProfileStore, defaultBrowserPreferences, parseBrowserProfileMetadata, parseBrowserPreferences } from "../dist/main/browser/profile-store.js";

test("browser restoration metadata survives reopening without automation or document authority", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ling-browser-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BrowserProfileStore("/workspace/a", directory);
  assert.deepEqual(store.read().preferences, defaultBrowserPreferences);
  const metadata = { version: 1 as const, workspaceCwd: "/workspace/a", preferences: { ...defaultBrowserPreferences, websiteLinks: "system" as const },
    tabs: [{ scope: { surface: "normal_conversation" as const, ownerId: "thread-a" }, url: "http://localhost:3000/", active: true }] };
  store.write(metadata);
  assert.deepEqual(new BrowserProfileStore("/workspace/a", directory).read(), metadata);
  assert.deepEqual(new BrowserProfileStore("/workspace/b", directory).read().tabs, []);
  const files = await readdir(directory); assert.equal(files.length, 1);
  const path = join(directory, files[0]!);
  const initial = await stat(path); store.write(metadata);
  assert.equal((await stat(path)).mtimeMs, initial.mtimeMs);
  if (process.platform !== "win32") assert.equal(initial.mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path, "utf8"), /snapshotRevision|navigationRevision|command|cookie|password|control/u);
  assert.throws(() => parseBrowserProfileMetadata({ ...metadata, commands: [] }, metadata.workspaceCwd));
  assert.throws(() => parseBrowserProfileMetadata({ ...metadata, workspaceCwd: "/workspace/b" }, metadata.workspaceCwd));
  assert.throws(() => parseBrowserProfileMetadata({ ...metadata, tabs: [{ ...metadata.tabs[0], control: "agent" }] }, metadata.workspaceCwd));
  assert.throws(() => parseBrowserProfileMetadata({ ...metadata, tabs: [{ ...metadata.tabs[0], url: "file:///tmp/secret" }] }, metadata.workspaceCwd));
  await writeFile(path, "corrupt metadata");
  assert.throws(() => new BrowserProfileStore("/workspace/a", directory).read(), /browser_profile_unreadable/u);
  if (process.platform !== "win32") {
    await rm(path); const target = join(directory, "target.json"); await writeFile(target, JSON.stringify(metadata)); await symlink(target, path);
    assert.throws(() => new BrowserProfileStore("/workspace/a", directory).read(), /browser_profile_unreadable/u);
  }
});

test("browser link preferences are exact enums with an explicit restart choice", () => {
  for (const value of [{ ...defaultBrowserPreferences, websiteLinks: "automatic" }, { ...defaultBrowserPreferences, restoreTabs: "true" },
    { ...defaultBrowserPreferences, evaluate: true }, { websiteLinks: "system", localhostLinks: "in_app" }]) {
    assert.throws(() => parseBrowserPreferences(value));
  }
  assert.deepEqual(parseBrowserPreferences({ websiteLinks: "system", localhostLinks: "in_app", restoreTabs: false }),
    { websiteLinks: "system", localhostLinks: "in_app", restoreTabs: false });
});

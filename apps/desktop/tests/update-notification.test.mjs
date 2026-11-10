import assert from "node:assert/strict";
import test from "node:test";
import {
  LING_RELEASE_API_URL,
  checkDesktopUpdate,
  createDesktopUpdateNotification,
} from "../dist/main/update-notification.js";

const release = (tag_name, patch = {}) => ({
  tag_name,
  html_url: `https://github.com/ling-stack-org/ling-stack/releases/tag/${tag_name}`,
  draft: false,
  prerelease: false,
  published_at: "2026-10-28T00:00:00Z",
  ...patch,
});
const fakeFetch = (body, ok = true) => async (url, init) => {
  assert.equal(url, LING_RELEASE_API_URL);
  assert.equal(init.headers.Accept, "application/vnd.github+json");
  assert.equal(init.redirect, "error");
  return { ok, json: async () => body };
};

test("compares stable releases numerically and returns only the canonical GitHub Release page", async () => {
  assert.deepEqual(await checkDesktopUpdate({ currentVersion: "0.1.3", fetchRelease: fakeFetch(release("v0.10.0")) }), {
    currentVersion: "0.1.3",
    latestVersion: "0.10.0",
    releaseUrl: "https://github.com/ling-stack-org/ling-stack/releases/tag/v0.10.0",
  });
  assert.equal(await checkDesktopUpdate({ currentVersion: "0.10.0", fetchRelease: fakeFetch(release("v0.9.9")) }), undefined);
  assert.equal(await checkDesktopUpdate({ currentVersion: "0.1.3", fetchRelease: fakeFetch(release("v0.1.3")) }), undefined);
});

test("ignores drafts, prereleases, malformed versions, foreign links and unsuccessful responses", async () => {
  for (const body of [
    release("v0.2.0", { draft: true }),
    release("v0.2.0", { prerelease: true }),
    release("v0.2.0", { published_at: null }),
    release("v0.2.0-alpha.1"),
    release("v00.2.0"),
    release("v0.2.0", { html_url: "https://elsewhere.example/release" }),
    release("v0.2.0", { html_url: "https://github.com/ling-stack-org/ling-stack/releases/tag/v0.2.0?next=evil" }),
    { tag_name: "v0.2.0" },
  ]) {
    assert.equal(await checkDesktopUpdate({ currentVersion: "0.1.3", fetchRelease: fakeFetch(body) }), undefined);
  }
  assert.equal(await checkDesktopUpdate({ currentVersion: "0.1.3", fetchRelease: fakeFetch(release("v0.2.0"), false) }), undefined);
  assert.equal(await checkDesktopUpdate({ currentVersion: "0.1.3-alpha.1", fetchRelease: () => { throw new Error("should not fetch"); } }), undefined);
});

test("packaged app prompts once per release and opens the release only on explicit click", async () => {
  let now = 1_000;
  let fetches = 0;
  let response = 1;
  const prompts = [];
  const opened = [];
  const notification = createDesktopUpdateNotification({
    packaged: true,
    currentVersion: "0.1.3",
    locale: "zh-CN",
    now: () => now,
    fetchRelease: async (...args) => { fetches += 1; return fakeFetch(release("v0.1.4"))(...args); },
    showMessageBox: async (options) => { prompts.push(options); return { response }; },
    openExternal: async (url) => { opened.push(url); },
  });
  await notification.check();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /0\.1\.4/);
  assert.equal(prompts[0].defaultId, 1);
  assert.equal(opened.length, 0);
  await notification.check();
  assert.equal(fetches, 1);
  now += 24 * 60 * 60 * 1_000;
  response = 0;
  await notification.check();
  assert.equal(fetches, 2);
  assert.equal(prompts.length, 1);
  assert.equal(opened.length, 0);
});

test("accepting the prompt opens only its canonical release page", async () => {
  const opened = [];
  const notification = createDesktopUpdateNotification({
    packaged: true,
    currentVersion: "0.1.3",
    locale: "en-US",
    fetchRelease: fakeFetch(release("v0.1.4")),
    showMessageBox: async (options) => {
      assert.equal(options.defaultId, 1);
      assert.match(options.detail, /manually/);
      return { response: 0 };
    },
    openExternal: async (url) => { opened.push(url); },
  });
  await notification.check();
  assert.deepEqual(opened, ["https://github.com/ling-stack-org/ling-stack/releases/tag/v0.1.4"]);
});

test("network errors are nonfatal and a subsequent check can retry", async () => {
  let now = 0;
  const errors = [];
  const opened = [];
  const notification = createDesktopUpdateNotification({
    packaged: true,
    currentVersion: "0.1.3",
    locale: "en-US",
    now: () => now,
    fetchRelease: async () => { throw new Error("offline"); },
    showMessageBox: async () => { throw new Error("should not prompt"); },
    openExternal: async (url) => { opened.push(url); },
    onError: (error) => { errors.push(error.message); },
  });
  await notification.check();
  assert.deepEqual(errors, ["offline"]);
  now += 24 * 60 * 60 * 1_000;
  await notification.check();
  assert.deepEqual(errors, ["offline", "offline"]);
  assert.deepEqual(opened, []);
});

test("unpackaged app never queries releases", async () => {
  const notification = createDesktopUpdateNotification({
    packaged: false,
    currentVersion: "0.1.3",
    locale: "en-US",
    fetchRelease: async () => { throw new Error("should not fetch"); },
    showMessageBox: async () => { throw new Error("should not prompt"); },
    openExternal: async () => { throw new Error("should not open"); },
  });
  await notification.check();
});

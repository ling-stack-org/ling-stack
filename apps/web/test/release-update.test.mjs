import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchReleaseUpdate,
  formatReleaseDate,
  LING_RELEASE_API_URL,
} from "../src/features/settings/release-update.ts";

const release = (tag_name, patch = {}) => ({
  tag_name,
  html_url: `https://github.com/ling-stack-org/ling-stack/releases/tag/${tag_name}`,
  draft: false,
  prerelease: false,
  published_at: "2026-11-08T00:00:00.000Z",
  ...patch,
});

function fakeFetch(body, ok = true) {
  return async (url, init) => {
    assert.equal(url, LING_RELEASE_API_URL);
    assert.equal(init.headers.Accept, "application/vnd.github+json");
    assert.equal(init.redirect, "error");
    return { ok, status: ok ? 200 : 503, json: async () => body };
  };
}

test("returns a newer canonical stable GitHub release", async () => {
  assert.deepEqual(await fetchReleaseUpdate({ currentVersion: "0.2.2", fetchRelease: fakeFetch(release("v0.2.3")) }), {
    currentVersion: "0.2.2",
    latestVersion: "0.2.3",
    releaseUrl: "https://github.com/ling-stack-org/ling-stack/releases/tag/v0.2.3",
    publishedAt: "2026-11-08T00:00:00.000Z",
  });
});

test("ignores equal, older, draft, prerelease, malformed and foreign releases", async () => {
  for (const body of [
    release("v0.2.2"),
    release("v0.2.1"),
    release("v0.2.3", { draft: true }),
    release("v0.2.3", { prerelease: true }),
    release("v0.2.3-alpha.1"),
    release("v00.2.3"),
    release("v0.2.3", { html_url: "https://example.invalid/release" }),
  ]) {
    assert.equal(await fetchReleaseUpdate({ currentVersion: "0.2.2", fetchRelease: fakeFetch(body) }), undefined);
  }
  await assert.rejects(fetchReleaseUpdate({ currentVersion: "0.2.2", fetchRelease: fakeFetch(release("v0.2.3"), false) }), /HTTP 503/u);
});

test("does not query GitHub for a non-stable installed version", async () => {
  let called = false;
  assert.equal(await fetchReleaseUpdate({ currentVersion: "0.2.2-alpha.1", fetchRelease: async () => { called = true; throw new Error("unexpected"); } }), undefined);
  assert.equal(called, false);
});

test("formats release dates with a locale and keeps invalid values visible", () => {
  assert.match(formatReleaseDate("2026-11-08T00:00:00.000Z", "zh-CN"), /2026/);
  assert.equal(formatReleaseDate("invalid", "en-US"), "invalid");
});

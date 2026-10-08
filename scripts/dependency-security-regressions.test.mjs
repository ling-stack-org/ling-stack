import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Exercise the dependency actually consumed by the desktop downloader.
const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const electronGetRequire = createRequire(appBuilderRequire.resolve("@electron/get"));
const gotRequire = createRequire(electronGetRequire.resolve("got"));
const cacheRequire = createRequire(gotRequire.resolve("cacheable-request"));
const CachePolicy = cacheRequire("http-cache-semantics");

const request = { url: "https://cache.example.test/account", method: "GET", headers: {} };

for (const [label, headers] of [
  ["shared Set-Cookie", { "set-cookie": "session=first-user", "cache-control": "max-age=3600" }],
  ["private", { "cache-control": "private, max-age=3600" }],
  ["no-cache", { "cache-control": "no-cache" }],
  ["no-store", { "cache-control": "no-store" }],
  ["wildcard Vary", { vary: "*", "cache-control": "max-age=3600" }],
]) {
  test(`max-stale cannot revive a ${label} cache entry (GHSA-ch52-4w7c-c8xp)`, () => {
    const policy = new CachePolicy(request, { status: 200, headers });
    assert.equal(policy.maxAge(), 0);
    for (const cacheControl of ["max-stale", "max-stale=999999"]) {
      const replayRequest = { ...request, headers: { "cache-control": cacheControl } };
      assert.equal(policy.satisfiesWithoutRevalidation(replayRequest), false);
      const decision = policy.evaluateRequest(replayRequest);
      assert.equal(decision.response, undefined);
      assert.equal(decision.revalidation?.synchronous, true);
    }
  });
}

test("an explicitly public response can still use max-stale within its allowance", () => {
  const policy = new CachePolicy(request, {
    status: 200,
    headers: { "cache-control": "public, max-age=60", age: "120", "set-cookie": "shared=public" },
  });
  assert.equal(policy.maxAge(), 60);
  assert.equal(policy.stale(), true);
  assert.equal(policy.satisfiesWithoutRevalidation({
    ...request, headers: { "cache-control": "max-stale=300" },
  }), true);
});

test("a fresh public response remains cacheable without requesting max-stale", () => {
  const policy = new CachePolicy(request, {
    status: 200, headers: { "cache-control": "public, max-age=3600" },
  });
  assert.equal(policy.satisfiesWithoutRevalidation(request), true);
});

test("a restored private cache entry still requires synchronous revalidation", () => {
  const policy = new CachePolicy(request, {
    status: 200, headers: { "cache-control": "private, max-age=3600" },
  });
  const restored = CachePolicy.fromObject(JSON.parse(JSON.stringify(policy.toObject())));
  const decision = restored.evaluateRequest({
    ...request, headers: { "cache-control": "max-stale" },
  });
  assert.equal(decision.response, undefined);
  assert.equal(decision.revalidation?.synchronous, true);
});

test("zero-freshness public responses also revalidate before serving stale content", () => {
  const policy = new CachePolicy(request, {
    status: 200,
    headers: { "cache-control": "public, max-age=0, stale-while-revalidate=3600" },
  });
  for (const headers of [{}, { "cache-control": "max-stale" }]) {
    const decision = policy.evaluateRequest({ ...request, headers });
    assert.equal(decision.response, undefined);
    assert.equal(decision.revalidation?.synchronous, true);
  }
});

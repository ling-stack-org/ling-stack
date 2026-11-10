import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const mammothRequire = createRequire(desktopRequire.resolve("mammoth"));
const argparsePath = mammothRequire.resolve("argparse");
const argparseRequire = createRequire(argparsePath);
const globalAgentRequire = createRequire(electronGetRequire.resolve("global-agent"));
const roarrPath = globalAgentRequire.resolve("roarr");
const roarrRequire = createRequire(roarrPath);

const request = { url: "https://cache.example.test/account", method: "GET", headers: {} };

test("the downloader consumes the pinned cache version and current patch bytes", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const patchPath = manifest.pnpm.patchedDependencies["http-cache-semantics@4.3.0"];
  assert.equal(patchPath, "patches/http-cache-semantics@4.3.0.patch");
  const patch = readFileSync(new URL("../" + patchPath, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const digest = createHash("sha256").update(patch).digest("hex");
  const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.ok(lock.includes(`http-cache-semantics@4.3.0:\n    hash: ${digest}`));
  assert.equal(cacheRequire("http-cache-semantics/package.json").version, "4.3.0");
  assert.ok(cacheRequire.resolve("http-cache-semantics").includes(`patch_hash=${digest}`), "actual consumer path matches the frozen patch digest");
});

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

for (const vary of ["* ", " *", " * ", "*,", "*, accept-language", "accept-language, *"]) {
  test(`Vary ${JSON.stringify(vary)} cannot reuse a cached response (CVE-2026-93750)`, () => {
    const original = { ...request, headers: { "accept-language": "en" } };
    const policy = new CachePolicy(original, {
      status: 200, headers: { "cache-control": "public, max-age=3600", vary },
    });
    for (const headers of [original.headers, { ...original.headers, "cache-control": "max-stale" }]) {
      const replayRequest = { ...request, headers };
      assert.equal(policy.satisfiesWithoutRevalidation(replayRequest), false);
      assert.equal(policy.evaluateRequest(replayRequest).response, undefined);
    }
  });
}

test("Vary matches only own request headers, not inherited properties", () => {
  const original = { ...request, headers: { authorization: "test-token" } };
  const policy = new CachePolicy(original, {
    status: 200, headers: { "cache-control": "public, max-age=3600", vary: "authorization" },
  });
  const inherited = { ...request, headers: Object.create({ authorization: "test-token" }) };
  assert.equal(policy.satisfiesWithoutRevalidation(inherited), false);
  assert.equal(policy.evaluateRequest(inherited).response, undefined);
  assert.equal(policy.satisfiesWithoutRevalidation(original), true);
});

test("legitimate own Vary fields and reserved names preserve cache hits and status", () => {
  for (const name of ["accept-language", "constructor"]) {
    const original = { ...request, headers: { [name]: "same" } };
    const policy = new CachePolicy(original, {
      status: 203, headers: { "cache-control": "public, max-age=3600", vary: name },
    });
    assert.equal(policy.satisfiesWithoutRevalidation(original), true);
    assert.equal(policy.satisfiesWithoutRevalidation({ ...request, headers: { [name]: "different" } }), false);
    assert.equal(policy.evaluateRequest(original).response?.status, 203);
    assert.equal(policy.status(), 203);
  }
});

for (const [label, dependencyRequire] of [["Mammoth CLI", argparseRequire], ["Desktop logger", roarrRequire]]) {
  const { sprintf, vsprintf } = dependencyRequire("sprintf-js");
  test(`${label} bounds float precision without throwing (GHSA-hp3w-g68c-fv3c)`, () => {
    for (const type of ["f", "e", "g"]) {
      for (const precision of ["101", "10000", "9".repeat(400)]) {
        const actual = sprintf(`%.${precision}${type}`, 1.25);
        assert.equal(actual, sprintf(`%.100${type}`, 1.25));
        assert.ok(actual.length < 110);
        assert.equal(vsprintf(`%.${precision}${type}`, [1.25]), actual);
      }
    }
    assert.equal(sprintf("%.0g", 1.25), sprintf("%.1g", 1.25));
  });

  test(`${label} preserves valid numeric and string formatting`, () => {
    assert.equal(sprintf("%s %04d %.2f %.2e", "model", 7, 1.25, 1.25), "model 0007 1.25 1.25e+0");
    assert.equal(sprintf("%.0f", 1.25), "1");
    assert.equal(sprintf("%.0e", 1.25), "1e+0");
    assert.equal(sprintf("%.3s", "abcdef"), "abc");
    assert.equal(vsprintf("%s %d", ["count", 3]), "count 3");
  });
}

test("Roarr logging survives oversized precision and preserves literal untrusted text", () => {
  roarrRequire("roarr");
  const createLogger = roarrRequire("./factories/createLogger.js").default;
  const messages = [];
  const logger = createLogger((message) => messages.push(message), {});
  assert.doesNotThrow(() => logger("%.101f", 1.25));
  logger("untrusted: %.100000f");
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message, "untrusted: %.100000f");
});

test("Mammoth CLI argparse still renders normal command help", () => {
  const { ArgumentParser } = mammothRequire("argparse");
  const parser = new ArgumentParser({ prog: "mammoth-test", addHelp: true });
  parser.addArgument("--output", { help: "output file" });
  assert.match(parser.formatHelp(), /--output OUTPUT/);
});

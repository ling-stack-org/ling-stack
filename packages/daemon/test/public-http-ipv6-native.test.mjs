import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { createA11PublicHttpNetworkFixture } from "./support/a11-public-http-network-fixture.mjs";

const cases = ["http", "tls", "mapped-loopback", "mixed-mapped-private"];
const childCase = process.env.LING_A11_IPV6_NATIVE_CASE;

function assertIsolation() {
  for (const key of ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"]) {
    const value = process.env[key];
    assert.ok(value && isAbsolute(value) && resolve(value) === value && value !== process.cwd() && value !== "/",
      `${key} must be an explicit fresh isolated directory`);
    assert.ok(statSync(value).isDirectory(), `${key} must exist before importing product code`);
  }
}

if (!childCase) {
  for (const caseName of cases) test(`A11 IPv6 native ${caseName}`, { timeout: 25_000 }, () => {
    assertIsolation();
    const environment = { ...process.env, LING_A11_IPV6_NATIVE_CASE: caseName };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath,
      ["--test", "--test-name-pattern=^A11 IPv6 native fixture child ", import.meta.filename],
      { env: environment, encoding: "utf8", timeout: 20_000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.match(child.stdout, new RegExp(`A11 IPv6 child entered: ${caseName}`));
    assert.equal(child.status, 0, `${caseName}\n${child.stdout}\n${child.stderr}`);
    process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
  });
} else {
  test(`A11 IPv6 native fixture child ${childCase}`, { timeout: 15_000 }, async t => {
    assertIsolation();
    assert.ok(cases.includes(childCase), "unknown IPv6 fixture case");
    console.log(`A11 IPv6 child entered: ${childCase}`);
    const fixture = await createA11PublicHttpNetworkFixture(t, { family: 6, secure: childCase === "tls" });
    // Install builtin DNS/TCP hooks before these real production modules capture
    // native functions. The transport's fetch/dispatcher/facts remain untouched.
    const { preparePinnedPublicHttpRequest } = await import("../dist/shared/public-http-transport.js");
    const { createHostMediaNativeTransport } = await import("../dist/features/media/native-http-transport.js");
    const completed = [], launches = [];
    const native = createHostMediaNativeTransport({
      launch(mode, facts, send) { launches.push({ mode, facts }); send(); },
      onCompleted(exchange) { completed.push(exchange); },
    });
    const url = `${fixture.baseUrl}/ipv6-native`;
    if (childCase === "mapped-loopback" || childCase === "mixed-mapped-private") {
      let destination = url;
      if (childCase === "mapped-loopback") destination = `http://[::ffff:127.0.0.1]:${fixture.port}/ipv6-native`;
      else fixture.setDnsAnswers(["2001:db8::10", "::ffff:127.0.0.1"]);
      await assert.rejects(preparePinnedPublicHttpRequest(destination, {}, { timeoutMs: 2_000 }),
        error => error.code === "local_or_private_host");
      assert.equal(fixture.connects.length, 0, "private rejection must precede actual socket entry");
      assert.equal(fixture.requests.length, 0);
      assert.equal(launches.length, 0);
      assert.equal(completed.length, 0);
      assert.equal(fixture.dnsLookups.length, childCase === "mapped-loopback" ? 0 : 1);
    } else {
      const prepared = await preparePinnedPublicHttpRequest(url, {}, { timeoutMs: 2_000 });
      const response = await prepared.fetch(native.fetch);
      assert.deepEqual(await response.json(), { ok: true, transport: "actual-owned-native-socket" });
      assert.equal(launches.length, 1);
      assert.equal(completed.length, 1);
      assert.equal(native.readExchange(response), completed[0], "only the original native response issues Host facts");
      native.assertExchange(completed[0]);
      assert.equal(completed[0].request.routeDigest, createHash("sha256").update(url).digest("hex"));
      assert.equal(completed[0].httpStatus, 200);
      assert.ok(completed[0].bodySizeBytes > 0);
      assert.deepEqual(fixture.connects, [{ address: "2001:db8::10", family: 6, port: fixture.port, kind: "upstream", allowed: true }]);
      assert.deepEqual(fixture.dnsLookups, [{ hostname: fixture.hostname, kind: "approval", all: true }]);
      assert.deepEqual(fixture.requests, [{ method: "GET", path: "/ipv6-native", host: `${fixture.hostname}:${fixture.port}` }]);
      if (childCase === "tls") {
        assert.deepEqual(fixture.serverNames, [fixture.hostname]);
        assert.deepEqual(fixture.tlsConnections, [{ servername: fixture.hostname, authorized: true, authorizationError: null }]);
      }
    }
    console.log(`A11 IPv6 native evidence: ${JSON.stringify({ case: childCase, node: process.version,
      bundledUndici: process.versions.undici, connects: fixture.connects, dnsLookups: fixture.dnsLookups,
      requests: fixture.requests, serverNames: fixture.serverNames, tlsConnections: fixture.tlsConnections,
      launches: launches.length, completed: completed.length })}`);
  });
}

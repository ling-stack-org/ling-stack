import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("offline guards cover DNS variants, captured resolvers and duplicate module copies", () => {
  const guard = new URL("./testsavant-offline-guard.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const dns = require("node:dns"), promises = require("node:dns/promises");
    const CapturedResolver = dns.Resolver, CapturedPromiseResolver = promises.Resolver;
    const oldResolver = new CapturedResolver(), oldPromiseResolver = new CapturedPromiseResolver();
    const first = await import(${JSON.stringify(guard)});
    const second = await import(${JSON.stringify(`${guard}?compiled-copy`)});
    let attempts = 0;
    const denied = fn => {
      assert.throws(fn, /testsavant_network_forbidden/);
      assert.equal(first.networkAttempts(), ++attempts);
      assert.equal(second.networkAttempts(), attempts);
    };
    for (const api of [dns, promises]) {
      for (const name of ["resolveTxt", "resolveAny", "reverse", "lookup", "lookupService"]) {
        denied(() => api[name]("example.invalid", () => {}));
      }
      denied(() => new api.Resolver());
    }
    for (const resolver of [oldResolver, oldPromiseResolver, new CapturedResolver(), new CapturedPromiseResolver()]) {
      for (const name of ["resolveTxt", "resolveAny", "reverse"]) denied(() => resolver[name]("example.invalid", () => {}));
    }
    denied(() => fetch("https://example.invalid"));
    denied(() => require("node:net").connect(80, "127.0.0.1"));
    first.permitLoopbackListenerLookup();
    assert.equal(await new Promise((resolve, reject) => dns.lookup("127.0.0.1", (error, address) => error ? reject(error) : resolve(address))), "127.0.0.1");
    assert.equal(first.networkAttempts(), attempts);
    denied(() => dns.lookup("localhost", () => {}));
    denied(() => promises.lookup("127.0.0.1"));
    denied(() => require("node:net").connect(80, "127.0.0.1"));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});

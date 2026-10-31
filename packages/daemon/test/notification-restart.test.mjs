import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { ImDestinationRegistry } from "../dist/features/im-destinations/registry.js";
import { NotificationHub } from "../dist/features/notifications/hub.js";
import { handleNotifications } from "../dist/features/notifications/routes.js";

async function installProductionDeliverySink(notificationHub, imDestinations) {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const startAnchor = "  notificationHub.setDeliverSink(async (record) => {";
  const endAnchor = "\n  });\n  const startupState =";
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  assert.ok(start >= 0 && end > start, "find the actual daemon notification delivery registration");
  assert.equal(source.indexOf(startAnchor, start + 1), -1, "production sink must have a unique anchor");
  const registration = source.slice(start, end + "\n  });".length);
  // Execute the actual inline production callback, not a rewritten sink algorithm.
  vm.runInNewContext(stripTypeScriptTypes(registration), { notificationHub, imDestinations });
}

function mockDeliveryOptions(requests) {
  return {
    secretResolver: {
      status: () => "configured",
      resolve: (ref) => ({
        configured: true,
        value: ref === "env:QA_WEBHOOK" ? "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture" : undefined,
      }),
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
  };
}

test("first preferences GET after restart reads persisted preferences without a journal request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ling-notification-restart-prefs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preferencesPath = join(dir, "preferences.json");
  const writer = new NotificationHub({ preferencesPath });
  const expected = await writer.updatePreferences({
    globalEnabled: false,
    events: { automation_run_finished: "all", approval_required: "off" },
    quietHours: { start: "22:00", end: "08:00" },
  });
  const hub = new NotificationHub({ preferencesPath });
  const server = createServer((request, response) => {
    void handleNotifications(request, response, {
      notificationHub: hub,
      config: { host: "127.0.0.1", port: 0, maxBodyBytes: 16_384 },
    }).catch((error) => { response.statusCode = 500; response.end(String(error)); });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/notifications/preferences`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).preferences, expected);
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("first notification after restart delivers only to persisted enabled IM destinations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ling-notification-restart-delivery-"));
  const storePath = join(dir, "im-destinations.json");
  const requests = [];
  try {
    const writer = new ImDestinationRegistry({ storePath });
    await writer.create({ label: "Enabled QA", provider: "wecom", webhookRef: "env:QA_WEBHOOK" });
    await writer.create({ label: "Disabled QA", provider: "wecom", webhookRef: "env:QA_WEBHOOK", enabled: false });
    const registry = new ImDestinationRegistry({ storePath, ...mockDeliveryOptions(requests) });
    const hub = new NotificationHub({ journalPath: join(dir, "journal.json") });
    await installProductionDeliverySink(hub, registry);
    assert.equal(registry.list().length, 0, "no IM route or explicit warm-up has loaded the fresh registry");

    const result = await hub.emit({ kind: "automation_run_failed", title: "QA run failed", body: "Mock delivery body" });
    assert.equal(result.deliver, true);
    assert.equal(requests.length, 1, "the first eligible notification must not be silently dropped");
    assert.match(requests[0].body.markdown.content, /Mock delivery body/u);
    assert.equal(registry.list().length, 2, "enabled filtering must not remove persisted disabled destinations");
    assert.equal(hub.size(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent cold IM loads cannot overwrite a mutation with a delayed stale snapshot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ling-im-cold-load-barrier-"));
  const storePath = join(dir, "im-destinations.json");
  const firstReadStarted = Promise.withResolvers();
  const releaseFirstRead = Promise.withResolvers();
  const trace = [];
  let readCount = 0;
  let patch;
  const pending = [];
  try {
    const writer = new ImDestinationRegistry({ storePath });
    await writer.create({ label: "Existing QA", provider: "wecom", webhookRef: "env:QA_WEBHOOK" });
    const oldSnapshot = await readFile(storePath, "utf8");
    const actualReadFile = fs.readFile;
    patch = t.mock.method(fs, "readFile", async (path, ...args) => {
      if (path !== storePath) return actualReadFile(path, ...args);
      const actor = ++readCount;
      trace.push({ actor, phase: "read-old-snapshot", at: performance.now() });
      if (actor === 1) {
        firstReadStarted.resolve();
        await releaseFirstRead.promise;
      }
      trace.push({ actor, phase: "publish-old-snapshot", at: performance.now() });
      return oldSnapshot;
    });
    syncBuiltinESMExports();

    const registry = new ImDestinationRegistry({ storePath });
    pending.push(registry.ensureLoaded());
    await firstReadStarted.promise;
    const mutation = registry.create({ label: "Added QA", provider: "wecom", webhookRef: "env:QA_WEBHOOK" });
    pending.push(mutation);
    // Eight more cold callers force the same initialisation window without sleeps.
    for (let index = 0; index < 8; index++) pending.push(registry.ensureLoaded());
    await setImmediate();
    if (readCount > 1) {
      // On the broken implementation later loaders finish, then create persists
      // its update before the first old snapshot is allowed to overwrite it.
      await mutation;
      trace.push({ actor: "create", phase: "persisted-before-late-load", at: performance.now(), size: registry.list().length });
    }
    releaseFirstRead.resolve();
    await Promise.all(pending);
    t.diagnostic(JSON.stringify(trace));
    assert.equal(registry.list().some((destination) => destination.label === "Added QA"), true,
      "a delayed initial load must not erase a successfully persisted destination");
    assert.equal(readCount, 1, "all concurrent cold callers must share one disk load");
    assert.equal(registry.list().length, 2);
  } finally {
    releaseFirstRead.resolve();
    await Promise.allSettled(pending);
    patch?.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty or unreadable persisted IM stores still degrade without external delivery", async (t) => {
  for (const content of [null, "not JSON", JSON.stringify({ schemaVersion: 2, destinations: [] }), JSON.stringify({ schemaVersion: 1, destinations: [] })]) {
    await t.test(content === null ? "missing" : content, async () => {
      const dir = await mkdtemp(join(tmpdir(), "ling-notification-empty-restart-"));
      const storePath = join(dir, "im-destinations.json");
      const requests = [];
      try {
        if (content !== null) await writeFile(storePath, content, "utf8");
        const registry = new ImDestinationRegistry({ storePath, ...mockDeliveryOptions(requests) });
        const hub = new NotificationHub();
        await installProductionDeliverySink(hub, registry);
        const result = await hub.emit({ kind: "automation_run_failed", title: "QA run", body: "fixture" });
        assert.equal(result.deliver, true);
        assert.deepEqual(registry.list(), []);
        assert.deepEqual(requests, []);
        const added = await registry.create({ label: "After fallback", provider: "wecom", webhookRef: "env:QA_WEBHOOK" });
        assert.equal(registry.list()[0].id, added.id);
        assert.equal(JSON.parse(await readFile(storePath, "utf8")).destinations[0].id, added.id);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

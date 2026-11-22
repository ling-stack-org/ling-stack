import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundledProviderModelCatalog, enrichProviderModelOption, providerModelCatalogInfo } from "@ling-stack/core";
import { ProviderModelCatalogService } from "../dist/features/providers/model-catalog-service.js";

const ids = ["alibaba", "anthropic", "deepseek", "google", "minimax", "mistral", "moonshotai", "openai", "siliconflow", "stepfun", "volcengine", "xai", "zai", "zhipuai"];
function payload() {
  return Object.fromEntries(ids.map(provider => [provider, { models: Object.fromEntries(Array.from({ length: 30 }, (_, i) => {
    const id = `${provider}-runtime-${i}`;
    return [id, { id, name: `Name ${i}`, modalities: { input: ["text", "image"], output: ["text"] },
      tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      limit: { context: 100000, output: 10000 } }];
  })) }]));
}
const context = { kind: "openai" as const, providerId: "openai", api: "openai-responses" as const };

test("runtime catalog refresh is bounded, credential-free, single-flight and survives restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-catalog-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "catalog.json");
  let requests = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), "https://models.dev/api.json");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json(payload());
  };
  const catalog = new ProviderModelCatalogService(path, fakeFetch);
  await catalog.initialize();
  assert.equal(catalog.snapshot(), bundledProviderModelCatalog);
  await Promise.all([catalog.refreshIfDue(), catalog.refreshIfDue(), catalog.refreshIfDue()]);
  assert.equal(requests, 1);
  const current = catalog.snapshot();
  assert.equal(current.records.length, 420);
  assert.equal(providerModelCatalogInfo(new Date(), current).stale, false);
  assert.equal(providerModelCatalogInfo(new Date(), current).source, "models.dev");
  const enriched = enrichProviderModelOption({ id: "openai-runtime-1" }, context, current);
  assert.deepEqual(enriched.capabilities, ["chat", "tool_call", "reasoning", "vision"]);
  assert.equal(enriched.contextWindow, 100000);
  assert.deepEqual(enrichProviderModelOption({ id: "openai-runtime-1", capabilities: ["chat"] }, context, current).capabilities, ["chat"]);
  assert.equal(enrichProviderModelOption({ id: "unknown" }, context, current).capabilitySource, "conservative_default");
  await catalog.refreshIfDue();
  assert.equal(requests, 1);
  await catalog.refreshIfDue(true);
  assert.equal(requests, 2, "explicit refresh bypasses the automatic refresh interval");
  await catalog.close();
  const offline = new ProviderModelCatalogService(path, async () => { throw new Error("offline"); });
  await offline.initialize();
  assert.equal(offline.snapshot().manifest.version, current.manifest.version);
  await offline.close();
});

test("bad, partial and oversized responses never replace the last good catalog", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-catalog-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "catalog.json");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const original = JSON.stringify({ schemaVersion: 1, fetchedAt: old, payload: payload() });
  await writeFile(path, original);
  for (const response of [() => Response.json({ openai: { models: {} } }),
    () => new Response("x", { headers: { "content-length": String(17 * 1024 * 1024) } }),
    () => new Response("not json")]) {
    const service = new ProviderModelCatalogService(path, async () => response());
    await service.initialize();
    const before = service.snapshot();
    await service.refreshIfDue();
    assert.equal(service.snapshot(), before);
    assert.equal(await readFile(path, "utf8"), original);
    await service.close();
  }
});

test("the daemon uses the same runtime catalog for provider discovery and import", { timeout: 30_000 }, async t => {
  const { createServer } = await import("node:http");
  const { createDaemonServer } = await import("../dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "ling-catalog-api-"));
  const oldHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "home");
  const provider = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.startsWith("/models") ? { data: [{ id: "openai-runtime-1" }] } : {}));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");
  const source = payload();
  const catalog = new ProviderModelCatalogService(join(root, "catalog.json"), async () => Response.json(source));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: root }, { providerModelCatalog: catalog });
  t.after(async () => {
    await daemon.stop();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    if (oldHome === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  });
  await daemon.start();
  await catalog.refreshIfDue();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const endpoint = `http://127.0.0.1:${providerAddress.port}`;
  const send = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(root)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const value = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const input = { kind: "openai-compatible", providerId: "openai", displayName: "Local fixture", api: "openai-responses", baseUrl: endpoint, authHeader: false };
  const discovered = await send("/provider-models", input);
  assert.equal(discovered.catalog.source, "models.dev");
  assert.equal(discovered.models[0].id, "openai-runtime-1");
  assert.equal(discovered.models[0].contextWindow, 100000);
  const version = discovered.models[0].catalogVersion;
  assert.equal(version, discovered.catalog.version);
  source.openai.models["openai-runtime-1"].limit.context = 200000;
  await catalog.refreshIfDue(true);
  assert.notEqual(catalog.snapshot().manifest.version, version);
  const imported = await send("/providers/import-models", { ...input, capabilities: ["chat"], models: [{ id: "openai-runtime-1", catalogVersion: version }] });
  assert.equal(imported.providers[0].contextWindow, 100000);
  assert.deepEqual(imported.providers[0].capabilities, discovered.models[0].capabilities);
  const legacy = await send("/providers/import-models", { ...input, capabilities: ["chat"], models: [{ id: "openai-runtime-1" }] });
  assert.equal(legacy.providers[0].contextWindow, 200000);
  const conflict = await fetch(`${base}/providers/import-models?cwd=${encodeURIComponent(root)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, capabilities: ["chat"], models: [{ id: "openai-runtime-1", catalogVersion: "models.dev:000000000000" }] }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, "model_catalog_changed");
  for (let i = 0; i < 4; i++) {
    source.openai.models["openai-runtime-1"].limit.context += 1;
    await catalog.refreshIfDue(true);
  }
  assert.equal(catalog.snapshotForVersion(version), undefined);
});

test("an older concurrent refresh cannot overwrite a newer daemon's snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-catalog-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "catalog.json");
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  const first = new ProviderModelCatalogService(path, async () => delayed);
  const secondPayload = payload();
  secondPayload.openai.models["openai-runtime-1"].name = "New metadata";
  const second = new ProviderModelCatalogService(path, async () => Response.json(secondPayload));
  await Promise.all([first.initialize(), second.initialize()]);
  const pending = first.refreshIfDue();
  await new Promise(resolve => setTimeout(resolve, 10));
  await second.refreshIfDue();
  release(Response.json(payload()));
  await pending;
  assert.equal(first.snapshot().manifest.version, second.snapshot().manifest.version);
  assert.equal(enrichProviderModelOption({ id: "openai-runtime-1" }, context, first.snapshot()).displayName, "New metadata");
  await Promise.all([first.close(), second.close()]);
});

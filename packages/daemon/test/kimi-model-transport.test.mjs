import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "smol-toml";
import Anthropic from "@anthropic-ai/sdk";
import { redactSecrets } from "@ling-stack/core";
import { prepareKimiExecutionHome } from "../dist/runtime/acp/kimi-execution-home.js";

async function fixture(t, type = "openai") {
  const source = await realpath(await mkdtemp(join(tmpdir(), "ling-kimi-model-test-")));
  const received = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url, headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(type === "anthropic"
      ? 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"real local stream"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
      : 'data: {"text":"real local stream"}\n\n');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const config = { default_model: "default", providers: {
    selected: { type, base_url: `http://127.0.0.1:${server.address().port}/vendor/v1`, api_key: "host-secret-sentinel",
      custom_headers: { "x-vendor-secret": "host-header-sentinel" } },
    unrelated: { type: "openai", api_key: "unrelated-secret-sentinel" },
  }, models: { default: { provider: "selected", model: "default-wire", max_context_size: 32000 },
    chosen: { provider: "selected", model: "chosen-wire", max_context_size: 64000, capabilities: ["thinking"] } } };
  await writeFile(join(source, "config.toml"), stringify(config), { mode: 0o600 });
  await mkdir(join(source, "credentials"));
  await writeFile(join(source, "credentials", "sentinel"), "host-oauth-sentinel", { mode: 0o600 });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(source, { recursive: true, force: true });
  });
  const signal = new AbortController();
  const prepare = async options => {
    const home = await prepareKimiExecutionHome(source, { policy: { toolDecisions: {}, allowedWritePaths: [] } },
      false, signal.signal, options);
    t.after(() => home.dispose());
    const projected = parse(await readFile(join(home.home, "config.toml"), "utf8"));
    return { ...home, projected, provider: Object.values(projected.providers)[0] };
  };
  return { source, received, config, signal, prepare };
}

test("Kimi execution home projects only the selected model and no persistent authentication", async t => {
  const f = await fixture(t), original = await readFile(join(f.source, "config.toml"), "utf8");
  const home = await f.prepare({ modelId: "chosen" });
  assert.deepEqual(Object.keys(home.projected.models), ["chosen"]);
  assert.equal(home.projected.default_model, "chosen");
  assert.deepEqual(home.projected.models.chosen, parse(stringify(f.config.models.chosen)));
  assert.deepEqual(Object.keys(home.projected.providers), ["selected"]);
  assert.equal(home.provider.api_key, "ling-relay");
  assert.equal(home.provider.oauth, undefined);
  assert.equal(home.provider.env, undefined);
  assert.equal(home.provider.base_url, `http://127.0.0.1:${home.modelRelayPort}/v1`);
  assert.match(home.provider.custom_headers["x-ling-model-token"], /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(home.projected).includes("sentinel"), false);
  await assert.rejects(readFile(join(home.home, "credentials", "sentinel")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.source, "config.toml"), "utf8"), original);
});

for (const [type, path, upstreamPath] of [
  ["openai", "/chat/completions", "/vendor/v1/chat/completions"],
  ["kimi", "/chat/completions", "/vendor/v1/chat/completions"],
  ["openai_responses", "/responses", "/vendor/v1/responses"],
  ["anthropic", "/v1/messages", "/vendor/v1/messages"],
]) test(`Kimi ${type} relay forwards a real selected-model request with host-only authentication`, async t => {
  const f = await fixture(t, type), home = await f.prepare();
  const response = await fetch(`${home.provider.base_url}${path}`, { method: "POST",
    headers: { ...home.provider.custom_headers, "content-type": "application/json", authorization: "Bearer child-must-not-forward" },
    body: JSON.stringify({ model: "default-wire", stream: true, messages: [] }) });
  assert.equal(response.status, 200); assert.match(await response.text(), /real local stream/);
  assert.equal(f.received.length, 1); const sent = f.received[0];
  assert.equal(sent.path, upstreamPath); assert.equal(sent.body.model, "default-wire");
  assert.equal(sent.headers["x-vendor-secret"], "host-header-sentinel");
  assert.equal(sent.headers["x-ling-model-token"], undefined);
  if (type === "anthropic") {
    assert.equal(sent.headers["x-api-key"], "host-secret-sentinel");
    assert.equal(sent.headers["anthropic-version"], "2023-06-01");
  } else assert.equal(sent.headers.authorization, "Bearer host-secret-sentinel");
  const rejected = await fetch(`${home.provider.base_url}${path}`, { method: "POST",
    headers: { ...home.provider.custom_headers, "content-type": "application/json" }, body: '{"model":"other-model"}' });
  assert.equal(rejected.status, 400); await rejected.text(); assert.equal(f.received.length, 1);
  await home.dispose();
  await assert.rejects(fetch(`${home.provider.base_url}${path}`, { signal: AbortSignal.timeout(1500) }));
});

test("Kimi relay rejects changed source identity and checks the current owner before forwarding", async t => {
  const f = await fixture(t); let current = true, checks = 0;
  const home = await f.prepare({ assertCurrent: () => { checks++; if (!current) throw Error("owner changed"); } });
  const send = () => fetch(`${home.provider.base_url}/chat/completions`, { method: "POST",
    headers: { ...home.provider.custom_headers, "content-type": "application/json" }, body: '{"model":"default-wire"}' });
  current = false;
  let response = await send(); assert.equal(response.status, 502); await response.text();
  assert.ok(checks > 0); assert.equal(f.received.length, 0);
  current = true;
  await writeFile(join(f.source, "config.toml"), `${stringify(f.config)}\n# replaced\n`);
  response = await send(); assert.equal(response.status, 502); await response.text();
  assert.equal(f.received.length, 0);
});

test("Kimi redacts model credentials without altering public Anthropic version text", async t => {
  const f = await fixture(t, "anthropic"), home = await f.prepare();
  const result = redactSecrets("Version 2023-06-01 key host-secret-sentinel header host-header-sentinel", home.modelSecrets);
  assert.equal(result, "Version 2023-06-01 key [REDACTED] header [REDACTED]");
});

for (const beta of [false, true]) test(`Kimi Anthropic relay accepts the actual SDK ${beta ? "beta" : "standard"} path`, async t => {
  const f = await fixture(t, "anthropic"), home = await f.prepare();
  const client = new Anthropic({ apiKey: "ling-relay", baseURL: home.provider.base_url,
    defaultHeaders: home.provider.custom_headers, maxRetries: 0 });
  const request = { model: "default-wire", max_tokens: 1, messages: [{ role: "user", content: "Synthetic local test" }], stream: true };
  const stream = await (beta ? client.beta.messages.create(request) : client.messages.create(request));
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.find(event => event.type === "content_block_delta")?.delta.text, "real local stream");
  assert.equal(events.at(-1)?.type, "message_stop");
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].path, `/vendor/v1/messages${beta ? "?beta=true" : ""}`);
  assert.equal(f.received[0].headers["x-api-key"], "host-secret-sentinel");
});

for (const suffix of ["", "/v1", "/v1/"]) test(`Kimi Anthropic native base normalization preserves the route prefix: ${suffix || "bare"}`, async t => {
  const f = await fixture(t, "anthropic");
  f.config.providers.selected.base_url = f.config.providers.selected.base_url.replace(/\/vendor\/v1$/, `/coding${suffix}`);
  await writeFile(join(f.source, "config.toml"), stringify(f.config));
  const home = await f.prepare();
  const client = new Anthropic({ apiKey: "ling-relay", baseURL: home.provider.base_url,
    defaultHeaders: home.provider.custom_headers, maxRetries: 0 });
  const stream = await client.messages.create({ model: "default-wire", max_tokens: 1,
    messages: [{ role: "user", content: "Synthetic normalized endpoint" }], stream: true });
  for await (const event of stream) assert.ok(event.type);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].path, "/coding/v1/messages");
});

for (const beta of [false, true]) test(`Kimi Anthropic ${beta ? "beta" : "standard"} request preserves SDK feature headers`, async t => {
  const f = await fixture(t, "anthropic"), home = await f.prepare();
  const client = new Anthropic({ apiKey: "ling-relay", baseURL: home.provider.base_url,
    defaultHeaders: home.provider.custom_headers, maxRetries: 0 });
  const feature = "interleaved-thinking-2025-05-14";
  const request = { model: "default-wire", max_tokens: 1, messages: [{ role: "user", content: "Synthetic local test" }], stream: true };
  const stream = await (beta ? client.beta.messages.create({ ...request, betas: [feature] })
    : client.messages.create(request, { headers: { "anthropic-beta": feature } }));
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.find(event => event.type === "content_block_delta")?.delta.text, "real local stream");
  assert.equal(f.received[0].headers["anthropic-beta"], feature);
  assert.equal(f.received[0].headers["x-ling-model-token"], undefined);
});

for (const kind of ["missing-model", "oauth", "ambient-key", "unsupported-protocol"]) {
  test(`Kimi ${kind} fails before launching instead of copying native credentials`, async t => {
    const f = await fixture(t);
    if (kind === "oauth") { delete f.config.providers.selected.api_key; f.config.providers.selected.oauth = { storage: "file", key: "sentinel" }; }
    if (kind === "ambient-key") { delete f.config.providers.selected.api_key; f.config.providers.selected.env = { OPENAI_API_KEY: "ambient-sentinel" }; }
    if (kind === "unsupported-protocol") f.config.providers.selected.type = "google-genai";
    await writeFile(join(f.source, "config.toml"), stringify(f.config));
    await assert.rejects(f.prepare({ modelId: kind === "missing-model" ? "missing" : undefined }), /kimi_.*(invalid|unsupported)/);
    assert.equal(f.received.length, 0);
  });
}

for (const protocol of ["anthropic", "openai_responses"]) {
  test(`Kimi managed model ${protocol} takes precedence over the provider protocol`, async t => {
    const f = await fixture(t, protocol === "anthropic" ? "anthropic" : "openai_responses");
    f.config.providers.selected.type = "kimi";
    f.config.providers.selected.default_model = "other-provider-default";
    f.config.providers.selected.source = { type: "managed", source_id: "kimi-code" };
    Object.assign(f.config.models.default, { protocol, beta_api: protocol === "anthropic",
      base_url: f.config.providers.selected.base_url.replace("/vendor/v1", "/model-endpoint/v1"),
      max_input_size: 64000, default_effort: "high",
      overrides: { max_context_size: 16000, max_output_size: 512, support_efforts: ["low"] } });
    f.config.services = { moonshot_search: { base_url: "https://unused.invalid/search", api_key: "service-key-sentinel" },
      moonshot_fetch: { base_url: "https://unused.invalid/fetch", api_key: "", oauth: { storage: "file", key: "oauth/kimi-code" } } };
    await writeFile(join(f.source, "config.toml"), stringify(f.config));
    const original = await readFile(join(f.source, "config.toml"), "utf8");
    const home = await f.prepare();
    const model = home.projected.models.default;
    assert.equal(home.provider.type, "kimi", "keep native provider traits while choosing the wire protocol");
    assert.equal(model.protocol, protocol);
    assert.equal(model.beta_api, protocol === "anthropic");
    assert.equal(model.max_context_size, 16000);
    assert.equal(model.max_input_size, 16000);
    assert.equal(model.max_output_size, 512);
    assert.equal(model.default_effort, undefined);
    assert.equal(model.overrides, undefined);
    assert.equal(model.base_url, home.provider.base_url, "model endpoint cannot bypass the relay");
    assert.equal(home.projected.services, undefined);
    assert.equal(home.provider.source, undefined);
    assert.equal(home.provider.default_model, undefined);
    assert.equal(JSON.stringify(home.projected).includes("sentinel"), false);
    if (protocol === "anthropic") {
      const client = new Anthropic({ apiKey: "ling-relay", baseURL: model.base_url, defaultHeaders: home.provider.custom_headers, maxRetries: 0 });
      const stream = await client.beta.messages.create({ model: "default-wire", max_tokens: 1,
        messages: [{ role: "user", content: "Synthetic managed model" }], stream: true });
      const events = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.at(-1)?.type, "message_stop");
    } else {
      const result = await fetch(`${model.base_url}/responses`, { method: "POST", headers: { ...home.provider.custom_headers,
        "content-type": "application/json" }, body: JSON.stringify({ model: "default-wire", input: "Synthetic managed model", stream: true }) });
      assert.equal(result.status, 200); await result.text();
    }
    assert.equal(f.received.length, 1);
    assert.equal(f.received[0].path, protocol === "anthropic" ? "/model-endpoint/v1/messages?beta=true" : "/model-endpoint/v1/responses");
    assert.equal(f.received[0].headers[protocol === "anthropic" ? "x-api-key" : "authorization"],
      protocol === "anthropic" ? "host-secret-sentinel" : "Bearer host-secret-sentinel");
    assert.equal(await readFile(join(f.source, "config.toml"), "utf8"), original);
    assert.deepEqual(home.enabledTools, ["Bash", "Read"]);
  });
}

for (const overrides of [{ provider: "unrelated" }, { model: "other" }, { protocol: "anthropic" },
  { beta_api: true }, { base_url: "https://other.invalid" }, { api_key: "forged-key" }, { oauth: { key: "other" } },
  { max_context_size: 0 }, { support_efforts: "high" }, { unknown: true }]) {
  test(`Kimi rejects a model override outside the official schema: ${Object.keys(overrides)[0]}`, async t => {
    const f = await fixture(t);
    f.config.models.default.overrides = overrides;
    await writeFile(join(f.source, "config.toml"), stringify(f.config));
    await assert.rejects(f.prepare(), /kimi_execution_configuration_invalid/);
    assert.equal(f.received.length, 0);
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, defaultProviderTemplates } from "../dist/index.js";

test("default provider templates include Seedream live HTTP base URL without enabling live mode", () => {
  const seedream = defaultProviderTemplates().find((template) => template.templateId === "seedream-image");

  assert.ok(seedream);
  assert.equal(seedream.kind, "seedream");
  assert.equal(seedream.api, "media-job");
  assert.equal(seedream.baseUrl, "https://ark.ap-southeast.bytepluses.com/api/v3");
  assert.equal(seedream.apiKeyRef, "env:SEEDREAM_API_KEY");
  assert.deepEqual(seedream.capabilities, ["image_generate", "image_edit"]);
  assert.equal(seedream.compat, undefined);
  assert.equal(seedream.enabled, false);
});

test("sqlite store persists provider check results", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-provider-"));
  const checkedAt = "2026-05-21T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  let providerId = "";
  try {
    const provider = store.createProviderPreset(
      {
        kind: "openai-compatible",
        displayName: "Local Relay",
        providerId: "local-relay",
        model: "dpv4",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKeyRef: "env:LOCAL_RELAY_API_KEY",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      },
      "2026-05-21T00:00:00.000Z",
    );
    providerId = provider.id;

    const updated = store.recordProviderCheckResult(providerId, {
      ok: false,
      code: "secret_missing",
      message: "Secret is not configured: env:LOCAL_RELAY_API_KEY",
      checkedAt,
    });

    assert.equal(updated?.lastCheck?.ok, false);
    assert.equal(updated?.lastCheck?.code, "secret_missing");

    const edited = store.updateProviderPreset(providerId, { model: "dpv4-next" }, "2026-05-21T00:01:00.000Z");
    assert.equal(edited?.model, "dpv4-next");
    assert.equal(edited?.lastCheck, undefined);

    store.recordProviderCheckResult(providerId, {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt,
    });
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const persisted = store.getProviderPreset(providerId);

    assert.equal(persisted?.lastCheck?.ok, true);
    assert.equal(persisted?.lastCheck?.code, "ready");
    assert.equal(persisted?.lastCheck?.checkedAt, checkedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

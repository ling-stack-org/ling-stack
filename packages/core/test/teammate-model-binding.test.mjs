import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createBuiltinAiTeammateId,
  createSqliteRunStore,
  initialAiTeammateModelBinding,
  resolveEffectiveTeammateProviderPresetId,
} from "../dist/index.js";

test("effective teammate model resolution keeps inherited and fixed ownership distinct", () => {
  const builtin = { id: "teammate_builtin_engineer", modelBindingMode: "workspace_default" };
  assert.equal(resolveEffectiveTeammateProviderPresetId({
    teammate: builtin,
    surface: "private",
    workspaceDefaultProviderPresetId: "provider_workspace",
    channelDefaultProviderPresetId: "provider_channel",
  }), "provider_workspace");
  assert.equal(resolveEffectiveTeammateProviderPresetId({
    teammate: builtin,
    surface: "channel",
    requestedProviderPresetId: "provider_request_override",
    workspaceDefaultProviderPresetId: "provider_workspace",
    channelDefaultProviderPresetId: "provider_channel",
  }), "provider_workspace");

  const lingAgent = { id: "ling_agent", modelBindingMode: "workspace_default" };
  assert.equal(resolveEffectiveTeammateProviderPresetId({
    teammate: lingAgent,
    surface: "private",
    workspaceDefaultProviderPresetId: "provider_workspace",
    channelDefaultProviderPresetId: "provider_channel",
  }), "provider_workspace");
  assert.equal(resolveEffectiveTeammateProviderPresetId({
    teammate: lingAgent,
    surface: "channel",
    requestedProviderPresetId: "provider_request_override",
    workspaceDefaultProviderPresetId: "provider_workspace",
    channelDefaultProviderPresetId: "provider_channel",
  }), "provider_channel");

  const fixed = { id: "teammate_custom", modelBindingMode: "fixed", providerPresetId: "provider_fixed" };
  assert.equal(resolveEffectiveTeammateProviderPresetId({
    teammate: fixed,
    surface: "private",
    workspaceDefaultProviderPresetId: "provider_workspace",
  }), "provider_fixed");
  assert.equal(resolveEffectiveTeammateProviderPresetId({
    teammate: fixed,
    surface: "channel",
    requestedProviderPresetId: "provider_request_override",
    channelDefaultProviderPresetId: "provider_channel",
  }), "provider_fixed");
  assert.equal(resolveEffectiveTeammateProviderPresetId({
    teammate: fixed,
    surface: "private",
    requestedProviderPresetId: "provider_request_override",
  }), "provider_request_override");
});

test("user-created teammates cannot opt into workspace default binding", () => {
  assert.throws(
    () => initialAiTeammateModelBinding("teammate_custom", "workspace_default", undefined),
    /cannot use the workspace default model binding/,
  );
  assert.deepEqual(
    initialAiTeammateModelBinding("teammate_custom", "fixed", "provider_fixed"),
    { modelBindingMode: "fixed", providerPresetId: "provider_fixed" },
  );
});

test("teammate model binding migration repairs inherited built-ins and remains idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-teammate-model-binding-"));
  const databasePath = resolve(cwd, ".ling-stack", "ling-stack.sqlite");
  const engineerId = createBuiltinAiTeammateId("engineer");
  const designerId = createBuiltinAiTeammateId("designer");
  let store = createSqliteRunStore(cwd);
  try {
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("UPDATE ai_teammates SET model_binding_mode = 'fixed', provider_preset_id = 'provider_legacy' WHERE id = 'ling_agent'").run();
      database.prepare("UPDATE ai_teammates SET model_binding_mode = 'fixed', provider_preset_id = NULL WHERE id = ?").run(engineerId);
      database.prepare("UPDATE ai_teammates SET model_binding_mode = 'fixed', provider_preset_id = 'provider_designer' WHERE id = ?").run(designerId);
      database.prepare("DELETE FROM schema_migrations WHERE version = 107").run();
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    assert.deepEqual(
      pickBinding(store.getAiTeammate("ling_agent")),
      { modelBindingMode: "workspace_default", providerPresetId: undefined },
    );
    assert.deepEqual(
      pickBinding(store.getAiTeammate(engineerId)),
      { modelBindingMode: "workspace_default", providerPresetId: undefined },
    );
    assert.deepEqual(
      pickBinding(store.getAiTeammate(designerId)),
      { modelBindingMode: "fixed", providerPresetId: "provider_designer" },
    );
    store.close();

    store = createSqliteRunStore(cwd);
    assert.equal(store.getAiTeammate(engineerId).modelBindingMode, "workspace_default");
    assert.equal(store.getAiTeammate(designerId).providerPresetId, "provider_designer");
  } finally {
    try {
      store.close();
    } catch {
      // The store may already be closed by the idempotency check.
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

function pickBinding(teammate) {
  return {
    modelBindingMode: teammate.modelBindingMode,
    providerPresetId: teammate.providerPresetId,
  };
}

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
  resolveEffectiveTeammateProvider,
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

test("typed effective teammate model resolution preserves owner and repair target", () => {
  const builtIn = { id: "teammate_builtin_qa", modelBindingMode: "workspace_default" };
  assert.deepEqual(resolveEffectiveTeammateProvider({
    teammate: builtIn,
    surface: "channel",
    workspaceDefaultProviderPresetId: "provider_workspace",
    channelDefaultProviderPresetId: "provider_channel",
  }), {
    kind: "resolved",
    binding: {
      schemaVersion: 1,
      participantId: builtIn.id,
      bindingMode: "workspace_default",
      source: "workspace_default",
      providerPresetId: "provider_workspace",
    },
  });
  assert.deepEqual(resolveEffectiveTeammateProvider({
    teammate: builtIn,
    surface: "channel",
    channelDefaultProviderPresetId: "provider_channel",
  }), {
    kind: "blocked",
    reasonCode: "workspace_default_provider_missing",
    participantId: builtIn.id,
    bindingMode: "workspace_default",
    source: "workspace_default",
    owner: "workspace",
    repairTarget: "model_workbench",
  });

  const lingAgent = { id: "ling_agent", modelBindingMode: "workspace_default" };
  assert.deepEqual(resolveEffectiveTeammateProvider({
    teammate: lingAgent,
    surface: "channel",
    workspaceDefaultProviderPresetId: "provider_workspace",
    channelDefaultProviderPresetId: "provider_channel",
  }).binding, {
    schemaVersion: 1,
    participantId: "ling_agent",
    bindingMode: "workspace_default",
    source: "channel_ling_agent_model",
    providerPresetId: "provider_channel",
  });

  const fixed = { id: "teammate_custom", modelBindingMode: "fixed" };
  assert.deepEqual(resolveEffectiveTeammateProvider({ teammate: fixed, surface: "channel" }), {
    kind: "blocked",
    reasonCode: "fixed_provider_missing",
    participantId: fixed.id,
    bindingMode: "fixed",
    source: "teammate_fixed",
    owner: "teammate",
    repairTarget: "teammate_settings",
  });
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

test("teammate model binding migration repairs a local version 107 collision", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-teammate-model-binding-collision-"));
  const databasePath = resolve(cwd, ".ling-stack", "ling-stack.sqlite");
  let store = createSqliteRunStore(cwd);
  try {
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("ALTER TABLE ai_teammates DROP COLUMN model_binding_mode;");
      database.prepare("UPDATE schema_migrations SET name = 'create_remote_conversation_state' WHERE version = 107").run();
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    assert.equal(store.getAiTeammate("ling_agent").modelBindingMode, "workspace_default");
    const migrated = new DatabaseSync(databasePath);
    try {
      assert.ok(migrated.prepare("SELECT name FROM pragma_table_info('ai_teammates') WHERE name = 'model_binding_mode'").get());
      assert.ok(migrated.prepare(
        "SELECT version FROM schema_migrations WHERE version = 108 AND name = 'create_remote_conversation_state'",
      ).get());
    } finally {
      migrated.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // The store may already be closed after a failed migration assertion.
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

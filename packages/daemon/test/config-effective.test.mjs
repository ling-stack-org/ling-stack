import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";
import { SUPPORTED_LOCALES } from "../../localization/dist/index.js";
import { parseWorkspaceSettingsUpdate } from "../dist/features/settings/effective-config.js";

test("workspace settings schema accepts exactly the shared locale registry", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const parsed = parseWorkspaceSettingsUpdate({ locale, responseLanguage: locale });
    assert.equal(parsed.locale, locale);
    assert.equal(parsed.responseLanguage, locale);
  }
  assert.throws(
    () => parseWorkspaceSettingsUpdate({ locale: "xx-YY" }),
    /locale must be a supported locale/u,
  );
  assert.throws(
    () => parseWorkspaceSettingsUpdate({ responseLanguage: "xx-YY" }),
    /responseLanguage must be follow_user, a supported locale, or null/u,
  );
  for (const mode of ["auto", "concise", "detailed", "none", null]) {
    assert.equal(parseWorkspaceSettingsUpdate({ defaultReasoningSummary: mode }).defaultReasoningSummary, mode);
  }
  assert.throws(
    () => parseWorkspaceSettingsUpdate({ defaultReasoningSummary: "raw" }),
    /defaultReasoningSummary must be auto, concise, detailed, none, or null/u,
  );
});

test("effective config reports user defaults and workspace execution sources", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-effective-config-workspace-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-effective-config-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = await startDaemonForTest(cwd);
  try {
    await mkdir(resolve(userRoot, "providers"), { recursive: true });
    await writeFile(resolve(userRoot, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      theme: "dark",
      locale: "zh-CN",
      responseLanguage: "en-US",
      lingConversationTone: "friendly",
      defaultReasoningSummary: "concise",
    }), "utf8");
    await writeFile(resolve(userRoot, "config.json"), JSON.stringify({
      schemaVersion: 1,
      product: "ling-stack",
      runtimeDefaults: {
        defaultRunnerId: "pi",
        implicitRunnerFallback: "disabled",
      },
    }), "utf8");
    await writeFile(resolve(userRoot, "providers", "profiles.json"), JSON.stringify({
      schemaVersion: 1,
      profiles: [],
    }), "utf8");

    const initial = await getJson(`${daemon.url}/config/effective?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.cwd, cwd);
    assert.equal(initial.paths.user.rootDir, userRoot);
    assert.equal(initial.paths.workspace.rootDir, resolve(cwd, ".ling-stack"));
    assert.equal(initial.values.theme.value, "dark");
    assert.equal(initial.values.theme.source, "user");
    assert.equal(initial.values.locale.value, "zh-CN");
    assert.equal(initial.values.responseLanguage.value, "en-US");
    assert.equal(initial.values.lingConversationTone.value, "friendly");
    assert.equal(initial.values.lingConversationTone.source, "user");
    assert.equal(initial.values.lingConversationTone.path, resolve(userRoot, "settings.json"));
    assert.equal(initial.values.reasoningSummary.value, "concise");
    assert.equal(initial.values.reasoningSummary.source, "user");
    assert.equal(initial.values.skillGovernancePolicy.value.generationMode, "semi_auto");
    assert.equal(initial.values.skillGovernancePolicy.source, "workspace");
    assert.equal(initial.values.runtime.defaultRunnerId.value, "pi");
    assert.equal(initial.values.runtime.defaultRunnerId.source, "user");
    assert.equal(initial.values.runtime.defaultRunnerId.path, resolve(userRoot, "config.json"));
    assert.equal(initial.values.runtime.explicitRunnerFallback.value, "disabled");
    assert.equal(initial.values.runtime.explicitRunnerFallback.source, "built_in");
    assert.equal(initial.values.runtime.implicitRunnerFallback.value, "disabled");
    assert.equal(initial.values.runtime.implicitRunnerFallback.source, "user");
    assert.equal(initial.layers.userConfig.runtimeDefaults.defaultRunnerId, "pi");
    assert.deepEqual(initial.diagnostics, []);

    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      theme: "light",
      locale: "en-US",
      lingConversationTone: "pragmatic",
      defaultReasoningSummary: "detailed",
      skillGovernancePolicy: {
        generationMode: "approval_only",
        recordingMode: "user_initiated",
        invocationMode: "explicit_only",
        publishMode: "manual_review",
        bindMode: "manual_review",
      },
    });
    await patchJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      defaultRunnerId: "pi",
      allowedRunnerIds: ["pi"],
      explicitRunnerFallback: "allow_to_default",
    });

    const patched = await getJson(`${daemon.url}/config/effective?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(patched.values.theme.value, "light");
    assert.equal(patched.values.theme.source, "workspace");
    assert.equal(patched.values.theme.path, resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    assert.equal(patched.values.lingConversationTone.value, "pragmatic");
    assert.equal(patched.values.lingConversationTone.source, "workspace");
    assert.equal(patched.values.lingConversationTone.path, resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    assert.equal(patched.values.reasoningSummary.value, "detailed");
    assert.equal(patched.values.reasoningSummary.source, "workspace");
    assert.equal(patched.values.skillGovernancePolicy.value.generationMode, "approval_only");
    assert.equal(patched.values.skillGovernancePolicy.source, "workspace");
    assert.equal(patched.values.runtime.defaultRunnerId.source, "workspace");
    assert.equal(patched.values.runtime.defaultRunnerId.path, resolve(cwd, ".ling-stack", "runtime-settings.json"));
    assert.equal(patched.values.runtime.explicitRunnerFallback.value, "allow_to_default");
    assert.equal(patched.values.runtime.explicitRunnerFallback.source, "workspace");
    assert.equal(patched.values.runtime.implicitRunnerFallback.value, "disabled");
    assert.equal(patched.values.runtime.implicitRunnerFallback.source, "workspace");
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("desktop runtime env enables unified exec without overriding an explicit daemon setting", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-effective-config-runtime-"));
  const previousUnifiedExec = process.env.LING_STACK_RUNTIME_UNIFIED_EXEC;
  let enabled;
  let explicitlyDisabled;
  t.after(async () => {
    try {
      await Promise.all([enabled?.stop(), explicitlyDisabled?.stop()]);
    } finally {
      if (previousUnifiedExec === undefined) {
        delete process.env.LING_STACK_RUNTIME_UNIFIED_EXEC;
      } else {
        process.env.LING_STACK_RUNTIME_UNIFIED_EXEC = previousUnifiedExec;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
  process.env.LING_STACK_RUNTIME_UNIFIED_EXEC = "1";
  enabled = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: resolve(cwd, "enabled"),
    runtimeTools: {},
  });
  explicitlyDisabled = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: resolve(cwd, "disabled"),
    runtimeTools: { unifiedExec: false },
  });
  assert.equal(enabled.config.runtimeTools.unifiedExec, true);
  assert.equal(explicitlyDisabled.config.runtimeTools.unifiedExec, false);
});

test("effective config reports user settings diagnostics without applying invalid values", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-effective-config-invalid-workspace-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-effective-config-invalid-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = await startDaemonForTest(cwd);
  try {
    await writeFile(resolve(userRoot, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      theme: "sepia",
      locale: "",
      responseLanguage: "xx-YY",
      lingConversationTone: "verbose",
    }), "utf8");
    await writeFile(resolve(userRoot, "config.json"), JSON.stringify({
      schemaVersion: 1,
      runtimeDefaults: {
        defaultRunnerId: "codex-app-server",
        implicitRunnerFallback: "sometimes",
      },
    }), "utf8");

    const body = await getJson(`${daemon.url}/config/effective?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(body.values.theme.value, "system");
    assert.equal(body.values.theme.source, "built_in");
    assert.equal(body.values.locale.value, "zh-CN");
    assert.equal(body.values.locale.source, "built_in");
    assert.equal(body.values.responseLanguage.value, "follow_user");
    assert.equal(body.values.responseLanguage.source, "built_in");
    assert.equal(body.values.lingConversationTone.value, "pragmatic");
    assert.equal(body.values.lingConversationTone.source, "built_in");
    assert.equal(body.values.runtime.defaultRunnerId.value, "pi");
    assert.equal(body.values.runtime.defaultRunnerId.source, "built_in");
    assert.equal(body.values.runtime.implicitRunnerFallback.value, "allow_to_default");
    assert.equal(body.values.runtime.implicitRunnerFallback.source, "built_in");
    assert.deepEqual(body.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
      "user_runtime_defaults_invalid_fallback_policy",
      "user_runtime_defaults_unavailable_runner",
      "user_settings_invalid_ling_conversation_tone",
      "user_settings_invalid_locale",
      "user_settings_invalid_response_language",
      "user_settings_invalid_theme",
    ]);
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

async function startDaemonForTest(cwd) {
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    channels: { autoRoute: false, intentSelector: false },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveConfig } from "../dist/config.js";
import { assertBundledCuaDriverRuntimeAvailable } from "../dist/features/plugins/routes.js";
import { buildCuaDriverSetupView } from "../dist/features/plugins/cua-driver.js";
import { CUA_DRIVER_MCP_SERVER_ID, CUA_DRIVER_PLUGIN_ID } from "../dist/features/plugins/presets.js";
import { BUNDLED_CUA_DRIVER_PLUGIN_ID } from "../dist/features/plugins/bundled-index.js";

test("Cua Driver feature config defaults off and explicit config wins over env", () => {
  const keys = [
    "LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_DARWIN",
    "LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_WIN32",
    "LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_DARWIN",
    "LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_WIN32",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "1";
    const fromEnv = resolveConfig({});
    assert.deepEqual(fromEnv.cuaDriver, {
      bundledEmbedded: { darwin: true, win32: true },
      packagedProvider: { darwin: true, win32: true },
    });

    const explicit = resolveConfig({
      cuaDriver: {
        bundledEmbedded: { darwin: false },
        packagedProvider: { darwin: false },
      },
    });
    assert.deepEqual(explicit.cuaDriver, {
      bundledEmbedded: { darwin: false, win32: true },
      packagedProvider: { darwin: false, win32: true },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
test("gate-off Cua Driver setup projection is byte-for-byte the legacy external shape", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-cua-contracts-legacy-"));
  const command = join(root, "cua-driver");
  const originalPath = process.env.PATH;
  try {
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    process.env.PATH = root;
    const store = {
      getMcpServer: () => undefined,
      getManagedPlugin: () => undefined,
      listManagedPluginContributions: () => [],
    };
    assert.deepEqual(
      buildCuaDriverSetupView({ store, now: "2026-07-18T00:00:00.000Z", platform: "darwin" }),
      {
        kind: "local_binary",
        state: "detected",
        checkedAt: "2026-07-18T00:00:00.000Z",
        detectedCommand: command,
      },
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled V2 setup projection never probes PATH and maps included to connected", () => {
  let probed = false;
  const store = {
    getMcpServer: () => {
      probed = true;
      throw new Error("external resolver must not be called");
    },
    getManagedPlugin: () => {
      probed = true;
      throw new Error("external resolver must not be called");
    },
    listManagedPluginContributions: () => {
      probed = true;
      throw new Error("external resolver must not be called");
    },
  };
  const setup = buildCuaDriverSetupView({
    store,
    now: "2026-07-18T00:00:00.000Z",
    platform: "darwin",
    projection: {
      schemaVersion: 2,
      distribution: "bundled_embedded",
      providerState: "included",
    },
  });
  assert.equal(probed, false);
  assert.equal(setup.schemaVersion, 2);
  assert.equal(setup.distribution, "bundled_embedded");
  assert.equal(setup.providerState, "included");
  assert.equal(setup.state, "connected");
  assert.equal(setup.effectiveEnabled, false);
});

test("effective packaged gate honors the explicit platform before external connect/broker work", () => {
  const config = resolveConfig({
    cuaDriver: {
      bundledEmbedded: { darwin: true, win32: false },
      packagedProvider: { darwin: true, win32: false },
    },
  });
  assert.throws(
    () => assertBundledCuaDriverRuntimeAvailable(config, "darwin"),
    (error) => error?.code === "cua_desktop_lease_unavailable" && error?.statusCode === 409,
  );
  assert.doesNotThrow(() => assertBundledCuaDriverRuntimeAvailable(config, "win32"));
});

test("canonical external and hidden bundled IDs remain distinct and stable", () => {
  assert.equal(CUA_DRIVER_PLUGIN_ID, "trusted-local:cua-driver");
  assert.equal(CUA_DRIVER_MCP_SERVER_ID, "mcp_cua_driver");
  assert.equal(BUNDLED_CUA_DRIVER_PLUGIN_ID, "bundled:cua-driver");
  assert.notEqual(CUA_DRIVER_PLUGIN_ID, BUNDLED_CUA_DRIVER_PLUGIN_ID);
});

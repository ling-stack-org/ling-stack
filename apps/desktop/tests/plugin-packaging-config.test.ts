import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { withCuaDriverBuilderEnvironment } from "../scripts/cua-driver-builder-environment.mjs";

type Resource = { readonly to?: string };
type BuilderConfig = {
  readonly extraResources: readonly Resource[];
  readonly files: readonly { readonly filter: readonly string[] }[];
  readonly extraMetadata: { readonly lingPluginResourceMode: string };
  readonly mac: { readonly extraResources: readonly Resource[] };
};

const desktop = fileURLToPath(new URL("../", import.meta.url));
const desktopRequire = createRequire(new URL("../package.json", import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
const { getConfig } = builderRequire("app-builder-lib/out/util/config/config.js") as {
  getConfig(projectDir: string, configPath: null, config: BuilderConfig): Promise<BuilderConfig>;
};

test("the macOS Builder merge excludes compatibility plugin resources in on-demand mode", async () => {
  for (const [setting, mode] of [["0", "bundled"], ["1", "on-demand"]]) {
    await withCuaDriverBuilderEnvironment({
      LING_PLUGIN_EXTERNAL_ONLY: setting,
      LING_CUA_DRIVER_CATALOG_MANAGED: "0",
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "0",
      LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: undefined,
      LING_CUA_PACKAGE_RESOURCES_ROOT: undefined,
      LING_CUA_SIGNING_TIER: "unsigned_dev",
      LING_CUA_DISTRIBUTION_CHANNEL: "development",
    }, async () => {
      const url = new URL("../scripts/cua-driver-electron-builder.config.mjs", import.meta.url);
      url.searchParams.set("pluginResourceMode", mode);
      const { default: config } = await import(url.href) as { default: BuilderConfig };
      const effective = await getConfig(desktop, null, config);
      const roots = effective.extraResources.map(resource => resource.to?.split("/")[0]);
      for (const root of ["office-driver", "browser-host", "browser-extension", "bundled"]) {
        assert.equal(roots.includes(root), mode === "bundled", root);
      }
      assert.equal(effective.extraMetadata.lingPluginResourceMode, mode);
      assert.ok(roots.includes("web"));
      assert.ok(effective.mac.extraResources.some(resource => resource.to === "office-local"));
      assert.equal(effective.files.some(entry => entry.filter.includes("!dist/office-driver{,/**/*}")), mode === "on-demand");
    });
  }
});

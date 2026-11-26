import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { collectMaterials, sha256, verifyMaterials } from "../../apps/desktop/scripts/distribution/materials.mjs";

function fixtureRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "ling-desktop-plugin-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, path: string, contents: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

test("on-demand Desktop preparation does not require the compatibility plugin source trees", t => {
  const root = fixtureRoot(t);
  const builders = [
    ["apps/desktop/scripts/build-office-driver.mjs", "--platform=win32-x64"],
    ["packages/browser-host/scripts/build-native.mjs"],
    ["apps/chrome-extension/scripts/build.mjs"],
  ];
  const env = { ...process.env, LING_PLUGIN_EXTERNAL_ONLY: "1", LING_CHROME_STORE_BOOTSTRAP: "0" };
  for (const [builder, ...args] of builders) {
    const script = join(root, builder);
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(new URL(`../../${builder}`, import.meta.url), script);
    execFileSync(process.execPath, [script, ...args], { cwd: root, env, stdio: "pipe", timeout: 15_000 });
  }
  for (const path of ["apps/desktop/dist", "packages/browser-host/dist", "apps/chrome-extension/dist",
    "apps/chrome-extension/ling-for-chrome.zip"]) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
});

test("Desktop distribution materials follow the package's plugin mode", t => {
  const root = fixtureRoot(t);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git(["init", "--quiet"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", "Distribution fixture"]);
  const sourceSha = git(["rev-parse", "HEAD"]);
  write(root, "pnpm-lock.yaml", "packages:\n  '@fontsource-variable/inter@1.0.0':\n    resolution: {}\n  fixture-extension-only@1.0.0:\n    resolution: {}\nsnapshots:\n");
  for (const path of ["LICENSE", "THIRD_PARTY_NOTICES.md", "docs/maintenance/asset-provenance.md"]) {
    write(root, path, "Distribution fixture material\n");
  }
  for (const [directory, name] of [["apps/desktop", "desktop"], ["apps/web", "web"], ["packages/daemon", "daemon"]]) {
    write(root, `${directory}/package.json`, JSON.stringify({ name: `@ling-stack/${name}` }));
  }
  write(root, "apps/chrome-extension/package.json", JSON.stringify({
    name: "@ling-stack/chrome-extension", dependencies: { "fixture-extension-only": "1.0.0" },
  }));
  for (const name of ["@fontsource-variable/inter", "fixture-extension-only"]) {
    write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
    write(root, `node_modules/${name}/LICENSE`, "Exact fixture notice\n");
  }
  const office = "apps/desktop/scripts/native/office-driver";
  const host = "packages/browser-host/native";
  const officeAddon = "native/office-local";
  const engineSupervisor = "packages/daemon/native/engine-supervisor";
  for (const directory of [office, host, officeAddon, engineSupervisor,
    "packages/daemon/src/runtime/adapters/codex/protocol", "packages/daemon/native/image-sanitizer", "native/sandbox"]) {
    write(root, `${directory}/source.txt`, "Fixture source\n");
  }
  write(root, "apps/desktop/scripts/cua-driver-electron-package.mjs", "");
  const runtime = "microsoft.netcore.app.runtime.win-x64";
  write(root, `nuget/${runtime}/8.0.34/LICENSE.TXT`, "Exact .NET grant\n");
  write(root, `nuget/${runtime}/8.0.34/THIRD-PARTY-NOTICES.TXT`, "Exact .NET notices\n");
  write(root, `${office}/windows/obj/project.assets.json`, JSON.stringify({
    packageFolders: { [join(root, "nuget")]: {} },
    project: { frameworks: { "net8.0": { downloadDependencies: [{
      name: "Microsoft.NETCore.App.Runtime.win-x64", version: "[8.0.34, 8.0.34]",
    }] } } },
  }));

  for (const platform of ["darwin-arm64", "win32-x64"]) {
    const bundled = collectMaterials({ root, platform, sourceSha });
    const onDemand = collectMaterials({ root, platform, sourceSha, pluginMode: "on-demand" });
    assert.equal(bundled.manifest.pluginMode, "bundled");
    assert.equal(onDemand.manifest.pluginMode, "on-demand");
    for (const path of [office, host]) {
      const source = `sources/repository/${path}/source.txt`;
      assert.ok(bundled.material.has(source), source);
      assert.ok(!onDemand.material.has(source), source);
    }
    const usedSource = platform === "darwin-arm64" ? officeAddon : engineSupervisor;
    assert.ok(onDemand.material.has(`sources/repository/${usedSource}/source.txt`));
    assert.ok(onDemand.manifest.components.some(component => component.name === "@fontsource-variable/inter"));
    assert.ok(bundled.manifest.components.some(component => component.name === "fixture-extension-only"));
    assert.ok(!onDemand.manifest.components.some(component => component.name === "fixture-extension-only"));
    assert.equal([...bundled.material.keys()].some(path => path.startsWith("licenses/dotnet/")), platform === "win32-x64");
    assert.ok(![...onDemand.material.keys()].some(path => path.startsWith("licenses/dotnet/")));
    const bundledSpdx = JSON.parse(bundled.material.get("distribution.spdx.json")!.toString());
    const onDemandSpdx = JSON.parse(onDemand.material.get("distribution.spdx.json")!.toString());
    assert.notEqual(onDemandSpdx.documentNamespace, bundledSpdx.documentNamespace);
  }
});

test("final distribution verification rejects materials prepared for a different plugin mode", t => {
  const resources = fixtureRoot(t);
  const platform = "darwin-arm64";
  const sourceSha = "a".repeat(40);
  for (const pluginMode of [undefined, "bundled", "on-demand"]) {
    const manifest = JSON.stringify({
      schemaVersion: 1, kind: "desktop-distribution-materials", platform, sourceSha, pluginMode,
      status: "collected", gaps: [], files: [],
    });
    write(resources, "distribution/distribution-manifest.json", manifest);
    write(resources, "distribution/SHA256SUMS.txt", `${sha256(manifest)}  distribution-manifest.json\n`);
    const input = { resources, platform, sourceSha, output: undefined, pluginMode };
    assert.equal(verifyMaterials(input).status, "verified");
    assert.throws(() => verifyMaterials({ ...input, pluginMode: pluginMode === "on-demand" ? "bundled" : "on-demand" }),
      /distribution_packaged_plugin_mode_mismatch/u);
  }
});

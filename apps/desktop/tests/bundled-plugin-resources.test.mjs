import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DESKTOP_BUNDLED_PLUGINS_RESOURCE_DIRECTORY,
  resolveBundledPackageRoot,
} from "../../../packages/daemon/dist/features/plugins/bundled-index.js";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const sourceRoot = resolve(repositoryRoot, "packages/daemon/src/features/plugins/bundled");

test("Desktop package copies only the Cua Driver plugin shell metadata", async () => {
  const desktopPackage = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));
  const resource = desktopPackage.build.extraResources.find(
    (candidate) => candidate.to === DESKTOP_BUNDLED_PLUGINS_RESOURCE_DIRECTORY,
  );

  assert.ok(resource, "Desktop must package the daemon bundled-plugin resource directory");
  assert.equal(resource.from, "../../packages/daemon/src/features/plugins/bundled");
  assert.deepEqual(resource.filter, [
    "cua-driver/.ling-plugin/plugin.json",
    "cua-driver/mcp-server.json",
    "cua-driver/README.md",
  ]);

  const sourceFiles = await listFiles(resolve(sourceRoot, "cua-driver"));
  assert.deepEqual(sourceFiles, [
    ".ling-plugin/plugin.json",
    "README.md",
    "mcp-server.json",
  ]);
  assert.equal(sourceFiles.some(looksLikeBinaryOrCredential), false);
});

test("packaged daemon resolves the copied Cua Driver manifest from Electron resources", async () => {
  const resourcesPath = await mkdtemp(resolve(tmpdir(), "ling-desktop-bundled-plugins-"));
  try {
    const packagedRoot = resolve(
      resourcesPath,
      DESKTOP_BUNDLED_PLUGINS_RESOURCE_DIRECTORY,
      "cua-driver",
    );
    await cp(resolve(sourceRoot, "cua-driver"), packagedRoot, { recursive: true });

    const resolvedRoot = resolveBundledPackageRoot("cua-driver", {
      resourcesPath,
      moduleUrl: new URL("file:///virtual/app.asar/dist/daemon/cli.mjs").href,
      cwd: "/virtual/workspace",
    });
    assert.equal(resolvedRoot, packagedRoot);

    const manifest = JSON.parse(
      await readFile(resolve(resolvedRoot, ".ling-plugin/plugin.json"), "utf8"),
    );
    assert.equal(manifest.id, "bundled:cua-driver");
    assert.deepEqual(manifest.platforms, ["darwin", "win32"]);
    assert.match(manifest.description, /already installed Cua Driver/u);
    assert.equal(manifest.healthChecks.some((health) => health.id === "binary" && health.kind === "binary"), true);
    assert.equal(manifest.contributions[0].path, "./mcp-server.json");
    const mcpServer = JSON.parse(await readFile(resolve(resolvedRoot, "mcp-server.json"), "utf8"));
    assert.equal(mcpServer.command, "cua-driver");
    assert.equal(mcpServer.managedBy, "ling-plugin-shell");
  } finally {
    await rm(resourcesPath, { recursive: true, force: true });
  }
});

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else if (entry.isFile()) {
      files.push(relative(resolve(sourceRoot, "cua-driver"), path).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

function looksLikeBinaryOrCredential(path) {
  return /(?:^|\/)(?:\.env|credentials?|secrets?|tokens?)(?:\.|$)|\.(?:app|dylib|dll|exe|key|p12|pem)$/iu.test(path);
}

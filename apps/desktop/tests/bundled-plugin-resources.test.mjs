import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  DESKTOP_BUNDLED_PLUGINS_RESOURCE_DIRECTORY,
  resolveBundledPackageRoot,
} from "../../../packages/daemon/dist/features/plugins/bundled-index.js";
import { createDevelopmentBundledPluginStagerForTest } from "../scripts/stage-development-bundled-plugins.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const sourceRoot = resolve(repositoryRoot, "packages/daemon/src/features/plugins/bundled");
const execFile = promisify(execFileCallback);

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
  assert.equal(
    desktopPackage.build.files.includes("!dist/daemon/bundled{,/**/*}"),
    true,
    "development-only staged metadata must not enter app.asar outside the reviewed extraResources lane",
  );
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
      moduleUrl: pathToFileURL(
        resolve(resourcesPath, "virtual", "app.asar", "dist", "daemon", "cli.mjs"),
      ).href,
      cwd: resolve(resourcesPath, "virtual-workspace"),
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

test("development daemon resolves bundled metadata with an unrelated workspace cwd", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "ling-desktop-external-workspace-"));
  try {
    const expectedRoot = resolve(desktopRoot, "dist/daemon/bundled/cua-driver");
    const resolvedRoot = resolveBundledPackageRoot("cua-driver", {
      resourcesPath: resolve(workspace, "electron-resources"),
      moduleUrl: pathToFileURL(resolve(desktopRoot, "dist/daemon/cli.mjs")).href,
      cwd: workspace,
    });
    assert.equal(resolvedRoot, expectedRoot);
    for (const path of [".ling-plugin/plugin.json", "mcp-server.json", "README.md"]) {
      assert.deepEqual(
        await readFile(resolve(resolvedRoot, path)),
        await readFile(resolve(sourceRoot, "cua-driver", path)),
      );
    }
    assert.deepEqual((await readdir(expectedRoot, { recursive: true })).map(path => path.replaceAll("\\", "/")).sort(), [
      ".ling-plugin", ".ling-plugin/plugin.json", "README.md", "mcp-server.json",
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Desktop development build stages bundled metadata after emitting the daemon", async () => {
  const desktopPackage = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));
  assert.match(desktopPackage.scripts.build,
    /node scripts\/build-packaged-daemon\.mjs && node scripts\/stage-development-bundled-plugins\.mjs/u);
});

test("development bundled-plugin staging replaces the destination with the exact reviewed inventory", async () => {
  const destinationRoot = resolve(desktopRoot, "dist/daemon/bundled");
  const foreignRoot = resolve(destinationRoot, "foreign-plugin");
  const foreignPath = resolve(foreignRoot, "unreviewed.txt");
  await mkdir(foreignRoot, { recursive: true });
  await writeFile(foreignPath, "UNREVIEWED FOREIGN FILE\n");
  try {
    await execFile(process.execPath, [resolve(desktopRoot, "scripts/stage-development-bundled-plugins.mjs")], {
      cwd: repositoryRoot,
    });
    await assert.rejects(readFile(foreignPath), error => error?.code === "ENOENT");
    assert.deepEqual(
      (await readdir(destinationRoot, { recursive: true })).map(path => path.replaceAll("\\", "/")).sort(),
      ["cua-driver", "cua-driver/.ling-plugin", "cua-driver/.ling-plugin/plugin.json", "cua-driver/README.md", "cua-driver/mcp-server.json"],
    );
  } finally {
    await rm(foreignRoot, { recursive: true, force: true });
  }
});

test("development bundled-plugin staging restores the previous tree when atomic cutover fails", async t => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "ling-bundled-stage-rollback-"));
  const sourceRoot = resolve(fixtureRoot, "source/cua-driver");
  const destinationRoot = resolve(fixtureRoot, "dist/daemon/bundled");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(destinationRoot, { recursive: true });
  await writeFile(resolve(sourceRoot, "manifest.json"), "NEW REVIEWED METADATA\n");
  await writeFile(resolve(destinationRoot, "previous.txt"), "PREVIOUS EXACT TREE\n");
  await writeFile(resolve(fixtureRoot, "package.json"), JSON.stringify({
    build: { extraResources: [{ from: "source", to: "bundled", filter: ["cua-driver/manifest.json"] }] },
  }));

  const injectedError = Object.assign(new Error("injected_cutover_failure"), { code: "EIO" });
  const stage = createDevelopmentBundledPluginStagerForTest({
    rename: async (from, to) => {
      if (to === destinationRoot && basename(from) === "next") throw injectedError;
      return rename(from, to);
    },
  });
  try {
    await assert.rejects(stage({ desktopRoot: fixtureRoot }), error => error === injectedError);
    assert.equal(await readFile(resolve(destinationRoot, "previous.txt"), "utf8"), "PREVIOUS EXACT TREE\n");
    await assert.rejects(readFile(resolve(destinationRoot, "cua-driver/manifest.json")), error => error?.code === "ENOENT");
    assert.deepEqual((await readdir(fixtureRoot)).filter(name => name.startsWith(".bundled-plugin-stage-")), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  t.diagnostic("Injected the failure after previous-tree quarantine and before next-tree publication; rollback restored the original bytes.");
});

test("development bundled-plugin staging retains recovery bytes if publication and rollback both fail", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "ling-bundled-stage-recovery-"));
  const sourceRoot = resolve(fixtureRoot, "source/cua-driver");
  const destinationRoot = resolve(fixtureRoot, "dist/daemon/bundled");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(destinationRoot, { recursive: true });
  await writeFile(resolve(sourceRoot, "manifest.json"), "NEW REVIEWED METADATA\n");
  await writeFile(resolve(destinationRoot, "previous.txt"), "PREVIOUS EXACT TREE\n");
  await writeFile(resolve(fixtureRoot, "package.json"), JSON.stringify({
    build: { extraResources: [{ from: "source", to: "bundled", filter: ["cua-driver/manifest.json"] }] },
  }));

  const publicationError = Object.assign(new Error("injected_cutover_failure"), { code: "EIO" });
  const rollbackError = Object.assign(new Error("injected_rollback_failure"), { code: "EACCES" });
  let renameCount = 0;
  const stage = createDevelopmentBundledPluginStagerForTest({
    rename: async (from, to) => {
      renameCount += 1;
      if (renameCount === 2) throw publicationError;
      if (renameCount === 3) throw rollbackError;
      return rename(from, to);
    },
  });
  let observed;
  try {
    await assert.rejects(stage({ desktopRoot: fixtureRoot }), error => {
      observed = error;
      return error?.code === "bundled_plugin_stage_rollback_failed"
        && error.errors?.[0] === publicationError
        && error.errors?.[1] === rollbackError;
    });
    assert.equal(
      await readFile(resolve(observed.recoveryPath, "previous/previous.txt"), "utf8"),
      "PREVIOUS EXACT TREE\n",
    );
    assert.equal(
      await readFile(resolve(observed.recoveryPath, "next/cua-driver/manifest.json"), "utf8"),
      "NEW REVIEWED METADATA\n",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
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

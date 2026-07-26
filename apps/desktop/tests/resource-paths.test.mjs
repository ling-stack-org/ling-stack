import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  resolveDesktopResourcePaths,
  resolveDesktopResourcesRoot,
} from "../dist/main/resource-paths.js";

test("development resourcesRoot is appPath/resources", async (t) => {
  const fixture = await createFixture(t);
  const app = { isPackaged: false, getAppPath: () => fixture.appPath };

  assert.equal(
    resolveDesktopResourcesRoot(app, "/ignored/packaged/resources"),
    resolve(fixture.appPath, "resources"),
  );
  const paths = await resolveDesktopResourcePaths(app, "/ignored/packaged/resources");
  assert.equal(paths.resourcesRoot, resolve(fixture.appPath, "resources"));
});

test("packaged resourcesRoot is Electron process.resourcesPath", async (t) => {
  const fixture = await createFixture(t);
  const packagedResourcesPath = join(fixture.root, "packaged-resources");
  await mkdir(join(packagedResourcesPath, "web"), { recursive: true });
  await writeFile(join(packagedResourcesPath, "web", "index.html"), "fixture");
  const app = { isPackaged: true, getAppPath: () => fixture.appPath };

  assert.equal(resolveDesktopResourcesRoot(app, packagedResourcesPath), resolve(packagedResourcesPath));
  const paths = await resolveDesktopResourcePaths(app, packagedResourcesPath);
  assert.equal(paths.resourcesRoot, resolve(packagedResourcesPath));
  assert.equal(paths.webIndexPath, resolve(packagedResourcesPath, "web/index.html"));
});

test("packaged Web entry keeps public assets relative and exposes macOS drag chrome", async () => {
  const webDistRoot = resolve(import.meta.dirname, "../../web/dist");
  const html = await readFile(join(webDistRoot, "index.html"), "utf8");
  const scriptPath = entryAssetPath(html, "script", "js");
  const stylesheetPath = entryAssetPath(html, "link", "css");
  const [script, stylesheet] = await Promise.all([
    readFile(join(webDistRoot, scriptPath), "utf8"),
    readFile(join(webDistRoot, stylesheetPath), "utf8"),
  ]);

  assert.match(script, /\.\/icons\/ling-stack-gpt-image-2-icon\.png/u);
  assert.match(script, /\.\/avatars\/teammates/u);
  assert.match(script, /desktop-window-drag-region/u);
  assert.match(stylesheet, /\.desktop-window-drag-region/u);
  assert.match(stylesheet, /\.app-shell\.desktop-macos/u);
  assert.match(stylesheet, /\.teammate-chat-header/u);
  assert.match(stylesheet, /-webkit-app-region:\s*drag/u);
  assert.match(stylesheet, /-webkit-app-region:\s*no-drag/u);
});

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-desktop-resource-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, "apps", "desktop");
  await Promise.all([
    mkdir(join(root, "apps", "web", "dist"), { recursive: true }),
    mkdir(join(appPath, "dist", "daemon"), { recursive: true }),
    mkdir(join(appPath, "dist", "renderer", "computer-use-preview"), { recursive: true }),
    mkdir(join(appPath, "resources"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "apps", "web", "dist", "index.html"), "fixture"),
    writeFile(join(appPath, "dist", "daemon", "cli.mjs"), "fixture"),
    writeFile(join(appPath, "dist", "renderer", "computer-use-preview", "index.html"), "fixture"),
  ]);
  return { root, appPath };
}

function entryAssetPath(html, tagName, extension) {
  const match = new RegExp(`<${tagName}[^>]+(?:src|href)="\\./([^\"]+\\.${extension})"`, "u").exec(html);
  assert.ok(match?.[1], `missing ${extension} entry asset`);
  return match[1];
}

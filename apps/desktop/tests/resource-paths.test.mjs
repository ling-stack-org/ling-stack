import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
  assert.equal(paths.imageSanitizerPath, resolve(fixture.root, "packages/daemon/dist/native/image-sanitizer", imageExecutable()));
});

test("packaged resourcesRoot is Electron process.resourcesPath", async (t) => {
  const fixture = await createFixture(t);
  const packagedResourcesPath = join(fixture.root, "packaged-resources");
  await mkdir(join(packagedResourcesPath, "web"), { recursive: true });
  await mkdir(join(packagedResourcesPath, "browser-host"), { recursive: true });
  await mkdir(join(packagedResourcesPath, "restricted-command"), { recursive: true });
  await mkdir(join(packagedResourcesPath, "office-local", "source"), { recursive: true });
  if (process.platform === "win32") {
    await mkdir(join(packagedResourcesPath, "engine-supervisor"), { recursive: true });
    await writeFile(join(packagedResourcesPath, "engine-supervisor/ling-engine-supervisor.exe"), "fixture");
  }
  await writeFile(join(packagedResourcesPath, "web", "index.html"), "fixture");
  await writeFile(
    join(packagedResourcesPath, "browser-host", process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"),
    "fixture",
  );
  await writeFile(join(packagedResourcesPath, "restricted-command", "ling-sandbox-runner"), "fixture");
  await writeFile(join(packagedResourcesPath, "restricted-command", "manifest.json"), "{}");
  await writeFile(join(packagedResourcesPath, "office-local", "office-local.node"), "test-only addon bytes");
  await writeFile(join(packagedResourcesPath, "office-local", "build-manifest.json"), "test-only build data");
  await mkdir(join(packagedResourcesPath, "image-sanitizer"));
  const imagePath = join(packagedResourcesPath, "image-sanitizer", imageExecutable());
  await writeFile(imagePath, "test-only codec bytes");
  await writeFile(join(packagedResourcesPath, "image-sanitizer/build-metadata.json"), "{}");
  await writeFile(join(packagedResourcesPath, "image-sanitizer/THIRD_PARTY_LICENSES.txt"), "test-only notices");
  const app = { isPackaged: true, getAppPath: () => fixture.appPath };

  assert.equal(resolveDesktopResourcesRoot(app, packagedResourcesPath), resolve(packagedResourcesPath));
  const paths = await resolveDesktopResourcePaths(app, packagedResourcesPath);
  assert.equal(paths.resourcesRoot, resolve(packagedResourcesPath));
  assert.equal(paths.webIndexPath, resolve(packagedResourcesPath, "web/index.html"));
  assert.equal(paths.imageSanitizerPath, imagePath);
  await unlink(imagePath);
  await assert.rejects(resolveDesktopResourcePaths(app, packagedResourcesPath), { name: "DesktopResourceResolutionError" });
  assert.equal(
    paths.browserHostPath,
    resolve(packagedResourcesPath, "browser-host", process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"),
  );
});

test("packaged Web entry keeps public assets relative and exposes the shared Desktop drag contract", async () => {
  const webDistRoot = resolve(import.meta.dirname, "../../web/dist");
  const html = await readFile(join(webDistRoot, "index.html"), "utf8");
  const scriptPath = entryAssetPath(html, "script", "js");
  const stylesheetPaths = entryStylesheetPaths(html);
  const [script, stylesheets] = await Promise.all([
    readFile(join(webDistRoot, scriptPath), "utf8"),
    Promise.all(stylesheetPaths.map((path) => readFile(join(webDistRoot, path), "utf8"))),
  ]);
  const stylesheet = stylesheets.join("\n");
  const javascriptBundles = await readJavascriptBundles(join(webDistRoot, "assets"));

  assert.match(javascriptBundles, /ling-mark-compact\.svg/u);
  assert.ok(script.length > 0);
  assert.match(javascriptBundles, /avatars\/teammates/u);
  const [conversationMark, teammateAvatar] = await Promise.all([
    readFile(join(webDistRoot, "icons", "ling-mark-compact.svg")),
    readFile(join(webDistRoot, "avatars", "teammates", "engineer.png")),
  ]);
  assert.ok(conversationMark.byteLength > 0);
  assert.ok(teammateAvatar.byteLength > 0);
  assert.match(javascriptBundles, /desktop-window-chrome/u);
  assert.match(javascriptBundles, /data-desktop-window-chrome/u);
  assert.match(javascriptBundles, /data-desktop-window-titlebar-surface/u);
  assert.match(javascriptBundles, /data-desktop-window-drag-region/u);
  assert.match(javascriptBundles, /data-desktop-window-no-drag/u);
  assert.match(stylesheet, /\.desktop-window-titlebar-surface/u);
  assert.match(stylesheet, /\.desktop-window-shell/u);
  assert.match(stylesheet, /\[data-desktop-window-drag-region=/u);
  assert.match(stylesheet, /\[data-desktop-window-no-drag=/u);
  assert.match(stylesheet, /grid-area:\s*titlebar/u);
  assert.match(stylesheet, /data-ling-overlay-scrim/u);
  assert.match(stylesheet, /--desktop-window-titlebar-height:\s*48px/u);
  assert.match(stylesheet, /pointer-events:\s*none/u);
  assert.match(stylesheet, /-webkit-app-region:\s*drag/u);
  assert.match(stylesheet, /-webkit-app-region:\s*no-drag/u);
});

test("packaged entry stylesheet discovery includes split CSS but excludes preload-only assets", () => {
  const html = [
    '<link rel="preload" as="style" href="./assets/not-applied.css">',
    '<link rel="stylesheet" crossorigin href="./assets/components.css">',
    '<link href="./assets/shell.css" rel="stylesheet">',
    '<script src="./assets/main.js"></script>',
  ].join("\n");
  assert.deepEqual(entryStylesheetPaths(html), ["assets/components.css", "assets/shell.css"]);
  assert.throws(() => entryStylesheetPaths('<link rel="preload" href="./assets/unused.css">'), /missing entry stylesheet/u);
  assert.throws(() => entryStylesheetPaths('<link rel="stylesheet" href="/assets/absolute.css">'), /relative packaged stylesheet/u);
});

async function readJavascriptBundles(assetsRoot) {
  const entries = await readdir(assetsRoot, { withFileTypes: true });
  const scripts = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => readFile(join(assetsRoot, entry.name), "utf8"));
  return (await Promise.all(scripts)).join("\n");
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-desktop-resource-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, "apps", "desktop");
  await Promise.all([
    mkdir(join(root, "apps", "web", "dist"), { recursive: true }),
    mkdir(join(appPath, "dist", "daemon"), { recursive: true }),
    mkdir(join(appPath, "dist", "renderer", "computer-use-preview"), { recursive: true }),
    mkdir(join(appPath, "resources"), { recursive: true }),
    mkdir(join(root, "packages", "browser-host", "dist", "native"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "apps", "web", "dist", "index.html"), "fixture"),
    writeFile(join(appPath, "dist", "daemon", "cli.mjs"), "fixture"),
    writeFile(join(appPath, "dist", "renderer", "computer-use-preview", "index.html"), "fixture"),
    writeFile(
      join(root, "packages", "browser-host", "dist", "native", process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"),
      "fixture",
    ),
  ]);
  return { root, appPath };
}

function entryAssetPath(html, tagName, extension) {
  const match = new RegExp(`<${tagName}[^>]+(?:src|href)="\\./([^\"]+\\.${extension})"`, "u").exec(html);
  assert.ok(match?.[1], `missing ${extension} entry asset`);
  return match[1];
}

function entryStylesheetPaths(html) {
  // Only HTML-linked styles count. Scanning every emitted CSS chunk could hide
  // a real missing-import bug behind an unrelated or unreachable stylesheet.
  const links = (html.match(/<link\b[^>]*>/gu) ?? [])
    .filter((tag) => /\brel=["']stylesheet["']/u.test(tag));
  assert.ok(links.length > 0, "missing entry stylesheet");
  return links.map((tag) => {
    const match = /\bhref=["']\.\/([^"']+\.css)["']/u.exec(tag);
    assert.ok(match?.[1], "expected a relative packaged stylesheet");
    return match[1];
  });
}

function imageExecutable() { return process.platform === "win32" ? "ling-image-sanitizer.exe" : "ling-image-sanitizer"; }

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ling-catalog-compilation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "catalogs"));
  for (const name of ["compile-catalogs.mjs", "catalog-utils.mjs"]) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(root, "scripts", name));
  }
  const catalog = (locale, message) => writeFileSync(path.join(root, "catalogs", `${locale}.json`), JSON.stringify({
    locale, sourceRevision: "fixture", messages: { "daemon.fixture": message },
  }));
  const compile = () => execFileSync(process.execPath, [path.join(root, "scripts/compile-catalogs.mjs")], { encoding: "utf8" });
  const generated = path.join(root, "src/generated");
  catalog("en-US", "First");
  compile();
  return { root, catalog, compile, generated };
}

function snapshot(file) {
  const stat = lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, mtimeNs: stat.mtimeNs, bytes: readFileSync(file) };
}

test("unchanged compilation preserves every generated file's bytes and identity", (t) => {
  const f = fixture(t);
  const files = ["catalog-loaders.ts", "server-catalogs.ts", "catalogs/en-US.ts"];
  const before = files.map((file) => snapshot(path.join(f.generated, file)));
  f.compile();
  assert.deepEqual(files.map((file) => snapshot(path.join(f.generated, file))), before);
  assert.deepEqual(readdirSync(f.generated).sort(), ["catalog-loaders.ts", "catalogs", "server-catalogs.ts"]);
  assert.deepEqual(readdirSync(path.join(f.generated, "catalogs")), ["en-US.ts"]);
});

test("changed messages replace only changed generated outputs", (t) => {
  const f = fixture(t);
  const loader = path.join(f.generated, "catalog-loaders.ts");
  const before = snapshot(loader);
  f.catalog("en-US", "Updated");
  f.compile();
  assert.deepEqual(snapshot(loader), before);
  assert.match(readFileSync(path.join(f.generated, "catalogs/en-US.ts"), "utf8"), /Updated/);
  assert.match(readFileSync(path.join(f.generated, "server-catalogs.ts"), "utf8"), /Updated/);
});

test("locale additions and removals still update loaders and remove obsolete output", (t) => {
  const f = fixture(t);
  f.catalog("fr-FR", "Premier");
  f.compile();
  assert.match(readFileSync(path.join(f.generated, "catalog-loaders.ts"), "utf8"), /fr-FR/);
  assert.match(readFileSync(path.join(f.generated, "catalogs/fr-FR.ts"), "utf8"), /Premier/);
  rmSync(path.join(f.root, "catalogs/fr-FR.json"));
  f.compile();
  assert.doesNotMatch(readFileSync(path.join(f.generated, "catalog-loaders.ts"), "utf8"), /fr-FR/);
  assert.deepEqual(readdirSync(path.join(f.generated, "catalogs")), ["en-US.ts"]);
});

test("a same-content symlink is replaced rather than treated as a stable generated file", (t) => {
  const f = fixture(t);
  const loader = path.join(f.generated, "catalog-loaders.ts");
  const target = path.join(f.root, "outside-loader.ts");
  const original = readFileSync(loader);
  writeFileSync(target, original);
  const before = snapshot(target);
  rmSync(loader);
  symlinkSync(target, loader);
  f.compile();
  assert.ok(lstatSync(loader).isFile());
  assert.equal(lstatSync(loader).isSymbolicLink(), false);
  assert.deepEqual(readFileSync(loader), original);
  assert.deepEqual(snapshot(target), before);
});

test("a same-content hard link is detached rather than retained as a generated input", (t) => {
  const f = fixture(t);
  const loader = path.join(f.generated, "catalog-loaders.ts");
  const target = path.join(f.root, "outside-loader.ts");
  linkSync(loader, target);
  const before = snapshot(target);
  assert.equal(lstatSync(loader).nlink, 2);
  f.compile();
  assert.equal(lstatSync(loader).nlink, 1);
  assert.notEqual(lstatSync(loader).ino, lstatSync(target).ino);
  assert.deepEqual(readFileSync(loader), before.bytes);
  assert.deepEqual(snapshot(target), before);
});

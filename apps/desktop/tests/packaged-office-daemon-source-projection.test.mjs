import assert from "node:assert/strict";
import test from "node:test";
import fsModule, { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const helperPath = join(repositoryRoot, "apps/desktop/scripts/packaged-office-daemon-source-inputs.mjs");
const packageNames = ["browser-host", "contracts", "core", "daemon", "localization", "plugin-sdk",
  "providers", "remote-protocol", "runner-pi"];
const sourceError = /packaged_office_daemon_source_(input|export)_invalid/u;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("local source projection snapshots changed authored inputs without modifying the approved review", async t => {
  const f = await fixture(t);
  writeFileSync(f.path("packages/core/src/index.ts"), 'export const value="local-worktree-source";\n');
  const projection = f.localApi.createReviewedOfficeDaemonSourceInputs();
  const result = await bundle(f, projection);
  assert.match(result.outputFiles[0].text, /local-worktree-source/u);
  projection.assertOriginalInputs(result);
  assert.deepEqual(readFileSync(f.reviewPath), f.originalReviewBytes);
  assert.match(projection.sourceReviewSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(projection.sourceReviewSha256, hash(f.originalReviewBytes));
});

test("source projection uses real esbuild on nine reviewed source packages and never stale workspace dist", async t => {
  const f = await fixture(t);
  const projection = f.api.createReviewedOfficeDaemonSourceInputs();
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.tsconfigRaw), true);
  assert.equal(Object.isFrozen(projection.tsconfigRaw.compilerOptions), true);
  assert.equal(projection.entryPoint, f.path("packages/daemon/src/cli.ts"));
  const result = await bundle(f, projection);
  const inputs = workspaceInputs(f, result);
  assert.equal(inputs.every(path => path.includes("/src/") && !path.includes("/dist/")), true);
  assert.deepEqual([...new Set(inputs.map(path => path.split("/")[1]))].sort(), [...packageNames].sort());
  assert.ok(inputs.includes("packages/core/src/original-office-host-bridge.ts"));
  assert.ok(inputs.includes("packages/daemon/src/index.ts"));
  const output = result.outputFiles[0].text;
  assert.match(output, /EXPLICIT_REVIEWED_SOURCE_CORE_SUBPATH/u);
  assert.doesNotMatch(output, /EXPLICIT_STALE_WORKSPACE_DIST/u);
  projection.assertOriginalInputs(result);
  assert.equal(existsSync(f.path("apps/desktop/dist/daemon/cli.mjs")), false);
  assert.deepEqual(readFileSync(f.reviewPath), f.originalReviewBytes);
  t.diagnostic("Copied real source-input helper + explicitly synthetic fixed review, real esbuild resolver/TS transform. No native build/signature/publication issuer, product approval, daemon execution, or GUI acceptance.");
});

test("source projection preserves root main fallback and package export condition/subpath routes", async t => {
  for (const route of ["main", "import-condition", "node-condition", "wildcard"]) await t.test(route, async t => {
    const f = await fixture(t, {
      configure(files) {
        const json = JSON.parse(files.get("packages/core/package.json"));
        if (route === "main") delete json.exports;
        if (route === "import-condition") json.exports["."] = {
          types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/NOT_REVIEWED.js",
        };
        if (route === "node-condition") json.exports["."] = {
          types: "./dist/index.d.ts", node: "./dist/index.js", default: "./dist/NOT_REVIEWED.js",
        };
        if (route === "wildcard") {
          delete json.exports["./original-office-host-bridge"];
          json.exports["./*"] = "./dist/*.js";
        }
        files.set("packages/core/package.json", JSON.stringify(json));
        if (route === "main") files.set("packages/daemon/src/cli.ts", 'import { value } from "@ling-stack/core"; globalThis.__EXPLICIT_SOURCE_RESULT__ = value;\n');
      },
    });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs();
    const result = await bundle(f, projection);
    assert.ok(workspaceInputs(f, result).includes("packages/core/src/index.ts"));
    assert.doesNotMatch(result.outputFiles[0].text, /EXPLICIT_STALE_WORKSPACE_DIST/u);
    projection.assertOriginalInputs(result);
  });
});

test("relative explicit dist and absolute workspace paths project only to reviewed authored bytes", async t => {
  for (const route of ["relative-dist", "absolute-src", "absolute-dist"]) await t.test(route, async t => {
    const f = await fixture(t, { configure(files, root) {
      const specifier = route === "relative-dist" ? "../../core/dist/index.js"
        : join(root, "packages/core", route === "absolute-src" ? "src/index.ts" : "dist/index.js");
      files.set("packages/daemon/src/cli.ts", `import { value } from ${JSON.stringify(specifier)}; globalThis.__EXPLICIT_SOURCE_RESULT__ = value;\n`);
    } });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs(), result = await bundle(f, projection);
    assert.ok(workspaceInputs(f, result).includes("packages/core/src/index.ts"));
    assert.equal(workspaceInputs(f, result).some(path => path.includes("/dist/")), false);
    projection.assertOriginalInputs(result);
  });
});

test("unknown workspace names/subpaths and missing reviewed sources cannot fall back to dist", async t => {
  for (const route of ["unknown-package", "unknown-subpath", "missing-source", "missing-digest", "ambiguous-source", "declaration-only"]) {
    await t.test(route, async t => {
      const f = await fixture(t, { configure(files) {
        if (route === "unknown-package") files.set("packages/daemon/src/cli.ts", 'import { value } from "@ling-stack/unreviewed"; console.log(value);\n');
        if (route === "unknown-subpath") files.set("packages/daemon/src/cli.ts", 'import { value } from "@ling-stack/core/private-unexported"; console.log(value);\n');
        if (route === "missing-source") files.delete("packages/core/src/index.ts");
        if (route === "ambiguous-source") files.set("packages/core/src/index.mts", 'export const value="UNREVIEWED_AMBIGUOUS";\n');
        if (route === "declaration-only") {
          files.delete("packages/core/src/index.ts"); files.set("packages/core/src/index.d.ts", 'export declare const value:string;\n');
        }
      }, omitReview: route === "missing-digest" ? ["packages/core/src/index.ts"] : [] });
      const projection = f.api.createReviewedOfficeDaemonSourceInputs();
      await assert.rejects(bundle(f, projection), sourceError);
      assert.equal(existsSync(f.path("apps/desktop/dist/daemon/cli.mjs")), false);
      assert.deepEqual(readFileSync(f.reviewPath), f.originalReviewBytes);
    });
  }
});

test("export targets cannot escape package source boundaries or select unreviewed assets", async t => {
  const targets = ["../contracts/dist/index.js", "./../../outside.ts", "./dist/../../outside.ts",
    "./dist/index.js\0", ".\\dist\\index.js", "/tmp/absolute.ts", "./fixtures/not-reviewed.json"];
  for (const target of targets) await t.test(JSON.stringify(target), async t => {
    const f = await fixture(t, { configure(files) {
      const json = JSON.parse(files.get("packages/core/package.json")); json.exports["."] = target;
      files.set("packages/core/package.json", JSON.stringify(json));
    } });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs();
    await assert.rejects(bundle(f, projection), sourceError);
  });
});

test("wildcard exports reject unsafe specifier segments even when normalization reaches reviewed source", async t => {
  const specifiers = ["../index", "./en", "nested/../en", "%2e%2e/index", "en?query", "en#fragment",
    "en\\extra", "node_modules/en", "/en"];
  for (const replacement of specifiers) await t.test(replacement, async t => {
    const f = await fixture(t, { configure(files) {
      const json = JSON.parse(files.get("packages/localization/package.json"));
      json.exports = { "./catalogs/*": "./dist/generated/*.js" };
      files.set("packages/localization/package.json", JSON.stringify(json));
      files.set("packages/localization/src/generated/en.ts", 'export const value="EXPLICIT_REVIEWED_CATALOG";\n');
      files.set("packages/daemon/src/cli.ts", `import { value } from ${JSON.stringify(`@ling-stack/localization/catalogs/${replacement}`)}; console.log(value);\n`);
    } });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs();
    await assert.rejects(bundle(f, projection), sourceError);
  });
});

test("fallback resolution admits builtins and ordinary vendor files without propagating foreign pluginData", async t => {
  const f = await fixture(t, { configure(files) {
    files.set("node_modules/explicit-vendor-resolution/index.js", 'export const value="EXPLICIT_VENDOR_SOURCE";\n');
    files.set("packages/daemon/src/cli.ts", 'import { readFileSync } from "node:fs"; import { value } from "explicit-vendor-resolution"; console.log(readFileSync, value);\n');
  } });
  const projection = f.api.createReviewedOfficeDaemonSourceInputs();
  let observed = false;
  const foreignPluginData = Object.freeze({ unreviewed: "DO_NOT_PROPAGATE" });
  const vendorPlugin = { name: "explicit-test-only-vendor-resolver", setup(builder) {
    builder.onResolve({ filter: /^explicit-vendor-resolution$/ }, () => ({
      path: f.path("node_modules/explicit-vendor-resolution/index.js"), namespace: "file", pluginData: foreignPluginData,
    }));
    builder.onLoad({ filter: /explicit-vendor-resolution\/index\.js$/ }, args => {
      observed = true;
      assert.equal(args.pluginData, undefined, "fallback must not transfer third-party resolver authority");
    });
  } };
  const result = await bundle(f, projection, [vendorPlugin]);
  assert.equal(observed, true);
  assert.match(result.outputFiles[0].text, /EXPLICIT_VENDOR_SOURCE/u);
  assert.match(result.outputFiles[0].text, /from "node:fs"/u);
  projection.assertOriginalInputs(result);
});

test("prefix-only Node builtin node:sqlite is externalized by real esbuild without executing it", async t => {
  const f = await fixture(t, { configure(files) {
    files.set("packages/daemon/src/cli.ts", 'import { DatabaseSync } from "node:sqlite"; globalThis.__EXPLICIT_SQLITE_BUILTIN__ = DatabaseSync;\n');
  } });
  const projection = f.api.createReviewedOfficeDaemonSourceInputs(), result = await bundle(f, projection);
  assert.match(result.outputFiles[0].text, /from "node:sqlite"/u);
  assert.equal(Object.values(result.metafile.outputs).some(output => output.imports.some(value =>
    value.path === "node:sqlite" && value.external === true)), true);
  projection.assertOriginalInputs(result);
  t.diagnostic("Prefix-only builtin admission regression: prior builtinModules enumeration omitted node:sqlite; this test bundles but never imports or executes node:sqlite.");
});

test("fallback resolution rejects nonbuiltin external, foreign namespace, suffix and repository nonvendor files", async t => {
  for (const kind of ["external", "namespace", "suffix", "repository-file"]) await t.test(kind, async t => {
    const f = await fixture(t, { configure(files) {
      files.set("node_modules/explicit-vendor-resolution/index.js", 'export const value="EXPLICIT_VENDOR_SOURCE";\n');
      files.set("scripts/EXPLICIT_UNREVIEWED_REPOSITORY_FILE.js", 'export const value="EXPLICIT_REPO_BYPASS";\n');
      files.set("packages/daemon/src/cli.ts", 'import { value } from "explicit-vendor-resolution"; console.log(value);\n');
    } });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs();
    const vendorPlugin = { name: "explicit-test-only-invalid-vendor-resolver", setup(builder) {
      builder.onResolve({ filter: /^explicit-vendor-resolution$/ }, () => {
        if (kind === "external") return { path: "explicit-unreviewed-external", external: true };
        return { path: f.path(kind === "repository-file" ? "scripts/EXPLICIT_UNREVIEWED_REPOSITORY_FILE.js"
          : "node_modules/explicit-vendor-resolution/index.js"),
        ...(kind === "namespace" ? { namespace: "explicit-foreign-namespace" } : {}),
        ...(kind === "suffix" ? { suffix: "?explicit-unreviewed-suffix" } : {}) };
      });
    } };
    await assert.rejects(bundle(f, projection, [vendorPlugin]), sourceError);
  });
});

test("vendor symlink resolution into workspace projects reviewed dist or rejects unknown workspace packages", async t => {
  for (const kind of ["reviewed", "unknown"]) await t.test(kind, async t => {
    const f = await fixture(t, { configure(files) {
      files.set("node_modules/explicit-vendor-resolution/package.json", JSON.stringify({
        name: "explicit-vendor-resolution", type: "module", main: "./index.js",
      }));
      files.set("packages/daemon/src/cli.ts", 'import { value } from "explicit-vendor-resolution"; console.log(value);\n');
      if (kind === "unknown") files.set("packages/unreviewed/src/index.js", 'export const value="EXPLICIT_UNKNOWN_WORKSPACE";\n');
    }, omitReview: kind === "unknown" ? ["packages/unreviewed/src/index.js"] : [] });
    symlinkSync(f.path(kind === "reviewed" ? "packages/core/dist/index.js" : "packages/unreviewed/src/index.js"),
      f.path("node_modules/explicit-vendor-resolution/index.js"));
    const projection = f.api.createReviewedOfficeDaemonSourceInputs();
    if (kind === "unknown") await assert.rejects(bundle(f, projection), sourceError);
    else {
      const result = await bundle(f, projection);
      assert.ok(workspaceInputs(f, result).includes("packages/core/src/index.ts"));
      assert.doesNotMatch(result.outputFiles[0].text, /EXPLICIT_STALE_WORKSPACE_DIST/u);
      projection.assertOriginalInputs(result);
    }
  });
});

test("vendor back-edges cannot make esbuild consume workspace dist or unreviewed repository files", async t => {
  for (const kind of ["workspace-dist", "repository-file"]) await t.test(kind, async t => {
    const f = await fixture(t, { configure(files) {
      files.set("node_modules/explicit-vendor-resolution/package.json", JSON.stringify({
        name: "explicit-vendor-resolution", type: "module", main: "./index.js",
      }));
      files.set("node_modules/explicit-vendor-resolution/index.js", `export { value } from ${JSON.stringify(kind === "workspace-dist"
        ? "../../packages/core/dist/index.js" : "../../scripts/EXPLICIT_UNREVIEWED_REPOSITORY_FILE.js")};\n`);
      files.set("scripts/EXPLICIT_UNREVIEWED_REPOSITORY_FILE.js", 'export const value="EXPLICIT_REPO_BYPASS";\n');
      files.set("packages/daemon/src/cli.ts", 'import { value } from "explicit-vendor-resolution"; console.log(value);\n');
    } });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs();
    await assert.rejects(bundle(f, projection), sourceError);
  });
});

test("vendor optional dependency handling remains esbuild default behavior", async t => {
  const f = await fixture(t, { configure(files) {
    files.set("node_modules/explicit-vendor-resolution/package.json", JSON.stringify({
      name: "explicit-vendor-resolution", type: "module", main: "./index.js",
    }));
    files.set("node_modules/explicit-vendor-resolution/index.js", 'try { require("EXPLICIT_OPTIONAL_VENDOR_NOT_INSTALLED"); } catch {} export const value="EXPLICIT_OPTIONAL_VENDOR_HANDLED";\n');
    files.set("packages/daemon/src/cli.ts", 'import { value } from "explicit-vendor-resolution"; console.log(value);\n');
  } });
  const projection = f.api.createReviewedOfficeDaemonSourceInputs(), result = await bundle(f, projection);
  assert.match(result.outputFiles[0].text, /EXPLICIT_OPTIONAL_VENDOR_NOT_INSTALLED/u);
  assert.match(result.outputFiles[0].text, /EXPLICIT_OPTIONAL_VENDOR_HANDLED/u);
  projection.assertOriginalInputs(result);
});

test("all nine package manifests/configs must be reviewed and match the fixed admitted compiler policy", async t => {
  for (const name of packageNames) for (const leaf of ["package.json", "tsconfig.json"]) await t.test(`${name}/${leaf}`, async t => {
    const f = await fixture(t, { omitReview: [`packages/${name}/${leaf}`] });
    assert.throws(() => f.api.createReviewedOfficeDaemonSourceInputs(), sourceError);
  });
  const configs = [
    ["extends", config => { config.extends = "../../outside-tsconfig.json"; }],
    ["paths", config => { config.compilerOptions.paths = { "@ling-stack/core": ["../core/dist/index.js"] }; }],
    ["baseUrl", config => { config.compilerOptions.baseUrl = "."; }],
    ["decorators", config => { config.compilerOptions.experimentalDecorators = true; }],
    ["metadata", config => { config.compilerOptions.emitDecoratorMetadata = true; }],
    ["jsx", config => { config.compilerOptions.jsx = "react-jsx"; }],
    ["module", config => { config.compilerOptions.module = "CommonJS"; }],
    ["moduleResolution", config => { config.compilerOptions.moduleResolution = "Bundler"; }],
    ["target", config => { config.compilerOptions.target = "ES2015"; }],
    ["include", config => { config.include = ["src/**/*.ts", "dist/**/*.js"]; }],
    ["outDir", config => { config.compilerOptions.outDir = "other"; }],
    ["rootDir", config => { config.compilerOptions.rootDir = "."; }],
    ["strict", config => { config.compilerOptions.strict = false; }],
  ];
  for (const [name, mutate] of configs) await t.test(name, async t => {
    const f = await fixture(t, { configure(files) {
      const config = JSON.parse(files.get("packages/core/tsconfig.json")); mutate(config);
      files.set("packages/core/tsconfig.json", JSON.stringify(config));
    } });
    assert.throws(() => f.api.createReviewedOfficeDaemonSourceInputs(), sourceError);
  });
  for (const mutation of ["name", "type"]) await t.test(`package-${mutation}`, async t => {
    const f = await fixture(t, { configure(files) {
      const json = JSON.parse(files.get("packages/core/package.json")); json[mutation] = "not-the-fixed-policy";
      files.set("packages/core/package.json", JSON.stringify(json));
    } });
    assert.throws(() => f.api.createReviewedOfficeDaemonSourceInputs(), sourceError);
  });
});

test("private captured bytes cannot be replaced by mutating a returned source view", async t => {
  const f = await fixture(t), projection = f.api.createReviewedOfficeDaemonSourceInputs();
  const path = f.path("packages/core/src/index.ts"), original = readFileSync(path, "utf8");
  const first = projection.loadSource(path);
  first.contents = 'globalThis.__CALLER_MUTATION__=true; export const value="caller";';
  first.resolveDir = "/tmp/elsewhere";
  const second = projection.loadSource(path);
  assert.equal(second.contents, original);
  assert.equal(second.resolveDir, dirname(path));
  assert.notStrictEqual(first, second);
  const result = await bundle(f, projection);
  assert.doesNotMatch(result.outputFiles[0].text, /__CALLER_MUTATION__/u);
  projection.assertOriginalInputs(result);
});

test("same-byte inode replacement before first load or after returned view fails the original-input fence", async t => {
  for (const timing of ["before-first-load", "after-returned-view"]) await t.test(timing, async t => {
    const f = await fixture(t), projection = f.api.createReviewedOfficeDaemonSourceInputs();
    const path = f.path("packages/core/src/index.ts"), bytes = readFileSync(path);
    if (timing === "after-returned-view") projection.loadSource(path);
    const before = lstatSync(path, { bigint: true });
    renameSync(path, `${path}.retained-original`); writeFileSync(path, bytes, { mode: 0o600 });
    assert.notEqual(lstatSync(path, { bigint: true }).ino, before.ino);
    assert.equal(projection.loadSource(path).contents, bytes.toString("utf8"), "do not refresh original captures from a replacement");
    const result = await bundle(f, projection);
    assert.throws(() => projection.assertOriginalInputs(result), sourceError);
    assert.deepEqual(readFileSync(f.reviewPath), f.originalReviewBytes);
  });
});

test("the complete reviewed snapshot rejects identity replacement even for unused workspace source", async t => {
  const f = await fixture(t, { configure(files) {
    files.set("packages/core/src/EXPLICIT_REVIEWED_UNUSED.ts", 'export const unused="EXPLICIT_UNUSED_SOURCE";\n');
  } });
  const projection = f.api.createReviewedOfficeDaemonSourceInputs(), path = f.path("packages/core/src/EXPLICIT_REVIEWED_UNUSED.ts");
  const bytes = readFileSync(path);
  renameSync(path, `${path}.retained-original`); writeFileSync(path, bytes, { mode: 0o600 });
  const result = await bundle(f, projection);
  assert.equal(workspaceInputs(f, result).includes("packages/core/src/EXPLICIT_REVIEWED_UNUSED.ts"), false);
  assert.throws(() => projection.assertOriginalInputs(result), sourceError);
});

test("same-byte manifest and config replacements fail final identity verification", async t => {
  for (const leaf of ["package.json", "tsconfig.json"]) await t.test(leaf, async t => {
    const f = await fixture(t), projection = f.api.createReviewedOfficeDaemonSourceInputs();
    const path = f.path(`packages/core/${leaf}`), bytes = readFileSync(path);
    renameSync(path, `${path}.retained-original`); writeFileSync(path, bytes, { mode: 0o600 });
    const result = await bundle(f, projection);
    assert.throws(() => projection.assertOriginalInputs(result), sourceError);
  });
});

test("source modification during its actual create-time FD capture is rejected before exposing source text", async t => {
  for (const kind of ["rewrite", "same-byte-replace"]) await t.test(kind, async t => {
    const f = await fixture(t);
    const path = f.path("packages/core/src/index.ts"), original = readFileSync(path), identity = lstatSync(path, { bigint: true });
    const readSync = fsModule.readSync;
    let injected = false;
    const mock = t.mock.method(fsModule, "readSync", (...args) => {
      const result = readSync(...args);
      const current = fsModule.fstatSync(args[0], { bigint: true });
      if (!injected && current.dev === identity.dev && current.ino === identity.ino && args[4] === 0) {
        injected = true;
        if (kind === "rewrite") writeFileSync(path, Buffer.from('export const value = "EXPLICIT_CHANGED_DURING_READ";\n'));
        else { renameSync(path, `${path}.retained-original`); writeFileSync(path, original, { mode: 0o600 }); }
      }
      return result;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => f.api.createReviewedOfficeDaemonSourceInputs(), sourceError); assert.equal(injected, true); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });
});

test("source symlinks, hardlinks, writable files, empty files and oversized files fail closed", async t => {
  for (const kind of ["symlink", "parent-symlink", "hardlink", "group-writable", "empty", "oversized"]) await t.test(kind, async t => {
    const f = await fixture(t), path = f.path("packages/core/src/index.ts");
    if (kind === "symlink") { renameSync(path, `${path}.original`); symlinkSync(`${path}.original`, path); }
    if (kind === "parent-symlink") {
      const src = dirname(path); renameSync(src, `${src}.original`); symlinkSync(`${src}.original`, src);
    }
    if (kind === "hardlink") linkSync(path, `${path}.extra-hardlink`);
    if (kind === "group-writable") chmodSync(path, 0o620);
    if (kind === "empty") writeFileSync(path, "");
    if (kind === "oversized") writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    assert.throws(() => f.api.createReviewedOfficeDaemonSourceInputs(), sourceError);
  });
});

test("source text must round-trip UTF-8, while ordinary Unicode source compiles normally", async t => {
  await t.test("invalid-utf8", async t => {
    const f = await fixture(t, { configure(files) { files.set("packages/core/src/index.ts", Buffer.from([0x65, 0x78, 0xff, 0x70])); } });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs();
    assert.throws(() => projection.loadSource(f.path("packages/core/src/index.ts")), sourceError);
  });
  await t.test("valid-unicode", async t => {
    const f = await fixture(t, { configure(files) { files.set("packages/core/src/index.ts", 'export const value="明确已审🌏";\n'); } });
    const projection = f.api.createReviewedOfficeDaemonSourceInputs(), result = await bundle(f, projection);
    assert.equal(workspaceInputs(f, result).some(path => path.includes("/dist/")), false);
    projection.assertOriginalInputs(result);
  });
});

test("unreviewed digest or review-row changes reject instead of auto-refreshing approval", async t => {
  await t.test("source-digest-before-create", async t => {
    const f = await fixture(t);
    writeFileSync(f.path("packages/core/src/index.ts"), 'export const value="changed-source";\n');
    assert.throws(() => f.api.createReviewedOfficeDaemonSourceInputs(), sourceError);
    assert.deepEqual(readFileSync(f.reviewPath), f.originalReviewBytes);
  });
  await t.test("source-digest-after-create", async t => {
    const f = await fixture(t), projection = f.api.createReviewedOfficeDaemonSourceInputs();
    writeFileSync(f.path("packages/core/src/index.ts"), 'export const value="changed-source";\n');
    const result = await bundle(f, projection);
    assert.doesNotMatch(result.outputFiles[0].text, /changed-source/u);
    assert.match(result.outputFiles[0].text, /EXPLICIT_REVIEWED_SOURCE_core/u);
    assert.throws(() => projection.assertOriginalInputs(result), sourceError);
    assert.deepEqual(readFileSync(f.reviewPath), f.originalReviewBytes);
  });
  await t.test("review-frame-changed", async t => {
    const f = await fixture(t), projection = f.api.createReviewedOfficeDaemonSourceInputs(), result = await bundle(f, projection);
    writeFileSync(f.reviewPath, Buffer.concat([f.originalReviewBytes, Buffer.from(" ")]));
    assert.throws(() => projection.assertOriginalInputs(result), sourceError);
  });
});

test("post-build input attestation requires a real matching metafile and is single-use", async t => {
  for (const kind of ["missing-metafile", "unknown-workspace", "missing-used-input", "dist-input", "repository-nonvendor-input",
    "namespace-prefixed-input", "data-uri-input", "nul-input"]) await t.test(kind, async t => {
    const f = await fixture(t), projection = f.api.createReviewedOfficeDaemonSourceInputs(), result = await bundle(f, projection);
    if (kind === "missing-metafile") delete result.metafile;
    else if (kind === "unknown-workspace") result.metafile.inputs["../../packages/unreviewed/src/index.ts"] = { bytes: 1, imports: [] };
    else if (kind === "missing-used-input") delete result.metafile.inputs[Object.keys(result.metafile.inputs).find(path => path.includes("packages/core/src/index.ts"))];
    else if (kind === "dist-input") result.metafile.inputs["../../packages/core/dist/index.js"] = { bytes: 1, imports: [] };
    else if (kind === "repository-nonvendor-input") result.metafile.inputs["../../scripts/EXPLICIT_UNREVIEWED_REPOSITORY_FILE.js"] = { bytes: 1, imports: [] };
    else if (kind === "namespace-prefixed-input") result.metafile.inputs["foreign:../../packages/core/src/index.ts"] = { bytes: 1, imports: [] };
    else if (kind === "data-uri-input") result.metafile.inputs["data:text/javascript,export default 1"] = { bytes: 1, imports: [] };
    else result.metafile.inputs["EXPLICIT\0INPUT.js"] = { bytes: 1, imports: [] };
    assert.throws(() => projection.assertOriginalInputs(result), sourceError);
  });
  const f = await fixture(t), projection = f.api.createReviewedOfficeDaemonSourceInputs(), result = await bundle(f, projection);
  projection.assertOriginalInputs(result);
  assert.throws(() => projection.assertOriginalInputs(result), sourceError);
  assert.throws(() => projection.loadSource(f.path("packages/core/src/index.ts")), sourceError);
});

/** Disposable code copy with a test-only reviewed-source reader, never a product issuer. */
async function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-source-projection-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new Map();
  for (const name of packageNames) {
    files.set(`packages/${name}/package.json`, JSON.stringify({
      name: `@ling-stack/${name}`, type: "module", main: "./dist/index.js",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        ...(name === "core" ? { "./original-office-host-bridge": { default: "./dist/original-office-host-bridge.js" } } : {}) },
    }));
    files.set(`packages/${name}/tsconfig.json`, JSON.stringify({ compilerOptions: {
      declaration: true, module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src",
      strict: true, target: "ES2022", types: name === "daemon" || name === "core" ? ["node"] : [],
    }, include: ["src/**/*.ts"] }));
    files.set(`packages/${name}/src/index.ts`, `export const value = ${JSON.stringify(`EXPLICIT_REVIEWED_SOURCE_${name}`)};\n`);
    files.set(`packages/${name}/dist/index.js`, `globalThis.__EXPLICIT_STALE_WORKSPACE_DIST__=true; export const value=${JSON.stringify(`EXPLICIT_STALE_WORKSPACE_DIST_${name}`)};\n`);
  }
  files.set("packages/core/src/original-office-host-bridge.ts", 'export const original = "EXPLICIT_REVIEWED_SOURCE_CORE_SUBPATH";\n');
  files.set("packages/core/dist/original-office-host-bridge.js", 'globalThis.__EXPLICIT_STALE_WORKSPACE_DIST__=true; export const original="EXPLICIT_STALE_WORKSPACE_DIST_SUBPATH";\n');
  files.set("packages/daemon/src/cli.ts", 'import { value as daemon } from "./index.js";\n'
    + packageNames.filter(name => name !== "daemon").map((name, index) => `import { value as value${index} } from "@ling-stack/${name}";\n`).join("")
    + 'import { original } from "@ling-stack/core/original-office-host-bridge";\n'
    + `globalThis.__EXPLICIT_SOURCE_RESULT__ = [daemon, ${packageNames.filter(name => name !== "daemon").map((_, index) => `value${index}`).join(", ")}, original];\n`);
  options.configure?.(files, root);
  for (const [path, value] of files) newFile(join(root, path), value);
  const scripts = join(root, "apps/desktop/scripts"), copiedHelper = join(scripts, "packaged-office-daemon-source-inputs.mjs");
  mkdirSync(scripts, { recursive: true }); copyFileSync(helperPath, copiedHelper);
  copyFileSync(join(repositoryRoot, "apps/desktop/scripts/packaged-office-native-review-inputs.mjs"),
    join(scripts, "packaged-office-native-review-inputs.mjs"));
  chmodSync(copiedHelper, 0o600);
  const reviewPath = join(root, "EXPLICIT-SYNTHETIC-REVIEW.json");
  const row = { packagingSha256: Object.fromEntries([...files].filter(([path]) => !path.includes("/dist/")
    && !(options.omitReview ?? []).includes(path)).map(([path, value]) => [path, hash(value)])) };
  const originalReviewBytes = Buffer.from(JSON.stringify(row)); writeFileSync(reviewPath, originalReviewBytes, { mode: 0o600 });
  const reviewUrl = pathToFileURL(join(scripts, "packaged-office-native-review.mjs")).href;
  newFile(fileURLToPath(reviewUrl), "EXPLICIT TEST-ONLY REVIEW MODULE PLACEHOLDER\n");
  const inputsUrl = pathToFileURL(join(scripts, "packaged-office-native-review-inputs.mjs")).href;
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url === inputsUrl) return { format: "module", shortCircuit: true,
      source: `export const PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS = Object.freeze(${JSON.stringify(Object.keys(row.packagingSha256))});` };
    if (url !== reviewUrl) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: `
      import {readFileSync} from "node:fs";
      import {createHash} from "node:crypto";
      export function readReviewedPackagedOfficeSource() {
        const bytes=readFileSync(${JSON.stringify(reviewPath)});
        const review=JSON.parse(bytes.toString("utf8"));
        Object.freeze(review.packagingSha256);Object.freeze(review);
        return Object.freeze({review,sourceReviewSha256:createHash("sha256").update(bytes).digest("hex")});
      }
      export function readLocalPackagedOfficeSource() {
        const result=readReviewedPackagedOfficeSource();
        const actual=readFileSync(${JSON.stringify(join(root, "packages/core/src/index.ts"))});
        return Object.freeze({...result,sourceReviewSha256:createHash("sha256")
          .update(result.sourceReviewSha256).update(actual).digest("hex")});
      }
    ` };
  } });
  t.after(() => hook.deregister());
  const api = await import(pathToFileURL(copiedHelper).href);
  const releaseApi = Object.freeze({ createReviewedOfficeDaemonSourceInputs: () => {
    const previous = process.env.LING_PACKAGED_RELEASE_REVIEW_REQUIRED;
    process.env.LING_PACKAGED_RELEASE_REVIEW_REQUIRED = "1";
    try { return api.createReviewedOfficeDaemonSourceInputs(); }
    finally {
      if (previous === undefined) delete process.env.LING_PACKAGED_RELEASE_REVIEW_REQUIRED;
      else process.env.LING_PACKAGED_RELEASE_REVIEW_REQUIRED = previous;
    }
  } });
  return { root, api: releaseApi, localApi: api, reviewPath, originalReviewBytes, path: value => join(root, value) };
}

async function bundle(f, projection, additionalPlugins = []) {
  return build({ absWorkingDir: f.path("apps/desktop"), entryPoints: [projection.entryPoint],
    bundle: true, platform: "node", format: "esm", outfile: "dist/daemon/cli.mjs", write: false, metafile: true,
    target: "es2022", tsconfigRaw: projection.tsconfigRaw, plugins: [projection.plugin, ...additionalPlugins], logLevel: "silent" });
}

function workspaceInputs(f, result) {
  return Object.keys(result.metafile.inputs).map(path => resolve(f.path("apps/desktop"), path))
    .filter(path => path.startsWith(f.path("packages") + "/")).map(path => path.slice(f.root.length + 1));
}

function newFile(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, { mode: 0o600 }); }

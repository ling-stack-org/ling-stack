import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parserBuildEnvironment } from "./build-shell-parser.mjs";
import { managedNodeArguments } from "./run-managed.mjs";

test("parse helper build isolates Go flags, credentials, automatic toolchain and user caches", () => {
  const env = parserBuildEnvironment({ root: "/selected/resources", scratchPath: "/selected/resources/runs/test" }, {
    PATH: "/usr/bin", OPENAI_API_KEY: "fixture", GOFLAGS: "-toolexec unwanted", GOTOOLCHAIN: "auto", GOPROXY: "https://unwanted",
    GOSUMDB: "off", GOCACHE: "/outside", GOMODCACHE: "/outside", HOME: "/outside" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GOTOOLCHAIN, "local");
  assert.equal(env.GOSUMDB, "sum.golang.org");
  assert.equal(env.GOCACHE, "/selected/resources/cache/go-build");
  assert.equal(env.GOMODCACHE, "/selected/resources/cache/go-modules");
  assert.equal(env.GOFLAGS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.ok(managedNodeArguments("shell-parser", ["/selected/output"])[0].endsWith("build-shell-parser.mjs"));
  assert.throws(() => managedNodeArguments("shell-parser", ["/selected/output", "go", "extra"]), /arguments/);
});

test("parse helper cannot build without a live managed lease", () => {
  const result = spawnSync(process.execPath, ["scripts/gstack/build-shell-parser.mjs", "/must-not-write/fixture"],
    { env: { PATH: process.env.PATH, LANG: "C" }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_resource_lease_required/);
});

test("source ABA cannot bind unrecorded copied bytes to a reviewed parser build", async () => {
  const original = Buffer.from("package main // A\n"), changed = Buffer.from("package main // B\n");
  const files = new Map(["main.go", "go.mod", "go.sum", "THIRD-PARTY-NOTICES"].map(path => [
    `/fixture/source/${path}`, path === "main.go" ? original : Buffer.from(path),
  ]));
  let compilerCalls = 0, copied = false;
  const key = `parserSnapshot${randomUUID().replaceAll("-", "")}`;
  globalThis[key] = { fs: {
    mkdir: async () => {}, mkdtemp: async () => "/fixture/work", rm: async () => {}, rmdir: async () => {},
    readFile: async path => Buffer.from(files.get(path) ?? ""), writeFile: async (path, bytes) => { files.set(path, Buffer.from(bytes)); },
    copyFile: async (from, to) => {
      if (from.endsWith("/main.go")) {
        copied = true; files.set(from, changed); files.set(to, Buffer.from(files.get(from))); files.set(from, original);
      } else files.set(to, Buffer.from(files.get(from)));
    },
    rename: async () => {},
  }, exec: (_command, args) => {
    compilerCalls++;
    if (args[0] === "version") return "go version fixture";
    files.set(args[args.indexOf("-o") + 1], Buffer.from("fixture parser never executed"));
    return "";
  } };
  let source = await readFile(new URL("./build-shell-parser.mjs", import.meta.url), "utf8");
  source = source.replace('import { execFileSync } from "node:child_process";', `const execFileSync = globalThis[${JSON.stringify(key)}].exec;`)
    .replace(/import \{ ([^\n]+) \} from "node:fs\/promises";/, `const { $1 } = globalThis[${JSON.stringify(key)}].fs;`)
    .replace('import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";',
      'const managedResourceWrite = async () => ({ root: "/fixture/resources", scratchPath: "/fixture/runs/test" }); const resourceCheckpoint = async () => {};')
    .replace('import { matchesNativeDependency } from "./runtime-dependency-audit.mjs";', 'const matchesNativeDependency = async () => true;')
    .replace('const source = fileURLToPath(new URL("./shell-ast/", import.meta.url));', 'const source = "/fixture/source";')
    .replace(/if \(process\.argv\[1\][\s\S]*$/, "");
  try {
    const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    await assert.rejects(api.buildShellParser({ outputPath: "/fixture/output", goCommand: "fixture-only" }), /copy_snapshot_changed/);
    assert.equal(copied, true); assert.equal(compilerCalls, 0);
  } finally { delete globalThis[key]; }
});

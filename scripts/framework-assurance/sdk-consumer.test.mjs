import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import {
  SDK_PACKAGES, auditSdkArchiveEntries, inspectSdkTarball, isWithin, runSdkConsumer,
  sdkConsumerEnvironment, validateTypeResolutionFiles,
} from "./sdk-consumer.mjs";

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(repoRoot, "fixtures/framework-assurance/sdk-consumer");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ling-sdk-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function manifest(overrides = {}) {
  return {
    name: "@ling-stack/fixture", version: "0.0.0", type: "module",
    main: "./dist/index.js", types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    ...overrides,
  };
}

function entries(extra = []) {
  return ["package.json", "dist/index.js", "dist/index.d.ts", ...extra].map((file) => ({ path: `package/${file}`, type: "File" }));
}

const expected = { name: "@ling-stack/fixture", version: "0.0.0" };
const closure = [{ name: "@ling-stack/dependency", version: "0.0.0" }];

test("module import has no commands, output or filesystem side effects", async (t) => {
  const root = await temporary(t);
  const source = new URL("./sdk-consumer.mjs", import.meta.url).href;
  const cli = new URL("./index.mjs", import.meta.url).href;
  const result = await exec(process.execPath, ["--input-type=module", "-e", `
    const before = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
    const m = await import(${JSON.stringify(source)});
    await import(${JSON.stringify(cli)});
    if (typeof m.runSdkConsumer !== 'function'
      || JSON.stringify(before) !== JSON.stringify(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)))) process.exit(1);`], {
    cwd: root, env: { PATH: process.env.PATH },
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(await fs.readdir(root), []);
});

test("real entry audit accepts all public targets and the exact local dependency closure", () => {
  const result = auditSdkArchiveEntries(entries(["fixtures/golden.json"]), manifest({
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./fixtures/golden.json": "./fixtures/golden.json" },
    dependencies: { "@ling-stack/dependency": "0.0.0" },
  }), expected, closure);
  assert.ok(result.files.includes("fixtures/golden.json"));
  assert.equal(result.dependencies[0].version, "0.0.0");
  assert.equal(result.exports.find((entry) => entry.target.endsWith("golden.json")).files.length, 1);
});

test("export audit covers wildcard declaration and runtime target files", () => {
  const result = auditSdkArchiveEntries(entries(["dist/catalogs/en-US.js", "dist/catalogs/en-US.d.ts"]), manifest({
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./catalogs/*": { types: "./dist/catalogs/*.d.ts", default: "./dist/catalogs/*.js" } },
  }), expected, []);
  assert.equal(result.exports.find((entry) => entry.target.endsWith("/*.js")).files[0], "dist/catalogs/en-US.js");
  assert.throws(() => auditSdkArchiveEntries(entries(), manifest({ exports: { "./catalogs/*": "./dist/catalogs/*.js" } }), expected, []), { code: "export_file_missing" });
});

test("archive audit rejects missing outputs, identity mismatch and non-portable dependencies", () => {
  assert.throws(() => auditSdkArchiveEntries(entries().filter((entry) => !entry.path.endsWith(".d.ts")), manifest(), expected, []), { code: "export_file_missing" });
  assert.throws(() => auditSdkArchiveEntries(entries(), manifest({ version: "0.0.1" }), expected, []), { code: "archive_identity_mismatch" });
  assert.throws(() => auditSdkArchiveEntries(entries(), manifest({ type: "commonjs" }), expected, []), { code: "archive_identity_mismatch" });
  for (const specifier of ["workspace:*", "link:../dep", "file:../dep", "https://registry.invalid/dep.tgz", "../dep", "/tmp/dep"]) {
    assert.throws(() => auditSdkArchiveEntries(entries(), manifest({ dependencies: { "@ling-stack/dependency": specifier } }), expected, closure), { code: "dependency_not_portable" });
  }
  assert.throws(() => auditSdkArchiveEntries(entries(), manifest({ dependencies: { "@ling-stack/missing": "0.0.0" } }), expected, closure), { code: "dependency_closure_missing" });
  assert.throws(() => auditSdkArchiveEntries(entries(), manifest({ peerDependencies: { "@ling-stack/dependency": "^0.0.0" } }), expected, closure), { code: "dependency_version_unverified" });
});

test("archive paths reject traversal, drive paths, duplicate entries, links and special files", () => {
  for (const unsafe of ["other/package.json", "package/../escape", "package/dist/../../escape", "package/C:/escape", "package/dist\\escape", "package//escape", "package/./escape"]) {
    assert.throws(() => auditSdkArchiveEntries([...entries(), { path: unsafe, type: "File" }], manifest(), expected, []), { code: "archive_path_invalid" });
  }
  assert.throws(() => auditSdkArchiveEntries([...entries(), entries()[0]], manifest(), expected, []), { code: "archive_duplicate" });
  for (const type of ["SymbolicLink", "Link", "CharacterDevice", "FIFO"]) {
    assert.throws(() => auditSdkArchiveEntries([...entries(), { path: "package/unsafe", type }], manifest(), expected, []), { code: "archive_link_or_special" });
  }
  for (const target of ["../outside.js", "./../outside.js", "./dist/../../outside.js", "./C:/escape.js", "file:///outside.js", "./dist\\index.js"]) {
    assert.throws(() => auditSdkArchiveEntries(entries(), manifest({ exports: { ".": target } }), expected, []));
  }
});

test("tar inspector reads the actual manifest and file byte digests, without extracting", async (t) => {
  const root = await temporary(t);
  const producer = path.join(root, "producer");
  await fs.mkdir(path.join(producer, "package", "dist"), { recursive: true });
  await fs.writeFile(path.join(producer, "package", "package.json"), JSON.stringify(manifest()));
  await fs.writeFile(path.join(producer, "package", "dist", "index.js"), "export const fixture = true;\n");
  await fs.writeFile(path.join(producer, "package", "dist", "index.d.ts"), "export declare const fixture = true;\n");
  const tar = createRequire(path.join(repoRoot, "package.json"))("tar");
  const archive = path.join(root, "fixture.tgz");
  await tar.c({ gzip: true, file: archive, cwd: producer }, ["package"]);
  const result = await inspectSdkTarball(archive, expected, [], tar);
  assert.equal(result.sha256, sha(await fs.readFile(archive)));
  assert.equal(result.manifest.name, expected.name);
  const js = result.entries.find((entry) => entry.path === "package/dist/index.js");
  assert.equal(js.sha256, sha("export const fixture = true;\n"));
  assert.equal(result.files.includes("dist/index.d.ts"), true);
  assert.deepEqual((await fs.readdir(root)).sort(), ["fixture.tgz", "producer"]);
});

test("environment drops credentials, Node fallback/hooks and ambient npm settings", () => {
  const root = path.resolve(os.tmpdir(), "sdk-env-test");
  const env = sdkConsumerEnvironment(root, {
    PATH: "fixed-path", NODE_PATH: "workspace/node_modules", NODE_OPTIONS: "--import attacker.mjs",
    npm_config_registry: "https://registry.invalid", NPM_TOKEN: "not-a-real-token", OPENAI_API_KEY: "not-a-real-key",
    HOME: "old-home", LING_STACK_HOME: "old-ling-home", COREPACK_ENABLE_NETWORK: "1",
  });
  assert.equal(env.PATH, "fixed-path");
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "npm_config_registry", "NPM_TOKEN", "OPENAI_API_KEY"]) assert.equal(env[key], undefined);
  assert.equal(env.npm_config_offline, "true");
  assert.equal(env.npm_config_ignore_scripts, "true");
  assert.equal(env.COREPACK_ENABLE_NETWORK, "0");
  assert.equal(isWithin(root, env.HOME), true);
  assert.equal(isWithin(root, env.LING_STACK_HOME), true);
  assert.equal(isWithin(root, env.npm_config_cache), true);
});

test("type-resolution witnesses must include all four packages and stay outside the workspace", () => {
  const root = path.resolve(os.tmpdir(), "sdk-resolution-test");
  const consumer = path.join(root, "consumer");
  const tools = path.join(root, "toolchain");
  const files = SDK_PACKAGES.map((name) => path.join(consumer, "node_modules", name, "dist/index.d.ts"));
  files.push(path.join(consumer, "consumer.ts"), path.join(tools, "node_modules/typescript/lib/lib.es2022.d.ts"));
  const result = validateTypeResolutionFiles(files.join("\n"), consumer, tools);
  assert.ok(result.includes("consumer/consumer.ts"));
  assert.throws(() => validateTypeResolutionFiles([...files, path.join(root, "workspace/src/index.ts")].join("\n"), consumer, tools), { code: "type_resolution_escape" });
  assert.throws(() => validateTypeResolutionFiles(files.slice(1).join("\n"), consumer, tools), { code: "type_resolution_missing_package" });
  assert.throws(() => validateTypeResolutionFiles([...files, path.join(consumer, "node_modules/@ling-stack/contracts/src/index.ts")].join("\n"), consumer, tools), { code: "type_source_fallback" });
  assert.throws(() => validateTypeResolutionFiles("", consumer, tools), { code: "type_resolution_empty" });
  assert.equal(isWithin(consumer, consumer + "-other"), false);
  assert.equal(isWithin(consumer, path.join(consumer, "..", "escaped")), false);
});

// Value: protects=producer packages publish only built outputs and the public JSON fixture;
// fails_when=an unintended source or test directory enters a producer allowlist;
// why_new=required inclusions alone allowed additional private files; seam=none;
// no_claim=archive bytes are checked separately by the real consumer smoke.
test("producer allowlists contain only declarations, runtime outputs and the contracts public JSON fixture", async () => {
  for (const name of SDK_PACKAGES) {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "packages", name.split("/")[1], "package.json"), "utf8"));
    assert.deepEqual(pkg.files, name === "@ling-stack/contracts"
      ? ["dist", "fixtures/channel-conversation-continuity-v2.json"] : ["dist"], name);
  }
});

test("fixture configs are standalone strict profiles with a deliberate required-field negative", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(fixtureRoot, "package.json"), "utf8"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.workspaces, undefined);
  assert.equal(packageJson.scripts, undefined);
  for (const profile of ["nodenext", "bundler"]) {
    for (const suffix of ["", ".negative"]) {
      const config = JSON.parse(await fs.readFile(path.join(fixtureRoot, `tsconfig.${profile}${suffix}.json`), "utf8"));
      assert.equal(config.extends, undefined);
      assert.equal(config.compilerOptions.paths, undefined);
      assert.equal(config.compilerOptions.strict, true);
      assert.equal(config.compilerOptions.noEmit, true);
      assert.equal(config.compilerOptions.skipLibCheck, false);
      assert.deepEqual(config.compilerOptions.types, ["node"]);
      assert.deepEqual(config.compilerOptions.typeRoots, ["../toolchain/node_modules/@types"]);
      assert.equal(config.compilerOptions.moduleResolution, profile === "nodenext" ? "NodeNext" : "Bundler");
      assert.deepEqual(config.files, [suffix ? "missing-resume.ts" : "consumer.ts"]);
    }
  }
  const negative = await fs.readFile(path.join(fixtureRoot, "missing-resume.ts"), "utf8");
  assert.match(negative, /: RunnerExtensionMetadata/);
  assert.doesNotMatch(negative, /resumeCapabilities|@ts-ignore|@ts-expect-error/);
  for (const file of ["consumer.ts", "runtime.mjs", "missing-resume.ts"]) {
    const content = await fs.readFile(path.join(fixtureRoot, file), "utf8");
    assert.doesNotMatch(content, /(?:from\s*|import\s*\()\s*["'][^"']*(?:packages\/|\.\.\/|\/src\/|\/dist\/)/);
  }
});

test("precondition failure produces an honest report, preserves locks and removes only owned temp state", async (t) => {
  const root = await temporary(t);
  const fakeRepo = path.join(root, "repo");
  const output = path.join(root, "artifacts");
  await fs.mkdir(fakeRepo);
  await fs.mkdir(path.join(fakeRepo, "fixtures/framework-assurance"), { recursive: true });
  await fs.cp(fixtureRoot, path.join(fakeRepo, "fixtures/framework-assurance/sdk-consumer"), { recursive: true });
  for (const name of SDK_PACKAGES) {
    const directory = path.join(fakeRepo, "packages", name.split("/")[1]);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.0.0", scripts: { prepack: "must-not-run" } }));
  }
  await fs.writeFile(path.join(fakeRepo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const before = sha(await fs.readFile(path.join(fakeRepo, "pnpm-lock.yaml")));
  const sentinel = path.join(root, "unrelated.txt");
  await fs.writeFile(sentinel, "preserve");
  const result = await runSdkConsumer({ repoRoot: fakeRepo, outputDir: output });
  assert.equal(result.passed, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "pack_lifecycle_present");
  assert.equal(result.commands.length, 0);
  assert.equal(result.rootLock.unchanged, true);
  assert.equal(result.isolation.ownedTemporaryDirectoryRemoved, true);
  assert.equal(result.matrix.every((cell) => cell.status === "not_run" && !cell.passed), true);
  assert.equal(sha(await fs.readFile(path.join(fakeRepo, "pnpm-lock.yaml"))), before);
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
  const saved = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
  assert.equal(saved.kind, "sdk_consumer");
  assert.equal(saved.reportPath, undefined);
  assert.equal(JSON.stringify(saved).includes(root), false);
});

test("missing offline TypeScript blocks the CLI before builds and retains cleanup evidence", {
  skip: process.platform === "win32" ? "POSIX executable fixtures" : false,
}, async (t) => {
  const root = await temporary(t);
  const fakeRepo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.mkdir(path.join(fakeRepo, "fixtures/framework-assurance"), { recursive: true });
  await fs.cp(fixtureRoot, path.join(fakeRepo, "fixtures/framework-assurance/sdk-consumer"), { recursive: true });
  await fs.writeFile(path.join(fakeRepo, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@10.0.0" }));
  await fs.writeFile(path.join(fakeRepo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const name of SDK_PACKAGES) {
    const directory = path.join(fakeRepo, "packages", name.split("/")[1]);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  }
  for (const [name, output] of [["git", "0".repeat(40)], ["npm", "11.0.0"], ["corepack", "10.0.0"]]) {
    await fs.writeFile(path.join(bin, name), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output + "\n")});\n`, { mode: 0o700 });
  }
  const source = new URL("./index.mjs", import.meta.url).href;
  const script = `const { createRequire } = await import('node:module');
    const require = createRequire(${JSON.stringify(path.join(fakeRepo, "package.json"))});
    try { require.resolve('typescript/package.json'); throw new Error('Fixture must not resolve TypeScript'); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    const { runCli } = await import(${JSON.stringify(source)});
    console.log(JSON.stringify(await runCli(['sdk-consumer', '--output', ${JSON.stringify(path.join(root, "artifacts"))}], { repoRoot: ${JSON.stringify(fakeRepo)} })));`;
  const run = await exec(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_PATH: "", PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) }, timeout: 15000,
  });
  const result = JSON.parse(run.stdout);
  assert.equal(result.exitCode, 2);
  const output = JSON.parse(result.text);
  const report = JSON.parse(await fs.readFile(output.files.consumerReport, "utf8"));
  assert.equal(report.status, "blocked");
  assert.equal(report.passed, false);
  assert.equal(report.error.code, "toolchain_missing");
  assert.deepEqual(report.commands.map((command) => command.label), ["source-commit", "npm-version", "pnpm-version"]);
  assert.equal(report.rootLock.unchanged, true);
  assert.equal(report.isolation.ownedTemporaryDirectoryRemoved, true);
  assert.equal(report.matrix.every((cell) => cell.status === "not_run" && !cell.passed), true);
});

// Value: protects=post-spawn watchdog failures stop owned descendants and retain a failed report;
// fails_when=timeouts or output limits leave commands running or skip cleanup and lock audits;
// why_new=the precondition test stops before spawning a command; seam=none;
// no_claim=controlled POSIX command boundary only, not real compiler failure or Windows termination.
test("command timeout and output limit stop owned processes and preserve failure evidence", {
  skip: process.platform === "win32" ? "POSIX process-group contract" : false,
}, async (t) => {
  const root = await temporary(t);
  const fakeRepo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.mkdir(path.join(fakeRepo, "fixtures/framework-assurance"), { recursive: true });
  await fs.cp(fixtureRoot, path.join(fakeRepo, "fixtures/framework-assurance/sdk-consumer"), { recursive: true });
  for (const name of SDK_PACKAGES) {
    const directory = path.join(fakeRepo, "packages", name.split("/")[1]);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  }
  const lock = path.join(fakeRepo, "pnpm-lock.yaml");
  await fs.writeFile(lock, "lockfileVersion: '9.0'\n");
  const before = sha(await fs.readFile(lock));
  const source = new URL("./sdk-consumer.mjs", import.meta.url).href;
  for (const mode of ["timeout", "output-limit"]) {
    const heartbeat = path.join(root, `${mode}-heartbeat`);
    const descendant = `const fs = require('node:fs');
      const tick = () => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'tick\\n');
      tick(); process.stdout.write('ready\\n'); setInterval(tick, 20);
      setTimeout(() => process.exit(0), 10000);`;
    const executable = `#!${process.execPath}
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => {
        process.stdout.write(JSON.stringify({ pid: process.pid, childPid: child.pid }) + '\\n');
        if (${JSON.stringify(mode)} === 'output-limit') process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 'x'));
      });
      setTimeout(() => process.exit(0), 10000);`;
    await fs.writeFile(path.join(bin, "git"), executable, { mode: 0o700 });
    const script = `const { runSdkConsumer } = await import(${JSON.stringify(source)});
      const result = await runSdkConsumer(${JSON.stringify({ repoRoot: fakeRepo, outputDir: path.join(root, mode), commandTimeoutMs: 1000 })});
      console.log(JSON.stringify(result));`;
    const run = await exec(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) }, timeout: 15000,
    });
    const result = JSON.parse(run.stdout);
    assert.equal(result.passed, false, mode);
    assert.equal(result.status, "failed", mode);
    const reason = mode === "timeout" ? "command_timeout" : "command_output_limit";
    assert.equal(result.error.code, reason);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].stopped, reason);
    assert.equal(result.commands[0].signal, "SIGKILL");
    assert.equal(result.rootLock.unchanged, true);
    assert.equal(result.isolation.ownedTemporaryDirectoryRemoved, true);
    assert.equal(result.matrix.every((cell) => cell.status === "not_run" && !cell.passed), true);
    const log = await fs.readFile(path.join(path.dirname(result.reportPath), result.commands[0].log), "utf8");
    const owned = JSON.parse(log.slice(0, log.indexOf("\n")));
    assert.ok(Number.isSafeInteger(owned.pid) && Number.isSafeInteger(owned.childPid));
    assert.throws(() => process.kill(owned.pid, 0), { code: "ESRCH" });
    const stoppedHeartbeat = await fs.readFile(heartbeat, "utf8");
    // gstack-timing-ok: a quiet window observes surviving descendants, not a performance bound.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await fs.readFile(heartbeat, "utf8"), stoppedHeartbeat, "descendant must not continue writing after failure");
    assert.equal(sha(await fs.readFile(lock)), before);
    const saved = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
    assert.equal(saved.error.code, reason);
    assert.equal(JSON.stringify(saved).includes(root), false);
  }
});

test("pre-cancelled SDK invocation starts no commands and still saves cleanup and lock evidence", async (t) => {
  const root = await temporary(t);
  const fakeRepo = path.join(root, "repo");
  await fs.mkdir(fakeRepo);
  await fs.writeFile(path.join(fakeRepo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const controller = new AbortController();
  controller.abort("private-cancellation-reason");
  const report = await runSdkConsumer({ repoRoot: fakeRepo, outputDir: path.join(root, "artifacts"), signal: controller.signal });
  assert.equal(report.status, "failed");
  assert.equal(report.passed, false);
  assert.equal(report.error.code, "command_cancelled");
  assert.deepEqual(report.commands, []);
  assert.equal(report.rootLock.unchanged, true);
  assert.equal(report.isolation.ownedTemporaryDirectoryRemoved, true);
  const saved = await fs.readFile(report.reportPath, "utf8");
  assert.doesNotMatch(saved, /private-cancellation-reason/);
  assert.equal(JSON.stringify(JSON.parse(saved)).includes(root), false);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`real SDK CLI ${signal} stops owned descendants, cleans temp state and writes a failed report`, {
    skip: process.platform === "win32" ? "POSIX process-group contract" : false,
    timeout: 15000,
  }, async (t) => {
    const root = await fs.realpath(await temporary(t));
    const fakeRepo = path.join(root, "repo");
    const bin = path.join(root, "bin");
    const temp = path.join(root, "tmp");
    const handshake = path.join(root, "handshake.json");
    const groupPidFile = path.join(root, "group-pid");
    const heartbeat = path.join(root, "heartbeat");
    await fs.mkdir(bin);
    await fs.mkdir(temp);
    await fs.mkdir(path.join(fakeRepo, "scripts"), { recursive: true });
    await fs.cp(import.meta.dirname, path.join(fakeRepo, "scripts/framework-assurance"), {
      recursive: true, filter: (file) => !file.endsWith(".test.mjs"),
    });
    await fs.mkdir(path.join(fakeRepo, "fixtures/framework-assurance"), { recursive: true });
    await fs.cp(fixtureRoot, path.join(fakeRepo, "fixtures/framework-assurance/sdk-consumer"), { recursive: true });
    for (const name of SDK_PACKAGES) {
      const directory = path.join(fakeRepo, "packages", name.split("/")[1]);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
    }
    const lock = path.join(fakeRepo, "pnpm-lock.yaml");
    await fs.writeFile(lock, "lockfileVersion: '9.0'\n");
    const before = sha(await fs.readFile(lock));
    const descendant = `const fs = require('node:fs');
      const tick = () => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'tick\\n');
      tick(); process.stdout.write('ready\\n'); setInterval(tick, 20);
      setTimeout(() => process.exit(0), 10000);`;
    await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      fs.writeFileSync(${JSON.stringify(groupPidFile)}, String(process.pid));
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => {
        const owned = { pid: process.pid, childPid: child.pid, tempRoot: require('node:path').dirname(process.env.HOME) };
        fs.writeFileSync(${JSON.stringify(handshake + ".tmp")}, JSON.stringify(owned));
        fs.renameSync(${JSON.stringify(handshake + ".tmp")}, ${JSON.stringify(handshake)});
        process.stdout.write(JSON.stringify(owned) + '\\n');
      });
      setTimeout(() => process.exit(0), 10000);`, { mode: 0o700 });
    const child = spawn(process.execPath, [path.join(fakeRepo, "scripts/framework-assurance/index.mjs"), "sdk-consumer", "--output", path.join(root, "artifacts")], {
      cwd: root,
      env: { PATH: [bin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter), TMPDIR: temp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let closed = false;
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, receivedSignal) => { closed = true; resolve({ code, signal: receivedSignal }); });
    });
    let owned;
    try {
      const deadline = Date.now() + 5000;
      while (!owned && Date.now() < deadline) {
        try { owned = JSON.parse(await fs.readFile(handshake, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!owned) {
          if (closed) {
            const summary = JSON.parse(Buffer.concat(stdout).toString());
            const report = JSON.parse(await fs.readFile(summary.files.consumerReport, "utf8"));
            assert.fail(`CLI stopped before the controlled command: ${JSON.stringify(report.error)}`);
          }
          await wait(20);
        }
      }
      assert.ok(owned, "controlled descendant must be ready before cancellation");
      assert.equal(isWithin(temp, owned.tempRoot), true);
      child.kill(signal);
      const exited = await Promise.race([completion, new Promise((_, reject) => {
        setTimeout(() => reject(new Error("CLI did not finish cancellation cleanup")), 5000).unref();
      })]);
      assert.equal(exited.signal, null);
      assert.equal(exited.code, signal === "SIGINT" ? 130 : 143);
      assert.equal(Buffer.concat(stderr).toString(), "");
      const summary = JSON.parse(Buffer.concat(stdout).toString());
      const report = JSON.parse(await fs.readFile(summary.files.consumerReport, "utf8"));
      assert.equal(report.status, "failed");
      assert.equal(report.passed, false);
      assert.equal(report.error.code, "command_cancelled");
      assert.equal(report.cancellation.signal, signal);
      assert.equal(report.commands.length, 1, "no command starts after cancellation");
      assert.equal(report.commands[0].stopped, "command_cancelled");
      assert.equal(report.commands[0].signal, "SIGKILL");
      assert.equal(report.rootLock.unchanged, true);
      assert.equal(report.isolation.ownedTemporaryDirectoryRemoved, true);
      assert.equal(report.matrix.every((cell) => cell.status === "not_run" && !cell.passed), true);
      await assert.rejects(fs.access(owned.tempRoot), { code: "ENOENT" });
      assert.throws(() => process.kill(owned.pid, 0), { code: "ESRCH" });
      const stoppedHeartbeat = await fs.readFile(heartbeat, "utf8");
      // gstack-timing-ok: a quiet window observes surviving descendants, not a performance bound.
      await wait(150);
      assert.equal(await fs.readFile(heartbeat, "utf8"), stoppedHeartbeat);
      assert.equal(sha(await fs.readFile(lock)), before);
      const saved = JSON.parse(await fs.readFile(summary.files.result, "utf8"));
      assert.equal(saved.error.code, "command_cancelled");
      assert.equal(JSON.stringify(saved).includes(root), false);
    } finally {
      let groupPid = owned?.pid;
      if (!groupPid) {
        try { groupPid = Number(await fs.readFile(groupPidFile, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (Number.isSafeInteger(groupPid) && groupPid > 1) {
        try { process.kill(-groupPid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (!closed) { child.kill("SIGKILL"); await completion; }
    }
  });
}

test("invalid inputs and source/runtime/dependency output fail before starting any build", async (t) => {
  await assert.rejects(runSdkConsumer(), TypeError);
  await assert.rejects(runSdkConsumer({ repoRoot, outputDir: "unused", commandTimeoutMs: 0 }), TypeError);
  const root = await temporary(t);
  await assert.rejects(runSdkConsumer({ repoRoot: root, outputDir: path.join(root, "source-output") }), { code: "unsafe_output_directory" });
  for (const name of [".git", ".ling-stack", "node_modules"]) {
    await assert.rejects(runSdkConsumer({ repoRoot, outputDir: path.join(root, name) }), { code: "unsafe_output_directory" });
  }
  assert.deepEqual(await fs.readdir(root), []);
});

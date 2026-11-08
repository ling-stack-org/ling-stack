import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));
const guard = `import cp from 'node:child_process'; import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports,registerHooks} from 'node:module';
const deny=()=>{throw Error('unexpected side effect')}; globalThis.fetch=deny;
net.connect=deny; net.createConnection=deny; net.createServer=deny; http.request=deny; https.request=deny; http.get=deny; https.get=deny;
const original=cp.execFileSync; cp.execFileSync=(command,args,options)=>{if(command!=='git'||args[0]!=='cat-file'||args[1]!=='blob') return deny(); return original(command,args,options)};
cp.spawn=deny;cp.spawnSync=deny;cp.exec=deny;cp.execSync=deny;cp.execFile=deny;syncBuiltinESMExports();
registerHooks({resolve(specifier,context,next){if(specifier==='node:sqlite') return deny();return next(specifier,context)}});`;

test("CLI zero-side-effect preflight/calibration/report works from an unrelated cwd", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-assurance-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", LING_STACK_HOME: join(root, "runtime-never-created") };
  const run = args => spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, entry, ...args],
    { cwd: root, env, encoding: "utf8", timeout: 30000 });
  const first = run(["preflight", "--output", join(root, "preflight")]);
  assert.equal(first.status, 0, first.stderr);
  const second = run(["calibrate", "--output", join(root, "calibration")]);
  assert.equal(second.status, 0, second.stderr);
  const summary = JSON.parse(second.stdout);
  assert.equal(summary.passed, true);
  const calibration = JSON.parse(await readFile(summary.files.result, "utf8"));
  assert.equal(calibration.controls.length, 9);
  assert.equal(calibration.externalProviderCalls, 0);
  const third = run(["report", "--input", summary.files.observations, "--output", join(root, "report")]);
  assert.equal(third.status, 0, third.stderr);
  const report = JSON.parse(await readFile(JSON.parse(third.stdout).files.result, "utf8"));
  assert.equal(report.liveTaskPassed, 0); assert.equal(report.assessed, 6);
  const compare = run(["report", "--input", summary.files.observations, "--compare", summary.files.observations, "--output", join(root, "compare")]);
  assert.equal(compare.status, 0, compare.stderr);
  assert.equal(JSON.parse(await readFile(JSON.parse(compare.stdout).files.result, "utf8")).comparable, true);
  await assert.rejects(access(env.LING_STACK_HOME));
  await assert.rejects(access(join(root, ".ling-stack")));
});

for (const args of [[], ["unknown"], ["preflight", "extra"], ["preflight", "--unknown"], ["report"],
  ["preflight", "--input", "a.json"], ["report", "--input", "a.json", "--variable", "model"],
  ["report", "--input", "a.json", "--compare", "b.json", "--variable", "unsupported"]]) {
  test(`CLI invalid arguments return 2: ${JSON.stringify(args)}`, () => {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).code, "invalid_arguments");
  });
}

test("CLI help imports no SDK consumer or runtime and missing input errors do not disclose paths", () => {
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /No command calls a Provider/);
  const failure = spawnSync(process.execPath, [entry, "report", "--input", "/never-existing-private-user/result.json"], { encoding: "utf8" });
  assert.equal(failure.status, 2); assert.doesNotMatch(failure.stderr, /never-existing-private-user/);
});

for (const [status, passed, exitCode] of [["passed", true, 0], ["failed", false, 1], ["blocked", false, 2]]) {
  test(`SDK CLI ${status} keeps local report paths out of its saved report and returns ${exitCode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "ling-assurance-sdk-cli-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const reportPath = join(root, "local-report.json");
    await writeFile(join(root, "sdk-stub.mjs"), "export async function runSdkConsumer(){return JSON.parse(process.env.LING_ASSURANCE_SDK_STUB)}\n");
    await writeFile(join(root, "hook.mjs"), `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "./sdk-consumer.mjs") return { url: new URL("./sdk-stub.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
`);
    const child = spawnSync(process.execPath, ["--import", join(root, "hook.mjs"), entry, "sdk-consumer", "--output", root],
      { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "",
        LING_ASSURANCE_SDK_STUB: JSON.stringify({ schemaVersion: 1, kind: "sdk_consumer", status, passed, reportPath }) } });
    assert.equal(child.status, exitCode, child.stderr);
    const summary = JSON.parse(child.stdout);
    assert.equal(summary.files.consumerReport, reportPath);
    const saved = await readFile(summary.files.result, "utf8");
    assert.equal(JSON.parse(saved).passed, passed);
    assert.equal(JSON.parse(saved).reportPath, undefined);
    assert.ok(!saved.includes(root));
  });
}

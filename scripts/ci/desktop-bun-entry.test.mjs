import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activatePackagedBrowseEntrypoint } from "../gstack/packaged-browse-build.mjs";

const bun = process.env.LING_BUN_ENTRY_PROBE_BINARY;
const guard = `if (import.meta.main) {
  main().catch((err) => {
    console.error(\`[browse] \${err.message}\`);
    process.exit(1);
  });
}`;

test("packaged CLI activation requires the exact unique upstream entry at the end", () => {
  const source = `// fixture\nasync function main() {}\n${guard}\n`;
  assert.match(activatePackagedBrowseEntrypoint(source), /await main\(\)\.catch/);
  for (const changed of [source.replace("main().catch", "other().catch"), source + "export {};",
    source + guard, source.replace("process.exit(1)", "process.exit(2)")]) {
    assert.throws(() => activatePackagedBrowseEntrypoint(changed), /upstream_entry_changed/);
  }
});

test("native packaged browser entry runs async startup and preserves failure handling", { skip: !bun }, async t => {
  assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(), "1.4.4");
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-bun-entry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = join(root, "build.mjs");
  await writeFile(build, `import {readFile} from 'node:fs/promises';
import {activatePackagedBrowseEntrypoint} from ${JSON.stringify(new URL("../gstack/packaged-browse-build.mjs", import.meta.url).href)};
const [source,output,activate]=process.argv.slice(2);
const result=await Bun.build({entrypoints:[source],target:'bun',metafile:true,
  compile:{outfile:output,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},
  plugins:[{name:'entry-probe',setup(build){build.onLoad({filter:/entry\\.ts$/},async args=>({
    contents:activate==='yes'?activatePackagedBrowseEntrypoint(await readFile(args.path,'utf8')):await readFile(args.path,'utf8'),loader:'ts'}));}}]});
if(!result.success)throw new Error(result.logs.map(String).join('\\n'));`);
  const results = [];
  for (const [name, activate] of [["upstream-control", false], ["packaged", true]]) {
    const directory = join(root, name);
    await mkdir(directory);
    const entry = join(directory, "entry.ts"), output = join(directory, process.platform === "win32" ? "entry.exe" : "entry");
    const marker = join(directory, "started.json"), dependencyMarker = join(directory, "dependency-ran");
    await writeFile(join(directory, "dependency.ts"), `import {writeFileSync} from 'node:fs';
export const value='dependency-loaded';
if(import.meta.main)writeFileSync(process.env.DEPENDENCY_MARKER,'unexpected dependency entry');`);
    await writeFile(entry, `import {realpath,writeFile} from 'node:fs/promises';
import {value} from './dependency';
console.log(JSON.stringify({stage:'entry',main:import.meta.main,value}));
async function main(){
  console.log('MAIN_STARTED');
  await realpath(process.cwd());
  if(process.argv[2]==='fail')throw new Error('startup fixture rejected');
  await writeFile(process.argv[3],JSON.stringify({started:true}));
  console.log('STARTUP_COMPLETED');
}
${guard}`);
    execFileSync(bun, ["--no-env-file", "--no-install", build, entry, output, activate ? "yes" : "no"],
      { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    const env = { ...process.env, DEPENDENCY_MARKER: dependencyMarker };
    const result = spawnSync(output, ["status", marker], { cwd: directory, env, encoding: "utf8", timeout: 15_000 });
    const state = await readFile(marker, "utf8").then(JSON.parse, error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    results.push({ name, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, state });
    assert.equal(result.status, 0, result.stderr);
    if (activate || process.platform !== "win32") {
      assert.deepEqual(state, { started: true }, `${name}: ${result.stdout}`);
      assert.match(result.stdout, /MAIN_STARTED\nSTARTUP_COMPLETED/);
    }
    if (activate) {
      const failure = spawnSync(output, ["fail", marker], { cwd: directory, env, encoding: "utf8", timeout: 15_000 });
      assert.equal(failure.status, 1, failure.stdout + failure.stderr);
      assert.match(failure.stderr, /\[browse\] startup fixture rejected/);
      assert.doesNotMatch(failure.stdout, /STARTUP_COMPLETED/);
    }
    await assert.rejects(readFile(dependencyMarker), { code: "ENOENT" });
  }
  t.diagnostic(JSON.stringify({ platform: process.platform, results }));
});

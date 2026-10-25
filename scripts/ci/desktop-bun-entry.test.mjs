import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const bun = process.env.LING_BUN_ENTRY_PROBE_BINARY;

test("native compiled browser entry keeps asynchronous startup alive", { skip: !bun }, async t => {
  assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(), "1.4.4");
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-bun-entry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = join(root, "build.mjs");
  await writeFile(build, `import {readFile} from 'node:fs/promises';
const [source,output,plugin]=process.argv.slice(2);
const result=await Bun.build({entrypoints:[source],target:'bun',metafile:true,
  compile:{outfile:output,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},
  plugins:plugin==='yes'?[{name:'entry-probe',setup(build){build.onLoad({filter:/entry\\.ts$/},async args=>({
    contents:'const injected=true;\\n'+await readFile(args.path,'utf8'),loader:'ts'}));}}]:[]});
if(!result.success)throw new Error(result.logs.map(String).join('\\n'));`);
  const results = [];
  for (const [name, plugin, awaited] of [["plain", false, false], ["plugin", true, false], ["awaited", true, true]]) {
    const directory = join(root, name);
    await mkdir(directory);
    const entry = join(directory, "entry.ts"), output = join(directory, process.platform === "win32" ? "entry.exe" : "entry");
    const marker = join(directory, "started.json");
    await writeFile(entry, `import {realpath,writeFile} from 'node:fs/promises';
console.log(JSON.stringify({stage:'entry',main:import.meta.main,argv:process.argv.slice(2)}));
async function main(){
  console.log('MAIN_STARTED');
  await realpath(process.cwd());
  await writeFile(process.argv[3],JSON.stringify({started:true}));
  console.log('STARTUP_COMPLETED');
}
if(import.meta.main){${awaited ? "await main();" : "main().catch(error=>{console.error(error);process.exitCode=1});"}}`);
    execFileSync(bun, ["--no-env-file", "--no-install", build, entry, output, plugin ? "yes" : "no"],
      { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    const result = spawnSync(output, ["status", marker], { cwd: directory, encoding: "utf8", timeout: 15_000 });
    const state = await readFile(marker, "utf8").then(JSON.parse, error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    results.push({ name, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, state });
  }
  t.diagnostic(JSON.stringify({ platform: process.platform, results }));
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.state, { started: true }, `${result.name}: ${result.stdout}`);
  }
});

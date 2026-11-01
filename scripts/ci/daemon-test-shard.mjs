import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestIsolation, runNodeTestFiles, runTestShard } from "./node-test-shard.mjs";
import { testSuites } from "./test-shard-plan.mjs";

export { assignTestShards, estimateTestWeight } from "./test-shard-plan.mjs";
export { createTestIsolation as createDaemonShardIsolation };

export async function discoverDaemonTestFiles(testDirectory = join(testSuites.daemon.cwd, "test")) {
  return (await readdir(testDirectory)).filter(file => file.endsWith(".test.mjs") && !testSuites.daemon.excluded.includes(file))
    .sort().map(file => `test/${file}`);
}

export function runDaemonTestFiles(files, options) {
  return runNodeTestFiles(files, { ...testSuites.daemon, suite: "daemon", ...options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runTestShard("daemon", process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 2; }
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/index.js");

test("version reports the shared product and daemon protocol versions", async () => {
  const human = await execFileAsync(process.execPath, [cliPath, "version"], { encoding: "utf8" });
  assert.equal(human.stdout.trim(), "Ling Stack 0.3.0 (daemon protocol 1)");

  const json = await execFileAsync(process.execPath, [cliPath, "--json", "version"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(json.stdout), { productVersion: "0.3.0", daemonProtocolVersion: 1 });
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import test from "node:test";
import { LING_DAEMON_PROTOCOL_VERSION } from "@ling-stack/contracts";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/index.js");

test("version reports the shared product and daemon protocol versions", async () => {
  const productVersion = (await readFile(new URL("../../../VERSION", import.meta.url), "utf8")).trim();
  const human = await execFileAsync(process.execPath, [cliPath, "version"], { encoding: "utf8" });
  assert.equal(human.stdout.trim(), `Ling Stack ${productVersion} (daemon protocol ${LING_DAEMON_PROTOCOL_VERSION})`);

  const json = await execFileAsync(process.execPath, [cliPath, "--json", "version"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(json.stdout), { productVersion, daemonProtocolVersion: LING_DAEMON_PROTOCOL_VERSION });
});

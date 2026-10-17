import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

const root = process.env.LING_GSTACK_RESOURCE_STAGE ? resolve(process.env.LING_GSTACK_RESOURCE_STAGE) : undefined;
test("real materialized package commands launch without an ambient Node installation", {
  skip: !root && "Set LING_GSTACK_RESOURCE_STAGE to an unpublished, materialized resource stage",
}, async (t) => {
  const runtime = join(root, "runtime");
  const record = JSON.parse(await readFile(join(root, "command-link-materialization.json"), "utf8"));
  assert.equal(record.deliveryStage, "resource-staging");
  assert.equal(record.packageAcceptance, "pending");
  assert.equal(record.links.length, 30);
  for (const link of record.links) {
    const path = join(runtime, link.path);
    assert.equal((await lstat(path)).isSymbolicLink(), false);
    assert.equal(`sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`, link.checksum);
  }
  const home = await mkdtemp(join(tmpdir(), "ling-gstack-materialized-smoke-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = (command, args) => {
    const result = spawnSync(join(runtime, command), args, {
      cwd: home, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home },
      encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  const browser = run("node_modules/.bin/playwright", ["--version"]);
  assert.equal(browser.status, 0);
  assert.match(browser.stdout, /^Version 1\.62\.1/);
  const image = join(home, "image.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6cAAAAASUVORK5CYII=", "base64"));
  const dimensions = run("node_modules/.bin/image-size", [image]);
  assert.equal(dimensions.status, 0);
  assert.match(stripVTControlCharacters(dimensions.stdout), /1x1/);
  const bad = Buffer.alloc(16); bad.write("icns"); bad.writeUInt32BE(16, 4); bad.write("ic07", 8);
  const malformed = join(home, "malformed.icns");
  await writeFile(malformed, bad);
  const invalid = run("node_modules/.bin/image-size", [malformed]);
  // The upstream CLI prints parser failures but exits zero; host adapters must
  // not classify this as successful image generation from the exit code alone.
  assert.match(invalid.stderr, /Invalid ICNS image entry length/);
  assert.doesNotMatch(stripVTControlCharacters(invalid.stdout), /\d+x\d+/);
});

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishStagedDirectory } from "./publish-staged-directory.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-staged-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate"), output = join(root, "output with 'quotes'; $literal [data]");
  await mkdir(candidate);
  await writeFile(join(candidate, "receipt.json"), "sealed candidate bytes");
  return { candidate, output };
}

test("the native directory rename publishes the complete candidate into a vacant destination", async t => {
  const f = await fixture(t);
  await publishStagedDirectory(f.candidate, f.output);
  assert.equal(await readFile(join(f.output, "receipt.json"), "utf8"), "sealed candidate bytes");
  await assert.rejects(lstat(f.candidate), { code: "ENOENT" });
});

for (const kind of ["file", "empty directory", "nonempty directory"]) {
  test(`publication preserves an existing ${kind} and the unpublished candidate`, async t => {
    const f = await fixture(t);
    if (kind === "file") await writeFile(f.output, "unrelated output");
    else {
      await mkdir(f.output);
      if (kind === "nonempty directory") await writeFile(join(f.output, "unrelated.txt"), "unrelated output");
    }
    const before = await lstat(f.output);
    await assert.rejects(publishStagedDirectory(f.candidate, f.output));
    const after = await lstat(f.output);
    assert.equal(after.ino, before.ino);
    assert.equal(await readFile(join(f.candidate, "receipt.json"), "utf8"), "sealed candidate bytes");
    if (kind !== "empty directory") {
      assert.equal(await readFile(kind === "file" ? f.output : join(f.output, "unrelated.txt"), "utf8"), "unrelated output");
    }
  });
}

test("a failed rename removes only its own empty reservation", async t => {
  const f = await fixture(t);
  await rm(f.candidate, { recursive: true });
  await assert.rejects(publishStagedDirectory(f.candidate, f.output));
  await assert.rejects(lstat(f.output), { code: "ENOENT" });
});

test("concurrent publishers choose one complete generation and preserve every losing candidate", async t => {
  const f = await fixture(t), candidates = [];
  for (let index = 0; index < 8; index++) {
    const path = join(f.candidate, `generation-${index}`);
    await mkdir(path);
    await writeFile(join(path, "receipt.json"), `generation-${index}`);
    candidates.push(path);
  }
  const results = await Promise.allSettled(candidates.map(path => publishStagedDirectory(path, f.output)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = results.findIndex(result => result.status === "fulfilled");
  assert.equal(await readFile(join(f.output, "receipt.json"), "utf8"), `generation-${winner}`);
  for (const [index, path] of candidates.entries()) {
    if (index === winner) await assert.rejects(lstat(path), { code: "ENOENT" });
    else assert.equal(await readFile(join(path, "receipt.json"), "utf8"), `generation-${index}`);
  }
});

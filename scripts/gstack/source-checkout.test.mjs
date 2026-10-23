import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const adaptationInputs = ["render-upstream.ts", "build-source-bundle.mjs", "upstream-lock.json"];

test("a Windows-style Git checkout retains the exact reviewed producer bytes and adaptation identity", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "gstack-source-checkout-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = join(temporary, "repository"), output = join(temporary, "checkout");
  const inputDirectory = join(repository, "scripts/gstack");
  await mkdir(inputDirectory, { recursive: true }); await mkdir(output);
  for (const name of [".gitattributes", ...adaptationInputs]) await copyFile(join(scripts, name), join(inputDirectory, name));
  await copyFile(join(scripts, "../../.gitattributes"), join(repository, ".gitattributes"));
  await mkdir(join(repository, "patches"));
  const patchPath = "patches/sprintf-js@1.1.3.patch";
  await copyFile(join(scripts, "../..", patchPath), join(repository, patchPath));
  const git = args => execFileSync("git", ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args], {
    cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  git(["init", "--quiet"]); git(["add", "."]);
  // checkout-index performs Git's real checkout conversion without commits,
  // network access, or mutating the caller's Git/global configuration.
  git(["checkout-index", "--all", `--prefix=${output.replaceAll("\\", "/")}/`]);
  const checkedOut = [];
  for (const name of adaptationInputs) {
    const expected = await readFile(join(scripts, name)), actual = await readFile(join(output, "scripts/gstack", name));
    assert.ok(actual.equals(expected), `${name}: runner autocrlf must not alter an authenticated producer input`);
    assert.ok(!actual.includes(Buffer.from("\r\n")), name);
    checkedOut.push(actual);
  }
  const reviewed = JSON.parse(await readFile(join(scripts, "reviewed-source-bundle.json")));
  assert.equal(`ling-${createHash("sha256").update(Buffer.concat(checkedOut)).digest("hex")}`, reviewed.adaptationRevision);
  assert.deepEqual(await readFile(join(output, patchPath)), await readFile(join(scripts, "../..", patchPath)),
    "the security patch must retain LF bytes so git apply can match the SHA-verified npm source");
});

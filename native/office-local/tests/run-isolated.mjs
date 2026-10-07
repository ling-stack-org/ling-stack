import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceDigests } from "../scripts/build.mjs";

/** Runs only this primitive's tests; never invokes a project/module/runtime build. */
const [binaryInput, outputInput, suite = "all"] = process.argv.slice(2);
assert.ok([4, 5].includes(process.argv.length), "usage: run-isolated.mjs /absolute/office-local.node /absolute/fresh-evidence-dir [publication|legacy|all]");
assert.ok(["publication", "legacy", "all"].includes(suite));
assert.ok(isAbsolute(binaryInput) && isAbsolute(outputInput));
const binary = realpathSync(binaryInput), output = resolve(outputInput);
const buildRoot = fileURLToPath(new URL(".", "file://" + binary));
const evidence = JSON.parse(readFileSync(join(buildRoot, "build-evidence.json"), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(readFileSync(binary)), evidence.binary.sha256);
assert.ok(lstatSync(evidence.nativeLifetimeTest.path).isFile());
assert.equal(sha256(readFileSync(evidence.nativeLifetimeTest.path)), evidence.nativeLifetimeTest.sha256);
assert.equal(sha256(readFileSync(evidence.nativeBudgetInjectedTest.path)), evidence.nativeBudgetInjectedTest.sha256);
assert.equal(sha256(readFileSync(evidence.nativePublicationTest.path)), evidence.nativePublicationTest.sha256);
mkdirSync(output, { mode: 0o700 });
const before = sourceDigests();
assert.deepEqual(before, evidence.sourceSha256, "current primitive inputs do not match the explicitly built binary");
writeFileSync(join(output, "source.before.sha256.json"), JSON.stringify(before, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const test = fileURLToPath(new URL("primitive.test.mjs", import.meta.url));
const readbackTest = fileURLToPath(new URL("readback.test.mjs", import.meta.url));
const publicationTest = fileURLToPath(new URL("publication.test.mjs", import.meta.url));
const env = { ...process.env, OFFICE_LOCAL_ADDON: binary, OFFICE_LOCAL_TEST_OUTPUT: output,
  OFFICE_LOCAL_LIFETIME_TEST: evidence.nativeLifetimeTest.path, OFFICE_LOCAL_BUDGET_INJECTED_TEST: evidence.nativeBudgetInjectedTest.path,
  OFFICE_LOCAL_PUBLICATION_TEST: evidence.nativePublicationTest.path };
for (const name of ["NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD"]) delete env[name];
const argv = ["--test", "--test-concurrency=1", ...(suite === "publication" ? [publicationTest]
  : suite === "legacy" ? [test, readbackTest] : [test, readbackTest, publicationTest])];
const result = spawnSync(process.execPath, argv, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
writeFileSync(join(output, "tests.actual.log"), (result.stdout ?? "") + (result.stderr ?? ""), { flag: "wx", mode: 0o600 });
const after = sourceDigests();
writeFileSync(join(output, "source.after.sha256.json"), JSON.stringify(after, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const summary = { node: process.execPath, argv, addonSha256: evidence.binary.sha256, nativeLifetimeTestSha256: evidence.nativeLifetimeTest.sha256,
  status: result.status, signal: result.signal ?? null, error: result.error?.message ?? null, fingerprintsEqual: JSON.stringify(before) === JSON.stringify(after),
  nativeBudgetInjectedTestSha256: evidence.nativeBudgetInjectedTest.sha256,
  nativePublicationTestSha256: evidence.nativePublicationTest.sha256, suite,
  fixtureResidue: readdirSync(output).filter(name => name.startsWith("fixture-")),
  protectedStageVerified: false, coreSafe: false, packaged: false,
  scope: "Dedicated local primitive and disposable confined actor tests; not Core/Host scope binding or distributed app verification" };
writeFileSync(join(output, "tests-evidence.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (result.error || result.signal || result.status !== 0 || !summary.fingerprintsEqual || summary.fixtureResidue.length !== 0) process.exitCode = 1;

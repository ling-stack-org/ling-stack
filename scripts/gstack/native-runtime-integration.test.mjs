import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertNativeTarget, buildEnvironment } from "./build-native-runtime.mjs";

const nativeRoot = process.env.LING_GSTACK_NATIVE_CANDIDATE ? resolve(process.env.LING_GSTACK_NATIVE_CANDIDATE) : undefined;
const checksum = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const reviewed = JSON.parse(await readFile(new URL("./reviewed-source-bundle.json", import.meta.url), "utf8"));

test("real native prerequisites retain input provenance, target binaries and functional CLI outputs", {
  skip: !nativeRoot && "Set LING_GSTACK_NATIVE_CANDIDATE to the newly built native dependency candidate",
}, async (t) => {
  const record = JSON.parse(await readFile(join(nativeRoot, "native-build.json"), "utf8"));
  assert.equal(record.deliveryStage, "native-dependencies");
  assert.equal(record.hostAcceptance, "pending");
  assert.equal(record.packageAcceptance, "pending");
  assert.deepEqual(record.target, { platform: process.platform, arch: process.arch });
  assert.equal(record.sourceManifestChecksum, reviewed.manifestChecksum);
  const scriptRoot = dirname(fileURLToPath(import.meta.url));
  const inputs = Buffer.concat(await Promise.all([
    "upstream-lock.json", "reviewed-source-bundle.json", "render-upstream.ts", "build-source-bundle.mjs", "build-native-runtime.mjs", "build-bun-native-resource.mjs", "build-cso-resource.mjs", "cso-build-compiler.mjs", "build-portable-resources.ts", "build-node-server-resource.mjs", "build-diagram-resource.mjs", "verify-shared-command-closure.mjs", "resource-workspace.mjs", "verify-security-sidecar-runtime.mjs", "security-sidecar-runtime-probe.mjs", "apply-runtime-security-patches.mjs", "patch-image-parsers.mjs", "patch-legacy-url-fallback.mjs", "../../patches/sprintf-js@1.1.3.patch", "../../package.json", "../../pnpm-lock.yaml",
    "build-managed-node-server.mjs", "build-testsavant-component.mjs", "packaged-browse-build.mjs",
    "packaged-browse-launch.mjs", "testsavant-gs-client.mjs", "testsavant-packaged-client.mjs", "testsavant-client.mjs",
    "testsavant-worker.mjs", "testsavant-runtime.mjs", "testsavant-model-pin.json", "testsavant-offline-guard.mjs",
  ].map((path) => readFile(join(scriptRoot, path)))));
  assert.equal(record.adaptationRevision, `ling-${createHash("sha256").update(inputs).digest("hex")}`);
  assert.equal(checksum(await readFile(join(nativeRoot, "source-manifest.json"))), reviewed.manifestChecksum);
  for (const component of record.components) {
    const bytes = await readFile(join(nativeRoot, component.path));
    assert.equal(bytes.length, component.sizeBytes);
    assert.equal(checksum(bytes), component.checksum);
    if (component.native) assertNativeTarget(bytes, record.target);
  }
  const runtime = join(nativeRoot, "runtime");
  if (process.platform === "darwin") {
    assert.ok(record.components.some(component => component.path === "runtime/bin/cso-build-provenance.json"));
    const proof = JSON.parse(await readFile(join(runtime, "bin/cso-build-provenance.json")));
    assert.equal(proof.compiledArtifactBinding, "repeated-unmodified-upstream-cso-build-and-signed-byte-identity");
    assert.equal(proof.sourceManifestChecksum, reviewed.manifestChecksum);
    for (const artifact of proof.artifacts) assert.equal(checksum(await readFile(join(runtime, artifact.path))), artifact.checksum);
  }
  assert.equal(checksum(await readFile(join(runtime, "bun.lock"))), record.dependencyLockChecksum);
  assert.equal(checksum(await readFile(join(runtime, "lib/diagram-render/bun.lock"))), record.diagramLockChecksum);
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const path of ["browse/dist/browse", "browse/dist/find-browse", "design/dist/design", "make-pdf/dist/pdf", "bin/gstack-global-discover"]) {
    const provenancePath = `runtime/${path}${suffix}.build-provenance.json`;
    assert.ok(record.components.some(component => component.path === provenancePath));
    const proof = JSON.parse(await readFile(join(nativeRoot, provenancePath)));
    assert.equal(proof.compiledArtifactBinding, "repeated-native-compilation-and-emitted-byte-identity");
    assert.equal(proof.sourceManifestChecksum, reviewed.manifestChecksum);
    assert.equal(checksum(await readFile(join(runtime, proof.artifact.path))), proof.artifact.checksum);
  }
  assert.ok(record.components.some(component => component.path === "runtime/browse/dist/node-server-build-provenance.json"));
  const nodeBuild = JSON.parse(await readFile(join(runtime, "browse/dist/node-server-build-provenance.json")));
  assert.equal(nodeBuild.compiledArtifactBinding, "repeated-compilation-and-emitted-byte-identity");
  assert.equal(nodeBuild.sourceManifestChecksum, reviewed.manifestChecksum);
  for (const artifact of nodeBuild.artifacts) assert.equal(checksum(await readFile(join(runtime, artifact.path))), artifact.checksum);
  assert.ok(record.components.some(component => component.path === "runtime/browse/dist/security-sidecar.js"));
  assert.ok(record.components.some(component => component.path === "runtime/browse/dist/security-sidecar-build-provenance.json"));
  const sidecarBuild = JSON.parse(await readFile(join(runtime, "browse/dist/security-sidecar-build-provenance.json")));
  assert.equal(sidecarBuild.compiledArtifactBinding, "repeated-compilation-and-emitted-byte-identity");
  assert.equal(sidecarBuild.sourceManifestChecksum, reviewed.manifestChecksum);
  assert.equal(sidecarBuild.runtimeResourceSelection, "pending");
  for (const artifact of sidecarBuild.artifacts) assert.equal(checksum(await readFile(join(runtime, artifact.path))), artifact.checksum);
  assert.ok(record.components.some(component => component.path === "runtime/browse/dist/security-sidecar-runtime-verification.json"));
  const securityRuntime = JSON.parse(await readFile(join(runtime, "browse/dist/security-sidecar-runtime-verification.json")));
  assert.equal(securityRuntime.releaseEligible, false);
  assert.equal(securityRuntime.modelDownloaded, false);
  assert.deepEqual(securityRuntime.observation.inference.Y, [1.25, -3.5]);
  assert.equal(securityRuntime.classifierModelInference, "pending");
  assert.ok(record.components.some(component => component.path === "runtime/lib/diagram-render/dist/diagram-build-provenance.json"));
  const diagramBuild = JSON.parse(await readFile(join(runtime, "lib/diagram-render/dist/diagram-build-provenance.json")));
  assert.equal(diagramBuild.compiledArtifactBinding, "repeated-upstream-assembly-and-emitted-byte-identity");
  assert.equal(diagramBuild.sourceManifestChecksum, reviewed.manifestChecksum);
  for (const artifact of diagramBuild.artifacts) assert.equal(checksum(await readFile(join(runtime, artifact.path))), artifact.checksum);
  assert.equal(record.securityPatches.length, 9);
  assert.equal(record.securityPatches.filter(patch => patch.package === "node-fetch").length, 4);
  const patch = record.securityPatches[0];
  assert.equal(patch.advisory, "GHSA-hp3w-g68c-fv3c");
  assert.equal(checksum(await readFile(join(runtime, patch.path))), patch.afterChecksum);
  assert.equal(checksum(await readFile(join(runtime, patch.patchPath))), patch.patchChecksum);
  for (const patch of record.securityPatches.slice(1)) {
    assert.equal(checksum(await readFile(join(runtime, patch.path))), patch.afterChecksum);
    assert.equal(checksum(await readFile(join(runtime, patch.patchPath))), patch.patchChecksum);
  }
  const bun = join(runtime, `tools/bun${suffix}`);
  const node = join(runtime, `tools/node${suffix}`);
  const work = await mkdtemp(join(tmpdir(), "ling-gstack-native-smoke-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const env = buildEnvironment({ bunPath: bun, nodePath: node, home: work, temporary: work });
  const run = (command, args) => execFileSync(command, args, { cwd: work, env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(run(bun, ["--version"]).trim(), record.bunVersion);
  assert.equal(run(node, ["--version"]).trim(), record.nodeVersion);
  assert.match(run(join(runtime, `browse/dist/browse${suffix}`), ["--help"]), /browse/i);
  assert.match(run(join(runtime, `design/dist/design${suffix}`), []), /design/i);
  assert.match(run(join(runtime, `bin/gstack-cso-launcher${suffix}`), ["--version"]), /\S/);
  run(node, ["--check", join(runtime, "browse/dist/server-node.mjs")]);
  run(node, ["--check", join(runtime, "browse/dist/security-sidecar.js")]);
  const markdown = join(work, "input.md");
  const html = join(work, "output.html");
  await writeFile(markdown, "# Native Runtime Acceptance\n\nComplete local rendering without remote model calls.\n");
  run(join(runtime, `make-pdf/dist/pdf${suffix}`), ["generate", markdown, html, "--to", "html", "--strict"]);
  const content = await readFile(html, "utf8");
  assert.match(content, /Native Runtime Acceptance/);
  assert.match(content, /<html/);
  const info = JSON.parse(await readFile(join(runtime, "lib/diagram-render/dist/BUILD_INFO.json"), "utf8"));
  assert.equal(checksum(await readFile(join(runtime, "lib/diagram-render/dist/diagram-render.html"))), `sha256:${info.sha256}`);
  // Native prerequisites are deliberately not accepted as an executable Ling bundle.
  await assert.rejects(readFile(join(nativeRoot, "manifest.json")), { code: "ENOENT" });
});

test("native generated resources do not embed temporary build roots", {
  skip: !nativeRoot && "Set LING_GSTACK_NATIVE_CANDIDATE to the newly built native dependency candidate",
}, async () => {
  const record = JSON.parse(await readFile(join(nativeRoot, "native-build.json"), "utf8"));
  for (const component of record.components) {
    const bytes = await readFile(join(nativeRoot, component.path));
    assert.equal(bytes.includes(Buffer.from(".gstack-native-stage-")), false, component.path);
  }
});

test("native dependency logger preserves Ling's bounded numeric precision fix", {
  skip: !nativeRoot && "Set LING_GSTACK_NATIVE_CANDIDATE to the newly built native dependency candidate",
}, () => {
  const dependencyRequire = createRequire(join(nativeRoot, "runtime/node_modules/roarr/package.json"));
  const { sprintf, vsprintf } = dependencyRequire("sprintf-js");
  for (const type of ["f", "e", "g"]) {
    for (const precision of ["101", "10000", "9".repeat(400)]) {
      const actual = sprintf(`%.${precision}${type}`, 1.25);
      assert.equal(actual, sprintf(`%.100${type}`, 1.25));
      assert.ok(actual.length < 110);
      assert.equal(vsprintf(`%.${precision}${type}`, [1.25]), actual);
    }
  }
  assert.equal(sprintf("%s %04d %.2f %.2e", "model", 7, 1.25, 1.25), "model 0007 1.25 1.25e+0");
});

test("native resources still execute after relocation without the build checkout or global gstack", {
  skip: !nativeRoot && "Set LING_GSTACK_NATIVE_CANDIDATE to the newly built native dependency candidate",
}, async (t) => {
  const work = await mkdtemp(join(tmpdir(), "ling-gstack-relocated-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const runtime = join(work, "application-resources/gstack");
  await cp(join(nativeRoot, "runtime"), runtime, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const home = join(work, "user-data");
  await mkdir(home);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const env = buildEnvironment({ bunPath: join(runtime, `tools/bun${suffix}`), nodePath: join(runtime, `tools/node${suffix}`), home, temporary: work });
  const run = (path, args) => execFileSync(join(runtime, path), args, { cwd: home, env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(run(`browse/dist/browse${suffix}`, ["--help"]), /browse/i);
  assert.match(run(`bin/gstack-cso-launcher${suffix}`, ["--version"]), /\S/);
  run(`tools/node${suffix}`, ["--check", join(runtime, "browse/dist/server-node.mjs")]);
  const markdown = join(home, "input.md");
  const document = join(home, "output.docx");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==", "base64");
  await writeFile(join(home, "image.png"), png);
  await writeFile(markdown, "# Relocated Runtime\n\nLocal image and document generation.\n\n![Local image](image.png)\n");
  run(`make-pdf/dist/pdf${suffix}`, ["generate", markdown, document, "--to", "docx", "--strict"]);
  const require = createRequire(join(runtime, "package.json"));
  const zip = await require("jszip").loadAsync(await readFile(document));
  assert.match(await zip.file("word/document.xml").async("string"), /Relocated Runtime/);
  assert.ok(Object.keys(zip.files).some((path) => /^word\/media\/.*\.png$/.test(path)));
});

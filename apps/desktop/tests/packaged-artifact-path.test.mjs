import test from "node:test";
import assert from "node:assert/strict";

import { resolvePackagedArtifactName } from "./packaged-artifact-path.mjs";

test("resolves the release artifact name from electron-builder metadata", () => {
  assert.equal(
    resolvePackagedArtifactName({
      artifactName: "Ling-Stack-${version}-macos-${arch}.${ext}",
      version: "0.1.2-alpha.1",
      arch: "arm64",
      ext: "zip",
    }),
    "Ling-Stack-0.1.2-alpha.1-macos-arm64.zip",
  );
});

test("rejects a builder template that was not fully resolved", () => {
  assert.throws(
    () => resolvePackagedArtifactName({
      artifactName: "Ling-Stack-${version}-macos-${arch}.${ext}",
      version: "",
      arch: "arm64",
      ext: "zip",
    }),
    /packaged_version_missing/,
  );
});

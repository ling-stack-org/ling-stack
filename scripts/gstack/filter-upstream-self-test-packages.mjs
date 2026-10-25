import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { filterReviewedGstackBuildPackages } from "./filter-reviewed-build-packages.mjs";

const reviewUrl = new URL("./reviewed-upstream-self-test-packages.json", import.meta.url);
const windowsReviewUrl = new URL("./reviewed-upstream-self-test-packages-win32-x64.json", import.meta.url);
export const REVIEWED_SELF_TEST_PACKAGE_CHECKSUM = `sha256:${createHash("sha256").update(await readFile(reviewUrl)).digest("hex")}`;
const windowsReviewChecksum = `sha256:${createHash("sha256").update(await readFile(windowsReviewUrl)).digest("hex")}`;
const classes = new Set(["comment-only", "self-test-path-data", "upstream-self-test", "upstream-dependency-metadata", "documentation"]);

export function filterGstackUpstreamSelfTestPackages({ reviewPath, expectedReviewChecksum, ...options }) {
  const windows = options.target?.platform === "win32" && options.target?.arch === "x64";
  return filterReviewedGstackBuildPackages({ ...options,
    reviewPath: reviewPath ?? (windows ? windowsReviewUrl : reviewUrl),
    expectedReviewChecksum: expectedReviewChecksum ?? (windows ? windowsReviewChecksum : REVIEWED_SELF_TEST_PACKAGE_CHECKSUM) }, {
    errorPrefix: "gstack_self_test_package", marker: "claude-agent-sdk", packageCount: 2,
    selectionScope: "reviewed-upstream-agent-sdk-self-test-packages",
    validReference: reference => classes.has(reference.classification),
    validPackage: (pkg, index, target) => pkg.version === "0.2.117" && pkg.name === (index === 0
      ? "@anthropic-ai/claude-agent-sdk" : `@anthropic-ai/claude-agent-sdk-${target.platform}-${target.arch}`),
    validMetadata: () => true,
  });
}

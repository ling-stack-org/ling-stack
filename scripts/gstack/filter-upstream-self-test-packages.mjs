import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { filterReviewedGstackBuildPackages } from "./filter-reviewed-build-packages.mjs";

const reviewUrl = new URL("./reviewed-upstream-self-test-packages.json", import.meta.url);
export const REVIEWED_SELF_TEST_PACKAGE_CHECKSUM = `sha256:${createHash("sha256").update(await readFile(reviewUrl)).digest("hex")}`;
const classes = new Set(["comment-only", "self-test-path-data", "upstream-self-test", "upstream-dependency-metadata", "documentation"]);

export function filterGstackUpstreamSelfTestPackages({ reviewPath = reviewUrl,
  expectedReviewChecksum = REVIEWED_SELF_TEST_PACKAGE_CHECKSUM, ...options }) {
  return filterReviewedGstackBuildPackages({ ...options, reviewPath, expectedReviewChecksum }, {
    errorPrefix: "gstack_self_test_package", marker: "claude-agent-sdk", packageCount: 2,
    selectionScope: "reviewed-upstream-agent-sdk-self-test-packages",
    validReference: reference => classes.has(reference.classification),
    validPackage: (pkg, index, target) => pkg.version === "0.2.117" && pkg.name === (index === 0
      ? "@anthropic-ai/claude-agent-sdk" : `@anthropic-ai/claude-agent-sdk-${target.platform}-${target.arch}`),
    validMetadata: () => true,
  });
}

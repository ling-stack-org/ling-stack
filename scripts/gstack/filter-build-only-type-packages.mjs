import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { filterReviewedGstackBuildPackages } from "./filter-reviewed-build-packages.mjs";

const reviewUrl = new URL("./reviewed-build-only-type-packages.json", import.meta.url);
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const REVIEWED_BUILD_ONLY_TYPE_PACKAGE_CHECKSUM = digest(await readFile(reviewUrl));
const runtimeFields = ["main", "module", "browser", "exports", "imports"];
const allowedResource = path => /^(?:package\.json|(?:README|CLAUDE)\.md|[^/]+\.d\.ts|ts7\.1\/[^/]+\.d\.ts|vendor\/.+\.d\.ts|docs\/.+\.mdx?)$/.test(path);

export function filterGstackBuildOnlyTypePackages({ reviewPath = reviewUrl,
  expectedReviewChecksum = REVIEWED_BUILD_ONLY_TYPE_PACKAGE_CHECKSUM, ...options }) {
  return filterReviewedGstackBuildPackages({ ...options, reviewPath, expectedReviewChecksum }, {
    errorPrefix: "gstack_type_package", marker: "bun-types", packageCount: 1,
    selectionScope: "reviewed-build-only-type-packages",
    validReference: reference => reference.path === "runtime/bun.lock" && reference.classification === "upstream-dependency-metadata",
    validPackage: pkg => pkg.name === "bun-types" && pkg.version === "1.4.2",
    validMetadata: metadata => metadata.types === "./index.d.ts" && runtimeFields.every(key => !Object.hasOwn(metadata, key)),
    validateResources(files, [pkg], fail) {
      const inventory = files.map(file => ({ path: file.path.slice(pkg.path.length + 1), sizeBytes: file.sizeBytes, checksum: file.checksum }))
        .sort((a, b) => a.path.localeCompare(b.path, "en"));
      if (inventory.some(file => !allowedResource(file.path))) fail("non_type_resource");
      if (inventory.length !== pkg.fileCount || inventory.reduce((n, file) => n + file.sizeBytes, 0) !== pkg.sizeBytes ||
        digest(JSON.stringify(inventory)) !== pkg.inventoryChecksum) fail("inventory_not_reviewed");
    },
  });
}

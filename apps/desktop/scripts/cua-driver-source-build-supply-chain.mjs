import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  sha256File,
  sha256Text,
} from "./cua-driver-source-build-lib.mjs";

export async function generateSupplyChainMetadata({
  cargoMetadata,
  lock,
  outputRoot,
  platform,
}) {
  const packages = [...cargoMetadata.packages].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"),
  );
  const created = new Date(lock.upstream.sourceDateEpoch * 1000).toISOString();
  const namespace = `https://ling-stack.dev/sbom/cua-driver/${lock.upstream.commit}/${lock.patchSet.sha256}/${platform}`;
  const spdxPackages = packages.map((pkg) => ({
    SPDXID: spdxId(pkg),
    name: pkg.name,
    versionInfo: pkg.version,
    downloadLocation: pkg.source?.replace(/^registry\+/u, "") ?? "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: pkg.license || "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: pkg.repository
      ? [
          {
            referenceCategory: "OTHER",
            referenceType: "vcs",
            referenceLocator: pkg.repository,
          },
        ]
      : [],
  }));
  const document = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `cua-driver-${lock.upstream.version}-${lock.distributionRevision}-${platform}`,
    documentNamespace: namespace,
    creationInfo: {
      created,
      creators: ["Tool: Ling deterministic Cua Driver source builder"],
    },
    packages: spdxPackages,
    relationships: spdxPackages.map((pkg) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: pkg.SPDXID,
    })),
  };
  await mkdir(outputRoot, { recursive: true });
  const sbomPath = join(outputRoot, "cua-driver.spdx.json");
  await writeFile(sbomPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const noticeLines = [
    "# Third-Party Notices for Cua Driver 0.8.3 (Ling build 1)",
    "",
    "Resolved from the locked Cargo graph. Package order is deterministic.",
    "",
    "| Package | Version | Declared license | Source |",
    "| --- | --- | --- | --- |",
    ...packages.map(
      (pkg) =>
        `| ${escapeMarkdown(pkg.name)} | ${escapeMarkdown(pkg.version)} | ${escapeMarkdown(pkg.license || "NOASSERTION")} | ${escapeMarkdown(pkg.repository || pkg.source || "NOASSERTION")} |`,
    ),
    "",
    "The upstream Cua Driver MIT license is reproduced in LICENSE.md.",
    "",
  ];
  const noticesPath = join(outputRoot, "THIRD_PARTY_NOTICES.md");
  await writeFile(noticesPath, noticeLines.join("\n"), "utf8");
  return {
    sbomPath,
    sbomSha256: await sha256File(sbomPath),
    noticesPath,
    noticesSha256: await sha256File(noticesPath),
  };
}

function spdxId(pkg) {
  const digest = sha256Text(`${pkg.name}@${pkg.version}:${pkg.source ?? "path"}`).slice(0, 16);
  return `SPDXRef-Package-${pkg.name.replace(/[^A-Za-z0-9.-]/gu, "-")}-${digest}`;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

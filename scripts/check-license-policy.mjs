import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "WTFPL OR ISC",
  "(BSD-3-Clause OR GPL-2.0)",
  "(MIT AND Zlib)",
  "(MIT OR Apache-2.0)",
  "(MIT OR CC0-1.0)",
  "(MIT OR GPL-3.0-or-later)",
  "(MPL-2.0 OR Apache-2.0)",
  "(WTFPL OR MIT)",
]);

const noticeRequiredLicenses = new Set([
  "Apache-2.0",
  "CC-BY-4.0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
]);

// Reviewed exceptions: upstream publishes the MIT license text but the npm
// metadata reports it in a form outside the allowed set. Each entry states
// where the license text can be verified.
const reviewedLicenseExceptions = new Map([
  ["chainsaw", "MIT/X11 — upstream https://github.com/dominictarr/chainsaw (MIT, shipped in source)"],
  ["buffers", "MIT — upstream https://github.com/dominictarr/buffers (MIT in README/source; npm metadata incomplete)"],
]);

const raw = execFileSync(
  "corepack",
  ["pnpm", "licenses", "list", "--json"],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
const report = JSON.parse(raw);
const failures = [];
const resolvedUnknown = [];
const packageVersions = new Set();

for (const [license, packages] of Object.entries(report)) {
  for (const dependency of packages) {
    for (const version of dependency.versions ?? []) {
      packageVersions.add(`${dependency.name}@${version}`);
    }

    if (allowedLicenses.has(license)) continue;
    if (license === "Unknown" && hasRecognizedMitLicense(dependency.paths ?? [])) {
      resolvedUnknown.push(dependency.name);
      continue;
    }
    if (reviewedLicenseExceptions.has(dependency.name)) {
      console.log(`Reviewed license exception applied: ${dependency.name} — ${reviewedLicenseExceptions.get(dependency.name)}`);
      continue;
    }
    failures.push(`${dependency.name}: ${license}`);
  }
}

if (failures.length > 0) {
  console.error("Dependency license policy failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const presentNoticeFamilies = [...noticeRequiredLicenses]
  .filter((license) => Object.hasOwn(report, license))
  .sort();

console.log(
  `Checked ${packageVersions.size} dependency versions across ${Object.keys(report).length} license families.`,
);
if (resolvedUnknown.length > 0) {
  console.log(`Resolved missing package metadata from bundled MIT license text: ${resolvedUnknown.sort().join(", ")}.`);
}
console.log(`Binary notice review families: ${presentNoticeFamilies.join(", ") || "none"}.`);

function hasRecognizedMitLicense(paths) {
  const candidates = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"];
  return paths.some((packagePath) => candidates.some((candidate) => {
    const licensePath = join(packagePath, candidate);
    if (!existsSync(licensePath)) return false;
    const text = readFileSync(licensePath, "utf8");
    return /MIT License|The MIT License \(MIT\)/i.test(text);
  }));
}

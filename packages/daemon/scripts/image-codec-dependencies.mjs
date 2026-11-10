import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Keep the compiled graph within the individually reviewed existing-policy choices. */
export async function verifyImageCodecDependencies({ metadata, activePackages, inventory, lock, notices, nativeRoot }) {
  const packages = new Map();
  for (const item of metadata.packages) {
    const key = `${item.name}@${item.version}`;
    const candidates = packages.get(key) ?? [];
    candidates.push(item);
    packages.set(key, candidates);
  }
  const reviewed = new Map(inventory.active.map(item => [`${item.name}@${item.version}`, item]));
  const actual = [];
  const keys = new Set(activePackages.map(item => `${item.name}@${item.version}`));
  keys.delete("ling-image-sanitizer@0.1.0");
  for (const key of keys) {
      const candidates = packages.get(key), review = reviewed.get(key);
      if (!candidates?.length) throw new Error("image_codec_dependency_graph_invalid");
      if (candidates.length !== 1) throw new Error(`image_codec_dependency_ambiguous:${key}`);
      const [item] = candidates;
      if (!review) throw new Error(`image_codec_dependency_unreviewed:${key}`);
      if (!["MIT", "BSD-3-Clause"].includes(review.selectedLicense)
        || item.license !== review.upstreamLicense
        || !item.license.split(/\s+OR\s+|\//u).includes(review.selectedLicense)) {
        throw new Error(`image_codec_dependency_license_changed:${key}`);
      }
      if (item.source === "registry+https://github.com/rust-lang/crates.io-index") {
        if (!lock.package.some(entry => entry.name === item.name && entry.version === item.version
          && entry.checksum === review.originalCrateSHA256)) throw new Error(`image_codec_dependency_checksum_changed:${key}`);
      } else if (item.name !== "jpeg-decoder" || resolve(item.manifest_path)
        !== resolve(nativeRoot, "vendor/jpeg-decoder/Cargo.toml")) {
        throw new Error(`image_codec_dependency_source_changed:${key}`);
      }
      const license = await readFile(join(dirname(item.manifest_path), basename(review.licensePath)));
      if (createHash("sha256").update(license).digest("hex") !== review.licenseSHA256
        || !notices.includes(license.toString("utf8").trim())) throw new Error(`image_codec_dependency_notice_changed:${key}`);
      actual.push({ name: item.name, version: item.version, selectedLicense: review.selectedLicense });
  }
  if (actual.length !== reviewed.size || reviewed.size !== inventory.active.length) throw new Error("image_codec_dependency_inventory_changed");
  return actual.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

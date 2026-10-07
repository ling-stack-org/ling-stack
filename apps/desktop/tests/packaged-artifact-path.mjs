const REQUIRED_TEMPLATES = ["${version}", "${arch}", "${ext}"];

/**
 * Resolves electron-builder's macOS artifactName using the package metadata
 * that produced the release. Keeping this pure makes the release naming
 * contract testable without launching Electron.
 */
export function resolvePackagedArtifactName({ artifactName, version, arch, ext }) {
  if (typeof artifactName !== "string" || artifactName.length === 0) {
    throw new TypeError("packaged_artifact_name_missing");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError("packaged_version_missing");
  }
  if (typeof arch !== "string" || arch.length === 0) {
    throw new TypeError("packaged_arch_missing");
  }
  if (typeof ext !== "string" || ext.length === 0) {
    throw new TypeError("packaged_extension_missing");
  }

  const resolved = artifactName
    .replaceAll("${version}", version)
    .replaceAll("${arch}", arch)
    .replaceAll("${ext}", ext);
  if (REQUIRED_TEMPLATES.some((template) => resolved.includes(template))) {
    throw new Error(`packaged_artifact_name_unresolved:${resolved}`);
  }
  return resolved;
}

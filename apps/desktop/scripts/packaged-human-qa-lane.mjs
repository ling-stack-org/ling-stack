/**
 * Select the one fixed, isolated Human QA identity. This is not an approval
 * issuer or caller-provided Builder config. All original publication, resource,
 * signature and final-artifact checks remain on the same awaited build path.
 *
 * @param {Record<string, any>} config Fresh original Builder configuration.
 * @param {Record<string, string | undefined>} environment Build environment.
 * @returns {Record<string, any>} Original config, or the fixed QA-only variant.
 */
export function selectPackagedOfficeBuildLane(config, environment) {
  if (!readPackagedOfficeHumanQaSelection(environment)) return config;
  if (config.appId !== "com.lingstack.desktop" || config.productName !== "Ling Stack") {
    throw new Error("packaged_human_qa_base_invalid");
  }
  return {
    ...config,
    appId: "com.lingstack.desktop.human-qa",
    productName: "Ling Stack Human QA",
    directories: { ...config.directories, output: "release/human-qa" },
    extraMetadata: {
      ...config.extraMetadata,
      // A package identity/scope marker, never proof of a human decision.
      lingHumanQaPackage: { schemaVersion: 1, purpose: "synthetic-human-evaluation", release: false },
    },
  };
}

/** Validate before any native/package side effects; presence is intentional. */
export function readPackagedOfficeHumanQaSelection(environment) {
  if (!Object.hasOwn(environment, "LING_DESKTOP_PACKAGE_HUMAN_QA")) return false;
  if (environment.LING_DESKTOP_PACKAGE_HUMAN_QA !== "1") {
    throw new Error("packaged_human_qa_lane_invalid");
  }
  return true;
}

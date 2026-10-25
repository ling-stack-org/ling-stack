/**
 * Select one of the fixed, isolated Human QA identities. This is not an approval
 * issuer or caller-provided Builder config. All original publication, resource,
 * signature and final-artifact checks remain on the same awaited build path.
 *
 * @param {Record<string, any>} config Fresh original Builder configuration.
 * @param {Record<string, string | undefined>} environment Build environment.
 * @returns {Record<string, any>} Original config, or the fixed QA-only variant.
 */
export function selectPackagedOfficeBuildLane(config, environment) {
  const lane = readPackagedOfficeBuildLane(environment);
  if (lane === "ordinary") return config;
  if (config.appId !== "com.lingstack.desktop" || config.productName !== "Ling Stack") {
    throw new Error("packaged_human_qa_base_invalid");
  }
  // The successor must never overwrite the App still owned by a blocked Host.
  // No caller-controlled name, path, config or signing policy is accepted.
  const successor = lane === "human-qa-r03-successor";
  return {
    ...config,
    appId: successor ? "com.lingstack.desktop.human-qa.r03-successor" : "com.lingstack.desktop.human-qa",
    productName: successor ? "Ling Stack R03 Successor QA" : "Ling Stack Human QA",
    directories: { ...config.directories, output: successor ? "release/human-qa-r03-successor" : "release/human-qa" },
    extraMetadata: {
      ...config.extraMetadata,
      // A package identity/scope marker, never proof of a human decision.
      lingHumanQaPackage: { schemaVersion: 1, purpose: "synthetic-human-evaluation", release: false },
    },
  };
}

/** Validate before any native/package side effects; presence is intentional. */
export function readPackagedOfficeHumanQaSelection(environment) {
  return readPackagedOfficeBuildLane(environment) !== "ordinary";
}

/** Exact lane identity, not just a boolean, must survive asynchronous build boundaries. */
export function readPackagedOfficeBuildLane(environment) {
  if (!Object.hasOwn(environment, "LING_DESKTOP_PACKAGE_HUMAN_QA")) return "ordinary";
  if (environment.LING_DESKTOP_PACKAGE_HUMAN_QA === "1") return "human-qa";
  if (environment.LING_DESKTOP_PACKAGE_HUMAN_QA === "retained-host-r03") return "human-qa-r03-successor";
  throw new Error("packaged_human_qa_lane_invalid");
}

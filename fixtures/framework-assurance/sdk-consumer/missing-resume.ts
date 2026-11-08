import type { RunnerExtensionMetadata } from "@ling-stack/plugin-sdk";

const missingResume: RunnerExtensionMetadata = {
  manifest: {
    id: "runner:negative", name: "Negative", version: "0.1.0", kind: "runner",
    trustLevel: "internal", capabilities: [],
  },
  runnerId: "negative", supportedTools: [], supportedProviderApis: [], eventTypes: [],
};
void missingResume;

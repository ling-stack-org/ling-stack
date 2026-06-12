import type { LingInputExtractor } from "../registry.js";

export const imageVisionExtractorV1: LingInputExtractor = {
  id: "image_vision_summary_v1",
  version: "1",
  supportedSourceKinds: ["attachment"],
  supportedContentKinds: ["vision_summary"],
  supports(input) {
    return input.sourceKind === "attachment";
  },
  async materialize() {
    return {
      status: "unsupported",
      contentKind: "vision_summary",
      errorCode: "not_wired",
      errorMessage: "image_vision_summary_v1 is declared in M1 and wired in M5.",
    };
  },
};

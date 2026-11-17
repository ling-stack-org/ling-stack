import type { PiRunnerToolHandledResult } from "./types.js";

export const CODE_INTELLIGENCE_OPERATIONS = ["definition", "references", "hover", "symbols", "diagnostics", "repo_map"] as const;
export interface PiRunnerCodeIntelligenceRequest {
  readonly toolCallId: string;
  readonly input: unknown;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}
export type PiRunnerCodeIntelligenceHandler = (request: PiRunnerCodeIntelligenceRequest) => Promise<PiRunnerToolHandledResult>;

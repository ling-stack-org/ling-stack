import type { TranscriptionResponse } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export function transcribeAudio(
  cwd: string,
  audio: Blob,
  options: {
    readonly filename?: string;
    readonly language?: string;
    readonly prompt?: string;
    readonly providerPresetId?: string;
  } = {},
): Promise<TranscriptionResponse> {
  return daemonClient.transcribeAudio(cwd, audio, options);
}

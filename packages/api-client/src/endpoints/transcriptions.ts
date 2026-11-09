import type { TranscriptionResponse } from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const transcriptionEndpoints = {
  async transcribeAudio(
    this: LingDaemonEndpointContext,
    cwd: string,
    audio: Blob,
    options: {
      readonly filename?: string;
      readonly language?: string;
      readonly prompt?: string;
      readonly providerPresetId?: string;
    } = {},
  ): Promise<TranscriptionResponse> {
    const form = new FormData();
    form.append("file", audio, options.filename ?? "recording.webm");
    if (options.language?.trim()) {
      form.append("language", options.language.trim());
    }
    if (options.prompt?.trim()) {
      form.append("prompt", options.prompt.trim());
    }
    if (options.providerPresetId?.trim()) {
      form.append("providerPresetId", options.providerPresetId.trim());
    }
    return this._requestMultipart("POST", "/transcribe", { cwd }, form);
  },
};

export type TranscriptionEndpoints = PublicEndpointGroup<typeof transcriptionEndpoints>;

import type { Translate } from "../../i18n.js";
import type { ChannelMention, RunIntervention } from "../../types.js";

export function channelRunInterventionStatusLabel(
  status: RunIntervention["status"],
  t: Translate,
): string {
  if (status === "cancelling_source") return t("Stopping source");
  if (status === "starting_continuation") return t("Starting continuation");
  if (status === "started") return t("Started");
  if (status === "cancelled") return t("Cancelled");
  if (status === "failed") return t("Failed");
  return t("Queued");
}

export function channelRunInterventionModeLabel(
  mode: RunIntervention["mode"],
  t: Translate,
): string {
  return mode === "interrupt_redirect" ? t("Stop and redirect") : t("Queue guidance");
}

export function channelGuidanceTargetLabel(input: {
  readonly teammateId?: string;
  readonly teammateOptions: readonly ChannelMention[];
  readonly lingAgentLabel: string;
  readonly fallbackLabel: string;
}): string {
  if (!input.teammateId || input.teammateId === "ling_agent" || input.teammateId === "ling-agent") {
    return input.lingAgentLabel;
  }
  return input.teammateOptions.find((teammate) => teammate.id === input.teammateId)?.label
    ?? input.fallbackLabel;
}

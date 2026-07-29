import { useI18n } from "../../i18n.js";
import { StatusIndicator } from "../../shared/ui/index.js";
import {
  channelActiveStatusPresentation,
  type ChannelActiveStatusInput,
} from "./channel-active-status-presentation.js";

export type ChannelActiveStatusIndicatorProps = ChannelActiveStatusInput;

export function ChannelActiveStatusIndicator(
  props: ChannelActiveStatusIndicatorProps,
): JSX.Element {
  const { t } = useI18n();
  const presentation = channelActiveStatusPresentation(props);

  return (
    <StatusIndicator
      className="channel-active-status-indicator"
      data-channel-active-status={props.kind}
      label={t(presentation.labelKey)}
      tone={presentation.tone}
    />
  );
}

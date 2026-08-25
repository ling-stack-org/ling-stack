import { useLayoutEffect, useState, type CSSProperties } from "react";
import {
  conversationSummaryGap,
  resolveConversationSummaryLayout,
  type ConversationSummaryLayoutInput,
  type ConversationSummaryLayoutResolution,
} from "./conversation-summary-layout-resolver.js";

export {
  conversationSummaryDockHandleWidth,
  conversationSummaryGap,
  conversationSummaryHorizontalGutter,
  conversationSummaryHysteresis,
  conversationSummaryMinContentWidth,
  conversationSummaryPanelWidth,
  conversationSummaryReserveWidth,
  resolveConversationSummaryLayout,
} from "./conversation-summary-layout-resolver.js";

export interface ConversationSummaryLayoutProjection extends ConversationSummaryLayoutResolution {
  readonly style: CSSProperties;
}

export function useConversationSummaryLayout(
  input: Omit<ConversationSummaryLayoutInput, "wasVisible">,
): ConversationSummaryLayoutProjection {
  const [wasVisible, setWasVisible] = useState(false);
  const resolution = resolveConversationSummaryLayout({ ...input, wasVisible });

  useLayoutEffect(() => {
    setWasVisible((current) => current === resolution.visible ? current : resolution.visible);
  }, [resolution.visible]);

  return {
    ...resolution,
    style: {
      "--conversation-summary-layout-width": `${resolution.reserveWidth}px`,
      "--conversation-summary-gap": `${conversationSummaryGap}px`,
    } as CSSProperties,
  };
}

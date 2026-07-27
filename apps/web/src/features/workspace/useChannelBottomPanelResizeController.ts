import type { MutableRefObject } from "react";
import {
  useConversationBottomPanelResizeController,
  type ConversationBottomPanelResizeController,
} from "./useConversationBottomPanelResizeController.js";

interface ChannelBottomPanelResizeControllerInput {
  readonly containerRef: MutableRefObject<HTMLDivElement | null>;
  readonly resizeObserverKey: string;
}

export type ChannelBottomPanelResizeController = ConversationBottomPanelResizeController;

export function useChannelBottomPanelResizeController({
  containerRef,
  resizeObserverKey,
}: ChannelBottomPanelResizeControllerInput): ChannelBottomPanelResizeController {
  return useConversationBottomPanelResizeController({
    containerRef: containerRef as MutableRefObject<HTMLElement | null>,
    resizeObserverKey,
    cssVariableName: "--channel-bottom-panel-height",
  });
}

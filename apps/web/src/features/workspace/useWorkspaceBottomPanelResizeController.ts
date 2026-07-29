import type { MutableRefObject } from "react";
import {
  useConversationBottomPanelResizeController,
  type ConversationBottomPanelResizeController,
} from "./useConversationBottomPanelResizeController.js";

interface WorkspaceBottomPanelResizeControllerInput {
  readonly containerRef?: MutableRefObject<HTMLElement | null>;
  readonly resizeObserverKey: string;
  readonly cssVariableName?: string;
}

export type WorkspaceBottomPanelResizeController = ConversationBottomPanelResizeController;

export function useWorkspaceBottomPanelResizeController({
  cssVariableName = "--workspace-bottom-panel-height",
  ...input
}: WorkspaceBottomPanelResizeControllerInput): WorkspaceBottomPanelResizeController {
  return useConversationBottomPanelResizeController({ ...input, cssVariableName });
}

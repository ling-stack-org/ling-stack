import {
  useConversationRightDockController,
  type ConversationRightDockController,
} from "./useConversationRightDockController.js";

interface WorkspaceRightDockControllerInput {
  readonly initialOpen: boolean;
  readonly intentOpen: boolean;
  readonly resizeObserverKey: string;
}

export type WorkspaceRightDockController = ConversationRightDockController;

export function useWorkspaceRightDockController(input: WorkspaceRightDockControllerInput): WorkspaceRightDockController {
  return useConversationRightDockController(input);
}

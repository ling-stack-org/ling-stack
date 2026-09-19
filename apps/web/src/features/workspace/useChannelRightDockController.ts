import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import type { DockPageKind } from "../../shared/conversation/index.js";
import type { WorkspaceRightDockFileTarget, WorkspaceRightDockPageRequest, WorkspaceRightDockReviewTarget } from "./right-dock/index.js";
import { channelRightDockMinWidth } from "./layout/channel-workspace-layout.js";
import {
  channelConversationRightDockVariables,
  useConversationRightDockController,
} from "./useConversationRightDockController.js";
import type { ConversationPanelMotionState } from "./useConversationPanelPresence.js";

interface ChannelRightDockControllerInput {
  readonly initialOpen: boolean;
  readonly intentOpen: boolean;
  readonly resizeObserverKey: string;
}

export interface ChannelRightDockController {
  readonly windowRef: MutableRefObject<HTMLDivElement | null>;
  readonly mainRef: MutableRefObject<HTMLDivElement | null>;
  readonly pageRequest: WorkspaceRightDockPageRequest | undefined;
  readonly visible: boolean;
  readonly expanded: boolean;
  readonly resizing: boolean;
  readonly width: number;
  readonly containerWidth: number;
  readonly motionState: ConversationPanelMotionState;
  readonly motionUntilRef: MutableRefObject<number>;
  readonly windowStyle: CSSProperties;
  readonly mainStyle: CSSProperties;
  readonly requestPage: (page: DockPageKind, workspaceFile?: WorkspaceRightDockFileTarget, workspaceReview?: WorkspaceRightDockReviewTarget) => void;
  readonly consumePageRequest: (nonce: number) => void;
  readonly close: () => void;
  readonly handleResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function useChannelRightDockController(input: ChannelRightDockControllerInput): ChannelRightDockController {
  const controller = useConversationRightDockController({
    ...input,
    defaultWidth: channelRightDockMinWidth,
    separateLayoutRoots: true,
    variables: channelConversationRightDockVariables,
  });
  const windowRef = controller.rootRef as MutableRefObject<HTMLDivElement | null>;
  const mainRef = controller.containerRef as MutableRefObject<HTMLDivElement | null>;

  return {
    windowRef,
    mainRef,
    pageRequest: controller.pageRequest,
    visible: controller.visible,
    expanded: controller.expanded,
    resizing: controller.resizing,
    width: controller.width,
    containerWidth: controller.containerWidth,
    motionState: controller.motionState,
    motionUntilRef: controller.motionUntilRef,
    windowStyle: controller.layoutStyle,
    mainStyle: controller.layoutStyle,
    requestPage: controller.requestPage,
    consumePageRequest: controller.consumePageRequest,
    close: controller.close,
    handleResizePointerDown: controller.handleResizePointerDown,
    handleResizePointerMove: controller.handleResizePointerMove,
    handleResizePointerEnd: controller.handleResizePointerEnd,
  };
}

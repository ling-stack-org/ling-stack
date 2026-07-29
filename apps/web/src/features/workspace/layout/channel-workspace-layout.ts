export const channelRightDockMinWidth = 304;
export const channelRightDockMaxViewportRatio = 0.5;
export const channelRightDockMinChatWidth = 560;
export const channelRightDockResizeHandleWidth = 8;

export interface ChannelWorkspaceLayoutTargetInput {
  readonly rightDockExpanded: boolean;
  readonly rightDockWidth: number;
}

export interface ChannelWorkspaceLayoutTargets {
  readonly dockWidth: number;
  readonly handleWidth: number;
}

export function easeChannelDockMotion(progress: number): number {
  if (progress <= 0) {
    return 0;
  }
  if (progress >= 1) {
    return 1;
  }
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - ((-2 * progress + 2) ** 3) / 2;
}

export function clampChannelRightDockWidth(width: number, containerWidth: number, viewportWidth: number): number {
  const maxByContainer = Math.max(
    channelRightDockMinWidth,
    containerWidth - channelRightDockMinChatWidth - channelRightDockResizeHandleWidth,
  );
  const maxByViewport = Math.max(channelRightDockMinWidth, Math.floor(viewportWidth * channelRightDockMaxViewportRatio));
  const effectiveMax = Math.min(maxByViewport, maxByContainer);
  return Math.round(Math.max(channelRightDockMinWidth, Math.min(width, effectiveMax)));
}

export function resolveChannelWorkspaceLayoutTargets({
  rightDockExpanded,
  rightDockWidth,
}: ChannelWorkspaceLayoutTargetInput): ChannelWorkspaceLayoutTargets {
  const dockWidth = rightDockExpanded ? rightDockWidth : 0;
  const handleWidth = rightDockExpanded ? channelRightDockResizeHandleWidth : 0;

  return {
    dockWidth,
    handleWidth,
  };
}

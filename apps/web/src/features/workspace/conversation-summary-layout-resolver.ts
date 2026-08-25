export const conversationSummaryPanelWidth = 280;
export const conversationSummaryGap = 16;
export const conversationSummaryReserveWidth = conversationSummaryPanelWidth + conversationSummaryGap;
export const conversationSummaryMinContentWidth = 560;
export const conversationSummaryHorizontalGutter = 48;
export const conversationSummaryDockHandleWidth = 8;
export const conversationSummaryHysteresis = 12;

export interface ConversationSummaryLayoutInput {
  readonly requestedOpen: boolean;
  readonly containerWidth: number;
  readonly dockVisible: boolean;
  readonly dockWidth: number;
  readonly wasVisible: boolean;
}

export interface ConversationSummaryLayoutResolution {
  readonly visible: boolean;
  readonly reserveWidth: number;
  readonly dockOffset: number;
  readonly requiredWidth: number;
}

export function resolveConversationSummaryLayout({
  requestedOpen,
  containerWidth,
  dockVisible,
  dockWidth,
  wasVisible,
}: ConversationSummaryLayoutInput): ConversationSummaryLayoutResolution {
  const dockReservation = dockVisible
    ? Math.max(0, dockWidth) + conversationSummaryDockHandleWidth
    : 0;
  const requiredWidth = conversationSummaryMinContentWidth
    + conversationSummaryHorizontalGutter
    + conversationSummaryReserveWidth
    + dockReservation;
  const dockOffset = dockReservation + conversationSummaryGap;

  if (!requestedOpen || containerWidth <= 0) {
    return { visible: false, reserveWidth: 0, dockOffset, requiredWidth };
  }

  const threshold = wasVisible
    ? requiredWidth - conversationSummaryHysteresis
    : requiredWidth + conversationSummaryHysteresis;
  const visible = containerWidth >= threshold;
  return {
    visible,
    reserveWidth: visible ? conversationSummaryReserveWidth : 0,
    dockOffset,
    requiredWidth,
  };
}

import {
  formatCatalogMessage,
  loadCatalog,
  type TranslationCatalog,
  type TranslationValues,
} from "@ling-stack/localization";
import { catalog as englishCatalog } from "@ling-stack/localization/catalogs/en-US";
import {
  DEFAULT_COMPUTER_USE_PREVIEW_LOCALE,
  isComputerUsePreviewLocale,
  type ComputerUsePreviewLocale,
} from "../../shared/desktop-capabilities.js";

const messageIds = {
  windowTitle: "desktop.computer_use.window_title",
  previewLabel: "desktop.computer_use.preview_label",
  previewAccessibleLabel: "desktop.computer_use.preview_accessible_label",
  livePreviewLabel: "desktop.computer_use.live_preview_label",
  inProgressLabel: "desktop.computer_use.in_progress_label",
  previewActionsLabel: "desktop.computer_use.preview_actions_label",
  moreLabel: "desktop.computer_use.more_label",
  morePreviewActionsLabel: "desktop.computer_use.more_preview_actions_label",
  previewMenuLabel: "desktop.computer_use.preview_menu_label",
  pageDeckLabel: "desktop.computer_use.page_deck_label",
  pagePositionLabel: "desktop.computer_use.page_position_label",
  activatingPageAction: "desktop.computer_use.activating_page_action",
  activatePageAction: "desktop.computer_use.activate_page_action",
  closePageAction: "desktop.computer_use.close_page_action",
  viewAllPagesAction: "desktop.computer_use.view_all_pages_action",
  availablePagesLabel: "desktop.computer_use.available_pages_label",
  failedLabel: "desktop.computer_use.failed_label",
  computerUseFailedDetail: "desktop.computer_use.failed_detail",
  completedLabel: "desktop.computer_use.completed_label",
  computerUseCompletedDetail: "desktop.computer_use.completed_detail",
  stoppedLabel: "desktop.computer_use.stopped_label",
  computerUseStoppedDetail: "desktop.computer_use.stopped_detail",
  stoppingLabel: "desktop.computer_use.stopping_label",
  waitingForStopConfirmationDetail: "desktop.computer_use.waiting_for_stop_detail",
  requestingStopDetail: "desktop.computer_use.requesting_stop_detail",
  stopFailedLabel: "desktop.computer_use.stop_failed_label",
  stopFailedDetail: "desktop.computer_use.stop_failed_detail",
  permissionRequiredLabel: "desktop.computer_use.permission_required_label",
  permissionRequiredDetail: "desktop.computer_use.permission_required_detail",
  previewCaptureFailedDetail: "desktop.computer_use.capture_failed_detail",
  approvalRequiredLabel: "desktop.computer_use.approval_required_label",
  approvalRequiredDetail: "desktop.computer_use.approval_required_detail",
  pausedLabel: "desktop.computer_use.paused_label",
  computerUsePausedDetail: "desktop.computer_use.paused_detail",
  reconnectingLabel: "desktop.computer_use.reconnecting_label",
  reconnectingDetail: "desktop.computer_use.reconnecting_detail",
  connectingLabel: "desktop.computer_use.connecting_label",
  connectingDetail: "desktop.computer_use.connecting_detail",
  liveLabel: "desktop.computer_use.live_label",
  openTaskAction: "desktop.computer_use.open_task_action",
  openTaskFailedLabel: "desktop.computer_use.open_task_failed_label",
  openTaskFailedDetail: "desktop.computer_use.open_task_failed_detail",
  tryOpenTaskAgainAction: "desktop.computer_use.try_open_task_again_action",
  hideAction: "desktop.computer_use.hide_action",
  resetPositionAction: "desktop.computer_use.reset_position_action",
  closeWindowAction: "desktop.computer_use.close_window_action",
  screenSettingsAction: "desktop.computer_use.screen_settings_action",
  retryCaptureAction: "desktop.computer_use.retry_capture_action",
  tryStopAgainAction: "desktop.computer_use.try_stop_again_action",
  stopComputerUseAction: "desktop.computer_use.stop_action",
  stopAndRevokeAction: "desktop.computer_use.stop_and_revoke_action",
  lockedControlArmedLabel: "desktop.computer_use.locked_armed_label",
  lockedControlAttestingLabel: "desktop.computer_use.locked_attesting_label",
  lockedControlActiveLabel: "desktop.computer_use.locked_active_label",
  lockedControlPausedLabel: "desktop.computer_use.locked_paused_label",
} as const;

export type ComputerUsePreviewMessageKey = keyof typeof messageIds;
export type ComputerUsePreviewTranslate = (
  key: ComputerUsePreviewMessageKey,
  values?: TranslationValues,
) => string;

export function normalizeComputerUsePreviewLocale(value: unknown): ComputerUsePreviewLocale {
  return isComputerUsePreviewLocale(value) ? value : DEFAULT_COMPUTER_USE_PREVIEW_LOCALE;
}

export function createComputerUsePreviewTranslator(
  _value: unknown,
  catalog: TranslationCatalog = englishCatalog.messages,
): ComputerUsePreviewTranslate {
  return (key, values) => formatCatalogMessage(catalog, englishCatalog.messages, messageIds[key], values);
}

export async function loadComputerUsePreviewTranslator(value: unknown): Promise<ComputerUsePreviewTranslate> {
  const locale = normalizeComputerUsePreviewLocale(value);
  const catalog = await loadCatalog(locale);
  return createComputerUsePreviewTranslator(locale, catalog.messages);
}

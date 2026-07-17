import {
  DEFAULT_COMPUTER_USE_PREVIEW_LOCALE,
  isComputerUsePreviewLocale,
  type ComputerUsePreviewLocale,
} from "../../shared/desktop-capabilities.js";

const enUS = {
  windowTitle: "{target} — {status} — Ling Computer Use preview",
  previewLabel: "Computer Use preview for {target}",
  livePreviewLabel: "Live Computer Use preview",
  inProgressLabel: "In progress",
  previewActionsLabel: "Computer Use preview actions",
  moreLabel: "More",
  morePreviewActionsLabel: "More preview actions",
  previewMenuLabel: "Preview actions",
  failedLabel: "Failed",
  computerUseFailedDetail: "Computer Use failed",
  completedLabel: "Completed",
  computerUseCompletedDetail: "Computer Use completed",
  stoppedLabel: "Stopped",
  computerUseStoppedDetail: "Computer Use stopped",
  stoppingLabel: "Stopping",
  waitingForStopConfirmationDetail: "Waiting for the runtime to confirm stop",
  requestingStopDetail: "Requesting runtime stop",
  stopFailedLabel: "Stop failed",
  stopFailedDetail: "Computer Use is still running. Try again.",
  permissionRequiredLabel: "Permission required",
  permissionRequiredDetail: "Screen recording permission is required",
  previewCaptureFailedDetail: "Preview capture failed",
  approvalRequiredLabel: "Approval required",
  approvalRequiredDetail: "Waiting for approval before continuing",
  pausedLabel: "Paused",
  computerUsePausedDetail: "Computer Use is paused",
  reconnectingLabel: "Reconnecting",
  reconnectingDetail: "Trying to restore the preview",
  connectingLabel: "Connecting",
  connectingDetail: "Preparing the approved preview source",
  liveLabel: "Live",
  openTaskAction: "Open task",
  hideAction: "Hide",
  resetPositionAction: "Reset position",
  closeWindowAction: "Close window",
  screenSettingsAction: "Screen settings",
  retryCaptureAction: "Retry capture",
  tryStopAgainAction: "Try Stop again",
  stopComputerUseAction: "Stop Computer Use",
} as const;

export type ComputerUsePreviewMessageKey = keyof typeof enUS;

const zhCN = {
  windowTitle: "{target} — {status} — Ling Computer Use 预览",
  previewLabel: "{target} 的 Computer Use 预览",
  livePreviewLabel: "实时 Computer Use 预览",
  inProgressLabel: "进行中",
  previewActionsLabel: "Computer Use 预览操作",
  moreLabel: "更多",
  morePreviewActionsLabel: "更多预览操作",
  previewMenuLabel: "预览操作",
  failedLabel: "失败",
  computerUseFailedDetail: "Computer Use 执行失败",
  completedLabel: "已完成",
  computerUseCompletedDetail: "Computer Use 已完成",
  stoppedLabel: "已停止",
  computerUseStoppedDetail: "Computer Use 已停止",
  stoppingLabel: "正在停止",
  waitingForStopConfirmationDetail: "正在等待运行时确认停止",
  requestingStopDetail: "正在请求运行时停止",
  stopFailedLabel: "停止失败",
  stopFailedDetail: "Computer Use 仍在运行，请重试。",
  permissionRequiredLabel: "需要权限",
  permissionRequiredDetail: "需要屏幕录制权限",
  previewCaptureFailedDetail: "预览捕获失败",
  approvalRequiredLabel: "需要批准",
  approvalRequiredDetail: "正在等待批准后继续",
  pausedLabel: "已暂停",
  computerUsePausedDetail: "Computer Use 已暂停",
  reconnectingLabel: "正在重新连接",
  reconnectingDetail: "正在尝试恢复预览",
  connectingLabel: "正在连接",
  connectingDetail: "正在准备已授权的预览来源",
  liveLabel: "实时",
  openTaskAction: "打开任务",
  hideAction: "隐藏",
  resetPositionAction: "重置位置",
  closeWindowAction: "关闭窗口",
  screenSettingsAction: "屏幕设置",
  retryCaptureAction: "重试捕获",
  tryStopAgainAction: "再次尝试停止",
  stopComputerUseAction: "停止 Computer Use",
} satisfies Readonly<Record<ComputerUsePreviewMessageKey, string>>;

const catalogs: Readonly<Record<ComputerUsePreviewLocale, Readonly<Record<ComputerUsePreviewMessageKey, string>>>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

type TranslationValues = Readonly<Record<string, string | number>>;

export type ComputerUsePreviewTranslate = (
  key: ComputerUsePreviewMessageKey,
  values?: TranslationValues,
) => string;

export function normalizeComputerUsePreviewLocale(value: unknown): ComputerUsePreviewLocale {
  return isComputerUsePreviewLocale(value) ? value : DEFAULT_COMPUTER_USE_PREVIEW_LOCALE;
}

export function createComputerUsePreviewTranslator(value: unknown): ComputerUsePreviewTranslate {
  const catalog = catalogs[normalizeComputerUsePreviewLocale(value)];
  return (key, values) => formatMessage(catalog[key], values);
}

function formatMessage(template: string, values?: TranslationValues): string {
  if (!values) {
    return template;
  }
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

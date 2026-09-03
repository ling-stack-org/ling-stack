import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import {
  formatCatalogMessage,
  loadCatalog,
  normalizeLocale,
  type TranslationValues,
} from "@ling-stack/localization";
import type {
  DesktopDaemonStartupFailureDecision,
  DesktopDaemonStartupFailurePrompt,
  DesktopDaemonStartupRecoveryDecision,
  DesktopDaemonStartupRecoveryPrompt,
} from "./daemon-startup-recovery.js";
import type { DesktopStartupFailurePrompt } from "./startup-failure-recovery.js";

type ShowMessageBox = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;

export async function showIncompatibleDaemonRecoveryDialog(input: {
  readonly locale: string;
  readonly prompt: DesktopDaemonStartupRecoveryPrompt;
  readonly showMessageBox: ShowMessageBox;
}): Promise<DesktopDaemonStartupRecoveryDecision> {
  const t = await createNativeTranslator(input.locale);
  const result = await input.showMessageBox({
    type: "warning",
    title: t("desktop.daemon.incompatible.title"),
    message: t("desktop.daemon.incompatible.message"),
    detail: t("desktop.daemon.incompatible.detail", { baseUrl: input.prompt.baseUrl }),
    buttons: [t("desktop.action.retry"), t("desktop.action.quit")],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0 ? "retry" : "quit";
}

export async function showOwnedDaemonStartupFailureDialog(input: {
  readonly locale: string;
  readonly prompt: DesktopDaemonStartupFailurePrompt | DesktopStartupFailurePrompt;
  readonly showMessageBox: ShowMessageBox;
}): Promise<DesktopDaemonStartupFailureDecision> {
  const t = await createNativeTranslator(input.locale);
  const details = startupFailureDetail(input.prompt.reason, t);
  const result = await input.showMessageBox({
    type: "error",
    title: t("desktop.daemon.start_failed.title"),
    message: t("desktop.daemon.start_failed.message"),
    detail: details,
    buttons: [t("desktop.action.retry"), t("desktop.action.open_diagnostics"), t("desktop.action.quit")],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (result.response === 0) {
    return "retry";
  }
  return result.response === 1 ? "open-diagnostics" : "quit";
}

function startupFailureDetail(
  reason: DesktopStartupFailurePrompt["reason"],
  t: NativeTranslate,
): string {
  return t(`desktop.daemon.start_failed.${reason === "start_timeout" ? "timeout" : reason}`);
}

type NativeTranslate = (key: string, values?: TranslationValues) => string;

async function createNativeTranslator(value: unknown): Promise<NativeTranslate> {
  const locale = normalizeLocale(value) ?? "en-US";
  const fallbackPromise = loadCatalog("en-US");
  const selectedPromise = locale === "en-US"
    ? fallbackPromise
    : loadCatalog(locale).catch(() => fallbackPromise);
  const [fallback, selected] = await Promise.all([fallbackPromise, selectedPromise]);
  return (key, values) => formatCatalogMessage(selected.messages, fallback.messages, key, values);
}

import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
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
  const chinese = input.locale.toLowerCase().startsWith("zh");
  const result = await input.showMessageBox({
    type: "warning",
    title: chinese ? "需要更新 Ling 本地服务" : "Ling local service needs an update",
    message: chinese
      ? "另一个 Ling daemon 正在使用本地端口，但与当前 Desktop 不兼容。"
      : "Another Ling daemon is using the local port, but it is incompatible with this Desktop build.",
    detail: chinese
      ? `Ling 不会自动终止不属于 Desktop 的服务。请先保存其中正在运行的任务，退出或更新 ${input.prompt.baseUrl} 上的 daemon，然后点击“重试”。`
      : `Ling will not terminate a service it did not start. Save any active work, stop or update the daemon at ${input.prompt.baseUrl}, then choose Retry.`,
    buttons: chinese ? ["重试", "退出"] : ["Retry", "Quit"],
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
  const chinese = input.locale.toLowerCase().startsWith("zh");
  const details = startupFailureDetail(input.prompt.reason, chinese);
  const result = await input.showMessageBox({
    type: "error",
    title: chinese ? "Ling 本地服务无法启动" : "Ling local service could not start",
    message: chinese ? "暂时无法打开工作区。" : "Ling cannot open the workspace yet.",
    detail: details,
    buttons: chinese ? ["重试", "打开诊断", "退出"] : ["Retry", "Open diagnostics", "Quit"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (result.response === 0) {
    return "retry";
  }
  return result.response === 1 ? "open-diagnostics" : "quit";
}

function startupFailureDetail(reason: DesktopStartupFailurePrompt["reason"], chinese: boolean): string {
  if (chinese) {
    switch (reason) {
      case "start_timeout":
        return "本地服务启动超时。你可以重试，或打开诊断目录查看启动日志。";
      case "child_exited":
        return "本地服务在准备完成前退出。你可以重试，或打开诊断目录查看启动日志。";
      case "resource_missing":
        return "Ling 的必要安装文件或工作区存储暂时不可用。你可以重试，或打开诊断目录检查安装。";
      case "spawn_failed":
        return "系统未能启动 Ling 本地服务。你可以重试，或打开诊断目录查看启动日志。";
    }
  }
  switch (reason) {
    case "start_timeout":
      return "The local service timed out while starting. Retry, or open diagnostics to inspect the startup log.";
    case "child_exited":
      return "The local service exited before it was ready. Retry, or open diagnostics to inspect the startup log.";
    case "resource_missing":
      return "Required Ling installation files or workspace storage are unavailable. Retry, or open diagnostics to inspect the installation.";
    case "spawn_failed":
      return "The system could not launch the Ling local service. Retry, or open diagnostics to inspect the startup log.";
  }
}

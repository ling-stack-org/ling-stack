export type ViewId = "workspace" | "teammates" | "runs" | "providers" | "media" | "approvals" | "settings";
export type SidebarViewTarget = ViewId | "tasks";
export type SidebarConversationKind = "teammate" | "direct";
export type SidebarTarget = SidebarViewTarget | `channel:${string}` | `${SidebarConversationKind}:${string}`;

export interface SidebarConversationItem {
  readonly id: string;
  readonly label: string;
  readonly kind: SidebarConversationKind;
  readonly avatarLabel: string;
  readonly tone?: "default" | "orange" | "teal" | "violet";
}

export function channelSidebarTarget(channelId: string): SidebarTarget {
  return `channel:${channelId}`;
}

export function conversationSidebarTarget(item: SidebarConversationItem): SidebarTarget {
  return `${item.kind}:${item.id}` as SidebarTarget;
}

export function viewTitle(view: ViewId): string {
  if (view === "workspace") {
    return "Run workspace";
  }
  if (view === "teammates") {
    return "AI Teammates";
  }
  if (view === "runs") {
    return "Run history";
  }
  if (view === "approvals") {
    return "Approvals";
  }
  if (view === "media") {
    return "Media jobs";
  }
  if (view === "settings") {
    return "Settings";
  }
  return "Model Workbench";
}

export function viewDescription(view: ViewId): string {
  if (view === "workspace") {
    return "发起本地任务，观察 pi-coding-agent 事件流，并读取持久化 run 历史。";
  }
  if (view === "teammates") {
    return "通过分步流程创建 AI 队友，选择默认角色、模型、频道、记忆和文件范围。";
  }
  if (view === "runs") {
    return "查看当前 workspace 的持久化 run，点击任意记录读取事件和上下文。";
  }
  if (view === "approvals") {
    return "查看和处理需要人工决策的高风险动作；bash、edit、write 会在执行前等待审批。";
  }
  if (view === "media") {
    return "创建和查看媒体 job 元数据；当前切片只验证模型与适配器边界，不调用真实媒体生成 API。";
  }
  if (view === "settings") {
    return "配置 workspace 级 approval policy，控制工具自动允许、询问或拒绝，以及写入路径边界。";
  }
  return "管理多模型和自定义国内模型接入，可直接保存 API Key，Save & Check 通过后用于工作区任务。";
}

export type ViewId = "workspace" | "teammates" | "runs" | "threads" | "automations" | "providers" | "media" | "approvals" | "work_board" | "settings";
export type SidebarViewTarget = ViewId | "tasks";
export type SidebarConversationKind = "teammate" | "direct";
export type SidebarTarget = SidebarViewTarget | `channel:${string}` | `${SidebarConversationKind}:${string}`;
export type SelectedEntity =
  | { readonly type: "workspace" }
  | { readonly type: "task"; readonly id: string }
  | { readonly type: "run"; readonly id: string }
  | { readonly type: "provider"; readonly id: string }
  | { readonly type: "mediaJob"; readonly id: string }
  | { readonly type: "approval"; readonly id: string };

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

export function teammateSidebarTarget(teammateId: string): SidebarTarget {
  return `teammate:${teammateId}`;
}

export function readTeammateSidebarTarget(target: SidebarTarget): string | undefined {
  return target.startsWith("teammate:") ? target.slice("teammate:".length) : undefined;
}

export function viewTitle(view: ViewId): string {
  if (view === "workspace") {
    return "Run workspace";
  }
  if (view === "teammates") {
    return "AI Teammates";
  }
  if (view === "runs") {
    return "Run Diagnostics";
  }
  if (view === "threads") {
    return "Threads";
  }
  if (view === "automations") {
    return "Automations";
  }
  if (view === "approvals") {
    return "Review Queue";
  }
  if (view === "work_board") {
    return "Work Board";
  }
  if (view === "media") {
    return "Generation tasks";
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
    return "查看 raw runs、事件、证据、shell snapshots 和线程绑定，用于开发与支持诊断。";
  }
  if (view === "threads") {
    return "查看长期线程的 lineage、证据、动作审计和 resume context。";
  }
  if (view === "automations") {
    return "创建、预览并运行可重复的 AI teammate 工作。";
  }
  if (view === "approvals") {
    return "处理跨频道注意事项、外部动作审批、已批准动作执行和离线本地审批。";
  }
  if (view === "work_board") {
    return "全局工作状态台账：按频道、来源、负责人、等待原因和阻塞状态查看所有工作。";
  }
  if (view === "media") {
    return "创建和查看媒体 job 元数据；当前切片只验证模型与适配器边界，不调用真实媒体生成 API。";
  }
  if (view === "settings") {
    return "配置 workspace 级 approval policy，控制工具自动允许、询问或拒绝，以及写入路径边界。";
  }
  return "Manage model presets, paste API keys, then Save before running workspace tasks.";
}

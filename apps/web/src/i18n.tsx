import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "en-US" | "zh-CN";

type TranslationValues = Readonly<Record<string, string | number>>;
export type Translate = (key: string, values?: TranslationValues) => string;

interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
}

const storageKey = "ling-stack.locale";
const defaultLocale: Locale = "en-US";

const dictionaries: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  "en-US": {
    "发起本地任务，观察 pi-coding-agent 事件流，并读取持久化 run 历史。": "Start local tasks, watch the pi-coding-agent event stream, and inspect persisted run history.",
    "查看当前 workspace 的持久化 run，点击任意记录读取事件和上下文。": "Inspect persisted runs for the current workspace and open any record to read events and context.",
    "查看和处理需要人工决策的高风险动作；bash、edit、write 会在执行前等待审批。": "Review risky actions that need a human decision; bash, edit, and write wait for approval before execution.",
    "创建和查看媒体 job 元数据；当前切片只验证模型与适配器边界，不调用真实媒体生成 API。": "Create and inspect media job metadata; this slice validates model and adapter boundaries without calling live media generation APIs.",
    "配置 workspace 级 approval policy，控制工具自动允许、询问或拒绝，以及写入路径边界。": "Configure workspace-level approval policy for tool allow, ask, deny decisions and write path boundaries.",
    "管理本地 provider preset，用 env:NAME 引用密钥，并在 run 启动时选择预设。": "Manage local provider presets, reference secrets with env:NAME, and select presets when starting runs.",
  },
  "zh-CN": {
    "AI teammate workspace": "AI 协作工作区",
    "Language": "语言",
    "English": "English",
    "Chinese": "中文",
    "Inspect Ling Stack workspace": "检查 Ling Stack 工作区",
    "Inspect workspace": "检查工作区",
    "Inspect the current project structure, give next implementation advice, and do not modify files.": "查看当前项目结构，给出下一步实现建议。不要修改文件。",
    "Checking daemon": "正在检查 daemon",
    "Daemon ready": "Daemon 已就绪",
    "Daemon offline": "Daemon 离线",
    "Refresh daemon health": "刷新 daemon 健康状态",
    "Workspace": "工作区",
    "Runs": "运行",
    "Providers": "Provider",
    "Media Jobs": "媒体任务",
    "Approvals": "审批",
    "Settings": "设置",
    "Run workspace": "运行工作区",
    "Run history": "运行历史",
    "Media jobs": "媒体任务",
    "Provider presets": "Provider 预设",
    "发起本地任务，观察 pi-coding-agent 事件流，并读取持久化 run 历史。": "发起本地任务，观察 pi-coding-agent 事件流，并读取持久化 run 历史。",
    "查看当前 workspace 的持久化 run，点击任意记录读取事件和上下文。": "查看当前 workspace 的持久化 run，点击任意记录读取事件和上下文。",
    "查看和处理需要人工决策的高风险动作；bash、edit、write 会在执行前等待审批。": "查看和处理需要人工决策的高风险动作；bash、edit、write 会在执行前等待审批。",
    "创建和查看媒体 job 元数据；当前切片只验证模型与适配器边界，不调用真实媒体生成 API。": "创建和查看媒体 job 元数据；当前切片只验证模型与适配器边界，不调用真实媒体生成 API。",
    "配置 workspace 级 approval policy，控制工具自动允许、询问或拒绝，以及写入路径边界。": "配置 workspace 级 approval policy，控制工具自动允许、询问或拒绝，以及写入路径边界。",
    "管理本地 provider preset，用 env:NAME 引用密钥，并在 run 启动时选择预设。": "管理本地 provider preset，用 env:NAME 引用密钥，并在 run 启动时选择预设。",

    "Workspace readiness": "工作区就绪状态",
    "Ready": "就绪",
    "{count} blocked": "{count} 项阻塞",
    "Daemon": "Daemon",
    "Checking local daemon": "正在检查本地 daemon",
    "Daemon is offline": "Daemon 离线",
    "Local daemon is reachable": "本地 daemon 可访问",
    "Retry": "重试",
    "Provider": "Provider",
    "Runnable chat presets": "可运行聊天预设",
    "Needs setup": "需要设置",
    "Loading provider presets": "正在加载 Provider 预设",
    "No provider presets": "没有 Provider 预设",
    "{total} configured, none runnable": "已配置 {total} 个，但没有可运行项",
    "{runnable} runnable, check required": "{runnable} 个可运行，需要 Check",
    "{ready}/{total} preflight ready": "{ready}/{total} 个预检查就绪",
    "Channel": "频道",
    "Channel provider": "频道 Provider",
    "Channels": "频道",
    "Loading channels": "正在加载频道",
    "No channel yet": "还没有频道",
    "{total} channel available": "{total} 个频道可用",
    "{total} channels available": "{total} 个频道可用",
    "Tasks": "任务",
    "Task": "任务",
    "Loading selected channel tasks": "正在加载当前频道任务",
    "No task in selected channel": "当前频道没有任务",
    "Create a channel first": "先创建频道",
    "{total} task in selected channel": "当前频道有 {total} 个任务",
    "{total} tasks in selected channel": "当前频道有 {total} 个任务",
    "{count} approval waiting for a local decision": "{count} 个审批等待本地决策",
    "{count} approvals waiting for a local decision": "{count} 个审批等待本地决策",
    "{count} expired approval need review": "{count} 个过期审批需要复核",
    "{count} expired approvals need review": "{count} 个过期审批需要复核",
    "No pending or expired approvals": "没有待处理或过期审批",
    "Run loop": "运行闭环",
    "Loading run history": "正在加载运行历史",
    "Latest failed run needs review: {runId}": "最近失败运行需要复核：{runId}",
    "No successful run yet": "还没有成功运行",
    "{count} successful run": "{count} 次成功运行",
    "{count} successful runs": "{count} 次成功运行",
    "Create": "创建",

    "First run": "首次运行",
    "setup loop": "设置闭环",
    "Run in progress": "运行中",
    "Active task": "当前任务",
    "Open run": "打开运行",
    "Run loop complete": "运行闭环完成",
    "Run needs attention": "运行需要处理",
    "Current run linked": "已关联当前运行",
    "Run again": "再次运行",
    "First run ready": "首次运行已就绪",
    "{taskTitle} can run with {providerName}.": "{taskTitle} 可使用 {providerName} 运行。",
    "Check run": "检查运行",
    "Run": "运行",
    "Create default": "创建默认项",
    "Set provider": "设置 Provider",
    "Create first task": "创建首个任务",
    "Provider is not ready.": "Provider 尚未就绪。",
    "Task and provider are ready.": "任务和 Provider 已就绪。",
    "Create or repair a preflight-ready chat provider first.": "先创建或修复一个预检查就绪的聊天 Provider。",
    "{providerName} is preflight-ready.": "{providerName} 已通过预检查。",
    "Create an Engineering channel with the ready provider as default.": "创建 Engineering 频道，并把就绪 Provider 设为默认项。",
    "Create a channel after provider setup.": "Provider 设置完成后创建频道。",
    "A channel is selected.": "已选择频道。",
    "Create or select a channel first.": "先创建或选择频道。",
    "Selected channel has a preflight-ready default provider.": "当前频道已有预检查就绪的默认 Provider。",
    "Set {providerName} as the channel default.": "把 {providerName} 设为频道默认 Provider。",
    "Repair a provider before setting the channel default.": "先修复 Provider，再设置频道默认项。",
    "Create the first task from the default prompt.": "用默认提示词创建首个任务。",
    "{count} task available.": "{count} 个任务可用。",
    "{count} tasks available.": "{count} 个任务可用。",
    "Create a task first.": "先创建任务。",
    "Create a channel first.": "先创建频道。",
    "Select or set a provider before running.": "运行前先选择或设置 Provider。",

    "Refresh": "刷新",
    "Workspace path": "工作区路径",
    "Execution": "执行路径",
    "Loading channels...": "正在加载频道...",
    "No channels yet": "还没有频道",
    "Channel detail": "频道详情",
    "Channel id": "频道 ID",
    "Execution path": "执行路径",
    "Name": "名称",
    "Default provider": "默认 Provider",
    "None": "无",
    "Save channel": "保存频道",
    "New channel": "新建频道",
    "Create channel": "创建频道",
    "None selected": "未选择",
    "Delete": "删除",
    "Run provider": "运行 Provider",
    "Select provider preset": "选择 Provider 预设",
    "No saved provider presets. Create one from GPT, Claude, relay, or domestic templates.": "没有已保存的 Provider 预设。请从 GPT、Claude、Relay 或国内模型模板创建一个。",
    "No runnable provider presets. Enable a chat provider and configure its env key.": "没有可运行的 Provider 预设。请启用聊天 Provider 并配置环境变量密钥。",
    "Select a provider preset before running tasks.": "运行任务前先选择 Provider 预设。",
    "Title": "标题",
    "Prompt": "提示词",
    "Create task": "创建任务",
    "Task detail": "任务详情",
    "Task id": "任务 ID",
    "Current run": "当前运行",
    "Edit": "编辑",
    "Review": "复核",
    "Save task": "保存任务",
    "Move to review": "移到复核",
    "Loading tasks...": "正在加载任务...",
    "No tasks in this channel": "这个频道还没有任务",

    "Recent runs": "最近运行",
    "Loading runs...": "正在加载运行...",
    "No persisted runs for this workspace": "当前工作区没有持久化运行",
    "Run detail": "运行详情",
    "Reload": "重新加载",
    "Rerun snapshot": "重跑快照",
    "Select a run to inspect execution details": "选择一个运行以查看执行详情",
    "Status": "状态",
    "Workspace cwd": "工作区 cwd",
    "Execution cwd": "执行 cwd",
    "Provider preset": "Provider 预设",
    "Created": "创建时间",
    "Ended": "结束时间",
    "Approval state": "审批状态",
    "{count} approval events": "{count} 个审批事件",
    "Waiting for {count} approval: {actions}": "等待 {count} 个审批：{actions}",
    "Waiting for {count} approvals: {actions}": "等待 {count} 个审批：{actions}",
    "No approval gates recorded for this run.": "这个运行没有记录审批门禁。",
    "Assistant output": "助手输出",
    "Task snapshot": "任务快照",
    "No prompt snapshot.": "没有提示词快照。",
    "Tool activity": "工具活动",
    "{count} tool events": "{count} 个工具事件",
    "No tool activity recorded.": "没有记录工具活动。",
    "Event timeline": "事件时间线",
    "{count} events": "{count} 个事件",
    "No events loaded.": "没有加载事件。",
    "Evidence": "证据",
    "audit preview": "审计预览",
    "Run summary preview": "运行摘要预览",
    "Terminal event": "终止事件",
    "Tool events": "工具事件",
    "Errored tools": "错误工具",
    "Session files": "会话文件",
    "Event log": "事件日志",
    "Summary": "摘要",
    "Artifacts": "产物",
    "No artifacts recorded for this run": "这个运行没有记录产物",
    "Artifacts will appear here once the daemon records files under .ling-stack/artifacts.": "daemon 在 .ling-stack/artifacts 下记录文件后，产物会显示在这里。",

    "Check all": "全部检查",
    "Compatible chat": "兼容聊天",
    "Preflight ready": "预检查就绪",
    "Missing env": "缺少环境变量",
    "Templates": "模板",
    "Loading providers...": "正在加载 Provider...",
    "Create a preset from GPT, Claude, relay, or domestic provider templates": "从 GPT、Claude、Relay 或国内模型模板创建预设",
    "enabled": "已启用",
    "disabled": "已禁用",
    "key ready": "密钥就绪",
    "key missing": "缺少密钥",
    "no key ref": "无密钥引用",
    "preflight ready": "预检查就绪",
    "needs check": "需要检查",
    "last check {time}": "上次检查 {time}",
    "not checked": "未检查",
    "Use": "使用",
    "Check": "检查",
    "Edit preset": "编辑预设",
    "New preset": "新建预设",
    "New": "新建",
    "Provider templates": "Provider 模板",
    "No templates available.": "没有可用模板。",
    "Kind": "类型",
    "Display name": "显示名称",
    "Provider id": "Provider ID",
    "Model": "模型",
    "API protocol": "API 协议",
    "Base URL": "Base URL",
    "API key ref": "API 密钥引用",
    "Input": "输入",
    "Context": "上下文",
    "Max tokens": "最大 token",
    "Capabilities": "能力",
    "Enabled": "启用",
    "Auth header": "认证头",
    "Reasoning": "推理",
    "Provider check": "Provider 检查",
    "Provider ready": "Provider 已就绪",
    "Provider needs attention": "Provider 需要处理",
    "no provider": "无 Provider",
    "Checked": "检查时间",
    "Save changes": "保存修改",
    "Create preset": "创建预设",
    "Check preset": "检查预设",
    "Run Check after saving to validate env, base URL, and model access.": "保存后运行 Check，验证环境变量、Base URL 和模型访问。",
    "Create the preset first, then run Check before using it in Workspace.": "先创建预设，使用前再运行 Check。",
    "Next: choose a template, save the preset, then run Check before using it.": "下一步：选择模板、保存预设，然后运行 Check。",
    "Ready: {providerName} passed preflight and can run tasks. Re-check after env, base URL, or model changes.": "就绪：{providerName} 已通过预检查，可以运行任务。环境变量、Base URL 或模型变更后需要重新检查。",
    "Next: set {envName} for {providerName}, restart the daemon, then run Check.": "下一步：为 {providerName} 设置 {envName}，重启 daemon，然后运行 Check。",
    "Next: run Check for {providerName} before using it in Workspace.": "下一步：使用 {providerName} 前先运行 Check。",
    "Next: enable a chat provider with a supported API protocol, then run Check.": "下一步：启用一个支持当前 API 协议的聊天 Provider，然后运行 Check。",

    "Media providers": "媒体 Provider",
    "Queued jobs": "排队任务",
    "Artifacts linked": "已关联产物",
    "Loading media jobs...": "正在加载媒体任务...",
    "No media jobs recorded for this workspace": "当前工作区没有媒体任务记录",
    "Run media adapter": "运行媒体适配器",
    "Cannot run from {status}": "状态 {status} 不能运行",
    "{count} artifacts": "{count} 个产物",
    "Approval required before live execution": "真实执行前需要审批",
    "Create media job": "创建媒体任务",
    "Media providers can run through the media adapter contract. Coding task runs still require chat providers.": "媒体 Provider 会通过媒体适配器契约运行；代码任务仍需要聊天 Provider。",
    "Create a Jimeng, Seedream, or Seedance media provider before recording media jobs.": "记录媒体任务前先创建 Jimeng、Seedream 或 Seedance 媒体 Provider。",
    "Media provider": "媒体 Provider",
    "Select media provider": "选择媒体 Provider",
    "Operation": "操作",
    "Image generate": "生成图片",
    "Image edit": "编辑图片",
    "Video generate": "生成视频",
    "{providerName} does not support {operation}.": "{providerName} 不支持 {operation}。",
    "Input JSON": "输入 JSON",

    "Approval policy": "审批策略",
    "Updated": "更新时间",
    "Tool approval decisions": "工具审批决策",
    "Allow": "允许",
    "Ask": "询问",
    "Deny": "拒绝",
    "Allowed write paths": "允许写入路径",
    "Save policy": "保存策略",
    "Approval requests": "审批请求",
    "No approval records for this run": "这个运行没有审批记录",
    "No approval requests for this workspace": "当前工作区没有审批请求",
    "Loading approvals...": "正在加载审批...",
    "Decision reason": "决策理由",
    "Required before approving high-risk requests": "批准高风险请求前必须填写",
    "Optional note for the audit log": "审计日志的可选备注",
    "High-risk approvals need a decision reason.": "高风险审批需要填写决策理由。",
    "High-risk approval. Review the payload and reason, then confirm.": "高风险审批。请复核 payload 和理由后确认。",
    "Cancel": "取消",
    "Approving": "正在批准",
    "Confirm approve": "确认批准",
    "Approve": "批准",
    "Denying": "正在拒绝",
    "resolved {time}": "已处理 {time}",
    "provider {providerPresetId}": "provider {providerPresetId}",
    "model {model}": "模型 {model}",
    "operation {operation}": "操作 {operation}",

    "Event stream": "事件流",
    "Assistant": "助手",
    "Pending approval": "待审批",
    "Waiting for runner events...": "等待 runner 事件...",
    "No run loaded yet": "尚未加载运行",
    "Payload": "Payload",
    "Run context": "运行上下文",
    "Run id": "运行 ID",
    "Load persisted run": "加载持久化运行",
    "Tool calls": "工具调用",
    "No tool activity yet.": "还没有工具活动。",
    "Persistence": "持久化",
    "not loaded": "未加载",

    "Approval required": "需要审批",
    "{count} approval pending before this run can continue.": "这个运行继续前还有 {count} 个审批待处理。",
    "{count} approvals pending before this run can continue.": "这个运行继续前还有 {count} 个审批待处理。",
    "This run is waiting for an approval decision.": "这个运行正在等待审批决策。",
    "Provider repair needed": "需要修复 Provider",
    "The failure looks related to provider auth, preflight, endpoint, or model configuration.": "失败看起来与 Provider 认证、预检查、端点或模型配置有关。",
    "Inspect run failure": "检查运行失败",
    "The failure looks like a runtime or tool issue. Inspect events, fix the workspace or task, then rerun.": "失败看起来是运行时或工具问题。请检查事件、修复工作区或任务后重跑。",
  },
};

const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => undefined,
  t: (key) => key,
});

export function I18nProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => resolveInitialLocale());

  useEffect(() => {
    globalThis.localStorage?.setItem(storageKey, locale);
    if (globalThis.document) {
      globalThis.document.documentElement.lang = locale;
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: setLocaleState,
      t: (key, values) => formatTranslation(dictionaries[locale][key] ?? dictionaries[defaultLocale][key] ?? key, values),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function LanguageSwitcher(): JSX.Element {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="language-switcher" aria-label={t("Language")}>
      <button
        type="button"
        className={locale === "zh-CN" ? "active" : ""}
        aria-pressed={locale === "zh-CN"}
        onClick={() => setLocale("zh-CN")}
      >
        中文
      </button>
      <button
        type="button"
        className={locale === "en-US" ? "active" : ""}
        aria-pressed={locale === "en-US"}
        onClick={() => setLocale("en-US")}
      >
        EN
      </button>
    </div>
  );
}

function resolveInitialLocale(): Locale {
  const saved = globalThis.localStorage?.getItem(storageKey);
  if (saved === "zh-CN" || saved === "en-US") {
    return saved;
  }

  const browserLanguage = globalThis.navigator?.language?.toLowerCase() ?? "";
  return browserLanguage.startsWith("zh") ? "zh-CN" : defaultLocale;
}

function formatTranslation(template: string, values?: TranslationValues): string {
  if (!values) {
    return template;
  }

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

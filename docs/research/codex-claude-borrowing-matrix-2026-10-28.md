# Codex / Claude 对 Ling 的设计借鉴与差距清单

日期：2026-10-28。用途：把外部参考转成可以逐项实施、验证的检查清单。

本文是研究对照记录。现有设计、实现计划和 `docs/design/implementation-status.md` 继续拥有行为约定与交付状态；本文不建立第二套架构、功能队列或完成判据。对已有实现优先补证据、修真实回归；新增能力单独标明。

## 研究快照与后继实施

以下现状保留首次研究时的代码基线；它不是当前完成状态。后继实施已迁至 `ling-design-parity/ling-stack`，仍使用 `codex/e6-safe-continuation`。已整合 `main@0b25fc18`，本地整合提交为 `071cbb85`。A03 命令详情、A06 阅读快照和 A07 文件展开偏好已有未提交实现；对应自动与实际客户端验收须分别记录，不由本清单自动判定完成。交付范围为原 21 项、补充 B08 的测量评估及原 E6 剩余工作。独立实验见 [C01/C05 原型记录](codex-claude-prototypes-2026-10-29.md)，原型通过不等于生产接入完成。

当前增量、实际验证及未完成边界集中见 [2026-10-29 实施检查点](../design/design-parity-implementation-checkpoint-2026-10-29.md)。下文 A03/A06/A07 的初始差距不应被解释为当前代码仍无实现。

## 初始证据范围与阅读方式

- 代码基线：工作区 `ling-e6-continuation/ling-stack`，分支 `codex/e6-safe-continuation`，HEAD `22204d64f5fab1ca0cdd81b5cedad6477ae8d050`。
- 本地 `origin/main` 指针为 `60ed948820311933edf3ce24a8282b560e3aca5d`，本轮未重新 fetch。E6 的实现、main 合入状态和正在运行的安装包不是同一份交付证明。
- 该工作区存在 Composer、权限选择、AppShell、私聊与相关测试的既有 WIP。本文读取当前工作副本；不把这些 WIP 视为已提交或已发布。只新增本文，不修改产品代码和既有计划。
- 本轮验证为定向源码阅读、现有测试/验收记录核对及本文结构检查。没有重新运行测试、模型、桌面操作、VM、构建或安装；下文“验收方式”是待执行或复用证据的要求，不是新通过结论。
- Codex 参考包的会话 renderer、事件与桌面桥接资料较完整，但其中仍有静态推断。“24 槽位”“固定重启间隔”“rollout/compress”等不能直接变成 Ling 契约；尤其不把存储压缩等同于模型上下文压缩。
- Claude 材料分析的是 **Claude Desktop 4.29.0**，包含 Claude Code/Cowork 接入，不是 Claude Code CLI 的完整源码。主会话由独立 WebContentsView 加载网页，本地 MainWindowPage 主要是窗口壳与错误恢复。因此不能据此认定 Claude 的聊天折叠、滚动或产物交互已经被完整验证。
- “未核实”表示证据不足；“缺少能力”表示已有明确代码依据；两者分别处理。用户本轮截图仅展示项目标题，不用来证明产品行为或缺陷。

参考编号：

| 编号 | 材料 | 可用范围 |
| --- | --- | --- |
| C08 | Codex 包 `docs/08-桌面壳实现细节与IPC契约.md` | 桌面桥接、快照/增量、分块与 ACK、能力端口；静态证据 |
| C09 | Codex 包 `docs/09-会话流事件模型与进程生命周期.md` | item/turn 事件、生命周期、诊断；须排除材料中的压缩语义误读 |
| C10 | Codex 包 `docs/10-会话UI组件树与排版规格.md` | 文本/工具/最终回复分工、过程分组、子代理与产物面板 |
| C11 | Codex 包 `docs/11-线程持久化与rollout读取链路.md` | 历史读取、分页、重连合并的参考；存储结构不直接迁入 Ling |
| C12 | Codex 包 `docs/12-原生层与沙箱Aperitif拆解.md` | 原生插件、能力与沙盒的静态线索；不据此承诺性能收益 |
| K01 | Claude `Claude-Desktop-4.29.0-架构逆向报告.md` | 专用运行时、IPC、原生层入口；产品内部职责仍需代码/动态验证 |
| K02 | Claude `analysis/native-cowork-vm.md` | Virtualization.framework、VM RPC、挂载与网络相关符号；动态效果未验证 |
| K03 | Claude `analysis/mcp-runtime.md` | MCP 宿主入口、OAuth/重连相关线索；关键词零命中不证明“没有授权逻辑” |

原始资料位置：

- Codex：用户提供的 `codex-desktop-reverse-20261028.zip`；本轮读取已解压副本 `codex-desktop-reverse-20261028/`。临时副本删除后，应从原附件恢复；本文只引用材料，不复制原始构建产物。
- Claude：用户提供的 `re-claude/` 目录。

## 总览与实施顺序

这里的“先后”是本次借鉴建议，不重新定义现有 P0/P1 或 UX1–UX3 范围，也不把原型自动批准为生产改造。

| ID | 项目 | 当前分类 | 下一步 |
| --- | --- | --- | --- |
| A01 | 正文、事实与最终回复的分工 | 已有实现 | 对齐现有契约，补缺失场景证据 |
| A02 | 过程折叠与活动分组 | 已有实现 | 复用既有验收，只补新差异 |
| A03 | 单条命令的完整详情 | 增量已有实现及浏览器回归 | 完成同包真实执行验收 |
| A04 | 异常、审批与追问显露 | 已有实现 | 核对终态、嵌套与错误唯一归属 |
| A05 | 流式阅读、滚动与长历史 | 已有实现 | 复用阅读稳定性验收，补真实组合场景 |
| A06 | 按会话恢复阅读位置与展开状态 | 增量已有实现及浏览器回归 | 完成历史/流式/重开联合验收 |
| A07 | 文件、Diff 与可交互产物 | 文件展开增量已有实现及回归 | 完成同包产物入口验收，沿用产物计划 |
| A08 | 子代理展示与定位 | 已有实现 | 核对父子归属、异常穿透及复制边界 |
| B01 | 宿主与执行内核分离 | 已有实现 | 沿用 Pi/native 路径与一致性门禁 |
| B02 | 取消、超时与实际停止 | 已有实现 | 收口真实执行与界面一致性 |
| B03 | 审批等待与续接 | 已有实现 | 核对一次批准、撤销、重启与续接 |
| B04 | 崩溃、租约与恢复 | 已有实现 | 补齐同包联合验收，禁止盲重放副作用 |
| B05 | 子任务预算与完成汇合 | 已有实现 | 核对 required 子任务及排空证据 |
| B06 | 事件背压与大输出 | 已有实现 | 覆盖慢客户端、重连与大产物组合 |
| B07 | 启动、退出与诊断 | 已有实现及跟进计划 | 对齐进程真相、恢复动作和诊断入口 |
| B08 | 后台读取调度（补充项） | 已完成隔离合成测量；未启用生产合并 | 补真实 UI 重复需求证据后决定是否优化 |
| C01 | MCP 连接复用与分代 | 隔离原型与本地测量已完成 | 生产接入前补 Host/auth 联合门禁 |
| C02 | MCP/Provider 配置变更与过期结果 | 已有实现；部分鉴权行为未核实 | 保留原子发布，核对真实认证生命周期 |
| C03 | 原生能力、IPC 与凭据边界 | 已有实现；非全量审计 | 沿现有能力入口逐项补齐 |
| C04 | Computer Use 与 PiP | 已有实现及平台待验项 | 接续现有加固/平台计划 |
| C05 | VM 隔离执行 | 最小 VM 实机原型已验证 | 继续研究生产 RPC、网络与恢复边界 |
| C06 | 桌面壳启动优化与底层运行时 | 已有两次真实阶段观测，未做受控 benchmark | 先定位资源准备耗时，补首帧、可输入及 RSS 测量 |

建议实施批次：先完成 **A03、A06**，同时核对 A01–A08 尚缺的真实证据；随后接续 B 组现有未完成验收。C01/C05/C06 可以开展独立测量或原型，接入生产仍须满足原有执行、授权、恢复和平台门禁。C02–C04 沿已有计划接续。

### 会话体验的共同验收

下列五项用于核对 A 组的最终体验。现有组件/浏览器回归和历史 packaged 证据按各自输入复用；当前增量的同包真实组合仍须单独取得证据，不能据此表提前判定通过。

| 用户关心的问题 | 对应条目 | 在同一新包中如何验收 |
| --- | --- | --- |
| 运行中是否跳动 | A01、A02、A05 | 分别在追尾及向上阅读时经历流式正文、工具状态变化、图片延迟加载；向上阅读时稳定布局后的锚点误差沿用 ≤2 CSS px，只有显式回到底部才恢复追尾 |
| 展开后是否抢滚动 | A02、A03、A05、A08 | 在阅读中段展开长命令、过程和子代理，再经历状态更新与虚拟重挂载；保留原可见内容及相对位置，命令复制与日志入口仍属于该条执行 |
| 历史重开是否一致 | A01、A06、A07 | A→B→A、reload 和实际退出重开后核对阅读位置、展开偏好、最终回复及文件归属；目标失效安全回退，不重跑任务、不新增重复回复 |
| 失败是否显露 | A02、A04、A06、A08 | 在恢复了收起偏好的历史上出现失败、审批、追问及结果待确认，均能看到并定位；保留各自精确状态和单一错误 owner |
| 产物是否容易找到 | A03、A07 | 从对应回复打开真实文件、Diff、图片及完整日志，再返回继续阅读；入口有真实来源，无来源时明确不可用，展开偏好不因重挂载丢失 |

## 2026-10-29 补充：完整结构化包的代码交叉核对

用户补充的五项机制已与原 21 项对齐；原编号保持稳定，新增 **B08 后台读取调度**，合计为原 21 项加 1 项。该补充包是 `codex-desktop-reverse-full-20261028/`，不把结构化打包模块当作完整原始工程。以下只读核对没有运行附件脚本。

| 补充机制 | 对应条目 | 本次明确补充 |
| --- | --- | --- |
| 过程与最终回复分开呈现 | A01、A02、A04 | 末尾工具、审批/追问插入、相同 searchItemId 且内容一致的最终回复去重；不按正文相似度吞掉合法重试 |
| 界面更新时保住阅读位置 | A05、A06 | 渲染模式切换前保存可见单元身份和像素偏移，更新后补偿；这与跨会话/重启的阅读快照是两种验收场景 |
| 有条件合并后台读取 | 新增 B08 | 后台元数据请求的可合并条件、重连清理、子线程补载并发上限；先测 Ling 路径，不能全局合并 GET |
| 大对象传输与背压 | B06、C03 | 分块、序号、ACK 属于传输层；不等于 UI 可逐块渲染模型正文或所有分块缓存均有界 |
| 生命周期分代与并发合并 | B04、B07、C02 | 旧代读取/回调失效、快速退出重开、配置切换和实际排空联合验收 |

直接源码证据（均相对补充包根目录）：

- **R01**：`structured-source/modules/session/split-items-into-render-groups-bbfa674b23c3.js:190–286`。返回对象含 **25 个字段**；最终回复去重同时要求 final_answer、相同非空 searchItemId 和对象内容一致。不能将分析文档的“24 槽位”固化为 Ling 的数据结构。
- **R02**：`structured-source/modules/session/local-conversation-thread-de0d137b0115.js:15894–15947`。`getSnapshotBeforeUpdate` / `componentDidUpdate` 只在切换至 native history timeline 时尝试保存并补偿可见内容锚点；跟随末尾时跳过。它不是“任何更新均自动保存”的全局规则。
- **R03**：`structured-source/modules/entry/app-initial-b539f0af92f3.js:122202–122322`。后台 thread/read 共享条件、至多 500 条 read state、重连 hydration generation 清理，以及 collab 补载至多 2 个 worker。数字是参考实现的本地选择，不是 Ling 的默认参数。

“固定 1 秒重启”只能用于对应 Local Work executor 的观察，不推广为所有进程策略。JSONL 与 SQLite 的分工也不构成 Ling 引入第二套持久化权威的理由。A03/A06/A07 的当前实现状态沿本文“研究快照与后继实施”及各 owning plan 记录，不再作为尚未开发项。

## A. 会话体验

### A01 — 正文、执行事实与最终回复分工

- **参考设计**：C10 的 typed renderer 与 commentary/final 分工。普通叙述、工具事实和最终回复分别呈现，避免所有内容卡片化。
- **Ling 现状**：统一 ConversationTimeline、TimelineFactRow 和 response-level footer 已存在。`conversation-turn-response-ownership.md` 已补充用户气泡、最终回复、文件卡与复制归属；其具体规则优先于早期视觉稿中冲突的示例。
- **具体差距**：本轮未确认新的结构性缺陷。已有索引/历史设计的旧措辞不能当作“缺少 renderer”的证据；跨普通会话、私聊、频道及子代理的最新包一致性仍需按已有验收记录逐项核对。
- **修改方案**：沿用现有投影与 renderer，只修复可复现差异。保持一条 owning row、一个纵向滚动 owner、每个 response 一份最终操作栏。结构化结果继续留作权威证据，日常界面按现有规则抑制重复报告。
- **验收方式**：同一组事实在各 surface 的顺序、状态、归属一致；最终回复和文件卡不因过程折叠消失；滚出/滚回虚拟窗口不会新增 footer；整轮复制不混入私聊、子代理全文或原始日志。复用 `conversation-process-disclosure.spec.ts`、`timeline-response-presentation.test.mjs` 与现有 packaged 记录。

### A02 — 成功过程收敛，运行与异常保持可见

- **参考设计**：C10 的过程入口、工具分组与单条下钻；自动折叠细节结合既有用户截图要求，不从公开协议推导桌面 UI 规则。
- **Ling 现状**：`timeline-process-presentation.ts:34` 处理 attention，`conversation-timeline-display-model.ts:178` 强制展开；现有过程、activity、command/exploration batch 均为展示投影。`conversation-turn-process-disclosure.md` 有历史 packaged 验收记录。
- **具体差距**：主体已实现。新增活动呈现的 fixture 证据不能直接继承为新的真实流式、SSE 或 packaged 验收；本轮没有新复现的折叠缺陷。
- **修改方案**：继续使用现有分组 identity 和 view store；只补当前增量的证据缺口。完成判断依赖 Host 生命周期，缺归属/阶段的内容保持可见；不添加 batch 数据表或新的 summary 权威。
- **验收方式**：覆盖 live→settled、unknown、手动展开后 revision 更新、批量阈值变化、重试及子代理边界；待审批/失败/取消/部分成功覆盖手动收起偏好。复用 `timeline-process-presentation.test.mjs`，新增 GUI 补测仅针对尚未覆盖的差异。

### A03 — 单条命令的原文、复制与完整输出入口

后继状态（2026-10-29）：下述入口差距已在当前工作副本实现，并有单测与浏览器回归；剩余为同一新包中的真实命令、剪贴板及 Host 日志打开验收。初始差距保留作改动依据，详见实施检查点。

- **参考设计**：C10 的命令活动逐层展开；原命令、cwd、输出与退出结果属于单条执行事实。
- **Ling 现状**：`ConversationTimelineCommandRenderer.tsx:7` 把 command 放在轻量行标题/tooltip。`timeline-renderer-details.tsx:13` 的 CommandDetail 显示 cwd、输出 tail、输出规模、截断文案和执行结果；展开体没有独立 command 代码块、复制操作或可点击的完整日志入口。`detailExists` 也未把“仅有 command”作为详情依据。
- **具体差距**：长命令在 compact 行中省略显示；用户展开后仍缺少便于选择/复制的完整命令。截断时只有“open the full log from evidence”文字，该 CommandDetail 没有对应跳转控件。这里确认的是当前命令组件的入口差距，不宣称整个产品没有任何日志查看器。
- **修改方案**：在现有 CommandDetail 内增加可展示命令原文及复制、必要时复制输出；让仅有 command 的记录也可展开。沿用 owning item 的受验证 source ref 打开日志；没有完整日志证据时显示明确的不可用状态。通过现有 onOpenSourceRef 链路传递能力，不把模型写出的路径直接当权限。补齐文案国际化。
- **验收方式**：长命令、引号/多行命令、只有 command 的历史项均可完整查看和复制；展开不抢滚动。exit 0 且 stderr 非空仍按真实成功显示，非零退出/超时/取消分别准确；有日志 ref 时可打开，无 ref 时无虚假链接。命令详情不复制到最终回复后；本项需增加有意义的组件与浏览器回归。

### A04 — 异常、审批、追问与诊断的唯一归属

- **参考设计**：C10 将 permission/user-input/system-error 区别于普通正文；错误与等待需要可辨认、可处理的入口。
- **Ling 现状**：`timelineItemNeedsVisibleAttention` 已覆盖失败、阻塞、取消、部分成功、待审批、追问及子活动。`conversation-error-ownership-and-feedback-isolation.md` 定义精确 scope 的单一错误 owner；TimelineFactRow 在观察暂停时显示 Stale snapshot。
- **具体差距**：未确认新缺陷。尚需核对当前包中“已持久化的失败回复”和“尚无回复的传输错误”是否仍遵循同一归属；不能把 cancelled、blocked、unknown effect 合并成一个泛化失败。
- **修改方案**：复用现有 failure/status 投影与 Composer 控制。若出现重复错误或刷新清空错误，按原 scope/operation/epoch 修复；不要用消息文本猜状态，也不新增全局通用错误卡压住原行。
- **验收方式**：待审批、审批过期、追问未送达、Provider 中断、SSE 断连及结果待确认分别可见；频道 root/topic/branch 和不同工作区互不清空。子代理异常穿透父折叠；键盘可到达现有恢复操作；恢复通知不能改变原始失败历史。

### A05 — 流式滚动、阅读锚点与长历史窗口化

- **参考设计**：C10 的稳定 turn/item 与虚拟化；具体滚动策略采用 Ling 现有阅读契约，不据包文件推断 Claude 行为。
- **Ling 现状**：`use-conversation-reading-viewport.ts:60` 暂停追尾、按行锚点补偿；NormalConversationFeed 使用消息 ID 组成内容 identity。私聊使用相同 hook，频道保留其带分页锚点的滚动 owner；Timeline 只有一份行虚拟化。已有 P2 阅读稳定性测试与历史证据。
- **具体差距**：这些机制不是待新建能力。本轮没有真实抖动复现；当前代码存在保护逻辑，也不能单凭源码宣布所有流式组合已通过。
- **修改方案**：沿用原滚动 owner、rowKey、measurement-scroll 区分及 locator。新问题先记录是哪一项内容/布局变化触发，再最小修复；只有实际职责或行为差异要求时才继续收敛频道实现。
- **验收方式**：覆盖底部追尾、向上阅读、展开/收起、图片延迟加载、resize、虚拟化阈值跨越、历史 prepend、搜索和显式回到底部。沿用现有稳定布局后 ≤2 CSS px 锚点误差断言；性能预算先读已有记录并测基线。复用 `p2-reading-stability.spec.ts`、`p2-surface-reading.spec.ts`；真实模型/SSE 的证据独立标注。

### A06 — 按会话保存与恢复阅读现场

后继状态（2026-10-29）：本地阅读快照、范围隔离、过期/容量控制和展开偏好已有实现；恢复的收起偏好不会遮住后继 running/attention。浏览器回归已通过，实际桌面包的流式、历史补载及退出重开组合仍待验收。

- **参考设计**：从 C11 的历史连续性和 C10 的视图分工提出的 Ling 增量。现有外部材料没有证明 Codex/Claude 的具体阅读位置持久化策略，不将此建议包装成已取证行为。
- **Ling 现状**：`conversation-view-provider.tsx:15` 按 surfaceId 新建内存 store；`use-conversation-reading-viewport.ts:31` 在 scope 变化时清除锚点并恢复默认追尾。当前实现保护同一挂载内的阅读，但不按会话持久保存阅读锚点和展开偏好。
- **具体差距**：切到别的会话再回来、重新挂载或重启应用后，无法可靠回到先前阅读现场。这是明确的能力增量，不把原有“切换会话按默认追尾”测试称为实现错误，也不把它塞成已完成 P2 的遗漏。
- **修改方案**：给现有 view store 增加轻量、可清理的本地视图快照适配器，按本地 profile＋workspace＋surface＋thread 隔离。仅保存 stable row/item ID、相对偏移、用户明确展开偏好与版本/更新时间，设置容量/过期清理；不保存消息正文、密钥、权限、执行终态。恢复在历史数据可定位后进行；目标已失效时使用当前默认位置，不重新执行任务。多窗口的外部快照更新不强制移动正在阅读的窗口。
- **验收方式**：A→B→A、刷新、重启后恢复位置/展开；跨工作区同名 thread 不串状态。目标删除、历史尚未加载、损坏/过期快照均安全回退；恢复不会打开权限、触发模型/工具或隐藏新出现的 attention。相关切换会话测试按新产品行为更新，保留首次进入与显式 Jump to latest 的覆盖。

### A07 — 文件、Diff、图片与可交互产物的入口

后继状态（2026-10-29）：文件“更多”已迁入共享 view store，并验证重挂载和 reload 保留偏好。真实新私聊首次完成时另复现了 workspace 元数据晚到导致无持久 scope 的缺口；已用同一已验证 directThreadId 补齐，并取得延迟读取＋实际 Composer SSE 的 RED→GREEN。该后继修复仍待新包 GUI 复验；其他产物能力继续按原 owning plan 验收。

- **参考设计**：C10 的文件变更、Sources/Artifacts 与正文分工；Claude 的真实 Artifacts 交互仍须后续实机观察，当前包只能提供预览/宿主线索。
- **Ling 现状**：`ConversationTimelineResponseFiles.tsx:11` 已有前三文件、更多、净变更 Review 与不可用提示；workspace-file-capability 负责文件打开能力。附件/媒体预览和互动 HTML 也有独立入口与测试，见 `ux-gap-roadmap-02-gen-ui-artifacts.md`。
- **具体差距**：不是从零新增“产物面板”。文件卡“更多”用组件局部 useState，重挂载会回到默认值；是否在当前虚拟窗路径中造成可见丢失需浏览器核实。文档交付、内置浏览器等剩余功能已有各自计划，本轮未做全量完成度审计。
- **修改方案**：先核对真实入口与返回路径；若复现重挂载丢状态，将文件卡 disclosure 接入同一 view store。新文档/互动产物继续接既有 artifact 类型、预览和权限链路，复用 01/02 产物计划。Diff unavailable 保留原因；普通文件预览与历史净变更 Review 分开。
- **验收方式**：从 owning response 打开文件、图片、互动 HTML 与 Diff；关闭预览后保留阅读现场。超过三文件、滚出/回装、历史 diff 缺失、文件移动/删除和无能力 ref 均有准确反馈；预览不授予写权限；私聊内容不出现在父会话或全局产物列表中。

### A08 — 子代理活动的层级与定位

- **参考设计**：C10 的子代理活动分组、摘要与下钻入口。
- **Ling 现状**：现有 Timeline 展示模型投影 depth-1 child，保留 child 的 run/attempt/participant；locator 可展开 Agent、process、batch 的祖先路径；未创建第二个子 Timeline 虚拟器。
- **具体差距**：主体已实现。需核对当前新状态是否能穿透父折叠、历史来源能否定位隐藏原子项；多代理看起来“都结束”不能替代 B05 的完成证据。
- **修改方案**：沿用同一 display model、disclosure 和身份 rail。摘要仅表示真实任务/状态，完整 child 内容按需展开；父回复复制与计数不隐式合并私有子内容。根据实际缺陷补齐状态映射，不新增并排多份完整聊天。
- **验收方式**：多个 child 中仅一个等待/失败时可定位到对应 child；展开状态跨 revision 保留；source 导航自动打开正确祖先且不跳到同名 sibling。子代理结束、父仍运行和父停止/子尚未排空分别正确显示。

## B. 执行与恢复架构

### B01 — Ling 宿主与可替换 Agent 内核

- **参考设计**：C09 的 app-server 生命周期与 K01 的专用 Agent/runtime 接入，借鉴宿主与执行内核的职责分工。
- **Ling 现状**：`runtime/runners.ts:21` 默认 runner 为 Pi；RunnerRegistry 有工具与恢复一致性门禁。当前分支也已有 Codex/Kimi/OpenClaw native 接入及部分真实验收，不能再写成“这些适配器都还没有实现”。生产组合是否开放仍受 profile、可信验证及平台门禁约束。
- **具体差距**：主要是现有 native T7 与交付验收边界，见 `native-execution-engines-implementation-plan.md`。没有证据要求重建顶层 orchestrator 或替换默认内核。
- **修改方案**：保留 Ling 对任务、审批、事实、恢复和产物的所有权。新 runner 通过现有 adapter/conformance 接口接入，无法保证的工具子集、system 指令或恢复能力应明确拒绝；不暗中回落到另一账号/引擎。
- **验收方式**：Pi 与每个声明支持的 native 组合分别核对连接、指令/工具限制、事件投影、审批、取消与恢复；缺可信证据的组合保持不可用。源码、指定引擎候选、安装包和生产开放分别记录，接续原 T7，不用本表重置其进度。

### B02 — 取消、超时与真实停止

- **参考设计**：C09 的进程/lifecycle 分层，借鉴区分停止请求、进程事件和最终结算。
- **Ling 现状**：`run-execution-supervision.ts:17` 为 Pi/native 共用 Attempt 时钟、心跳和 exact-fence 停止写入；run-shutdown-coordinator、host completion 及 active run stop 已有实现。审批暂停与委派树绝对截止采用不同语义。
- **具体差距**：本轮未确认缺少取消状态机。现有 native 计划仍列有外部引擎停止及未知副作用边界；“客户端收到 abort”不能直接证明外部工作已停。
- **修改方案**：沿用原 RequestStop→实际排空→持久结算链路。无法确认的远端效果保留 unknown/blocked；将当前来源明确投影到会话，不用 UI 动画或关闭窗口代替停止确认。
- **验收方式**：空闲超时、硬超时、审批暂停、主动取消、工具子进程未退出、晚到成功回调及旧 Attempt 写回分别处理。旧 Attempt 不得覆盖新结果；取消的模型调用、工具和派生进程记录与实际状态一致。复用 `run-execution-supervision.test.mjs` 和 shutdown/原生验证记录。

### B03 — 审批等待、一次授权与续接

- **参考设计**：C10 的 approval/user-input 区分，以及 K03 的 elicitation/认证交互线索；确认问题与授予执行权限各自有明确语义。
- **Ling 现状**：已有 durable approval checkpoint、Host continuation、命令规则和 Composer 决策入口；pending operation 的 authority epoch/字段续接也已有当前实现。页面权限选择仍有并行 WIP，不能当作已发布行为。
- **具体差距**：不是新增一套审批中心。当前应核对多个 surface 的单一操作 owner、撤销/过期状态、重启后的批准消费及新权限 UI WIP 的实际联动。
- **修改方案**：复用 checkpoint、policy snapshot、exact fence 与现有 Composer gate。允许一次只消费原操作；修改目录/参数后按既有规则重新绑定或拒绝；审批反馈与“需要补充信息”分别投影。
- **验收方式**：批准/拒绝/过期/撤销、双击批准、重启前后批准、跨窗口同时操作和权限 ABA 变化；只补字段时原命令/owner 不变，旧授权不复活，副作用最多进入原有允许路径。复用既有有效证据，保存新的失败历史，不反复重跑已完成案例。

### B04 — 崩溃恢复、持久队列与副作用对账

- **参考设计**：C09/C11 的恢复读取与生命周期。将恢复建立在持久事实、当前所有权和可验证的执行结果上。
- **Ling 现状**：`daemon-recovery-coordinator.ts:45` 按 durable continuation 与分页面发现恢复；`tool-execution/recovery.ts:22` 处理遗留工具执行，并通过文件前后 hash 判定 applied/not_applied/unknown；SQLite、lease、Attempt fence 已是权威。
- **具体差距**：这些基础不是空白；剩余是 T13/H09 等原有联合验收和具体平台边界。当前 E6 的完整组合验收仍不能由单个 checkpoint 或报告中的 green 推定。
- **修改方案**：接续原恢复 barriers、claim/lease 与幂等规则；有已落库 tool_end 就从证据结算，只有 tool_start 且效果未知时阻塞，不自动再跑。保留失败记录、分页游标及分阶段启动，不迁入 Codex JSONL 双写方案。
- **验收方式**：在工具开始前、作用后但结果未落库、tool_end 后但 Run 未结束、审批已批准未消费等窗口中断/重启；核对无重复副作用、无孤儿租约、旧回调被拒绝、恢复结果可重开。必须使用隔离工作区/副作用计数器，不能用真实用户任务盲重放做试验。

### B05 — 子任务预算、required 汇合与父完成

- **参考设计**：C10 的多代理活动与执行结果分层；具体预算/汇合规则沿用 Ling 现有 Harness 合同。
- **Ling 现状**：`delegations/completion-wait.ts:10` 明确 SDK 返回仅结束模型生产，父完成等待后代实际停止及 required 成功 sealed 结果；registry、预算、权限子集与恢复归属已有实现。
- **具体差距**：不是只缺“多代理 UI”。目前需要补的是原计划的多 required、真实恢复和物理排空联合证据；不能把子代理消息说完成作为验收凭据。
- **修改方案**：复用现有 budget reservation、completion evidence 和父子所有权；父结果仅由 Completion Gate 结算。统一会话中 pending/failed/unknown 的解释与定位，不新增第二个 scheduler 或用内存 Promise 代替持久证据。
- **验收方式**：多个 required 中一个失败/未知、optional 失败、父取消时子仍运行、旧 child callback、预算不足和重启恢复；父成功必须满足真实 required 与排空条件。复用 `delegation-completion-wait.test.mjs`，结合实际小项目记录，保留原失败案例。

### B06 — 有界事件流、大输出与重连

后继状态（2026-10-29）：有界 writer 已接入 Run、普通会话、频道和私聊入口，真实 HTTP 慢读/断线回归确认停止观察后不再写 socket，Run 继续唯一持久结算。尚未完成全仓 SSE 入口审计或新包重连组合验收。

- **参考设计**：C08 的分块/ACK 和 C11 的快照＋增量读取。借鉴流量有界、慢消费者不拖累执行、断线后可重建；协议按 Ling 的 SSE/RPC 实际边界实现。
- **Ling 现状**：`shared/sse-stream-writer.ts:4` 已限制帧、缓冲和待发送条数，并有堵塞超时；`server/rpc-outbound.ts` 也有有界发送；大内容可走 artifact，remote projection 已有 outbox。HTTP drain 不等于远端用户已收到。
- **具体差距**：未发现需要从零引入背压。尚需核对相关事件入口是否都复用有界 writer，以及断线后的快照/replay 是否覆盖最新事实；本轮不宣称已完成全入口审计。
- **修改方案**：保留有界 writer 和持久 replay，修复实际绕过路径。大输出仅传 bounded preview/统计/source ref；不可重放的 UI 通知不作为唯一事实来源。仅在现有协议确有需求时增加分块，不整体照搬 Codex IPC。
- **验收方式**：慢读/停止读取客户端、超大单条输出、连续事件、连接中断、事件重复及乱序；内存/队列不无界增长，重连无重复 owning row、无状态回退。分别验证 transport 已写入、持久结果已提交和客户端已恢复，不混作一次“已送达”。

### B07 — 启动、退出与可操作诊断

- **参考设计**：C09 的生命周期管理与诊断、K01 本地窗口壳的重试/Reload/Restart。每种恢复动作应匹配实际故障层。
- **Ling 现状**：`daemon-lifecycle.ts` 已管理 readiness、owned process、启动/关闭及资源身份；`startup-lifecycle.ts:35` 合并并发打开并在退出时使旧代失效。Startup diagnostics 已列入已实现路线，完整安装/平台证据仍由原计划负责。
- **具体差距**：不是新增“诊断面板”。需要核对界面能否区分连接失败、引擎未就绪、服务身份不符和业务运行失败；本轮未测当前冷启动耗时，也不把已有面板存在等同于可诊断全部问题。
- **修改方案**：沿现有诊断对象和生命周期输出恢复动作。重连、重载页面、重启自有 Daemon、修复引擎分别保留适用条件；不停止身份未知进程。日志保留 run/attempt/时间及脱敏错误，不暴露密钥或要求用户理解内部字段。
- **验收方式**：首次启动、连接失败、端口被占、旧代晚回调、快速退出/重开、启动中退出；重复恢复不创建重复进程，退出后排空证据准确。复用 desktop lifecycle 测试与已有 diagnostics 计划，真实安装行为单列。

### B08 — 有条件的后台读取合并与并发调度（补充项）

- **参考设计**：R03 的 `readThread` 仅在 scheduler 开启、不含 turns、background、source 为 thread_hydration、未显式禁止 coalesce、无单独 timeout、无 clientUserMessageId 时标为可共享；durable 非 shared 线程与其他 Host 的 background lookup 分支各有条件。重连使旧 hydration generation 失效并清理缓存；collab 补载用两个 worker，而不是对所有请求无条件 Promise.all。
- **Ling 现状**：私聊 `use-teammate-private-timeline.ts:83–169` 已有单 owner 的串行读取、pending 合并、750ms 节流、终态紧急刷新和 Host observation epoch 校验；普通会话有 request/owner fencing 与历史分页。`packages/api-client/src/client.ts` 是公共请求入口，但本次定向阅读未确认跨消费者的“仅后台元数据”共享调度器。已有局部合并不能写成完全没有读取调度；尚未测出前台被预取拖慢。
- **具体差距**：原 21 项没有单独覆盖跨消费者重复后台读取、子线程补载的并发上界与前后台排队时间。这是新增的测量/优化候选，不是已经证实的性能故障。无依据把 Codex 的 2/500 或 Ling 私聊的 750ms推广为全局常量。
- **修改方案**：先按实际 endpoint/source/Host epoch 记录请求次数、并发、重复占比、排队及前台延迟。仅对证实重复且等价的只读后台元数据接入小范围 single-flight/有界队列；键须包括 Daemon 身份、workspace、surface/owner、参数、可见性与认证代际。前台读取、带独立超时/取消/消息归属的请求、历史正文页、mutation 和 SSE 不默认共享；某个订阅者取消不能取消其他 owner 的请求。切换工作区、权限变化、重连和卸载均失效旧代结果，沿用现有 observation/publication 门禁，不把缓存结果当执行权威。
- **验收方式**：记录同构建条件下前后台请求数量、峰值并发、排队及响应分布；可合并元数据只发一次，参数/owner/epoch 不同不混用，失败后可重新读取。后台队列满时前台仍能进入；取消一个消费者不影响其他消费者；重连、权限 ABA 和快速切换后旧结果不能发布；子线程补载有界且无重复 owning row。只有实测改善且原读取/恢复回归通过才启用，未达到条件保留现有局部调度。

后继测量：已完成真实 Daemon＋SQLite＋loopback HTTP 的隔离合成负载，模型调用为 0，详见 [探针与实际数据](../../packages/daemon/experiments/read-scheduling/README.md)。四个后台消费者下，前台 median 为 6.11/5.81ms，只有前台为 2.86/2.48ms；没有隔离队列耗时，也未测真实 UI 重复需求，因此暂不引入全局共享。另已确认私聊 GET 会创建/获取 thread 并 flush governance notifications，不能作为纯元数据共享候选。

## C. 扩展、原生能力与隔离

### C01 — MCP 连接复用、配置失效与旧代排空

后继状态（2026-10-29）：独立连接池原型与真实 SDK stdio/HTTP 本地测量已完成，同代十次调用的连接数由十次降为一次。原型默认关闭；生产 broker 仍须满足 Host/auth/撤销与恢复合同后才能接入。

- **参考设计**：K03 的专用 MCP 宿主及重连线索、C09 的运行时生命周期。single-flight、连接分代和在途绑定是给 Ling 的具体方案，不宣称这些细节已经从 Claude 包中得到动态验证。
- **Ling 现状**：`mcp/broker.ts:315` 的通用 withMcpClient 当前每次新建 Client、connect、执行后 finally close；已有 Host operation admission、实际发送复核、取消和有界关闭机制。
- **具体差距**：通用入口缺少跨调用连接复用是明确结构事实；是否构成用户可感知的性能问题尚无本轮测量。简单把连接放到全局 Map 会破坏原来按调用绑定的 Host 权限与恢复语义。
- **修改方案**：先记录 stdio/HTTP 的启动、握手、调用、认证、取消关闭耗时与连接数。制作独立复用原型，按 workspace/server/有效配置与凭据代际隔离，single-flight 建连、配置变化标脏、新代原子切换、旧代等待在途调用后关闭；每次调用仍有独立 admission、权限和结果校验。明确 Daemon 退出排空与闲置回收，不能让共享连接扩大某次 Attempt 的授权。
- **验收方式**：同代连续调用能在既定保活窗口复用连接；更换配置/凭据/禁用服务后不再接纳旧代新调用；并发首次调用不重复建连；取消一个调用不误杀其他 owner。比较延迟、内存、失败率与清理成本；满足原 Host 执行证明之前只算原型，不启用生产复用。

### C02 — MCP/Provider 的过期结果与认证生命周期

- **参考设计**：C09 的配置/生命周期分工、K03 的 OAuth/认证回调线索。旧配置的异步结果不能覆盖新配置。
- **Ling 现状**：`mcp/metadata-publication.ts:16` 有 durable admission、原子 commit 和 superseded 拒绝；`providers/check-publication.ts:14` 只发布已提交结果；`mcp/result-authority.ts:52` 校验 server/tools revision 与特定激活代际。
- **具体差距**：不能再把“没有过期结果保护”列为当前缺口。通用 OAuth 全状态、回调与凭据轮换是否完整覆盖，本轮没有全量核查；静态出现 PKCE 字段也不证明整个流程正确。
- **修改方案**：保留现有 request ticket 与事务提交；认证回调、工具目录更新和 C01 的新连接代际共用当前配置有效性校验。对实际未覆盖的认证状态补投影与恢复入口，不用 transport 成功冒充工具授权。
- **验收方式**：请求 A 慢、配置 B 后 A 才返回；删除/禁用时结果返回；凭据轮换、认证取消、重复回调、过期回调和重启。状态/目录/事件不得回退，已提交但 live notification 失败仍可 replay。复用 metadata/provider publication 测试，真实认证仅在专用测试账号/服务范围验证。

### C03 — 原生能力、IPC 来源与凭据

- **参考设计**：K01/K02 的专用原生桥和 C08 的能力端口。采用有限能力接口、明确来源与作用域；报告中“凭据绝不进入 JS”等结论不作为已证实前提。
- **Ling 现状**：已有 Desktop bridge、Host capability、SecretResolver 与 Keychain 路径。`main/local-files/ipc.ts:37` 在请求进入、异步检查后及菜单动作时重复验证窗口/frame/文档来源，是可复用的实际模式。
- **具体差距**：本轮只核对了代表性路径，未完成所有 IPC/凭据出口的安全审计，不能称“全部安全”或“全部缺少校验”。原生功能跨平台可用性仍有各自发布门禁。
- **修改方案**：新能力按现有 typed bridge 注册，并对实际高权限路径核对 sender、scope、异步后身份与撤销。前端只持必要的能力句柄/secret ref；生产密钥解析留给现有 Host 路径。沿原计划修复找到的具体遗漏，避免新增一条绕过 Daemon 的原生执行入口。
- **验收方式**：正确窗口可调用；iframe、其他窗口、导航后的旧 frame、撤销后晚到响应均被拒绝。敏感值不进入正文、快照、日志和导出；平台能力不支持时有明确状态。沿现有 local-files/desktop bridge 测试并补实际缺失路径。

### C04 — Computer Use、PiP 与权限状态

- **参考设计**：K02 的原生 computer-use 原语、C08 的预览媒体生命周期和能力隔离。具体产品交互需另行真实观察。
- **Ling 现状**：已有 coordinator、typed bridge、PiP、provider permission、锁屏撤销及清理/恢复逻辑。`desktop-computer-use-picture-in-picture-implementation-plan.md` 和 bundled CUA 计划保留 signed/clean-host/macOS/Windows 门禁；10-26 hardening 文档还有状态、watchdog、错误分类等跟进内容，具体完成度须按代码核对。
- **具体差距**：不是新增整套桌面控制。平台验收是明确待交付边界；hardening 文档写“待做”本身不能证明当前 coordinator 中不存在相应逻辑。本轮未启动控制或真实权限流程。
- **修改方案**：接续既有设置、coordinator 和 hardening owner；先逐项查代码/测试再补实际缺失的状态、watchdog、错误映射。Hide/Close 只影响呈现，Stop 等待 Daemon 确认；锁屏/撤销后旧媒体与输入权都不能复活。
- **验收方式**：授权拒绝/授予/撤销、锁屏、显示器变化、目标应用失去响应、driver 退出、旧帧晚到、反复开关 PiP。模拟帧/输入汇只能证明逻辑；真实 TCC、显示器、辅助技术和签名安装包证据另行完成，保留原 gate，不把原型测试洗成发布通过。

### C05 — 隔离执行后端与 VM 原型

后继状态（2026-10-29）：已完成两次真实 Virtualization.framework 最小 RAM guest 实验，覆盖受限读写、产物导出、正常停止和取消后实际停止。当前生产路径仍未接入 VM；网络策略、生产 RPC 和恢复边界不能从该原型推定通过。

- **参考设计**：K02 的 Virtualization.framework、guest RPC、挂载与网络相关符号，以及 C12 的沙盒策略集中管理。宿主代理/证书符号不能直接证明所有流量都被审计。
- **Ling 现状**：`runtime/sandbox/native-process-launch.ts:23` 的这一原生执行边界在 darwin 使用 sandbox-exec 并限制路径/网络；不能据此外推所有 runner/平台。当前核对的标准执行路径未显示 Cowork 式 VM 后端，也没有 VM 的新实机证据。
- **具体差距**：VM 级客体隔离是可新增的架构能力，需要明确平台支持、资源成本及挂载/网络/恢复合同；它不是“现有进程沙盒还没写”的同义词。
- **修改方案**：先做独立、默认关闭的最小执行后端原型：单任务、只读挂载、显式可写输出目录、默认禁网、Host RPC、取消/退出和产物导出；继续由现有 Run/Attempt/Broker 管权限和结果。首个原型不注入真实 SSH 私钥/用户 cookie，不引入 CA/EDR 等扩展。完成证据后再决定生产接入及后续功能。
- **验收方式**：客体读不到未挂载 canary，越界写入失败；只允许指定输出回收；禁网与允许列表实际生效；取消/崩溃后客体及挂载排空，无旧任务复活。测冷启动、内存/磁盘和工具兼容性，与现有执行后端比较；保存平台、镜像/代码版本和限制，不预设性能提升。

### C06 — 桌面壳、首屏快照与定制 Electron 研究

后继状态（2026-10-29）：同一真实 macOS QA 包首次新 profile 与同 profile 重开，module→window loaded 分别为 32,026 / 24,134 ms，资源准备占 31,335 / 23,448 ms。样本与全套测试负载重叠，不构成受控性能对比；首帧、可输入和 RSS 未测。阶段证据见实施检查点，尚无更换 Electron 或跳过资源校验的依据。

- **参考设计**：C08 的首屏 bootstrap、主题初始化、共享对象增量及专用 worker；C12 的定制运行时线索。包结构证明技术存在，不证明 Ling 采用后必然更快。
- **Ling 现状**：共享 Web UI＋Electron 壳＋Daemon 已是当前形态，启动/退出 owner 已存在；主题持久化、diagnostics、native worker 也各有实现/计划。本轮未做冷启动性能 trace，也未证明标准 Electron 是当前瓶颈。
- **具体差距**：当前可确认的是缺少本轮针对该候选的性能证据，不能把“没有定制 Chromium”直接列成产品缺陷。主题闪变、空侧栏、主进程阻塞均需真实复现后才成立。
- **修改方案**：先测进程启动→首帧→首屏数据→可输入各阶段，核对现有主题/bootstrap 与 worker 边界。只对实测瓶颈做最小优化；同步首屏数据仅限极小、必要、无 I/O 的内容，不迁入同步 DB/网络请求。若仍有标准 Electron 无法满足的具体能力，再做隔离的底层原型，单列长期升级、签名和维护成本。
- **验收方式**：同机同构建条件对比冷/热启动、主题首帧、已有历史首屏和可输入时刻；同时确认主进程响应、退出、macOS/Windows 行为无回归。底层原型必须展示可复现收益和升级可维护性，不能只以“能编译”决定替换。

## 执行与交付记录方式

每项执行时追加到原 owning plan 或本项的独立证据文件：`ID → 本次精确源码/构建 → 改动 → 验证 → 结果 → 未完成项`。本表保持为快照对照，不承载新一份长期进度账。

1. **新增能力**：A03、A06 先按现有组件/存储边界拆为小改动；A07 只有在实际路径或重挂载差异成立时改动。
2. **已有能力收口**：A/B 组先读取既有证据，仅补未覆盖的场景或修复新复现问题。文档的旧状态、截图标题或单个状态字符串都不足以重开已完成工作。
3. **架构候选**：C01/C05/C06 先测量或原型；代码存在、原型通过、生产启用和平台发布分别记录。不会因“借鉴”自动更换执行内核、存储权威、用户凭据或运行环境。
4. **UI/真实执行证据**：记录实际 surface、工作区、thread/run/attempt、构建与场景，必要时保存截图/语义状态/脱敏日志。fixture、真实模型、历史重开和实际平台安装各自标注，不能互相代替。
5. **完成定义**：明确具体行为已实现且对应验收满足；源码修改、测试通过、PR、合并、安装和发布分别报告。本文没有把任何新修改或新验收标为完成。

## 现有权威文档入口

- [实现状态索引](../design/implementation-status.md)
- [会话 surface 契约](../design/conversation-surface-contract.md)
- [会话视觉契约](../design/conversation-codex-parity-visual-spec.md)
- [回复与文件归属](../design/conversation-turn-response-ownership.md)
- [过程折叠](../design/conversation-turn-process-disclosure.md)
- [P2 会话体验计划](../design/five-point-optimization-implementation-plan.md)
- [Harness 计划](../design/ling-harness-gap-closure-implementation-plan.md)
- [Runtime Supervisor](../design/runtime-supervisor.md)
- [原生执行引擎计划](../design/native-execution-engines-implementation-plan.md)
- [已有竞品差距路线](../design/ux-gap-roadmap.md)
- [Computer Use 加固](../design/ux-gap-roadmap-06-computer-use-hardening.md)
- [PiP 平台验收](../design/desktop-computer-use-picture-in-picture-implementation-plan.md)
- [内置 CUA 平台验收](../design/cua-driver-bundled-embedded-implementation-plan.md)

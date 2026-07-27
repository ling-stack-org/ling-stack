# Ling UI 2.0 文档入口

## Status

Design source of truth. Implementation is in progress: package foundations、forms、Dialog/Drawer、
Popover/Tabs/Segmented、Feedback/Data Display、P2A ThemeRegistry/independent Theme Packs、P2B.1
Presentation Profile/Theme Compiler foundations, selected Desktop slices, Shell/Sidebar and all three conversation
surfaces exist. Web 主产品面大部分已验证；T13-P.3 已完成 canonical closeout，剩余重点是明确的产品决策门和
packaged macOS/Windows 证据。Channel、Normal Conversation 和 AI 队友私聊的 UI 2.0 会话切片已全部关闭。
First Run 的 A/B/C 产品语义等待用户确认；
`P7A.1 Settings Shell foundation`、`P7A.2 Settings Profile`、
`P7A.3 Default Authorization + Personalization`、P7A.4 当前可达的 Interface Preferences 与
`P7A.5 External Work`、`P7B.1 MCP Tool Servers` 与 `P7B.2 Skill Library` 已验证关闭。Skill Library
七个可达 Function ID 已有自动化和六张实页证据；官方来源更新继续 `inventory`。
`P7B.3 Archived Items`也已完成 focused design/implementation plan、四类对象、七个 Function ID、组件/CSS 迁移、
focused `5/5`、existing `19/19`、selected `29/29` 和六张实页证据，现已 `verified`。`P7B.4 Startup +
Run Diagnostics` 也已完成组件/view-model、scoped Runs adapter、398 行 focused CSS、package `41/41`、focused
`5/5`、Settings `17/17`、Runtime `19/19`、selected `25/25` 和六张原尺寸实页证据，七项已 `verified`。
`P7B.5 Settings Workspace Tools 嵌入态` 的 reachability 审计、零决策设计、matching implementation plan、
4 个 Function ID、shared embedded surface、死 overview/CSS 删除、两处共享 Dialog、selected `88/88`、
focused evidence `7/7` 和六张实页证据已闭环，现为 `verified`。原尺寸审查发现并修复了 Model Editor
定位和长列表 toolbar/table 叠压。`P7C.1 Web Theme Pack Management` 也已按 D1=A token+preview、
D2=A Web-first 完成：package `45/45`、focused `5/5`、selected `83/83`、六张原尺寸证据及
metadata 均通过，现为 `verified`。Desktop app-data/typed IPC/packaged restart 仍是独立明确待办，
P7C.2 Quick Theme Studio 的 entry audit、图片验证/分析、IndexedDB v3 草稿、纯 reducer
和 package-owned 四 surface/五 viewport Preview substrate 已完成，package `50/50`、focused `4/4`、
Theme 联合 `15/15`。D3 runtime artwork 安全边界等待用户选择，生产 controller/UI/publish 不提前接线。
P8.1 AI Teammate Management 已不是当前执行入口：List/Search 已以 focused `4/4`、selected `30/30`
和四张证据关闭；Default roles/Create 又以 shared Dialog/Form/Feedback、focused `5/5`、selected `35/35`
和五张证据关闭；Profile/Avatar 又以 shared crop、protected policy、folded persona、scoped feedback、
focused `6/6`、Teammates `21/21`、selected `16/16` 和五张证据关闭；Model 又以 focused
controller/view-model、managed path、单一状态与 Header actions、focused `6/6`、selected `36/36` 和五张
证据关闭；Skills 又以 focused controller/view-model、shared controls/overlays、focused `13/13`、selected
`52/52` 和五张证据关闭；Permissions 又以 Core resolver、只读能力上限与 Workspace 默认预览、focused
`5/5`、selected `60/60` 和六张证据关闭；Tasks 又以 scoped Recent Tasks、私聊消息转任务、活动成员
频道、Runs/Work Board 路由、focused `9/9`、selected `49/49` 和六张证据关闭；Activity 又以五类来源、
100 条 recent 边界、retained refresh、身份竞态保护、focused `6/6` 和五张证据关闭。以上八项均为
`verified`，现有自定义队友创建完整保留。Memory 也已按 A 边界完成 scopes、健康、Workspace 治理、
导入和审计生命周期，未增加永久删除。Danger 已迁入共享 Dialog/Field/Input，关闭 browser confirm、
独立 disable/delete busy 与 protected 零 mutation，focused `5/5`、selected `36/36` 和六张证据闭环。
Council A 的 Create/Clone、List/Health、Members、Channels 与 Settings/Archive 已完成权威 detail 投影、源漂移
复核、单一 readiness、完整 policy、removal-only、draft/lifecycle 和 Archive Dialog 边界，分别关闭
`COUNCIL-CREATE-001`、`COUNCIL-LIST-001`、`COUNCIL-MEMBERS-001`、`COUNCIL-CHANNELS-001` 与
`COUNCIL-SETTINGS-001`；runtime provenance 继续独立 inventory。MCP 仍等待决策；Teammate Channels 已以
focused `7/7`、selected `30/30`、
6 张原尺寸证据和 metadata 关闭。T12.1/T12.1a Shared Input containment 也已关闭：package `51/51`、focus geometry
与 pixel containment `3/3`、普通对话与队友 Header/Search `4/4` 均通过；普通 focus ring 使用内描边，
共享与迁移期裸输入框不再向外扩张。2026-07-24 的截图复核进一步移除 Conversation Header Search 的
`30px` native line-height，恢复 `20px` token 并补齐 caret 视觉留白断言；三类 Header/Search `8/8` 通过，
未增加全局 `input:focus` 规则。2026-07-27 的 T12.1d 又将 Web 18 个 checkbox/file/range 和 package
task-list checkbox 纳入显式 native owner，并删除 `components/workspace/layout` 中全部 aggregate
input/textarea default/focus/disabled/theme branch；代表性 browser `38/38` 与 formal recapture `13/13` 通过。
原图审查发现并修复 1280 Dark Teammate MCP Header identity/action 碰撞。U13 聚合 CSS 收口又完成 `T13-O.2/O.3`：AI Teammate MCP
的 328 行视觉归入 focused owner，`teammates.css` 降至 1,435 行；共享消息正文的 580 行
Markdown/GFM/Mermaid/KaTeX 样式归入 conversation package，`components.css` 降至 10,009 行。
MCP `7/7`、package `10/10`、三类正文 `3/3` 和三类 Feed/Composer `11/11` 通过，未提升任何 Function ID。
`T13-O.4` 又将 Channel execution proposal、requirement shaping、collaboration 和 edit form 的 24 个 class
family 收敛到 511 行 focused owner；`T13-O.5` 随后把 Context Source Detail、Context Packet 与 Workflow
Context 的 65 个 selector 收敛到 372 行 focused owner；`T13-O.6` 再把跨频道、普通对话和私聊的 271 行
Terminal Report 视觉迁入 shared focused owner；`T13-O.7` 又把消息组、气泡、正文、meta、reply 与 action 的
298 行共享基线从 `layout.css` 迁入 `conversation-message-frame.css`；`T13-O.8` 继续把文本/图片 Artifact Preview
和四种图片比较模式的 319 行视觉迁入 `shared/conversation-artifact-preview.css`；`T13-O.9` 又把 Channel/私聊
共享 Status/Guidance 迁入 240 行 `shared/conversation-runtime-feedback.css`，并将动作接入 shared
Button/IconButton/Textarea/Radix Menu。O.9 后 `components.css/layout.css` 为 `8,289/1,321`，新的 message-frame owner
保留 9 个无等价 token 的历史 `rgba()`，并明确登记后加载聚合文件中
14 个有意的最终视觉覆盖。O.7 三类 Feed/Composer `11/11`、频道/私聊语义场景 `4/5 + 1/1`、
console/pageerror/overflow 与 Web static/build 均通过；O.8 focused `2/2`、既有 Channel/Runtime 回归 `2/2`、
焦点恢复、reduced motion、containment、selector 与 Web static/build gate 也全部通过；O.9 package `12/12`、
focused `2/2`、完整 Channel + Teammates `126/126`、Menu keyboard/Esc/outside/focus-return 与静态/构建 gate
通过，并删除两份零消费者 Web 重复组件。`T13-O.10` 又将角色详情、Advanced、Prompt 与 Workflow 的视觉收敛到
308 行 `teammate-management-role-detail.css`，删除零消费者旧 Sheet/Hero/phase-token，并把 Channel compact
workflow 与私聊角色标签分别归还其 focused owner；`teammates.css/components.css` 降至 `946/8,259` 行。
focused `3/3`、Create `5/5`、Settings/Teammates/Dark `40/40`、Channel + Web release `117/117` 和三张原尺寸证据
通过。`T13-O.11` 再把跨 Channel、AI 队友私聊与 Runs 的 Conversation Evidence 收敛到 309 行
`shared/conversation-evidence.css`，删除 69 行零消费者 avatar-stack CSS，并将 Evidence disclosure 接入 shared
Button。focused `3/3`、Runs `7/7`、私聊 Feed/Composer `4/4`、频道 web evidence `1/1`、三张原尺寸证据与
static/build gate 全绿；`components.css` 降至 7,842 行。两处 package barrel 消费方已改为直接导入，生产构建
不再报告对应循环 re-export 告警。`T13-O.12` 又把 shared FileChange/DiffViewer 基线收敛到 256 行
`shared/conversation-file-diff.css`，修复 preview request 自取消/失败循环，并补回 ArtifactRow 迁移遗漏的紧凑
布局。focused `4/4`、selected `49/49`、四张原尺寸证据与 static/build gate 全绿；`components.css` 降至
7,584 行。`T13-O.13` 继续将三类会话 Summary 与 Runs Summary Row 收敛到 279 行
`shared/conversation-summary.css`，删除约 200 行无生产消费者的旧 attention queue family；截图跟进的
`T12.1b` 又修复 Activity/Work Thread 的 `34px shell / 36px native input` focus 越界，并对 MCP/Channel Create
嵌套 raw input 补齐局部 containment。focused Summary/Evidence `9/9`、Input `4/4`、MCP `2/2`、selected
`152/153 + exact repeat 2/2` 与 static/build gate 通过。`T13-O.14` 随后将三类会话 WorkCell 的 Activity、
Details、CommandBatch、shell command、inline change preview 和 evidence links 迁入 720 行
`shared/conversation-work-cell-activity.css`，删除 15 个 dead rules / 16 个 dead branches；focused `5/5`、
selected consumer `6/6`、完整 File Diff `4/4` 和六张原图通过。`T13-O.15` 再将 WorkCell Shell、
Artifact/Reference、changed group、hover preview 与 Channel adapter 迁入 690 行
`shared/conversation-work-cell-shell-artifacts.css`，删除 25 个 dead rules / 30 个 dead branches，并补回
Artifact Row 的 32px Open With owner；focused `3/3`、组合 `12/12`、宽回归 `147/147` 和五张证据通过。
`T13-O.16` 又将 Channel Activity shell、Filters、Drilldown、Triage 与暂未开放的 Work Thread tree 收敛到
556 行 `channel-activity-work-thread.css`，删除 4 个 dead rules 和 1 个 dead mixed branch；19 行
`channel-activity-controls.css` 继续作为 34px nested input 的最终 owner。focused `2/2`、现有 Channel Activity
`7/7`、Runtime/Dark/Input `25/25`、七张证据与 static/build gate 全绿。`T13-O.17` 随后把 AppShell Sidebar
展开态 shell、主导航、section、对象行、分支创建/list 与底部设置入口收敛到 737 行
`app/sidebar-layout.css`，删除确认无消费者的旧 brand/toolbar/inbox/hash/mention/config family；focused 与既有
Sidebar `12/12`、App/Channel/Teammates/Archive/Dark `149/149`、十张证据和 static/build gate 全绿。`T13-O.18`
继续将 48px compact rail、三个 section preview/stack、identity/action visibility 与 hover/focus 收敛到 396 行
`app/sidebar-rail-sections.css`，并删除 `<=900px` 的完整重复 compact family；focused + existing Sidebar
`16/16`、宽回归 `149/149`、九张证据和 static/build gate 全绿。`T13-O.19` 随后释放 Model Workbench
被 `components.css` 与 `strict-console.css` 抢占的旧 Provider repaint：18 个 dead roots、旧七列表格、旧 panel
header/menu 和 pre-primitive 分支归零，632 行 focused cluster 与 shared primitives 成为真实 owner；Model
`25/25`、Settings/Dark `26/26`、宽回归 `149/149` 和八张重采证据通过。`T13-O.20` 又释放 Automations
被 strict/generic workspace blanket 抢占的旧视觉所有权：11 个 dead roots 删除，剩余聚合规则只保留
`:where(:not(.workspace-automations-surface))` negative exclusion，focused CSS 与 shared primitives 成为真实 owner；
focused `6/6`、legacy `2/2`、现有联合 `68/68`、宽回归 `149/149`、八张 Light/Dark/imported Theme 证据与
static/build gate 全绿。`T13-O.21` 随后释放 Teammates legacy writer：946 行 `teammates.css` 与 import 删除，
strict/components 中的 Teammates repaint 归零，59 行 management shell、19 行 shared Avatar、235 行 private
Feed/Composer 与 299 行 Message Frame 成为真实 owner；新专项 `8/8`、focused selected `19/19`、全部管理专项
`74/74`、跨模块 `171/171` 和八张 Light/Dark/Quiet Ocean 证据通过。`T13-O.22` 继续删除 10 个零引用的
Channel Tabs / Task Strip family，并将唯一存活的 `task-strip-head` 收敛到 Channel Activity focused owner；新专项
`3/3`、selected `43/43` 和三张 Light/Dark/Quiet Ocean 证据通过。频道完整套件为 `104/105`，唯一失败是既有
Tokenized Composer 连续 fill 偶发残留，独立重复 `2/3`，已登记为后续行为稳定性候选。
`T13-O.23` 随后释放 Run Guidance legacy writer：`components.css` 的 74 行旧手写 input/list/row family 删除，
4 行 `runs/guidance.css` 成为唯一 live panel owner；新专项 ordinary/capture 各 `3/3`、Runs/Runtime `26/26`、
selected `41/42`、broad `157/158` 和三张证据完成。两个组合失败均与 O.23 selector 无交集：Menu outside-click
独立 `1/3`，Teammate membership 独立 `3/3`，已如实登记为独立稳定性风险。`T13-O.24` 又释放 Media
Workspace root 和 24 组 Dark descendant blanket：canvas-first focused shell 成为唯一正向 owner，后加载
AppShell 滚动规则在首次失败后补为第 31 个 exclusion。focused ordinary/capture 各 `3/3`、selected `31/31`、
broad 最终 `64/64` 和三张原尺寸证据通过；Media preview 多元素 locator 经隔离 `1/3` 后收窄到 hero，复跑
`3/3`。`T13-O.25` 随后释放 Channel Right Dock 聚合 writer：161 行 focused shell 只持有布局、resize 与动效，
共享 package 重新成为 Header/Body/背景和控件 chrome 的真实 owner；旧 Review/panel/management family 归零。
focused ordinary/capture 各 `3/3`、selected `26/26`、Channel/Workspace/Dark/Theme broad `125/125` 和三张原尺寸
证据通过。最终静态门禁又删除 `layout.css` 中最后 12 行零消费者 `.channel-files` writer。
`T13-O.26` 随后产品化 Runs/Threads intervention 行：Run Guidance 使用 actionable 模式，Thread Evidence 使用
read-only 模式，六种状态拥有专用 tone，长指令默认三行并在展开后使用 240px 内部滚动。focused ordinary/capture
各 `3/3`、selected `36/36`、broad `48/48` 和三张原尺寸证据通过；全局 Input/DataRow/API/状态机均未改。
`T13-O.27` 又将 MessageRow/MessageBubble/MessageActionBar 通用结构与状态交给 conversation package，Channel
Turn/Transcript 交给 438 行 focused owner，并解除 Normal 对 `channel-message-row` 的借用。package `17/17`、
focused ordinary/capture 各 `3/3`，三张 Light/Dark/Quiet Ocean 原图通过；selected `30/31` 与 broad 初始
`160/165` 的残余均已在账本中区分为旧 Tooltip/hover 测试合同或独立 Guidance Menu outside-click，真实独立 AI
宽度回退已修复并精确复跑 `1/1`。O.27 closeout 时 Web CSS 为 160 文件 / 34,438 行，`components.css=2,890`、
`strict-console.css=434`、`layout.css=907`。Function ID 不变，packaged Desktop 仍待独立验证。
`T13-O.28` 随后将上述旧 action/hover/Tooltip/outside-click 断言迁到 exact ARIA action、Radix Tooltip Portal、
semantic hover 和真实 composer 外部目标；原失败场景 `5/5`、selected conversation `31/31` 通过，生产代码未改。
`T13-O.29` 又删除 Legacy Workspace Prototype 的 28 个零消费者 class family，保留 mixed selector 的 live branch；
`layout/components/strict` 合计净减 423 行。`T13-O.30` 同时删除 11 个 Web 会话重复实现，让 MessageBubble 与
CopyActionButton 只保留 Web renderer/i18n 薄适配，并将 Reply/Copy 统一到 Radix Tooltip。package `18/18`、
focused ordinary/capture 各 `8/8`、broad `165/165` 和六张原图通过；当前 Web CSS 为 160 文件 / 34,015 行，
`components.css=2,856`、`strict-console.css=421`、`layout.css=531`。该时点剩余 raw input 后由 T12.1c 页面迁移关闭，
没有新增全局 `input:focus`。`T13-O.31` 又让 conversation package 持有 canonical Composer shell/input，
301 行 shared slot owner 持有三面共享附件、picker、drop hint 与 file-reference，三个 focused owner 只保留
surface adapter；四个 compatibility class、aggregate/strict duplicate writer 与两个零消费者组件归零。package
`20/20`、focused ordinary/capture 各 `4/4`、既有 Composer/Form `18/18`、broad `165/165` 和三张原图通过；
Web CSS 为 161 文件 / 33,864 行，`components.css=2,202`、`strict-console.css=386`、`layout.css=494`。
`T13-O.32` 又将 Plugin root 从后加载 strict Dark 的 1 个 root repaint 和 21 个 descendant blanket 中
完整释放，删除 1 行空 CUA facade/import 与 dead token，并以公开 InlineFeedback detail slot 取代两个
package-private Feature selector。package `51/51`、focused ordinary/capture 各 `4/4`、Plugin `17/17`、
App/Dark/Theme `26/26`、representative release gate `12/12` 和三张原图通过；Web CSS 为 160 文件 /
33,861 行，`strict-console.css=385`。`T13-O.33` 随后删除四个零消费者 Route Explanation 根 family，保留真实
Routing Inspect grid/section 与 adjacent live branches；focused ordinary/capture 各 `3/3`、selected `18/18`、
static/build 和两张原图通过，O.33 自身净删 87 行。T12.1c 随后将 38 个可达 raw text controls 全部迁入
shared Input/Textarea/Field；lint 锁定 `reachable=0, decision-gated=1/1`，focused `22/22`、三类 Header
`8/8`、业务回归 `142/142` 和 16 张证据通过。共享工作树当前机械快照为 `161 CSS / 33,745 行`；
该总数包含其他进行中的共享树变动，不能全部归因于 T12.1c。当前 UI 2.0 工作量加权进度仍按既有阶段模型
记录为 `90.6%`，严格
Function ID 证据闭环率仍为 `68.8%`；O.29-O.33 不代表 U13 或整个 UI 2.0 完成。O.29-O.33 证据见
[`evidence/features/layout-legacy-prototype-dead-family/metadata.md`](evidence/features/layout-legacy-prototype-dead-family/metadata.md)
、[`evidence/conversations/conversation-package-boundary/metadata.md`](evidence/conversations/conversation-package-boundary/metadata.md)
、[`evidence/conversations/conversation-composer-ownership/metadata.md`](evidence/conversations/conversation-composer-ownership/metadata.md)
、[`evidence/features/plugin-manager-legacy-writer/metadata.md`](evidence/features/plugin-manager-legacy-writer/metadata.md)
、[`evidence/conversations/channel-route-explanation-dead-css/metadata.md`](evidence/conversations/channel-route-explanation-dead-css/metadata.md)
与 [`evidence/features/raw-text-controls/metadata.md`](evidence/features/raw-text-controls/metadata.md)。O.11 证据见
[`evidence/conversations/shared-conversation-evidence/metadata.md`](evidence/conversations/shared-conversation-evidence/metadata.md)。
O.12 证据见
[`evidence/conversations/shared-conversation-file-diff/metadata.md`](evidence/conversations/shared-conversation-file-diff/metadata.md)。
O.13 证据复用并重采
[`evidence/conversations/shared-panels/metadata.md`](evidence/conversations/shared-panels/metadata.md) 与
[`evidence/conversations/shared-conversation-evidence/metadata.md`](evidence/conversations/shared-conversation-evidence/metadata.md)；
nested input 证据见
[`evidence/settings/ui-form-foundation/metadata.md`](evidence/settings/ui-form-foundation/metadata.md)。
O.14 证据见
[`evidence/conversations/shared-conversation-work-cell-activity/metadata.md`](evidence/conversations/shared-conversation-work-cell-activity/metadata.md)。
O.15 证据见
[`evidence/conversations/shared-conversation-work-cell-shell-artifacts/metadata.md`](evidence/conversations/shared-conversation-work-cell-shell-artifacts/metadata.md)。
O.16 证据见
[`evidence/conversations/channel-activity-work-thread/metadata.md`](evidence/conversations/channel-activity-work-thread/metadata.md)。
O.17 证据见
[`evidence/shell/sidebar-foundation-layout/metadata.md`](evidence/shell/sidebar-foundation-layout/metadata.md)。
O.18 证据见
[`evidence/shell/sidebar-rail-sections/metadata.md`](evidence/shell/sidebar-rail-sections/metadata.md)。
O.19 证据见
[`evidence/features/model-workbench/metadata.md`](evidence/features/model-workbench/metadata.md)。
O.20 证据见
[`evidence/features/automations/metadata.md`](evidence/features/automations/metadata.md)。
O.21 证据见
[`evidence/features/teammates-legacy-writer/metadata.md`](evidence/features/teammates-legacy-writer/metadata.md)。
O.22 证据见
[`evidence/features/channel-task-strip-legacy-writer/metadata.md`](evidence/features/channel-task-strip-legacy-writer/metadata.md)。
O.23 证据见
[`evidence/features/run-guidance-legacy-writer/metadata.md`](evidence/features/run-guidance-legacy-writer/metadata.md)。
O.24 证据见
[`evidence/features/media-workspace-root-ownership/metadata.md`](evidence/features/media-workspace-root-ownership/metadata.md)。
O.25 证据见
[`evidence/conversations/channel-right-dock-legacy-writer/metadata.md`](evidence/conversations/channel-right-dock-legacy-writer/metadata.md)。
O.26 证据见
[`evidence/features/run-intervention-row/metadata.md`](evidence/features/run-intervention-row/metadata.md)。
O.27 证据见
[`evidence/conversations/message-transcript-ownership/metadata.md`](evidence/conversations/message-transcript-ownership/metadata.md)。
Skill Library 证据见
[`evidence/settings/skill-library/metadata.md`](evidence/settings/skill-library/metadata.md)，Archived 证据见
[`evidence/settings/archived-items/metadata.md`](evidence/settings/archived-items/metadata.md)，Startup/Diagnostics
证据见 [`evidence/settings/startup-diagnostics/metadata.md`](evidence/settings/startup-diagnostics/metadata.md)。
Workspace Tools 证据见 [`evidence/settings/workspace-tools-embedded/metadata.md`](evidence/settings/workspace-tools-embedded/metadata.md)。
Theme Pack 证据见 [`evidence/settings/theme-packages/metadata.md`](evidence/settings/theme-packages/metadata.md)。
Teammate List 证据见
[`evidence/features/ai-teammate-management-list/metadata.md`](evidence/features/ai-teammate-management-list/metadata.md)。
Teammate Create 证据见
[`evidence/features/ai-teammate-management-create/metadata.md`](evidence/features/ai-teammate-management-create/metadata.md)。
Teammate Profile 证据见
[`evidence/features/ai-teammate-management-profile/metadata.md`](evidence/features/ai-teammate-management-profile/metadata.md)。
Teammate Skills 证据见
[`evidence/features/ai-teammate-management-skills/metadata.md`](evidence/features/ai-teammate-management-skills/metadata.md)。
Teammate Permissions 证据见
[`evidence/features/ai-teammate-management-permissions/metadata.md`](evidence/features/ai-teammate-management-permissions/metadata.md)。
Teammate Tasks 证据见
[`evidence/features/ai-teammate-management-tasks/metadata.md`](evidence/features/ai-teammate-management-tasks/metadata.md)。
Teammate Activity 证据见
[`evidence/features/ai-teammate-management-activity/metadata.md`](evidence/features/ai-teammate-management-activity/metadata.md)。
Teammate Memory 证据见
[`evidence/features/ai-teammate-management-memory/metadata.md`](evidence/features/ai-teammate-management-memory/metadata.md)。
Teammate Channels 证据见
[`evidence/features/ai-teammate-management-channels/metadata.md`](evidence/features/ai-teammate-management-channels/metadata.md)。
Teammate Danger 证据见
[`evidence/features/ai-teammate-management-danger/metadata.md`](evidence/features/ai-teammate-management-danger/metadata.md)。
Council Create/Clone 证据见
[`evidence/features/council-create-clone/metadata.md`](evidence/features/council-create-clone/metadata.md)。
Council List/Health 证据见
[`evidence/features/council-list-health/metadata.md`](evidence/features/council-list-health/metadata.md)。
Council Members 证据见
[`evidence/features/council-members/metadata.md`](evidence/features/council-members/metadata.md)。
Council Channels 证据见
[`evidence/features/council-channels/metadata.md`](evidence/features/council-channels/metadata.md)。
Council Settings/Archive 证据见
[`evidence/features/council-settings-archive/metadata.md`](evidence/features/council-settings-archive/metadata.md)。
Model Workbench Web 也已完成 11 个 Function ID 的 UI 2.0 closeout；T13-O.19 释放 legacy writer 后，focused、
P13 productization 与 legacy 联合 `25/25`，8 张 Light/Dark 原尺寸 changed-state 证据已重采并复核 SHA-256；
`MODEL-DESKTOP-001` 因缺少真实 Electron macOS Retina 与 Windows 125%/150% 证据继续保持 `implemented`。
证据见 [`evidence/features/model-workbench/metadata.md`](evidence/features/model-workbench/metadata.md)。
Plugin Manager Web 已完成列表、筛选、retained refresh、对象级失败、Create/Detail/CUA/Uninstall overlay
闭环，focused + legacy `17/17` 和 9 张原尺寸证据通过；packaged macOS/Windows CUA 继续独立验收。
Automations 七个 Web Function ID 也已完成 controller/view-model/CSS 拆分；O.20 后 focused `6/6`、legacy
`2/2`、正式联合 `8/8`、现有联合 `68/68`、宽回归 `149/149` 和 8 张原尺寸证据均通过，其中 Quiet Ocean
Theme Pack 覆盖 list/Inspector/Dialog。证据见
[`evidence/features/plugin-manager/metadata.md`](evidence/features/plugin-manager/metadata.md) 与
[`evidence/features/automations/metadata.md`](evidence/features/automations/metadata.md)。
Media Jobs P10.1 的四个 Web Function ID 也已关闭：focused `11/11`、legacy `5/5`、与 Media Production
联合 `24/24`，三份旧 CSS 删除并收敛为 521 行 focused owner，12 张 Light/Dark/imported Theme 原图已核验。
证据见 [`evidence/features/media-jobs/metadata.md`](evidence/features/media-jobs/metadata.md)。P10.2 Media
Production 的九个 Web Function ID 也已完成 S0-S5 closeout：focused `27/27`、legacy `8/8`、Media Jobs
`16/16`、Dark `2/2`、evidence `36/36` 和 static gates 全绿。五个旧 CSS owner 已删除（S0 脏树快照
2,432 行；相对 HEAD 2,438 行），后续 Dock owner refinement 后为 8 个 focused owner / 1,597 行且禁用项
扫描为零；36 张原尺寸图和
36 份 sidecar 覆盖 9 个 ID 的四类状态。
证据见 [`evidence/features/media-production/metadata.md`](evidence/features/media-production/metadata.md)。
packaged macOS/Windows 与 Desktop host integration 继续作为独立待办。
Work Board P11.1 与 U13 `T13-D` 已完成 focused + legacy `12/12`、selected `147/147`，raw failure 默认折叠，
9 张双主题/双尺寸原图与 sidecar；旧 `article` helper 已迁到公开 DataRow/action 合同。证据见
[`evidence/features/work-board/metadata.md`](evidence/features/work-board/metadata.md)。
Runs/Threads P11.2、Approvals P11.3 和 Profile P11.4 也已完成 Web 回归：分别为 focused `7/7` + Runtime
`19/19` + 8 张证据、focused `9/9` + legacy `2/2` + 8 张证据、最终串行 `28/28` + 6 张证据。
账本见 [`evidence/features/runs-threads/metadata.json`](evidence/features/runs-threads/metadata.json)、
[`evidence/features/approvals/metadata.md`](evidence/features/approvals/metadata.md) 和
[`evidence/settings/settings-profile/metadata.md`](evidence/settings/settings-profile/metadata.md)。
详细恢复入口以临时执行方案第 0 节和
第 13 节为准。

### P3 canonical closeout snapshot（2026-07-26）

- A-H、J-L、N-X 共 22 项在 I 前已完成；本次 I 文档 closeout 完成后，P3 已完成权重为 `2.12%`。
- P3-Y 继续等待 AppShell generic run status 产品决策；本次不替用户选择，也不删除 `StatusBadge`。
- facade guard 当前为 `0/0/0/1`：SelectControl / CreateDialogShell / OperationEmptyState / StatusBadge。
- Web CSS 当前为 `163 files / 33,427 lines`：`components=1,881`、`workspace=713`、`layout=490`、
  `strict-console=335`、`sidebar=138`。
- 覆盖矩阵为 `173 verified / 32 implemented / 31 designed / 14 inventory = 250`，闭环率 `69.2%`。
- P3-I 前 UI 2.0 总进度为 `93.1%`，本次文档 closeout 后为 `93.2%`。
- 当前文档资产为 `209 Markdown / 490 PNG / 778 files`；共享工作树为 `1,845` 项。
- canonical gate 为 focused `14/14`、broad `202/202`，lint、i18n、typecheck、build 与 diff check 均通过；
  本文前述各阶段测试数字作为历史快照继续保留。
- 正式 evidence：
  [Channel Proposed Plan](evidence/conversations/channel-proposed-plan/metadata.md)、
  [AppShell Geometry P3](evidence/shell/app-shell-geometry-p3/metadata.md)、
  [Channel Workflow Status](evidence/conversations/channel-workflow-status/metadata.md)、
  [Runtime Diagnostics Status](evidence/features/runtime-diagnostics-status/metadata.md)。

### P4 legacy dead-family closeout（2026-07-26）

- 16 个 generic readiness/runtime/check/policy class 的 production emitter 与 CSS writer 均归零；
  `first-run-*`、Runtime KPI/Audit、meta/tool/provider/status 和 focused capability class 均保留。
- Web CSS 当前为 `163 files / 33,210 lines`：`components=1,802`、`workspace=608`、`layout=457`、
  `strict-console=335`、`sidebar=138`，相对 P3 snapshot 净减 217 行。
- static `4/4`、Runtime/Runs/Settings/Release selected `28/28`、Runtime capture `4/4`、
  lint/typecheck/i18n/build/diff check 全绿；两张 Runtime 重采图与正式 evidence SHA-256 完全一致。
- Function ID 仍为 `173/32/31/14=250`；P4 只提升 U13 cleanup，总进度为 `93.4%`。
- 下一批为 P5 Settings Subnav/Overlay 真实可达合同与账本 closeout；P3-Y、First Run、Theme Studio D3、
  Skill Source 和 packaged Desktop 决策/平台门保持独立。

### P5 Settings reachability closeout（2026-07-26）

- `SETTINGS-SUBNAV-001` 收窄为 Skill Library / Archived Items 两个真实消费者并转为 verified；未使用的
  description 保持隐藏。
- `SETTINGS-OVERLAY-001` 收窄为当前 19 Dialog / 4 Menu 并转为 verified；Drawer/Popover 为 0，modal
  section switch 不可达，均未伪装为完成。
- 覆盖矩阵当前为 `176 verified / 33 implemented / 29 designed / 12 inventory = 250`，闭环率 `70.4%`；
  P6 Browser Feedback 与 DP.1 自动化语义 closeout 后，总进度为 `94.2%`。
- browser-facing production/package 的 `alert/prompt/confirm` 已由 AST guard 锁定为 0；下一切片仍按
  [后续升级执行方案](04-UI2.0后续升级执行方案.md) 推进，P3-Y 与各产品/平台决策门不变。

Current temporary execution entry and protected closeout references:

- [UI 2.0 后续升级执行方案](04-UI2.0后续升级执行方案.md)
- [P10.2 Media Production 设计合同](modules/13-Media-Production.md)
- [P10.2 Media Production 零决策实施计划](modules/13-Media-Production-implementation-plan.md)

以下 P7/P8 链接仅用于已验证切片的回归与边界参考，不是当前 Active slice：

- [P7C.1 Theme Pack Management 专项实施计划与 Web closeout](modules/settings/10-Theme-Pack-Management-implementation-plan.md)
- [P7C.2 Quick Theme Studio 专项实施计划](modules/settings/11-Quick-Theme-Studio-implementation-plan.md)
- [P8.1 AI Teammate Management 专项实施计划](modules/07-AI队友管理-implementation-plan.md)
- [P8.2 Council Workspace](modules/08-Council-Workspace.md)
- [P8.2a Council List / Health A 实施计划](modules/08-Council-List-Health-A-implementation-plan.md)
- [P8.2b Council Members A 实施计划](modules/08-Council-Members-A-implementation-plan.md)
- [P8.2d Council Channels A 设计合同](modules/08-Council-Channels-A.md)
- [P8.2d Council Channels A 实施计划](modules/08-Council-Channels-A-implementation-plan.md)
- [P8.2e Council Settings / Archive 设计合同](modules/08-Council-Settings-Archive.md)
- [P8.2e Council Settings / Archive 实施计划](modules/08-Council-Settings-Archive-implementation-plan.md)

该临时总控的第 `0.6` 节是当前基线之后的全量实施作业单，按 `R0-R8` 细分 Settings、Theme Studio、
管理面、媒体、运行面、全局清理和跨平台发布；第 `13` 节给出下一位 AI 的恢复指令，第 `14` 节规定
每个切片必须留下的交接记录。后续实施以这一个入口为准，不再新建第二份并行总计划。

## Purpose

本目录定义 Ling Web 与未来 Electron Desktop 的 UI 2.0 升级合同。它覆盖设计
tokens、共享组件、页面结构、所有主视图、Settings 深层状态、迁移切片和验收证据。

旧 P4-P13 文档继续描述当时的业务决定和问题背景。发生冲突时：

- API、状态机、权限、持久化和业务语义以对应功能文档及当前代码为准；
- 视觉层级、控件、交互、可访问性、主题和布局以本目录为准；
- 任何需要修改业务行为的 UI 2.0 任务必须停止并补独立设计。

## Reading Order

1. [UI 2.0 整体升级方案](00-UI2.0整体升级方案.md)
2. [全产品覆盖矩阵](01-全产品覆盖矩阵.md)
3. [UI 2.0 实施总计划](02-UI2.0实施总计划.md)
4. [UI 2.0 验收总规范](03-UI2.0验收总规范.md)
5. `foundations/` 与 `architecture/`
6. `components/`
7. `themes/`
8. `modules/` 与 `modules/settings/`
9. `migration/`

CSS 与图标实施前必读：

- [CSS 目标目录与加载顺序](architecture/06-CSS目标目录与加载顺序.md)
- [CSS 逐文件拆分矩阵](migration/06-CSS逐文件拆分矩阵.md)
- [Selector 与硬编码颜色清理](migration/07-Selector与硬编码颜色清理.md)
- [Iconography 与图标色系](foundations/07-Iconography与图标色系.md)
- [Icon 系统与功能映射](components/11-Icon系统与功能映射.md)
- [旧图标替换矩阵](migration/08-旧图标替换矩阵.md)
- [Motion 与状态转场](foundations/08-Motion与状态转场.md)
- [旧动效与交互行为迁移矩阵](migration/09-旧动效与交互行为迁移矩阵.md)
- [Toast 与 InlineFeedback](components/07-Toast与InlineFeedback.md)
- [全局反馈消息迁移矩阵](migration/10-全局反馈消息迁移矩阵.md)

主题系统实施前必读：

- [主题系统入口](themes/README.md)
- [独立主题包产品模型](themes/01-独立主题包产品模型.md)
- [主题包 Schema 与 Token 合同](themes/02-主题包Schema与Token合同.md)
- [沉浸式主题与 Presentation Profile](themes/06-沉浸式主题与Presentation-Profile.md)
- [AI 生成主题产品流程](themes/07-AI生成主题产品流程.md)
- [主题注册表与运行时切换](architecture/07-主题注册表与运行时切换.md)
- [Theme Compiler 与 AI Provider 边界](architecture/08-Theme-Compiler与AI-Provider边界.md)
- [ThemePicker 与主题预览](components/12-ThemePicker与主题预览.md)
- [Theme Studio 与生成预览](components/13-Theme-Studio与生成预览.md)
- [主题系统迁移与兼容验收矩阵](migration/11-主题系统迁移与兼容验收矩阵.md)
- [AI 主题与跨平台验收矩阵](migration/12-AI主题与跨平台验收矩阵.md)

Desktop 与 Computer Use PiP 实施前必读：

- [Desktop Client Shell](modules/18-Desktop-Client-Shell.md)
- [Desktop Computer Use PiP](modules/19-Desktop-Computer-Use-PiP.md)
- [Compact Desktop Window 与 Capability Control](components/14-Compact-Desktop-Window与Capability-Control.md)
- [Desktop 多窗口渲染器与主题同步](architecture/09-Desktop多窗口渲染器与主题同步.md)
- [Desktop 与 Computer Use PiP 迁移矩阵](migration/13-Desktop与Computer-Use-PiP迁移矩阵.md)

## Coverage Contract

UI 2.0 完成必须覆盖：

- `ViewId` 的 13 个主视图；
- `SettingsSectionId` 的 12 个 Settings 入口；
- 频道、普通对话、AI 队友私聊三类会话；
- 所有 Tab、Dialog、Drawer、Popover、Menu、Tooltip、Details 和 Inspector；
- 默认、hover、focus、active、disabled、loading、empty、success、warning、error、
  stale、destructive 和 long-content 状态；
- `1440x960` 与 `1280x800` 的 `ling-light`、`ling-dark`；
- 内置 `ling-light`、`ling-dark` 独立 Theme Pack，以及共享主题兼容 fixture；
- Electron Desktop 的共享组件边界，但不包含本轮移动端设计。
- Desktop main BrowserWindow、原生启动恢复 Dialog、current-session capability 和
  Computer Use PiP utility window。

## Function IDs

所有功能点使用稳定 ID：

```text
SHELL-*       AppShell 与全局层
SIDEBAR-*     左侧导航和对象列表
FIRST-*       首次使用
CONV-*        会话共享行为
CHANNEL-*     频道
TEAMMATE-*    AI 队友
COUNCIL-*     Council
MODEL-*       模型工作台
PLUGIN-*      插件
AUTO-*        自动化
MEDIA-*       媒体任务
PROD-*        媒体生产
BOARD-*       Work Board
RUN-*         Runs / Threads
APPROVAL-*    审批
PROFILE-*     个人资料
SETTINGS-*    Settings 壳层和子页面
UI-CSS-*      CSS 架构、拆分和清理
UI-ICON-*     图标系统和迁移
UI-MOTION-*   动效、状态转场和迁移
UI-FEEDBACK-* 全局 Toast、InlineFeedback 和消息迁移
UI-DATA-*     Badge、EmptyState、Skeleton、DataRow、Table 和 InspectorSection
UI-OVERLAY-*  Dialog、Drawer、Popover、Menu 和 Tooltip
UI-NAV-*      Tabs、SegmentedControl 和共享导航切换控件
UI-THEME-*    独立 Theme Pack、注册、导入和兼容验收
UI-THEME-GENERATE-*  快速、生成和高级主题生成流程
DESKTOP-*     Electron 壳层、Desktop capability、Computer Use PiP 和跨平台窗口
```

状态统一为 `inventory`、`designed`、`implemented`、`verified`、`blocked`。只有
`verified` 才表示对应功能点已完成真实浏览器验收。

T13-P.7 Icon Web implementation 与 formal evidence 已完成：共享 package `69/69`，AST guard 冻结
78 个 Web IconButton owner与 1 个 Profile Avatar identity 预算，标准 action legacy 为 `0`；17 个 touched
specs `122/122`，专用 Light/Dark capture `6/6`，14 张原尺寸 PNG/hash/metadata 位于
[`evidence/features/icon-system-p7-f/`](evidence/features/icon-system-p7-f/)。`UI-ICON-FOUNDATION-001` 与
`UI-ICON-MAP-001` 当前为 `implemented`；P.7-E Web implementation 与 macOS arm64 packaged motion/Input
子门禁也已完成，见 [`evidence/desktop/ui2-motion-p7-e/`](evidence/desktop/ui2-motion-p7-e/metadata.md)。
Windows 11 x64 与完整 release evidence 未关闭前，Icon/Motion 均不提升为 globally `verified`。

## Working Rules

- `@ling-stack/ui-react` 是基础组件唯一实现。
- Web feature 从 `apps/web/src/shared/ui` 使用组件；禁止直接导入 Radix。
- 不引入 Tailwind，不建立第二套视觉系统。
- 新样式进入共享包或 focused CSS；不得继续扩大 `components.css`。
- Lucide 是默认 UI 图标源；远程 Iconfont 禁止使用。
- `LingStackLogo` 和 favicon 是受保护品牌资产，不参与 UI 2.0 图标替换。
- 点击、展开、隐藏、切换和拖动必须使用统一 motion tokens，并支持 reduced motion。
- 短暂成功和信息统一使用全局 Toast；字段、对象、blocker 和修复路径就地持续展示。
- Feature 不得自建 Toast viewport、反馈 timer 或 browser `alert()`。
- Light/Dark 是两个独立内置 Theme Pack；`System` 只是主题选择策略。
- 主题只能通过语义 token 和受限本地资源改变视觉，不得提供任意 CSS/JS。
- 主题可选择 Ling 内置 Presentation Profile，但不能提供 Profile CSS、DOM 或布局。
- 快速模式不调用模型；生成模式只要求生图能力；高级模式使用结构化 Planner 与生图能力。
- 所有生成主题必须经过同一个 deterministic Theme Compiler，模型输出不能直接安装。
- P2A 已实现 ThemeSelection、完整 Theme Pack validation、Registry resolve/fallback、原子
  apply/rollback、Web 首帧 bootstrap、IndexedDB manifest storage 和 Desktop/PiP revision bridge；
  ThemePicker、real artwork renderer 与 Theme Studio 仍属后续切片。
- P2B.1 已实现四 Profile registry、route policy、local image analysis、deterministic token/artwork
  compiler、verification blockers 和 Web/PiP generic surface policy；真实 artwork publish/render、
  Theme Studio 与 provider adapters 仍属 U4/U7。
- Desktop 主窗口复用 shared Web UI；Desktop-only renderer 也必须消费 UI 2.0 primitives/tokens。
- Computer Use PiP 的 Hide、Close、Stop 语义不得因视觉迁移改变。
- 每个模块实施前必须先把对应文档状态更新为 `designed`。
- P10.2 Media Production Web closeout 是受保护回归基线；没有真实回归失败时不得重开，也不得用 Web
  evidence 代替 packaged macOS/Windows 验收。
- P9-D 后冻结 Web 视觉；不再启动新的 U13 CSS、selector、icon、motion 或 primitive 清理。
- P9-E/F 合并为 P9-EF final Web batch：小切片只跑 focused，四个实现切片后统一一次 broad/full。
- 已验证页面不重复截图；P9-EF 只在批次结束时为新增 changed-state 生成一次 evidence/hash/metadata。
- Intel macOS、Windows、packaged restart 与平台辅助技术验收移入
  [`release/01-Desktop跨平台发布验收清单.md`](release/01-Desktop跨平台发布验收清单.md)，不阻塞 Web 主线。

## T13-P.8 Feedback Ownership Status

AI Teammate MCP、Plugin CUA Copy、Channel Protocol/Composer、Settings MCP Check/Sync 和 Model row Check
已经完成反馈 owner 收口。短暂成功只进入 global Toast，失败留对象 owner，三个旧成功 class 与三个业务
timer 预算均为 `0`；focused/legacy effective `55/55`、模块 effective `156/156`、formal capture `14/14`
与 static gates 通过。P9-C 又将 Provider、Runs、Approvals、MCP、Settings 移出 AppShell generic error，
combined `50/50`、Settings follow-up `5/5`、cross-page evidence `3/3` 通过；P9-E-F 与 Profile standalone
message 仍 open，因此 UI 2.0 总进度保持 `94.2%`，不宣称全产品 feedback 完成。

## T13-P.9C Existing DomainError Status

Provider、Runs、Approvals、MCP 与 Settings 已使用 domain/object error owner，AppShell 不再向五个 hook 注入
generic setter。Approval decision 按对象身份隔离，Provider row failure 继续使用 P8 owner；从失败的 Model
Workbench 返回 Channel 时错误不会跨页残留。generic writer guard 当前为 `248/14`，released contracts=`8`。
四张 Light/Dark、1440/1280 原尺寸证据位于 `evidence/shell/app-shell-error-ownership/`。P9-D Channel 已按下节
关闭，当前 Active batch 进入 P9-EF；共享 Input 的 T12.1b/c/d containment 已验证，不因截图视觉误读重开。

## T13-P.9D Channel Error Ownership Status

Channel create/workspace/composer/task/workflow/protocol/dock/sidebar 已迁入 `surface + object identity + scope`
focused owner；四个 Channel controller/domain hook 与 sidebar archive action 不再写 generic AppShell error，
WorkspaceClientView 也不再渲染页面级 generic error。迟到的 Engineering send failure 不会污染 Research，返回
Engineering 后 draft、failure 与 Retry 仍在；Rename failure 留在 Dialog。generic writer guard 已下降到 `91/9`，
released contracts=`13`。focused/capture `3/3`、selected Channel `35/35`、完整 Channel `105/105`、conversation
package `23/23`、shared UI `70/70`、Form `4/4` 和 static gates 通过；三张正式证据位于
`evidence/conversations/channel-error-ownership/`。Active batch 进入 P9-EF final Web error ownership；Profile
standalone 保持 inventory，packaged platform gates 转入独立发布清单；总体进度保持 `94.2%`。

## T13-P.9EF Final Web Batch

这是现有可达 Web UI 2.0 主线的最后一个实施批次。它合并 Normal Conversation、AI Teammate、Plugin 与
startup/control-plane/shell error ownership，最终删除 generic AppShell error writer、consumer 和 compatibility
prop。P9-D 后 Web 视觉冻结；A-E 小切片只运行 focused，不截图，I 集成时统一运行一次 non-Desktop full
regression 并只生成一次新增状态证据。完成该批次后，当前已确定范围的 Web UI 2.0 主线可以 closeout；未决
新增能力和 Desktop 发布门禁继续独立登记。

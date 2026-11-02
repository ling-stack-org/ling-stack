# E6 P3：频道预算与澄清失效修复

范围：E6 专用分支内的真实 C01 失败修复。仅隔离 QA，不是协作成功、已合并或发布记录。

## 真实失败与事实来源

频道 `channel_dac98dcb-eb5f-49ce-9198-1d167b80daf5`（E6-C01 青岚协作验收 20261023）。
运行包 ASAR `114ddf774501da14eb9df2035b21a10533e62f2cb688f0ab2a6f0283c801d3a0`，
尚未包含本页及前三项私聊修复。

1. 首轮 `turn_036320fa-e7a0-404c-aba6-933d09a75da6` 在预算准入前阻塞，未创建 workflow。
   输出上限8192、未配置窗口，却把保守8192窗口标成 known；预留输出与512 overhead 后
   又人为补回1024输入空间。不能把调大窗口或重复提交当作源码修复。
2. 通过真实 GUI 将输出上限降至1024，窗口仍留空；并将频道移交本地 QA workspace、
   开启任务所需读写/命令工具。第二轮 `turn_09585fe5-c8ef-4290-85c0-315853b2649c`
   仍没有 workflow：模型澄清的 `qaCliCommand` 字段未在中文问句中逐字出现，校验抛错，
   退化成普通无工具回复。首轮另有相同原因的 `originalInputPaths` 校验错误。
3. 第二轮普通回复 Run `run_f9b4caa7-9038-44bb-b54e-8b3cfb9e4c30` 虽为 succeeded，
   只证明回复结束，不证明两名 required 参与者执行。C01/F01 仍失败，不能计为 fan-in 成功。
4. UI 的“web_search 8 个来源”不是伪造：旧包在明确“不联网”的任务上进行了 Host 网页预取。
   这些事实在 WorkUnit runtime events，而不是该 Run 的模型工具事件中。
   `work_unit_9c2faf93-8137-4518-bbe3-7aca6ef40432` 有3个进度事件和1个
   `web_evidence_recorded`（8个返回来源）。先前仅查看 Run 的空工具列表不足以推断没有外发。
   有限否定语句预取修复见 [私聊 QA 修复](e6-p3-private-qa-repairs-2026-10-23.md)，仍须新包复验。

只读证据位于 `output/e6-20260928/p3-live-20261023/`：

- `c01-budget-and-intent-host-capture.json`：原两轮、意图原因、空 workflow 与 Run 事件。
- `c01-workunit-web-evidence-20261023.json`：补齐 Host 预取事实，SHA256
  `5856e9ed7a9df12afdb81f6c6e0a8882a01c8d6d8a0722296a6a7fdb5fe01a6a`。
  捕获脚本只读现有 API，不再调用搜索服务，不修改 SQLite 历史。

## 修复契约

### 窗口与输出分别建模

- 只设置 maxTokens 不代表已知 contextWindow。窗口沿真实模板/家族/保守来源估计，
  保留合法 runtime 降窗；显式输出预留不能因 confidence 不是 known 而丢失。
- 输入空间 `max(0, window - output - overhead)`，不设虚构最低容量。
  输出耗尽窗口时使用 `output_reservation_exhausted`，提示降低输出上限或填写经验证窗口。
- 小于1024的输入容量不启动要求最低1024的摘要维护；这不是绕过回复准入。
  最终渲染输入和 SDK 仍必须通过严格容量 gate。
- workflow 必需依赖即便已压缩也必须保留；放不下就 Host 阻塞，不能丢依赖后继续执行。
- create/PATCH/import token字段均须正安全整数，显式输出须小于窗口。
  import 必须在 catalog enrichment 和既有值继承之后校验最终组合；整批先验证再写入，
  无效后项不能导致前项已写或启动后台 Provider 检查。

### 澄清是结构化缺项，不是执行权威

- `missingFields` 是审计数据，question 是本地化产品问题；不再将字段解释成正则或要求
  中文/法文问句包含 camelCase/英文内部名。Host 不能靠有限词表证明自然语言语义相关性。
- 保留非空、合法 schema、trim 后唯一字段校验；不接受附带 execution 的 clarification。
  重复字段在任何问题写入前拒绝，避免孤立问句污染后续回放。
- 普通内容问题不能被模型转为索取本地 target；reply/no_reply 的无工具 fallback 不新增执行权。
- clarification 不产生 Task/Run/proposal 或权限变更；同 sourceItem 重放复用原问题和 decision。
  后续真实执行仍经过完整 operation graph、current-source、owner、dependency、工具与审批绑定。
  本次没有放宽执行来源校验，也没有恢复关键词自动执行。

## 已运行的验证

- 原预算新增5项红测；真实 HTTP 小窗口/耗尽/工作流压缩最终9/9。
- 旧1024输入floor的两条邻接断言已按 fixture 精确修为512，并同时断言输出1024和overhead512。
- import 真实 HTTP 红测证明 raw 校验后继承值可写入无效组合；修后覆盖保存值继承、catalog
  补值、无效后项不部分写入、零 Provider 检查。
- Core、Daemon 编译通过；预算/保存/导入/runtime/summary 相关最终82/82，0 fail/cancel/skip，
  `p3-provider-budget-final-regression-20261023.log`。先前81项中的2项失败日志保留，不覆盖。
- clarification 的有效 fixture 红测5失败（另一次错误 fixture 的失败日志不作为根因证据）；
  修后新9项和操作来源/owner/命令/内容边界共45/45，0 fail/cancel/skip，
  `p3-clarification-green-20261023.log`。
- 所有后续 SQLite/Daemon 测试在全新 `/private/tmp` Ling home/default workspace 下运行，
  不迁移真实数据库，不弱化 migration guard。

## 未完成与接续

clarification 差量独审已完成，选定范围零确认 finding；独立隔离回归45/45通过。
预算独审额外复现两项消费者缺口，现已补修，最终差量复审零剩余确认问题：

- 旧 preset 的不安全整数在 Core 仍被标为 known，减去预留后 input 又可能变为 safe。
  Core token 解析现仅接受正安全整数；调用前同时校验窗口、输出、overhead 与 input，
  input 不能超过实际可用容量。两个新红测已真实失败，修后通过。
- intent/auto-route 的零预算仍调用 adapter，retry/图修复也未单独校验实际请求。
  现在每次 runTask 前对实际 system+prompt 使用同一准入；typed Host budget error
  不进入 Provider context-length 重试。小于1024的真实输入预算不启动摘要维护，
  既有摘要/最小投影仍须经最终准入，不虚构容量或弱化 coordinator 的原契约。
- 新 `channel-selector-budget.test.mjs` 的7项有效fixture全红→全绿，覆盖首次、降窗重试、
  rendered system、图修复及小预算维护。早期fixture更新Provider后未恢复check导致的假pass
  已修正，原日志保留但不作为因果证据；有效日志为`p3-selector-budget-causal-red-20261023.log`。
- 最终本组28/28、零失败/取消/skip，actual exit0，
  `p3-budget-review-green-20261023.log`；相邻HTTP/summary/频道集成仍单列，不冒充整树通过。
- 后继相邻频道集成68/68、HTTP/Provider/runtime/summary73/73均actual exit0、无skip。
  新增真实本地HTTP入口后澄清回归10/10，canonical assistantItems已提交，且零Run/Task/
  workflow/proposal；SDK/Provider仍是隔离桩，不是真实模型或GUI。

独审新发现须单列修复与定向回归，不能沿用旧输入 hashes。
另一会话还在同步共享 activity UI；它真实终态后才冻结整体输入和新 QA 包。
新包复验私聊审批/diff/离线、频道澄清与本地协作，再继续完整 C/F/recovery/Office 矩阵。
不再用旧包重复发送 C01 并期待源码修复生效。

N03 已通过真实 GUI 重开历史后继续第11轮受约束纯文本任务：青桐-47、137元、11月6日
均正确，38+47=85、余额52；全会话无 execution actions。Host capture
`host-lineage-2026-10-23T14-12-37-312Z.json`，SHA256
`ed00c09da32ce9effc636b127b7e4d7442bacf7de0d5f86fc82fd2f3f11b33bd`。
原第6轮 Provider 失败保留，不宣称十一轮无间断成功；本例也不证明所有历史事实永不丢失。

H09 的 CPA 硬输出 cap 仍未证明，不运行 pilot、不改共享 CPA、不把 GUI maxTokens 设置
当作真实传输硬上限。总目标仍 active，PR/merge 未执行。

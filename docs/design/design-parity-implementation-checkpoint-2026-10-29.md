# 设计借鉴实施检查点 — 2026-10-29

对应 [设计借鉴清单](../research/codex-claude-borrowing-matrix-2026-10-28.md)。
当前实施树为 `ling-design-parity/ling-stack`，分支 `codex/e6-safe-continuation`，
HEAD `071cbb8514b03d08154052153954c64045d142dc`；以下增量尚未提交、推送或合并。
本记录接续原 E6 owning plans，不将研究、原型或测试通过改写为全部产品验收。

## 当前实现

- A03：单条命令可完整查看和复制；command-only 历史可展开。完整日志入口只接受
  owning item 已有 artifact source ref，保留真实 operation lineage；无证据时明确不可用。
  命令复制反馈的 action identity 随递归 Timeline reconciliation 保留。
- A06：阅读锚点、相对偏移、追尾及明确展开偏好进入本地视图快照，按 Daemon、cwd、
  surface 和 thread 隔离，限定容量与 TTL，不保存正文、密钥、权限或执行状态。
  恢复偏好与当前交互分开：恢复的收起不能遮住后续运行/attention 详情，自动展开
  不覆盖持久偏好；当前显式操作替换恢复意图。
- A07：文件“更多”使用共享 view store，虚拟重挂载与 reload 保留用户偏好。
  真实首次私聊另复现了元数据晚到时的持久化缺口：canonical 已能显示文件卡，
  Feed 的 `threadId` prop 尚未到达，导致第一次展开没有持久 scope。现改为优先
  prop、否则使用已验证的 `canonical.directThreadId`；不借用 canonical thread id。
  延迟 workspace/canonical GET＋实际 Composer SSE 的浏览器用例已取得 RED→GREEN，
  该后继修复尚未进入下述真实 QA 包。
- B06：原有有界 writer 被接入 Run、普通会话、频道及私聊入口；pre-header 失败
  仍返回 JSON，post-header 失败走 SSE。慢读/断线只关闭观察，Host-owned Run
  持续唯一结算。未宣称完成全仓所有 SSE 入口审计。
- Ordinary checkpoint：仅对 canonical `unifiedExec` 与 Host normal-close 精确对应的
  bash 正非零退出，允许保存原始失败结果并进入下一模型边界。校验 command/digest、
  cwd 的持久词法/真实路径映射、run/task/call、observation 和所属历史 Attempt；
  保留 `isError:true`，不合成成功。未决审批、缺 receipt、旧 owner、未结算或
  unknown Host operation 继续拒绝；compaction 不启用此例外。
- CodeBlock：真实中文日志曾将 UTF-16 长度误标为 bytes；现以 UTF-8 字节数显示大小，
  字符数仍用于原折叠阈值，复制内容不变。实际组件渲染核对空文本、ASCII、中文和
  emoji，邻接 blocked narration 12/12 通过；尚待新包核对。
- Native Write：固定 inline worker 随 CLI 单 bundle 构建，模型数据只走 stdin。
  Electron Node-mode 运行时使用原 Supervisor 的可信 pin 与既有资源验证，缺失则
  拒绝；沙箱只增加经过验证的固定 runtime roots，不开放整个 App。

## 本次真实验证

本地日志均位于 `.gstack/tmp/`。不同检查有覆盖重叠，不相加为总验收数量。

| 范围 | 实际结果 | 日志与边界 |
| --- | --- | --- |
| Core 全套 | 4572/4572，exit 0 | `design-parity-core-unit-final.log`；历史库 fixture 撤去后继 overlay，不改生产 migration |
| A06/命令反馈邻接单测 | 49/49，exit 0 | `design-parity-reading-feedback-green.log`；原 attention、同值 set、retain 失败日志另存 |
| 命令/文件/阅读浏览器组合 | 14/14，exit 0 | `design-parity-reading-attention-browser.log`；生产组件＋合成 fixture，不是 packaged GUI |
| A03/A06/A07 独立内容审阅 | 当前限定增量无未解决发现 | `design-parity-ui-independent-review.md` 与 34 文件 hash；不是全 PR 审阅 |
| B06 正常 dist | 新测试 8/8、频道 stream 3/3，均 exit 0 | `design-parity-sse-canonical-*.log`；真实 HTTP/SQLite，Runner 为无网络合成执行 |
| B06 生命周期 | 14/14，exit 0 | `design-parity-sse-lifecycle.log`；隔离 dist，另有先行 87/87 组合，不冒充一次统一矩阵 |
| 原生 Worker 回归 | 272/272，exit 0 | `design-parity-inline-worker-regression-replay.log`；原 271/272 失败与原样单例重放保留，未改 deadline |
| Node/Electron Seatbelt | 2/2，exit 0 | `design-parity-inline-worker-runtime.log`；Electron runtime pins 为机制 fixture，不是生产授权 |
| 实际 esbuild 转换后的 Worker | 2/2，exit 0 | `design-parity-inline-worker-bundle-recheck.log`；dist/source 两模式单 ESM，Node/Electron 真执行；非完整 ASAR |
| Codesign 测试夹具消费者 | 130/130，exit 0 | `design-parity-codesign-fixture-verified.log`；固定预载模块精确 resolve，不开放真实 FS passthrough |
| CLI bootstrap | 3/3，exit 0 | `design-parity-daemon-cli-bootstrap-recheck.log`；真实 CLI/FD3/FD4，资源与服务 side effects 为 fixture |
| Codex lifecycle / workflow path | 91 pass、5 skip，exit 0 | `design-parity-native-lifecycle-path-recheck.log`；skip 原样保留，不计通过 |
| Office source-input 守卫 | 1405/1405，exit 0 | `design-parity-office-source-inputs-final.log`；真实 esbuild，native/compiler/signature 为 synthetic |
| 本地文档链接 | 509 份 Markdown，exit 0 | `design-parity-doc-links.log`；只验证本地目标存在 |
| 首次私聊 scope | 浏览器 2/2、邻接 37/37、Web 类型检查 exit 0 | `design-parity-a07-private-scope-receipt.json`；实际首次展开丢失的 RED 与修复后首次保存、Diff/切换、显式收起及 reload GREEN 分别保留，未替代新包 GUI |
| Ordinary failed bash checkpoint | Core 邻接 269/269、Daemon continuation 整文件 48/48、最终 SDK crash/recovery 2/2 | `design-parity-closed-failed-bash-receipt.json`；Core 正例与真实 SDK 原 RED 保留，最终 exit0/exit7 两例均通过。exit7 原错误进入恢复 SDK/provider wire 各一次，marker 始终 1 行；无重复命令或原 terminal Run 改写 |

Terminal 两个全套失败在原整文件 28/28 中未复现，尚无稳定根因，不称为已修复。
旧 Daemon 全套跨越 dist 重建，仅保留为诊断；其中失败不能抹除，也不能作为当前
冻结候选的全套通过证据。

后继正式冻结全套已自然结束：`node --test --test-concurrency=1 test/*.test.mjs`
实际 **exit 1**，8,009 tests / 7,993 pass / 3 fail / 0 cancelled / 13 skip，
用时 3,330,145 ms。前后 8,215 项、248,189,937 bytes 的输入完全一致，
568 份测试 inventory 和 Node 身份一致，无新增、删除或变更；不是跨构建结果。
完整日志 `design-parity-daemon-unit-frozen-candidate.log` 的 SHA-256 为
`2f6c89fe7823fa03c260c87caea59539a95990e8f0ad9ff7e4891e92bdef16a2`。

三处失败分别为 engine lifecycle 的 `detected/unsupported` 和 native Codex
candidate 的两处 `not_run/passed-or-failed` 断言。两个原整文件在相同输入下顺序
重放分别 6/6、7/7，exit 0，未复现；原全套 RED 保留。现有日志不足以区分
底层 probe、连接、前置场景及 abort 路径，未证明具体竞态，不修改 deadline
来消除失败。诊断见 `design-parity-daemon-frozen-three-failure-diagnosis.md`。
后继 Core 修复改变了输入，上述结果不冒充修复后全套结果。

## 测量与原型

B08 的真实 Daemon/SQLite/HTTP 合成读取测量已完成，模型调用 0，保留现有局部
调度，不启用全局共享。私聊 GET 有创建 thread/flush 通知的副作用。
实际数据与局限见 [读取探针](../../packages/daemon/experiments/read-scheduling/README.md)。
C01 的 MCP 复用及 C05 的两次真实最小 VM 实验见 [独立原型记录](../research/codex-claude-prototypes-2026-10-29.md)，
均未接入生产。

## Office 冻结差额与隔离 QA 绑定

本次独立内容审阅覆盖 2 个新增、18 个非 catalog 变更和 55 个生成 catalog 变更，
限定差额内无未解决发现。1,569 个未变 packaging 输入与 15 个未变 native 输入
复用原内容审阅；1,644 项当前与冻结源码均逐字节核对。报告为
`design-parity-office-independent-review.md`，SHA-256
`0c76614ef0b510e6233a7cf4b1a5c151966f0613baeb97d349f33de48aaac955`。

依原有隔离 QA standing 授权，精确应用了已审 packaging map：1,642→1,644，
2 added / 73 changed / 1,569 unchanged / 0 removed。原
`readReviewedPackagedOfficeSource()` 实际读取通过；正式记录 SHA-256 从
`d9614f8fac98b80ad5574513b5cfb12cd242a2d7d0491e0f2b2578944a9c4410`
变为 `7c3b1e0e7bf2f3c163904e17532f9a7bb3e618c925452b198db000c5590e9faa`。
全部 non-map 字段和 native 输入不变，proposal 保持 `approved:false / approval:null`，
冻结 manifest 保持原字节。实际回执为 `design-parity-office-application-receipt.json`。
这不构成全 PR 审阅、实际 Office 执行、新包 GUI 验收或公开发布批准。

旧 GStack generation 保留不动。本次已在新的私有 `local-bounded` 资源目录完成
正式 source-fetch、native、reviewed-sdk-only stage、assembly 和 selection，均实际
exit 0；当前 30 项 toolInputs 全部匹配。固定上游仍为
`47d639abffa882b8cbb641d7d1dedf08ecada9ec`，source manifest
`46d0b73ac3efa12039ea2332f03782b9d940cdd47c3798bf99cd75406166f866`
精确匹配当前 pin，`reconstructed:false`。新 executable manifest 为
`6f0bc3de145298da881fae8d77acd681b9db8ecb2ff219ece5e0c7c318773bdf`，
29,996 文件、资源目录逻辑用量 5,917,328,287 bytes，低于 12 GiB。
原 Desktop reader/readExecutableBundle 独立读回通过；进程组排空、lease 已释放。
完整证据见本地 `design-parity-gstack-current-generation-review.md` 与读回回执。

本代采用 `model:download-required / browser:bundled`，本轮未下载或运行
TestSavant 模型，不沿用旧 bundled-model 的通过声明。license/notice release blockers
仍在，`releaseEligible:false`，不构成分发批准。

同一输入的新 macOS arm64 隔离 QA 包已实际打包 exit 0，ad-hoc
`codesign --verify --deep --strict` 通过。ASAR SHA-256 为
`fb03cb450d956b53c068980208680b4823ec1f1b39f130d5c2f3985130c72409`；
实际 packaged CLI 绑定上述 Office review SHA 和 GStack identity。新私有 profile
的 App 与子 Daemon 归属已核对，`/health` 返回 `readiness:ready`，首屏实际可见。
这些证明生成、启动与首屏就绪；三 surface、Office 和恢复联合验收仍在进行。

依用户选择，本机 CPA 已通过正式 Provider API 接入该新私有 workspace，
公共读回确认 `apiKeyConfigured:true`；凭据未进入命令行、环境或验收正文，
共享 CPA 配置未改。`gpt-5.6-terra / openai-completions` 的一次正式真实 preflight
HTTP 200、`ok:true / code:ready`，用时 4,339 ms。Engineer、QA 两位队友已在
界面固定绑定该 preset 并保存；共享 CPA 配置未改。

## 真实会话、产物与同 profile 重开

以下均使用上述 ASAR 和新的私有 profile `design-parity-packaged-qa-Xd51j0`，
凭据只保存在该隔离 workspace。证据为 `design-parity-real-three-runs-evidence.json`，
包含 canonical 事件、lineage、真实 cwd 和全部 13 个产物的内容/hash。

| Surface / Run | 真实结果 | 已验证与限制 |
| --- | --- | --- |
| 普通 `run_82d1100f-72b4-495f-a9f2-8b5be2027bd1` | failed | 35 行中文日志命令 exit 0；独立预期失败命令 exit 7。UI 显露失败，完整日志可打开；单条命令复制后真实粘贴核对一致。下一模型边界被 `checkpoint.effect_unknown` 阻断，九文件没有在此 Run 执行。保留失败，不复活或改写终态。 |
| 普通 `run_09240884-455c-4304-ac67-f9d66605a9d5` | succeeded | 独立新任务创建并核验 `qa-results/result-01.txt` 至 `09.txt`；第九文件真实预览正确。这些是正文 source links，不计作“更多文件”卡验收。读旧长日志时新轮结束未强拉到底，显式 Jump 才到底；未测量像素偏差。 |
| Engineer 私聊 `run_9eb24c04-337f-4e78-bf14-9b0e4fc9be0b` | succeeded | 四次 write 在私聊专属 managed worktree 创建 `qa-private-a.txt` 至 `d.txt`。卡显示四文件、+4/−0，默认前三＋“文件+1”；展开第四个并打开真实 Diff，A–D 内容正确。 |

私聊首次完成后，展开→Diff→关闭→普通会话→返回，曾丢失展开偏好。后来重新
展开后 reload、实际退出重开及再次切换均保留。不能将后续通过覆盖首次失败；
对应后继最小修复及受控 RED→GREEN 见上文 A07。修复后的新包实机复验仍待做。

已正常退出旧 App/Daemon，确认进程与端口排空后重开**同一 profile**，未重置数据
或 marker。三个旧 Run 的 ID/status/endedAt 与全部 13 文件 hash 均不变，重启未
创建新 Run；首页、普通历史、Engineer 私聊和四文件卡均实际重开。回执为
`design-parity-reopen-readback-and-startup-baseline.json` 及
`design-parity-packaged-reopen-1-{launch,readiness}.json`。截图/AX 位于工具记录，
本轮未保存独立本地 PNG，不能据此宣称已有可交付截图文件。

频道 `channel_9d9e4003-e866-4824-a4c0-7c1b7bcb685e` 的真实 @Engineer
请求已由 durable dispatch 消费，但操作计划被 `channel_operation_plan_invalid`
拒绝，canonical Turn 为 blocked，未启动队友或 Run，UI 已显示阻断原因。
workspace API 确认执行目录是频道专属 managed worktree；不能只查 boundPath。
该案例未通过四文件验收。初始与一次修复均通过 schema，随后因
`contentSource.text` 来源绑定被拒；候选正文未持久化，不能断言是换行造成。
读回与诊断为 `design-parity-channel-stuck-readback.json` 和
`design-parity-channel-plan-binding-diagnosis.md`，保留原拒绝与来源校验。

第二个独立请求使用明确的逐文件 literal，来源绑定一次通过，生成同一 proposal
`proposal_671c0ebc-88a1-481a-869b-64394d465ab1`。频道创建时仅有 read/grep/find/ls，
第一次 Allow 被 Host 以缺少 write 拒绝；经真实设置界面显式只开启 write，再次
Allow 后接纳同一 proposal，未重发任务。后继
`run_83f2aa0f-1fc0-4940-8ab5-d59a81318eb3` 为 succeeded，但无任何工具调用，
四文件均未产生，workflow/step 最终明确 blocked，不能把模型结束当作任务完成。

Run request、prepared input 和 runner input 均含 write；实际工具与政策没有缺失。
另确认动态“缺 write”说明被拼入 proposal.riskSummary，批准成功只清 error/blocker，
后继 step prompt 仍把旧说明作为当前 Risk summary。它是已证实的错误上下文，
尚不能认定为模型未调用工具的唯一原因。正在分别修复动态风险归属及界面能力
恢复入口，旧 Run/审批/失败证据保持原状；新包真实模型复验尚未完成。
读回为 `design-parity-channel-approved-write-readback.json`。

## 后继基线整合

远端 main 已前进至 `c128146c5cf874fa4717dbb23b5743c31be27e27`，包含文档产物、
交互表格和 API/业务数据兼容切换。当前 HEAD 尚未包含这些提交；已完成只读
merge-tree 预检，尚未合入。等待当前窄修复及测试停止后，先备份全部 WIP，
再整合 main、保留两侧兼容逻辑与文案，随后重新冻结 Office 输入、构建及实机复验。
既有包与全套证据不冒充后继整合候选的结果。

## C06 首批真实启动观测

从同一包 Desktop phase 日志读取新 profile 首次启动及同 profile 重开两个样本：

| 阶段 | 首次新 profile | 同 profile 重开 |
| --- | ---: | ---: |
| module loaded → window loaded | 32,026 ms | 24,134 ms |
| resources preparing → ready | 31,335 ms | 23,448 ms |
| resources ready → Daemon ready | 450 ms | 382 ms |
| Daemon ready → window loaded | 177 ms | 232 ms |

重开 spawn→HTTP health ready 为 24,247 ms。测量期间有全套测试负载，以上为
观测样本，**不是受控冷/热 benchmark，也不是优化收益**；首帧、真正可输入时间
和 RSS 尚未测量。资源准备是下一步定位候选，不据此跳过完整性校验或更换 Electron。
原始时间戳与差值保存在上述 reopen/startup-baseline 回执。

## 尚待收口

继续收口已发现的 ordinary 失败命令 checkpoint 与首次私聊 scope 修复，
差量复核 Office 输入并生成后继新包，完成三 surface/审批/恢复/Office 联合验收、
频道计划拒绝诊断及 C06 剩余测量，再按 `/ship` 完成全累计
PR 范围审阅、验证、推送、CI 和实际远端合并。H09 仍要求可证明 reasoning/visible
总输出硬上限的 Provider 路径；已有预算委托不等于已证明该技术条件。

不访问此前事故涉及的真实 E6 DB/marker。只用新的隔离 QA profile；不发布，
不启用或手动触发 main CI，不做 Windows 验收，不升级全局 GStack。

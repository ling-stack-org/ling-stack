# C01 路径引用与命令工作目录边界

状态：源码修复及新 packaged GUI 的四项只读回归已通过；完整小项目与整个 E6 尚未完成。
唯一实施树仍为 `ling-e6-continuation/ling-stack`，不改根 checkout。

## R8 输入坐标契约收口（2026-10-25，实施中）

R8-C1 实际停在 `inputs.path`，原被拒候选未持久化，不能声称已还原其具体字段。
独立临时目录探针 capture030/031 确认现有候选契约的表示歧义：无 `relativeTo`
的 canonical 输入会被再次拼接 cwd；操作数字面引用与 canonical 引用混用会被拒绝。
这不是授权扩大问题，也不能通过重发提示词或删除来源检查解决。

从本切片起，候选路径与已有持久 binding 的坐标保持一致：

1. 没有 `relativeTo` 的 `inputs[].path` / `commandGoal.module.path` 一律相对 workspace，
   与 `workingDirectory` 是否存在无关；Host 不按文件存在性、basename 或前缀猜测坐标。
2. 只有显式 `relativeTo` 改变路径锚点。command input/module 可使用逐字引用的
   `cli.js`、`../records.csv`，分别引用独立的 canonical workspace-relative 目录锚点。
   锚点原始目录必须在归一化前检查，不能让 `../` 擦掉 symlink 或非目录。
3. 路径、锚点各有真实来源引用；当前来源必须属于当前 operation 的责任块。
   历史材料仍只取 canonical source registry，不因此获得新的执行意图。
4. `workingDirectory` 只决定进程启动位置。原 command、owner、projectInputRoot、
   sandbox/approval、producer dependsOn、Run/Attempt/fingerprint/evidence 检查不变。
5. 仅 command input/module 的显式锚点形式归一化 `..`；普通 file target 不放宽。
   持久 inputRefs/modulePath 仍是 canonical workspace-relative；不改表、历史或冻结 Run。

同步修改 selector prompt、binder 与原生回归。旧 cwd 回归改为显式锚点夹具，保留其
argv、canonical input、越界和 import 断言；新增反例覆盖 canonical 不重复加前缀、
无锚点不隐式相对 cwd、来源/目录校验及 producer 精确匹配。旧 capture 和真实失败保留。
本切片在新包真实项目通过前不能记为 C01/E6 完成。

## 最新真实 GUI 回归（2026-10-25）

新包 ASAR `ffc306b6660098034c5054fa780f73ed56de96dcafebc8eaebb386ec9451cbc0`，
UI任务 `E6-C01-CWD-R6-20261025-1453`，Host workflow
`workflow_9f30e6f6-3113-4ff8-9348-62c51cd6e0aa` 已 succeeded。
Engineer/QA 两个独立 Run 各自真实读取 constraints 并执行自己的精确 Node 命令；
Host cwd、staging topology、原始 argv、exit0及输入来源均有实证。每条命令 prepare/settle 各一次。
原8文件SHA不变；QA终态前父任务仍 running，最终仅一个有效父结果。
证据位于 `output/e6-20260928/p3-bash-cwd-contract-live-20261025/`：capture010/011、
`r6-after-qa-approval-host-lineage.json`、`r6-terminal.png`、`r6-terminal-full.txt`。

范围限制：只证明四项只读静态协作和本次 cwd 修复，不证明完整两文件项目、
动态委派/整树停止或全部恢复通过。后继 R7 真实失败：意图 JSON 解析错误被
accepted reply fallback 吞掉，未创建 workflow，普通回复错误声称没有工具。
失败截图、AX、capture012 保留；不能用 R6 的成功覆盖它。

R7 后继修复契约：压缩重试、格式修正、来源绑定修正共用最多两次 selector 调用；
仍无法解析时发布 Host-owned `channel_intent_selection_failed` blocked 结果，
不调用普通回复模型、不产生执行计划或额外权限。诊断 item 是半持久化恢复锚点，
同 source 的重放/重启不重复选择或发布。Host apply/持久化异常必须向上保留，
不能混入 selector 异常，更不能用诊断掩盖已创建 proposal 的 lineage 缺口。
合法普通回复及独立可答内容的防误澄清不变。
验证：新增异常回归14/14；完整澄清、operation bindings、capability blocker三文件47/47；
channel-workspace公开入口定向1/1；编译及diff-check通过。四份完整回归文件加一个入口
共62项，无失败/取消/skip；不是channel-workspace全文件、Daemon全套或真实外部模型验证。
三文件精确字节的独立增量审阅0未闭环finding，证据capture018–022及
`intent-failure-independent-review-20261025.md`。尚未打新包复验。

R5 要求重述已确认是 current-turn sourceQuote 约束，不是 SQLite 历史丢失；
后续需以用户明确承接与 canonical 历史来源为依据设计，不能直接取消 source authority。
R6 审批 pending 提示独立待查；每条真实命令仅执行一次，原失败历史保留。

以下为原设计与实施历史，当前执行顺序以上述检查点为准。

## 1. 已复现的根因

真实 C01 请求在项目子目录执行 `node cli.js ../records.csv`，提前得到
“路径不在当前工作区内”的回复。根因链如下：

1. `composer-input-parts.ts` 从正文识别路径，原先四处提交映射都把词法识别结果
   标成 `source: composer`，与显式文件引用混在一起。
2. `ling-agent-turn-envelope.ts` 对所有这些引用以 workspace root 为基准解析，
   将命令操作数 `../records.csv` 标成 blocked，即使真正的命令工作目录应在项目内。
3. `channel-intent-selector.ts` 在模型意图选择之前检查 blocked file refs，
   整轮请求因此被提前改成文件越界澄清。
4. 普通会话和私聊 canonical ingest 还会把原始来源统一改写为 `explicit_text`，
   仅改频道判断不足以保留同一语义。

这与工具边界拒绝真正越界是两件不同的事，不能通过允许任意 `..`、删除审批、
给命令整个 workspace 的读取权限或把 shell 命令改成 `cd ... && ...` 来绕过。

## 2. 第一切片：正文词法引用不升级为文件读取请求

本轮实现：

- 新增 `source: inferred_text`，仅表示正文的展示性路径识别。
- 三种会话的真实提交及频道预览统一写入这个来源；正文、路径标签和跳转信息不变。
- HTTP 校验、Core SQLite parser、canonical ConversationItem、normal prepared
  request 和私聊 ingest 保留该来源，不把它降成无来源或升级成显式请求。
- 频道 turn envelope 不对 inferred refs 做 stat、缓存内容载入或越界澄清，
  原始字面内容仍完整留在 body 中供模型理解。
- 普通和私聊的模型上下文不再把它重复列成“Workspace file references”。
- `composer`（显式提交）、`explicit_text`、`api` 的原文件边界不变；
  独立的 `file:` / `path:` 显式语法不被同路径 inferred token 遮蔽。
- 不迁移历史记录、不新增表、不改变命令允许范围、不修改已冻结 Run。

验证：新增 `inferred-file-reference-boundary.test.mjs` 在原 dist 上真实
5 fail / 3 pass；修复并编译后 8/8 pass。失败涵盖误 materialize、HTTP enum、
canonical 来源升级、模型选择被提前拦截，以及显式引用被同路径 token 遮蔽。
修复后原三种显式越界拒绝仍全部通过。

当前相邻 6 个 Daemon 文件 88/88 pass、无 skip，包含 normal request、私聊
ingest/context、意图澄清、prepared execution/no-replay。Web typecheck exit0；
Contracts Continuity v2 14/14、私聊 timeline 23/23 均 exit0。
扩大邻接的进程/日志为
`output/e6-20260928/run-inferred-reference-adjacency-20261025.mjs` 和
`inferred-reference-adjacency-20261025.log`；该批实际 exit1：额外 Daemon 291/291、
Core 持久化 29/29、Contracts 全套 95/95 通过，Web 775/797、22 fail。

### Web 邻接失败已收口（不是新包 GUI）

22 个失败在单独三文件组合中再次稳定复现，actual exit1。两类原因：

- `workspace-client-view.types.ts` 使用 Core 根入口导入 `AiTeammateTemplate`，
  违反浏览器边界；改用已有 `@ling-stack/core/skill-types` 子路径，未新增导出或运行逻辑。
- #584 的组合模型控件替代旧推理按钮，但旧 C011 测试仍要求旧按钮 class，
  新控件也未保留原来的推理关闭说明及专用可访问性标签。保留组合控件，
  补回 `Thinking off`、关闭说明和 `Selected thinking mode`，测试改为验证真实新控件，
  而不是恢复旧 UI。off 不发送 thinkingLevel、high 原值发送、锁定无法提交的校验均保留。

修复后定向三文件 75/75、Web 全套 **797/797**，零失败/取消/skip，actual exit0；
Web typecheck exit0。新全套只重跑受影响的 Web，不重复已通过的 Daemon/Core/Contracts。
runner `output/e6-20260928/run-web-boundary-repair-20261025.mjs`，
日志 `web-boundary-repair-20261025.log`，SHA256
`34d8bad72bfe379e7de73d0ac7ba258908624b6c4eb0b58cb0cf80a56dd6eda8`。
1867 输入前后指纹相同：
`aca0ee3c0b0cdd30fa774eae1a2be10560c3fae79123e89cea63d304b289edfc`。
session58138 已实际 exit0，不再等待。这是自动回归和 SSR consumer 证据，非 packaged GUI。

## 3. 第二切片：每条命令的 source-bound cwd

源码链路已接通，正在做扩大回归和独立差量审阅；尚未进入新 QA 包或 GUI 验收。
第一切片仅纠正提前误拦。原先另外存在 Run/tool cwd 强制相等、命令输入禁止父级操作数、
staging 始终从 workspace root 执行的问题。Pi 仍传 session cwd，没有假设它支持每命令 cwd。

当前实现保持 `Run.cwd` 是 workspace 权威根，另行冻结每条命令工作目录：

1. Candidate/Host binding 增加可选的 workspace-relative `workingDirectory`，
   自带当前操作的用户原文 sourceRefs。缺省表示原 workspace root，不推断目录。
   目录不能仅来自脚本路径前缀、历史模型文本或候选的 `verified=true`。
2. 原始命令保持逐字匹配，不静默改写 argv。输入可相对这个明确目录解析，
   但持久化的 inputRefs 必须仍是 canonical workspace-relative 路径。
   `project/../records.csv` 可在验证后归一为 `records.csv`；越过 workspace
   的路径和 symlink/目录身份变化继续拒绝，不能全局放宽 path validator。
3. Host 从唯一匹配的不可变 operation 选 cwd，不相信模型任意指定的工具 cwd。
   如工具显式带 cwd，必须与所绑定目录一致。审批所展示的原始工作目录、
   normalized action / similar-command grant、operation fingerprint 和 journal
   都要绑定这个目录，不能同命令换目录后复用原批准。
4. 保留 staging 的 workspace 拓扑；实际进程在 `staging/workspace/project`
   启动，读取父级输入只能命中独立授权并已捕获的 `staging/workspace/records.csv`。
   不把 staging root 改成 project 后再向外复制 `../`，也不扩大 project input scope。
5. sandbox policyHash、operationHash、真实 original/execution cwd、输入捕获与
   action evidence 记录同一选择。目录 identity 在异步准备后及原子启动前重验。
6. 审批恢复、SSE reconnect、Daemon restart 只使用冻结 binding，不重新解释原文。
   stale writer、目录替换、未结算效果继续 blocked，不重放已执行的工具。

实现位置：Contracts binding/goal/validator 与 Host selector 保留来源和 canonical input；
`workflow-command-cwd.ts` 在审批、Broker、unified exec 和 restricted dispatch 的入口
统一绑定冻结目录。`restricted-command-directory.ts` 捕获并在异步边界、spawn 前复核
目录链的 dev/ino。原 Host protected actor 仍使用 Run workspace 根，不扩大其权限。
similar-command proposal 的 fingerprint 纳入 cwd；持久规则从原 source approval 派生 cwd，
无可信来源不匹配，不新增 SQLite 表或列。审批与设置 UI 展示规则的运行目录。
固定 Office authored 清单显式加入两份新模块，仅登记输入，不自动更新 approved。

定向证据：新 binding 测试 6/6；runtime/SQLite/Broker/fan-in 5/5。
真实 native conformance 的五个场景均已执行通过：审批/目录/journal 一致、未授权父级输入拒绝、
准备后目录替换拒绝、异步捕获期间强制替换拒绝、Host 函数目标的 cwd-relative import。
使用当前 dist 与旧已签名 QA 包内未变的 helper/Electron 资源，bootstrap 实际执行 codesign，
没有覆写 verifyBundle。它不是新 packaged GUI 证明；正式组合回归正在另存不可覆盖日志。
先前新夹具漏 Run owner、误要求任意 node 脚本有 prefix rule、未区分 macOS canonical
`/private/var`、合成 tool_end 缺正式结果字段的问题均已在测试中修正，没有放松产品检查。

必要回归包括：实际子目录 Node 命令与显式父级数据；错误/无 source quote；
未授权父级文件、workspace escape、symlink/目录替换；相同命令不同 cwd 不复用批准；
approval pending/retry/restart 不改 cwd；无 workingDirectory 的原 root 行为。
完成后才对对应 runtime/权限/打包输入做增量独审，更新精确 QA packet 并重打新包。

## 4. 完成边界与接续

### 第三切片：模型可见的 cwd 与三种会话的审批一致性

后继 QA 包已启动并真实发送 C01 R4。Engineer 读取后显式 blocked：Bash schema
没有 cwd，模型不能同时满足“子目录运行”和“命令逐字不变”。这不是工具执行成功，
也不能用 Run succeeded 代替 workflow/step evidence；QA 尚未运行，原失败保留。

Runner 现在公开可选 `cwd`，相对路径仍以 session workspace 为基准，参数原样交给
Host，不改 command、不改变 `Run.cwd`、没有 SDK local Bash fallback。省略参数时，
typed workflow 使用不可变 operation 目录；ordinary/private 使用 session 根目录。
typed 显式参数只是和冻结目录的一致性检查，不能赋予另一目录或额外文件的权限。

公开此参数必须同时补齐普通/私聊的 Host 入口。原 legacy 分支直接返回 session cwd，
后面的 execution normalizer 却消费 input.cwd，导致审批展示、批准指纹、相似命令规则
和实际进程目录分叉。真实临时 SQLite/原生 producer 回归已复现根目录一次批准和规则
可错误启动子目录命令，不能只修频道或仅在 UI 显示目录。

共享 `normalizeBashWorkingDirectory` 在审批前选定 effective cwd；同一结果贯穿
approval payload/proposal、规则匹配、Broker identity 和 original launch 检查。
最终 execution normalization 复用同一函数，拒绝非字符串、空白和 workspace 外目录。
保持 Run workspace 权威根、原 command/input、typed immutable authority 和原权限策略。
目录选择不是读取授权，也不是 Full Access；原文件/sandbox/launch 校验仍必须通过。

新回归分别覆盖：普通和真实 teammate Run 的幂等绑定；审批事件、持久 payload、
新规则与实际结果目录一致；根目录一次批准/规则不能用于子目录；被拒绝时零 producer、
真实 Host no-start；有效子目录审批后能执行；原 typed consistency/malformed 拒绝。
Runner 17/17 和全套 569/569 已通过；Host 最终10个完整文件215/215、真实macOS
native conformance 5/5均actual exit0，零失败/取消/skip；回归冻结输入前后一致。
9文件最终独立静态复审0个未闭环finding，原始source factory另行防止直接调用借root grant。
新ordinary raw正例使用Node默认文件进程隔离，不清除产品sticky actor history。
这不是整个Daemon全套或新包GUI结果；下一步更新具体QA packet、重包，新nonce复验C01。

### 独审后补齐的内部边界

前一扩大回归（444 Daemon / 183 Core / 95 Contracts / 797 Web / 5 native）和
1466 项 Office source closure 已实际退出通过，但独审仍发现三个未覆盖入口。
typed 命令缺省目录必须和显式目录一样校验真实 evidence cwd；私聊共用 admission
不能把 inferred refs 当真实文件请求；normal queue/interrupt 的 source 必须贯穿
HTTP、SQLite、pending projection 和 continuation request，不能在后续轮次升级。
intervention prompt 的文件列表也必须排除 inferred refs，原 body 不变。

跨 Run 依赖命令另已用正式 SQLite/action projection 复现：按消费方 cwd 校验会拒绝
生产方正确证据，也可能借错目录。typed dependency 现按 owning Run 的 frozen cwd
验证，不能仅依赖 action 的命令和 exit0。历史无 typed binding 的 generic 规则不变。
以上均有 RED→GREEN，当前定向64/64；尚待新字节全套与差量独审，详见
`output/e6-20260928/cwd-boundary-review-repairs-20261025.md`，不把前一全绿当修后证明。

`7f214629` 已推送并按远端 exact hash 读回，是第一切片之前的证据 checkpoint。
原 Daemon 完整回归 7534 pass / 0 fail / 12 existing skip 只覆盖该旧冻结输入，
不能直接宣称覆盖本轮新源码。原 raw 证据日志未改写。

本轮尚未重打 QA 包、未做上述新源码 GUI 验收、未新建 PR/合并 main，也未发布。
最近内置 Cua 请求 timeout，旧 Main/Daemon PID 和 17928 listener 已不在；
这不是客户端已通过，也不能据此声称当前依旧锁屏。重启时先用原 owned-profile
参数和隔离端口，再核对真实进程归属，不能无参数拉起日常实例。

继续第二切片扩大回归、独审和新包复验，以及新的真实两 required participants/full project C01，随后继续总计划
P3 的断线/重启、动态委派、Office GUI，和 P4 H09。不要重复 P1 资源重建、
时长格式化、旧 CPA cap 调查或旧已完成的测试。

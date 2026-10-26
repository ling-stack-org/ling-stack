# E6 R03：停止失败路径修复与接续点

状态：Host/Desktop/共享 UI 源码修复及隔离组合回归已通过；
**新包差量冻结与真实 packaged R03 尚未完成，不是总目标完成**。
唯一实施树仍是 `ling-e6-continuation/ling-stack`，分支 `codex/e6-safe-continuation`。

## 1. 原始真实现场：保留，不重发

- 旧冻结 QA ASAR：`4db75650e50300c45fdc033f715ef231fa41dc1db0d670eaf1f34c1dfeb70c35`。
- Case：`E6-R03-RESTART-20261026-0334`；Run `run_293abe6c-730f-4128-93b6-87930d891b85`。
- Attempt：`work_unit_attempt_47eb4069-19b3-4618-9c1b-b2d9d44db581`。
- 唯一工具调用：`call_MoyChCBe8Pq8AJ3bzc7CdiR9`；唯一真实 approve_once 已完成。
- 原 Main 67490 直接拥有 Daemon 67495；在工具运行中仅给该 Daemon 发过一次 SIGTERM。
  这些是当时身份，不是将来发信号的授权目标；操作前仍须重新核对 PID/PPID/argv。
- 工具 PID 68832 没有被杀掉：自然运行完 60 ticks，marker 共 62 行（一个 start、一个 done）。
  Host prepared/settled、tool_start/tool_end 各一次。不得重发任务、重批审批或删除 marker 重跑。
- SDK/本地写入已排空，`host_attempt_completions.drained_at` 已落库，
  但效果覆盖仍 `unverified`；suspension 已 sealed，stop 仍 stopping，没有 stopped 回执。
- 旧客户端显示运行中和 Failed to fetch。旧 Daemon 未退出，所以 Main 未真正开始新实例恢复。
  **R03 原始真实判定为失败/未完成，不得涂绿。**

原始证据位于 `output/e6-20260928/r03-daemon-restart-packaged-20261026/`。
本轮仅用只读 SQLite/进程/源码取证；没有改真实数据库或再给该实例发信号。

## 2. 已确认的根因，不再重新猜测 SDK 卡死

1. Core 当前明确只接受 host command 的 journalled no-launch 等适用证明。
   `completed` 的 leader exit/stdio close 仍带 `descendants: unverified`，不能推出后代 containment。
   `user-input-durable-quiescence.ts` 和 `run-suspension-stop-store.ts` 拒绝该停止证明是正确的。
   本轮不把 completed 改成安全、不伪造 effectCoverage、stopped 或成功终态。
2. 真正的无限等待位于 Daemon 外层：`server.close()` 已开始，continuation settle 等待它；
   run shutdown 拒绝后，原代码跳过控制面 SSE 与 HTTP 连接清理。活跃 SSE 因而阻止 close 完成，
   Harness lifecycle 永远拿不到 failed receipt。
3. 修复上述等待后还必须处理 CLI：原 `void stop()` 的拒绝未捕获。
   真实 CLI 子进程回归证明它会 exit 1，可能触发 Desktop 自动恢复；不能让安全拒绝变成隐式 crash/restart。

## 3. 本轮修复边界

- run shutdown 拒绝后仅关闭被动观察连接：ControlPlane SSE、RPC 订阅与 HTTP sockets。
  不清除 Computer Use 私有 descriptor，不处置 Chrome/Office/capability 执行器，
  不关闭 writable Store、不释放 leases，不声称未知执行 transport 已关闭。
- continuation 网络等待在原 run shutdown 拒绝时同样拒绝；即使保留的升级连接仍活，
  也能返回 failed lifecycle，而不是循环等待或伪造网络已排空。
- CLI signal shutdown 单飞并显式处理最终拒绝，保留 Host 和静态 blocked 诊断。
  只有原真实 drain 成功才 exit 0；失败不落入未处理 rejection/自动重启。
- 独审发现有限 media 观察超时不能永久缓存为最终失败，已补分层：
  `Daemon.stop()` 默认仍保留 5000ms media 观察；CLI 明确使用
  `stop({ waitForOwnedDrain: true })` 等原始实际 drain，不用超大超时或 timeout-as-proof。

## 4. 验证与证据边界

- 009/010：原网络失败路径在真实 bash＋SSE 隔离回归中稳定超时，命令仅执行一次。
- 011：互等已解除，暴露隔离 fixture 在更早的 `checkpoint.effect_unknown` 拒绝；
  已修正该阶段断言。它不是原 packaged approval-resume 的晚期 `host_not_drained` 场景。
- 012：单项隔离回归通过；015：加入保留升级连接及实际 CLI signal 后，相邻 51/51 通过。
- 013/014：旧 CLI 在受控 startup fixture 的真实 signal 下 exit 1；成功路径仍 exit 0。
- 016/017：独审提出的有限观察问题经真实 Media registry＋Daemon 和实际 CLI 两层红回归确认。
- 最终 018：8 文件组合 **83/83**，零失败/取消/跳过，actual exit 0；完整 stdout/stderr
  已读。Daemon TypeScript 编译及 diff-check 通过。独立只读差量审阅已复核修复，
  选定最终 diff 未解决已确认问题为 0；这不是新包或完整产品独审。
- 模型 transport 是确定性 loopback，无真实模型调用/费用；bash、SSE、升级 socket、
  CLI 子进程和 signals 真实运行。升级连接仅是保留 transport fixture，不是实际 Chrome 执行证明。

## 5. 必须继续的工作

1. 最终差量审阅与源码组合验证已完成，保存源码与证据检查点；不重复 018 或旧全套。
2. 补齐 Desktop/共享会话的显式停止受阻状态。当前 CLI stderr 被 Desktop spawn 忽略，
   静态诊断**不等于**用户已经在 GUI 看见 blocked；不能只改普通叙述冒充 Host 事实。
3. 明确并实现该受阻状态的可信 Host 投影，保留 fencing、no-replay 和未知效果阻塞。
   本轮没有新增持久 stopped/blocked 证明，也未改原始 Run 历史。
4. 对受影响冻结输入补差量 Office/打包审阅，随后打新 QA 包，用新唯一 case 验受影响链路。
   原失败证据和历史保留；不得用旧包截图或本轮 native green 代替 packaged 验收。
5. 继续总计划 P3/P4/P5 的未验项，不重跑 R02、时长格式、旧复制等已通过且未受影响的工作。

权威总计划仍是 [剩余目标计划](e6-remaining-work-plan-2026-10-23.md)。
本文件不授权发布、不启用主 CI、不升级全局 gstack，也不将总 Goal 标为完成。

## 6. Host → Desktop 停止观察契约（后继实现）

停止成功仍只来自原 Host 完整排空后真实正常退出；新通道**不是** effectCoverage、
stopped receipt、Run 终态或重放授权，不新增表、不改旧历史。

- Main 给其直接拥有的 Daemon 继承私有 FD5，与 FD3 engine authority、FD4 资源准备分开。
  stdout/stderr、HTTP、模型文本和文件均不能代替此通道。环境变量只接受固定 FD5，
  CLI 在启动派生执行器前删除该变量，writer 校验 FIFO/socket。
- 协议仅有 `draining`、`blocked`，固定 schemaVersion/PID/phase 三字段，严格单调最多
  两条 newline-delimited JSON，总字节有界，不携带命令、路径、密钥或原始错误。
  `draining` 在原 stop 前发布；最终拒绝才发布 `blocked`。重复 signal 不重复 stop/事件。
  observer I/O 失败不得跳过原 stop，也不得让被保留 Host crash。
- Main 从 spawn 时绑定的 child/PID/FD5读取；无效、截断、过大、乱序、身份不符或通道丢失
  都不能证明停止成功。EOF 不等于成功；需与原 child 的实际 exit 配对，避免正常退出
  时 pipe EOF 比 exit 先到造成错误重启。被替换 child 的晚事件不得改新状态。
- 已服务 Host 的 stop/restart 必须保留 child owner，观察超时仅表示停止未确认，不能
  SIGKILL、释放旧执行资源或启动 successor。启动前失败清理与已服务 Host 分开审查，
  不把旧 3 秒强杀规则套到有运行/效果的 Host。
- 退出预检要在销毁 IPC/窗口/Office/Computer Use 之前请求原 Host 排空。仅精确的
  停止受阻/未确认拒绝退出，其他普通 cleanup 错误保持既有失败退出契约；不能笼统吞错。
- DesktopRuntime 在 draining/blocked 时保留排空所需 transport；禁止新的 provider 调用。
  preload 补现有 daemonStatus IPC 的订阅，并由三种会话共享的连接状态栏消费。
  普通浏览器仍保持 HTTP offline 契约。停止受阻显示静态 Host 状态，不提供会隐式启动
  successor 的重连；不插入 agentMessage 或伪造任务最终总结。

分步验证：先隔离验证私有协议、signal 单飞和错误路径；再验证 Desktop owner/退出/恢复、
共享 UI 订阅及相邻正常退出。完成差量独审后才重包做新 nonce 的真实客户端验收。
这段设计与新增协议源码不代表 Desktop/UI 或 packaged R03 已完成。

### 6.1 本次已完成的 Host slice

- 已实现 Core 私有 FD5 reporter/observer、CLI 环境入口和 signal 的前置 draining 通知。
  reader 不从 EOF 推断成功，writer 不发送 stopped，原排空/保活门槛不变。
- 019 原代码两项红回归：缺少前置 draining；修复后 021 五文件组合 33/33，
  零失败/取消/跳过，actual exit0，完整 stdout/stderr 已读。含真实 FD5 子进程、
  实际 CLI signal/observer 丢失，只有不相关 server startup 被替换，无真实模型调用。
- 020 的 32pass/1fail 是新非 pipe 夹具把额外 fd 设为 ignore 后被 Node 重用；
  已改为显式继承只读普通文件，并断言 fstat.isFile，保留原拒绝断言，021 全通过。
- Core/Daemon TypeScript 编译和 diff-check 通过。独立只读差量审阅未确认剩余问题，
  精确源码 SHA 前缀：observer `97586c0f`、CLI `0e7a8389`、signal `30fc8f13`。
  审阅与 33 项结果仅覆盖本 slice，不覆盖未接线的 Desktop/UI。
- 下一步仅接 Desktop owner/停止观察/退出预检和共享状态；不能把此 slice 当已修正
  旧 3 秒强杀、失败仍退出或 GUI 显示。原失败 case 不重发，原 83 项不无故重跑。

### 6.2 Desktop、连接保留与最终源码集成检查点

本节覆盖上一 slice 的“尚未接线”，不改变原真实失败记录。

- Desktop 默认 spawn 保留 FD3/FD4 固定位置并接私有 FD5；按直接拥有的 child/PID
  观察停止阶段。观察超时、拒绝或异常退出均保留 owner，不发送 SIGKILL、不启动替代实例。
  EOF 本身不是成功，真实 clean exit 才能解除停止门槛。
- 停止单飞在发布同步状态前安装；逐个隔离状态监听器及其诊断异常，不能因观察者
  抛错而跳过 SIGTERM、崩溃 timeout 回调或让其他观察者收不到同一事实。
  startup 两处异步 race 先复核 generation，再分类 child error/exit，避免把已排空的
  原 owner 误报为普通 startup failure 并弹重试/退出提示。
- Runtime 新增 `prepareShutdown()`：同步关新准入，串行等待原 Host 真实停止。
  失败保留 coordinator、platform owner、continuation lease/heartbeat；未知停止异常
  规范为 `stop_unconfirmed`。失败 memo 可由下次显式退出重查，但不自动重试、不放开新工作。
- Main 在销毁窗口、IPC、Office、Computer Use 等任何资源之前完成上述预检。
  Exit lifecycle 仅对真实 typed `stop_blocked/stop_unconfirmed` 拒绝退出；停止已确认后
  的普通 cleanup 错误仍保留 exit-1 契约。停止确认晚到时，需用户显式再次退出才清理。
  restart 顺序同样为原 Host 停止 → 旧 coordinator 清理 → successor。
- Main coordinator/proxy/lease publisher 有不可重开的 drain 闩；保留已接受 exchange
  及其当前 session/in-flight requestId 绑定的取消通知。迟到 readiness、SSE 丢失、DELETE、
  lease 失败不能在排空中重新开门、拆 transport 或自动启动 provider。
- Daemon pool 同步停止新 acquire；已退休条目仍保留到真实最终清理。
  `index.ts` 仅在 `runShutdown` 成功后调用 final pool disposal，不再与停止证明并发。
  原 durable lease fence、stale-result、effectCoverage 与 no-replay 规则不变。
- Main IPC → preload 初读/订阅 → 公共 AppShell 状态栏已接通；普通/私聊/频道
  使用同一 Host 状态。draining/blocked 不展示原始 message/baseUrl、不提供隐式重启。
  Browser 原 HTTP offline/reconnect 不变。
- 55 语言目录同步完成：本次 6 个状态键及既有 6 个缺译键补齐，保留已有译文。
  新补非中英文译文来自仓库机器翻译脚本，不声称逐语种人工审校。

最终验证分别计数，不把相同用例的中间 rerun 累加为独立覆盖：

| 范围 | 最终结果 | 证据 |
| --- | --- | --- |
| Desktop owner/退出/IPC/初始订阅，9 文件 | 101/101，actual exit 0 | `output/e6-20260928/r03-daemon-restart-packaged-20261026/desktop-owner-exit-final-20261026.log` |
| Runtime + Main transport，6 文件 | 102/102，actual exit 0 | 同目录 `desktop-runtime-transport-final-20261026.log` |
| Daemon pool/原停止链，11 文件 | 213/213，actual exit 0 | `output/r03-host-lease-drain-20261026/qa-report.md` |
| 共享状态栏实际 authored component render | 4/4，actual exit 0 | `apps/web/test/app-connection-status.regression-1.test.mjs` |
| 55 语言目录/编译/本地化测试 | 审计通过，15/15，actual exit 0 | `corepack pnpm --filter @ling-stack/localization test` |

Daemon、Desktop Main/preload/renderer、Web 类型检查及 diff-check 通过。
保留红回归：Runtime 原 8 项全失败、退出/预检原 9 项中 6 失败、观察者异常 1 失败、
FD5 draining 后 startup 错误分类 2 失败、pool retirement 与并发 final disposal 各自失败。
所有修复后均由上述最终组合覆盖；没有操作真实用户数据库、没有外部模型费用。

只读差量独审确认观察者异常与 startup 分类两项 finding 已闭环；UI/IPC slice
没有剩余 confirmed finding。最终复核源码 SHA256：

- `daemon-lifecycle.ts`：`141c56041b382e90c3c6eefb4174dddaa83cea59a8af72074bb1bca68231d450`
- `desktop-runtime.ts`：`79c5db69ac9515e3553c264ab698ce23779cedd29b120e09a6f7ad86081a1f85`

**唯一下一步：** 对本次变更补精确 Office/打包输入差量冻结和审阅，随后新 QA 包、
读回归属和新唯一 R03 case 的真实 macOS 验收。保留旧未知效果 Host 与失败历史；
不强杀旧实例、不删除安全锁、不重发旧任务，不以本节隔离验证冒充 packaged 通过。

### 6.3 保留原 Host 时的隔离后继 QA 构建

04:56 本机进程读回确认原 Main/Host 仍存活，17928 无监听。因此不能运行要求旧 PID
消失的原构建 runner，也不能覆盖它们正在执行的 `release/human-qa` App。

- 仅新增闭集选择 `LING_DESKTOP_PACKAGE_HUMAN_QA=retained-host-r03`，固定使用
  `com.lingstack.desktop.human-qa.r03-successor`、`Ling Stack R03 Successor QA`、
  `release/human-qa-r03-successor`。普通与原 Human QA 的选择和输出不变。
- 准入、派生环境和异步 config 之后比较精确 lane 身份，而非两个 QA 共有的 boolean。
  继续使用原 Office source/publication、资源、签名和 final-artifact 校验及 `publish: never`；
  不接受任意名称、输出路径、签名或 Builder config 覆盖。
- 专用 runner 必须核对原 PID 的启动时间/父进程/命令、原 App 字节及新输出路径不重叠；
  不操作旧进程，构建前后核对原包未变。独立单写入者拒绝并发构建，不覆盖不明旧输出。
- 新客户端只使用新建的专用 QA profile/workspace，不复制或恢复原未知效果 Run。
  启动前再次确认17928无监听，并读回新 Main 直接拥有的 Host、目录与端口归属。
  此新客户端不是原逻辑 Run 的 successor；不得通过新隔离实例绕过原 workspace 的停止门槛。
- 固定包装清单显式补上 `daemon-shutdown-observer.ts` 和 `signal-shutdown.ts` 两个
  新运行时依赖；没有运行时发现或自动批准。新冻结记录保留 `approved:false/approval:null`，
  独审完整受影响差量后按现有 standing QA-only 授权应用正式 manifest，不作发布。

新 lane/清单回归先红后绿，五文件组合301/301、无失败/取消/跳过、actual exit0。
它只证明编排、固定身份和校验边界，不是实际构建、原生签名或 GUI 验收。

### 6.4 真实打包失败后的诊断与新尝试

05:14 的后继打包实际在最终 DMG 子进程校验失败，原日志与 ZIP/DMG 保留。
系统休眠/唤醒与该命令重叠，但日志没有信号或耗时，不能追认精确杀死原因。
旧 Host 同期 exit 1，旧 Main 仍在；这两件事不得互相充当因果或安全停止证明。

- `runBoundedCommand` 的失败增加固定、有界 transport 诊断：命令 basename、闭集
  hdiutil verb、PID、开始时间、单调耗时、配置 timeout、exit/error code、signal、
  killed、stdin 失败、输出字节数与 `outputComplete`。诊断直接进入 Error message，
  避免 Builder 只打印隐藏 cause 外壳；不记录 argv、输入、输出正文或环境变量。
- 诊断不是新的停止权威。原错误仍拒绝，`outputComplete` 原 predicate 不变，
  timeout/signal/overflow/spawn 失败不能据诊断产出 attach ownership 或安全效果。
  新真实子进程断言在修前 6 项失败；修后与 attachment custody 组合 138/138。
  两文件差量独审 0 confirmed finding，未重复原 301/101/102/213 长套。
- 打包恢复与原 Run 恢复分开：原失败日志、产物、锁、App/profile 和 unknown effects
  必须留存。只在明确核验当前受控构建进程/解释器目录和相关挂载均无占用、原 App
  完整 inventory 不变后，才可用精确目标的可恢复 rename 保留失败输出与旧构建锁。
  此核验只允许下一次受控打包，不追认原历史后代停止，也不改变旧 Run/效果/预算。
- 新尝试记录 direct build 结果必须先于 post-build invariant 检查；后置进程身份
  变化不能抹掉原退出结果。独占 lease 仅在 awaited 成功后释放，失败继续保留。
  使用进程作用域 `caffeinate -i` 防止本次实际出现的 idle sleep，不改变系统设置，
  不保证抵抗手动休眠/合盖/关机/强杀，不延长时限或绕过最终校验。

完整证据位于 `output/e6-20260928/r03-packaging-successor-20261026/`。
本节不是重打包、R03 GUI 或 P3/P4/P5 的完成证明。

### 6.5 新包真实 R03 后的观察层缺口

后继构建与包身份读回已成功；新独立 profile 的真实 GUI 提交一次任务并允许一次，
tick8 时仅对所属 Host 请求一次停止。客户端真实显示 draining→blocked，保留原 Host、
阻止 successor；工具自然完成也未把 descendants/effectCoverage 的 unverified 升级为安全。
Run 仍 running，此结果只证明安全阻断 slice，不证明 R03 整体或重启恢复通过。

同一现场发现：HTTP已关闭后，会话/侧栏/输入框/toast重复展示 Failed to fetch，旧action
与Agent placeholder仍被当成实时状态。Desktop新claim仍持续轮询。完整证据见
`output/e6-20260928/r03-packaging-retry-20261026/live-findings.md`。

后继修复契约：

- 只有可信Desktop自有Host的停止状态且endpoint归属匹配，才暂停新只读观察/重连；
  browser普通断线、外部Host或不同endpoint不得误暂停。
- 观察暂停与执行终态独立。保留快照和accepted submission，不改Run/Attempt/Item事实，
  不重发提交，不凭断线推导失败/取消/成功。
- 错误合并必须保留transport来源，不能按错误字符串或scope把业务/HTTP/校验失败吞掉。
  已开始请求的迟到失败和停止后的新刷新都应受当前观察闩约束；恢复后仍需精确source读回。
- 三种会话和嵌套子Agent共用观察暂停展示；实时动画停下，并标明上次观察状态，不另造最终回复。
- Main只关闭新claim准入/availability；已接纳执行、lease、结果回执和helper资源仍由原停止契约保留。
  在途claim返回必须明确处理，不可直接丢弃已接纳操作或使用shared abort假装排空。

恢复与投影的额外约束：

- receipt查询每次backoff后的实际GET都重查当前准入与原epoch；暂停前的`unknown`不能
  在暂停或恢复后充当本次提交被拒绝的证明，未确认journal继续保持query-only。
- 有效accepted receipt、原已接纳stream的生命周期回执仍是事实，可释放对应防重复指针、
  收口本地发送状态；旧epoch的消息body/narration/详情快照不得覆盖恢复后的投影。
  观察中断不能把同一stream真实done变成失败；也不能从本地发送settle推导Run已安全结束。
- strict控制面刷新若因navigation/paused/stale epoch未实际应用读取，必须defer，不能推进
  invalidation cursor。新epoch的频道Run详情必须重新读取，不能因旧缓存或旧load key跳过。
- `loadRun`及其`refreshRuntimeState`的分阶段读取需要在每个await后核准入；只在外层await
  完成后检查，挡不住内部后续请求或已经发布的旧WorkUnit/lease投影。真实业务错误保持可见。
- 停止/撤销已接纳操作不受新消息/新guidance准入门的总禁用影响；不abort既有lease/result。

源码/隔离回归与差量独审正在收口；当前运行包尚不含本节修复，真实GUI仍未验收。
不重复已通过的FD5接线、长套或旧任务。

#### R03-OBS 源码检查点（2026-10-26）

本节的源码和隔离回归已收口；上句“正在收口”保留为历史过程，不是重新开工指令。
Desktop/Office仅暂停新claim及idle availability，保留accepted execution、lease与result；
只在显式新Host rebind后开放新generation，含被较新drain打断rebind后的合法恢复。
停止状态订阅不再错误依赖Computer Use启用开关。对应源码/测试本地提交`134ea739`。
API fetch/SSE reader保留typed transport来源，AbortError/HTTP/JSON解析/业务异常保持独立；
不增加重试。API源码/测试本地提交`6c8dc912`。

Web以共享observation context接入三种会话及嵌套子Agent，只改变观察语义与实时动画，
不改canonical status/revision/sourceRefs。普通/频道/私聊的新消息、receipt backoff、
迟到snapshot与SSE presentation分层；真实接纳/链接/终态发送生命周期保留，旧epoch消息
不得覆盖新快照。频道Run和Runtime分阶段读取、列表及旧cwd callback都检查当前owner。
审批已成功后的typed deferred读取只停止fan-out，不能反报审批失败；真实错误继续归原owner。

验证（不是GUI）：Desktop最终49/49、API53/53；Web最终八文件组合132/132，均actual exit0，
零失败/取消/跳过。Main/Web类型与diff-check通过；不把多次局部重跑累加为新的案例数量。
Web最终命令：`node --experimental-strip-types --test`，显式指定以下八文件：

- `daemon-observation.regression-1.test.mjs`
- `conversation-stream-observation-recovery.regression-1.test.mjs`
- `control-plane-conversation-recovery.regression-1.test.mjs`
- `channel-observation-pause.regression-1.test.mjs`
- `teammate-observation-pause.regression-1.test.mjs`
- `run-observation-pause.regression-1.test.mjs`
- `app-shell-observation-pause.regression-1.test.mjs`
- `app-shell-approval-refresh.regression-1.test.mjs`

最终日志位于`output/e6-20260928/r03-packaging-retry-20261026/`：
`web-observation-integrated-final.log` SHA256
`6963aab5111e887b83b79d7af116e73d86fb985397c7be3cfd8be457a784d02c`。
差量独审分别见同目录`desktop-observation-independent-review.md`、
`web-core-observation-independent-review.md`、`runs-runtime-shell-observation-independent-review.md`。
初审私聊finding由未实现这两文件的主代理复核最新源码与最终组合结果，无剩余确认问题。

仍未完成：新字节精确QA冻结/打包/真实GUI复验，以及总计划P3/P4/P5。
当前保留Main/Host和App/profile不得被本检查点覆盖、强杀或重放；未知效果仍保持未知。
没有push、PR、merge或发布，不把本地checkpoint当最终交付。

#### R03-OBS 新包结果与侧栏补充（2026-10-26）

f802141d新包已真实完成冻结、构建、包读回和GUI单次命令/审批/停止请求；
不是仍在等待打包。证据目录为`output/e6-20260928/r03-observation-package-20261026/`。
Main28239/Host28249保留，marker start1/tick60/done1，prepared/settled/start/end各一次；
SQLite仍为Run running、stop stopping、descendants/effectCoverage unverified。
drained_at和工具自然退出不是后代安全证明，不能自动successor或重放。原5715/5734同样保留。

GUI真实看到了draining→blocked、Agent待确认、工具旧快照，重复transport错误已消失。
但侧栏仍将快照直接读作运行中，不能把该包的R03-OBS完整验收标绿。
侧栏沿用现有可信、同workspace的DaemonObservation：只对running/waiting添加旧快照说明、
中性色和可访问/hover文案，保留canonical primaryStatus、审批计数、failed/paused状态。
不从断线推导终态，不改数据库，不禁用或删除已接纳运行的Stop入口。

新原生回归`sidebar-observation.regression-1.test.mjs`已在修前真实失败、修后通过；
覆盖三owners×四状态×live/同cwd暂停/异cwd暂停及输入不变，与共享观察回归组合5/5。
Web typecheck:ci及diff-check通过；最终两文件独审0确认问题，具体SHA和证据见
`output/e6-20260928/r03-sidebar-observation-repair-20261026/`。
这是源码/SSR验证，尚未进入新包，不冒称当前GUI已修复。

另一个现场诊断已结案：五秒locked-task-continuation sync_failed来自已关闭HTTP的锁策略续约。
它不是Web新claim、不是重放，也不是递归loop。现有failed-preflight回归刻意要求保留该lease；
在真实cleanup前不能为消除诊断将其取消或改变过期策略。本轮不作此类改动。

后续只需在下一份非覆盖QA包中核验最终侧栏字节，再继续其它P3/P4/P5案例。
不重发任何保留现场的命令、审批或SIGTERM，不重复先前132/49/53项套件。

第三固定QA输出：两组旧App仍被保留Host占用，新的`retained-host-r03-observation`
只映射到`release/human-qa-r03-observation`及独立固定身份，不能由调用者传路径/名称。
仍沿原awaited macOS打包、资源/Office/signing/final-artifact守卫和publish:never路径，
不放宽原两lane或ordinary行为，不修改旧App、profile或未知效果。精确lane选择在所有
异步构建边界保持一致；第三lane和既有完整邻接原生回归104/104通过，先RED后GREEN。
这属于隔离验收的打包基础，不是新的运行权限或正式发布授权；对应closure只有lane源码
一项变化，须独审并将精确差量绑定QA记录，不能直接忽略旧manifest的hash不匹配。

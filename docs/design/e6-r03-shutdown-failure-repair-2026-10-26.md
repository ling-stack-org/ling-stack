# E6 R03：停止失败路径修复与接续点

状态：源码修复/隔离回归检查点；**不是 packaged R03 通过，不是总目标完成**。
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

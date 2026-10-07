# 七项执行阻塞：已确认边界与闭环计划

2026-09-09：用户明确回复「好的，按照你的建议处理吧」，确认下列取消与 HTML
产品规则。本文件取代此前「这两项待用户决定」的状态，不表示能力已实现或测试已通过。
继续使用专用恢复工作树，保留 WIP；不提交、推送、合并，不改真实 SQLite/凭据。

## 1. 取消不是回滚，也不是任意后代停止证明

- 取消本次任务及其所属子 Agent，不再派发新操作，不取消其他独立任务。
- Host 对持有的执行进程/进程组尽力发送终止信号，升级强杀和等待输出都有上限。
- 分离逻辑取消、leader exit、stdio close、清理请求结果和后代停止确定性。
  `killpg` 返回、SDK idle、leader exit、管道关闭均不能证明所有 detached 后代已停止。
- 停止无法确认时，显示「任务已取消，后台进程停止未确认」；不可显示「全部已停止」。
  保留已产生的输出/修改及诊断；不自动撤销文件或外部请求。
- 未确认状态要持久化并绑定 run/attempt/toolCall/workspace，重启不可清空；禁止自动
  retry/successor/新写任务与这次未确认执行产生重叠写入。只读查看和其他隔离工作区不受影响。
  重新核验/用户处理必须可追溯，不能只依赖过期时间或点击重试就解除。
- 本次取消边界不放宽文件和网络权限。已有跨目录硬链接反例仍是必须修复的安全问题。
  用户已接受的风险是后台后代可能继续访问其原获准资源，不是访问未获准资源。
- 安全让出 `yielded` 仍需独立判断是否可续接；不能把「取消已受理」当作停止 receipt。

## 2. HTML 的三种操作

| 意图 | 默认处理 | 授权/事实 |
| --- | --- | --- |
| 看源码 | 文件查看器/代码 renderer | 不执行页面 |
| 运行网页预览 | Ling 隔离可交互预览 | 项目资源范围受限，不继承日常浏览器会话 |
| 明确使用系统浏览器 | 独立 Host 打开动作 | 用户明确选择或绑定该调用的审批；不冒充受限预览 |

隔离预览允许页面脚本，但无 Node/Electron/Ling bridge、任意本地文件、默认外部网络。
项目资源通过受控读取提供；路径逃逸、链接别名、MIME、导航、弹窗、下载、权限请求和
窗口关闭都须有明确策略。资源被拦截/脚本错误/加载失败须可见，不以静态降级冒充正常运行。
启动开发服务器或安装依赖是独立命令执行，不能作为「打开」的隐藏副作用。
Host launch 回执只证明启动被接受；页面/窗口实际可见需要额外 UI 证据。
系统浏览器显式点击作为该次授权，不再重复弹窗；模型请求使用现有独立审批链路。

## 3. 模块边界与实施顺序

1. **执行生命周期**：独立 process observer 管理取消、超时、清理升级、有限输出等待。
   unified-exec 只接线并保存结构化观察；不得把平台进程逻辑继续塞进 orchestrator。
2. **持久化与恢复**：复用现有 SQLite 事实承载，补停止风险与执行准入检查；覆盖普通执行、
   审批恢复、自动重试/问答续接。模型文字或错误字符串不是解除风险的凭据。
3. **受限命令**：接通 Host policy、原生 executor、硬链接保护与 runner tool-before，
   无支持则显式失败，不原始 spawn fallback，不仅删除 readiness 门禁。
4. **目标与命令绑定**：用户明确命令保持 exact constraint；自然语言目标允许模型生成
   具体调用，但必须保存原目标和具体调用之间的 lineage，校验文件/函数/参数和真实执行结果。
   不把模型命令伪装成用户原文，不仅用 Node executable 白名单判完成。
5. **Host 打开**：接通隔离预览/显式系统打开、审批和已有 host-open receipt 的生产消费者。
6. **参与者与收尾**：启动后继续核验 owner、required participant、fan-in 和最终报告发布。
   共同启动阻塞解除不代表这些后置断言已经通过。
7. **实际验收**：七项目标、异常/恢复回归，再更新专用 macOS QA 包，用真实模型留下
   普通/私聊/频道/多 Agent/小项目的可检查历史和截图。不以静态 provider 测试替代真实 App。

## 4. 原七项验收，不改变业务目标

实施记录：执行器有界取消之后，已接入 Host 命令 journal、准备/启动/完成边界、共享工具
写入风险检查和审批恢复；SDK 不再自行回退执行 Bash。专项 54 项已通过。
这仍不是七项或完整取消安全验收：其他写入效果的原子预约、跨 Store 物理范围协调、
风险的客户端展示与可追溯处置、受限命令及 Host 打开仍需完成。
详见上一阶段进程观察 (`cancel-process-lifecycle-handoff-20260909.md`)和
Host journal 阶段证据与后续边界 (`host-command-journal-handoff-20260909.md`)。

| 编号 | 原目标 | 验收重点 |
| --- | --- | --- |
| 1 | 指定命令不被语义替代 | 原命令约束、真实工具证据、错误命令不完成 |
| 2 | 后续会话打开最近文件 | 历史目标准确、授权、实际打开和可见验证 |
| 3 | 创建文件后运行 Node | 创建依赖顺序、运行证据、部分失败不虚报成功 |
| 4 | 自然语言 Node 验证 | 文件/函数/参数不丢失，不要求用户手写完整命令 |
| 5 | 指定自定义 Agent | 不被同角色默认 Agent 替换 |
| 6 | 同角色多个 Agent | 独立 required participant，不漏证据 |
| 7 | 发布最终结果后才收尾 | callback publication 完成前源 turn 不终结 |

原 detached 反例保留。产品取消测试按用户已确认的合同新增「明确未确认 + 阻止重叠执行」
断言，不能把仍存活进程改报为停止成功。硬链接越界测试仍必须拒绝越界。

未决产品选择：这两项已确认，无待用户重复确认项。实现和实机验收尚未完成，工程失败
继续定位修复；只有确需新增系统服务/VM/权限或扩大边界时才提出新的具体决策。

## 5. Host 命令取消事实与执行准入细节

- 命令启动前，在原 Run 的 `run_events` 提交 `host_command_prepared`。绑定捕获的
  workUnit/attempt/runtime/fence、toolCall、工作区逻辑路径与物理路径、实际 cwd 和命令摘要；
  不把原始命令中的凭据写入 journal。以同一 `BEGIN IMMEDIATE` 完成冲突检查与准备记录，
  同一数据库内的父子目录和符号链接别名视为重叠范围。
- 准备与启动是两个边界。准备先持久化；物理 spawn 前再在写锁内校验原 owner，使用
  Host 内存中的一次性 ticket。复制公开 executionId 不能获得启动或 settlement 能力；
  SDK/模型普通事件 API 拒绝写这两种专用事件。
- `host_command_settled` 独立于 Runner/SSE 发布，允许旧进程在终态后补诊断，却不允许
  它解除风险。`completed` 仅限当前 owner、leader 已退出、stdio 已关闭、无停止原因和
  信号异常；它不证明任意 detached 后代全部停止。其他终止观察保留 `stop_unconfirmed`。
- spawn 前同步失败可以记 `not_started`；spawn 后 Host/数据库异常必须清理实际 child，
  不能当作没启动。settlement 写失败时保留已提交的 prepared。首条 settlement 幂等，
  冲突拒绝；用现有表上的唯一表达式索引约束，索引在建表后的迁移阶段创建。
- 重启后 prepared 无 settlement 仍阻塞。读取先校验 settlement 再排除正常完成，
  损坏的“完成”记录不能解锁。没有 TTL、自动重试或模型文字解锁入口。
- 普通/私聊/频道统一在工具准入、审批后和审批恢复时查询风险；已知只读工具可以继续，
  未知工具不自动认定只读。这一检查不授予新的文件、网络或 Host 权限。
- Host 命令执行默认开启；显式关闭意味着拒绝 Bash，而不是回到未记录的 SDK 执行。
  Runner 始终注册 Host Bash wrapper，避免缺省/false 开关绕过权威结果。

当前明确未闭环的边界：

1. journal 的原子预约覆盖命令；文件/MCP 等目前是工具边界的风险检查，尚不能把
   “已通过检查、稍后才实际执行”的动作视为拥有完整原子预约。需结合现有 lease/owner
   链路补齐，不能声称所有写入并发都已解决。
2. journal 查询属于相应 RunStore。同一物理目录经不同项目 Store 接入时，仍需验证并
   补齐跨 Store 协调；不同 Store 不自动等于物理隔离。
3. 客户端需要显示“停止未确认”及可追溯的独立核验/用户处置。当前安全默认是保留阻塞，
   尚无可交互的解除流程；不能用点击重试或修改历史记录代替该流程。
4. 以上都是内部链路的实现事项，不是取消/HTML 产品选择尚待确认。受限执行器与
   HTML 隔离预览仍按前述顺序继续，最后完成真实 macOS 验收。

## 6. 受限命令的原生输入快照链路

2026-09-09：已实现原生文件级输入捕获及 Daemon 消费端，尚未接入频道命令调度。
这不是原七项完成，也不改变 §3 的执行器、目标绑定、Host 打开及真实客户端验收范围。

- 原始工作区不能因为运行命令就直接获得无边界写入。执行副本的输入由 Host 按
  已验证范围选择；原生 helper 用目录 FD/openat 逐级读取，固定根目录 dev/inode，
  所有目录和文件拒绝跟随 symlink。未知多硬链接输入拒绝读取，因为新 inode 副本
  只能保护后续写入，不能使此前未授权的读取变为合法。
- 只接受普通文件，默认调用预算由 Host 指定，上限 64 MiB；FIFO 使用非阻塞打开后
  拒绝，避免等待写端。读取后比较 inode、size、mtime、ctime、link count，再重新
  验证根和目录项；任何变化都整次拒绝，不输出部分内容。
- 私有管道传输闭合请求、分块和完成记录。Host 核对 helper 身份、请求随机标识、
  原 Run/Attempt identity、顺序、字节预算、元数据、进程退出和最后的 owner 校验。
  取消、超时、截断和错误响应均不能得到可发布输入。Wire identity 不是授权，
  配置提供的 hash 也不能自行认证配置；后续接线必须使用 Host 可信打包身份和真实
  sourceFence 校验，不能把测试回调移成生产默认实现。
- 已验证 Host → 原生读取 → 新 inode 副本 → 真实 Seatbelt/Node 的临时夹具，
  Node 输出 proof:7319，直接读取 origin 被 OS 拒绝。该夹具不证明完整依赖复制、
  输出回写、多 Agent、频道调度或 packaged GUI 已可用。
- 后续接入时，需区分用户工作区/原命令与实际副本 cwd，保留输入 hash 与源引用。
  复用现有 command journal 和原子启动 guard；准备阶段失败必须准确 settlement，
  不能产生未启动却永远不释放的风险记录。不能只删除 readiness/审批门禁。

实际代码、红绿证据及剩余范围见
原生输入捕获阶段记录 (`native-input-capture-handoff-20260909.md`)。
无新增待用户决定的产品选项。生产调度、依赖语义、输出发布仍是未完成的实现事项。

## 7. 自然语言 Node 调用目标与具体命令分层

2026-09-09：已接入生产 selector 指令、Host binder、公开 binding 校验；原第 4 项
已从「缺少原文 command」前进到受限命令 readiness 阻塞，仍不是该场景整体通过。

- 显式命令仍使用 `command`，完整命令与其 quote 必须属于当前 operation 的原文范围。
  自然语言 Node 调用使用互斥的 `commandGoal`，保留 module、invocation 与 canonical
  source refs。模型不能提供或自行认证 Host 的最终 binding。
- 第一种结构化目标是 `node_function`：模块为已绑定工作区相对路径，调用为当前用户
  原文中的导出函数及 JSON-literal 参数。模块来自其他指令范围时，必须有唯一显式
  file_read/file_create/file_edit 依赖；绑定保存 inputOperationId，不能只选第一份文件。
- Host 从目标生成确定的实际命令，使用动态 import、命名导出/CommonJS own property、
  单次 await 调用及真实返回值。函数缺失、导入失败或 Promise 拒绝均保留非零失败。
  Host 不 eval 用户表达式，不把生成的 Shell 命令伪装成用户原文。URL 编码与 Shell
  quoting 分层处理，拒绝无法编码的路径、任意表达式、非有限数字和超预算输入。
- 原目标保存在 commandGoal；生成后的 exact command 保存在 effectScope 与既有
  commandMatchPolicy。共享协议校验重算生成命令与输入范围、检查依赖和 fingerprint，
  因而不能只重算 plan fingerprint 就把参数、模块或最终命令换成另一个目标。
- 复用原审批前精确匹配及完成后的真实 commandEvidence 校验，不新增成功判定捷径。
  一条命令即使打印出相同结果，也不能代替原函数调用。实测 Host 结果进入 SQLite
  后，重开 Store 仍保留目标、Run/Step/participant 归属和 evidenceActionIds。
- 这只闭合已定义 Node 函数目标的绑定，不替代普通 Shell 能力、任意自然语言目标、
  依赖树解析、输入隔离或输出发布。无完整执行后端仍明确阻塞，不放宽环境/网络权限。
  其他目标类型的内部接线仍属于既定完整计划，不要求用户改成手写命令作为永久方案。

证据与尚未完成的生产执行入口见
Node 目标绑定实施记录 (`node-goal-binding-handoff-20260909.md`)。
未决产品选择：无新增；执行器、Host 打开及真实 macOS App 验收继续保持未完成。

## 8. 受限命令后端、真实权限复验与频道调度接线

2026-09-09：§6/§7 的“尚未接入生产调度”是当时状态。本节更新：已完成配置注入下的
真实后端与频道调用链，原生 10 项异常/隔离测试、Node evidence/SQLite reopen、
真实 Pi 频道自然语言 Node 场景均通过。原七项默认矩阵与 packaged GUI 仍未完成。

- 可信 Host bootstrap 提供 helper/executable 的固定路径与 hash；runtime 不从项目、
  模型或 PATH 选择后端。未配置仍明确拒绝，不回退 raw spawn。
- 统一 Bash 入口重验唯一 owned exact command、不可变 Run/Step/participant、依赖
  evidence、原 sourceFence、当前 policy 和 durable approval。准备前、异步捕获后、
  原子启动回调中重复核验；恢复审批通过真实 resume_pending 的新 Attempt lineage。
- 原工作区与执行副本分离。只复制明确授权输入的新 inode，输入只读、scratch 可写，
  不继承 Host 环境、不授网络。保留原命令/cwd 与实际 argv/cwd、输入 hash/source refs，
  对实际 argv 使用既有脱敏规则。副本不改变 conversation context 的语义。
- journal 先持久化 prepare，再准备副本，最后在同一写锁内检查并 spawn。
  准备/启动前失败准确记 not_started；准备后取消不能遗留永久 prepared。
  未知停止保留隔离文件与风险记录，不声称所有后台后代停止。
- 原子 launch 内的依赖证据读取使用显式只读事务窗口。嵌套投影不能写入、不能开启或
  提交另一事务；未显式标识的外部事务仍拒绝收编。
- 本轮不增加 SQLite 表、不修改真实历史。runtime、authority、UI/投影保持模块边界。
  实际资源打包、完整依赖/输出发布、Host HTML 打开和 macOS GUI 验收仍属既定范围。

完整证据、测试迁移说明与剩余范围见
受限命令接线实施记录 (`restricted-command-dispatch-handoff-20260909.md`)。
未决产品选择：无新增；不得把上述专项通过表述为原七项或整体计划完成。

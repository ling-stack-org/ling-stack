# E6：graceful tree suspension / restart 收口

状态：S1–S10主链已有定向实现与证据；当前在收齐最终全套回归、Office具体批准和客户端验收。
下文较早阶段的缺口仅是历史检查点，以本节和最新验收总账为准，不能作为完整E6验收通过记录。

2026-10-23后续增量覆盖上方“自动启动组合尚缺”：默认Daemon新PID只调用`start()`已通过
普通已封存三层树自动恢复，以及第二次启动不重派。queued/noAttempt已有独立never-dispatched
证明与首次dispatch验证；最终SDK树9/9、Core联合304/304、Daemon邻接139/139，均actual exit0。
后续S8/S9已补齐compaction/final-assistant独立authority，S10定向163/163及原gates58/58通过。
当前全量新失败、Office新差量批准、真实模型/客户端验收仍未完成；历史未实现状态不再适用。
全量后继已修普通取消执行器的`stop_without_resume`关机路径，提供的terminal handoff仍需先验证。
旧production optional测试的post-run hook已移到真实SDK settled窗口，完整文件13/13、actualexit0；
没有放宽Core/Host准入、超时、排空、usage或result断言。最终Core/Daemon全套正在执行。
基线：`codex/e6-safe-continuation`，`c71bae7526955d6458909ea6d919de7ac6ec317a` 加当前 WIP。
唯一实施树：`/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`。

## 固定边界

- 用户已批准 optional `stop_with_parent`；失败不等于 required 失败，但未知停止结果不算整树完成。
- required 后代不因祖先 optional 而自动变 optional。
- Harness 默认不删、不自动 TTL/enroll；仅接受 Host 显式截止时间清理无引用正文，普通历史不删。
- graceful suspension 不是 failed/cancelled terminal intent，也不是用户显式 interrupt；三个事实不能互相代替。
- 不重放原 prompt、已完成工具、unknown effect；不退款、不延长原 reservation/deadline。
- 没有生产 native Session handle；Pi `SessionManager.inMemory(cwd)` 的真实恢复输入是 Host-sealed SDK view。

## S10：optional终止与shutdown的独立交接（定向GREEN＋冻结独审）

`stop_with_parent`的普通终止与graceful suspension必须保持两个独立事实。已abort的执行器
不能重分类为resumable；纯signal.reason、completion Promise或status也不是终止证明。

closeParent必须在任何物理abort之前，为完整选定子树leaf→parent保存exact原source的durable
terminal intent。全部成功才发停止；中途失败保留原行，不做部分abort。已有failed disposition
优先，不得改写为cancelled。旧intent exact replay在Core182 admission veto前，保持原guard。
原Host completion未注册、foreign source、旧process-only abort没有durable intent仍blocked。

原composition为每个delegated execution签发constructor-custodied nominal terminal handoff。
shutdown请求阶段只捕获intent和exact source；真正终验放在原executors、registry与order
finalizers全部完成之后，读取Core终止result及Host drain/effect/quiescence、usage、reservation
和全后代证据。不能清除其他source持久化失败，不授权重放、退款或延长deadline。

证据：`output/e6-20260928/s10-optional-terminal-handoff-evidence-20261023.md`。

## S9：最终 assistant 的独立 settlement authority（组合GREEN＋冻结独审）

真实 SDK 回归已确认：`onTaskSettledBoundary` 未接 Host，使最终 assistant 后才到达的暂停请求报
`suspension.boundary_unavailable`。不能把 final assistant 放进普通 checkpoint allowlist，或从聊天
文字推导 SDK、工具与子树已停止。

- Runner 在原非 aborted `agent_settled`、`run_end` 前冻结独立 SDK view；WeakMap receipt 仅在
  这个原窗口可读，返回 detached clone。Host callback 参数被修改不能改变原观察。
- Core additive187 `run_final_settlements` 保存独立不可变 ledger；private writer 仅接受原
  constructor 捕获的 observation reader。冻结 lineage、SDK view、canonical final/工具/effects、
  budget/usage 与 retained dependencies；只验证当前 source 实际执行的工具属于其 SDK inventory，
  不要求恢复 view 的历史工具在新 source 重执行。无动态预算的普通 Run 不凭空增加 charge 要求。
- witness 使用 `kind: settlement` / `.settlement`，不造 ordinary/compaction checkpoint。182 seal、
  183 physical stop、184/185 root activation/ACK、186 child activation/ACK 和 recovery pins 均验证
  原 ledger。final settlement 不是整树成功证明，不要求父保存 SDK view 时所有 required child
  已完成；真正恢复后仍走原 required fan-in / optional stop-with-parent 链。
- Host 在原 settled callback 接请求、封存、等待 descendants-ready、再次封存验证，然后 begin-stop；
  不能等待自己的 lifetime。unknown effect/usage/drain 仍 blocked，不改真实数据、不自动重放。
- stopped 私有 reader 支持 activation 与实际 ACK 前后重验。root/child 根据已验证 view 选择原
  ordinary 或 compaction installer，恢复完整 final 时仍需要真实 SDK ACK 和 Host 权限新鲜度，
  但零新 provider wire；不重新 prompt、不创建新 Task、不把 settlement 当普通 progress witness。

### complete恢复后再次暂停的独立 authority

恢复后的完整 assistant view 不是一次新模型 settlement。Runner 在真实 prepared ACK 与
`before_agent_start` 校验之后，进入独立 `onTaskRestoredCompleteBoundary` 窗口；原settled reader
不能读取该窗口，新的 nominal reader 也不能在ACK内、窗口外或复制receipt上生效。
Host复用同一final/fan-in控制逻辑，但向Core提供独立`pi_restored_final_settlement` kind。
Core自行读取exact184/185或186不可变predecessor链，复验完整view、真实ACK和全部pin；
当前Attempt必须零新工具inventory/charge，canonical新增仅允许它自身已ACK的`run_start`。
不能通过caller传递的inherited布尔或旧checkpoint授予再次封存权。

原始和恢复后的final窗口都必须覆盖optional真实排空及required fan-in。durable shutdown请求仅
取消Host观察等待，然后在同一原窗口封存；不abort SDK/child，不把closeParent返回当drained。
长等待后再次核验owner、predecessor和Provider/D1。无新wire的complete路径也须在ACK后主动
核验Provider，不依赖只有发模型才会运行的invocation gate。

回归必须覆盖A原final→暂停→B实际ACK complete→required子仍pending→再次暂停→C实际ACK，
并逐级验证新Attempt、零新root wire、原read/spawn恰好一次、预算/deadline不变及真实fan-in。

证据与接续：`output/e6-20260928/s9-final-settlement-evidence-20261023.md`。S8 已 GREEN 的冻结
独审不覆盖 S9 新字节；S9 必须 fresh build、原 Host RED 转 GREEN、异常/撤权/child 矩阵后再独审。

## 已确认根因

1. child shutdown 已先落 durable interrupt，再 leaf-first stop/drain，但 root 非审批 `runtime_suspend`
   仍走 `runtime_interrupted_no_checkpoint`，不是逻辑可恢复暂停。
2. `recoverStore()` 仅 dispatch `queued_unclaimed`；不能把进程间 queued 用例算成 running 恢复。
3. 当前普通 checkpoint 只在下一 provider boundary 封存；SDK abort 后直接 dispose，最新 view 未保存。
4. interrupt 已把 child Attempt/unit 改为 cancelling；不能再调用只允许 running/started 的普通 checkpoint writer。
5. abort 后 orchestrator 丢弃非 `run_cancelled` 事件，晚到 `tool_end` 不能与 SDK view 配对；
   仅增加 abort 后 snapshot callback 不足以恢复。不得放宽普通 writer 或接受 aborted assistant。
6. registry `stopAdmission()` 立即 abort 全局 wait，可能先于 source suspend intent 把工具变成普通失败。
7. 普通 checkpoint 缺 delegation 工具事实支持。此项本轮已补源码/隔离回归，仍需 fresh 组合验证；
   `wait_agent` 仅是有归属的观察，不是子树完成/停止/预算结算证据。

## 最小实现顺序

### S1：持久化请求、关闭新准入

Host 对现有 root/child 的 exact Run/WorkUnit/Attempt/runtime/fence 保存 suspension identity。
先停止新 admission 和 recovery scan，但暂不 abort in-flight delegation wait 或把源变为 cancelling。
持久化失败不能继续声称已暂停。新 source 不能消费旧 source 的请求。

### S2：在真实 SDK 安全边界封存

复用 `onTaskContinuationBoundary("before_provider_request", modelView)`。
Host 先核验 source、所有 tool pair、原 canonical watermark、effect receipts、当前权限和 provenance，
再用 head CAS 保存实际 SDK view。此专用 producer 即使没有新 `tool_end` 也要核验完整 view，
不能沿用 ordinary controller 的 `not_needed` 捷径。compacted view 走既有 compaction producer。

增加独立 suspension directive/latch，不冒充 user-input yield；模型/HTTP DTO 不能制造此 authority。
封存完成后不得开始下一次 provider/tool 派发。不能在 boundary callback 内等待自己的 Run completion。

完整 `stopReason:"stop"` assistant 需要实际 provider settlement 与 exact terminal snapshot 验证，
才能恢复为 `complete` 而不发模型；Core 当前尚未支持，不可直接扩大 allowlist。

### S3：再 interrupt、停止、真实排空

对已封存源沿用现有 durable interrupt 和 leaf-first exact stop。
原 `runCompletion`、local writers、Host effects、required questions 和后代全部 drain 后才写 stopped receipt。
到不了安全边界、SDK/工具不结束、partial tool batch、unknown usage/effect 一律 retained/blocked。
停机超时不是物理停止证明，也不是释放 Store 或资源的授权。

### S4：root 逻辑保持开放

专用 suspend 分支先于 generic failure 和 terminal `stop_with_parent`。
只有 suspension checkpoint + 原 source stop/effect proof 均成立，才允许形成可恢复的 root。
复用既有 atomic continuation activation；如需要新 suspension audit/receipt，startup 必须验证该精确事实，
不能伪造 `runtime-startup-reconcile` 或扩大任意 stale/lost source 的准入。
冻结 root budget 的旧 identity 必须保留；新 Attempt 的 Host binding 要从原持久权威验证恢复，不能重新冻结预算。

### S5：新进程父先子后恢复

root 先获得真实新 Attempt/fence、prepared input/SDK ACK 与 live parent authority。
private registry 只自动 resume 有已验证 Host suspension 来源的 interrupted child；
用户显式 interrupt 不自动恢复，也不按 call-id 前缀猜来源。
嵌套树父到子恢复，同 Run、新单调 Attempt，原 reservation/deadline 不变。

#### Root activation 与物理 SDK start 是两次不同的原子事实

- additive184 只消费 exact183 stopped receipt，创建同 Run 新单调 Attempt、replay continuation
  和 claim；普通无 delegation budget 的 Run 不新建动态账本。重放只返审计记录，不重新授 dispatch。
- additive185 只接收原 composition constructor 捕获的私有 nominal observation。模型/路由提供
  `authenticated=true`、复制的 receipt 或普通 Store 的 `startRunnerContinuation` 都不能制造 ACK。
- observation 绑定184 identity、target fence、continuation、task、prepared input fingerprint、实际
  `pi-session-ready` callback 和观察时间。Core 在同事务重验 current target、claim revision/token/
  owner/expiry、未 abort、Provider/D1、policy、budget/deadline 和原 witness，再原子推进
  Attempt/continuation/WorkUnit（以及存在的 Task）；持久 ACK 是独立 immutable artifact，保留 pins。
- 普通 Run 的 target-start authority 单独读取，不能借 old lost source 的 recovery reader，也不能
  依赖不存在的 dynamic budget。Host temporary receiver 仅包围同步 Core 事务并在 finally 撤销。
- 不论是否有 budget，activation 与实际 ACK 都必须验证冻结 SDK 工具面仍被当前 teammate/
  channel 授权；只把撤销后的工具从 authority projection 滤掉、不核对旧 SDK 工具面是不安全的。
  收到撤权必须在185与下一 wire 前拒绝，不用空账本补偿这个权限检查。
- Task 比较使用 frozen runner execution 的规范任务输入，不与含状态/时间戳的数据库 Task 全行
  混比。重复提交184记录只能只读拒绝，不能进入通用准备失败 cleanup 改坏原 WorkUnit/claim。
- Runner 必须先验证 session assembly，再安装/验证 ordinary/compaction SDK view，之后才发 ACK；
  ACK callback 失败、视图不合法或 callback 改坏 assembly/view 均不得发下一 wire。不能先记录
  started 再发现恢复输入无法安装。事件在真实 ACK 前缓冲，不提前发布 run_start 为事实。
- 184 已提交但 dispatch/ACK 前崩溃或失败保留 blocked，不把 claimed target 改为 schedulable queued，
  也不自动重派。只有父185真实 ACK 后才允许 child activation；child 真实 start ACK 后才恢复孙辈。
- immutable successor 的历史读取资格与 live admission 分离：B 已停止或正常终结后仍需验证
  A→B 的原历史工具/journal；不因 B 不再 live 而退回 whole-run 误报 foreign source。旧 callback
  的新写准入仍受 active pointer/current fence/live 状态限制。

继续使用 `assessDelegatedRunRecovery` → sealed ordinary/compaction view → SDK install → `continuePiSession`。
首个实际 model context 和 ACK 再验 witness；缺失/变化/撤权继续 blocked，不能 `.prompt(originalTask)` 回退。

#### 子树接线（已实现，真实SDK同PID重开4/4）

- private `activateDelegatedRunSuspension` 输入 exact suspension/source receipt、当前 direct-parent
  fence、step revision、新 runtime 与时间。fresh 结果仅一次含 claimed child；相同重放只返审计
  record，不含 child/entry，dispatch 前崩溃不自动重派。
- source child 已 cancelled/排空，新进程无旧 live facts；constructor 独立
  `readDelegatedSuspensionRecoveryAuthority` 只在同步 activation 事务期间可用，重建子任务自己的
  Provider/D1/current policy、冻结工具面和父权限，finally 清除。它不是普通 live reader 的例外。
- additive186 保存 child source→target activation；实际 child `commitDelegatedChildStart` 继续
  消费原 SDK nominal observation，在原事务写独立 immutable start receipt。孙任务必须核验
  direct-parent 的此 start receipt，不能仅看到 root185 或 caller 设置的 started flags 就恢复。
- discovery 继续有界分页；仅 `interrupted` 且拥有 sealed182/stopped183 的来源可走该私有入口。
  手动 interrupted、created/unknown、resuming、过期或未结算来源保持 retained，不调用普通 resume。
- 原 Root 与 child SDK ACK 成功后各触发一次有界 discovery；触发失败不回滚 ACK 或伪造 terminal，
  后续周期扫描仍逐项复核当前 parent owner。排序不是权限，不能一次 root ACK 放开所有深度。
- activation的owned写事务内，使用原constructor私有scope的只读查询；不嵌套snapshot事务，
  不调用自行开启写事务的recovery classifier。失败原子回滚Attempt/control/artifact/pins。
- 已验证child实际ACK失败保留claimed/created、不重派、不启动孙级；原budget/reservation/
  deadline保持，required结果到齐才成功。Root fresh日志：
  `/private/tmp/e6-s7-real-tree-owned-read-fresh-green-20261023.tap`；Core九文件371/371：
  `/private/tmp/e6-s7-core186-fresh-joint-20261023.tap`。这些不替代不同PID或GUI验收。
- 并发恢复不能要求整树所有Provider请求都先结算：父级真实ACK后可能已有在途请求。
  仅允许其他Run的reserved charge在exact active Attempt仍started、Run/WU仍running且
  无ended/abort时共存，预留继续按全额计入所有祖先预算。unresolved、旧Attempt、非live owner
  和当前待恢复子任务自己的未结算charge仍拒绝；不取消预留、不退款、不把reserved伪造为measured。
  已以真实父HTTP响应保持未完成的SDK用例复现RED并修复，三层组合5/5；Core四项预算正反例
  与相关迁移/activation组合200/200。原lineage诊断先于新增suspension latch，拒绝仍在写入前发生。
- 186两个immutable表增加BEFORE INSERT的全唯一身份冲突检查，防止recursive_triggers=0时
  REPLACE绕过DELETE保护；不改迁移marker的严格验证契约，已记录schema缺失时拒绝重建。
  生产writer仍仅plain INSERT，未确认外部可利用入口；此项是未发布186的防御契约补齐。

### 186之后的显式中断与普通续跑

真实SDK复现确认：A经183停止并恢复为B，B完成新的工具并保存checkpoint，再由当前父级显式
中断并真实排空后，普通resume被旧182 latch误拒绝。旧latch只能识别live186 target；B已cancelled，
而后续C也没有新的186 row。这不是允许自动重派未知任务的理由。

- 普通resume只在exact current child处核验`interrupted/cancelled`、原Host排空、效果和问答静默，
  再通过原186实际ACK和历史lineage识别已消费的旧latch；所有祖先仍必须是exact live owner。
- 原`delegation.resume.v1` control在创建successor的同一事务内、dispatch校验之前保存。control、
  Attempt、claim及pin共同回滚；没有新增模型/HTTP bypass字段，也不靠callId前缀判定恢复来源。
- 历史只读lineage有界遍历186 activation与普通resume edges，逐边核验不可变control、digest/pin、
  parent/source/target fence、相邻Attempt编号、原SDK ACK、interrupt control/stopped audit、Host排空、
  独立effects/questions、资源释放和已结算usage。缺证据保持拒绝。
- 新target的control不是actual SDK ACK。实际工具/模型准入仍要求该Attempt原Host的
  `delegation_runner_start`事件；Runner自己的同名`work_unit_started`叙述不属于该ACK。
- 手动interrupt不创建新的graceful stop authority，周期discovery不自动恢复它；必须显式resume。
  C安装B自己的最新checkpoint，D安装C的新checkpoint，不能退回A的旧view。
- 已有真实SDK/临时SQLite用例验证连续两次显式interrupt/resume、每个读取只执行一次、原budget/
  deadline不变、required孙任务结果保留；尚不代表不同PID的手动resume或packaged GUI验收。

新差量及最终联合验证见`output/e6-20260928/s7-manual-resume-lineage-evidence-20261023.md`。

### 未派发后代与默认 Daemon 自动启动

- 无Attempt不等于已物理停止。183新增`never_dispatched`证明，begin固定queued Run/WU
  完整fingerprint、原step/reservation。提交stop和激活前重验：spawning/queued/reserved，零历史
  Attempt、零计数、无active pointer、无Host/工具/native/continuation/资源/问答/事件/usage。
- 任一原facts变化或执行迹象均拒绝；没有伪造drain、SDK ACK或terminal结果。停止父级不改
  queued child、不退款、不延长deadline；required fan-in仍pending。父恢复并实际ACK后才通过
  原queued claim首次派发，子任务仍需自己的真实ACK、工具和结果才算完成。
- source Host实际退出之后，不同PID的默认Daemon仅通过正常`start()`自动发现root、父先子后
  恢复三层SDK；测试不注入Store factory/私有registry或直接调用continuation入口。journaled
  write/read/spawn均不重放，预算及marker mtime保持；再次正常启动不新增任何调用。
- 当前证据覆盖普通已封存树；不能据此开放compaction/final-assistant或宣称GUI通过。
  日志、源码hash和审阅边界见`output/e6-20260928/s7-queued-and-automatic-daemon-evidence-20261023.md`。

### S8：压缩视图的独立封存 authority（分层验证通过，非完整 E6 验收）

`ordinary` 和 `compaction` 不能只靠更改 allowlist 混用。压缩后最新 SDK view 已不再以前
ordinary head 为完整前缀；普通 writer 的拒绝是正确边界。新封存 witness 使用独立的
`kind:"compaction"`，仍引用已有 compaction checkpoint、summary 和原始 snapshot，不造 ordinary row。

- `checkpointId/revision/sourceEventSeq` 绑定真实 compaction head；`boundaryEventSeq` 单独绑定
  当前完整 canonical 水位。合法 turn_start/end 可以晚于 checkpoint，但不能夹带内容或工具。
- summaryArtifact/digest、contextSnapshotArtifact/digest、原 sdk_installed seq/digest、完整
  sourceFence 与 lineage 一起保存。后续 progress 可能属 B，原安装仍属 A，必须沿 predecessor
  验证到真实原 compaction_start，而非强行把 installed 归到当前 Attempt。
- Host 先沿用已有 producer 提交真正的新 tool round；没有新 tool_end 时只重验已有 exact view，
  不放宽旧 progress writer，不让 summary 或空 DTO 代替工具事实。传入 SDK view 与 durable
  summary.modelView 不一致、存在未配对工具、unknown effects、待批或必答问题都继续 blocked。
- Core structured reader 是只读观察，不授权 stop、dispatch 或历史 source 的 live owner。
  182 seal、183 stop、184/185 root activation/ACK、186 child activation/ACK 各自持有原 authority，
  在所属事务重新读取该 witness 的依赖和状态。所有 predecessor 内容接 recovery/audit pins。
- 最终 assistant 即使文本看起来完整，也不走本轮 compaction suspension。Host/Runner 的
  `complete` 必要条件已补正常 stopReason/SDK content；仍必须另有原 provider settlement、
  exact terminal view、effects、后代与usage结算，才能安全恢复为零新模型请求的 complete。

最终fresh Core8文件334/334、Daemon suspension125/125、compaction邻接63/63、Runner全套558/558，
全部actual exit0，0 skipped。真实SDK覆盖重复暂停、完整依赖损坏和三层压缩恢复；新增collector截链与
锁屏await遗漏均先有效RED再修。独立只读复审零新增可行动发现，16文件manifest全部匹配。
新实际RED、完整日志/hash及未完成gate记录于
`output/e6-20260928/s8-compaction-suspension-evidence-20261023.md`。
final-assistant settlement、Office批准/H09/macOS验收仍未完成；此节不构成完整E6验收通过。

## 文件责任

- Runner：`types.ts`、`task-boundary.ts`、`adapter.ts`，仅独立 suspension 控制、稳定 view 和 idle 证明。
- Host producer：`run-ordinary-progress.ts`，安全边界封存和 head CAS。
- Core：source-bound suspension authority、checkpoint API、必要 additive migration；不放宽普通 live owner。
- Daemon：`active-runs.ts`、`orchestrator.ts`、registry/composition、startup recovery、`index.ts`。
- 所有新 suspension/preparation/view/control/effect receipts 接现有原事务 recovery/audit pins，
  未恢复或结算前不因普通 retention sweep 消失。
- terminal-intent Agent 当前独占 orchestrator/registry/supervisor/Store 总接线，必须停写并交接后再改。

## 验收矩阵

1. 进程 A 真正运行 root → child → grandchild，完成 read 和已 journaled write；在下一 provider
   boundary 请求 graceful shutdown。A 正常退出后，不同 PID 的 B 打开同一隔离库自动恢复。
2. 断言同 Run、新 Attempt/fence、首个 wire context 有最新 toolResult、marker/工具计数仍为 1、
   reservation/deadline 不变，最终才 fan-in/settle。
3. 分别在 boundary 前、封存后、interrupt 后、drain 前停止；重复 startup 不重复 dispatch。
4. 覆盖 in-flight wait、晚到工具、未知 effect/usage、tail watermark 变化、缺 snapshot、
   policy/provenance/selection 变化、显式用户 interrupt、缺 native handle、retention sweep。
5. Source-overlay/临时 SQLite/离线 SDK 是分层证据，不冒充 fresh packaged macOS、真实模型或完整 E6。

### 新增跨PID证据（包含源进程真实退出）

`run-graceful-suspension-tree.test.mjs`先启动专用源Host worker，确认其sealed/stopped并正常
退出（code=0/signal=null），才启动新PID恢复worker。新Store/composition/Supervisor/Registry
通过原`executeExistingRunContinuation`恢复三层树；驱动进程从未持有原Host私有对象。
实际SDK ACK按层发生，原toolResult进入新wire，原read/spawn与
有Host evidence的文件write不重放；文件mtime、原root budget及reservation/deadline保持。
明确区分这项证据与完整Daemon自动启动、真实Provider和packaged GUI验收；本例从测试驱动
显式进入原Host recovery入口。最终六项日志
`/private/tmp/e6-s7-source-exit-six-cases-final-20261023.tap`（6/6 exit0）；共享SSE A21邻接
`/private/tmp/e6-s7-shared-transport-a21-neighbors-20261023.tap`（4/4 exit0）。

本记录固定已查到的链路，后续直接实现/验证，不再从头检索同一 SDK/Codex 资料。

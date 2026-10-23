# E6 全量回归后继修正 — 2026-10-23

状态：最终Core全套4431/4431 actualexit0，零fail/cancel/skip；旧Daemon全套7401项、
7319pass/70fail/12skip，actualexit1。后继A28最终14/14和四文件邻接93/93均actualexit0；
最终Daemon全套session35284运行中，未收actualexit，不以旧结果冒称通过。
不是 Office 批准、客户端验收或完整 E6 通过。
唯一树：`/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`。
基线 HEAD：`c71bae7526955d6458909ea6d919de7ac6ec317a` 加保留的全部 WIP。

## Core 六项旧夹具

原完整日志 `/private/tmp/e6-current-core-full-20261023.tap`：4395/4401，actual exit1，0skipped。

- 153迁移夹具漏剥离187空sidecar。先验证没有业务行，再在临时库剥离并验证升级恢复；
  不删除真实库或放宽已安装schema损坏的拒绝。
- root成功而optional仍活着的旧预期与用户的stop_with_parent冲突；现在先验证真实成功
  被拒，历史terminal损坏行仅作为显式fixture，用于late spawn拒绝与response-loss重放。
- required/optional barrier保留业务失败差异，但二者都必须有实际停止结果；补真实claim/
  start/drain/settlement/sealed-result正例。终止状态的fixture UPDATE不冒充生产终止执行。
- 旧continuation134重建drop135破坏180索引却留下180marker。临时库精确剥离180五索引和
  marker，再验证公开startup overlay重建，不把损坏修复冒充完整schema134 migration。

定向 `/private/tmp/e6-full-core-legacy-fixtures-fixed-20261023.tap`：85/85，actualexit0。
定向 `/private/tmp/e6-full-continuation-migration-fixture-fixed-20261023.tap`：5/5，actualexit0。
生产Core未因这批夹具修正改变。最终全套session34041已收actualexit0，日志
`/private/tmp/e6-current-core-full-final-20261023.tap`：4401/4401，0fail/cancel/skip。

## 原审批取消后立即关机

实际失败：`run cancel cancels pending approvals for a waiting run`。后续同文件workspace lease
失败为它保留runtime归属引起的连带错误，不算九个独立产品根因。

隔离RED与递归错误链：

- `/private/tmp/e6-full-cancel-approval-isolated-red-20261023.tap`
- `/private/tmp/e6-full-cancel-approval-host-error-chain-20261023.tap`
- 精确错误：`runtime_terminal_handoff_source_unverified`。

根因：ActiveRuns把所有已经aborted来源先强制成delegated terminal handoff，误伤Host显式
`stop_without_resume`的普通取消执行器。最小改动保留原stop reason，等待原executor lifetime，
不调用checkpoint；提供了handoff时仍先严格验证（包括null/forged），checkpoint/未知策略
缺证明仍拒绝。abort不等于drained或resumable。

新增两项原shutdown测试有效RED1/2，日志
`/private/tmp/e6-full-nonresumable-cancel-valid-red-20261023.tap`。
fresh Daemon tsc actualexit0，日志 `/private/tmp/e6-full-shutdown-delta-daemon-tsc-20261023.log`。
独立静态差量复核零确认可行动发现，不是独立执行或Office批准。

当前源码hash：

```text
0077880040e547d4fa8a7610d70fefbf92503f8a735d71dbd399f8804cb6ba72 packages/daemon/src/runtime/active-runs.ts
14f61a1db4f846f93ea0151c14c8686a6a5f6ee9e562e0cdeb267f6de7fd50db packages/daemon/test/run-shutdown-coordinator.test.mjs
```

## SDK final边界后的旧测试控制点

六文件组合 `/private/tmp/e6-full-shutdown-fixed-joint-20261023.tap`：213项，205pass，
8cancelled（未改的15000ms超时），0fail/0skip，actualexit1。原审批完整文件与前121项通过；
后面的真实三层树与shutdown邻接也通过。八项超时不能算GREEN。

探针保留：

- `/private/tmp/e6-full-production-optional-timeout-probe-20261023.tap`
- `/private/tmp/e6-full-production-optional-evidence-probe-20261023.tap`
- `/private/tmp/e6-full-production-optional-at-boundary-probe-20261023.tap`

首次父SDK final callback时，child是spawning/queued、WU claimed、Attempt created，
尚无ActiveRuns/completion，原Host正确返回blocked。之后child才实际ACK/运行。
旧测试在super.runTask返回后的afterModel才等childModel/注入父失败，与现在位于SDK
settled callback内的Host收尾顺序冲突，所以从未收到所等待的child abort。

修正仅改测试fixture：在真实SDK settled callback之前持有同一窗口/注入错误，然后调用
原Host callback。真实usage、原executor/abort/drain、late spawn拒绝、原始预算、原子result、
single terminal notification/control-plane event断言全部保留；无skip、超时扩大、直接状态/
evidence写入或生产guard变化。临时探针已移除。

完整文件 `/private/tmp/e6-full-production-optional-sdk-boundary-fixed-20261023.tap`：
13/13，actualexit0，0cancelled/0skipped。

```text
f39e0698543583d66112ecb508a7c824d1d113c8ad61b6f8223fa5287a017007 packages/daemon/test/delegation-production-tool-surface.test.mjs
```

## ACP/Kimi真实写入观察边界

原Daemon全套两项失败分别位于旧源码168行write reply及441行post-claim symlink write。
不能按新增诊断后的行号把前者误读为read。原全套未记录worker当时的具体OS调度，不作
该历史细节的确认结论。独立原文件65/65 exit0仅作诊断对照。

受控探针只暂停本测试实际创建的sandbox worker，2000ms后恢复；生产writeWorker5000ms
deadline和prompt10000ms均不变。旧300x5ms轮询实际1869ms先失败，有效RED1/1、exit1：
`/private/tmp/e6-kimi-worker-polling-forced-red-20261023.tap`。
同一真实worker延迟以事件观察通过1/1、exit0：
`/private/tmp/e6-kimi-worker-event-forced-green-20261023.tap`。

初版等待stdin字节过早，完整文件67/68 exit1：
`/private/tmp/e6-kimi-event-observation-file-final-20261023.tap`。原written双effect断言发现
第二项reply仍unknown，证明不能将写入bytes冒充Host确认。现在fixture包裹并先调用真实
KimiHostFiles.onReplyOutcome，再唤醒awaiter；所有原write结果/effect断言保留。
新增cancelled及terminal-without-reply拒绝，不留Promise.race的后台轮询读已关闭Store。
完整最终68/68、actualexit0、0skipped：
`/private/tmp/e6-kimi-host-committed-observation-file-final-20261023.tap`，session9698已收exit。
没有生产修改、扩大执行期限、retry或skip。旧轮询误判边界已被有效探针确认；精确全套
worker调度未记录，不以单例通过抹去该全套RED。

## A01 launcher隔离

原全套11项在启动真实child前被assertA01Isolation拒绝：父process并未设置专用环境。
runA01Child只导入builtin且立即创建独立临时home/workspace，真正执行产品的是持有新env的
child。因此校验改为显式传入这份child环境，不再检查未消费的父环境；child端原guard
和45秒进程截止均保留。验证session33404，日志
`/private/tmp/e6-a01-owned-child-environment-final-20261023.tap`，11/11、actualexit0、0skip。

Kimi延迟hook依独审建议补必达断言：必须命中本测试实际worker、完整pause/resume序列，
且暂停至少1950ms。最新三项回归session30377 actualexit0，3/3、0skip：
`/private/tmp/e6-kimi-forced-observation-asserted-final-20261023.tap`。

## 默认Broker与问答能力接线

四项真实频道write均已在全新临时home/workspace复现；首个tool_end是
`host_file_broker_evidence_required`，Run冻结toolBroker=off、HarnessToolExecution=0。
安全receipt guard本身正确；错误是Host内部enableUserInputPause无条件启用U tracker。
只读诊断：`/private/tmp/e6-channel-file-budget-readonly-diagnosis-20261023.md`。

新增矩阵覆盖off/shadow/enforce与opt-in开关、真实SDK wire/frozen schema及off/shadow实际
写入/无tracker/停止效果仍unverified。修复前10项6pass/4fail，session94159 actualexit1：
`/private/tmp/e6-user-input-broker-gate-red-20261023.tap`。

最小源码修补：准备、重准备和执行共享U能力判定（可信opt-in、canonical source、非delegated、
冻结Broker enforce）；media tracker也仅enforce。不升级显式off/shadow、不去掉receipt
guard、不改已封存input/fingerprint；封存true遇关闭gate仍由原恢复校验明确拒绝。
旧full结束后fresh Core/Daemon编译均exit0。原四个频道write场景与原1800/4096预算
两例完整6/6、actualexit0、0skip：`/private/tmp/e6-channel-four-and-budget-fresh-20261023.tap`。
不提高预算、不改安全tools，不需要额外摘要重构。U完整文件最初47/49；两处独立手写
合法pause fixture仍默认off，现明确配置enforce并断言冻结snapshot，原off/shadow矩阵保留。
与prepared surface及native完整文件联合112/112、actualexit0、0skip：
`/private/tmp/e6-user-input-native-complete-fresh-20261023.tap`。

## 健康契约及A32新RED

health三项失败仅因expected缺少已公开的delegationSelectedWorkflowIds空数组。补字段，
保留完整deepEqual与privateDiagnostic不泄漏断言，生产不改。health+冻结工具撤销原合同
10/10、actualexit0（session4635）：`/private/tmp/e6-health-and-frozen-tool-contract-20261023.tap`。

A32原同栈snapshot.shutdown断言已经通过；实际失败在下一条同栈abort断言。统一lifecycle
先同步关闭所有domain准入，再await进入abort，测试应观察真实abort事件，而非改变这个顺序。
修正观察后真实RED1pass/1fail、actualexit1：
`/private/tmp/e6-media-shutdown-observer-valid-red-20261023.tap`。非协作真实HTTP/body仍活着，
public stop到6500ms仍unsettled；原5秒media观察在后续settle阶段，abort等待drain先挡住它。

最小生产修补：public stop并列观察原single-flight lifecycle与media的5秒期限；内部settle
等待真实media排空，不把观察超时记成永久内部失败，不提前释放Store/lease。真实EOF后
retry加入原工作，不重复执行；其他domain真实错误仍保留。5秒不是整个Daemon的总期限。
ActiveRuns新增纯同步stopAdmission latch，关闭queued ordinary/native preflight准入，
不触发source callback/abort；已进入的原lifetime仍可登记并被真实graceful阶段收齐。

测试保留原5秒/真实SQLite busy/EOF/retry/单次send/close/release门槛，在真实abort listener
冻结media.shutdown、原ActiveRuns关闭及active/body/native/Store/lease事实，另覆盖两类
真实executeRunRequest微任务不得进入dispatch。media-local-production同样观察真实abort事件。
fresh noEmit exit0：`/private/tmp/e6-broker-media-admission-daemon-noemit-20261023.log`；
fresh Daemon已emit exit0。A32和media-local两文件原四项均通过；六文件联合115/116，
actualexit1，唯一失败是新增native测试以不完整owner key查Thread。曾改为undefined导致假阴性，
独审已发现；最终改为listLingThreads精确读取真实failed preparation Thread，并验证zeroTurn、
全隔离Store零WU/Run。该边界以最终native完整文件重验为准，不用112项旧GREEN证明。
独立静态复核未确认新增生产问题，指出的A32事件准入快照缺口已补，不把静态结论冒充执行。

## A11 API/deadline隔离

两个launcher误查未消费的父scope；实际child才导入产品。保留child原guard和全部断言/
期限，launcher校验实际传入的独立tmp目录与最小env，不继承credentials或Node test context。
显式unset父scope时旧20项全RED；修后完整20/20、actualexit0、0cancel/skip（session28966）：
`/private/tmp/e6-a11-owned-child-environment-final-20261023.tap`。真实DNS/headers/body各30.007s。
主代理已核两文件diff。IPv6四项同类parent guard原4/4RED；修后4/4 actualexit0、0skip：
`/private/tmp/e6-a11-ipv6-owned-child-environment-final-20261023.tap`，HTTP/TLS真实launch/complete
各1次，private拒绝两例0connect。真实TLS授权/SNI等断言保留，主代理已核完整diff。

## 本轮新增native/evaluation/A28接缝

native缺失owner先进入preflight/Thread，source-lineage异常遮住原typed拒绝。已将captured
owner门前置，缺失owner早于availability/Thread拒绝；await availability/idempotency后重验
原请求owner，早于Turn/WorkUnit/Attempt/Run。预检已用的Thread可保留为failed，不删除历史。
原commit准入门保留；缺owner和await内撤owner两例有效RED，修后完整native63项通过，
最终完整文件63/63 actualexit0、零skip：
`/private/tmp/e6-native-owner-complete-final-key-20261023.tap`。新增测试曾有错误owner查询，
已按真实preparation Thread和全Store零Turn/WU/Run复核，不能由旧112项GREEN推定。

evaluation坏body原claim事务正确回滚，但scheduler在grading try外抛，坏queued head可能
反复挡后续valid。窄typed永久body错误现在在exact revision+live owner/token/expiry事务中
failed/result_invalid，清claim并释放仅本owner recovery pins；其他SQLite/COMMIT/holder错误
原样抛。含claim/start/replay/requeue及真实队首调度回归。fresh Core相关41/41、Daemon
evaluation13/13通过；独审又发现body坏+本owner audit_hold冲突组合会误释放，12子例已有效
RED。修补在terminal release前验证完整canonical集合的本holder reason均为recovery，
冲突仍原事务rollback。最终Core三文件55/55和Core全套4431/4431均actualexit0，零skip；
独审已收口零剩余确认问题。上一候选Daemon十文件新Core邻接224/224 actualexit0，
最终R3新字节另经下述93项回归；完整Daemon仍未收口。

A28私聊审批恢复原六例均卡第一次daemon.stop。有效探针确认Run/WU waiting_for_approval，
普通SDK suspension controller只接受running，报suspension.source_stale后原approval wait
仍不退出。修复范围限定普通exact approval checkpoint分流、真实local writer drain及重新
校验；delegated/动态后代不得误作普通resume。另补request先于approval commit的交错，
未知仍blocked保留authority。fresh Daemon emit exit0；首次十一例6pass/5fail、actualexit1，
零cancel/skip：`/private/tmp/e6-a28-private-recovery-final-20261023.tap`。原六例已全部通过；
request先于approval交错仍65秒未退出，三例fixture重复close server遮挡原始结果，
真实local-writer例也未通过。历史失败保留；下述修补不增加原65秒child期限。

最终native/evaluation/media/U六文件组合session50577已actualexit1：128项126pass/2fail，
零cancel/skip：`/private/tmp/e6-daemon-evidence-final-integrated-20261023.tap`。两项真实reviewer
晚排空后资源2/预期0已由独审确认：新approval wait局部1000ms观察超时后保留authority，
但原onLocalDrained不再重验/提交approval suspension，Core veto因此正确保留资源。
已在同一原source真实drain后exact re-read+CAS，不弱化veto/原资源断言。
A28第七例的裸Store绕过正式factory/composition，request在落库前被custody拒绝；fixture
改为仅旁观真实Registry.getStore，保留default factory。上一候选13/13、十文件224/224
均actualexit0，但未覆盖后继通知异常修补。

R3真实Hub active listener因果RED确认CAS已提交1次、checkpoint revision2后，publish消费者
抛错被误作durable收尾失败。最小修补只在成功CAS后逐事件隔离通知异常，固定诊断无payload；
不吞Core CAS异常、不修改全局Hub。observer fulfillment注释同步纠正为非durable receipt。
最终orchestrator SHA`cf8e7fbe180ed15d1308bb42a8b487ce865726cb8d049947e3a8630cf970be5f`，
test SHA`d1bde4492623ce35059c5f5fd6c2953d8010aa6146b228fbcb0393b68f3f2f33`。
统一fresh emit actualexit0；A11 session66087完整14/14、actualexit0、0fail/cancel/skip：
`/private/tmp/e6-a28-private-recovery-notification-final-20261023.tap`。新增第14例验证真实监听器
3次抛错后原CAS仍仅1次、revision仅+1、audit1次、零slots/leases、Host stop成功。
Root session18208最终四文件93/93、actualexit0、0fail/cancel/skip：
`/private/tmp/e6-daemon-a28-notification-neighbors-final-20261023.tap`，原reviewer晚排空两例通过。
A08原独审报告已将R1/R2/R3全部closed，保留范围限制，不代替Office或E6批准。
Office六项最终源码增量已独审，166项delta hashes均匹配最新inventory：
`/private/tmp/e6-office-final-notification-inventory-20261023.json`，SHA
`a637c116afa70a07dbcd82b0ea95ede4eb5fe644f244d819d4fccc72a7926de6`；仍非clean packet或批准。

## 最终全套与未完成项

- 原Daemon full因已知取消缺陷被受控终止，actualexit1，未跑完，绝不冒充通过。
- 旧Daemon full session72373已actualexit1：7401项，7319pass/70fail/0cancelled/12skip；
  日志`/private/tmp/e6-current-daemon-full-final-20261023.tap`。旧dist诊断，不是修后验收。
- 原media fetch failed的单例及完整approval文件已通过，但原全套失败原因未确认；保留记录，
  等新全套核验，不用单例GREEN抹去失败。
- Runner full567/567 actualexit0；最新Office source-closure1343/1343 actualexit0，0skipped。
- Office165项WIP inventory独审已完成，无新增确认问题：90本轮全文、20精确旧全文、
  55catalog精确旧字节/全部当前差量。报告SHA`86b0dc2b2b779497e8613d49ab6b12fba4d19ba1dac9403dd2a49992587e0a05`；
  仍不是clean-HEAD packet/approved，生成catalog继承旧语义覆盖限制。
- 频道四项file_create与两预算案例6/6、U/prepared/native完整112/112 exit0；health旧expected
  已验证。A32/media-local原案例已通过，六文件组因native新fixture期望未通过（115/116）。
- evaluation组合冲突及A28修复已定向GREEN/独审收口；最终Core4431/4431无需重跑。
- 最终Daemon全套session35284运行中：`/private/tmp/e6-daemon-complete-notification-final-20261023.tap`。
  新临时HOME/workspace、test:ci同并发1；受测dist冻结，不在消费者运行时emit。
- 旧Office165项后继六项新字节已独审，最终166项inventory绑定cf8e；仍需clean checkpoint、
  新pending packet及用户本人批准，不能自动生成approved。
- H09预算真实模型、本人认证、新macOS包与20项真实GUI仍未完成。付费generation0。
- 无stage/commit/push/PR/merge、真实库操作或正式发布。总Goal active。

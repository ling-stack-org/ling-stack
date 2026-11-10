# Media scene cancellation lifecycle

状态：实施设计；仅 A19 范围。首次真实回归由 Root 执行：六例中两个独立正常正例通过，四个取消例失败。Provider / Comfy 两条真实 HTTP 链均在 cancel 返回 200 后，由迟到的 poll owner 把 cancelled 覆盖成 succeeded / failed。不是 UI 状态或 fixture 故障。

## 权威边界

一次成功的 scene cancel 只承诺：本地 job 终态为 cancelled，拒绝此 generation 的后继 submit/poll/collect，取消精确 child Attempt 并释放其 semaphore。已经发送的远端工作可能继续；不以本地停止、HTTP 客户端退出、child 终态或 semaphore 释放证明远端已停止。不杀远端任务，不重试不确定的提交或远端取消。

取消与成功/失败竞争同一 SQLite active-status CAS。先提交终态的一方获胜；晚到 cancel 返回 409，晚到成功/失败不得覆盖 cancelled。重复 cancel 返回现有 409，不派发任何远端请求。通用 Store 的既有显式 failed retry 保留，但 cancelled 原 job 不允许 retryTerminal 复活，重试必须创建新 scene run/job/fence。

child 分两阶段收口：有真实 entered owner 时，取消先关闭本地 business/新网络准入，child 保留 active 以允许其原 native EOF/ACK 进入 Core exact-fence receipt writer；原 await 返回并捕获事实后，只有原 opaque generation owner 可以取消 child/释放精确 semaphore。无 entered owner 的定时等待可立即收口。不以等待中的 child 为远端运行或远端停止证明。取消响应不是完整物理 quiescence 回执。

## 模块与数据流

- Core `UpdateMediaJobStatusInput.expectedStatuses`：可选的原子 SQL 条件；不新增表、方法或 schema 迁移。未指定时保持原调用语义；指定时 CAS 失败返回 undefined，调用者必须读回当前事实，不能用旧 job 回退假装成功。
- `scene-cancellation.ts`：共享 active-only status CAS、取消 readback、child/Attempt/handle 收尾以及迟到真实 submission 的只读结果持久化。公开 route 与两种 owner 使用同一规则，不复制第三套取消状态机。
- `MediaLocalExecutionRegistry`：同一 opaque generation 的 cancellation latch；立即清定时器、拒绝所有新 network effect 与 schedule，但已经进入的 callback/原生 response EOF、receipt capture 和 cleanup 继续归原 owner，shutdown 仍等待 drain。取消不调用 stopSource，不让取消被误报为 source-obsolete。
- Provider / workflow owner：在 await 后做 business admission；取消异常优先转到 cancelled readback/精确 child 收尾，不进入 failed catch。native transport 的 completion gate 仍保存真实响应事实，不能被 business cancel gate 阻断。

公开 scene run → dispatch → 真实 submit → durable handle → 真实 poll → 真实 collect → 本地产物写入 → terminal CAS。每个 async 边界之后与实际 network launch 之前检查准入；同步产物写入和 terminal CAS 之间没有 await。失败分支同样 active-only CAS。

## 不确定结果与恢复

cancel 时持久化 handle 的 `nextPollAt=null`，没有可用远端 ID 的 entered submission 标记 `submissionOutcome=unknown`；EOF 仍未返回时保留原 `waiting_for_submission` phase，使原 Core ACK/handle 原子投影仍可通过其未放宽的校验。owner 返回后仍无 ACK 才将 phase 转为 `submission_outcome_unknown`。真实迟到 ACK 可更新到它实际返回的 externalOperationId 与 recovery，但不安排 poll、不选 scene 结果、不创造新的 Attempt。迟到失败不能伪造远端 stopped/failed 的安全证明。保留已存在 artifact / receipt，不删除已发送请求或未知结果证据。显式 retry 不允许借 unknown sentinel 自动重发；新场景运行可创建新 job，旧 generation 不能写它。

取消不主动发远端 cancel。Seedance 无已核实的取消映射；Comfy legacy 无可靠确认。已有其他显式恢复入口的远端 cancel 行为不作为本地承诺前提，也不得因 unknown/error 自动重发。

## 验证门槛

保留首次六例断言和正常对照，扩展 Provider/Comfy 的 submit/poll/collect 延迟成功与失败、已完成后取消、重复取消、取消后的完整真实 poll 周期无后继请求、真实 child/Attempt/semaphore 收尾，以及迟到 submit ACK 保留/未知提交不重发。并发 cancel/complete 必须只产生一个终态；不能通过移除断言、缩短产品 timer 或 fake fetch/Response 制造 GREEN。

测试唯一 hook 仅透明观察真实 runTick Promise settlement：原 descriptor 恢复、原 this/args、原 Promise 返回值，hook 不参与产品准入。全部专用 mkdtemp SQLite 与自有 loopback upstream，无外网/真实模型、无真实 workspace、无 GUI/正式发布结论。Root 独占实际 build/dist/执行；作者仅 source/test/design。主 CI 停用不作为门槛。

首轮完整测试共 22 例：原六例、八例 submit/collect 迟到成功/失败、两例 cancel/complete 竞态、两例旧 generation/新 scene run 隔离、四例 **internal trusted captured receipt controls**。前 18 例仍经过完整 daemon 的公开 scene 链；后四例使用真实 `appendConversationUserTurn` 产生 source item，再从可信内部 `executeRunRequest(..., { enableUserInputPause: true })` 进入原 `onMedia` Host producer，创建真实 child/private ticket/native sender/receipt。此内部开关没有在公开 conversation 路由开放，不能把后四例称为公开 conversation 验收。其最小 HTTP fixture 只挂载原 scene-cancel/replay handler，同一真实 Store/Registry/Supervisor 贯穿运行和取消；Store 仅配置专用目标、场景及现有 job 的 sceneRun 关联，不构造 transport/receipt/fence。后继取消收尾 Store 故障两例加入后，当前文件共 24 例；原 22 例断言保持不变。

这四例的 scripted runner 保持真实父 Run/Attempt active，直到原 Media owner 与 Host receipt tail 完成，再释放 runner 返回。它只控制测试源运行的寿命，不放宽 Core 的 active-parent/exact-fence 校验；不覆盖“父 Run 先自然结束后”的后台链行为。submit 对照必须读取 Core sealed submission receipt 和真实 externalOperationId；ACK-only 时整个 Host 操作必须仍为 unknown，不能因 child 已取消就变成 known-no-start/safe。

2026-10-15 Root 实际执行：上述四例在测试 SHA256 `964b9eebcfac615d69d3926391b57390ad9632a3084681e8fa110aab1a58f003` 下 **4/4 通过，exit 0，零 skip/cancel，5766.337041 ms**。原始日志：`output/e6-20260928/a19-20261015/a19-internal-captured-parent-active.log`，SHA256 `7a5e2e98d136477cec9cd5eb89605f24db166805e49dad4a0509d6490893e96c`。随后同一 SHA 的完整运行 **22/22 通过，exit 0，零 fail/cancel/skip/todo，88507 ms**；原始日志：`output/e6-20260928/a19-20261015/a19-full-parent-active.log`，SHA256 `ee5150ef2a99378397d2921018b05e46656c14ea23d9bb078af6cf2ffbaaa281`。窄四例是完整 22 例的子集，不累计为 26 例。此结果不等于真实模型、GUI、发布或所有故障恢复验收；先前原六例、首次 22 例及父运行寿命修正前的 raw 均保留，fixture 失败不改记为产品 RED。

## 取消收尾中断的故障门槛与修复合同

后继测试保留原 22 例与断言，并为 Provider / Comfy 各增加一例 Store 故障控制。真实 submit 已返回 ACK、原 Registry `getSnapshot()` 明确 `active=0` 且 `scheduled=true` 后，在此专用 Store 的取消 handle upsert 注入一次异常；终态 CAS 和本地 timer 关闭已发生，但 handle/child/semaphore 收尾可能未完成。原 `runTick` 透明 observer 仅额外读取真实 Registry snapshot，不修改产品 timer、网络 sender 或任何 receipt。故障只作用于当前 mkdtemp job 的一次同步 Store 写，finally 恢复原 descriptor。

2026-10-15 Root 在测试 SHA256 `1529d31f82c3851789a0c1503baf83e1407cdb81f4576a489d67d1bcc6060dbf` 上窄运行上述两例：**0 pass / 2 fail、exit 1，零 cancelled/skip/todo，7686.357292 ms**。两例均到达真实 ACK / timer-only 前提、精确 post-CAS Store 注入、原错误映射 400 和重复 cancel 409；最终完整 lineage 断言证实 job 已 cancelled，但 child 仍 running、Attempt 仍 started、slot 仍 active、durable `nextPollAt` 残留。不是 fixture 或超时。raw：`output/e6-20260928/a19-20261015/a19-timer-store-fault-first.log`，SHA256 `ad65e1048cc8e77690c939347604d8452250553ba33feb70ccd8112fba3bd03a`。

修复仅在公开 cancel route 接通既有幂等收尾：读到已 cancelled，或 active-status CAS 败方读回 cancelled 时，在返回现有 409 前复用 `settleLocallyCancelledMediaJob`，并完成该 cancelled job 尚待关闭的 media-cost approvals；当前仍有 entered owner 时，继续使用共享 helper 的两阶段规则，不能提前关闭 child/fence。已 succeeded/failed 的终态不触发取消写入。真实 Store 异常继续交给原错误映射，不能吞掉后假装已 reconciliation。首次正常取消的 200 契约不变。

重复 cancel 仍保持现有 409 的 HTTP 契约，但不能因为 job 已 cancelled 而跳过本地幂等 reconciliation；瞬时写故障消失后，应清除 durable `nextPollAt`、终结原 child/Attempt 并释放原 semaphore，不创建新 Attempt、不请求远端 cancel、不重发 submit/poll/collect。此次不把本地修复误称为远端停止或确定安全。产品仅重开 `production-routes.ts` 的两个遗漏分支，其余 8 个产品输入和原 24 测试冻结；后继 fresh build、完整 24 例和增量独审由 Root 收口，源码修复本身不算 GREEN。

无待确认设计决策。公开错误/恢复 UI 的额外展示不在 A19 范围；unknown 事实必须留存，不得由展示简化改变其语义。

# A16 / A17：External background scheduler 生命周期归属

状态：首批三个公开 Registry / 真实 SQLite / Core producer 用例已由 Root 实际复现，
0 pass / 3 fail、actual exit 1、零 cancel/skip/todo，均抵达产品行为断言。
同一实施链已按下列不变量完成修复；Root fresh Daemon tsc actual exit0，
完整生命周期 23/23、原 external-work-import 25/25、新源码 Desktop source-input 340/340，
各 actual exit0、零 fail/cancel/skip/todo。最终未实施者增量独审已收口，选定范围无剩余确认问题，
`approved=false`；不冒 GUI/Office 验收，尚未合并 main。
原始记录见 `output/e6-20260928/a16-a17-20261015/`。
接续已合并 #547 的 `666da85f`；不重开已完成的 Automation scheduler / A09。

## 问题与边界

当前 background-scheduler.ts 在 await poll/reconcile 之后直接写 running；stop 只能清已排的timer。
startup reconcile 在注册map/key之后抛错时缺失败清理；重复stop旧A还会无条件删除同key后继B的索引。
这些是当前源码候选，必须通过公开 Registry / HTTP producer 和真实 await 屏障验证，不以静态推导冒RED。

这组只维护内存scheduler的当前代、状态、去重索引和timer生命周期。
不新增表、服务、Provider/session或权限轴，不承诺强杀已经进入Core的poll/reconcile或已经发送的hook。
停止轮询不是已发生外部动作的撤销证明；已知结果不能因停止而伪装为未发生。

## 模块边界

- `features/external-work/background-scheduler.ts`：entry身份/所有权判定、stop幂等、await后阶段准入、timer与startup失败收口。
- `features/external-work/background.ts`：保留现有HTTP错误、list和stop接口；只有真实契约需要时才改。
- 新 `test/external-work-background-lifecycle.test.mjs`：独立隔离生命周期矩阵，不再向已有大型import测试堆逻辑。
- 原 `external-work-import.test.mjs`：正常background/错误路径作为完整邻近回归。

## 生命周期不变量

一个entry的唯一身份使用既有随机scheduler.id和entry对象，不另造无用全局代际服务。
当前身份须同时属于entriesById、idsByKey的当前指针且status=running。

1. stop/stopped为该entry的代际终态；重复stop不改原stoppedAt，不删除同key后继的指针。
2. stopAll同步终止当前已注册entries的后续准入、清timer和自己的key；不能让已在途旧tick继续排期。
3. poll/reconcile每个await后重新核当前代；已停止时不再启动下一个尚未进入的阶段。
4. 迟到结果可记入该旧entry的lastPoll/lastReconcile/错误与实际已准入tick事实，但不能改其终态、stoppedAt或后继entry。
5. timer callback和then/catch/finally只处理捕获的entry；排期前再次核owner。没有timer/假running不当作健康成功。
6. 当前timer的失败收口不允许把stopped改failed，旧finalizer不能清B的timer/key。

## startup失败

保留现有running/stopped/failed闭集，不新增starting enum来改变公开协议。
startup reconcile真实失败时：无timer，保留本entry为failed与可读错误，释放的只能是自己仍持有的key；HTTP保留失败响应。
重试可以创建新entry且duplicate=false，不返回一个running但永远没有timer的幽灵duplicate。
若await期间已被stop/stopAll或同key后继取代，迟到成功/失败只记录旧事实，不能重写终态或删除后继key。
正常startup、已有running duplicate、错误cwd stop保持原行为。

## 验证顺序与完成门槛

1. 原生产Core/Registry或HTTP创建合法workflow/channel/state；fetch为实例级受控替身，不请求真实GitHub。
2. 首批RED覆盖poll/reconcile await→stop/stopAll→释放成功/普通错误，以及A停止→B启动→再次stop(A)→C仍duplicate=B。
3. startup失败需已有正规external state使真实reconcile抵达fetch；空store checked=0不能冒网络失败复现。
4. 覆盖startup失败/list一致/重试正常、失败期间stop或stopAll+B启动、timer触发tick不重排、正常启动与duplicate。
5. 所有pending在finally释放并await settlement后清理，不能为RED留下悬挂后台timer或调用。
6. 实际RED后最小完整产品修复、freshbuild、完整矩阵与邻近GREEN、未实施者增量独审，才可限定保存。

Root保唯一Daemon build/dist/实际测试窗口；准备作者不自行执行或修改真实数据。
主CI不查询/启用/等待，不发布；本组不替代Office具体批准或fresh macOS GUI验收。
无新增用户产品决定；现有已准入hook不被强杀的边界保持。

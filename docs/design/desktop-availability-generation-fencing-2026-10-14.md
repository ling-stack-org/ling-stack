# A34 Desktop availability 的代际隔离

状态：真实隔离 RED→GREEN 与后继增量独审已完成；不是 Office 审核批准或 packaged GUI 验收。
唯一实施树 `ling-e6-continuation/ling-stack`，原准备基线 `360abd58`，实际 RED 基线 `c557de47`。
沿用既有 Desktop handshake、lease、availability 和 activation CAS，不新增 SQLite 表。

## 修复目标

同一经过 Host 认证的 handshake 中，已经接受 G2 lease 后，即使它被撤销或过期，
G1 的迟到 availability、高 sequence 或相同 sequence 重试也不能重新进入当前观测。
旧缓存同样不能经 retirement/projection retry 绕过入口校验。

这是观测与修复指导的防回退，不是 ready 事实或新执行授权；现有最终实时 lease、
requestedRevision/activationEpoch CAS、工具与权限校验保持。旧报告被拒绝不表示
已经派发的网络请求能撤回，或者旧工具已经停止。

## 模块职责

| 模块 | 必要修改边界 |
| --- | --- |
| Host desktop-bridge-authority | 持有同 handshake 的合法观测 generation 高水；准入与 getter 共用 fence |
| Desktop availability-publisher | 记录合法 snapshot generation；enqueue 与真正 dispatch 前淘汰旧代待发报告 |
| retirement/composition | 继续读取权威 getter；保留 durable commit 后 dedupe、失败重试和关闭 effective flags 的行为 |
| 回归测试 | 单独证明 authority、排队 producer、真实隔离 HTTP 与 SQLite projection，不把 fixture 当 packaged 事实 |

## Host 合同

- 高水来源仅为经过现有校验、当前 handshake 的成功 lease/non-ready 观测；无效、
  stale handshake、TTL/deadline 失败的候选不能推进它。
- 必须在转发同步 retirement observer 前建立相应 fence；不能只在 publish 返回后赋值。
  首次成功且没有 replacement callback 的 lease 也须记入。
- revoke、主动/读取 expiry、projection 失败与普通 restart 不清除已接受高水。
  仅真正 handshake 旋转或 authority clear 重置；旧 tuple 的 clear callback 不能重新播种。
- generation 先于 sequence 判断。低代 identical-sequence 不能借幂等绕过高水；
  同代既有相同内容幂等、冲突/旧序号拒绝、更高序号更新合同保留。
- getter 隐藏低于高水的缓存；没有合法新报告时沿用现有 unknown/desktop_unavailable
  fallback，不能凭空构造 G2 ready 或 non-ready 报告。

## Desktop 合同

- ready snapshot 不发送 availability，但合法 generation 仍建立内部代际 fence。
  无效 generation 不污染高水，generation 合法范围沿既有 safe integer / >=0 合同。
- 在 enqueue 与 dispatch 两处检查；已进入 client 的请求无法因此撤回，Host fence负责迟到准入。
- 不修改 coordinator 正常 enable/restart 代际生产、lease 发布、close drain 或错误诊断隔离。
  序号的合法空隙不作为失败；单纯增加串行队列不能修复旧代迟到问题。

## 退出证据

1. R1：正常接受 G2 后 revoke、读取 expiry、deadline expiry，拒绝 G1 高序号/相同序号；getter 隐藏旧缓存。
2. R2：合法 ready G2 不发送报告但淘汰后来的 G1；已排队但未 dispatch 的 G1 在更高代出现后也淘汰。
3. R3：真实 coordinator enable/restart 生产 G1→G2，与独立 availability 队列受控交错；资源 fixture-only，不伪造权限事实。
4. R4：自有 Daemon HTTP、正常认证、真实隔离 SQLite retirement；迟到旧 PUT 返回409，health/repair/epoch不回退；投影失败重试仍不消费旧缓存。
5. 邻近反证：无效候选不影响高水、新 handshake可从较低代开始、同代序号规则、合法新 lease最终CAS和失效effective=false/tools=[]保持。

每层分别保留实际日志、exit、源/dist SHA及限制。原 preparation 报告为
`output/e6-20260928/a34-next-gate-preparation-20261014.md`，保留为历史而非执行证据。
没有新增用户安全选择；全量后继审核批准、fresh packaged macOS与原 E6 总门槛不变。

## 本组实际验收

原产品四组实际 RED35项中26失败，均目标语义失败而非 fixture 导入问题。
两产品最小修改后 fresh Daemon/Desktop main direct TS build实际exit0，原35定向全部GREEN；
15个完整邻近文件266/266、零fail/cancel/skip（包含上述35，不重复累计）。
只修改 Host authority 与 Desktop publisher，不放宽 live lease/final activation CAS，
不修改正常 coordinator、Core数据库、权限或公开接口。

作者最终报告：`output/e6-20260928/a34-final-product-green-20261014.md`，
SHA `517cd679f0203f21ad7b4d5e2db25075088e9f3707b163d26c294c91be8127de`。
独立最终审阅：`output/e6-20260928/office-full-content-review-20261010/a34-final-incremental-independent-review-20261014.md`，
SHA `b8bd4a35a82a2cc14b4cf6d93a976fd3b93bf4f52f33762d2e5db217b28f741e`，
`PASS_SCOPED_WITH_LIMITS / approved=false`，范围内无确认残留P1/P2。
该独审覆盖本节补充前的既有实现合同；此处仅补真实状态，不冒新文档字节已经独审。

53项冻结保存source/dist/test/preload；后继构建若改变dist不能沿用旧SHA。
GREEN的owned HOME与精确Keychain preload保证不倒推原RED零读取，也不是native/TCC验收。
真实Node22/Windows、新macOS包、Office具体用户批准与总E6仍未完成；主CI按用户决定不处理。
本组没有新的未解决产品选择。

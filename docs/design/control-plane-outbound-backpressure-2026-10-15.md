# A15：Control-plane SSE 与 RPC WebSocket 出站边界

状态：首次真实 RED 已保留；产品修复、fresh Daemon 编译、两完整矩阵 68/68、公开 Run 断流链 2/2、
邻近 26/26 与 Desktop 源码输入 340/340 均由 Root 实际执行通过。未实施者最终增量独审已收口，
冻结范围无剩余已确认 P1/P2；`approved=false`，尚未合并；
这些不是实际慢网络或 macOS packaged GUI 验收。证据见 `output/e6-20260928/a15-20261015/`。
接续已合并 #547 的 `666da85f`（原实现 `2551b693`），不重开已完成的 A14 / B-007。

## 真实失败与范围

`writeSse` 当前把 header/data 分两次写入；ControlPlaneEventHub 忽略 write(false)，
继续清空应用队列。RPC 同样把订阅队列移入 `ws.send`，没有连接级缓冲和回调界。
500 条应用队列限制和 WebSocket 入站 maxPayload 都不能约束出站缓冲。

首次隔离实际两例均失败，exit 1、零 skip/cancel/todo：
首 write(false) 后继续写七次，总八次/976 bytes。它证明协议/背压行为，
不是实际慢 socket、OOM 或端到端网络可靠性验收。
原始日志 `output/e6-20260928/a14-b007-20261015/a15-sse-first-red.log`，
SHA-256 `9af3b34187a9d10b9eba9f9014a96d4c992c3fd795273fd405ec175fcfb07fe0`。

公开 WS upgrade/initialize/subscribe 正常基线后，真实 Hub 通知在缓冲超限时仍调用 send，
断言 `3 !== 2`；actual exit1、0pass/1fail、零cancel/skip/todo。
测试 SHA `5b1a2bc6d2ebd5e6d6145535e5a14181f9b6e430b457de395ff319c687c6d95e`。
直接工具输出摘录与边界见 `output/e6-20260928/a15-ws-first-red-20261015.md`；
这是受控传输层的公开RPC链测试，无TCP/DB/模型，不冒真实slow socket或GUI。

本组只对 Control-plane SSE 和 RPC WebSocket 建立出站 writer。
其他会话 SSE 仅共享完整 frame 的底层编码，不偷偷增加异步队列或改变其 end 时序。
不改模型、审批、Run/Attempt、权限或持久 cursor 的领域事实。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| shared/response.ts | 一次编码、一次 write 完整 SSE frame，保留 Node boolean 返回 |
| shared/sse-stream-writer.ts（新增） | response 级 FIFO、UTF-8 byte 预算、false/drain、期限、结束和清理 |
| features/control-plane/events.ts | 订阅、replay/live/ready 屏障、coalescing 与所有阶段的入队界 |
| features/control-plane/routes.ts | 头部 comment 也纳入同一 writer；request/response 关闭与注销 |
| server/rpc-outbound.ts（新增） | connection 级单 in-flight writer、callback、bufferedAmount、期限、关闭 grace |
| server/rpc.ts | 所有 response/error/control-plane/Run 通知接统一 writer；取消未发送订阅组 |
| Desktop authored inventory/tests | 两个新增 runtime 输入纳入冻结、source-only bundle、缺失/变字节拒绝回归 |

不把协议状态机继续堆入已有 629 行的 rpc.ts；不新增服务或数据库表。

## SSE 状态与顺序

```text
open → write(false) → blocked → drain → open
  └──────── close/error/overflow/deadline ─────→ closed
```

write(false) 已接受当前完整 frame，不是发送失败，不能重新入列或重放。
blocked 期间不得继续写；drain 后从下一个尚未写入 frame 恢复。
replay、replay_ready、live、heartbeat 和 snapshot_required 走同一个 FIFO。
replay 上界以内先有序入列，ready 排在它们之后；捕获期产生的 live 上界外事件排在 ready 之后。
即使最后一个 replay 返回 false，ready 也不能越过背压。
blocked 期最多保留一个待发 heartbeat，不能靠 heartbeat 跨过 ready 或刷新期限。

provisional 与 active 入队均立即核 count/bytes，不能只在定时 flush 时核。
初次头 comment 若已 write(false)，writer 必须接管 writableNeedDrain/writableLength；
优先让该 comment 自身走相同 writer，避免入口存在旁路。

snapshot_required 需“排入控制 frame 后有界结束”，与 overload/error 的立即丢弃/断开区分。
normal end 等待原队列处理，但不能无限等待 drain/finish。
主动 close、请求取消、错误或超界同步停止 intake、注销订阅、清 pending 和定时器/监听器，
随后有界关闭 response；迟到 drain/timeout 不能复活 writer 或再写。

## WebSocket 全连接边界

JSON-RPC response/error、订阅通知和 Run 通知共享一个 writer 与总预算。
不能只保护 control-plane 的 send，或让多个 subscription 各自拥有不受连接总界约束的额度。
将各订阅尚未 flush 的队列也计入连接总量，含 provisional/replay 阶段。

一次最多一个已交给 ws.send 的 frame；callback 后才能继续下一个。
发送前核 encoded frame bytes、pending、in-flight 和 ws.bufferedAmount，允许保守重复计量，
不依赖仅保护入站的 maxPayload。callback 只代表本机写出，不代表对端处理 ACK。
callback 同步、迟到、error、send 同步 throw、无 callback 都须显式处理；
回调重入不能导致递归无限 pump 或关闭后复活。

unsubscribe 取消对应尚未发送的 subscription group，不取消别组或已经交给 socket 的 frame。
关闭先同步停止连接 intake/注销所有订阅并清 pending/timers，再启动 close handshake；
grace 到期 terminate，迟到 callback 不得继续 pump。

## 默认预算与保证边界

- 单个序列化 frame：128 KiB；不截断大型 Run 事实，超界断开该消费者。
- retained pending/in-flight 加可观测传输缓冲：1 MiB；上游待 flush 队列也不得漏计。
- blocked 固定期限：5 秒；后续输入不能延长已有期限。
- close grace：1 秒，之后 destroy/terminate；测试可注入更短的同语义参数。
- 保留现有事件数量/coalescing 优化，但它不是 byte/time 边界。

这些界针对该出站生命周期保留的序列化内容与可观测缓冲，
不宣称 JSON.stringify 临时分配、任意原始事件对象或整个 Daemon 内存全局有界。
传输中断后客户端按既有 durable cursor replay/snapshot；不在服务端伪造消费 ACK 或推进 cursor。
慢连接不是 Run 失败或取消原因，断开通知流不能 abort Run、撤销权限或触发重做真实动作。
不得丢掉/coalesce 事实性 Run items 或 RPC response 后继续假称已送达。
超载时不以额外发送 slow_client_disconnect 为清理前提。

## 验证顺序

1. SSE 最小两例与公开 WS upgrade/initialize/subscribe 链一例真实 RED 已执行并保留，不重复。
2. 按以上状态机最小完整实现，原 RED 转 GREEN，不改原断言消除失败。
3. 覆盖 drain/replay-ready/live/heartbeat/重入、count/UTF-8 bytes/大 frame、多订阅合计、
   无 drain/无 callback 期限、同步错误/回调、重复 close、迟到事件与 timer/listener/queue 清理。
4. 原完整 Hub/API/RPC/Run 通知邻近与 Desktop source-only/拒缺失输入回归，增量独审。
5. 真实 slow reader 与 packaged/macOS 结果单独标注；不用合成响应或逻辑测试冒真实 GUI。

无新增未决产品选择；具体 Office 审核批准和 E6 真实客户端验收仍是后续独立门槛。

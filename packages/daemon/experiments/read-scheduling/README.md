# 后台读取调度测量

这是默认关闭的合成负载探针，不接入生产缓存或请求合并。它使用真正的
Daemon、SQLite 和 loopback HTTP；所有工作区、数据库和 Ling home 都在自有
临时目录内，Runner 拒绝模型调用。需先构建 Daemon 及依赖，再在本包运行：

```sh
node experiments/read-scheduling/measure.mjs --run-isolated-probe
```

探针创建 48 条历史，前台读取 `/conversations/:threadId`，后台读取纯列表
`/teammates`。每个模式运行 30 次前台读取；压力模式另有四个消费者各读取
30 次后台列表。第二轮反转模式顺序。退出时先停止 Daemon，再清理自有
工作区与 home，保留临时目录的 `report.json`；标准输出也包含报告和目录。

## 2026-10-29 实测

macOS arm64、Node v24.22.1；报告 UTC 时间为 `2026-10-28T16:55:16.009Z`，
命令 exit 0、模型调用 0。每行各 30 次前台请求；压力行各有 120 次后台请求。

| 顺序 | 模式 | 前台 median ms | 前台 p95 ms | 后台 median ms | 后台 p95 ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 只有前台 | 2.86 | 3.53 | — | — |
| 2 | 四个后台消费者 | 6.11 | 7.98 | 6.27 | 9.87 |
| 3 | 四个后台消费者 | 5.81 | 7.47 | 5.84 | 10.11 |
| 4 | 只有前台 | 2.48 | 2.85 | — | — |

服务端从 request listener 到 response finish/close 观察的峰值均为 1；
这不是客户端并发数，也不能分离进入 listener 之前的排队。客户端耗时包含
传输、排队、投影与 JSON 解析。其他 suite 同时运行、OS cache 和固定样本量
都会影响结果；该报告没有显著性或真实 UI 重复请求占比的证明。

报告记录实际 dist 与探针 SHA-256。本地保留原始
`.gstack/tmp/design-parity-read-measure-recheck.json`；后续源码改动不自动继承
该候选的测量结果。一次失败的 stub 缺 `secretResolver.status`，其日志另存，
没有用失败结果填表。

## 当前决定与后续条件

合成后台负载增加了这组前台请求耗时，但尚未证明真实用户故障或跨消费者
等价读取。保留现有单 owner 串行、pending 合并与 epoch 校验；不启用全局
single-flight、缓存或优先队列。下一步应在实际 UI 记录 endpoint、source、
owner、epoch 与重复比例，再决定是否只合并等价的后台纯元数据。

私聊 `/teammates/:id/direct-messages` GET 会创建/获取 thread，并 flush
governance notifications，然后才读取投影；不能按 HTTP GET 方法把它归为
无副作用元数据。带消息归属、独立超时/取消、正文分页、mutation 和 SSE
也不在默认共享范围内。

# C01 / C05 独立原型的实际证据

日期：2026-10-29。对应 [设计借鉴清单](codex-claude-borrowing-matrix-2026-10-28.md)
的 C01/C05；两项均默认关闭、未接生产，不改变现有权限、执行与存储权威。
这是本次实验记录，不替代 owning plan 的产品验收。

## C01：连接生命周期

源码在 `packages/daemon/experiments/mcp-reuse/`。分代池 8/8 单测通过，
使用实际 MCP SDK 对本地 stdio 与 Streamable HTTP 合成服务各连续调用十次：

| Transport | 模式 | 建连数 | median ms | p95 ms |
| --- | --- | --- | --- | --- |
| stdio | 每调用建连 | 10 | 72.18 | 82.75 |
| stdio | 原型复用 | 1 | 0.17 | 71.04 |
| HTTP | 每调用建连 | 10 | 2.23 | 18.03 |
| HTTP | 原型复用 | 1 | 0.47 | 1.52 |

测量包含首次握手；stdio 的十次尾部分布仍包含首次启动。固定顺序、单机、本地
合成负载，只证明连接成本可以被复用，不证明真实用户收益。11 个自有 stdio
进程全部退出，HTTP server 已关闭。heap delta 含 GC 噪声，不能当 RSS 比较。

实际测量源码 SHA-256：

- `generation-pool.mjs`: `e19867e5eeffd508420c0af0249ae9b1176c21b08972618948eabf7b307c7f20`
- `fixture-server.mjs`: `d6f2b8adc1e2e1946a4a0c7b842d7ab6b66b597506859ef2ff1d56b5fc2e77fb`
- `measure.mjs`: `960579ee86609089d60126923b6ae7bfd36e919e110daad0ea7506b92b824ca6`

保留本地 `.gstack/tmp/design-parity-mcp-pool-unit-recheck.log` 与
`.gstack/tmp/design-parity-mcp-measure.json`。guards 为模拟，真实 Host
transport/send fencing、每调用 admission/结果证明和认证轮换尚未验收。
因此继续保留生产 `withMcpClient` 的每调用 connect/close。

## C05：最小 RAM guest

源码在 `packages/daemon/experiments/vm-isolation/`，重现方式与固定镜像 pin
见该目录 README。实际平台 macOS arm64，1 CPU / 512 MiB，无网卡、磁盘或
socket device，只有显式的只读 input 与可写 output。

两次真实 Virtualization.framework 启动通过：

- 正常路径：允许输入可读；只读写被拒；未共享 canary 与越界 symlink 不可读；
  guest 只有 lo；固定输出生成并回收；Host 输入/canary 不变；symlink 与路径
  穿越导出被拒；收到 guest 结果后 ACK，再观察到正常 poweroff。
- 取消路径：ready 后请求 stop，实际收到 stopped callback，未生成任务结果。
- 正常路径 guest ready 为 257.95 ms，stopped 为 267.75 ms；取消路径 ready
  为 257.15 ms，stop requested 为 466.17 ms，stopped 为 467.61 ms。

这只是两次最小 guest，不是冷启动分布、工具兼容性或原生沙盒对比。
网络 allowlist、崩溃后持久恢复、生产 Host RPC/admission/Runner、RSS/磁盘
测量与签名发行均未完成。

实际源码 SHA-256：

- `probe.swift`: `6f404947f327a448017c3680e1d5c986d8a9b2fe342764d6007ce346f19793b1`
- `ling-init.sh`: `894fb74c23d33c98fe74f7b945576a6a180cbd16ead7c30232f78636ddb5c3bf`
- `run-probe.mjs`: `c40f93e8a83e8f495c82057563c6efe2954a3a826169cb481a4232be6895ae5e`
- `entitlements.plist`: `915e2b39357ecf8d211dc7fac43195c9cdcf55a0a1ecdbf931c116a4eac421f3`

保留本地 `.gstack/tmp/design-parity-vm-report-final.json` 和脚本打印的证据
目录。最初缺 busybox applet、结果与 poweroff 竞态、串口 CRLF 解析三次
失败保持原样；最终成功仅归属带 Host ACK 的后继源码。

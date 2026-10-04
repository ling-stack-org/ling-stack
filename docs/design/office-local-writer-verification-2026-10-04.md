# Office local writer：成员与 FD 异常验证（2026-10-04）

这是 E6/U 执行链的一个已实现增量，不是整个目标完成，也不是生产 route 或 safe receipt 验收。原远端 Draft PR #507 的保存点仍为 `76600b95`；本页记录其后的实现。

## 模块边界与实际修复

- `office-local-members.ts`：成员路径读回、inode identity 校验、固定 FD/50 MiB 读取预算。`refresh` 只能推进已有节点或固定 syscall 的显式身份；`observeFinal` 只观察，不能修改 expected/授予 cleanup 权威。超预算和路径变化用固定错误码记录。
- `office-local-writer.ts`：原 syscall/Tracker gate、执行顺序和 FD 所有权。open 返回后先登记 descriptor 再 fstat/readback；close-entered 与 closed 分开，未知 close 不重放；关闭原 descriptor 不依赖已可能被外部替换的路径 ledger。
- `office-local-writer.test.mjs`：真实 SQLite/SDK 字节和真实文件/FD 故障注入，不用 ready 文本充当执行证据。

目录有独立约束：`mkdirSync` 不返回原节点 identity，事后 `lstat(path)` 仅能约束后续路径检查，不能证明 cleanup ownership。失败时不自动 `rmdir`，目录残留进入完整成员 manifest；未来原生 creator receipt 和 Core verifier 必须显式处理，不能靠目录为空就删除或判 safe。

## 真实反例与当前证据

1. 原保存点 writer 当前重跑 **3/5**，两个真实失败：外部 temp inode 被收编/删除、成员读回使用无界 `readFileSync(path)`；Tracker mode 已 GREEN。
2. 加入只读 final/inode 同内容替换等反例后，旧实现实际 **4/8**，4 fail。第一批修复实际 **8/8**。
3. FD 反例实际 **7/10**，3 fail：路径已替换阻止原 FD 关闭、open 后首次 fstat 失败丢 FD、close 失败后同 inode 复用的 FD 被再次关闭。对应修复后 **10/10**。
4. 目录首次观察收编反例真实失败；删除该不具权威的 rmdir 路径。另补 oversized residue 不读/不授予权威测试和预算固定错误码。
5. 最新定向 writer **12/12** 加 snapshot **12/12**，合计 **24/24**，0 fail/cancel/skip，exit 0。Daemon build:ci 与 diff check exit 0。
6. Tracker mode 独立执行 **1/1**，exit 0，执行前后指纹一致。三文件独立静态窄审查剩余确认 finding 0；它不是 combined review。

Daemon 全套 session73621 已真实结束，**2,780/2,780**，0 fail/cancel/skip，exit 0。Node 内建 reporter 完整日志位于本地 `output/e6-20260928/U-office-writer-daemon-full-20261004.log`；3 个产品/测试文件的运行前后 SHA-256 完全一致。TAP 顶层 `1..2673` 含 nested cases，最终 tests/pass 均为 2780，不把顶层序号冒充测试总数。

## 明确未完成的正式事实链

- native API 真实返回必须在原返回点锁存；不能把后续 ledger/readback/Host COMMIT 错误写成 native 未返回。
- write 要有实际 `bytesWritten`，不能用请求 `sizeBytes` 代替。
- 正式 Host resource lifetime ID 要绑定 open effect/source/member，数字 FD 不提供可恢复权威；未知/retained FD 的完整持有和恢复仍需补齐。
- complete members/resources/effects 终态，以及纯 Core whole-file verifier、原 parent+producer pair 原子封口与全部 children fan-in 尚未实现。
- 固定 production route、live Office/Cua/Chrome enforcement、retained restart、answer continuation/ACK/recovery 和 fresh packaged macOS 联合验收仍按总计划继续。

本增量不开放 U gate、不颁发 safe、不放宽旧 patch verifier、不改真实数据库或历史。Node 路径检查不冒称 hostile ABA 的原子 OS 保护。失败残留和 retained/unknown 不会被标作完整收尾。

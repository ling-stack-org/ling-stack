# A29：Snapshot 流生命周期

状态：20 项流生命周期、A29/A30 最终完整相邻回归 104/104 已实际通过；独立窄审无确认残留。
不是 Office 审核批准或 App 验收；重叠回归不累加计数。

## 根因与实证

`captureWorkspaceSnapshot → scanWorkspace → hashFile` 和
`restoreWorkspaceSnapshot → buildRestorePlan → hashAndStoreBlob → hashFile`
共用手动读写循环。只有 `write=false` 时临时等待 drain、EOF 后等待 close，
不能接住等待下一次 input read 时 output 的异步 open/write 错误。

2026-10-16 首跑四例全部失败，actual exit 1、零 skip/cancel/todo：
capture / restore preimage × EACCES open / write=true 后 ENOSPC。
每例真实 WriteStream 故障时 error listener 为 0，发生 uncaught error，
操作未 settle、input 未关闭。write 例真实留下 1 byte，非模拟“磁盘耗尽”。
原始证据：`output/e6-20260928/a29-red-20261016.log`。

## 最小完整合同

- UI、数据模型与 API 不改；只修改 snapshot 文件流实现及回归测试。
- 用标准 `pipeline` 绑定 input、流式 hash/计数、output 或 discard sink。
  背压、任一端错误、销毁与关闭归同一 awaited 生命周期，不用空 error listener 吞错。
- 保持有界内存，不把文件完整读进内存；仅 pipeline 成功后返回 digest/size/tempPath。
- staging 文件保持 `wx`；从真实 open 事件记录创建所有权。错误返回前，pipeline
  必须已关闭双方，再删除本次成功创建的 staging 文件。open 失败不删除碰撞的既有文件。
- cleanup 失败须显式报告原始错误和 cleanup 错误，不伪造已清理或发布成功。
- 上层不能从失败 hash 发布 blob/manifest；原 workspace 字节/权限不变。
  restore 在 preimage 阶段失败保持 failed、空 journal、fence 释放且 SQLite 重开一致。

## 验证门槛

原四例 RED→GREEN，补 source read、背压与末尾错误、正常空/多块文件。
检查 actual exit、输入/输出关闭、staging、digest/size、blob/manifest、restore journal/fence；
随后跑受影响的 snapshot 完整文件、Daemon 类型检查及独立源码审阅。
不以本组逻辑/真实文件流测试代替 packaged macOS 验收，不复测已完成的 R03/运行时长。

## 未决事项

本项无需要新增授权的设计决策。A18、A30 与其他总计划项独立推进，不能据本项通过关闭总目标。

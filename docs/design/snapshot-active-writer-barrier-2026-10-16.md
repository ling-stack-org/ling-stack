# A30：Snapshot 活跃 writer 与 fence 准入

状态：原子 claim 与 A29/A30 最终完整相邻回归 104/104 实际通过；最终独立窄审无确认残留，approved=false。
packaged App 验收另列，不从窄审或相邻回归推断全局完成。

## 确认根因

`hasActiveWorkspaceRun` 使用面向 UI 的 latest-200 `listRuns`，并且只比较 cwd 相等。
真实旧 running command 被 200 个后继 terminal Run 或 sibling queued Run 挤出，
或者其 cwd 是 root 的子目录时，capture/restore 都会错误进入 committed。
首跑 13 项 7 pass / 6 fail、actual exit 1、零 skip/cancel/todo；
restore 反例确实发生文件替换，而 command 后续 PROBE 仍能真实写入。
证据：`output/e6-20260928/a30-red-20261016.log`，不是已发生的用户数据损坏。

## 数据与职责边界

- `listRuns` 继续是历史分页 API，不扩大 limit、不改变 UI 和公共历史读取语义。
- Core 提供无分页只读 `listActiveRunScopes()`，返回 active Run 的 id/cwd，
  复用内部 recovery 的同一状态集合 queued/running/waiting_for_approval。
  不加载模型快照、不新表、不新增任意 SQL callback。
- Snapshot 在 fence 前和 fence 后共用同一 writer 检查：
  1. 现有 `listHostCommandWriteBlockers(root)` 查询全部 prepared / stop_unconfirmed 命令事实。
     不以 Run terminal/yielded 或 lease 存在推断物理命令已停。
  2. 无分页 active scopes 按 canonical cwd 检查 parent/child 重叠；真正 sibling 不互相阻塞。
     root 不可访问错误不伪装成安全。已消失目录仅保留 lexical scope 检查。
- 新 Run、审批和执行状态转换继续使用现有持久 snapshot fence 准入。
  fence 本身不杀命令，不能用它清除旧 command blocker；失败不自动重放或补造 stop receipt。
- yielded 自身不视为活跃写权限；若仍存在独立 command blocker，则继续阻断。
- Restore 只通过 Core 专用 `claimSnapshotRestoreFence` 获得执行权：输入 requestId、
  原请求 state（requested/validating）与原请求 epoch；workspace 从真实 request row 读取。
  同一 `BEGIN IMMEDIATE` 内核验原请求、检查 fence owner、递增 workspace epoch、
  将请求状态与新 epoch 一起绑定为 fenced；任一步或 COMMIT 失败完整回滚。
  不再单独提交 requested→validating/acquire/bind，避免绑定异常遗留中间状态。
  前置 CAS 未命中返回 undefined，不认领 fence；外国 owner 明确拒绝，不改其状态。
  Capture 与恢复核对继续使用已有通用 acquire，不扩宽通用 request update 的 epoch 组合。
- 原子 claim 成功后才进入第二次 writer 检查；检查报错与 busy 都走同一失败收口。
  原子返回的真实 epoch 是唯一 cleanup 权；claim 失败不补造 owner 或释放回执。
  整个 post-claim 链在 try/finally 内。
  尚未尝试 workspace syscall 的失败可以释放本次精确 owner/epoch；存在效果且回滚未知时保留 fence。
  终态记录或释放本身失败保留原异常与 cleanup 异常（两入口均使用 AggregateError/cause），
  不覆盖后继 owner，也不假称恢复成功。COMMIT 前失败保持原请求（通常 requested）而非假称 failed。

## 验证

真实隔离 SQLite + current Attempt + Host command journal + 有限生命周期的 owned Node writer。
覆盖两入口的 buried writer、>200 active、子目录、sibling、正常 command close/Run terminal，
fence 期间另一连接创建 Run 的真实回滚，以及无 command journal 的 active Run。
原子 claim 定向覆盖状态/原请求 epoch 冲突、外国 owner、COMMIT 前两次真实写入后故障的全回滚、
成功 exact epoch、新连接读回；Daemon 故障测试同步观察新 claim，不削弱 busy、原异常与副作用断言。
重验 snapshot 原完整文件、Core command/fence/store 邻近与类型检查。
不改日常数据库、不请求模型、不把本组测试算作 macOS App 验收。

## 未决事项

本项没有需要新增授权的设计决策。非受控同 UID 进程和 Full Access 的 OS 隔离不在此合同内；
A18 的真实受控目录竞争另列，不从本项 fence 推导其安全性。

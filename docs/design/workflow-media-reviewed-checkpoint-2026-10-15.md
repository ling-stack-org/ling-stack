# Workflow / Media 后继检查点，2026-10-15

本记录仅说明 A18 静态路径、A19 取消生命周期和 A20 连接检查这一批源码的实现与验证。
不是总 E6 完成，不是 Office approved、macOS GUI 验收或发布批准。
主 CI 按用户要求不查询、不启用、不等待、不作为本次门槛。

## 实现边界

| 项目 | 当前实现 | 未被替代的门槛 |
| --- | --- | --- |
| A18 | configure 在副作用前核验已存在祖先；逐层创建、canonical FD 读写、exclusive 新文件，拒绝预存越界 symlink | inter-syscall 受控 actor 祖先替换、FD 移出/hardlink 等 OS race 仍未完成；不把重验身份说成内核原子隔离 |
| A19 | active-status SQL CAS；Registry 业务取消与原 EOF/ACK 分层；两阶段 child 收尾；重复取消补做中断的本地 reconciliation | 本地取消不证明远端停止；ACK-only 保留 unknown；新重试必须新 scene run，不隐式重发原 job |
| A20 | migration 162 持久配置/请求/消费代次；健康与消费同事务 CAS；配置和有效凭据改变时丢弃旧检查；公开 stale 409 | 外部凭据只比较本次有效值，不承诺识别 A→B→A 完整历史；不自动恢复或重发检查 |
| A20 诊断 | 原生 JSON 格式错误使用无 body 诊断；其他错误按当次真实 key 精确脱敏，再持久化 error health | 不以通用 sk-/Bearer 正则代替有效密钥清洗；不删除有用 HTTP/策略/timeout 诊断 |

新增逻辑在 path-admission、scene-cancellation、workflow-connection-check 和独立迁移模块；
大型 sqlite-run-store 仅做类型/构造接线和委托，不塞入并发业务实现。

## Root 实际验证

全部运行使用专用临时 HOME/workspace/SQLite、owned loopback 或现有受限 TCP/DNS fixture，
不读真实凭据、Keychain 或日常数据库，不调用付费模型。

- fresh Core 和 Daemon TypeScript 编译均 actual exit 0。
- A18 新完整 20 加原 import 25：45/45、actual exit 0、零 fail/cancel/skip/todo。
- A19/A20 最终两个完整文件：76/76，其中 A19 24、A20 52；actual exit 0，零 fail/cancel/skip/todo，108770.997 ms。
- 新异常窄六例是上述 76 的子集，6/6、actual exit 0，不另加总数。
- Core status CAS 独立 6/6；历史迁移完整 37/37，均 actual exit 0。
- 原 Core 邻近 60/60，原 Daemon 邻近见 Root 原始回执；A11 的 hostname 外层 guard 冲突已明示，
  改用其原 owned TCP guard 后实际通过。没有把第一次失败日志改写为成功。
- 最终 Desktop 源码输入完整 356/356、actual exit 0、零 fail/cancel/skip/todo。
  真实 esbuild 4105 runtime inputs / 1210 authored workspace inputs / 九 workspace dist inputs 0；
  native compiler/codesign 为 synthetic，artifactExecuted=false，不能称 App 已测试。
- 7 项最终 source/test/dist 冻结前后全部匹配；git diff --check 无错误。

原始失败仍保留：A18 静态越界创建、A19 取消被迟到结果覆盖、新 timer-only 收尾 Store 故障，
A20 配置/检查结果污染及非法 JSON 回显密钥，均先有实际行为 RED，不靠删除断言取绿。
历史 schema153 fixture 只精确剥离新增空 overlay/marker，保留历史 SQL、Run、Artifact、Provider、
MCP、markers、重复 reopen 与 FK 断言；新增 161/162 正确身份和空表断言。

## 原始证据绑定

输出根目录为 `output/e6-20260928/`。这些是开发机原始记录路径，不宣称已进入 release artifact。

| 记录 | SHA-256 |
| --- | --- |
| `a18-20261015/a18-post-fix-and-import.log` | `34ee0fba2b5f43f82e9b7e64cab60dac434263bd660373e41ac7e29aa959eb09` |
| `a19-20261015/a19-timer-store-fault-first.log` | `ad65e1048cc8e77690c939347604d8452250553ba33feb70ccd8112fba3bd03a` |
| `a20-20261015/credential-parse-error-first.log` | `5a65c75a086b2f8efe6a859eaaaca80b3adb1733eb53e6430f1b8a46adfbda24` |
| `a20-20261015/a19-a20-final-full.log` | `6d760868235093f3b7435e47b14de140d59536ccb424c81d8737e1ded0d81e54` |
| `a20-20261015/desktop-final-fault-fixes-source-inputs.log` | `24645c13ab5d4d27848c1364c03d8c3aed4f471bccf51bfbcdee54b759601fb8` |

## 未实施者独立审阅

- A18 静态：`a18-20261015/final-independent-source-review-20261015.md`，
  SHA `db625d051a2434da67f5212487a235fa87f5cdf8ff3245216e3fe73a0fbb6f47`。
- A19：`a19-20261015/final-incremental-independent-review-20261015.md`，
  SHA `99af2595665fd32a033bfa58663df3d9dbd2b82c437b104eadea82afc4334e65`。
- A20：`a20-20261015/independent-source-review-20261015.md`，
  SHA `47b68f4a3a9f6749ed828bfc2cf06973b17d0a4c70b539d2b104c0c9e7dfb200`。

各自冻结范围无确认残留；审阅者未实施所审产品。审阅不是 Office 批准。
A19 内部 captured controls 不冒称公开 conversation；不同 job 隔离不冒同 workUnit successor
Attempt 的动态替换证明。无新增待用户选择的产品决策。

下一步继续其余具名修复及 A18 OS race；最终受影响输入冻结、具体 Office 用户批准和 fresh packaged
macOS 12 类真实 GUI 验收仍须完成，不因本检查点降低门槛。

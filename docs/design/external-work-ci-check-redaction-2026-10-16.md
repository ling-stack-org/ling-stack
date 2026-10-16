# B009：check-run 故障事实在解析和持久化前统一脱敏

状态：Root 已确认有效首 RED（9 项 1 pass / 8 fail、actual exit 1），完成单文件产品修复。
fresh Core build、专用 9/9、四完整文件邻近 82/82 均 actual exit 0，零失败/取消/跳过。
未实施者窄审 b009-a09-independent-narrow-review-20261016.md 无确认残留，approved=false。
本项不启用或查询主 CI，不代替真实 App 或整包验收。

## 当前可达链与根因

1. 实际 Daemon POST `external-work/ci-triage.ts:123–134` 用
   `resolveExternalGitHubToken` 读取本次有效 secret，再传 Core `githubToken`。
2. Core `external-work-ci-triage.ts:199–205` 传给 adapter `listFailures.token`；然而
   `149` 调用 `buildCheckRunFailure` 不传 token。`658–695` 在原 check output 上
   `parseLogEvidence`，保留原命令/path 和 `raw.checkRun`，仅 logExcerpt 做无 token 脱敏。
3. `createTriageRecordForFailure:297–329` 只把 normalized artifact 脱敏，仍将原
   `failure`、firstFailingCommand/reproductionCommand/suspectedSourcePath 交 Store。
   `external-work-ci-triage-store.ts:26–135` 原样写字段与 failure_json，mapper 原样读出。
4. `buildCiTriageSummary:526–547`、`buildCiFixTaskPrompt:498–522` 将这些原字段写摘要、
   task/prompt artifact。`buildExternalWorkCiTriageView:243–257` 与实际 POST/list/detail
   handler 复用 Store 事实，shared `writeJson` 直接 JSON.stringify，没有后置脱敏。
5. workflow-job 在 `594` 已用本次 token 脱敏日志后再 parse，是明确正常反证；不能把
   B009 概括为所有 CI 日志、自动执行命令或真实用户凭据已经泄漏。

## 最小产品边界（已实施）

- Core check builder 接收本次 token，先用现有 `redactSecrets` 脱敏完整 check/output，
  再解析命令/路径；safe raw 与 safe 派生字段出自同一投影。不仅给 normalized/log 文件加过滤。
- 在新建 record 的写入边界使用同一 safe candidate，统一交给 artifact、summary、Task、
  Store；不让某个 sink 重新引用 raw input。Store 和 HTTP serializer 不应各造一套 token 规则。
- 保持原 command/path 诊断、failureKey、幂等、head 校验、有限条目和 excerpt 上限。
  含 secret 的路径不能继续作为原明文路径；合法普通路径仍准确。不为诊断恢复 secret。
- 不新增表/服务，不读真实凭据，不迁移或清洗用户历史，不启动 Runner，不更改审批或 GitHub
  mutation 门槛。新写入行的重复投影/稍后创建 Task 应继续安全。

现 duplicate 分支 `209–222` 直接复用既有记录。此次只验证修复后新建的行；过去若已经存入
raw 的历史记录不会自动被清洗，不能据新写入通过宣称历史泄漏已消除。真实历史处置不在本次
授权范围，不静默修改日常数据库。

## 冻结 test-only 候选

`packages/daemon/test/external-work-ci-redaction.test.mjs`，9 项：

- 3 个 adapter case：secret-shaped command、当前非通用模式 dummy token、secret-shaped path。
  走真实 adapter/check parser，检查完整 candidate（含 raw）而不是只看 logExcerpt。
- 同 3 个 case 走真实 triage→SQLite→artifact→Task：先 createTask=false，再重复请求创建
  Task，最后幂等请求；检查真实 SQL 行、重开 Store、所有 artifact 内容和完整返回投影。
- 1 个大 output：bounded log 保留 64,000 上限，尾部合法命令/path 仍可诊断。
- 1 个 workflow-job 正例：沿原先脱敏再 parse 的路径，合法命令/path、summary/task/Store
  全部保留正确行为。
- 1 个真实 Node loopback HTTP→生产 POST/list/detail handler→真实 Store/mapper 测试；由
  fixture SecretResolver 返回已知 dummy，读取真实 WORKFLOW.md。GET 不再请求 GitHub/secret，
  因而不能靠 GET 临时读取凭据掩盖不安全持久化。

所有 secret 都是源码明确的 synthetic fixture。GitHub fetch 为精确 URL/method 白名单的离线
协议替身，不委托网络；唯一 socket 是测试自己的 loopback handler。SQLite/artifacts/WORKFLOW
全部在显式临时 root，storage 配置 HOME/env-free，无默认 Store、日常数据或真实 App。
safe 断言汇总被污染 sink 名称，不将 dummy 明文误当真实泄漏证据。代码没有 skip/todo，
不修改现有测试 gate；执行成功必须由 Root 首跑后另报，不能预报通过。

本文件与 test-only 作者均未实施产品修复；最终独审须由未实施该产品改动的人另行完成。
未决判定：新写入修复无需新增用户决策；真实历史数据清洗明确不在本项，不冒称已经处理。

# 审批落盘后的只读恢复观察（R6）

状态：Web 实现、原生回归及差量独审完成，新包真实 GUI 尚待验证。
属于 E6/P3 审批恢复，不表示 P3/P4/P5 总体验收通过。

## 根因与事实来源

真实 R11 六项审批均只批准一次。GET 回执确认审批为 approved，三个 postcommit
effects 最终 completed；owner 的异步接续在 40–499ms 后完成。旧 Web 在 deferred
响应后立即丢弃查询 journal，并直接显示 15 秒 warning，后续完成不能撤销该提示。
证据位于 `output/e6-20260928/p3-bash-cwd-contract-live-20261025/.qa-evidence/103/`。

Host 的 durable decision 与 postcommit ledger 不改。模型叙述、Run 成功或工具 exit0
均不能替代 approval receipt。postcommit completed 也不意味着 Run 或整棵委派树已结束。

## 观察契约

| 回执 | 界面含义 | journal |
| --- | --- | --- |
| mutation postCommit=deferred；GET pending/claimed effect | 审批已保存，正在恢复（info） | 保留 |
| GET blocked effect | 恢复受阻，查看运行状态，不重复授权（warning） | 保留 |
| GET 失败、缺 effects、非法/重复 kind/status、错误 approvalId、effect_unknown | 暂时无法确认，不重复授权（warning） | 保留 |
| GET 所有 effects completed | 撤销同 scope 提示，只读刷新归属视图 | 仅此时清除 |
| mutation 未返回 deferred，或 resolved GET 的显式空 effects | 既有 API 的已完成语义 | 清除 |

原 mutation 响应丢失时，GET 的状态原样分类，不能把 blocked/unknown 改成 pending。
still-pending approval 仅保留查询指针，不能宣称审批已记录成功或恢复完成。
scope 继续使用 `approval:<id>:postcommit`。同 token、同状态不重复发提示。

每个已挂载 workspace 只拥有一个观察 timer，500ms 起步，指数退避至最多30秒。
timer 和手动刷新对同 cwd/approval/token 单飞 GET；刷新 generation 变化后丢弃旧回执。
切 cwd、reset、unmount 取消本地 timer 并 fence 延迟响应，不删除 durable journal。
下次正常读取列表时恢复 GET 观察。禁止观察器 POST、自动重授权、重放工具或创建新 Run。

`approval.recoveryChanged` 与 `approval.resolved` 分离：前者撤销/更新提示；GET completed
携带 receipt 归属的 run/media/external/channel ID，以现有只读入口刷新依赖视图，不递归刷新 receipt。
原 mutation 仍只发布一次 resolved；不同时触发第二套重复依赖刷新。

频道优先使用 receipt.channelId 与当前选中频道精确匹配；缺 metadata 时仅可用已观察的
当前频道 Run 精确归属，不从名称/模型文本猜测。跨频道回执不刷新当前频道。
按既有 Run、Task、messages、protocol、files、artifacts、actions、transitions 只读入口刷新，
不能调用包含 refreshApprovals 的整体 refreshChannelActivity，也不把 completed effect 当 Run 终态。

分发绑定本次 render 的固定 owner identity：cwd/channel 变化会替换 identity，返回原频道也
不恢复旧 identity。必须在 helper 入场、每个 await 后和延迟回调内核验，不能在入场时
采纳最新 ref owner，否则 resolved 前置 await 仍可把旧闭包伪装为新 owner。

## 验证与限制

- 104：原源码8项全部RED；105：初修8项GREEN。
- 106：扩展到17项，13通过/4失败，暴露完成目标遗漏及响应丢失后的状态误分类。
- 107：同命令17/17 GREEN；108：Web typecheck exit0。
- 109：当时输入 Web 完整815/815，零失败/取消/跳过；包含17项，不重复计数。
- 110：现有 UI/AppShell lint exit0；diff-check exit0。
- 111：翻译审计 exit1，stderr 明确是旧 Harness 界面缺三个中文 key；后续仅补这三个en/zh目录项，
  123原审计命令exit0。新三条 R6 文案也完整存在。
- 独审发现一项P2：SSE断开时原完成分发漏掉频道视图。112真实 AppShell 回调回归2pass/2fail，
  113同命令4/4GREEN；新增测试只在测试内用既有 TypeScript AST提取真实私有回调并运行，
  不增加生产 export、注入参数或测试分支。
- 第一频道修复输入：114 typecheck exit0；115 Web完整819/819；116 lint exit0。
- 独审同一P2的异步边界：117进入helper后切owner三项RED，118同7项GREEN；119typecheck/
  120当时Web822/822。随后121补入场前交错（8pass/2fail），122 render-frozen owner修复后
  同10项GREEN。全套最终数字仅取最后组合输入，不能叠加或把中间版本称已验收。
- 最终输入：123 i18n、124 typecheck、125完整Web825/825、126 lint均exit0，无失败/取消/跳过。
  两份回归17+10项已包含在825项内；不重跑未变化的Core/Daemon套件。
- 真实独立Agent对9输入首尾SHA复算一致，Root复算逐项相同；两项P2闭环，剩余finding=0。
  报告：`output/e6-20260928/r6-approval-observation-independent-review-20261025.md`。

原生测试复用已有 catalogConsumerHarness/catalogHookPort，编译真实 hook 源码；只替换
API、React 测试 hook port、journal 和时钟。无新增生产测试 seam。这不是 Host、真实模型、
断网或 packaged GUI 证据。新包仍需真实审批、完成后撤销提示、保持单次工具执行的读回。

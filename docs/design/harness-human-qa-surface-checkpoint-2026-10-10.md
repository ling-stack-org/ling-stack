# H09 可见 QA 与固定人工报告：实施检查点

唯一实施树 `ling-e6-continuation/ling-stack`，分支 `codex/e6-safe-continuation`；基线 `29ed9745`。
设计见[可见 QA 合同](harness-human-qa-surface-detailed-design.md)。只在本地保存，不push/PR/merge。

## 已完成内部链路

- Core：固定 namespace 内先 enrollment JOIN 再分页，默认25/最大50，全部task state；
  own read-only SQLite snapshot核验immutable report的consumed intent、真实audit、sealed bytes、
  config/rubric与完整head lineage。纠正/撤回仅改变currentness，不改原事件或137grade。
- Daemon/Main：专用private list/report与strict DTO；Main固定配置路径/canonical可信绑定，
  alias retarget/缺失拒绝；cleanup后再次核对owner、epoch、OS session，不公开路径选择权。
  list独立2MiB/report256KiB，读字段500/4096与Core合法上界对齐，旧mutation预算不变。
- Web：设置的启动与诊断内独立默认折叠QA区域，展开才读取；单项inspect后才开放反馈。
  dispatch前保存exact unresolved request，suspend/reopen或迟到拒绝不冒充提交失败；
  unknown只读恢复，不自动重发/认证。旧报告保留原内容，只标current/stale/unavailable。
- 模块分层：UI/controller/styles独立；Main read-operation/read-response/workspace-scope独立；
  Core read-store/validation独立。不把控制面表单插入会话时间线，不新增SQLite表。

## 本次真实失败与最小修复

1. Web在途submit→suspend→reopen丢未决标记：controlled RED 0/1、exit1；改为dispatch前登记，
   GREEN及后继exact-request/rejection/迟到失败测试通过。原RED保留。
2. `/var`与`/private/var`或symlink工作区被Renderer简单字符串比较误拒：Main绑定固定raw与
   canonical，UI只接受Host验证的两者之一；foreign scope仍拒绝，retarget仍拒绝。
3. Office固定input缺新read链路5项：inventory RED0/1→GREEN1/1。
4. Core纯interface用`export *`留下空runtime边缘：真实source-only RED254/256、exit1；
   一行改`export type *`，不放宽断言，最终source-only256/256、exit0。

## 最终实际验证

收据目录 `output/e6-20260928/`；失败、旧收据与GREEN分别保存。

| 层面 | 最终结果 | 收据 |
|---|---|---|
| Core新只读矩阵Node22/24 | 各60/60，actual exit0 | `h09-human-visible-core-type-export-node{22,24}-final-20261010.tap` |
| Daemon focused Node22/24 | 各28/28，actual exit0 | `h09-human-read-daemon-node{22,24}-green-20261010.log` |
| Desktop focused Node22/24 | 各85/85，actual exit0 | `h09-human-read-desktop-node{22,24}-20261010.log` |
| Web focused Node22/24 | 各26/26，actual exit0 | `h09-qa-surface-web-alias-node{22,24}-final-20261010.tap` |
| Web full Node22/24 | 各481/481，actual exit0 | `h09-qa-surface-web-full-node{22,24}-final-20261010.tap` |
| Web noEmit Node22/24 | actual exit0 | `h09-qa-surface-web-typecheck-{node22-final,final}-20261010.log` |
| Office real source-only | 256/256，actual exit0 | `h09-qa-surface-office-source-green-final-20261010.tap` |
| Workspace typecheck:ci | actual exit0 | `h09-human-visible-workspace-typecheck-final-20261010.log` |
| docs/public/diff检查 | actual exit0 | `h09-human-visible-{docs,public}-final-20261010.log` |

Contracts/Core、Daemon/Main/preload编译通过。Office真实esbuild三次覆盖原 authored inputs，
九个workspace dist输入为0；native/codesign仍测试替身，未执行bundle，不伪造正式source approval。
独审新read/alias/bounds/controller源码无剩余确认P1/P2；不会用该结果冒真实UI验收。

## 原生与真实验收边界

- 先前display-only synthetic payload返回confirmed且child实际close；用户亲自确认看到了窗口、
  点击确认并完成系统认证。没有SQLite样本，仅记录这个具体payload的真实用户认证。
- 新取消专用fixture记录实际child PID，但窗口发现前已结束，返回confirmed，actual exit1
  （期望cancelled）。没有代理点击任何认证按钮；该次人类来源尚待核实，滚动/取消未通过。
  收据 `h09-native-ui-owned-cancel-cua-20261010.log`，不重复盲跑。
- Cua共享service保持standard profile；真实TCC状态当前unknown，authorization host unavailable。
  官方Computer Use库存返回`Codex auth token is unavailable`；没有改变权限/profile或绕过输入。
- 历史专用QA app与隔离userdata目录当前已不存在，不能用旧截图或旧实例冒当前验收。
  正式Office source-review row缺失，不制造approval，不在普通日常客户端/DB中测试。

真实grader completion仍0；未知Provider output-cap不发送。H09预算batch3/rolling24h12、
owned lane1/retry0/unknown不退款；仅`OPENAI_API_KEY_2`引用，不打印/保存密钥。
下一只继续独立QA客户端、真实滚动/取消/人工durable提交与受预算Provider验证。
正式Office approval/隔离Keychain、Mobile native、macOS12类联合验收仍未完成。
H10根预算是独立未答题，不启dynamic children；总目标active，无新内部设计待决。
根checkout与独立writer WIP不改；writer diff SHA为
`312530d527ff7d209c8c281de4bc17e27261bfb7d15358a9006a281dc59e43db`。

# A23 自动化上下文条目预算检查点

基线为 #549 merge `5da1152d72aa03aa2cf687d2f7c6f0c963eb5fa8`。
本记录是 A23 源码与定向回归的检查点，不是 Office approved、真实 App 或 E6 总体验收。
主 CI 按用户要求不查、不启、不等、不作门槛，不作 CI-pass 宣称。

## 实现合同

细设计见 `automation-context-item-budget-2026-10-15.md`。
共享 Core validator 只接受缺省或正 safe integer；缺省不发明全局32上限。
builder 按原 selector/query 顺序选完整 occurrence，每条同时拥有 ref 和完整 Markdown，
brief 整块算一条、重复 selector 按次数计数。正文与 refs、context artifact、durable request、
实际 Runner task 来自同一集合；省略提示保留，预算耗尽仍显示 missing/unsupported 警告。

HTTP/Core/draft 写前拒绝非法预算，不留新 thread/definition；历史坏配置仍可禁用或归档。
非 heartbeat 在 queued/idempotency 写入前构建；duplicate 先复用既有事实。
heartbeat 保独立续跑路径，不截其指令、不新增 deterministic context/refs artifact。
没有修改 selector 权限、query limits、recurrence、表、历史或执行权限。

## 实际验证

Root 首次真实 public preview/run 为 1 pass / 2 fail：显式预算32收到33条；足预算64正例通过。
原 RED 不改写，修复后 fresh Core/Daemon tsc 均 actual exit0。

- public10 + pure33：43/43，actual exit0，3878.172875ms。
- 新真实普通 source→heartbeat / completed-key replay：2/2，actual exit0，1368.934084ms。
- API/draft race/recurrence/timer/Core Store五文件：138/138，actual exit0，31995.549167ms。
- 当前 Desktop source-input：360/360，actual exit0，15348.100458ms。
- 各组 fail/cancelled/skipped/todo 均0；43+2为分次执行，不伪称单次45项。

Public 使用真实 loopback HTTP/SQLite/orchestration、原 Pi input assembler 和 no-model RecordingRunner；
pure 使用明确 Store double。没有调用付费模型或日常数据库。
Desktop esbuild 实际4106 runtime / 1211 authored runtime inputs，九 workspace dist inputs=0；
native compiler/codesign synthetic、artifactExecuted=false，不冒真实安装/App通过。

原23项source/dist/design/tests/inventory在运行后仍全匹配；加新heartbeat文件为最终24项。
owned guard 所有当前网络拒绝计数为0；两guard记录共12次被 exec 前拒绝的 Keychain 尝试，
没有实际系统Keychain读取，不能称全部suite零attempt，未绑定PID与suite故不擅自归因。

## 证据绑定

路径相对开发输出 `output/e6-20260928/a23-20261015/`，不宣称输出日志进入发布包。

| 记录 | SHA-256 |
| --- | --- |
| 原RED `context-budget-first.log` | `9b05910f86222727e9c3199e2b7ccd4f5be878850da43b7c1f8b73f089f129c2` |
| 修后43 `context-budget-first-postfix-full.log` | `eb2336c0dc3d0e184bacba32c1dba0e0c2304cf62e09e202fd42d704238b4edf` |
| 新2 `heartbeat-and-duplicate-first.log` | `09d44d3e2e35b819500ccd58fa9343fc07c3f8fed200f838f7cd8ec9f77563c1` |
| 相邻 `automation-neighbors.log` | `386d0ebeedfd133d9ac7420a484754d3a0adefe4b7987959297185e3e77a7092` |
| Desktop `desktop-current-source-inputs.log` | `b9e5a585c7e2551374bd6f1f6e586869bb76f62c3189bef52f2dc1ff51eaa740` |
| 最终24 manifest `final-source-dist-test-after.sha256` | `7c20660684857e80e0292737d400ab1fcb7550f2245997e6921ee7ae76aad71b` |
| 未实施者独审 `final-independent-review-20261015.md` | `f7da47c70615bb74188849198d21d1fe4e7f8bf5b904cf739311027fac466fe8` |

Root 已全文读独审并核hash；选定范围无剩余已确认缺陷，approved=false。
小型 validator 和纯投影保模块边界；既有 routes/store/schemas 大文件只加必要入口校验，未扩成重构。
A23 无未决产品选择；A24、其它具名项、A18强OSrace、具体Office用户批准、新包与12类真实GUI仍未完成。
另一writer文档不改不纳入此检查点，根checkout不改；E6总目标保持active。

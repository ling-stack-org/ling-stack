# P3 私聊 QA 发现与修复 — 2026-10-23

范围：当前 E6 专用工作树，隔离 macOS QA。不是发布或总目标完成记录。

## 已定位的三项问题

1. 新私聊任务审批在 Host pending、Sidebar 计数存在，但 Composer 没有按钮。
   实际刷新同一客户端后，原审批立即可见。根因是审批归属筛选依赖启动时独立加载的全局
   Run/WorkUnit 缓存，未使用已刷新且经归属验证的当前私聊快照。修复复用该快照，不合成
   Run、不放松 teammate/thread/cwd 过滤、不新增 Host 请求。浏览器回归两正例在旧接线失败，
   修复后通过；错误 timeline owner/WorkUnit owner 不显示审批、零决策请求。联测72/72。
2. 私聊完成三文件写入后，文件卡误报“历史差异证据不完整”。Host公开API确认 immutable
   review 返回 `File-change provenance includes a non-reviewable path.`。根因是实际 managed
   worktree 的根位于 `.ling-stack/worktrees/teammates/...`，旧路径检查把合法根的祖先也拒绝。
   修复仅允许被冻结 Host directWorkspaceSnapshot 认证的 managed/ready 根祖先；teammate、
   executionCwd、worktreePath 必须匹配对应 Run。根内部 metadata、traversal、兄弟路径、
   malformed Windows path 仍拒绝；原始 sealed path、唯一性、内容hash与scope校验保留。
   新用例真实 RED→GREEN；review/native-write 22/22，recovery/direct-context/projection 31/31。
3. 私聊离线任务曾闪现“web_search 被阻止”。根因是 Host eager-prefetch 的宽正则从“不联网”
   里匹配到“联网”。该 QA 无搜索后端，未发出真实搜索；不能称当时已经外发内容。
   修复使明确离线/否定打开URL的表达不触发预取。独审发现直接否定URL的遗漏后已补齐；
   secrets、DNS、fetch、progress 均零调用；肯定搜索/打开URL的旧行为保留。最终整文件19/19。
   这是有限保守提示，不是通用语言权限判定或离线安全承诺，不改变模型工具审批策略。

## 审阅与证据

- 两个Host源码差量由真实独立审阅Agent审查，未参与实现。最终选定范围剩余finding=0。
  公共RunRequest丢弃伪造私聊snapshot；独立POSIX/Windows/UNC内存probe19/19。
- 完整独审记录、SHA、原始RED/GREEN和Host证据位于
  `output/e6-20260928/p3-private-host-delta-independent-review-20261023.md` 与同目录日志。
- Web766/766、Web类型检查、conversation-ui-core191/191已经通过；不因新记录重复运行。
- 本轮Host源码已编译、diff-check通过。后继完整Daemon启动未隔离default workspace，
  出现migration marker冲突，已中断并保留日志；不算当前整树验收。后继必须使用fresh
  Ling home和default workspace，不能修改真实数据库或放松migration guard来过测试。

## 真实案例进度与待验

- N02真实小项目五文件+311−0、项目测试11/11；TerminalReport与result Item lineage精确匹配。
  已实际点击package.json、ledger.js、cli.js、展开“文件+2”、README及总“查看变更”入口，
  对应文件正确定位、高亮、行号和真实+/-可见，不重跑已通过项目测试。
- P01原包真实工具私聊最终成功，测试2/2、单最终回复、无其他Agent消息。修复前的问题证据
  保留，不改真实SQLite历史；新包仍需验证无需刷新即可审批，以及历史文件diff恢复。
- N03第十轮已在真实客户端召回首轮三条事实；Host确认10turns、9成功1失败、0actions，
  最后accepted/request/execution快照均引用首轮Item。第六轮Provider失败保留；重开历史和
  继续约束任务仍待验，不能称完整N03通过。精确证据见`p3-current-checkpoint-20261023.md`。
- 当前运行包SHA仍为`114ddf774501da14eb9df2035b21a10533e62f2cb688f0ab2a6f0283c801d3a0`，
  **尚未包含上述三个修复**。新包差量审核、打包身份与真实场景复验必须单独留证。
- 频道required fan-in、恢复、动态委派、Office、H09和完整矩阵继续按总计划执行。

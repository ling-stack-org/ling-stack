# E6：main 整合后的隔离 QA 检查点

日期：2026-10-27。源码树为 `ling-e6-continuation/ling-stack`，分支
`codex/e6-safe-continuation`。本记录不是总计划完成、main 合并或发布证明。

## 后继检查点：频道权限继承与共享执行详情归属

权限继承实现已保存/推送为 `a5517f19a2039aaca9aaa229a933349ac538818e`。
统一 Daemon 最终组合 132/132、typecheck 通过。真实 native 首组 7/8，唯一新
symlink 测试的错误名预期已纠正，精确补测 1/1 通过；不改写成一次全组 8/8。
已完成两份未参与各自选定实现切片的独审，不宣称全 E6 完全独立审阅。
这不代表频道新策略已在新 macOS 包完成 GUI 验收。

Office 正式记录在同一 standing QA-only 授权下继续只更新 packaging map：

- 本节覆盖下方旧「最新源码」数值：新完整 SHA 为
  `f0b0f91e4a4975b68a2c2cfcbdae420cc82680acf5c0342eb4abe348c8892ef0`。
- 1637→1638；1 added、12 changed、1625 unchanged、0 removed；15 native 与全部
  non-map 字段不变。完整 JSON 精确重建、独立机械 closure 和原 reader 15/1638
  均通过。proposal `cdd76a3b…` 仍为 false/null，不伪造新本人批准。
- Web 四个 presentation 源码不属于这个固定 Office runtime map；由各自内容审阅
  与新 QA 包冻结负责，不为它们扩充 Office map 或重做旧全量阅读。

用户最新「执行详情归具体工具」规则在三种会话及嵌套子 Agent 的共享 timeline
实现；不重写三个入口、不改 SQLite/终态/fan-in。命令/cwd/输出/耗时/exit 保留在
具体工具，文件卡及逐文件 +/- 保留。结尾和日常复制仅结果/必要限制，不再追加
整份 TerminalReport；完整报告仅保留底层和显式 serializer。整轮 commentary+
final 复制、settled-only 和单 footer 不变。设计见
`execution-detail-ownership-2026-10-27.md`。

本节记录时：共享 SSR/邻接 58/58 与 Web typecheck 已通过；Root 另跑的中英文
failed/cancelled/blocked 真实临时 SQLite 6/6 通过。浏览器 mock 的频道夹具曾有
source turn/Run/report 不同归属，生产校验正确拒绝；仅在当前 spec 对齐合法
lineage，不能把早期「成功态不见报告」当有效隐藏证据。新的五个频道状态分别
1/1 和 4/4 通过，复用未受影响的普通/私聊/attention 12 项，形成 12+5=17 项矩阵，
不是最后一次统一跑 17 项。待最终审阅、checkpoint 后，用新包/新 nonce 验收。
这些 fixture 和 SSR 结果均不当作 packaged GUI。

旧 8795/b013cb54 App 已正常退出，精确 Main/Host/launcher 排空且旧输出整体保全，
没有删除历史或复用旧 one-shot。新 wrapper/launcher 只准备新 run 和新回执路径，
未知 final HEAD/ASAR 必须拒绝，真实 freeze/build/GUI 结果仍需单独收取。

## 已保存的源码与当前范围

普通 merge `d369e4ca` 保留 E6 与 main `d507c048` 的两边历史；后继修复保存于
`f2745528`、`0de9a37c`，96 项确定错译修正保存于 `f7f7bc75`。
本次不重复整合，不重新运行已通过且输入未变的完整测试。

此前实际 exit0 的选定验证：RPC 44/44、频道 41/41、Web 1020/1020、contracts
112/112、固定 Office source-input 1397/1397、本地化 20/20，及双隔离通知/
marketplace fixture 59/59。它们有覆盖重叠，不合成总数，也不替代 macOS GUI。
完整 added-text 独审覆盖 55 locale × 39 项；96 项修正的精确应用已独审闭合。
这不保证 55 种语言的专业母语质量。

## f135 隔离包的真实客户端结果

内置 Computer Use 操作原包 `f1357986`、ASAR
`4325897f28bf9eefa15118013a41b434251108e128326195a4d34be83859d2ca`，
不是上述最新组合源码包。

专用频道 `P3-20261027 Pending Scope` 由用户明确授权仅启用原定只读命令校验；
文件 edit/write 仍关闭，沙盒和工具审批保留。

1. 原 fs-read 夹具真实失败：未显式声明 `input.json`，工具 exit1/ENOENT；Run
   failed、workflow blocked 保持原判定，不重试、不改绿。项目目录是 literal
   import/require 闭包范围，不是任意 fs 读取授权。没有为测试过关扩大产品权限。
2. 明确不同的后继 module 案例真实通过：新 @QA 请求、目录问题、回答和精确工具
   审批各一次；只补 scope/本次回答来源，完整原图及 required QA manifest 保留。
   一个 resolution/proposal/workflow/Run，一组 tool_start/tool_end；命令
   `node pending-scope-module-fixture-20261027/validate.cjs` 真实 exit0，stdout 为
   `PENDING_SCOPE_MODULE_GUI_OK_20261027 sum=16`。JSON 派生 hash、parent hash 和
   回答来源已核。夹具未在 terminal 执行，原失败不作为该后继的成功样本。
3. 正常 `super+q` 后 launcher 实际 exit0，Main code0/signalnull；精确 Main/Host/
   后代消失，17928 无 listener，QA DB 无活动句柄。未发 signal 或强杀；历史 exit1
   和先前自动 receipt 不改写。单次 launcher 已消费，不得重跑。

本地证据目录为 `output/e6-20260928/p3-integrated-client-20261027.0oyefv/`：

| 证据 | SHA-256 |
| --- | --- |
| pending-module-gui-final-host.json | ee07075288091ab8793995b8621401cf2937ebd4ebcffa6e618652bdff6d448c |
| pending-v2-normal-quit-owner-drain.json | 7f1f68b1e0acb53a701c1035d00e9bbd96651f5fced51cbedb662d942f8aab63 |

真实原生截图为该目录的 `pending-module-gui-overview.png` 和
`pending-module-gui-completed.png`。Electron/macOS task_name_for_pid warning
保留，未当作成功凭据或掩盖具体工具失败。

## 最新源码的 Office QA 输入绑定

依用户已有「批准，不用再问我了」「批准，不发布，只验证」指令，完成相同隔离 QA
范围的精确 map 应用；没有新的本人认证、正式发布批准或权限豁免。

- 原正式完整记录 SHA：`0a5214d947c188d6df9f6e87ad19d6beed19a4904786ce526a34f82380241e74`。
- 新正式完整记录 SHA：`35a2e6253210368ac99f0de1639390a87e0743df0332ff903812495f046340aa`。
- 仅 packagingSha256：1625→1637，12 added、71 existing changed、0 removed。
- 15 项 native 和全部 non-map 字段不变，包括 toolchain/runtime/signing/trust/approval。
- 原 `readReviewedPackagedOfficeSource()` 实际 exit0，15/1637；完整 JSON 与原记录仅
  替换已审 map 的预期字节精确相等。未放宽 reader 或批准门禁。

本地 proposal-after-catalog 仍为 `approved:false, approval:null`，SHA
`1388a5dee07cb93c835d668d1efa51f048ed3a909e553fa510cfd492f6a8f4d2`。
内容独审/机械应用独审分别记录于 `output/e6-20260928/`：

| 报告 | SHA-256 |
| --- | --- |
| main-integration-catalog-and-office-final-closure-20261027.md | 0bc52b00c22b96e62cc63106b5c78e982e036d4ca70c0128e2706c302bd4e48d |
| main-integration-office-row-application-closure-20261027.md | eed5fac7df099349e7e09a0191013e97cffbd23e4ead8f7ce4549df48f81cb13 |

内容覆盖依赖此前全量 baseline 与精确增量，不宣称重新全文阅读 1637 项；测试通过
不是内容审阅或批准的替代。应用说明保存在同目录
`main-integration-office-standing-qa-application-20261027.md`。

## 剩余门槛与不变边界

下一步为最新源码的独立冻结/新组合包和差额 GUI/恢复、Office、H09 验收，再进行
PR/main 收尾。已过旧包案例不重复；未配置/未触发项逐项保留 not_run，不用静态
fixture 冒充真实任务或完整矩阵。H09 的 1024-token 硬输出上限仍缺可证明 Provider。

先前测试误隔离的真实 E6 DB 事故尚未关闭，缺少事前快照，不能确认其他影响；不得
继续读取、备份、修改或回滚该真实 DB/marker。本次只使用隔离 QA profile，保留
事故及失败事实。主 CI 继续停用，不发布、不升级全局 gstack、不做 Windows；无关
catalog consumer untracked 保留。提交、远端保存、PR 和 main 合并分别核验。

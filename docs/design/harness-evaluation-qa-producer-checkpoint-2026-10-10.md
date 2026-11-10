# H09 专用 QA producer：实施检查点

唯一实施树：`ling-e6-continuation/ling-stack`；分支 `codex/e6-safe-continuation`。
基础提交：`7e6fb06f`。本记录不代表生产启用、真实 Provider、人工 OS 或 macOS GUI 验收。
政策与模块边界见[详细设计](harness-evaluation-qa-producer-detailed-design.md)。

## 已实现的内部链路

- 159 sidecars：固定 QA namespace、sealed config batch、显式脱敏审阅 enrollment、request ledger。
- 原子配额/准入和终态/收据；批次3、滚动24小时12、clock high-water、单 owned lane。
- 不退款、不自动重发 unknown；跨 boot 未 drain 的请求 quarantine；显式核销保留审计引用。
- 独立非流式 OpenAI-compatible transport，私有 prepared/owned batch/receipt，单 fetch、retry0、
  redirect禁用，完整输入/响应上界，不建立 AgentSession、不启动工具或压缩。
- 原始 usage 与模型评分分开；未知金额保持 unknown，结果仍 unverified，不修改137 grade。
- credential rotation 不重置 durable 请求额度；D1证明、实际Provider/地址和configuration必须一致。
- worker不注册production。普通executor原limit1、普通Run/source/grade/quota不改变。
- Office固定清单明确增加12个authored inputs（11个可达runtime、1个type-only contract）；
  source-only验收与native/codesign/GUI分开。

## 本轮确认的缺陷与补齐

1. 跨 boot 已 quarantine 的 completed-undrained 请求无法显式核销：真实 Core RED→GREEN已保存。
2. 固定100普通/旧batch队列前缀造成当前QA永久饥饿：改为SQL先筛选owned batch再LIMIT，
   加窄端口、复合index、EXPLAIN及100项以上前缀回归，原158 claimCAS保留。
3. 最终generation callback能重入并改变lane/lease：callback之后再取clock/重验admission，
   最后abort检查后唯一fetch；拒绝路径要求真实HTTP0。
4. D1checker与实际地址误接线：绑定originalProvider的providerId/baseUrl/api/model，
   不匹配在checker创建时拒绝，batch/request和HTTP均不增加。
5. 终态同步事务内重入取消嵌套BEGIN：完整响应已验证且原子commit成功胜出；
   事务前取消或commit失败仍unknown。真实Core事务callback回归，不以mock成功代替。

## 当前已收终态与待验范围

收据在 `output/e6-20260928/`；旧失败和中间收据不覆盖。

- selector增量前的Core：双Node各63/63、Core full2755/2755，实际exit0。
  增量改变源码后，这份full仅属于当时freeze，不能作为新selector的finalfull证据。
- `h09-qa-office-required-twelve-green-20261010.tap`：static清单1/1，exit0；
  仅确认显式清单包含12leaf，不证明实际esbuild/native或GUI。
- 新selector双Node67/67、最终Core全量2759/2759、Daemon/旧worker双Node109/109、
  Root联合双Node176/176，均已收真正exit0。Root联合使用真实临时SQLite和owned loopback HTTP。
- workspace CI typecheck scripts实际exit0；Desktop全量2046pass/3Windows-onlyskip，exit0。
- Office首次真实source-only结果188项中186pass/2fail：误将仅`export type *`的contract要求为
  executable runtime input。精确分离type-only清单后188/188、exit0；该源仍保留全部digest/
  mutation/source-absent拒绝校验，不删保护、不新增虚假runtime导出。首失败日志保留。
- 三次真实esbuild均4009runtime inputs、1173authored workspace inputs、0workspace dist；
  捕获的11个新runtime与1个type-only审阅SHA匹配最终31-source/test manifest。
  native compiler/codesign仍synthetic，未执行bundle，不产生正式approval或GUI证据。
- 隔离Daemon最终全量4016/4016，0fail/cancel/skip/todo，已收actualexit0；session82634已结束。
  逐进程隔离home/defaultworkspace，未改旧真实数据库或放宽迁移校验；不再poll/重跑。
- 真实grader completion请求0；已授权模型目录HTTP200/36项，不是实际模型评分通过。

## 下一条未完成链路

完成当前内部freeze/联合后验、独审、source-only清单验证和scoped local保存后，进入完整
人工160/Main intent→OS→Daemon append-only adjudicate/correct/revoke/audit。
不能用IPC token、用户名、teammateId或`authenticated=true`冒充人工认证。
再做受本额度约束的真实Provider及新的owned QA macOS12类案例，保留旧历史，不采集日常会话。

正式Office source approval/隔离Keychain、Mobile native compile/sign/install及总体macOS验收
仍未完成。H10根预算是独立未答选择，不套用H09预算，dynamic children仍不启用。
不改根checkout；独立writer文档不改不stage；没有push/PR/merge授权，本切片只作本地保存。

收据索引（相对上述output/e6目录，除特别注明）：

- `h09-qa-core-selector-node22-20261010.tap`、`h09-qa-core-selector-node24-20261010.tap`。
- `h09-qa-core-selector-final-full-20261010.tap`：2759，actualexit0。
- `../h09-qa-model-verification-receipt-20261010.md`：作者build/窄RED→GREEN终端元数据；
  不是完整raw日志，未重建遗漏的初始stream。
- `h09-qa-joint-final-node22-20261010.tap`、`h09-qa-joint-final-node24-20261010.tap`：各176。
- `h09-qa-office-source-final-20261010.tap`：真实type-only错误RED；
  `h09-qa-office-source-final-green-20261010.tap`：188、actualexit0。
- `h09-qa-desktop-final-full-20261010.tap`、`h09-qa-workspace-types-final-20261010.log`。
- `h09-qa-daemon-isolated-final-full-20261010.tap`：4016，actualexit0。
- `h09-qa-final-source-20261010.sha256`：31份最终源码/测试，逐项checkOK。

## 当前 verdict

159专用QA内部实现、异常路径与全量回归通过；同harness独审没有剩余确认P1/P2，
不是外部Claude审查、真实Provider或GUI。31份源码/测试与4份设计/检查点作scoped local保存，
不包括独立writer文档。不新增本切片用户政策未决项；下一步是已授权的完整160人工链路。
整体H09及总目标保持active，未production注册、未push/PR/merge。

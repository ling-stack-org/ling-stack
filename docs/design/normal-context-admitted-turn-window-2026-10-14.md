# 普通会话长历史：按准入上下文读取 Turn

状态：首次真实隔离14项2通过/12失败的原始RED保留。Core双序游标与复合索引已实际12/12通过；Daemon修后原14/14、新streaming8/8与四个完整邻近文件79/79通过；Desktop完整source-input332/332通过。各次实际exit0且零失败/跳过/取消，不与旧轮次累加；不是全Daemon或GUI验收。Core回执为`output/e6-20260928/a13-core-cursor-executed-green-20261014.md`，修后回执为`output/e6-20260928/a13-actual-green-20261015.md`。

## 问题与不变合同

当前 collector 在共享 projector 已选出合法 tail/summary 后，仍先查询整个 thread 的最多500条Turn，达到500即拒绝输入。持久化历史总量因此错误地控制了新输入准入。
SQLite不是问题，也不需要删历史、新建会话或扩大模型预算。应保留当前segment、summary、visibility、source水位和whole-group预算政策，只读取被准入的事实及验证所需的owner。

这是读取长期持久化事实的改进，不新增旧版本执行兼容、事件补活或外部session权威。

## 模块边界

- Core：为确需扫描的持久历史提供稳定复合游标；默认`updatedAt DESC,id DESC`，预算折叠显式选择`createdAt DESC,id DESC`，并以workspace/thread/timestamp/id复合索引支持两种顺序。同时间戳跨页不能遗漏。旧timestamp游标行为保持，新cursor缺失、foreign或混用明确拒绝。
- Daemon私有候选收集模块：按projector实际admitted Item和source直接读取Turn/assignment；summary source refs只作必要验证，不能重新准入已覆盖原文。合法pre-bootstrap历史沿既有严格owner/source/visibility规则流式过滤，不全表materialize。
- collector/hydrator：维持Run/Turn真实归属、canonical narration的deny信号、50,000事件硬界、精确event watermark、redaction/fingerprint与whole-group预算。assigned但未被projector准入的Turn不读取事件。
- accept/fork：继续同一SQLite事务冻结；capture失败须回滚Turn、Item、assignment、附件、sequence与snapshot。幂等replay读原冻结结果，不按新历史重捕获或继承parent新权限。
- Desktop：如新增authored helper，补固定输入清单和统一source-only/缺输入拒绝回归；不继承旧Office批准。

## 明确不采用

不只删除500 guard后使用首500；不按`updatedAt < last`简单翻页；不固定最近N轮替代现有admission；不扩大budget、不删除summary或历史、不从RunEvent补活被拒正文；不把capture移出原子accept事务。
每页有界不代表可以把整个thread对象无界积入内存。只物化准入候选；分页必须在同一read snapshot中前进，cursor不前进明确失败。

## 流式选择的必要顺序合同

`updatedAt`游标只保证完整遍历，不能直接据此淘汰whole-group预算候选。最终历史以创建顺序选择：创建A/B/C、大小4/7/6、预算10时，若更新顺序先A再B后C，提前淘汰A将错失正确的C+A。

因此严格legacy扫描必须增加明确的`createdAt DESC,id DESC`有序读取模式，并与assigned准入候选按同一tuple归并。ID比较须与SQLite BINARY一致，不把JS `localeCompare`假作同序；这只影响新capture，已冻结snapshot/fork seed不重算。

每次只折叠一Turn完整组，复用纯hydrator中的owner、selectedRun、canonical deny、summary coverage和watermark规则。按降序消耗全局remaining text预算；太大的组整组跳过后仍继续尝试更小的旧组；summary按原合同最后参与预算、最终排在正文历史前。不能先为summary预留预算。

assigned候选仅按source及projector已准入Item直取owner；summary source owner另作验证，不把已覆盖正文或事件重新准入。legacy仅在既有唯一bootstrap segment合同成立时扫描，未满足条件只推进cursor，不保留全部thread对象。

单次capture的50K事件界不能按组或页重置。仅保留选中entries/refs/watermarks，legacy未保留组的诊断按code聚合，assigned诊断仍保留具体turnId。零文本entry/巨大refs也消耗内存：新capture最终snapshot限定2,000,000个UTF-8序列化字节，collector保留组时也独立累计entries/refs/diagnostics字节；超过界限须明确失败并回滚完整accept/fork，不能静默丢来源。此数量级沿用fork既有2M规模，但不可把JS字符数误称字节数。不改变已冻结snapshot的读回语义；单页/当前组/原50K事件仍是独立界，不宣称任意原始单行或事件负载均有全局字节上限。

最坏legacy扫描时间仍是O(legacy行数)；本组消除永久500拒绝和无界materialization，不承诺恒定查询耗时。上述接口/预算与纯函数拆分属必要实现合同，不引入新服务或session。

## 验证门

先执行真实公共producer构成的隔离fixture，分别记录fixture错误、500guard和实际抵达阶段；初次原始失败与owned SQLite保留，不用导入失败冒产品RED。
覆盖499控制、500/501新输入、同thread连续499→500→501、summary、segment与visibility隔离、同时间戳深页、预算whole-group拒绝、双连接WAL水位、reopen replay、冻结fork，以及snapshot INSERT故障的完整rollback/安全retry。
首次证据运行显式`LING_A13_KEEP_FIXTURES=1`，输出精确owned root；不使用日常DB/Provider/Keychain或外网。

首次RED回执：`output/e6-20260928/a13-first-actual-red-20261014.md`。T01控制与T09 reopen幂等通过；T08 RunEvent hook、T11 INSERT注入与T10 fork后半未抵达，不提前计作覆盖。

按实际RED推进产品；修后新增Core cursor正反例，运行原normal context/input/hydrator/fork与Core accepted/context/Turn/fork-seed必要邻近。最终独审与限定保存、Office具体批准、fresh packaged macOS验收分开；主CI不启用、不等待。

A14的terminal_report fork variant与B-007 summary重建另列，不因本组通过放宽其validator或source fence。当前没有新增未解决产品决定。

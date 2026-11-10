# A24：Execution Loop 的语义进度边界

## 实测问题与范围

Root 首次运行 `execution-loop-semantic-progress.test.mjs`：7 项中 3 pass / 4 fail，actual exit 1，零 skip/cancel。四项失败均为已有真实命令/stream producer 成功后没有产生预期 loop finding，并非安全票据、权限或 fixture 前提失败。

原始日志：`output/e6-20260928/a23-20261015/a24-first-semantic-progress.log`，SHA256 `549a30c77e29fb53822050936ac937c84ad3bb57b00cba20f8c404d4ddc62674`。

根因是 detector 对整个 `result`、`partialResult`、progress event data 做 hash。UnifiedExec 的新 toolCallId、artifact ID/path、时间、duration、stream sequence，以及自动生成的结果 JSON 大小，均可能被误当作新执行内容。模型可见的生成式摘要本身也包含 duration。

本项不改变执行权限、Host command ticket、审批、cancel、hard/idle timeout、fence、retry 或终态持久化。只修正 attempt-local loop detector 的证据等价关系。

## 真实链路

1. `unified-exec.ts` 执行真实受控命令，生成 stdout/stderr/result artifacts 和包含 `details.unifiedExec` 的 handled result。
2. handled result 经 `runner-pi/events.ts` 原 `tool_execution_end` normalizer 进入 `tool_end`；normalizer 不改写结果。
3. `unified-exec-output.ts` 的 stream chunk 走 Host `RunEventEmitter`，不是 Pi normalizer；chunk 含 `sequence`、`ts`、`toolCallId`。
4. orchestrator 先 redact 并用 current execution fence 写入 durable RunEvent，再交 detector。SQLite 事实和原始 UI/恢复数据保持原样。

## 模块边界

- `execution-loop-semantic-evidence.ts`：无状态纯投影，严格识别已知 producer envelope，返回用于比较的语义值；不获得执行或安全授权。
- `execution-loop-detector.ts`：保留原计数、有限 history/cache 和 findings，仅在 hash 前使用投影。
- 原 7 项真实 producer/SQLite 窄集成不降低断言；新增 focused 单测验证未知工具内容不会被通用删字段、typed 状态/内容变化仍可区分。

## 投影规则

### 完整 UnifiedExec result

只有 bash、envelope/call identity 匹配、完整 required result/stream/artifact/command/environment 字段有效时才识别。保留请求 command/args、cwd、环境摘要、stdout/stderr 文本与字节/行数、truncation、status、exitCode、signal、timeout/cancel、process observation 和 isolation。未知字段继续保留。

仅删除明确的本次执行封套：toolCallId、approvalId、startedAt/endedAt/durationMs、已知 artifact 引用。result JSON 的 sizeBytes 是封套序列化大小，不是命令新内容；stdout/stderr artifact 的实际大小仍保留。

生成式 `content[0].text` 只有在它**精确等于**原 `renderUnifiedExecModelOutput(result)`、且只有该一个 text block 时，才通过同一 renderer 将 duration 固定成零用于比较。不得 regex 修改任意工具正文；额外正文或不匹配文本完整保留。不得删除整个 details。

Isolation evidence 不作猜测式路径重写，保留 actualCommand、executionCwd/profileHash 等完整信息。若其他 backend 在这些字段加入每次随机内容，可能保守漏检而不是把未知语义吞掉；后续须先有该 producer 的独立真实反例再扩展。

### UnifiedExec stream chunk

仅完整 chunk、bash、内外 toolCallId 一致、stream/text/byteCount/redaction/truncation/sequence/ts 有效时，移除 sequence/ts/内层 toolCallId。保留 stream、完整文本、字节数和状态，以及未知扩展字段。普通工具的 `id`、`time`、`timestamp` 等任意同名字段不得全局删除。

### Host artifact / command settlement

自动 UnifiedExec artifact 必须精确满足 producer 的 role/type/title/contentType、内外 artifact ID 一致和 `runId/unified-exec/sanitizedCall/filename` 路径；result ID 是 producer 的确定命名，stdout/stderr ID 则由真实 Store 随机创建、在完整 result 中通过 role/ref 关联校验，不虚构其确定命名。仅对这些日志/result 证据去掉生成 identity/path/time，并去掉 result JSON 大小；实际 stdout/stderr 大小及未知扩展继续保留。它们第一次可形成证据，后续同效果的新封套不再重置 no-progress 计数。非匹配 artifact 完整保留。

有效 `host_command_settled` 只去掉 executionId，保留 outcome/ownerCurrent/完整 observation/未知扩展。新的 receipt identity 本身不证明任务语义进度；outcome 或实际观测变化仍是不同证据。

审批、workspace change 等其他 progress event 暂保留原完整语义，不扩大本项归一化范围。

## 内存、异常与验证

投影无 cache、不保存 raw 内容；detector 仍只保存有限 hash/counter。无效、部分、未知 producer shape 一律退回原值，不能因为解析失败丢证据或停止校验。现有 bounded canonical hash 和 attempt-local 生命周期不变。

验证顺序：保留首次 RED → focused semantic tests → 原 7 项真实 producer/SQLite 集成 → 既有 detector/orchestrator 邻近回归 → build/typecheck。仅 Root 持有运行；作者此轮不得执行 build/test/importdist/Git/CI。

以上是窄 producer/normalizer/durable event/detector 验证，不等于完整真实模型 loop、orchestrator abort、macOS GUI 或 E6 总体验收。主 CI 不属于本项门槛。

## C3 增量：完整输出身份，不以预览冒充全文

Root 已实际复现：同一 command 连续三次输出 9450 bytes、共同的 8 KiB preview、等长但不同尾部。真实 stdout artifacts 与 Host stream 尾部不同，第三个 tool_end 却错误产生 `exact_repeat`。独立测试 `execution-loop-full-output-progress.test.mjs` 首次 0 pass / 1 fail、actual exit 1，零 skip/cancel。日志 `output/e6-20260928/a24-20261015/full-output-first.log` SHA256 `56db22a1bb3a7484b6f9ce51be3804a7c6933468e813d89e502c91c94c48bf3d`。

因此，metadata 归一化必须同时拥有完整已观测输出的身份：

- producer 在 UTF-8 decoder 和 redaction **之后**、preview/artifact 截断 **之前**，按顺序对全部 redacted text 的 UTF-8 bytes 做增量 SHA256。不能 hash raw secret，不能只 hash 8 KiB preview 或 2 MiB artifact。stdout/stderr 各自有独立 hash 状态，内存为常量。
- `snapshot()` 使用 `hash.copy().digest("hex")`，不会 finalize 原 hash，重复 snapshot 和后续 ingest/flush 均合法。snapshot 不暴露内部 Hash 对象。
- 新 producer 的 `UnifiedExecStreamSummary.contentSha256` 是全部**已观测 redacted bytes** 的 digest，空流也有标准空 SHA。它不证明未知 descendant 已终止，也不把未完整收集的输出升级为成功。摘要只进入既有 Host details/artifact，renderer 不主动展示或把 digest 当用户叙述。
- synthetic stream 使用相同的 redaction→完整 digest→bounded preview/artifact 顺序。contracts/core 字段可选，以便读取历史记录，但新 producer 总是写入。
- detector 将该 digest 纳入语义比较。历史 stream 缺 digest 且 `truncated=true` 时，不能把相同 preview 当作相同完整输出；整 handled payload 保守 fallback，保留每次封套，而不是清零 exactCount 掩盖循环。
- 完整 result 仅识别 producer 的 result/stdout/stderr artifacts，角色、引用和数量必须一致。`combined` 或无对应 stream 的额外 ref 是未知扩展，整 payload 保留，不统一删其 artifactId。

新增 focused 测试覆盖任意 chunk split、多字节/redaction 边界、空流、重复 snapshot/继续 ingest、synthetic parity、stdout/stderr 隔离，以及超过 2 MiB artifact cap 的等长不同尾部。原 7 项、C3 和原 8 项业务断言不降低。若正式 summary 增字段导致原 empty-summary 精确预期变化，只显式加入空 digest 字段，保留其余断言。

update fallback 的 tracked-call map 已先冻结独立测试并由 Root 首次实测：2 项中 start-cap 正例通过、orphan tool_update 第 3 个 event 留存 3 项超过 max2，1 pass / 1 fail、actual exit 1，零 skip/cancel。日志 `output/e6-20260928/a24-20261015/tool-tracking-bound-first.log` SHA256 `d36e43dfd0e1dc8bc2d0cbb336752d3afd71c2936c322ff4032f942a752dcd68`。

最小修复：start 与 update 统一调用有限 map 的 set-and-trim helper，沿用既有 maxTrackedToolCalls、oldest insertion 淘汰顺序。start 原有 delete/reinsert、update 原有 set(existing) 顺序不变，不改计数阈值或业务策略。独立两项测试断言保持不变。

## 未决项

本范围无未决产品选择。未知工具及未证实的新 backend envelope 保守保留，可能漏检但不误删用户内容；不据此宣称覆盖任意工具的所有循环。

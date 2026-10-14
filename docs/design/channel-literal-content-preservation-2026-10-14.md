# A10：文件内容与意图分类文本分离

状态：产品、定向与相关邻近回归通过，Desktop 输入回归通过；等待最终增量独审。非 Office/packaged GUI 批准。
范围是显式关闭 channel intentSelector 的 deterministic 路径；不替换默认 model V2。

## 职责

- `file-request-content.ts` 只解析当前请求 literal 与 Markdown code block，返回原始内容、围栏外/内容外的 `instructionText`，或无法确定的状态；不处理授权、目标路径或 workflow 完成。
- selector 的 normalized text 仅用于分类、目标和自然语言 objective。writer 的专用内容段与 Host exact QA 必须消费同一份原始内容。
- 当前请求明确给了内容但无法安全解析时，使用既有结构化澄清；不能回退成上轮代码或相邻会话内容。
- 所有目标、participant、权限、operation ownership 与 fan-in 合同保持不变。

## 字节与语法边界

1. 显式多行内容冒号后的一次 LF/CRLF 属于起始语法；后续缩进、空行、tab、行内空格与 CRLF 是内容。
2. 围栏 opener 行及 closer marker 属于语法；closer 前内容的最后行终止符保留，围栏内首尾空白不 trim。
3. 验证/handoff suffix 只剥既有限定的围栏外指令。围栏内部类似 `;QA verify…` 的文本是文件字节。
4. 既有 inline 请求保持其语法空白处理；需要精确头尾空白时使用明确多行/围栏。
5. recent 同 thread code 仍按目标/语言选块，非空判断可以 trim，返回 payload 不得 trim。
6. 未闭合围栏、围栏后实质内容或显式空内容，无法确定时澄清，不静默截断或更换来源。
7. literal 内的命令示例不是执行指令。命令物化、验证意图和预算例外只读取 `instructionText`；显式围栏外的有界命令仍按现有 parser 和权限处理。

## 验证预算与失败

Host exact QA 保持原 512 字符命令上限，用原始内容生成 base64 和固定比较程序后计量。
无法放入预算且没有用户明确的有界验证命令时，必须 structured clarify/blocked；
不能 normalize 压短后通过，不能省略 required QA，也不能降级成只验存在。
不新增 Schema、安全例外或执行权限。错误字段遵循既有 clarification validator。

## 退出证据

- canonical SQLite source、持久化 Host plan、participant/source ownership、writer 专用内容段和 QA decoded 原字节分别核对。
- 正确字节由同一固定 Host Node argv 返回0，变形/压平字节返回1；使用 owned 文件、无 shell，不启动真实模型或伪造产品写入。
- 原29完整focused、额外异常边界及受影响完整邻近实际通过；保真实 RED、失败分类、fresh build、SHA与原始日志。
- 新 authored helper 纳入 Desktop 固定 inventory，缺 digest/变字节/缺 source 必须在执行前拒绝；真实 esbuild metafile 证明 source-only 来源。
- 未实施者审阅最终冻结，不从已有输入审核继承新 SHA 的批准。macOS packaged 实际案例单独验收。

## 本次局部实际结果

- 最终源码 fresh Daemon TS build exit 0；原29项、额外6项内容边界和3项命令边界同次38/38通过。
- 最终受影响完整三文件324/324通过；此前八文件365项有一条旧HTTP文案断言失败，保留原日志，不混称一次365全绿。
- Root 完整 Desktop authored/source-input 回归308/308、零fail/cancel/skip。真实 esbuild 的1198个 workspace 输入全部来自 source，九个 workspace dist 输入为0；新helper缺digest、变字节、缺source均在构建前拒绝。
- 原生编译与 codesign 仅使用明确的 synthetic fixture；这些结果不是实际 Office 包、真实模型或 macOS GUI 验收。日志与 SHA 见 `output/e6-20260928/a10-product-final-green-and-neighbors-20261014.md`、`a10-root-desktop-validation-20261014.md`。

当前没有新增未解决产品决定。实际结果以本组最终回执为准，不将设计或准备矩阵当通过证据。

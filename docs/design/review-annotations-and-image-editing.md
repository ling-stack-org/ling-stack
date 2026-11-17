# 代码批注与图片评论、编辑

## 目标与交互

在会话内审阅工作区或历史回合的代码修改，点击行号建立批注，Shift 点击同侧另一行选择范围。批注显示原始/修改侧、行范围及审阅版本；历史 diff 变化时保留原来的定位证据，不自动映射到新版本。可编辑、删除多条批注后通过同一条会话消息发送给 AI。

图片预览提供位置评论、画笔、直线、箭头、矩形、椭圆、文字、透明擦除、调整尺寸及模型移除背景。评论以图片实际显示区域计算归一化坐标。图片标注和尺寸变换在本地 canvas 处理；移除背景及按 mask 内容修复使用已配置的 live image_edit provider。结果生成新图，原资源保留，可下载或作为会话附件使用。

交互参考用户提供的 Codex 截图和静态逆向资料中的功能描述。实现由 Ling 的现有契约、预览和发送模块承担，不引入或分发逆向包中的代码。

## 架构选择

方案 A：每个面板维护评论，发送时拼接文本。接口少，但关闭面板后无法统一恢复、去重或确认发送边界。

方案 B：会话拥有一个 review draft controller，通过 React context 供 diff 与图片预览使用；扩展现有 ChannelMessageFileRef 的 annotation 字段，由既有消息持久化链路保存。采用方案 B：草稿、发送确认和隔离策略有单一 owner，daemon 复用统一解析及 prompt 渲染契约。不添加数据库表、独立服务或依赖。

```text
DiffViewer / ImageReviewEditor
           | save / update / remove
           v
ReviewDraftController -- localStorage (cwd + conversation owner)
           |
           +--> Composer feedback shelf
           |       |
           |       v
           +--> fileRefs[].annotation + existing attachments
                       |
                       v
             stream / queued follow-up
                       |
             accepted message snapshot
                       |
             model prompt + transcript
```

## 数据与边界

`ReviewAnnotation` 使用 code/image 判别联合。共同字段为稳定 id 和评论正文。代码使用 fileRef.path / line，annotation 保存 side、startLine、revision 及有界 diffHunk。图片保存 source、sourceId、x、y，坐标范围为 [0, 1]。图片评论不触发工作区文件读取；用户选择把图片加入消息后，原图副本通过现有上传链路成为附件。

API 边界验证类型、长度、坐标有限性及行号。现有文件访问策略继续控制代码引用。所有评论作为用户数据渲染，不作为系统指令。草稿只在本机存储，按 workspace 与 conversation owner 隔离；存储失败时显示反馈，当前内存草稿仍可发送。批注数量遵循现有单条消息 12 个引用的限制。

## 发送与恢复

评论进入待发送区后可与普通文本、附件一同发送。发送失败保留评论；只有服务器接受或恢复查询证明相同批注已绑定到消息时才清除该批快照。输入接受通知独立于当前界面是否仍选中，普通会话与频道的延迟回执均按原 owner 清理。发送期间新增或编辑的评论不属于已确认快照，不清除。切换会话不会提交前一会话的草稿。

未添加的代码评论按 owner、路径、审阅 revision 和 diff 内容指纹恢复选区与正文。图片草稿按 owner、workspace、资源来源和 id 保存工具、文字、位置、绘图历史及撤销位置、应用尺寸和尺寸输入；模型结果保存 artifact id，经既有内容路由重新加载。待发送区允许临时清空正文，所有发送入口在补齐正文后才接受发送。图片附件遵循现有 Composer 生命周期，草稿中的 sourceId 不等于已上传附件。

## 图片编辑

绘制对象使用归一化点、颜色及笔宽；canvas 按当前应用尺寸导出 PNG，透明擦除使用 destination-out。预览层与导出层使用相同绘制函数。撤销/重做按对象记录；关闭再打开恢复绘制草稿。绘制达到 200 个对象时阻止继续添加并显示反馈，已有绘制仍保留。尺寸输入限制边长及总像素数，防止超大 canvas 分配；保持比例为默认选项。超限原图仍可预览，编辑画布按比例初始化到允许尺寸并显示缩放提示。图片评论可把当前 canvas 副本加入消息，同一待发送批次和画面复用已添加的副本，后续批次重新添加。

模型编辑使用 source data URL 和可选 mask data URL，经现有 media jobs API 创建并运行。只展示支持 image_edit 且配置为 live 的已启用 provider。无能力时显示配置提示；不会退回生成一张无关图片。失败保留当前本地编辑，运行状态与错误可见。外部 provider 的能力与透明通道质量由真实服务决定，代码验收与真实 provider 验收分别记录。

结果图片通过 fetch/decode 和像素限制后才替换当前 base image 并清空绘图历史；任务失败、下载失败或解码失败保留当前画面。恢复原图是独立的显式操作。移除背景与 mask 修复会调用外部模型，沿用 Media Jobs 的任务记录、执行和 provider 错误语义。

## 组件、主题与表面

复用共享 Button、Input、Textarea、Select、Checkbox、InlineFeedback 和 ImageCompareViewer。批注与编辑器属于共享会话模块，外观读取已有 card、control、text、accent、border 和 focus 语义参数；Feature 只负责布局，不按主题 id 分支或覆盖共享控件的外观。批注待发送区提供独立阅读底面，媒体画布及编辑区域使用实底保护，透明棋盘格只表达图像 alpha。六套内置主题均使用相同结构与操作。

验收覆盖默认、选中、键盘焦点、禁用、加载、错误、恢复与窄窗；在同一内容下切换 Light、Dark、Breeze、Night、Ocean、Journey，检查草稿、画布和滚动边界。Web 验证与原生包及主题美术确认分开记录。

## 实施与验收顺序

1. 共享 annotation 契约、API 校验、SQLite/投影与 prompt 链路；以存储关闭重开验证持久化和 follow-up。
2. 会话 owner 草稿与确认快照、diff 行/范围选区、统一待发送区；验证失败、延迟回执和切换隔离。
3. 图片坐标评论、本地绘制/擦除/尺寸/PNG、模型编辑；验证像素、mask、撤销恢复及错误保留。
4. 普通与频道真实组件发送、现有图片比较/变更审阅回归、六主题和窄窗检查；同步 API 与产品说明。

## 质量、测试与性能

- 契约测试：code/image 解析、边界、范围、prompt 输出及无效输入拒绝。
- 草稿测试：owner 隔离、损坏存储恢复、稳定 id 更新、快照确认、发送失败保留。
- 绘图测试：归一化坐标、尺寸限制、撤销/重做、导出及 mask 语义。
- daemon 测试：普通发送与 queued follow-up 的批注保留和 prompt 渲染。
- 浏览器交互：代码 Shift 范围、评论增删改、刷新恢复、批量反馈；图片位置、绘制、擦除、调整尺寸、下载及加入消息；provider 缺失、运行失败状态。
- 运行拥有者包的类型检查、相关测试、Web lint/i18n 及文档检查。

草稿限制 12 条批注，每条正文 8,000 字符，diff 片段 24,000 字符。绘制轨迹限制点数和历史对象数量，导出限制总像素。绘制、撤销和尺寸变化在本机完成，无逐点网络请求；图片加载、模型发现、附件上传和模型任务沿用已有 API。模型任务在组件内显示结果，关闭后任务记录仍归现有 Media Jobs 管理。

## 实现状态与验收记录

本次实现已覆盖 Web 普通会话和频道会话的代码行/范围批注、图片位置评论、画笔、直线、箭头、矩形、椭圆、文字、透明擦除、撤销/重做、PNG 下载、加入消息、调整尺寸、移除背景及按 mask 修复。批注草稿按 workspace 与会话 owner 隔离并支持恢复；批量反馈支持失败保留和接受回执后的精确清理。结构化批注已接入普通消息、频道消息和 queued follow-up 的持久化与模型 prompt。

已完成的代码验收包括 contracts、core、daemon 和 Web 的 TypeScript 检查，Web lint、i18n、文档、许可证和公开 API 检查，contracts/core/daemon 相关单测，图片预览/比较模式/变更审阅回归，以及批注、图片编辑、恢复、模型编辑和频道发送的新增测试。新增浏览器检查覆盖六套主题、窄窗口、forced colors 和 reduced motion；受控 provider mock 已验证 image_edit payload、黑底白区 mask、失败/下载失败保留本地草稿，以及成功结果 artifact 的持久化与恢复。

未验证真实外部图片 provider、原生桌面打包、生产部署和现场验收；这些边界仍按交付范围单独确认。

## 交付边界

本设计覆盖 Web 中普通会话和频道会话的共享批注面板与图片预览。原生桌面打包、生产部署、云端草稿同步、代码自动重定位、多人实时协作和图层文件格式不在本次范围。

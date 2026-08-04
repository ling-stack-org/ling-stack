# Profile

## Scope

Profile 只处理用户身份和使用摘要，不显示静态预览或重复标题。用户名只读，不伪装成输入框。

## Surface

- 身份区以头像、显示名称和只读用户名组成紧凑视觉组。
- 相机 IconButton 打开本地图片选择与裁剪 Dialog；名称使用低存在感编辑入口和内联 Input。
- 使用摘要直接展示真实数据；没有数据时显示紧凑空态，不生成统计卡墙。
- 初次加载使用稳定 Skeleton，不能先闪出默认用户或假空态。

## State And Feedback

- 名称编辑、保存、失败、头像上传、裁剪、裁剪保存和使用数据加载分别拥有 scoped state。
- 保存成功使用唯一全局 Toast 并自动消失；失败使用 Profile InlineFeedback，保留输入和旧头像。
- crop Dialog 使用共享焦点锁定、Esc、outside dismiss 和 focus restore；保存中阻止重复提交。
- native file chooser 关闭后焦点回到头像入口。

## Boundaries

- Profile 不改变账号身份、权限、模型、workspace 或同步协议。
- 中文/英文时间、月份和单复数必须由 i18n 格式化，不在 JSX 拼接。
- Settings Profile 与独立 Profile 共享数据和组件语义，不共享脆弱视觉 selector。

## Acceptance

覆盖 loading/empty/error/long data、名称保存、头像格式失败、裁剪取消/失败、Toast、键盘、Light/Dark、
`1440x960`、`1280x800` 和无 document overflow。

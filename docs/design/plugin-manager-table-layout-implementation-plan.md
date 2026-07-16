# 插件管理表格与详情抽屉实施计划

## Slice 1: View Model

- 将卡片展示模型收敛为 `PluginTableRowView`。
- 集中生成短状态、状态 tone、可见操作和详情字段。
- Cua Driver 不再输出最近检查或“已启用，可使用”。

## Slice 2: Table And Drawer

- 新增插件表格组件和插件详情抽屉组件。
- `PluginManagerSettingsPanel` 只组合标题、表格和两个抽屉，操作反馈统一交给全局 toast。
- 移除行内 details、MetaRow、贡献 token 和顶部 MCP 设置按钮。

## Slice 3: Scroll And Styling

- 插件页改为固定顶部、表格主体内部滚动。
- 移除 1100px 内容上限，使插件页与自动化页使用相同的完整工作区宽度。
- 添加 sticky 表头、稳定三列尺寸和 hover/focus 滚动条。
- 行内只保留一个文字主操作，其余动作收敛为带 tooltip 的图标按钮。
- 名称列增加单行描述，状态和操作列固定宽度并列内居中。
- 暗色继续使用现有 surface、border、text 和 danger/warning token。

## Slice 4: Tests

- 使用 30 个 mock 插件验证内部滚动、sticky 表头和无横向溢出。
- 覆盖 missing、connected、ready 的状态和右侧操作。
- 覆盖详情抽屉内容、MCP 入口、失败原因和全局 toast。
- 覆盖 1280、1440、1920 与暗色模式。

## Verification

- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- plugins.spec.ts`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web lint`
- `git diff --check`

## Hard Stops

- 不改 daemon API、contracts 或持久化。
- 不恢复页面内局部通知。
- 不让详情抽屉改变表格行高。
- 不向 `AppShell.tsx` 增加插件展示业务逻辑。

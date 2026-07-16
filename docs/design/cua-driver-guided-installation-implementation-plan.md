# Cua Driver 自动检测与安装引导实施计划

## Slice 1: Contracts And Catalog

- 增加 setup state/view、connect request/response contracts 和 API client 方法。
- 在 canonical Cua Driver view 中投影只读检测结果。
- 从默认列表隐藏 `bundled:cua-driver`，保留直接 id API 兼容。
- 让 canonical view 直接识别已有 `mcp_cua_driver`。

## Slice 2: Connect And Enable

- 提取 Cua Driver connect/rollback service 与 activation service，保持 routes 只做解析和响应。
- 新增幂等 connect route，自动接入始终写 disabled。
- 旧 apply-preset 复用 connect + enable。
- Cua Driver enable 执行 MCP 检查、工具同步和失败回滚。

## Slice 3: Web Product Flow

- Plugin Manager 只渲染一个 Cua Driver。
- domain 在检测到未接入时自动 connect 一次，不自动启用。
- 新增轻量安装引导抽屉，支持官方文档、复制命令、自定义路径和重新检测。
- 只有 `missing` 状态展示安装引导；其他状态完全隐藏安装提示。
- 更新中文/英文产品文案和暗色样式。

## Slice 4: Compatibility And Tests

- API client 覆盖 connect URL/body。
- daemon 覆盖检测、单入口、幂等连接、旧 bundled 兼容、启用同步和失败回滚。
- Web E2E 覆盖 missing/detected/connected/ready、自定义路径、只连接一次和抽屉交互。
- 保留旧 apply-preset 测试，更新不再成立的双条目断言。

## Verification

- contracts/core/daemon/api-client/web typecheck。
- daemon plugin tests、API client tests、Web plugin/app/dark-mode E2E。
- i18n、lint、`git diff --check`。
- 真实 daemon 无驱动验证 missing 引导。
- 使用临时可执行 fixture 验证 detected -> 自动 connect disabled，不执行外部安装。
- 1280/1440/1920 桌面宽度检查抽屉、列表和无横向溢出。

## Hard Stops

- 不执行官方安装命令。
- 不自动启用 Cua Driver。
- 不删除旧数据库记录或破坏旧直接 API。
- 不创建第二个 MCP 服务。
- 不把本次工作扩展成通用插件市场或跨平台安装器。
- 不向 `AppShell.tsx` 增加安装业务逻辑。

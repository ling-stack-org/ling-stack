# Desktop 跨平台发布验收清单

## Purpose

本清单接管 UI 2.0 的 packaged Desktop 平台门禁。它属于发布准备，不阻塞 P9-EF 或 Web UI 2.0 主线
closeout，也不得用 Web/Playwright 结果替代真实安装包和平台实机证据。

## Release Gates

| Gate | Platform | Required evidence | Status |
|---|---|---|---|
| DESKTOP-RELEASE-MAC-ARM64 | Apple Silicon macOS | packaged launch/restart、Light/Dark、Input/Motion、window restore、0 runtime error | existing partial evidence retained |
| DESKTOP-RELEASE-MAC-X64 | Intel macOS x64 | clean install、first launch、restart、window chrome、font/control geometry、theme startup、CUA/PiP | pending |
| DESKTOP-RELEASE-WIN-X64 | Windows 11 x64 | installer、first launch、restart、DPI 100/125/150%、window chrome、font/control geometry、theme startup、CUA/PiP | pending |
| DESKTOP-RELEASE-AT-MAC | macOS | VoiceOver keyboard path、focus order、Dialog/Drawer/Menu announcements | pending |
| DESKTOP-RELEASE-AT-WIN | Windows | Narrator or NVDA、High Contrast、keyboard path、focus order | pending |
| DESKTOP-RELEASE-RESTART | macOS + Windows | first-frame theme, no black flash, persisted window/layout/theme, daemon recovery | pending |

## Evidence Contract

- 每个平台记录 commit、package version、OS build、CPU architecture、display scale、locale 和 theme。
- 截图必须来自真实 packaged app，不得来自 Vite、Playwright Web 或 Electron dev renderer。
- 每个 gate 保留 launch/restart logs、runtime errors、原尺寸截图和 SHA-256 metadata。
- 平台差异只能进入 Desktop surface tokens、window chrome 或 native bridge，不得复制 Web components。
- Logo 继续是受保护资产，不替换、不重绘、不改色、不改比例。

## Release Decision

P9-EF 完成后可宣布 Web UI 2.0 主线完成，但不能据此宣布 Desktop release-ready。只有本清单对应目标平台
全部通过，才允许发布该平台安装包。单个平台通过不自动外推到另一个平台或 CPU architecture。

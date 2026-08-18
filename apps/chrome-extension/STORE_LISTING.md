# Ling for Chrome Store Listing
Status: submission draft. Replace every `REQUIRED_...` placeholder and complete privacy/legal
review before uploading or publishing.

## Dashboard Fields

| Field | Value |
| --- | --- |
| Product name | Ling for Chrome |
| Category | Productivity |
| Default language | English |
| English summary | Let Ling complete user-approved tasks in the Chrome tabs you connect. |
| Chinese summary | 让 Ling 在你连接的 Chrome 标签页中完成经你批准的任务。 |
| Privacy policy URL | `REQUIRED_PUBLIC_PRIVACY_POLICY_URL` |
| Support email | `REQUIRED_SUPPORT_EMAIL` |
| Support URL | `REQUIRED_SUPPORT_URL` |

## English Description

Ling for Chrome connects your existing Chrome profile to the Ling desktop app running on your
computer. It lets Ling list tabs, read a bounded visible-page snapshot, navigate, click, type into
non-password fields, and capture the visible viewport only after you enable the Chrome plugin and
approve the relevant browser tool.

You stay in control:

- Every browser tool asks for approval by default.
- The extension connects only to the Ling daemon running on your computer.
- Page access is injected only for an approved action; there is no always-on content script.
- You can revoke the connection from Ling or disconnect the extension at any time.
- Ling for Chrome does not read Chrome passwords, cookies, history, bookmarks, or downloads.

When an approved browser result is used in an AI task, bounded content may be sent by Ling to the
model provider selected by the user. The extension contains no analytics, advertising, or remote
telemetry endpoint.

## Chinese Description

Ling 浏览器扩展将你现有的 Chrome 配置连接到本机运行的 Ling 桌面应用。启用 Chrome 插件并批准相应的
浏览器工具后，Ling 才能列出标签页、读取有限的可见页面快照、导航、点击、向非密码字段输入文字，以及
截取当前可见区域。

控制权始终在你手中：

- 所有浏览器工具默认都需要确认。
- 扩展只连接本机运行的 Ling daemon。
- 只有执行已批准的操作时才注入页面脚本，不存在常驻内容脚本。
- 你可以随时在 Ling 中撤销连接，或从扩展中断开连接。
- Ling 浏览器扩展不会读取 Chrome 密码、Cookie、历史记录、书签或下载内容。

当已批准的浏览器结果用于 AI 任务时，Ling 可能会将有限的相关内容发送给用户选定的模型服务商。扩展
本身不包含分析、广告或远程遥测端点。

## Single Purpose

Ling for Chrome connects a user-selected Chrome profile to the local Ling desktop daemon so Ling
can perform explicitly approved browser reading and interaction tasks.

## Permission Justifications

| Permission | Dashboard justification |
| --- | --- |
| `scripting` | Injects the packaged Ling content script into the selected HTTP(S) tab only after the user approves a snapshot, click, or type request. |
| `storage` | Stores the local Ling workspace binding and a revocable pairing credential in this Chrome profile. |
| `<all_urls>` | Allows approved actions and visible-viewport capture after navigation across user-selected HTTP(S) pages. Runtime validation rejects browser-internal, file, data, and JavaScript URLs. |

Remote code: **No**. All executable extension code is included in the uploaded ZIP.

## Privacy Questionnaire Draft

Declare conservatively and reconcile the final answers with the published privacy policy:

| Dashboard area | Draft answer |
| --- | --- |
| Website content | Yes: bounded visible text, interactive labels, and visible screenshots for approved tasks. |
| Web history | Yes: HTTP(S) URLs and page titles of tabs involved in approved tasks. |
| Authentication information | Review required: the one-time pairing credential is local and revocable, but should be disclosed if the Dashboard definition includes local application credentials. |
| Personal communications | No by design; review again if a user directs Ling to a messaging page. |
| Analytics or advertising | No. |
| Sale of user data | No. |
| Use unrelated to the single purpose | No. |

## Reviewer Instructions

1. Install Ling Desktop from `REQUIRED_REVIEW_BUILD_URL` and start the local daemon.
2. In Ling, open Plugin Manager, enable Chrome, and request a one-time pairing code.
3. Open the extension, enter the workspace path and pairing code, accept the disclosure, and connect.
4. Run the six browser tools from Ling: tabs, snapshot, navigate, click, type, and screenshot.
5. Verify that every tool asks for approval by default and that revoking access disconnects the
   extension.

Reviewer test account: not required for Ling. Tests should use public pages and must not require a
signed-in third-party account.

## Asset Map

| Asset | Path | Status |
| --- | --- | --- |
| Store icon 128x128 | `assets/icon-128.png` | Prepared |
| Manifest icons 16/32/48/128 | `assets/icon-{16,32,48,128}.png` | Prepared |
| Small promo 440x280 | `store-assets/promo-440x280.png` | Candidate, human approval required |
| English light screenshot 1280x800 | `store-assets/screenshots/plugin-manager-light-1280x800.png` | Candidate |
| Chinese dark screenshot 1280x800 | `store-assets/screenshots/plugin-manager-dark-1280x800.png` | Candidate |

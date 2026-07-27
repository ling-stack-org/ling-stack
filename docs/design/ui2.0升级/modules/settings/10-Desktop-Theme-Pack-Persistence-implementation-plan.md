# P7C.D Desktop Theme Pack Persistence 零决策实施计划

Status: `implementation-in-progress`（packaged evidence `partial`）

Decision lock: `D2=A`。Web 继续使用 IndexedDB；Desktop 必须使用 Electron main process
管理的原生 Theme Pack repository。`Theme Studio D3` 不阻塞本任务，也不得借本任务扩大为
Theme Studio、runtime artwork 或 AI 生成主题实现。

Canonical Function ID: `DESKTOP-THEME-PACK-PERSISTENCE-001`

Function status: `inventory/partial`。真实 Intel macOS x64 与真实 Windows 11 x64 packaged gate
尚未完成，不得升级为 `verified`。

Implementation slice: `P7C.D`

## 1. 文档目的

本计划把 Desktop Theme Pack 原生持久化写成可直接实施的合同。实现人员不得在编码阶段重新决定：

- Theme Pack 保存在哪里；
- renderer 与 main 之间传什么；
- 哪一层负责重新验证；
- install、reimport、delete 如何原子发布和回滚；
- active theme 如何保护；
- Web 与 Desktop 何时选择 IndexedDB 或原生 repository；
- macOS 和 Windows 用什么证据才能从 `inventory` 升级为 `verified`。

本文件只定义 P7C.D。P7C.1 已验证的 Web Theme Pack UI、ThemePicker、Import/Preview/Delete
Dialog 和 ThemeRegistry 业务语义保持不变。

## 2. 已锁定来源与优先级

依次遵守：

1. [主题资源导入与安全](../../themes/05-主题资源导入与安全.md)
2. [P7C.1 Theme Pack Management Implementation Plan](10-Theme-Pack-Management-implementation-plan.md)
3. [Interface Preferences](03-Interface-Preferences.md)
4. [Desktop 多窗口渲染器与主题同步](../../architecture/09-Desktop多窗口渲染器与主题同步.md)
5. [Desktop 与 Computer Use PiP 迁移矩阵](../../migration/13-Desktop与Computer-Use-PiP迁移矩阵.md)
6. [主题注册表与运行时切换](../../architecture/07-主题注册表与运行时切换.md)

指定审计项 `modules/settings/10-Theme-Pack-Management.md` 当前不存在。其产品合同实际由
`03-Interface-Preferences.md` 和 `10-Theme-Pack-Management-implementation-plan.md` 共同承担。
P7C.D 不创建同名替代文档，也不修改上述来源。

冲突处理顺序：安全合同 > 本计划的原生持久化合同 > P7C.1 已验证业务行为 > 当前实现便利性。

## 3. 当前权威状态

截至 2026-07-26：

- T01-T08 的 shared parser、typed contract、原生 repository、IPC/preload、Web/Desktop adapter、
  ThemeProvider integration 和 focused regression 已完成；
- T09 的真实 Apple Silicon macOS arm64 packaged sub-gate 已完成 `19/19`；
- 自包含证据位于
  `apps/desktop/release/evidence/theme-package-persistence/macos-arm64-20260726T151813Z`，包含
  `26` 张 screenshots、`14` 份 logs、`0` 个 runtime errors 和 `6` 次 first-frame transitions；
- artifact ZIP SHA-256 为
  `e4fe5020141eb6533f7819ffaace1c61b796a4f5c36cd8bf99642385fbbb312a`，executable SHA-256 为
  `997d6e26011b89344f98626987155158f13f492148f79bc00f24d841ae693b60`，`app.asar` SHA-256 为
  `da25639265ef2829d187b8851f7b6793d042649a05fdf2f4cc007e439dd32f6b`；
- candidate version 为 `0.0.0`，source HEAD 为 `0a0b80502715d0333342422e6dc8cedd2cd77b14`；
- 该 candidate 来源工作树 dirty 且未签名，只是隔离 packaged 验证证据，不是正式发行物；
- 真实 Intel macOS x64 和真实 Windows 11 x64 仍未验证，T11 只能做部分对账。

因此 `DESKTOP-THEME-PACK-PERSISTENCE-001` 当前必须保持 `inventory/partial`。arm64 packaged
证据证明 Apple Silicon 子门禁成立，但不能单独把完整 macOS gate 或跨平台 Function ID 升级为
`verified`。

## 4. 目标

P7C.D 完成后：

1. 普通 Web 继续通过 IndexedDB 保存 Theme Pack；
2. Electron Desktop main process 在 `app.getPath("userData")/themes/<themeId>/` 保存 Theme Pack；
3. Desktop renderer 只能提交受限归档字节和 typed request，不能选择目标路径；
4. main process 对归档、manifest、资源和已落盘文件做独立重新验证；
5. install、reimport、delete、startup recovery 不暴露半完成主题；
6. ThemeProvider 通过统一 repository port 使用 Web 或 Desktop adapter，Settings UI 合同不变；
7. active theme 删除前必须先切换并确认 built-in fallback；
8. 损坏主题不能进入 Registry，当前选择自动回退到 built-in，并保留 Reimport/Delete 修复入口；
9. 打包应用重启后，原生主题列表、当前选择、首帧主题和 Preview 均可恢复；
10. macOS 与 Windows 的真实 packaged evidence 均通过后，Function ID 才能标记 `verified`。

## 5. 非目标

- 不实现 Theme Studio Quick、Generate 或 Advanced；
- 不等待或重新打开 `Theme Studio D3` 决策；
- 不允许 runtime artwork、shell background、hero、corner decoration 或 Presentation Profile payload；
- 不新增任意 CSS、JS、HTML、SVG、font、remote URL、data URL 或 selector；
- 不改 Logo、应用图标、Settings IA、路由、ViewId、daemon API、数据库或 workspace 状态；
- 不把 Theme Pack 保存到 app bundle、resources、workspace、Downloads 或用户选择的目录；
- 不同步 Web 与 Desktop Theme Pack，不做云同步；
- 不从旧 IndexedDB 记录合成一个“可信”的 `.ling-theme` 归档；
- 不让 renderer 直接读取原生绝对路径或 `file://` URL；
- 不在 `main.ts`、`ipc.ts`、`theme.tsx` 中实现 ZIP 解析或文件事务；
- 不用 Web fixture、Playwright capability mock 或 PiP token screenshot 代替 packaged Desktop gate。

## 6. 模块边界

```text
Settings Theme Pack UI
  -> ThemeProvider
  -> ThemePackageRepositoryPort
       -> WebThemePackageRepositoryAdapter
            -> IndexedDB v3
       -> DesktopThemePackageRepositoryAdapter
            -> window.lingDesktop.themePackages
            -> preload typed capability
            -> dedicated main IPC owner
            -> DesktopThemePackageRepository
            -> userData/themes

Raw archive validation
  -> @ling-stack/ui-react/theme runtime-neutral parser
       -> Web image decoder adapter
       -> Desktop nativeImage decoder adapter
```

### 6.1 UI 层

- `InterfaceThemeSettings.tsx` 继续只负责组合；
- `useThemePackageController.ts` 继续负责 Dialog 状态和产品反馈；
- UI 不判断平台路径、fs error、journal 状态或 checksum 优先级；
- 已验证 Import、Preview、Reimport、Delete 可见行为不改。

### 6.2 Web adapter 层

- 定义唯一 `ThemePackageRepositoryPort`；
- 普通 Web 选择 IndexedDB adapter；
- Desktop capability 完整存在时选择 Desktop adapter；
- capability 一旦存在，本次 renderer 生命周期内不得因原生操作失败而静默回退到 IndexedDB；
- capability 缺失时才允许选择 Web adapter；
- adapter 把 `ArrayBuffer` 转为/转回 Web 使用的 Blob，不泄漏原生路径。

### 6.3 Shared theme parser 层

- 归档目录检查、预算、CRC、manifest、checksum、MIME sniff 和资源引用检查只有一个实现；
- shared parser 输入 `Uint8Array`，输出 normalized bytes，不 import Electron、IndexedDB、React 或 Web i18n；
- Web 和 Desktop 各自注入 image decode adapter，二者都必须完成真实解码和尺寸检查；
- renderer 的第一次解析只用于 review；main 的第二次解析才是原生发布信任边界。

### 6.4 Desktop main 层

- `DesktopThemePackageRepository` 是文件系统和事务唯一 owner；
- `registerDesktopThemePackageIpc` 是 channel、sender 和 request shape 唯一 owner；
- repository 不 import BrowserWindow、IPC 或 Web 类型；
- IPC owner 不实现 ZIP、文件写入或产品文案；
- `main.ts` 只构造、`await initialize()`、注入、注册 disposer；
- 现有 `ipc.ts` 不增加 Theme Pack handler。

### 6.5 Shared contract 层

- request/result/error 和 capability 定义在 Desktop shared 文件；
- preload 和 Web declaration 消费同一语义；
- renderer 不接收绝对路径、OS error message、stack、ACL、用户名或 staging 名称。

## 7. 原生目录合同

根目录必须由 Electron 运行时解析：

```ts
const themesRoot = resolve(app.getPath("userData"), "themes");
```

禁止从环境变量、renderer request、manifest、workspace 或文件选择器覆盖该路径。

目标结构固定为：

```text
<userData>/themes/
  .staging/
    <operationId>/
      operation.json
      candidate/
        installation.json
        theme.json
        LICENSE.txt                 optional
        assets/
          preview.png|jpg|jpeg|webp optional, exactly one
  .rollback/
    <themeId>.<operationId>/
      installation.json
      theme.json
      ...
  .trash/
    <themeId>.<operationId>/
      ...
  <themeId>/
    installation.json
    theme.json
    LICENSE.txt                     optional
    assets/
      preview.png|jpg|jpeg|webp     optional, exactly one
```

规则：

- `<themeId>` 使用已验证的 lowercase ASCII kebab-case ID，最长 64；
- `ling-*` 永远不能成为本地目录；
- 为跨平台一致性，额外拒绝 `con`、`prn`、`aux`、`nul`、`com1` 至 `com9`、`lpt1` 至
  `lpt9`；
- 所有包内路径继续限制为 ASCII，按 Unicode-independent lowercase 做冲突检查；
- 不把归档原样保存为文件，不执行“通用解压到目录”；
- repository 只按 allowlist 写出 normalized `theme.json`、可选 license 和可选 preview；
- `installation.json` 是 repository metadata，不来自归档；
- `.staging`、`.rollback`、`.trash` 与最终目录必须位于同一个 `themesRoot` 文件系统；
- 出现 `EXDEV` 时直接失败，不使用 copy-and-delete 冒充原子 rename；
- Desktop 不修改应用包内任何文件。

### 7.1 installation.json

固定 schema：

```ts
interface DesktopThemeInstallationRecordV1 {
  readonly storageSchemaVersion: 1;
  readonly themeId: string;
  readonly source: "local-import";
  readonly packageChecksumSha256: string;
  readonly manifestChecksumSha256: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly files: readonly {
    readonly path: "theme.json" | "LICENSE.txt" | `assets/${string}`;
    readonly byteLength: number;
    readonly checksumSha256: string;
    readonly mimeType: "application/json" | "text/plain" | "image/png" | "image/jpeg" | "image/webp";
  }[];
}
```

- 时间使用 UTC ISO 8601；
- install 固定新的 `installedAt`；
- reimport 保留 `installedAt`、更新 `updatedAt`；
- `theme.json` 使用验证后 manifest 的 canonical JSON：UTF-8、2-space indentation、末尾一个 LF；
- `LICENSE.txt` 重新编码为 UTF-8，保留文本内容，末尾不强行修改；
- files 按 canonical path 升序写入；
- `installation.json` 写完后自身不列入 files，repository 读取时单独做 schema 和大小限制；
- metadata 最大 64 KB；
- checksum 一律为 lowercase 64 字符 SHA-256 hex。

### 7.2 权限

- POSIX 创建目录请求 `0700`、文件请求 `0600`；
- Windows 依赖 `userData` 当前用户 ACL，不把 POSIX mode 当作 Windows 安全证据；
- 不调用 shell、PowerShell、`chmod -R` 或平台外部工具；
- 不移除 macOS quarantine/xattr，也不执行导入内容；
- 权限检查失败返回 typed error，不在 renderer 暴露绝对路径。

## 8. 验证管线

install 和 reimport 必须执行完全相同的 main-side 管线：

```text
typed request shape
  -> sender ownership
  -> requestId and byteLength bound
  -> .ling-theme extension
  -> SHA-256 of received archive
  -> ZIP central/local directory inspection
  -> count/compressed/uncompressed budgets
  -> raw path/case-fold duplicate/symlink/special entry rejection
  -> bounded in-memory decode
  -> CRC and actual uncompressed size verification
  -> UTF-8 and strict JSON parse
  -> validateThemeManifest(source=local-import)
  -> D1=A runtime artwork rejection
  -> reference allowlist and unreferenced file rejection
  -> preview extension + magic MIME + native decode + dimensions
  -> per-file SHA-256
  -> staging write
  -> lstat/realpath/no-symlink verification
  -> re-read every staged byte and checksum
  -> atomic publication protocol
  -> final re-read before result
```

固定预算沿用 P7C.1：

| 项目 | 限制 |
|---|---:|
| archive | 20 MB |
| entry count | 32 |
| file count | 16 |
| total uncompressed | 32 MB |
| theme.json | 1 MB |
| installation.json | 64 KB |
| one image | 16 MB |
| decoded pixels | 32 MP |
| longest image edge | 8192 px |
| IPC originalFileName | 160 ASCII/UTF-8 code units, basename only |
| IPC requestId | 80 ASCII characters |

必须拒绝：

- absolute path、drive path、UNC path、`..`、empty/control-character path；
- case-fold duplicate；
- symlink、hardlink、socket、device、FIFO 和其他 special entry；
- ZIP64、multi-volume、encrypted、unsupported compression、trailing data；
- local/central header 不一致、CRC 或 size 不一致；
- CSS、JS、HTML、SVG、font、WASM、executable 或 unknown file；
- remote URL、data URL、Logo replacement、runtime artwork、unknown Presentation Profile payload；
- reserved `ling-*` ID、跨平台 reserved filename、unsupported schema；
- preview extension、magic MIME、native decoder 或 dimensions 任一不一致；
- renderer checksum 与 main 重算 checksum 不一致；
- staged/final 文件 checksum、size、path 或 metadata 不一致。

main 进程不得相信 renderer 已经执行过同一验证。renderer 提供的 `themeId`、checksum、manifest
摘要都只用于 optimistic concurrency 或 UI identity comparison，不是发布依据。

## 9. 路径和 symlink 安全

所有路径操作使用 `node:path` 和 `node:fs/promises`。不得手工拼接 `/` 或 `\\`。

每次 publication 前后执行：

1. `lstat(themesRoot)`，若 root 是 symlink 则停止全部原生主题操作；
2. `realpath(themesRoot)` 保存为 authority root；
3. 每个候选路径使用 `resolve(authorityRoot, relativePath)`；
4. 使用 `relative(authorityRoot, candidate)` 验证结果非空、非 absolute、且不以 `..` 开头；
5. 对已存在的每一级执行 `lstat`，任何 symlink 都拒绝；
6. 写入使用 `open(..., "wx", 0o600)`，不能覆盖 staging 内意外存在的文件；
7. 写后重新 `lstat`、`realpath`、读取并核对 checksum；
8. cleanup 遇到 symlink 只 unlink 该 link，不跟随目标；
9. final package 扫描只接受 allowlist 文件，发现额外文件即标记 corrupt。

大小写敏感文件系统也使用 case-fold duplicate 规则，以保证同一包在 macOS 和 Windows 的行为一致。

## 10. 原子发布、回滚与启动恢复

### 10.1 Journal 状态

`operation.json` 固定为：

```ts
type DesktopThemeOperationPhase =
  | "staging"
  | "candidate-ready"
  | "backup-created"
  | "published"
  | "delete-staged";

interface DesktopThemeOperationJournalV1 {
  readonly journalSchemaVersion: 1;
  readonly operationId: string;
  readonly kind: "install" | "reimport" | "delete";
  readonly themeId: string;
  readonly phase: DesktopThemeOperationPhase;
  readonly expectedPreviousChecksumSha256?: string;
  readonly candidateChecksumSha256?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}
```

每次 phase 更新采用同目录 temp file + rename，并在支持时 fsync file 和 parent directory。

### 10.2 Install

1. 获取全局 mutation lock；
2. main 重新验证归档；
3. 若 final 已存在，返回 `theme_already_installed`；
4. 创建随机 operation ID 和同卷 staging；
5. 写 `staging` journal；
6. 生成 candidate，fsync，完整 re-read；
7. journal 改为 `candidate-ready`；
8. `rename(candidate, final)`；
9. fsync `themesRoot`（平台支持时）；
10. journal 改为 `published`；
11. final 完整 re-read；
12. 删除 operation 目录；清理失败返回 success warning `cleanup_pending`；
13. 更新内存 index 和 repository revision。

final rename 之前的任何失败都删除 staging，最终目录保持不存在。final rename 之后若 final re-read
失败，立即把 final 移到 `.rollback/<themeId>.<operationId>`，返回 `publication_failed`，不得把该
主题加入 Registry。

### 10.3 Reimport

1. 获取全局 mutation lock；
2. final 必须存在；
3. request 的 `expectedCurrentChecksumSha256` 必须匹配当前安装；
4. 新包 main-side validation 后必须解析为同一个 theme ID；
5. staging candidate 完整写入和 re-read；
6. journal 进入 `candidate-ready`；
7. `rename(final, rollback)`，journal 进入 `backup-created`；
8. `rename(candidate, final)`；
9. final 完整 re-read，journal 进入 `published`；
10. 删除 rollback 和 staging；cleanup 失败记为 `cleanup_pending`；
11. 更新 index/revision。

任一步在 `backup-created` 后失败：

- 若新 final 存在，先安全移到 `.trash`；
- `rename(rollback, final)`；
- 完整 re-read 旧 final；
- 恢复成功返回原操作失败，例如 `publication_failed`，旧主题继续可用；
- 恢复失败返回 `rollback_failed`，保留 journal、rollback 和可诊断 operation ID；
- `rollback_failed` 时 ThemeProvider 回退到 built-in，不尝试注册不确定版本。

Windows 对非空目录没有可依赖的原子 replace 语义，因此不得调用“直接覆盖 final”。上述两个
rename 边界和 journal recovery 是唯一实现。

### 10.4 Delete

1. active guard 必须 ready；
2. built-in 或 active theme 返回 blocker；
3. request checksum 必须匹配当前安装；corrupt item 可使用 bootstrap 返回的 `recordRevision`；
4. 获取 mutation lock；
5. `rename(final, .trash/<themeId>.<operationId>)`；
6. fsync root（支持时），journal 进入 `delete-staged`；
7. 从 index 移除并返回成功；
8. trash 递归清理由后台 bounded cleanup 执行。

删除提交点是 final -> trash 的 rename。rename 失败时 final 完整保留并返回 error。rename 成功但
物理清理失败时返回 success warning `cleanup_pending`，下次启动继续清理；不得把已删除主题重新
显示为已安装。cleanup 不跟随 symlink。

### 10.5 Startup cleanup/recovery

`DesktopThemePackageRepository.initialize()` 必须在 Theme Pack IPC 注册和主 Web window 可交互前完成：

1. 创建/验证 root、staging、rollback、trash；
2. 拒绝 symlink root；
3. 按 operation ID 排序读取 journal；
4. `staging` / `candidate-ready` 且无 final/backup：删除 abandoned staging；
5. `backup-created` 且 final 缺失、rollback 有效：恢复 rollback；
6. `backup-created` 且 final 有效：final 胜出，旧 rollback 进入 trash；
7. `published` 且 final 有效：保留 final，旧 rollback/staging 进入 trash；
8. `published` 且 final 无效、rollback 有效：恢复 rollback；
9. final 与 rollback 都无效：保留目录、标记 corrupt，不自行删除用户数据；
10. 清理无 journal 的 abandoned staging；
11. best-effort 清理 trash，失败只形成 typed cleanup warning；
12. 完整扫描 final packages，建立 valid/corrupt index；
13. revision 从 `1` 开始，后续 mutation 单调递增。

单实例锁是跨进程前提；repository 仍必须有进程内全局 mutation mutex。所有 mutating request 串行，
read/list/bootstrap 等待正在执行的 mutation 后读取一致 snapshot。

Windows rename 遇到 `EPERM`、`EACCES` 或 `EBUSY` 时固定重试 3 次，延迟为 50 ms、150 ms、450 ms。
其他错误和第三次失败立即进入 rollback。macOS 不做无界重试。任何平台都不重试 validation error。

## 11. Typed contract

新增 `apps/desktop/shared/theme-package-capabilities.ts`，固定公开类型：

```ts
export type DesktopThemePackageHealth = "ready" | "corrupt";

export interface DesktopThemePackagePreviewDescriptor {
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
}

export interface DesktopThemePackageDescriptor {
  readonly themeId: string;
  readonly health: DesktopThemePackageHealth;
  readonly recordRevision: number;
  readonly manifest?: LingThemePackManifest;
  readonly packageChecksumSha256?: string;
  readonly installedAt?: string;
  readonly updatedAt?: string;
  readonly preview?: DesktopThemePackagePreviewDescriptor;
  readonly issueCode?: DesktopThemePackageErrorCode;
}

export interface DesktopThemePackageReadValue {
  readonly descriptor: DesktopThemePackageDescriptor;
  readonly licenseText?: string;
  readonly previewBytes?: ArrayBuffer;
}

export interface DesktopThemePackageBootstrapValue {
  readonly repositoryRevision: number;
  readonly packages: readonly DesktopThemePackageDescriptor[];
  readonly recoveryWarnings: readonly DesktopThemePackageWarning[];
  readonly activeGuardReady: boolean;
}

export interface DesktopThemePackageArchiveRequest {
  readonly requestId: string;
  readonly originalFileName: string;
  readonly archiveBytes: ArrayBuffer;
  readonly rendererPackageChecksumSha256: string;
}

export interface DesktopThemePackageReimportRequest extends DesktopThemePackageArchiveRequest {
  readonly themeId: string;
  readonly expectedCurrentChecksumSha256?: string;
  readonly expectedRecordRevision: number;
}

export interface DesktopThemePackageDeleteRequest {
  readonly requestId: string;
  readonly themeId: string;
  readonly expectedCurrentChecksumSha256?: string;
  readonly expectedRecordRevision: number;
}

export interface DesktopThemePackageSetActiveRequest {
  readonly themeId: string;
}

export type DesktopThemePackageResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly DesktopThemePackageWarning[] }
  | { readonly ok: false; readonly error: DesktopThemePackageError };
```

### 11.1 Error codes

`DesktopThemePackageErrorCode` 固定包含：

```text
unauthorized_sender
invalid_request
archive_empty
archive_too_large
invalid_archive
unsupported_archive
unsafe_path
unsupported_entry
unsupported_file
invalid_entry_size
invalid_entry_crc
invalid_text
invalid_manifest
invalid_schema
reserved_theme_id
runtime_artwork_not_supported
missing_preview
invalid_preview_mime
invalid_preview_image
invalid_preview_dimensions
checksum_mismatch
theme_id_mismatch
theme_already_installed
theme_not_found
built_in_theme_protected
active_theme_protected
active_theme_unknown
stale_repository_revision
operation_in_progress
storage_unavailable
permission_denied
disk_full
corrupt_installation
publication_failed
rollback_failed
cleanup_failed
unknown_io
```

```ts
export interface DesktopThemePackageError {
  readonly code: DesktopThemePackageErrorCode;
  readonly operationId?: string;
  readonly themeId?: string;
  readonly relativePath?: string;
  readonly retryable: boolean;
}
```

- IPC 不返回原始 `Error.message`、stack、绝对路径或 Node errno 文本；
- main log 可以记录 sanitized errno、operation ID 和相对路径，但不能记录 archive bytes、license
  内容、完整 manifest token 或用户目录；
- Web adapter 把 error code 映射为现有 `LingThemePackageIssue`/产品文案；
- blocking error 留在 Dialog/section InlineFeedback；成功和 cleanup warning 使用现有全局反馈合同；
- `rollback_failed` 和 corrupt active fallback 必须持续可见，不自动消失。

### 11.2 Request validation

- `ArrayBuffer` 必须是独立、非 `SharedArrayBuffer`，byteLength 在 `(0, 20 MB]`；
- `originalFileName` 只允许 basename，必须以 `.ling-theme` 结尾；
- request ID 是 1 至 80 个 ASCII `[A-Za-z0-9._-]`；
- theme ID 使用 shared `validateThemeManifest` 的 ID 规则和额外平台 reserved-name 规则；
- checksum 使用 lowercase SHA-256 hex；
- unknown fields 不影响 structural clone，但 parser 只读取 allowlist 字段；
- 不接收 destination、directory、filePath、URL、manifest override 或 `validated=true`。

## 12. IPC channels、sender 和 preload

`DESKTOP_IPC_CHANNELS` 精确新增：

```ts
themePackagesBootstrap: "ling-desktop:theme-packages:bootstrap"
themePackagesList: "ling-desktop:theme-packages:list"
themePackagesRead: "ling-desktop:theme-packages:read"
themePackagesInstall: "ling-desktop:theme-packages:install"
themePackagesReimport: "ling-desktop:theme-packages:reimport"
themePackagesDelete: "ling-desktop:theme-packages:delete"
themePackagesActiveSet: "ling-desktop:theme-packages:active-set"
```

全部使用 `ipcMain.handle` / `ipcRenderer.invoke`，不使用 fire-and-forget `send` 执行 mutation。

每个 handler 在解析 payload 前验证：

```text
mainWindow exists
event.sender.id === mainWindow.webContents.id
event.sender is not destroyed
event.senderFrame === event.sender.mainFrame
```

PiP renderer、subframe、stale/replaced main window、DevTools 和其他 BrowserWindow 都返回
`unauthorized_sender`。handler 不抛出可跨 IPC 泄漏的异常，所有业务/存储失败转换为 typed result。

`LingDesktopCapabilities` 新增：

```ts
readonly themePackages: {
  bootstrap(): Promise<DesktopThemePackageResult<DesktopThemePackageBootstrapValue>>;
  list(): Promise<DesktopThemePackageResult<readonly DesktopThemePackageDescriptor[]>>;
  read(request: { readonly themeId: string; readonly includePreviewBytes: boolean }):
    Promise<DesktopThemePackageResult<DesktopThemePackageReadValue>>;
  install(request: DesktopThemePackageArchiveRequest):
    Promise<DesktopThemePackageResult<DesktopThemePackageDescriptor>>;
  reimport(request: DesktopThemePackageReimportRequest):
    Promise<DesktopThemePackageResult<DesktopThemePackageDescriptor>>;
  delete(request: DesktopThemePackageDeleteRequest):
    Promise<DesktopThemePackageResult<{ readonly repositoryRevision: number }>>;
  setActive(request: DesktopThemePackageSetActiveRequest):
    Promise<DesktopThemePackageResult<{ readonly activeThemeId: string }>>;
};
```

preload 只做 invoke 和类型边界，不解析 archive、不生成路径、不捕获后伪造 success。Web declaration
必须与 shared capability 对齐，不能长期手写第二份不同合同。

## 13. Active theme 保护

main process 的 active guard 是删除保护，不取代现有 `ThemeSelection` 和 localStorage first-paint
snapshot。

1. repository 初始化后 `activeGuardReady=false`；
2. Desktop ThemeProvider bootstrap、resolve 并原子应用主题；
3. `DesktopThemeBridge` 对当前 resolved theme 调用 `themePackages.setActive()`；
4. main 只接受 built-in ID 或当前 valid native package ID；
5. 成功后 `activeGuardReady=true`；
6. delete 在 guard 未 ready 时返回 `active_theme_unknown`；
7. delete target 等于 active ID 时返回 `active_theme_protected`；
8. 删除 active local theme 时，ThemeProvider 先 apply matching `ling-light` / `ling-dark` fallback，
   `await setActive(fallbackId)` 成功后再 invoke delete；
9. delete 失败时恢复 previous selection，并再次 `await setActive(previousThemeId)`；
10. reimport active theme 成功后正常重新 resolve/apply；apply 失败时 repository 回滚旧包，ThemeProvider
    恢复旧 resolved theme；
11. renderer crash 后 guard 保留 main 最近确认值；新 renderer bootstrap 完成后覆盖；
12. main window 被替换时旧 sender 不能继续 mutate repository。

`setActive` 只接收 theme ID，不接收 CSS variables、路径或文件。现有 `appearance.reportTheme` 继续负责
PiP token snapshot；两个能力语义不同，不能合并为一个未确认成功的 `send`。

## 14. Web adapter 与 fallback

新增 repository factory，选择规则固定：

```text
window.lingDesktop?.themePackages has the complete capability
  -> DesktopThemePackageRepositoryAdapter
otherwise
  -> WebThemePackageRepositoryAdapter
```

规则：

- 选择只在 ThemeProvider 初始化时执行一次；
- Desktop capability 存在但 bootstrap/operation 失败：保留 Desktop adapter，显示 persistent storage
  failure；不得切到 IndexedDB；
- 普通 Web 不 import Desktop shared runtime code，只 import type；
- Web adapter 继续使用 IndexedDB v3，不修改已验证 transaction 语义；
- Desktop adapter install/reimport 发送 renderer review 使用的同一份 archive bytes；
- main 返回的 manifest/checksum 才是 publication result；adapter 不复用 renderer candidate 冒充结果；
- `read(includePreviewBytes=true)` 返回的 bytes 在 Web adapter 内转换为 Blob/object URL；URL 生命周期
  继续由现有 Preview controller 管理；
- Desktop bootstrap 返回 valid manifests 后才注册进 ThemeRegistry；
- corrupt record 不注册，只投影为 repair item；
- native package missing/corrupt 且当前 selection 指向它时，Registry 原子回退到同色 built-in，
  persistent warning 显示 Reimport/Delete；
- 不把 native bytes 复制回 IndexedDB；
- Desktop 旧 IndexedDB-only local theme 不自动合成或自动迁移。native bootstrap 不存在该 ID 时，
  将其投影为 `legacy_browser_only` repair item，要求用户使用原 `.ling-theme` 重新导入；如果它是当前
  selection，则先回退 built-in。重新导入成功后可删除同 ID 的 legacy IndexedDB 记录；
- binary rollback 到没有 capability 的旧 Desktop 时，旧 IndexedDB 仍保留；native-only 新主题在旧
  版本不可见，旧版本应回退 built-in，不删除 `userData/themes`。

Theme Studio 后续若发布 `local-generated`，必须通过同一个 repository port 和 main-side publication
validator；P7C.D 不实现该入口。

## 15. Corruption 模型

每个 descriptor 只有一个主 health：`ready` 或 `corrupt`。

以下任一发生即为 corrupt：

- metadata/schema 不能解析；
- theme ID 与目录名不一致；
- required file 缺失；
- extra file 或 symlink；
- path、size、checksum 或 MIME 不一致；
- manifest validation 失败；
- preview native decode 失败；
- unsupported storage schema。

处理：

- 不自动删除或覆盖 corrupt final；
- 不将 manifest 注册到 ThemeRegistry；
- list/bootstrap 返回 theme ID、record revision 和 sanitized issue code；
- read 不返回未经验证的 license/preview bytes；
- Reimport 允许同 ID 替换 corrupt item；
- Delete 允许删除 corrupt item，但仍执行 active guard 和 rename-to-trash；
- 当前 selection 指向 corrupt item时，立即回退到同色 built-in；
- 回退只改变外观，不刷新 workspace、不关闭 Dialog、不清空用户输入；
- 同一 corrupt revision 只显示一个 persistent owner，不同时出现页面 banner 和全局重复 Toast。

## 16. macOS 与 Windows 语义

### 16.1 共同规则

- 永远通过 `app.getPath("userData")` 获取根路径；
- 文档、代码、测试都不把真实用户目录硬编码为 production path；
- 文件名和 manifest 规则取两平台安全交集；
- case-fold duplicate 在所有平台都拒绝；
- symlink 在所有平台都拒绝；
- package root 与 staging/rollback/trash 必须同卷；
- Theme Pack 不写入 `.app`、DMG、Program Files、resources 或安装目录。

### 16.2 macOS

典型路径仅作为说明：`~/Library/Application Support/<app-name>/themes`。实现不拼接该字符串。

- APFS 默认大小写不敏感但可配置为敏感，repository 行为不能依赖该差异；
- file/dir fsync 可用时执行；parent directory fsync 不支持时记录 debug warning，不把已验证 publication
  误报失败；
- 不修改 quarantine、TCC、sandbox entitlement 或 app bundle；
- packaged gate 必须从实际 `.app`（DMG/ZIP 产物）运行，不使用 `electron .`。

### 16.3 Windows

典型路径仅作为说明：`%APPDATA%\\<app-name>\\themes`。实现不读取或拼接 `%APPDATA%`。

- 使用 `node:path`，拒绝 drive/UNC/alternate-data-stream 风格输入；
- 使用跨平台 reserved-name denylist；
- antivirus/indexer 导致的 `EPERM`/`EACCES`/`EBUSY` 只执行固定 3 次 bounded rename retry；
- directory fsync 不可用时允许跳过，候选文件 fsync 和 journal 仍必须执行；
- 不要求 Developer Mode，不创建 junction、shortcut 或 symlink；
- packaged gate 必须从实际安装后的 NSIS x64 应用运行，不使用 WSL、Wine 或浏览器 mock。

Linux 继续使用相同 repository 合同和 `app.getPath("userData")`，但不属于本 Function ID 的 release
verification gate。

## 17. 文件级写集合

实现只能在以下切片内写入。任何新增文件必须先确认没有并行 owner。

### P7CD-W1 Shared parser and contracts

新增：

- `packages/ui-react/src/theme/import/inspect-zip-central-directory.ts`
- `packages/ui-react/src/theme/import/parse-theme-package-bytes.ts`
- `packages/ui-react/src/theme/import/theme-image-validation.ts`
- `apps/desktop/shared/theme-package-capabilities.ts`

修改：

- `packages/ui-react/src/theme/import/package-types.ts`
- `packages/ui-react/src/theme/index.ts`
- `packages/ui-react/package.json`
- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/src/shared/ui/theme/package/web-theme-package-parser.ts`
- `apps/web/src/shared/ui/theme/package/web-theme-package-types.ts`

删除：

- `apps/web/src/shared/ui/theme/package/inspect-zip-central-directory.ts`

`fflate` 从 Web-only direct dependency 移到共享 parser owner `@ling-stack/ui-react`，Web 不保留第二份
ZIP parser。

### P7CD-W2 Native repository

新增：

- `apps/desktop/main/theme-packages/theme-package-paths.ts`
- `apps/desktop/main/theme-packages/theme-package-image-decoder.ts`
- `apps/desktop/main/theme-packages/theme-package-files.ts`
- `apps/desktop/main/theme-packages/theme-package-journal.ts`
- `apps/desktop/main/theme-packages/theme-package-repository.ts`
- `apps/desktop/main/theme-packages/theme-package-errors.ts`

每个 production file 目标 `<400` 行；repository composition 目标 `<600` 行。超过目标必须继续拆分，
不得把 journal、validation 和 cleanup 合回一个超大文件。

### P7CD-W3 IPC and preload

新增：

- `apps/desktop/main/theme-packages/theme-package-ipc.ts`

修改：

- `apps/desktop/shared/ipc-channels.ts`
- `apps/desktop/shared/desktop-capabilities.ts`
- `apps/desktop/preload/main-window.ts`
- `apps/web/src/desktop-capabilities.d.ts`
- `apps/desktop/main/main.ts`（仅 import、construct、initialize、register、dispose）

禁止修改 `apps/desktop/main/ipc.ts` 来承载本功能。

### P7CD-W4 Web repository adapter

新增：

- `apps/web/src/shared/ui/theme/package/theme-package-repository-port.ts`
- `apps/web/src/shared/ui/theme/package/web-theme-package-repository-adapter.ts`
- `apps/web/src/shared/ui/theme/package/desktop-theme-package-repository-adapter.ts`
- `apps/web/src/shared/ui/theme/package/theme-package-repository-factory.ts`
- `apps/web/src/shared/ui/theme/desktop-theme-active-bridge.ts`

修改：

- `apps/web/src/shared/ui/theme/package/index.ts`
- `apps/web/src/shared/ui/theme/package/web-theme-package-repository.ts`
- `apps/web/src/shared/ui/theme/web-theme-storage.ts`
- `apps/web/src/theme.tsx`（只接 port、bootstrap、rollback 和 repair projection）
- `apps/web/src/app/DesktopThemeBridge.tsx`
- `apps/web/src/features/settings/theme-packages/useThemePackageController.ts`
- `apps/web/src/features/settings/InterfaceThemeSettings.tsx`
- `apps/web/src/i18n/locales/en-US.ts`
- `apps/web/src/i18n/locales/zh-CN.ts`

UI 文件只允许增加 native storage/corruption repair 的既有组件组合，不新增新 IA 或大段技术说明。

### P7CD-W5 Tests and packaged evidence harness

新增：

- `packages/ui-react/test/theme-package-bytes.test.mjs`
- `apps/desktop/tests/theme-package-repository.test.mjs`
- `apps/desktop/tests/theme-package-ipc.test.mjs`
- `apps/desktop/tests/theme-package-fixtures.mjs`
- `apps/desktop/tests/run-theme-package-persistence-smoke.mjs`
- `apps/web/e2e/ui2-desktop-theme-package-persistence.spec.ts`

修改：

- `apps/desktop/package.json`
- `apps/desktop/tests/ipc.test.mjs` 仅保留现有 IPC aggregate regression；新详细场景进入新 spec
- `apps/web/e2e/ui2-settings-theme-packages.spec.ts` 仅补跨 adapter 不回退断言
- `apps/web/e2e/ui2-theme-registry.spec.ts` 仅补 native bootstrap/corrupt fallback

后续 closeout 才允许修改 coverage、migration、status、evidence metadata；本计划编写阶段不修改它们。

## 18. 任务、依赖、并行与权重

| Task ID | 任务 | 写集合 | 前置依赖 | 可并行性 | 当前状态 | 验证 | 权重 |
|---|---|---|---|---|---|---|---:|
| `P7CD-T00` | 冻结本零决策计划 | 当前文档 | 无 | 独立 | 已完成 | whitespace + links | 3% |
| `P7CD-T01` | 抽共享 bytes parser 与恶意包 fixtures | W1 | T00 | 可与 T02 并行，不能与 W4 并行 | 已完成 | ui-react `69/69` + typecheck/build + Web typecheck | 10% |
| `P7CD-T02` | 定义 typed contract、errors、channels | W1/W3 shared files | T00 | 可与 T01 并行；shared 文件单 owner | 已完成 | Desktop typecheck/build + contract unit `3/3` | 8% |
| `P7CD-T03` | 原生 repository、journal、recovery、mutex | W2 | T01/T02 | 不与其他 Desktop main 写入并行 | 已完成 | repository/recovery `21/21`；含 T02 contract `24/24`；Desktop typecheck/main build | 24% |
| `P7CD-T04` | IPC sender validation、preload capability、main 薄接线 | W3 | T02/T03 | 可与 Web adapter 在文件不交叉时并行 | 已完成 | capability/IPC/preload/main wiring `11/11` + Desktop typecheck/build | 10% |
| `P7CD-T05` | Web/Desktop repository adapters 与 factory | W4 shared adapter files | T01/T02 | T03 接口冻结后可与 T04 并行 | 已完成 | adapter matrix `6/6` + Web typecheck/build | 14% |
| `P7CD-T06` | ThemeProvider bootstrap、active guard、corrupt/legacy repair | W4 integration files | T03/T04/T05 | 文件交叉，单 owner | 已完成 | Desktop lifecycle + Theme Registry focused `13/13` | 10% |
| `P7CD-T07` | Repository/IPC/static 全矩阵 | W5 unit files | T03/T04 | unit specs 可分 agent，production 不再写 | 已完成 | repository/recovery + capability/IPC/preload `35/35` | 8% |
| `P7CD-T08` | Web adapter、Settings、rollback E2E | W5 Web specs | T05/T06 | 可与 T07 并行 | 已完成 | Desktop/Settings/adapter/Registry Playwright `24/24` | 5% |
| `P7CD-T09` | packaged macOS install/restart/recovery evidence | W5 harness/evidence | T07/T08 | 可与 Windows 在独立机器并行 | 已完成（arm64 packaged gate）；macOS 整体 `partial` | 真实 Apple Silicon macOS `19/19`；26 screenshots、14 logs、0 runtime errors、6 first-frame transitions；真实 Intel x64 仍为独立未关闭门禁 | 3% |
| `P7CD-T10` | packaged Windows install/restart/recovery evidence | W5 harness/evidence | T07/T08 | 可与 macOS 在独立机器并行 | 等待依赖 | 等待真实 Windows 11 x64 安装环境；Wine/WSL/browser fixture 不可替代 | 3% |
| `P7CD-T11` | 对账矩阵、状态和证据 metadata | docs/evidence closeout | T09/T10 | 最后单 owner | 部分对账 / 等待依赖 | arm64 artifact、日志、截图与 hash 已对账；完整 closeout 等待真实 Intel x64 和 Windows 11 x64 | 2% |

总权重：`100%`。

并行约束：

- 当前 `main.ts`、preload、Desktop shared IPC 文件已有大量未提交工作，P7C.D 实施前必须先确认这些
  owner 已收口；
- Desktop central files 只允许一个 agent 写；
- parser、repository tests、Web E2E 和两个真实平台证据可以在接口冻结后分给独立 agent；
- agent 完成后主 agent 必须统一检查 typed contract、error code、revision 和 adapter 选择是否一致；
- 不允许用并行效率为理由复制 parser、capability type 或 storage state。

## 19. 测试矩阵

### 19.1 Shared parser unit

必须覆盖：

- valid token-only package with/without preview/license；
- wrong extension、empty、oversize、malformed ZIP；
- ZIP64、multi-volume、encrypted、unsupported compression、trailing bytes；
- local/central mismatch、CRC mismatch、declared/actual size mismatch；
- absolute/drive/UNC/`..`/control/non-ASCII/duplicate-case paths；
- symlink、hardlink、special entry；
- blocked file type、extra file、unreferenced asset；
- invalid UTF-8、JSON、schema、tokens、contrast、reserved ID；
- runtime artwork、Presentation payload 和 remote reference；
- PNG/JPEG/WebP extension/magic/decode/dimensions mismatch；
- Web 与 Desktop decoder 对同一 fixtures 产生相同 normalized metadata。

### 19.2 Native repository Node unit

使用临时 root 注入，不使用真实用户目录：

- initialize empty root；
- install and final re-read；
- duplicate install；
- same-ID reimport and installedAt preservation；
- different-ID reimport rejection；
- expected checksum/revision conflict；
- inactive delete and trash cleanup；
- active/unknown guard rejection；
- corrupt item reimport/delete；
- concurrent install/reimport/delete serialization；
- duplicate request ID in-flight/result dedupe；
- write、fsync、rename、permission、disk-full injection；
- Windows bounded rename retry schedule；
- install failure leaves no final；
- reimport failure restores old final；
- rollback failure keeps journal and typed error；
- startup recovery for every journal phase；
- abandoned staging/trash cleanup；
- root/final/child symlink rejection and no-follow cleanup；
- metadata/path/size/checksum/MIME/schema corruption；
- cleanup pending returns success warning, not false failure。

### 19.3 IPC unit

- authorized main frame for every channel；
- wrong BrowserWindow、PiP、subframe、destroyed/stale main window；
- malformed request ID、filename、theme ID、checksum、revision；
- empty/oversize/SharedArrayBuffer-like payload rejection；
- no destination/path/URL field consumption；
- every repository error maps to stable result；
- no raw exception/path crosses preload；
- unregister removes every new handler；
- setActive allows built-in/valid package and rejects unknown/corrupt ID。

### 19.4 Web E2E

- normal Web still uses IndexedDB and never calls Desktop capability；
- complete Desktop capability selects native adapter；
- partial capability is treated unavailable, not partially invoked；
- Desktop operation failure does not fall back/write to IndexedDB；
- native bootstrap restores ThemePicker option；
- install/reimport/delete behavior matches P7C.1 UI；
- active delete applies and confirms built-in before native delete；
- fallback setActive failure prevents delete；
- corrupt selected theme falls back and shows one repair owner；
- corrupt reimport/delete works；
- native read returns Preview without exposing path；
- hard reload keeps native package；
- legacy IndexedDB-only package becomes reimport-required, not auto-migrated；
- Light/Dark、zh-CN/en-US、keyboard、reduced motion、console and overflow remain clean。

### 19.5 Static and build commands

```text
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop build
node --test apps/desktop/tests/theme-package-repository.test.mjs
node --test apps/desktop/tests/theme-package-ipc.test.mjs
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-theme-packages.spec.ts ui2-desktop-theme-package-persistence.spec.ts ui2-theme-registry.spec.ts settings.spec.ts dark-mode.spec.ts
```

若 package filter 实际名称不是 `@ling-stack/desktop`，执行前以 `apps/desktop/package.json` 的 `name`
为准替换命令；不得因此跳过 Desktop typecheck/build。

## 20. Packaged evidence gate

`DESKTOP-THEME-PACK-PERSISTENCE-001` 只有同时满足以下条件才可标记 `verified`。

### 20.1 macOS gate

- 运行 `package:mac` 生成的实际 `.app`，来源为 DMG 或 ZIP 产物；
- 至少在真实 Apple Silicon macOS 运行 arm64 candidate；x64 candidate 必须在真实 Intel macOS 或
  项目批准的独立 x64 runner 验证，Rosetta 结果只能标为 supporting；
- 使用临时 `--user-data-dir`，不污染开发者真实 profile；
- 完成 install -> quit -> restart -> list/read/preview/active first frame；
- 完成 same-ID reimport -> restart；
- 完成 inactive delete -> restart；
- 完成 active delete built-in fallback -> restart；
- 注入 abandoned staging、corrupt final、write/rename permission failure并验证 recovery；
- 记录 app version、commit、artifact SHA-256、OS/arch、userData test root、每步 result 和 screenshot/video。

当前结果：真实 Apple Silicon macOS arm64 sub-gate 已通过 `19/19`。自包含 evidence 目录为
`apps/desktop/release/evidence/theme-package-persistence/macos-arm64-20260726T151813Z`，其中有
`26` 张 screenshots、`14` 份 logs、`0` 个 runtime errors 和 `6` 次 first-frame transitions。artifact
ZIP、executable 与 `app.asar` SHA-256 分别为
`e4fe5020141eb6533f7819ffaace1c61b796a4f5c36cd8bf99642385fbbb312a`、
`997d6e26011b89344f98626987155158f13f492148f79bc00f24d841ae693b60`、
`da25639265ef2829d187b8851f7b6793d042649a05fdf2f4cc007e439dd32f6b`。candidate version 为
`0.0.0`，source HEAD 为 `0a0b80502715d0333342422e6dc8cedd2cd77b14`；工作树 dirty 且 candidate
未签名，因此不得作为正式发行物。

该结果只关闭 arm64 packaged sub-gate。真实 Intel macOS x64 尚未验证，完整 macOS packaged gate
仍为 `partial`；Rosetta、交叉构建、浏览器 fixture 或其他架构模拟都不能替代真实 Intel 证据。

### 20.2 Windows gate

- 运行 `package:win` 生成并实际安装的 NSIS x64 应用；
- 在真实 Windows 11 x64 执行，不使用 Wine、WSL 或 macOS browser fixture；
- 使用隔离测试 userData；
- 执行与 macOS 相同的 lifecycle；
- 额外覆盖 antivirus-style `EPERM/EACCES/EBUSY` bounded retry、case-fold conflict 和 reserved name；
- 记录 installer/app SHA-256、Windows build、artifact version、每步 result 和 screenshot/video。

当前结果：等待真实 Windows 11 x64 环境，gate 未关闭。Wine、WSL、macOS browser fixture、Web
fixture 和交叉构建均不接受为替代证据。

### 20.3 First-frame 证据

两平台都必须证明：

- 第二次启动在 Web 交互前完成 native repository bootstrap；
- localStorage selection/bootstrap snapshot 与 native manifest 一致时首帧直接使用目标主题；
- native package 缺失或 corrupt 时首帧使用同色 built-in，不出现黑闪、白闪或半主题；
- 首帧截图/视频包含 window chrome 和 AppShell，不能只截 ThemePicker；
- renderer-ready 后 ThemePicker、AppShell、PiP theme report 使用同一 resolved theme ID。

### 20.4 Evidence 路径

```text
docs/design/ui2.0升级/evidence/desktop/theme-package-persistence/
  macos-arm64/
  macos-x64/
  windows-x64/
  metadata.md
```

metadata 必须记录每个 artifact、图片和报告的 SHA-256，并由 verifier 复算。Web fixture、unit test、
dev Electron、`electron .`、Vite screenshot、IndexedDB hard refresh 和 PiP token snapshot 都只能作为
supporting evidence，不能关闭 packaged gate。

当前 arm64 大体积自包含证据保留在
`apps/desktop/release/evidence/theme-package-persistence/macos-arm64-20260726T151813Z`，不复制进
`docs`。轻量索引已写入
[`evidence/desktop/theme-package-persistence/metadata.md`](../../evidence/desktop/theme-package-persistence/metadata.md)；
T11 当前只能记录 arm64 部分对账，待真实 Intel x64 与 Windows 11 x64 证据齐全后才能完成跨平台汇总。

如果任一平台缺失，implementation slice 最多只能描述为 `implemented`；Canonical Function ID 必须保持
`inventory/partial`，不得标记 `verified`，总控完成度也不得按 verified 计权。

## 21. Deployment 与 rollback

### 21.1 Deployment

1. 先落 shared parser/contracts；
2. 落 native repository 和 tests；
3. 落 IPC/preload capability；
4. 落 Web adapter 和 integration；
5. 通过 Web/Desktop build 和 focused regression；
6. 生成 packaged candidates；
7. 先运行隔离 userData smoke，再运行完整 macOS/Windows gate；
8. 证据齐全后更新矩阵和状态。

repository schema 首版固定为 `1`。遇到未来未知 storage schema 只标记 incompatible/corrupt，不能尝试
降级解析或删除。

### 21.2 Binary rollback

- 回滚到旧 Desktop binary 时不删除 `userData/themes`；
- 旧 binary 没有 capability，会继续走已有 IndexedDB adapter；
- native-only theme 在旧 binary 不可见时回退 built-in；
- P7C.D 不迁移或清空 IndexedDB，因此旧版本仍可读取原有 Web records；
- 重新升级后 native repository 继续读取 schema v1；
- 不提供把原生主题自动反向复制到 IndexedDB 的 downgrade migration。

### 21.3 Operation rollback

- install failure：无 final；
- reimport failure：恢复 previous final；
- delete rename failure：final 保留；
- delete trash cleanup failure：逻辑删除成功，startup 继续 cleanup；
- native bootstrap failure：built-in 主题仍可用，Theme Settings 显示 persistent storage failure；
- main/repository fatal error 不得影响 daemon、workspace 数据或现有任务。

## 22. Large-file boundary

- `apps/desktop/main/main.ts` 已超过 1500 行，只允许不超过约 25 行的 import、construction、initialize、
  register 和 dispose 接线；
- `apps/desktop/main/ipc.ts` 不接收本功能代码；
- `apps/web/src/theme.tsx` 只接 repository port 和 transaction orchestration；新增主要逻辑必须进入
  focused adapter/helper；
- `useThemePackageController.ts` 不接 filesystem/IPC error matrix；
- 每个新 production owner 目标 `<400` 行，repository composition `<600` 行；
- 若 `main.ts` 需要 lifecycle helper，先新增 `apps/desktop/main/theme-packages/theme-package-runtime.ts`
  再薄接线，不得突破边界；
- 不向 `components.css`、`settings.css` 或其他超大 CSS 增加样式。本切片原则上不需要新视觉样式。

当前 large-file 风险仍存在，但 P7C.D 不扩大该风险。

## 23. 完成门禁

以下全部成立才算 P7C.D 完成：

- [x] 普通 Web 仍使用 IndexedDB v3；
- [x] Desktop 只使用 main-owned `userData/themes` repository；
- [x] capability 失败不静默回退 IndexedDB；
- [x] renderer 无法指定绝对路径、destination 或 file URL；
- [x] shared parser 和 main-side second validation 均存在；
- [x] archive/path/symlink/MIME/schema/checksum/size 验证全覆盖；
- [x] install、reimport、delete、startup recovery 和 cleanup 全覆盖；
- [x] active/unknown guard 阻止不安全删除；
- [x] corrupt selected theme 原子回退且保留修复入口；
- [x] concurrent mutation、stale checksum/revision 和 duplicate request 被测试；
- [x] Desktop repository、IPC、preload、Web adapter 类型一致；
- [x] unit、IPC、Web E2E、typecheck 和 build 全绿；
- [x] packaged macOS arm64 sub-gate 在真实 Apple Silicon 上通过 `19/19`；
- [ ] packaged macOS x64 sub-gate 在真实 Intel macOS 或项目批准的独立真实 x64 runner 通过；
- [ ] 完整 packaged macOS gate 通过（arm64 与真实 Intel x64 均具备）；
- [ ] packaged Windows gate 通过；
- [x] arm64 first-frame transitions 与 packaged lifecycle 证据复验通过；
- [ ] macOS x64 与 Windows first-frame 无黑闪/白闪/半主题证据通过；
- [x] arm64 自包含 evidence artifact/log/screenshot/hash 复验通过；
- [ ] 跨平台 evidence metadata/hash 复验通过；
- [x] arm64 coverage、Desktop migration、E2E matrix、status board 和总控在证据之后完成部分对账；
- [ ] Intel macOS x64 与 Windows 11 x64 证据完成后执行最终跨平台对账；
- [ ] Function ID 从当前 `inventory/partial` 变为 `verified`，而不是由 arm64 或 Web fixture 提前升级。

## 24. Hard stops

- 发现 Desktop central files 有并行 owner 时停止写这些文件，先重新分配无交叉任务；
- 发现 repository root 或 package child 是 symlink 时停止原生主题操作；
- 发现跨卷 rename 时停止，不 copy fallback；
- 发现现有 active theme 无法被 main 确认时拒绝 delete；
- 发现 main 与 renderer checksum 不一致时拒绝 publish；
- 发现 Windows rollback 无法恢复时保留 journal/backup 并报告 `rollback_failed`；
- 发现任一平台只有 browser fixture 时保持 `implemented`，不能声称 `verified`；
- 不因 Theme Studio D3 未决而暂停 P7C.D；
- 不因 P7C.D 需要原生持久化而顺手实现 runtime artwork 或 AI Theme Studio。

## 25. 当前 closeout 快照

| 范围 | 状态 | 关闭依据 / 剩余依赖 |
|---|---|---|
| T01-T08 implementation 与 focused regression | 已完成 | 任务表所列 unit、IPC、E2E、typecheck 与 build 证据 |
| T09 Apple Silicon macOS arm64 packaged sub-gate | 已完成 | 真实 macOS arm64 `19/19` 与自包含 evidence bundle |
| macOS packaged gate | `partial` | 仍需真实 Intel macOS x64；Rosetta 与 browser fixture 不接受 |
| T10 Windows packaged gate | 等待依赖 | 仍需真实 Windows 11 x64；Wine、WSL 与 browser fixture 不接受 |
| T11 closeout | 部分对账 / 等待依赖 | arm64 已对账；最终矩阵、metadata 和状态升级等待 Intel 与 Windows |
| `DESKTOP-THEME-PACK-PERSISTENCE-001` | `inventory/partial` | 两个平台的全部真实 packaged gate 未齐，禁止标记 `verified` |

当前实现可以描述为“implementation 已落地、Apple Silicon packaged sub-gate 已验证、跨平台 closeout
未完成”。不得把 `19/19` 扩大解释为完整 macOS gate、Windows gate 或 Function ID verified。

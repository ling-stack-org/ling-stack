# Desktop 本地开发候选包

本文说明如何准备 macOS Apple Silicon 和 Windows x64 的本地开发候选。
命令以 `49554b07652c4311fade8ec8dee858dd364b85fe` 为基线核对，并包含本轮对 Electron Builder 启动方式的修复；
构建时必须选取包含该修复的已审核提交。这份文档不代表已在 Windows 执行或验收。
候选包只用于本机工程验证，不自动上传、创建 Release 或晋级为正式发行版。

## 转给 Windows 同事的短版

1. 在 **Windows x64** 测试机/虚拟机上准备 Git、x64 Node **22.22.1**、Corepack/pnpm **10.0.0**、
   Rust **1.97.1 MSVC**、VS Build Tools 的 **C++ 与 Windows SDK**、**.NET 8 SDK**。
2. 维护者提供已审核的 tag 或完整 SHA；新建干净 checkout，固定到它，不直接拿移动中的 `main`。
3. 在 x64 Developer PowerShell 中依次运行 `corepack pnpm install --frozen-lockfile`、
   `corepack pnpm build`、`corepack pnpm --filter @ling-stack/desktop package:win`。
   用下方完整模板逐步检查退出码；失败就停，回传首个错误和脱敏日志。
4. 检查本次 `Ling-Stack-<version>-windows-x64-setup.exe`，记录源码 SHA 与文件 SHA-256。
   在测试账号中实际完成 **安装 → 启动 → 真实模型任务 → 退出重启 → 系统重启 → 卸载**，保存结果和脱敏截图。
5. 回传安装包、SHA-256、工具版本、各项 `PASS / FAIL / BLOCKED`。
   这是本地未签名开发候选，不需要 Wine；默认不含 bundled Cua Driver，不能宣称已完成正式发布或 Computer Use 验收。

## 签名与账号边界

- macOS 本地开发可以使用 ad-hoc identity `-`，不需要 Apple Developer 账号。
  本仓库的 `unsigned_dev` Mac 通道实际会做 ad-hoc 签名；“unsigned”表示没有发行者证书，不能理解为完全没有代码签名。
- ad-hoc 签名和 `codesign --verify` 通过，只能说明包的本地代码签名结构通过验证。
  它们不能提供 Developer ID 发行者身份，也不能替代公证或 Gatekeeper 验收。
- 面向其他用户分发的 Developer ID 包需要 Apple Developer Program、Developer ID 证书和公证流程。
  Apple 的说明见 [Developer ID](https://developer.apple.com/developer-id/) 和
  [在 Mac 上安全地打开 App](https://support.apple.com/en-us/102445)。
- Windows 的 `unsigned_dev + development` 候选不需要代码签名证书，不能声称具有 Authenticode 发行者身份或已通过 SmartScreen 发布验收。
  本文不要求 Wine，也不要求关闭 Gatekeeper、SmartScreen、Defender 或其他系统安全设置。

正式分发与签名验收另见 [Desktop 发布验收手册](desktop.md) 和
[第三方声明的分发边界](../../THIRD_PARTY_NOTICES.md#binary-distribution-boundary)。

## macOS Apple Silicon

前提是原生 arm64 Mac、Node.js **22.22.1 或更新版本**、Corepack 管理的 pnpm **10.0.0**、
Xcode Command Line Tools，以及已安装的 Rust **1.97.1**。
Office 原生打包还需要经过独立审核的本机编译器、macOS SDK、Node headers 和源码输入。
源码构建不需要 Developer ID 账号。

### 机器绑定的独立审查前置

标准 `package:mac` 固定执行 `package-macos-with-office.mjs`，只接受
`darwin + arm64 + unsigned_dev`，使用默认 ad-hoc signer，并拒绝同时打入 Cua Driver provider。
它要求 `native/office-local/reviewed-packaged-source-v1.json`；上述历史基线没有这个文件，
因此当时干净 checkout 的标准打包会遇到 `packaged_office_native_source_review_missing`。
2026-10-12 开发候选补齐了有限范围的独立审查，见
[审查记录](../../native/office-local/reviewed-packaged-source-v1-review.md)。该记录绑定本次实际
Darwin 25.6.0、Electron 44.5.1 和本机工具链，不是任意机器或后续源码的通用批准。

这个记录绑定审核过的编译器、SDK、headers、Office 源码和打包源码摘要。
**不能用成功构建、测试结果或自动生成的摘要替代独立审核，也不能为了让打包通过而生成或批准该记录。**
Mac 打包 hooks 同样要求本次进程内的原 Office publication；直接调用 Electron Builder 不构成受支持的绕过路径。
签名前还必须准备 `apps/desktop/dist/distribution` 中的实际第三方原文、来源索引和 SBOM，
并复核最终 App、ZIP、DMG 内的资源。Builder 的缺失资源警告不能代替分发材料验收。

### 标准命令

先选定已审核的 tag 或完整 commit SHA，在独立干净 checkout 中工作。
以下命令只有在 Office review 已由维护者完成、且对应当前源码与本机工具链时才进入打包步骤：

```bash
set -e
corepack pnpm install --frozen-lockfile
corepack pnpm build

if [ ! -f native/office-local/reviewed-packaged-source-v1.json ]; then
  echo "Blocked: packaged_office_native_source_review_missing"
  exit 1
fi

LING_CUA_SIGNING_TIER=unsigned_dev \
LING_CUA_DISTRIBUTION_CHANNEL=development \
LING_CUA_DRIVER_PACKAGE_PROVIDER=0 \
CSC_IDENTITY_AUTO_DISCOVERY=false \
corepack pnpm --filter @ling-stack/desktop package:mac
```

使用没有遗留 provider source-build 或发布签名环境变量的独立构建 shell。
记录源码 SHA、Node/pnpm/Rust/CLT 版本和完整构建日志；离线 Rust 构建所需的依赖缓存也必须已具备。
脚本可能下载 Electron 或打包工具，不能把“无需签名账号”理解为无需网络或构建依赖。

成功后应检查 `apps/desktop/release/` 中本次生成的 arm64 `.app`、DMG 和 ZIP，
逐一记录 SHA-256，验证 DMG/ZIP 完整性及解包后的 `codesign --verify --deep --strict`。
随后在测试账号中验证安装、启动、真实模型任务、退出重启和卸载。
这些结果仍只属于本地 ad-hoc 候选，不代表公证、Gatekeeper 或完整 clean-machine 发布验收。

若只需源码开发运行，可在 workspace 构建后执行：

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

开发运行不经过上述 Office 安装包 review 流程，也不能替代 DMG/ZIP 验收。

## Windows x64：同事执行清单

Windows 的完整构建与验证应在真实 Windows x64 主机或 Windows x64 虚拟机中进行。
仓库的 `package:win` 按宿主构建 Browser Host 和 OfficeDriver；在 Mac 上调用它会先得到 Mac 原生资源，
不能据此认定已生成完整可运行的 Windows 候选。

### 1. 准备工具与测试环境

- Git；x64 Node.js 最低版本为 **22.22.1**，首次候选建议固定使用 22.22.1，记录实际版本。
- Corepack 和仓库固定的 pnpm **10.0.0**。
- Rust 的 **MSVC** 工具链；首次候选固定使用 `1.97.1-x86_64-pc-windows-msvc`。
  Browser Host 脚本会以当前工具链执行 `cargo build --release --locked`，模板通过 `RUSTUP_TOOLCHAIN` 固定这次构建版本。
- Visual Studio Build Tools：Desktop development with C++、MSVC x64/x86 工具和 Windows SDK。
  在可找到 `cl.exe` 的 x64 Developer PowerShell 中构建。
- **.NET 8 SDK**；OfficeDriver 使用 `net8.0-windows`，打包脚本通过
  `dotnet publish --runtime win-x64 --self-contained true` 生成本机 driver。
- 可访问 npm、Rust registry、NuGet 和 Electron/打包工具下载地址。
- 独立测试用户或 Windows 虚拟机，以及自己的测试模型配置；不要用已有生产工作区验收。

工具应事先安装完成。仓库命令不会替代 VS C++/SDK 或 .NET 的安装。
不需要配置代码签名账号，不需要 Wine。
当前打包封装用 Node 直接启动已安装的 Electron Builder CLI，避免在子进程中直接执行 Windows `.cmd` shim。
这修复了启动方式，但仍须由 Windows 同事实际构建和验收。

### 2. 固定源码、安装依赖、构建和打包

下面是**待执行模板**。目前本文没有指定已创建的发布 tag；维护者应先提供已审核的 tag 或完整 commit SHA，
再替换 `$ReleaseRef`。不要用会继续移动的 `main` 作为验收输入。
每个 native 命令都检查退出码；失败后停止，不删除 lockfile、不修改版本、不跳过保护检查来继续打包。

```powershell
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string]$Program, [string[]]$ArgumentList)
    & $Program @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed with exit code $LASTEXITCODE"
    }
}

$RepositoryUrl = 'https://github.com/ling-stack-org/ling-stack.git'
$ReleaseRef = 'REPLACE_WITH_REVIEWED_TAG_OR_FULL_COMMIT_SHA'
if ($ReleaseRef.StartsWith('REPLACE_')) {
    throw 'Replace ReleaseRef with the maintainer-reviewed tag or full commit SHA.'
}
$CheckoutRoot = Join-Path $PWD 'ling-stack-candidate'
Invoke-Checked 'git' @('clone', $RepositoryUrl, $CheckoutRoot)
Set-Location $CheckoutRoot
Invoke-Checked 'git' @('fetch', '--tags', 'origin')
Invoke-Checked 'git' @('checkout', '--detach', $ReleaseRef)
$CandidateCommit = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve candidate commit.' }
if ($CandidateCommit -notmatch '^[0-9a-f]{40}$') { throw 'Invalid candidate commit.' }
$SourceStatus = @(& git status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect checkout.' }
if ($SourceStatus.Count -ne 0) { throw 'Candidate checkout must be clean.' }

Invoke-Checked 'node' @('--version')
$NodePlatform = (& node -p 'process.platform + ":" + process.arch').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Node platform.' }
if ($NodePlatform -ne 'win32:x64') { throw 'Use x64 Node on Windows for this candidate.' }
$NodeVersion = (& node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Node version.' }
if ([version]$NodeVersion -lt [version]'22.22.1') { throw 'Node 22.22.1 or newer is required.' }
Invoke-Checked 'corepack.cmd' @('pnpm', '--version')
$PnpmVersion = (& corepack.cmd pnpm --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect pnpm version.' }
if ($PnpmVersion -ne '10.0.0') { throw 'Use the repository-pinned pnpm 10.0.0.' }
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw 'Use x64 Developer PowerShell with MSVC and Windows SDK installed.'
}
$env:RUSTUP_TOOLCHAIN = '1.97.1-x86_64-pc-windows-msvc'
Invoke-Checked 'rustup' @('run', $env:RUSTUP_TOOLCHAIN, 'rustc', '-vV')
Invoke-Checked 'dotnet' @('--list-sdks')
$DotnetSdks = @(& dotnet --list-sdks)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect .NET SDKs.' }
if (-not ($DotnetSdks -match '^8\.')) { throw '.NET 8 SDK is required.' }

# Use a fresh shell without provider source-build or signing credential variables.
$env:LING_CUA_SIGNING_TIER = 'unsigned_dev'
$env:LING_CUA_DISTRIBUTION_CHANNEL = 'development'
$env:LING_CUA_DRIVER_PACKAGE_PROVIDER = '0'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
Invoke-Checked 'corepack.cmd' @('pnpm', 'install', '--frozen-lockfile')
Invoke-Checked 'corepack.cmd' @('pnpm', 'build')
Invoke-Checked 'corepack.cmd' @('pnpm', '--filter', '@ling-stack/desktop', 'package:win')

$ReleaseRoot = Join-Path $CheckoutRoot 'apps/desktop/release'
$Installers = @(Get-ChildItem $ReleaseRoot -File -Filter 'Ling-Stack-*-windows-x64-setup.exe')
if ($Installers.Count -ne 1) { throw 'Expected exactly one fresh Windows x64 installer.' }
$MainExe = Join-Path $ReleaseRoot 'win-unpacked/Ling Stack.exe'
$BrowserHost = Join-Path $ReleaseRoot 'win-unpacked/resources/browser-host/ling-browser-host.exe'
$OfficeDriver = Join-Path $ReleaseRoot 'win-unpacked/resources/office-driver/win32-x64/ling-office-driver.exe'
foreach ($CandidateFile in @($Installers[0].FullName, $MainExe, $BrowserHost, $OfficeDriver)) {
    if (-not (Test-Path -LiteralPath $CandidateFile -PathType Leaf)) {
        throw "Missing candidate file: $CandidateFile"
    }
}
foreach ($CandidateFile in @($Installers[0].FullName, $MainExe)) {
    if ((Get-AuthenticodeSignature -LiteralPath $CandidateFile).Status -ne 'NotSigned') {
        throw 'This checklist expects an unsigned development candidate; inspect unexpected signing separately.'
    }
}
Get-FileHash -Algorithm SHA256 -LiteralPath $Installers[0].FullName, $MainExe, $BrowserHost, $OfficeDriver
Write-Output "Candidate source commit: $CandidateCommit"
```

请保留命令输出和构建日志，将 candidate 源码 SHA、工具版本、文件名与 SHA-256 一起交给维护者。
若安装、编译或打包失败，提供首个失败命令、退出码及已脱敏日志，停止在失败处。
只有 Installer 存在或 NSIS 打包退出成功，不足以证明应用能运行。

### 3. 真机人工验收与回传

1. 在独立测试账号/虚拟机中，记录 Windows 版本、x64 架构、源码 SHA 和待安装文件 SHA-256。
2. 按当前用户安装，验证程序目录、图标、开始菜单入口及正常启动；不关闭系统安全功能。
   若系统策略阻止安装，记录提示并停在阻断处，由维护者决定下一步，不强行绕过。
3. 使用测试项目和自己的模型配置完成一次真实模型任务，检查回复、任务状态及实际结果。
   若验证文件工具，再在临时工作区做一次受支持的文件任务；截图和日志不得包含密钥或私人数据。
4. 正常退出后重启应用，确认项目、会话和配置恢复；再测试系统重启后的启动。
5. 若验收 Chrome 扩展，单独验证 Windows Browser Host 与扩展连接、应用重启后的恢复。
   Office 文档应用互操作需要对应本机应用，不以 driver 文件存在替代实际操作验收。
6. 卸载，确认应用进程退出，以及 Ling 自己的 Chrome/Chromium Native Messaging 注册表项和 manifest 清理。
   记录用户数据保留情况；不手动删除已有工作区或其他 Host 的数据。
7. 回传 `PASS / FAIL / BLOCKED`，附安装、启动、模型任务、重启、卸载各项结果与脱敏截图/日志。
   本轮执行方仍须记录哪些步骤没有运行，不能把 Mac 静态检查写成 Windows 实测。

默认候选没有 bundled Cua Driver provider。Computer Use、锁屏控制、Windows 多显示器/DPI、
辅助功能、正式签名和 SmartScreen 等能力须按各自的真实验收边界另行验证，不能从基本启动与模型任务推导通过。

## 本轮收尾边界

CI 额度、主分支保护和安全报告入口按当前维护安排暂缓；本文不配置或自动修改这些在线设置。
候选文件保留在本地，不自动上传、不创建 tag 或 GitHub Release，也不宣称正式签名发布。
公开安装包前还需完成实际包内容的第三方 notices/SBOM 和对应平台分发验收。

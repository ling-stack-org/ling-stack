# Desktop Theme Pack Persistence Release Plan（已停用）

Status: retired by the 2026-10-23 official-only theme decision; historical implementation reference only
Owner: Theme system, Desktop and release maintainers
Last verified: 2026-08-03；当前产品不再提供主题包导入、修复或 Theme Studio 入口
Document type: protected platform implementation plan

## Owning Contracts

- [Settings UI2 Contract](README.md)
- [Theme Product Model](../../themes/01-独立主题包产品模型.md)
- [Theme Schema And Token Contract](../../themes/02-主题包Schema与Token合同.md)
- [Theme Resource Safety](../../themes/05-主题资源导入与安全.md)
- [Desktop Release Checklist](../../release/01-Desktop跨平台发布验收清单.md)

## Current Boundary

当前产品决策已改为只提供官方内置主题。本计划描述的 `.ling-theme` 原生发布、重导入、删除和修复不再是产品能力；仅保留历史兼容参考，不能作为当前开发依据。

Theme package parsing, validation, Web storage, Desktop native repository, journaled
publish/delete/reimport, startup bootstrap, first-frame resolution, IPC capabilities and
corrupt-package fallback are implemented. Apple Silicon packaged behavior has been
verified as a partial platform gate.

The function remains `partial`: real Intel macOS x64 and Windows 11 x64 packaged gates are
open. Browser fixtures, cross-builds, Rosetta, Wine and WSL cannot close them.

## Native Storage Contract

- Desktop owns native package bytes, manifests, artwork and journals under its user-data
  root; the renderer receives typed snapshots and errors only.
- Import, reimport, delete and recovery are serialized per package id.
- Publish uses staging, validation and atomic promotion; interrupted work is reconciled on
  startup.
- Active-package deletion falls back to a built-in theme before removing native data.
- Corrupt, incomplete or checksum-mismatched packages never enter the active registry.
- Web and Desktop adapters implement one repository contract without sharing browser or
  filesystem internals.

## Open Packaged Gates

### Intel macOS x64

- build and run an actual x64 packaged application on Intel hardware;
- verify import, restart, reimport, delete, corrupt recovery and first-frame theme;
- validate window chrome, AppShell and compact Desktop renderers;
- capture signed release evidence through the release pipeline.

### Windows 11 x64

- install and run the packaged x64 application on Windows 11;
- cover import/restart/reimport/delete and first-frame resolution;
- cover `EPERM`, `EACCES`, `EBUSY`, case-fold and reserved-name failures;
- verify rollback, antivirus-style interference and installer lifecycle.

### Cross-Platform Closure

- reconcile both platform results in the Desktop release checklist;
- verify artifact, source and signature provenance through independent tooling;
- keep evidence in CI or Release artifacts, not under `docs/design`;
- mark the function verified only after both required platform gates pass.

## Safety And Recovery Invariants

- Theme packages contain data and approved local artwork only, never executable code,
  arbitrary CSS, DOM or remote runtime resources.
- Paths are normalized and confined before any write or extraction.
- The selected theme cannot point to an unpublished or corrupt native package.
- Startup recovery is bounded and never leaves a half-published package visible.
- Theme failure cannot alter business state, routing, permissions, provider authority or
  workspace data.
- First-frame fallback uses a built-in compatible theme without black/white flash or mixed
  token state.

## Verification

- Shared parser and schema fixtures cover malformed, oversized and hostile packages.
- Desktop tests cover repository, journal, IPC, bootstrap, recovery and concurrent intent.
- Web tests cover adapter selection, Settings actions, rollback and active-theme guards.
- Packaged target-platform evidence covers real restart and first-frame behavior.

## Closure

Close only after Intel macOS x64 and Windows 11 x64 packaged gates pass. Move final status
to the Desktop release checklist, retain the long-lived contracts, and delete this plan.

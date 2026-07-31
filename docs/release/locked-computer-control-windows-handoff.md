# Windows Locked-Surface Denial Evidence Handoff

> **Historical security evidence, not a feature-enablement plan.** The current product
> policy is [Lock-Aware Task Continuation](../design/locked-computer-control-policy.md): tasks
> continue, Computer Control pauses, and a fresh normal generation may recover only after
> unlock. Windows acceptance no longer needs to prove positive locked input.

## Verdict boundary

This handoff retains the Windows x64 native helper source, deterministic build/signing
command and content-free WTS/Winlogon/UAC/Session-0 denial probes. It does **not** enable
locked Computer Control and it does not authorize the macOS owner or CI to report Windows
real-machine acceptance.

The current helper deliberately returns negative capture/input/secure-surface attestation.
The product policy therefore remains `disabled_by_build`. A successful run below means only
that the current fail-closed boundary was observed on that Windows machine.

Windows acceptance ownership remains with the Windows team. Do not convert any handoff
report to `supported_restricted`; the retained reports are negative boundary evidence only.
A future positive locked-control proposal must begin with a new product/security design.

## Prerequisites

- Dedicated Windows 11 x64 physical machine or VM in an interactive local user session.
- Visual Studio 2022 x64 Native Tools Command Prompt, MSVC C++20 and Windows SDK 10.0.26100
  or the repository's current locked successor.
- Standard Medium-IL user session for Baseline, LockCycle, WtsDisconnect and UacDenial.
- An approved internal Authenticode certificate for signed handoff. Do not generate or
  silently trust a simulated product certificate.
- Sysinternals PsExec only for the explicit Session-0 denial test. PsExec's temporary service
  is a test harness, never an installed Ling component.

No command records a username, SID, password, PIN, biometric data, screen pixels or input
contents. The report contains only platform facts, booleans, hashes, signature identity and
timestamps.

## 1. Build and sign

From an x64 Native Tools Command Prompt at the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File apps\desktop\scripts\build-locked-control-native-helper.ps1 `
  -CertificateThumbprint "<approved-certificate-thumbprint>" `
  -RequireSigned
```

For code-only compilation before an approved certificate is available, omit
`-CertificateThumbprint` and `-RequireSigned`. That output is explicitly unsigned and cannot
close a signing or product gate. Save the emitted SHA-256 and use it as
`<expected-helper-sha256>` in every probe below.

## 2. Unlocked WTS/default-desktop baseline

Run from a normal, unlocked local desktop:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File apps\desktop\scripts\test-locked-control-win32-handoff.ps1 `
  -Mode Baseline `
  -RequireSigned `
  -ExpectedSha256 "<expected-helper-sha256>" `
  -Output "C:\ling-locked-control-evidence\baseline.json"
```

Expected result: WTS session active, input desktop `Default`, Medium IL, content-free session
digest valid and locked attestation still negative.

## 3. Winlogon lock denial

The next command locks Windows. Leave it locked for at least five seconds, then unlock it
normally. Do not enter credentials through Ling or the harness.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File apps\desktop\scripts\test-locked-control-win32-handoff.ps1 `
  -Mode LockCycle `
  -RequireSigned `
  -ExpectedSha256 "<expected-helper-sha256>" `
  -Output "C:\ling-locked-control-evidence\winlogon-denial.json"
```

Expected result: the helper observes `sessionActive=false` and `sessionLocked=true` while
Winlogon owns the input desktop, then observes the same logon-session digest after unlock.

## 4. WTS disconnect denial

This command disconnects the current WTS session. Reconnect to the same session and unlock
within ten minutes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File apps\desktop\scripts\test-locked-control-win32-handoff.ps1 `
  -Mode WtsDisconnect `
  -RequireSigned `
  -ExpectedSha256 "<expected-helper-sha256>" `
  -Output "C:\ling-locked-control-evidence\wts-disconnect-denial.json"
```

Expected result: disconnected WTS state is denied, and reconnecting does not silently change
the bound logon-session digest. A different digest is evidence of a user/session switch, not
a passing continuity result.

## 5. UAC secure-desktop denial

The harness starts a harmless elevated `cmd /c exit 0` request while a background worker
samples only session booleans. Keep the UAC prompt visible for at least five seconds, then
select **No**.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File apps\desktop\scripts\test-locked-control-win32-handoff.ps1 `
  -Mode UacDenial `
  -RequireSigned `
  -ExpectedSha256 "<expected-helper-sha256>" `
  -Output "C:\ling-locked-control-evidence\uac-denial.json"
```

Expected result: at least one sample observes the non-default secure input desktop as denied.
If Windows is configured to show UAC on the ordinary user desktop, the gate fails; do not
reinterpret that policy weakening as support.

## 6. Session-0 denial

Run only from an elevated test shell with the reviewed Sysinternals PsExec binary. This
command may create PsExec's temporary test service; confirm it is removed after the command.
It must never be part of Ling Setup, app startup or CI installation.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File apps\desktop\scripts\test-locked-control-win32-handoff.ps1 `
  -Mode SessionZeroDenial `
  -PsExecPath "C:\Sysinternals\PsExec64.exe" `
  -RequireSigned `
  -ExpectedSha256 "<expected-helper-sha256>" `
  -Output "C:\ling-locked-control-evidence\session-zero-denial.json"
```

Expected result: the helper running in Session 0 reports `sessionActive=false` and
`sessionLocked=true`.

## 7. Review and hand back

Return the four/five JSON files, exact helper SHA-256, Authenticode certificate thumbprint,
Windows build number and any failed command output to the Windows owner. Do not include
screenshots of a lock/UAC screen, credentials, user identifiers or raw desktop contents.

The current handoff is complete when:

- signed helper build and all denial probes execute on Windows x64;
- every report remains content-free and states `productCapability=disabled_by_build` and
  `acceptance=handoff_probe_only`;
- Windows owner records PASS/FAIL for the denial harness without changing the product flag;
- failures leave the feature Off and are fixed without adding a service, UIAccess,
  credential provider or secure-desktop bypass.

## Unresolved decisions

There are no unresolved implementation decisions in this handoff. Native feasibility for
positive locked capture/input is deliberately unresolved evidence; deferring it means the
Windows product feature remains Off.

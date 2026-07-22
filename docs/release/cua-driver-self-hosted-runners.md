# Cua Driver Self-Hosted Native Runners

This path exists for locked native evidence when GitHub-hosted macOS or Windows minutes
are unavailable. It does not weaken the provider lock, replace Windows VM acceptance, or
turn a local build into release evidence.

The entrypoint is the existing `Desktop artifacts` workflow. Dispatch it with:

- `execution_mode=self-hosted-native`;
- `native_platform=macos`, `windows`, or `both`;
- `expected_commit=<the exact 40-character commit selected as the workflow ref>`.

`self-hosted-native` is the manual form default. Pull-request and push events leave all
native artifact jobs skipped, so an exhausted GitHub-hosted billing account cannot create
an immediate failed hosted matrix. `github-hosted` remains an explicit manual fallback
after hosted billing is restored.

The caller skips every GitHub-hosted job in this mode and invokes
`cua-driver-self-hosted-native.yml` from the same immutable commit. Pull requests and
pushes cannot select self-hosted mode. The called workflow also rejects any event other
than `workflow_dispatch`, a different repository, a different actor/triggering actor,
or a commit that differs from `expected_commit`.

## Runner identities

The reviewed identities live in `.github/cua-driver-self-hosted-runners.json`.

| Platform | Runner name and only custom label | Runner root | Launch mode | Locked native tools |
| --- | --- | --- | --- | --- |
| macOS ARM64 | `ling-cua-driver-macos-arm64-v1` | `/Users/tianxiao/.github-actions/ling-cua-driver-macos-arm64-v1` | interactive Aqua login session | actions/runner 2.336.0, Xcode 26.6 build 17F113, macOS SDK 26.5, Rust 1.97.1, arm64 + x86_64 targets |
| Windows x64 | `ling-cua-driver-windows-x64-v1` | `C:\actions-runner` | Windows service | actions/runner 2.336.0, VS 17.14.37502.11, MSVC 14.44.35211, Windows SDK 10.0.26100.0, Rust 1.97.1 |

Both runners use `--no-default-labels`. A generic `self-hosted`, `macOS`, `Windows`,
`ARM64`, or `X64` job therefore cannot select them. They are repository-scoped and must
not be shared with a public repository.

The runner version is pinned with `--disableupdate`. Update the manifest, installer
digest, verification tests, and both hosts together within 30 days of a new runner
release, or sooner for a critical runner security update.

## macOS registration

The current Mac runner is registered at the reviewed root. It must execute native evidence
from a logged-in Aqua terminal with `./run.sh`; `svc.sh start` is forbidden for this lane.
The GitHub LaunchAgent sets `ACTIONS_RUNNER_SVC=1` and its job descendants do not retain
the graphic-session capability needed by the upstream cursor integration tests. The
checked-in verifier rejects that mode before source acquisition or compilation.
The official `actions-runner-osx-arm64-2.336.0.tar.gz` digest is:

```text
8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079
```

The source-build workflow uses `/Applications/Xcode.app/Contents/Developer` and verifies
the exact Xcode build and SDK before acquiring or compiling provider source. Do not use a
symlinked developer directory or silently fall back to Command Line Tools.

Start the reviewed interactive runner immediately before dispatch:

```bash
cd ~/.github-actions/ling-cua-driver-macos-arm64-v1
./svc.sh stop
./run.sh
```

Keep that terminal and the logged-in Aqua session alive until the build and promotion jobs
finish. Stop the interactive runner with `Ctrl-C`; do not restart the LaunchAgent for native
evidence.

## Windows registration handoff

Run these steps on the dedicated Windows x64 machine from an elevated PowerShell prompt.
Obtain the one-hour registration token from repository **Settings → Actions → Runners →
New self-hosted runner** immediately before configuration. Never put that token in a
script, evidence bundle, issue, or chat.

1. Install the locked Visual Studio, MSVC, Windows SDK and Rust versions shown above.
2. Download `actions-runner-win-x64-2.336.0.zip` from the official `actions/runner`
   release and require this SHA-256 before extraction:

   ```text
   d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162
   ```

3. Extract to `C:\actions-runner`, then configure using the one-hour token:

   ```powershell
   .\config.cmd --unattended `
     --url https://github.com/tianxiaochannel-oss88/ling-stack `
     --token $env:LING_GITHUB_RUNNER_REGISTRATION_TOKEN `
     --name ling-cua-driver-windows-x64-v1 `
     --labels ling-cua-driver-windows-x64-v1 `
     --no-default-labels `
     --work _work `
     --disableupdate
   .\svc.cmd install
   .\svc.cmd start
   ```

4. Remove `LING_GITHUB_RUNNER_REGISTRATION_TOKEN` from the process environment and
   confirm GitHub lists exactly one online runner with only the reviewed custom label.

The Windows colleague performs this runner provisioning and later real-VM acceptance.
The workflow, locked build, test signing, Setup construction, verifiers, and handoff remain
Ling implementation scope.

## Evidence and cleanup

Every build uses a run-id/run-attempt-specific tree below `RUNNER_TEMP`; it never reuses a
previous output root. Candidate A and B are uploaded under a run-specific artifact name,
downloaded by a separate promotion job, reverified, and reduced to a review-only proposal.
The source-build job resolves package authority only from the independently anchored
committed lock. On the initial closed-gate run it skips Desktop dependency installation,
the production package wrapper and its trace upload, while still uploading A/B evidence for
the proposal. After review commits the proposed lock and matching independent anchor, the
mandatory second A/B run executes the production wrapper against fresh candidate A. macOS
covers both architectures and DMG+ZIP in one wrapper call; Windows covers the x64 app,
uninstaller and NSIS signing roles. The resulting Electron Builder hook/final-artifact trace
is uploaded separately. All self-hosted artifacts use one-day retention.

GitHub artifact storage must have enough capacity before dispatch. Deleting old CI
artifacts is an explicit release-owner action. Do not silently delete release evidence or
replace the upload/download boundary with a persistent local directory.

Self-hosted success does not open either feature gate. The reviewed proposal still needs
the normal lock-and-anchor commit followed by a second native A/B build.

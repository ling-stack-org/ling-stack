# Cua Driver Self-Hosted Native Runners

This path builds internal Desktop products without consuming GitHub-hosted macOS or Windows
minutes. It does not weaken the provider lock, replace Windows real-machine acceptance, or
turn an internal package into a public release.

The entrypoint is the `Desktop product artifacts` workflow. Dispatch exactly one target:

- `target=macos-arm64`; or
- `target=windows-x64`.

There is no `both` option and no pull-request or push trigger. Each job checks out the
selected workflow ref without retaining credentials, verifies its dedicated runner profile,
builds the locked provider once and packages it in the same job. The historical
`cua-driver-self-hosted-native.yml` evidence workflow is not part of this product path.

## Runner identities

The reviewed identities live in `.github/cua-driver-self-hosted-runners.json`.

| Platform | Runner name and only custom label | Runner root | Launch mode | Locked native tools |
| --- | --- | --- | --- | --- |
| macOS ARM64 | `ling-cua-driver-macos-arm64-v1` | `/Users/tianxiao/.github-actions/ling-cua-driver-macos-arm64-v1` | interactive Aqua login session | actions/runner 2.336.0, Xcode 26.6 build 17F113, macOS SDK 26.5, Rust 1.97.1, arm64 target |
| Windows x64 | `ling-cua-driver-windows-x64-v1` | `C:\actions-runner` | interactive unlocked Windows login session | actions/runner 2.336.0, VS 17.14.37502.11, MSVC 14.44.35211, Windows SDK 10.0.26100.0, Rust 1.97.1 |

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

Keep that terminal and the logged-in Aqua session alive until the product job finishes.
Stop the interactive runner with `Ctrl-C`; do not restart the LaunchAgent for this build.
The product job selects the available Apple Development identity, derives its Team ID with a
temporary signed probe, signs both the embedded provider and Ling app, verifies the app,
provider, DMG and generated ZIP, and uploads only the DMG plus `checksums.txt`.

## Windows registration handoff

Run these steps on the dedicated Windows x64 machine. Install native toolchains with
administrator approval when their installers require it, but configure and launch the
runner from the standard, non-elevated user in the logged-in unlocked desktop session.
The provider readiness contract requires the runner and provider to share that medium-
integrity interactive session. Obtain the one-hour registration token from repository
**Settings → Actions → Runners → New self-hosted runner** immediately before configuration.
Never put that token in a script, evidence bundle, issue, or chat.

1. Install the locked Visual Studio, MSVC, Windows SDK and Rust versions shown above.
2. Download `actions-runner-win-x64-2.336.0.zip` from the official `actions/runner`
   release and require this SHA-256 before extraction:

   ```text
   d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162
   ```

3. Extract to `C:\actions-runner`, then configure using the one-hour token. Do not install
   it as a Windows service: service mode runs in Session 0 and cannot satisfy the locked
   same-session, medium-integrity, `default_unlocked` provider readiness proof.

   ```powershell
   .\config.cmd --unattended `
     --url https://github.com/tianxiaochannel-oss88/ling-stack `
     --token $env:LING_GITHUB_RUNNER_REGISTRATION_TOKEN `
     --name ling-cua-driver-windows-x64-v1 `
     --labels ling-cua-driver-windows-x64-v1 `
     --no-default-labels `
     --work _work `
     --disableupdate
   ```

4. Remove `LING_GITHUB_RUNNER_REGISTRATION_TOKEN` from the process environment and
   confirm GitHub lists exactly one online runner with only the reviewed custom label.
5. From the logged-in, unlocked desktop session, start `C:\actions-runner\run.cmd` and keep
   that console and session alive until the product job finishes. Stop it
   with `Ctrl-C` after the jobs complete.

The Windows colleague performs this runner provisioning and later real-VM acceptance.
The workflow, locked build, unsigned development Setup construction and contract verifiers
remain Ling implementation scope. Real Authenticode is added when the Windows signing
identity is available; the current `unsigned_dev + development` package is not a release
candidate.

## Evidence and cleanup

Every product build uses a fresh tree below `RUNNER_TEMP`; it never reuses a previous source
output. The same platform job verifies that one output and passes its absolute path into the
governed Electron Builder wrapper. No source-build output, signing fixture, promotion
proposal, handoff or finalizer artifact is uploaded. macOS uploads exactly one DMG and
`checksums.txt`; Windows uploads exactly one Setup executable and `checksums.txt`. Product
artifacts have three-day retention to limit storage use.

GitHub artifact storage must have enough capacity before dispatch. Deleting old CI
artifacts is an explicit release-owner action. Do not silently delete release evidence or
replace the upload/download boundary with a persistent local directory.

Self-hosted success proves that the selected internal product was built. It does not provide
notarization, SmartScreen/WDAC, production certificate or Windows real-machine acceptance.

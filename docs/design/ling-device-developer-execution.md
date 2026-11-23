# Ling Device Developer Execution and Connectivity

Status: proposed design and acceptance criteria
Owner: Ling platform maintainers
Last verified: 2026-11-20 (D12 communication paths)
Document type: developer sessions, communication, and device workflows

Related documents:
[Device Support Platform](ling-device-support-platform.md) ·
[Runtime Contract](ling-device-support-platform-runtime-contract.md) ·
[Hardware Protocol Workbench](ling-hardware-protocol-workbench.md) ·
[Ling Server Connectivity](ling-server-connectivity.md) ·
[Ling Device Fabric](ling-device-fabric.md) ·
[Implementation Plan](ling-device-support-platform-implementation-plan.md)

## 1. Device sessions

Ling offers a standard device session and a developer device session on PC and Mobile.
Both show the current target, the host that owns the device connection, the available
operations, and the verified outcome. The user chooses a session mode independently of
whether the phone or PC owns the task.

| Session | Operations | What the user sees |
| --- | --- | --- |
| Standard | Discover, diagnose, configure, recover through a supported interface, and verify. Use a versioned playbook or model-assisted planning. | Device status, proposed change, confirmation when required, and the result of the retest. |
| Developer | Add a project workspace, build and test, transfer verified build artifacts, deploy and manage authorized test apps, inspect logs and profiles, and use native developer or vendor tools. | Project and build details, active device identity, effective privileges, a native workbench where supported, and attempt history. |

The developer session binds the operator, target, owning host, project or app if
applicable, and current platform authorization. Its lifecycle follows the selected
device and its authorization. Ling shows the connection and the actual developer or
service identity before opening a native tool. Device authorization comes from the
target and host OS. For example, an Android debugging connection reports the granted
shell or development-build privileges and the capabilities they enable.

### 1.1 Developer workflow and native tools

- **Project work.** Edit source, select the SDK and build variant, build, test, and
  package using a compatible execution environment. The phone can handle supported
  project work locally and use an existing build service or a paired PC for toolchains
  it cannot run. Record the source revision, toolchain, build variant, and output digest.
- **Device work.** The model can drive the typed deployment, app launch, test, scoped log
  capture, result collection, and retest loop on the authorized target. A developer
  session can approve a concrete plan for one build and target, covering the named
  actions and parameters. Each dispatch still checks the specific action and current
  capability. A changed device, payload, or authorized scope needs a new decision.
- **Native workbench.** The developer can open an authorized SSH or Android developer
  terminal and use the privileges the device grants. Supported native tools can
  manage app data and package state, restart the device, or maintain the OS. A
  firmware workflow connects the user to the supported vendor tool, verifies model
  and package compatibility and trusted signing, preserves a recovery route, and
  records the installed version and boot or app health afterward. Terminal input and
  vendor maintenance controls belong to the operator. The task owner coordinates
  tool access and refreshes the device state after maintenance. The model can analyze
  a user-selected, redacted transcript and use the newly available typed capabilities.
- **Long-running work.** Build and test jobs on a PC or authorized build host retain job
  IDs, logs, and status after a client disconnect. A connected target can continue a job
  it has already accepted if its supported executor provides status and cancellation.
  On reattach, Ling reads the original job and records its actual state. Mobile-owned
  dispatch follows OS execution lifecycle and the device runtime contract.

Project processes run in their project environment. The device broker and native
maintenance tools hold their own target credentials and connection handles. A build
job contributes artifacts and test results through declared interfaces. The build
environment receives project credentials and access specific to the build. The broker
and workbench keep target access within the owning host's device execution boundary.
An operator selects the device and authorizes installation of the specific artifact.

### Native workbench job contract

Submit a native workbench job through
`POST /v1/device-support/developer/sessions/{sessionId}/jobs` on the authenticated
loopback listener. The request names one tool, one operation ID and an optional
SHA-256 digest of operator-selected evidence. The host supplies the SSH, ADB or
vendor tool integration and holds the native connection.

```json
{
  "jobId": "native-network-readback-1",
  "kind": "workbench",
  "authorizationRevision": "auth-7",
  "expectedSessionRevision": 4,
  "nativeWorkbench": {
    "tool": "ssh",
    "operation": "collect-network-evidence",
    "evidenceDigest": "<sha256 of the selected evidence>"
  }
}
```

The host's `DeviceDeveloperExecutor.nativeWorkbenchSideEffect` returns the
side-effect class for a supported target and operation. Its `execute` method uses
`assertCurrent()` before dispatch so mutating operations respect the target's
dispatch-stop revision.
Every job remains bound to the developer session's target and profile/connection
revisions. Completion requires a readback containing the same target, revisions,
observation time and evidence digest. A missing, foreign, stale or failed readback
leaves the job failed or unknown and retains the original job record. SQLite
keeps the request and readback together. Retrying the same job ID returns the
retained record.

## 2. Execution architecture

```mermaid
flowchart TB
  PC["Ling PC"]
  Phone["Ling Mobile"]
  Cloud["Configured model service"]
  Shared["Shared device schemas, task rules, playbooks and fixtures"]

  subgraph Desk["PC host"]
    Gateway["Remote Gateway and signed sync"]
    Daemon["Daemon task owner and journal"]
    Pi["Runner-Pi / project workspace"]
    PBroker["PC capability broker"]
    PNative["Operator's native tools"]
    Gateway <-->|"PC task state or collaboration messages"| Daemon
    Daemon --> Pi
    Daemon --> PBroker
  end

  subgraph Handset["Mobile host"]
    Task["Mobile task owner and journal"]
    Planner["Mobile planning loop and local playbooks"]
    MBroker["Mobile capability broker"]
    MNative["Operator's supported native tools"]
    Task --> Planner
    Task --> MBroker
  end

  PC --> Daemon
  PC --> PNative
  Phone --> MNative
  Phone <-->|"Authenticated remote session"| Gateway
  Phone <-->|"Phone-owned task controls and state"| Task
  Pi <-->|"Model turns"| Cloud
  Planner <-->|"Model turns"| Cloud
  Shared -.-> Daemon
  Shared -.-> Task
  PBroker --> PAdapters["PC adapters and transport"]
  MBroker --> MAdapters["Mobile adapters and native transport"]
  PAdapters --> Target["Selected external device or target-side executor"]
  MAdapters --> Target
  PNative --> Target
  MNative --> Target
```

| Placement | Planning and project work | Device execution and journal |
| --- | --- | --- |
| Phone alone | Mobile planning loop calls the configured model service. Supported local playbooks also work offline. | Phone broker and adapter, using the phone's connection. |
| PC owns the device connection | Daemon and Runner-Pi. Paired Mobile can initiate eligible actions and follow the task through the Gateway. | Daemon broker and adapter, using the PC's connection. |
| Remote PC helps the phone | PC can plan, build, or analyze evidence. The same task can also use the phone's configured model provider. | Phone broker and adapter. The PC receives a projection of the phone-owned task. |

Reuse the target, capability, plan, action, approval, journal, and evidence schemas.
Keep portable decision and state-transition logic in shared TypeScript where both
hosts can run it. Keep USB and BLE bridges, platform credential stores, system dialogs,
and process/toolchain launching native to the execution host. Runner-Pi is the current
PC project runtime. The Mobile loop consumes the shared tool and task contracts and
can run supported workflows with its own model connection and local adapter.

Bundle native transport modules in the platform build. Versioned playbooks, profiles,
and data-only manifests can be installed or updated against a declared contract range.
A shared logic fix must pass the same behavior fixtures on both hosts and ship in
their respective builds. Availability depends on the installed adapter version, the
OS, and the actual target interface. Publish compatibility and acceptance for each
phone OS, target firmware, and transport combination.

### 2.1 Explicit execution context

The target can be physically separate from both the planner and the host running the
adapter. Each proposal identifies its context by kind. A PC build action uses a
project workspace ID and PC host ID. A device action uses the external device ID and
the selected execution host ID. Observations carry their own subject, source, and
timestamp. The conversation UI displays them next to the corresponding result.

| Context shown in the UI | Example | Authority |
| --- | --- | --- |
| Project workspace | PC checkout of the head-unit app | PC project executor and project policy |
| Execution host | Phone connected to the head unit | Mobile broker and local device authorization |
| External target | The selected Android head unit | Target identity, transport session, and capability snapshot |
| Planner | PC Runner-Pi or configured Mobile model | Propose the next step and interpret eligible evidence |

An action also binds the task ID, capability/schema version, connection revision,
app or artifact when applicable, and current approval. If a model is moved to a
different host, the task owner and target stay attached to the existing journal.
When a target enters reboot or recovery, match the new connection to the verified
device and supported transition. If identity cannot be verified, resolve it with the
operator before a new action. A new owner starts a linked task after any uncertain
attempt is reconciled. See the [Runtime Contract](ling-device-support-platform-runtime-contract.md).

### 2.2 PC-assisted phone execution

```mermaid
sequenceDiagram
  actor U as User at phone
  participant M as Mobile task owner
  participant P as PC Gateway and Runner-Pi
  participant T as Selected external device
  U->>M: Select target and pair the device
  M->>T: Verify identity and read capabilities
  M->>P: Share task reference and authorized observations
  P->>P: Plan, analyze evidence or build in PC workspace
  P-->>M: Return typed proposal and artifact reference
  M->>M: Resolve target, verify artifact and check capability
  M->>U: Show target, change and expected check
  U->>M: Approve the action or concrete plan
  M->>T: Dispatch through the phone adapter
  T-->>M: Return action result
  M->>T: Read back the target state
  M-->>P: Sync receipt, verification and evidence
  M-->>U: Show verified or outstanding outcome
```

PC assistance is an explicit, revocable collaboration binding for the phone-owned
task. It authorizes selected evidence, proposals, and build-asset transfer between
paired peers. The phone intersects a proposal with its local capabilities and
approval. It downloads a build artifact only for the selected task and checks its
digest, app identity, and signing metadata before deployment. A transport receipt
confirms message delivery. The task journal provides the device outcome.

If the PC drops offline, the phone can continue with locally available prerequisites
or mark the specific missing build or analysis step as pending. If the phone loses its
device link after dispatch, it rechecks the target on resume. The PC displays the last
confirmed state until the phone publishes a new receipt or observation.

## 3. Communication design

### 3.1 Phone and PC

Ling Server provides first-party enrollment, presence, signaling, and STUN/TURN.
Paired phones and PCs carry the Ling application protocol over an authenticated
WebRTC DataChannel. A direct ICE route carries data when available. The
installation's TURN relay is the fallback. D6 adds the PC-owned task facade.
D11 carries scoped proposals and evidence for phone-owned tasks.
[Mobile Remote Access design](mobile-remote-access-detailed-design.md) ·
[Ling Server design](ling-server-connectivity.md)

```mermaid
flowchart LR
  Phone["Ling Mobile"]
  Gateway["PC Remote Gateway"]
  Server["Ling Server signaling, STUN and TURN"]
  Phone <-->|"HTTPS/WSS signaling"| Server
  Gateway <-->|"HTTPS/WSS signaling"| Server
  Phone <-->|"1. Authenticated LAN path"| Gateway
  Phone <-->|"2. Authenticated cross-network direct path"| Gateway
  Phone <-->|"3. End-to-end encrypted relay traffic"| Server
  Server <-->|"3. End-to-end encrypted relay traffic"| Gateway
```

| Responsibility | Design |
| --- | --- |
| Pairing and endpoint authentication | Keep local PC confirmation and pinned Ling peer identity. Authenticate both peers before accepting application messages. Bind a relayed channel to the same peer keys as a direct channel. |
| Signaling and presence | Peers register outbound and exchange signed negotiation messages. Presence carries a last-seen time. The server issues expiring TURN credentials for an eligible relay attempt. |
| Path selection and fallback | Reuse a reachable authenticated LAN path. Try authenticated internet direct connectivity with bounded traversal attempts. Use the encrypted relay when the direct path is unavailable. Reauthenticate route changes and measure fallback and reconnect time. |
| Sync and resume | The owner publishes ordered events and durable receipts. A client resumes from its last observed revision or loads a current snapshot if history has expired. A duplicate action reference returns its recorded disposition. |
| Data and operations | Ling Server handles online and routing metadata, relay traffic and resource quotas. Private keys, target credentials and conversation, command and artifact plaintext stay at the participating endpoints. Track route choice, failures and capacity using redacted metadata. |

```mermaid
sequenceDiagram
  participant M as Paired Mobile
  participant S as Ling Server
  participant P as PC Gateway
  M->>S: Register outbound and request the paired endpoint
  P->>S: Register outbound
  S-->>M: Forward signed negotiation messages
  S-->>P: Forward signed negotiation messages
  alt Authenticated LAN or cross-network path is reachable
    M->>P: Establish an authenticated peer channel
  else Network requires relay
    M->>S: Request TURN credentials for the paired peer
    S-->>M: Issue expiring relay credentials
    S-->>P: Issue expiring relay credentials
    M<<->>P: Establish DataChannel through TURN
  end
  Note over M,P: Peers verify paired identity before accepting signed messages
  M->>P: Exchange conversation and task cursors
  P-->>M: Resume PC-owned events or snapshot
  M-->>P: Resume shared Mobile-owned task state
```

The Gateway checks the pairing and the authenticated peer channel before accepting
application messages. TURN/TLS supports relay transport when UDP from the client is
unavailable. Endpoints enforce peer revocation on the active path. Ling Server
controls new relay admission and bounds the lifetime of existing allocations.

Local execution and an already established direct peer route can work during a Ling
Server outage. Remote reachability across networks depends on an available direct or
relay path. Release acceptance includes pair/revoke, peer identity change, NAT and
relay fallback, reconnect on a network change, and route migration during a live task.
Conversation and device-task updates use the same reachability layer while retaining
their own permissions, event sequence, and owner.

### 3.2 Execution host to external device

Ling-to-Ling pairing and target authorization are distinct connections. A target
pairing QR can carry a connection hint, public fingerprint and account hint when
supported. The user checks the fingerprint against a trusted device display or record.
The adapter establishes the actual protocol session. Passwords and private keys are
entered or stored in the host's protected credential path.

| Target path | Phone-owned task | PC-owned task |
| --- | --- | --- |
| Linux over local network or phone hotspot | Native SSH on a reachable address with host key verification. Confirm that the hotspot permits the phone to reach its client. | SSH from the PC when it has its own route and credentials. |
| Android head unit over network | Device-supported, authorized ADB where the phone adapter and network allow it. APK installation via the head-unit installer is also available on supporting firmware. | PC uses authorized network ADB or shares a validated package with the phone. |
| USB to Android target | Android needs USB host support, a data-capable cable, user permission, and native adapter support. iOS support depends on an available and authorized accessory interface. | USB ADB or vendor tooling on a supported PC OS, drivers, and target. |
| BLE or vendor/household peripheral | Native transport plus a matching GATT, Matter, Home Assistant, or vendor adapter as appropriate. | A matching local protocol or bridge when reachable from the PC. |
| Vendor maintenance and recovery | Use the vendor's documented phone/target maintenance flow for supported equipment. | User operates the supported vendor tool with the device physically reachable from that PC. |

The model connection is a third path. When an internet connection changes during
hotspot, USB, or CarPlay setup, the phone retains the device task and can finish
supported local checks. Resume model and peer sync separately when their paths return.

## 4. Case flow: Linux device with Wi-Fi trouble

A local SSH check from a Mac reached the device and obtained wireless association,
DHCP, route and journal evidence. The journal showed a `WRONG_KEY` event and four
handshake failures followed by a successful association two seconds later. This is
evidence of an intermittent failure sequence. Its cause, phone-to-hotspot-client
SSH reachability, and real Mobile execution still require verification.

```mermaid
flowchart TD
  Start["Linux cannot join the intended Wi-Fi"]
  Alt{"Can the phone reach the device?"}
  Route["Try a known-good hotspot or LAN"]
  Pair["Confirm device identity and authorize SSH"]
  Report["User supplies evidence from an authorized local console"]
  Owner{"Does PC assist?"}
  Local["Mobile interprets locally or calls its model"]
  PC["PC analyzes the shared evidence or proposes a step"]
  Read["Phone collects link, IP, route, DNS and recent Wi-Fi events"]
  Change{"Supported action over a verified route?"}
  Repair["Approve, record baseline and apply on owning host"]
  Verify["Verify association, DHCP, route, DNS and the original symptom"]
  Record["Record verified outcome or the next unresolved check"]
  Start --> Alt
  Alt -->|"Yes"| Pair
  Alt -->|"Alternate route is available"| Route --> Alt
  Alt -->|"Local console only"| Report --> Owner
  Alt -->|"Device is unreachable"| Record
  Pair --> Read --> Owner
  Owner -->|"Phone only"| Local --> Change
  Owner -->|"PC assists"| PC --> Change
  Change -->|"Yes"| Repair --> Verify --> Record
  Change -->|"Diagnostics only"| Record
```

Compare known-good hotspot behavior with the intended network. Association failures,
failure to obtain an IP address, and DNS failures point to different observations.
For a configuration change affecting the active route, use the runtime contract's
alternate verified path or target-side restoration mechanism. After reconnect, read the
original target identity and retest access. In the remote assistance variant the phone
maintains the SSH session and applies the accepted action. If the PC has its own
verified connection to the Linux device, the user can select it as the owner at
task creation.

### PC-owned Linux SSH diagnosis

The Daemon loads a host-owned JSON file from `LING_STACK_DEVICE_SSH_TARGETS_FILE`
or the embedding option `deviceSupport.linuxSshTargetsFile`. The file belongs
in the installation's trusted configuration area. Each target includes an
operator-verified SSH server public key and an absolute path to a local client
identity. OpenSSH reads the client identity on the executing host.

```json
{
  "version": 1,
  "targets": [
    {
      "connectionId": "lab-board",
      "host": "board.lab.example",
      "port": 22,
      "user": "operator",
      "identityFile": "<absolute path to the local SSH identity>",
      "hostKey": "ssh-ed25519 <verified public key data>",
      "credentialRevision": "key-1"
    }
  ]
}
```

These routes use the direct-loopback Daemon listener and its configured bearer
authentication. [Daemon routes](../../packages/daemon/src/features/device-support/routes.ts)

| Operation | Route | Request |
| --- | --- | --- |
| List candidate and enrolled targets | `GET /v1/device-support/linux/targets` | No body |
| Verify the supplied host key and enroll the board | `POST /v1/device-support/linux/enroll` | `{"connectionId":"lab-board"}` |
| Run and persist a read-only diagnosis | `POST /v1/device-support/linux/diagnose` | `{"deviceId":"<enrolled device ID>"}` |
| Read the durable task journal | `GET /v1/device-support/tasks/<task ID>/events` | Optional `afterSequence`, `generation` and `limit` |

The device ID uses the verified host key fingerprint. A moved target with the
same key retains its device ID. Update its endpoint or move the client identity
to a new path in the host configuration and restart the Daemon. Bump
`credentialRevision` when rotating the client identity in place. The next diagnosis
revalidates the pin and refreshes the connection binding. A removed target goes
offline and keeps its journals. A new server key requires enrollment as a new identity.

Network evidence uses `iproute2` JSON output and `iw`. The report records IPv4
configuration, route selection and Wi-Fi association separately. An optional
`dnsProbeHostname` adds an IPv4 name-resolution observation through the target's
DNS service via `getent`. Missing tools and unmeasured reachability remain unknown.
Each report links its normalized facts to the owned task journal. Network changes
that could drop SSH access require a verified recovery route or target-side restoration.
[Linux SSH executor](../../packages/daemon/src/features/device-support/adapters/linux-ssh-executor.ts)

### Phone-owned Linux SSH diagnosis

An Android build with the `LingDeviceTransport` module exposes Linux SSH from
phone device diagnosis. Enter the board address, port, SSH account and verified
OpenSSH `SHA256:` host-key fingerprint. The fingerprint comes from the target's
console or trusted inventory. Submit the account password for this connection.
The transport checks the pin during the handshake before sending authentication.

The phone runs the same IPv4, route, Wi-Fi and optional DNS observations as the
PC adapter. It saves the enrolled device identity and endpoint metadata after a
successful diagnosis. The password is scoped to the submitted operation. The
local task journal retains typed facts and failure codes. When the app loses
foreground access it closes the live SSH session and preserves an interrupted
attempt for inspection after resume.
[Mobile runtime](../../apps/mobile/src/device/standalone-runtime.ts)
[Android native session](../../apps/mobile/modules/ling-device-transport/android/src/main/java/expo/modules/lingdevicetransport/PinnedSshSession.java)

The Android native client has passed JVM loopback tests, including host-key
rejection before authentication, fixed command execution and output bounds. The
generated Gradle project requires Android SDK 37 for compilation and targets SDK
36. The default build environment has no complete Android SDK/NDK installation,
so the native Gradle package has not been accepted yet. Physical Android LAN
and hotspot runs, native iOS SSH, and a recovery path for network changes remain
on the acceptance ledger.

### Phone-owned Home Assistant recovery

Open phone device diagnosis and enter the trusted Home Assistant HTTPS origin,
the entity ID, and the access token. For a disabled automation with a configured
ID, the phone accepts **Re-enable automation** for 30 seconds after diagnosis.
Confirmation binds the approved action to the origin, entity, configured ID
digest, capability snapshot, connection revision and policy revision. The phone
owns this workflow and its journal independently of PC pairing.

The Mobile adapter rechecks the automation and calls `automation.turn_on` for
the approved entity if it is still disabled. It reads the entity again and records
successful verification when the same automation is enabled. A changed identity,
expired baseline or denied authorization stops dispatch. A lost write response
or missing readback leaves the result unknown. Another confirmation of the same
diagnosis returns the saved attempt. The shared trace includes the attempt,
adapter revision and verification references. The token lives in memory until the
workflow ends.

For a recovery marked unknown, enter the same origin, entity ID and a current
access token and open **Verify this recovery** from the task history. The phone
rechecks the automation through a fresh HTTPS connection and attaches the
readback to the original attempt. A verified state settles the task. An
unavailable response, identity change, or disabled automation leaves it
unresolved. The original write receipt and connection revision remain in the
journal, with the readback recorded under its own revision.

### Collaborate from a phone-owned diagnosis

On a paired phone, find a Linux SSH or Home Assistant task in **手机设备诊断**
and choose **请配对电脑协助**. Confirm the 30-minute share. In Ling Desktop, open
**Settings → Mobile Access → Phone device tasks** to view the target reference,
diagnostic facts and verification state. Use **Send analysis** to attach a note
to the displayed task revision.

When the PC workspace has a default chat model, **Draft with workspace model**
fills the note with an editable suggestion. The model receives the shared
diagnostic facts, recorded outcome and verification status. Review the draft and
select **Send analysis** to share it. A newer phone task revision requires the PC
to review the note with that record before sending.

On the phone, choose **同步记录和建议** to review the note. The phone records the
accept or reject decision and keeps device operations in the task's existing
controls. A completed readback updates the shared task revision, and a note
awaiting review on the earlier revision expires. Choose **结束共享** to remove
the projection from the PC's active shares.

### Receive a PC build file on the phone

In **Settings → Mobile Access → Phone device tasks**, choose **Share a PC file**
and select a file from the system picker. Ling streams the selected file to the
local Gateway. The signed manifest binds the file name and SHA-256 to the paired
phone, task revision, target, attempt and connection. An offer supports up to
256 MiB.

On the phone, choose **同步记录、建议和文件** and then **接受并接收** on the matching
offer. If interrupted, reopen the same task and choose **继续接收**. The phone
verifies each signed chunk and the final SHA-256, records the file on the task,
and returns its signed receipt. The Desktop task shows **File verified by phone**.
Choose **导出已校验文件** on the phone to save a verified copy to a selected folder,
including after the share ends.

For a file named `.apk`, configure the PC's `apkTools` in the
[ADB targets file](#pc-owned-signed-apk-deployment). A PC preparing APKs for the
phone can use an empty `targets` array. The Gateway verifies the staged APK with
Android SDK Build Tools, then signs the manifest with the APK's SHA-256,
package ID, decimal long version code, optional legacy version code, and
sorted SHA-256 certificate fingerprints. The package must be a signed
standalone APK. Both WebSocket and the signed Ling Server SDP negotiate
`ling.device-tasks.v8` for offers carrying this identity. A `v7` session can
continue to receive ordinary file offers.

Mobile compares the assembled SHA-256 with the signed manifest. A build
with the Android native transport also verifies the archive through Android's
package manager and compares the package, version and current signer
fingerprints. Other Mobile builds verify the paired Gateway's signed
attestation and the exact file digest. The signed receipt includes the method
used. Mobile retains its verification record before publishing the receipt,
so a lost connection can resume from the verified bytes. A target-side
installation has its own approval and readback evidence.
[Offer service](../../packages/daemon/src/features/remote-access/phone-task-artifacts.ts)
[Mobile verification](../../apps/mobile/src/device/phone-task-artifacts.ts)

### Phone-owned USB ADB APK deployment

On Android, open **手机设备诊断 → Android USB** and connect the target with a
data-capable USB cable. Ling lists USB Host interfaces that expose the ADB bulk
transport. The operator grants the Android USB permission and accepts Ling's
ADB host key on the target. Ling records the target's hardware serial, model,
Android release, build fingerprint and connection revision before showing an
installation action.

The APK can come from the phone's file picker or from an accepted paired-PC
artifact. The phone checks the sealed file's size and SHA-256, package ID,
decimal version code and signer certificate fingerprints. A paired artifact
also has to match the current phone-task projection and target binding. The
install action is a mutating developer operation. The phone requires an
explicit confirmation, binds the action to the current USB target and sends
the APK through the native ADB transport.

After `pm install` returns, the phone reads the selected package with
`pm path`, `dumpsys package` and a base-APK digest where the target exposes it.
The task is verified only when package ID, version code and installed digest
match the approved APK. A lost response leaves the task `unknown`. Reconnect
the same target and choose **回读这次安装结果** to settle the original attempt
from a fresh package and digest readback. A different USB device, changed serial,
changed build fingerprint, expired approval or a backgrounded app stops the
operation without a second install.
[Mobile USB ADB runtime](../../apps/mobile/src/device/usb-android-runtime.ts)
[Native ADB transport](../../apps/mobile/modules/ling-device-transport/android/src/main/java/expo/modules/lingdevicetransport/UsbAndroidPackages.kt)

### Build an APK on the assisting PC

Provide the absolute path to a host-owned build configuration through
`LING_STACK_DEVICE_ANDROID_BUILDS_FILE` or
`deviceSupport.androidProjectBuildsFile`. Enable `apkTools` on the same Daemon.
Each configured build selects a project inside the current PC workspace.
The APK path is relative to the project directory.

```json
{
  "version": 1,
  "builds": [
    {
      "buildId": "head-unit-debug",
      "directory": "head-unit-app",
      "executable": "<absolute path to gradlew>",
      "args": ["assembleDebug"],
      "apkPath": "app/build/outputs/apk/debug/app-debug.apk",
      "toolchain": "Gradle and Android SDK",
      "variant": "debug"
    }
  ]
}
```

Use the authenticated loopback Daemon to discover the local PC and create a
developer session for it. Choose a build from
`GET /v1/device-support/developer/project-builds`. Authorize the session, then
submit a job to its `/jobs` route with `kind: "build"`, `jobId`, `buildId`,
`authorizationRevision`, and `expectedSessionRevision`. The PC starts the
configured executable in the project directory. SDK paths and common process
settings are inherited. A build can list additional project environment keys
in `passEnvironment`. The job record carries the configured toolchain and
variant through its output artifact, with the Git revision and worktree status
when available. The session's `/jobs/{jobId}/build-log` route returns the bounded
stdout and stderr from the finished process.

When the job finishes and the APK verifies, the Daemon commits the job outcome,
artifact identity and session revision together. Read the outcome through
`/jobs/{jobId}` after reconnecting. Repeating a job ID with the same input
returns the recorded outcome.

In **Settings → Mobile Access → Phone device tasks**, select a completed build.
Check its package, version and SHA-256, then choose **Share APK build**. The
local Mobile Access management route accepts
`POST /v1/mobile-access/device-collaboration/artifacts/from-build` with the
active `shareId`, `expectedRevision`, a `proposalId` and `buildJobId`. The
Gateway resolves the retained APK from the completed job in its workspace,
verifies its SHA-256 and uses the same signed-offer flow as a selected file.
This preserves the reviewed build bytes when the project's output path is
overwritten. The phone accepts the offer and verifies the file against its
task's target and connection revision. Device installation uses the phone's
local developer authorization.
[PC build service](../../packages/daemon/src/features/device-support/android-project-builds.ts)
[Native peer acceptance fixture](../../packages/daemon/test/ling-server-native-peer.test.ts)

## 5. Case flow: install DiPlay on an older head unit

DiPlay v0.2.22 is a public-preview Android APK for a compatible head unit, with
Android 7.0+ as the stated minimum. Installing and configuring the APK supplies the
CarPlay receiver. The normal wireless or USB connection uses the iPhone and DiPlay.
The head-unit package installer is the baseline installation route. Authorized ADB is
an option for package deployment and development diagnostics when supported. Model,
Android/DiLink firmware, and iOS compatibility must be established on the combination
being used. Upstream wired and wireless evidence differs by device.
[Install guide](https://github.com/shihabal3amri/DiPlay/blob/v0.2.22/docs/INSTALL.md) ·
[Compatibility](https://github.com/shihabal3amri/DiPlay/blob/v0.2.22/docs/COMPATIBILITY.md)

```mermaid
flowchart TD
  Begin["Identify the parked head unit, firmware and iPhone"]
  Fit{"Compatible APK and supported install path?"}
  Mode{"Phone only or remote PC assistance?"}
  Mobile["Phone selects the upstream release and stages it for the car"]
  PC["PC checks release or builds an authorized test artifact"]
  Stage["Phone verifies the package and stages supported install"]
  Install["Install or update on head unit and check package and version"]
  Connect["Grant needed app permissions and start USB or wireless CarPlay"]
  Test{"Picture, touch, audio and reconnect verified?"}
  Logs["Collect DiPlay report and isolate installation or connection issue"]
  Recovery["Retest a verified change or use the documented return path"]
  Finish["Record tested combination, evidence and result"]
  Other["Report incompatibility or use a supported alternative"]
  Begin --> Fit
  Fit -->|"Yes"| Mode
  Fit -->|"No"| Other
  Mode -->|"Phone only"| Mobile --> Stage
  Mode -->|"PC assists"| PC --> Stage
  Stage --> Install --> Connect --> Test
  Test -->|"Yes"| Finish
  Test -->|"Incomplete"| Logs --> Recovery --> Finish
```

1. **Prepare.** Record head-unit model, Android and firmware version, supported
   package installer, iPhone/iOS version, and a matching wired or wireless path.
   Preserve relevant app settings or reports where export is supported. Obtain the
   release from the upstream source and record the package, artifact digest and
   signing information. Establish signing continuity for an in-place update.
2. **Install.** With only a phone, Ling can stage the APK through a supported local
   transfer or guide installation on the head-unit screen. A phone with a verified
   native ADB route can deploy via the adapter. With a remote PC, it can prepare
   the release or build a test APK, send it with its manifest, and inspect logs.
   The phone and the user at the car complete the installation if the phone owns
   the device connection. If the PC is physically connected to the head unit and
   owns the task, its authorized adapter can install the artifact.
3. **Configure and verify.** Finish the permissions and pairing on the head unit and
   iPhone. Verify that CarPlay starts, displays a picture, accepts touch, routes audio,
   and reconnects using the selected backend. Log the last verified stage if the
   phone switches networks or the control connection drops during setup.
4. **Diagnose and recover.** Read the exported DiPlay report or scoped app logs when
   authorized, matching evidence to the installed version. Distinguish package
   installation, Bluetooth/Wi-Fi or USB setup, projection, and media failures. Apply
   a supported adjustment and repeat the failing check, or use the documented
   uninstall/settings restore path and retest the original projection setup.
   Record what the user verified at the car.

The iPhone can serve as both Ling's control surface and the CarPlay endpoint.
An Android phone can host Ling's developer adapter, with an iPhone still needed to
test CarPlay. Vehicle acceptance records the exact OS, head unit, connection backend,
and release. DiPlay remains an independently installed project. Bundling or modifying
it requires dependency and license review.

### PC-owned Android ADB diagnosis

The Daemon uses an already authorized target on the PC's local Android Platform
Tools server. Configure an absolute JSON file with `LING_STACK_DEVICE_ADB_TARGETS_FILE`
or the Daemon embedding setting `deviceSupport.androidAdbTargetsFile`. Each entry
has a `connectionId`, the serial shown by `adb devices -l` as `adbSerial`, the
device's trusted `ro.serialno` as `hardwareSerial`, and a `kind` of `android` or
`head_unit`. For devices that supply only `ro.boot.serialno`, use that value. The
file sets `version` to `1`, lists entries under `targets`, and can specify an
absolute `adbPath` when Platform Tools are outside the Daemon's PATH.

| Operation | Route | Request |
| --- | --- | --- |
| List configured targets | `GET /v1/device-support/android/targets` | No body |
| Verify the authorized debugging transport and enroll | `POST /v1/device-support/android/enroll` | `{"connectionId":"bench"}` |
| Read Android version and package count | `POST /v1/device-support/android/diagnose` | `{"deviceId":"<enrolled device ID>"}` |

The Daemon checks the hardware serial inside the selected ADB transport and
stores a derived device ID. A change to the ADB transport or build fingerprint
creates a new connection revision. The package query verifies the same hardware
serial within its own shell process. The diagnosis uses the PC owner journal
and projects the OS version and package count. The snapshot advertises the
operations supported by the selected executor.
[Daemon ADB target binding](../../packages/daemon/src/features/device-support/android-adb-targets.ts)

### Android installation readback

An Android adapter with an authorized installation executor binds the approved
SHA-256, Android package ID and decimal version code to the current connection
revision. The executor receives that binding. After installation, the adapter
reads the package inventory from the same target and records the observed version
in the owner journal. An installed older version fails verification. When
the target provides package presence alone, the verification stays unresolved.
The configured PC executor queries package version codes where Android supports
them. On older releases it reads the selected installed package's version through
`dumpsys package`. It also reads the installed base APK digest where the device
makes the file available to ADB. After an uncertain installation, reconciliation
requires this digest as well as the approved package ID and version.
[Adapter](../../packages/daemon/src/features/device-support/adapters/android-adb.ts)
[Readback fixture](../../packages/daemon/test/device-support-adapters.test.ts)

### PC-owned signed APK deployment

Add `apkTools` to the authorized ADB targets file to enable APK import and
installation for enrolled targets and APK offers for a paired phone.
Set `javaPath`, `apkSignerJar`, and `aapt2Path` to absolute paths
to Java and the Android SDK Build Tools. The daemon verifies the staged APK
with `apksigner.jar` and reads the standalone package manifest with AAPT2.
It retains the SHA-256, package ID, version code and certificate fingerprints
against the developer session. An import reports the long version code and
its legacy component where the app declares a version code major.
The APK fixtures verify the signer digest emitted by Android SDK Build Tools
36.0.0 and 37.0.0.

Create and authorize the developer session for the enrolled target. The
following paths are relative to `/v1/device-support/developer/sessions/{sessionId}`
on the authenticated loopback daemon.

| Operation | Method and path | Inputs and evidence |
| --- | --- | --- |
| Review the signed APK | `POST /artifact?expectedRevision={revision}` | Raw APK body with `Content-Type: application/vnd.android.package-archive` and its `Content-Length`. Returns the verified artifact and updated session. |
| Reopen reviewed metadata | `GET /artifact` | Returns the retained artifact and session. |
| Confirm installation | `POST /jobs` | Send `jobId`, `kind: "deploy"`, the reviewed `artifactDigest`, `authorizationRevision` and `expectedSessionRevision`. The owner journal binds these to the registered target and connection. |
| Inspect the job | `GET /jobs/{jobId}` | Returns the retained job and its device task reference when available. |
| Settle an uncertain installation | `POST /jobs/{jobId}/readback` | Reopens the authorized connection to the same device and reconciles the original attempt from package, version and digest evidence. The original job outcome remains available with the current task status. |

The PC checks the retained file digest before dispatch. ADB must report the
enrolled serial and build fingerprint on the selected connection before the
PC sends the APK. Android's package manager applies installation and signing
continuity rules. Repeat submissions with the same job ID return the retained
job. The daemon records the fresh readback and preserves the original attempt
when a response is lost.
[APK verifier](../../packages/daemon/src/features/device-support/android-apks.ts)
[Deployment routes](../../packages/daemon/src/features/device-support/developer-routes.ts)
[Integration test](../../packages/daemon/test/android-apk-deployment.test.ts)

### PC-owned Android developer logs

Set an enrolled target's optional `logTag` to the tag emitted by the app under
test. Create and authorize a developer session for that target through
`/v1/device-support/developer/sessions`. Submit a job of kind `logs` with its
authorization revision. The PC captures a bounded main and crash buffer dump
filtered to the tag. The capture checks the hardware serial and build fingerprint
on the selected ADB transport. Another submission of the same job ID returns the
retained job.

An authenticated local client can read the retained text using
`GET /v1/device-support/developer/sessions/{sessionId}/jobs/{jobId}/logcat`.
The trace and journal projections carry the attempt and device lineage. The log
text is sensitive evidence scoped to the local developer session.

## 6. Acceptance and delivery evidence

Record host OS and app build, target model and firmware, transport, adapter and contract
versions, initiating client, owner, action attempts, artifact digest where relevant,
before/after observations, and verification outcome. Record whether a case was run
against a fixture, simulator, or physical target. For assisted tasks include which
data and artifacts the user shared and the connected peer.

| Slice | Evidence |
| --- | --- |
| [D8](ling-device-support-platform-implementation-plan.md#d8-additional-ecosystems) | Linux SSH and Android adapters report actual support. Verify a Linux diagnosis and a parked-vehicle DiPlay installation and retest on recorded combinations. |
| [D9](ling-device-support-platform-implementation-plan.md#d9-standalone-mobile-execution) | Real phone and target complete the official BLE recovery case and resume after interruption. Linux and Android paths get their own physical-device runs. |
| [D10](ling-device-support-platform-implementation-plan.md#d10-developer-device-sessions) | Verify the install/test/log/retest loop for an authorized app, the user's native-tool session, job reattach, and the supported vendor maintenance receipt. Exercise injected device text, target mismatch, and loss of authorization. |
| [D11](ling-device-support-platform-implementation-plan.md#d11-pc-assisted-mobile-execution) | PC submits analysis or a build for a phone-owned task. Link loss, duplicate proposals, and a different attached target preserve the owner and recorded attempts. |
| [D12](ling-device-support-platform-implementation-plan.md#d12-ling-server-connectivity) | Paired peers sync over LAN, direct internet and encrypted relay. Test relay fallback, route switch, resync and revoke using the same task, sequence and authorization model. |
| [D13](ling-device-support-platform-implementation-plan.md#d13-hardware-protocol-development-and-debugging) | Capture and decode a documented Modbus RTU bench device on supported PC and Mobile paths. Replay traces, verify a live change, and register the verified adapter for standard sessions. |
| [D14–D22](ling-device-support-platform-implementation-plan.md#d14-semantic-device-graph-and-twin) | Connect semantic device state, cross-device task graphs, edge runtimes, event streams, signed resources, safety, fleet lifecycle, model context, and conformance evidence. |

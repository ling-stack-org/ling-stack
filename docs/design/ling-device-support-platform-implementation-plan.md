# Ling Device Support Platform Implementation Plan

Status: tracking plan; D1–D3 core, D4/D5/D7/D8 adapters, D6/D9 execution slices, D10–D22 domain foundations, and the first durable fabric stores landed. Shared device approval, Home Assistant reload, and PC Modbus serial slices are implemented with field and platform acceptance still queued
Owner: Ling platform maintainers
Last verified: 2026-11-23 (D8/D10 PC-owned Android developer logs, D9 phone-owned Home Assistant recovery, and D14 enrolled-device graph)
Document type: staged implementation and acceptance record
Related design: [Ling Device Support Platform](ling-device-support-platform.md)
Runtime contract: [Ling Device Support Platform Runtime Contract](ling-device-support-platform-runtime-contract.md)
Developer workflows and topology: [Device Developer Execution and Connectivity](ling-device-developer-execution.md)
Ling Server communication: [Ling Server Connectivity](ling-server-connectivity.md)
Cross-device execution fabric: [Ling Device Fabric](ling-device-fabric.md)

This plan records delivery one slice at a time. A slice is not complete because code
compiles or a static package check passes. Each completed slice must record behavior
validation and the boundary of what remains unverified.

## Status legend

- [ ] not started
- [~] in progress
- [x] completed with evidence
- [!] blocked, with the blocking condition recorded
- [-] intentionally deferred by a product decision

## Delivery rules

1. Keep device contracts independent from individual adapters.
2. Use read-only capabilities first; add side effects only with explicit approval and
   verification behavior.
3. Use simulators and fixtures before real hardware. Hardware and field acceptance remain
   separate evidence categories.
4. Use typed broker capabilities for model actions. The operator uses native
   development and vendor tools through the authorized workbench.
5. Do not add an adapter to the product catalog until its manifest, health behavior,
   permission profile, support matrix, contract tests, and removal path exist.
6. Record the exact adapter version, device profile, capability snapshot, and the
   playbook version or model/provider used for every executed task.
7. Update this file in the same change as each material slice. Keep completed behavior in
   the owning contract and keep this file for delivery status and evidence links.

## Slice overview

| ID | Status | Scope | Exit condition | Primary validation |
| --- | --- | --- | --- | --- |
| D0 | [x] | Architecture, boundaries, and tracking plan | Design indexed and linked from implementation status | Markdown/link checks, review of current architecture |
| D1 | [x] | Shared device contracts and adapter manifest | Strict schemas compile and reject invalid inputs | Contracts typecheck and contract tests |
| D2 | [x] | Device registry and capability broker | A fake device can register, discover, refresh capabilities, lease a target, and execute a read-only capability | Core broker tests with fake adapter |
| D3 | [~] | Task state, approval, verification, and evidence | A task keeps its approval, dispatch intent, receipt and verification through interruptions, with user-visible reconciliation and recovery | Core SQLite journal and daemon startup recovery tests |
| D4 | [~] | Home Assistant adapter | The configured Daemon diagnoses entity and integration state, and an approved automation recovery verifies a fresh enabled state | Daemon fixtures and a local Home Assistant Core 2026.11.2 run |
| D5 | [~] | PC adapter and target-side executor | Typed PC network, native process, service, log, and software inventory observations, plus one reversible repair | Three-platform inventory fixtures and macOS arm64 owner-journal acceptance |
| D6 | [~] | Mobile device-task facade | Paired Mobile can inspect, approve, revoke, request readback, and resume the PC owner's journal through Gateway | Remote protocol and authenticated Gateway fixtures |
| D7 | [~] | Playbooks and operator evidence | Bounded read-only playbook validation and replayable task attempts are implemented | Core playbook fixture tests |
| D8 | [~] | Additional ecosystems | PC-owned SSH and ADB enroll Linux and Android targets. Developer sessions can capture Android logs for the enrolled target's configured tag. Host-supplied bridges provide typed Android development and OBD diagnosis | Daemon HTTP, reconnect fixtures, adapter contracts and OpenSSH loopback |
| D9 | [~] | Standalone Mobile execution | Mobile owns Home Assistant diagnosis and automation recovery, with exact approval, readback and a local journal independent of PC pairing | Mobile fixtures, Home Assistant Core 2026.11.2 HTTPS loopback and iOS/Android JS bundle exports |
| D10 | [~] | Developer device sessions | The Daemon coordinator persists target-bound sessions, artifacts and job outcomes | Core and Daemon developer-session fixtures |
| D11 | [~] | PC-assisted Mobile execution | Phone-owned collaboration proposals and chunked artifacts preserve owner and target binding | Core collaboration fixtures |
| D12 | [~] | Ling Server connectivity | The native PC peer uses a verified Ling Server profile and serves the same owner journal after PC restart. Direct, relay, and fallback behavior have transport evidence | Native Pion/TLS loopback, Mobile connector tests, Chromium/Pion TURN loopback, and Desktop resource checks |
| D13 | [~] | Hardware protocol development and debugging | Daemon developer sessions capture and replay Modbus RTU traffic. Standard diagnosis reads the configured register range through the broker and keeps the protocol evidence | Core protocol, Daemon and macOS native serial PTY fixtures |
| D14 | [~] | Semantic device graph and twin | The local graph exposes enrolled devices and current connection bindings alongside stored relationships and twin records | Core graph/twin fixtures and Daemon enrollment and reconnect fixture |
| D15 | [~] | Cross-device task graph | Dependency validation, ready-node placement, owner leases, partial aggregation, result lineage, cancellation, and failed-node retry are implemented | Core task-graph fixtures |
| D16 | [~] | Edge Runtime and bridge contract | Enrollment, revocation, per-task journal and revision-bound placement decisions are durable | Core SQLite restart fixtures |
| D17 | [~] | Event and telemetry plane | The owning Daemon journal exposes resumable event pages and a bounded authenticated watch to local and paired Mobile clients | Core journal, authenticated Gateway, Remote Client, and Mobile fixtures |
| D18 | [~] | Resource and adapter registry | Daemon imports, updates, disables and rolls back signed resources through its local operator API | Core resource fixtures and Daemon HTTP integration |
| D19 | [~] | Safety, policy, and secrets | The Daemon persists an operator dispatch stop and retains unsettled attempts. The policy evaluator checks physical facts and handoff requirements | Core safety and authenticated Daemon fixtures |
| D20 | [~] | Fleet and lifecycle | The Daemon projects workspace health and records retirement with the target's profile and connection revisions | Core lifecycle and authenticated Daemon Fleet fixtures |
| D21 | [~] | Model context and orchestration | PC and enrolled Linux diagnosis can select typed steps through the existing Pi runner and a configured model provider | Core proposal validation and loopback Pi integration |
| D22 | [~] | Observability and conformance | Daemon task traces link accepted plans, adapter attempts and readback evidence | Local diagnosis, Gateway reconciliation and Core trace fixtures |

## D0: Design baseline

Recorded in [PR #730](https://github.com/ling-stack-org/ling-stack/pull/730).

- [x] Define product scope and non-goals.
- [x] Separate client, daemon, model runner, capability broker, adapter, transport, and
  target executor ownership.
- [x] Define device identity, profile, capability, task, action, observation, and evidence
  concepts.
- [x] Define adapter lifecycle, versioning, permissions, and failure behavior.
- [x] Define mobile, local, direct-transport, hardware-bridge, and future relay topologies.
- [x] Define Home Assistant, PC, vehicle, and generic transport extension points.
- [x] Add this plan to the design index and implementation-status index.

D0 covers the design and the implementation plan.

## D1: Shared device contracts and adapter SDK

### Scope

- [x] Add strict DeviceIdentity, DeviceProfile, CapabilityDescriptor, AdapterManifest,
  Observation, ActionRequest, ActionResult, VerificationResult, and DeviceTask contracts.
- [x] Add schema versions and reject unknown fields where the contract is security- or
  wire-sensitive.
- [x] Select a shared contract major and compatible capability schemas. Allow additive
  display metadata within a supported version.
- [x] Define side-effect, approval, permission, idempotency, timeout, verification, and
  rollback metadata.
- [x] Define per-operation deadlines, response size limits, and the total task budget.
- [x] Define normalized error categories without exposing raw credentials or protocol
  payloads.
- [x] Define adapter conformance fixtures and a fake adapter.
- [x] Record the deployment rule for each transport: no target install, target-side
  executor, or hardware bridge, with pairing and removal behavior.

### Exit evidence

- Contract typecheck output.
- Schema fixtures for compatible peers, incompatible versions, display metadata, and
  invalid manifest and action fields.
- Fake adapter manifest and capability snapshot.
- Review confirming no UI, SQLite, provider, or model dependency in the contracts.

## D2: Device registry and capability broker

### Scope

- [x] Add device registration, revocation, health, and capability snapshot storage.
- [x] Resolve a stable device id independently from addresses and transport handles.
- [x] Load adapter manifests and reject incompatible contract versions.
- [x] Track capability support, current availability, and authorization independently.
- [x] Refresh stale snapshots after expiry and changes to connection, firmware, adapter,
  or authority. Recheck target identity and prerequisites at dispatch.
- [x] Add target leases and bounded concurrency for device tasks.
- [x] Keep adapter crashes, malformed frames, oversized responses, timeouts and transport
  failures isolated from the daemon process where external adapters are used. The
  newline-delimited JSON process host discards a failed child, rejects all pending
  requests with a redacted category, and starts a fresh child for the next operation.
  The runtime accepts trusted external adapters and closes them with the Daemon.

### Exit evidence

- Fake device discovery and capability refresh test.
- Distinct offline, unsupported, and denied results. Revocation or a stale capability
  between approval and execution prevents dispatch.
- Concurrent task lease test. Where a write requires exclusion across hosts, test the
  target session or conditional write that provides it.
- External adapter crash and reconnect test through the real child-process fixture. The
  contract rejects malformed profiles, snapshots, receipts, observations and verification
  payloads before they reach the broker.

## D3: Task state, approval, verification, and evidence

### Scope

- [x] Add durable device-task transitions from creation through verification.
- [x] The device broker validates exact approval bindings. A durable device approval
  queue projects into the existing Ling approval list and decision routes. The task
  trace identifies the exact approval and the authenticated paired device that submitted
  it. Approval admission is recorded in the same owner journal transaction as the
  dispatch intent, so a rejected or busy admission does not create an approval fact.
- [x] Keep the original capability snapshots, policy revision, and applicable access
  grant and operator-stop revisions for task admission and reconciliation reads.
- [x] Show the target, capability and PC owner before a write and bind confirmation to
  the exact action and current revisions. Paired Mobile presents the side-effect class,
  target, capability and expected verification before its approval command. The Daemon
  rejects stale, foreign-subject, missing or expired verification evidence.
- [x] Persist dispatch intent and an attempt ID before invoking the adapter. The owning
  daemon checks task scope, current proposal, approval, and lease in the admission
  transaction. A stop before admission cancels the task. A stop after admission
  preserves the attempt as potentially effective and requests adapter cancellation.
- [x] Require verification for any action that claims to repair or configure a device.
- [x] Record action response, device verification, and user outcome independently.
- [x] Preserve unknown outcomes from interrupted dispatch, missing readback, authority
  changes and daemon restart. Exact retries return the prior attempt. A reconciliation
  read uses a current read-only capability, fresh target evidence and the owner's
  current connection revision. Late receipts cannot restore success after revocation.
- [x] Let a paired Mobile request PC readback for an unknown task. Bind the request to
  the durable attempt and the current PC capability snapshot. A renewed snapshot stays
  bound to the registered connection and its target.
- [~] Bind alternate-route plans for writes that can strand a previously reachable
  device to the exact approval, fresh baseline and verification deadline. The Daemon
  and standalone Mobile owners hold the target while checking the path and retain the
  plan and check time with the attempt. Gateway WebSocket and Ling Server peer
  clients with `ling.device-tasks.v4` display the plan before approving. Target
  rollback timers and physical recovery acceptance remain open.
- [x] Add redacted observations and artifact references to the existing audit/evidence
  model.
- [x] Ensure reconnecting clients read durable task state rather than infer cancellation.

### Exit evidence

- Recovery fixtures for daemon restart, client disconnect, cancel or revoke before
  dispatch, and stop or timeout after dispatch intent. Assert the dispatch count and
  subsequent outcome evidence.
- A signed Gateway session revokes a task while its approval command is waiting on
  the adapter. The stop persists immediately. Replaying the approval returns the
  recorded attempt. Its late receipt remains visible, and the task remains unknown.
- SQLite fixtures cover legacy lease migration and target exclusion during late
  verification. Thrown transport errors keep their stable error category and redact
  the transport exception text.
- A current PC snapshot and a fresh PC network readback can reconcile an unknown
  network repair exactly once. Stale snapshots, stale readback and a revoked target
  leave the task unresolved.
- An authenticated Gateway fixture exercises the v1 Mobile snapshot, v2 reconciliation,
  incorrect workspace and attempt bindings, renewal of an expired snapshot, unresolved
  readback followed by verification, and a request repeated after verification. The
  original write count stays at one.
- Focused broker and Gateway fixtures cover a wrong target, stale observation and
  missing readback evidence. The Mobile confirmation presents the target,
  side-effect class and supported network verification conditions. The owner trace
  retains the exact approval and its paired session.
- A SQLite upgrade fixture preserves the retained live snapshot and identifies missing
  earlier evidence. The Linux SSH reconnect fixture changes the configured address,
  restarts the Daemon, and reads the unchanged original task trace. The same device's
  new task has a distinct snapshot and connection revision. Gateway reconciliation
  links its refreshed readback snapshot to the original approval's paired session.
- Evidence fixture showing before and after state, verification, and user outcome. For
  each supported automatic recovery path, verify restoration of the recorded baseline
  after a simulated connection loss.
- Audit review confirming no secret or raw credential enters logs or artifacts.
- Core and Daemon fixtures cover an unavailable backup route, mismatched approval
  scope, stop during the route check, target exclusion and retained recovery evidence.
  Authenticated v4 routes display the plan and bind the confirming session in the
  owner trace. A repeated approval over WebSocket returns the same result. A v3
  session can still read the task journal. The phone fixture retains fresh, same-target
  readback in its own journal and preserves an unknown outcome for foreign readback.

## D4: Home Assistant adapter

### Scope

- [x] Register a Home Assistant adapter with explicit URL, authentication, and instance
  health configuration.
- [x] Discover the configured instance, its version, and the selected entity's
  availability. The authenticated loopback route
  `GET /v1/device-support/home-assistant/catalog?kind=devices|entities|services`
  reads the WebSocket device registry or the REST states and services endpoints.
  Each response includes the Daemon task ID and a page of up to 100 items.
  Pass its `nextAfter` value as `after` to continue.
- [x] Normalize selected entity availability into Ling facts and project catalog
  entries with stable typed IDs, availability, disabled state, or service target
  metadata. Duplicate, malformed, oversized and version-mismatched responses fail
  closed.
- [~] The read-only flow covers available, unavailable, and missing entities. The
  Daemon accepts an HTTPS or loopback HTTP origin and an env/keychain secret
  reference. An operator-supplied bounded report-age window now distinguishes
  fresh, stale, legacy, invalid, and future `last_reported` timestamps without
  exposing attributes. The integration diagnosis reports config-entry health and the
  registry's disabled state for the selected entity. Automation diagnosis reports
  current enabled state and the last trigger time when available.
- [x] Bind a reload proposal to the selected integration and verifying entity using
  the Home Assistant registry. The local Review Queue records one-time approval,
  then the Daemon runs the reload and verifies fresh entity availability.
- [~] Add further verified service actions, including bounded automation re-enable
  where supported. The configured Home Assistant adapter now reads integration
  state and automation registry identity, queues an exact approval for a disabled
  automation, invokes the official automation.turn_on service, and verifies
  automationEnabled true from a fresh entity readback. Changed registry identity,
  concurrent approval and a failed service response remain durable.
- [x] Preserve Home Assistant entity and service identifiers in evidence without exposing
  credentials.

### Exit evidence

- Fixture-based tests against a fake Home Assistant API.
- A separate macOS arm64 run against Home Assistant Core 2026.11.2 reloaded the
  built-in Sun integration, read back the available entity and reopened the
  12-event journal. Concurrent approval and restart replay retained one
  service call and one verified attempt. Denied approval created no attempt.
- At least one real local Home Assistant acceptance run.
  Home Assistant Core 2026.11.2 ran on macOS arm64 through the real REST API and
  authenticated Daemon route. The three software fixture entities produced
  available, unavailable and absent observations. Each task contained eight
  SQLite journal events and three trace spans. Credentials and vendor attributes
  were absent from the stored observations, event records and API report.
- The live Core fixture also exercised the device registry and paged entity and
  service catalogs through the authenticated Daemon API. All four pages matched
  their public typed observations after reopening SQLite.
- Action approval, verification, and rollback or safe-failure evidence.
- Automation recovery fixture on Home Assistant Core 2026.11.2 observed one
  automation.turn_on call, one verified attempt, and one retained task after
  Daemon restart. The diagnosis report exposed only the entity ID, integration
  state, enabled state and last-triggered timestamp. Registry and service private
  fields were omitted.
- Adapter fixtures cover normalized `last_reported`, `last_updated`, and
  `last_changed` values, bounded freshness windows, and invalid or future
  timestamps. Missing metadata preserves the legacy fact shape.
- Support matrix for Home Assistant and adapter versions.

## D5: PC adapter and target-side executor

### Scope

- [x] Define the Windows/Linux/macOS target-side executor boundary.
- [~] Implement inventory, process/service, network, log, and software-version
  observations. Local service diagnosis records loaded systemd units, jobs in the
  Daemon's launchd domain, or Windows services visible to the current user.
  `pc.inspect.processes` reads native process IDs and names with `ps` on Linux and
  macOS and `Get-Process` on Windows. `pc.inspect.logs` reads bounded severity and
  source metadata through journalctl, macOS unified logging, or Windows Event Log.
  The owner journal keeps normalized rows while reports and model context use typed
  counts. Unavailable and oversized results produce unknown-quality evidence.
  Installed software observations use bounded dpkg, RPM, Windows uninstall-registry,
  and macOS System Profiler metadata. Native field acceptance remains open.
- [x] Refresh the local PC capability snapshot on adapter upgrade. The device keeps its
  identity and the owner journal retains historical snapshot versions.
- [x] Expose typed repair actions instead of arbitrary shell execution.
- [x] Add a loopback-authenticated local PC diagnosis route that returns the structured
  read-only report and persists the daemon-owned task and observations.
- [~] Add least-privilege installation, pairing, update, revoke, and uninstall behavior.
- [x] Implement one low-risk repair flow with explicit verification.
- [ ] Establish a reproducible Windows network fault on a test PC or VM. Reproduce the
  diagnosis with read-only checks before exercising an approved reversible repair and
  retesting the original symptom.
- [x] Document target access and OS recovery prerequisites.

### Target access and recovery

- Local PC operations run on the target's Daemon with its current OS permissions. A
  paired Mobile session requests PC-owned operations through that target's Gateway.
- The [D8 Linux SSH adapter](#d8-additional-ecosystems) handles supported network reads
  when SSH is already running and the operator has enrolled the pinned target. WinRM
  operations require a compatible Windows adapter and an authorized WinRM endpoint.
- When the operating system cannot start, the operator uses the platform's documented
  recovery environment or a configured out-of-band management path. After recovery, the
  owning runtime refreshes target identity and connectivity before resuming device tasks.

### Exit evidence

- Adapter contract tests exercise Linux, macOS and Windows service status projection,
  empty and malformed results, and unavailable or oversized observations. macOS 27.2.1
  arm64 returned 549 jobs in its current launchd domain. The diagnosis report's state
  counts matched the normalized service observations after reopening SQLite.
- Native process fixtures exercise all three query formats, unavailable and empty
  results, cancellation and the evidence size limit. A macOS 27.2.1 arm64 run
  reported 990 processes and matched the rows after reopening the Daemon's SQLite
  journal. An adapter-upgrade fixture retains the version 1.0.0 snapshot and
  records a new version 1.1.0 snapshot for the same target.
- A macOS arm64 run using adapter and playbook version `1.3.0` recorded 200
  System Profiler application rows and marked the capped list as truncated. It
  also recorded 200 native error events. After reopening SQLite, both counts
  matched the report, and all five diagnostic observations remained readable.
- Windows OS acceptance with the known network fault. Record whether the test PC is
  physical or virtual and the recovery path used.
- Permission and uninstall checks.
- Before/after logs and verified task result.
- Explicit distinction between static package checks and field acceptance.

## D6: Mobile device-task facade

### Scope

- [x] Extend the Remote Gateway with a narrow device-task capability surface.
- [x] Reuse secure pairing, device identity, replay protection, and signed frames.
- [x] Add mobile read-only device list, capability, PC-owned recent-task status, task
  detail, and evidence projection through the negotiated ling.device-tasks.v1
  WebSocket subprotocol.
- [x] Add approval and revoke commands. Mobile creates a short-lived binding from the
  current paired session's preview. Gateway admission rechecks the proposal, current
  snapshot, policy revision and task owner before invoking the broker.
- [x] Negotiate `ling.device-tasks.v2` or later for PC-owned readback. The Gateway
  advertises the reconciliation capability and projects the eligible attempt.
- [x] Negotiate `ling.device-tasks.v3` for the PC-owned journal. Paired Mobile reads
  bounded pages in the selected task, resumes from the displayed cursor after
  reconnect, and reloads the journal when its generation changes.
- [x] Route eligible device-task messages through the Gateway allowlist and keep
  target credentials with the executing host. Legacy clients use the conversation
  protocol over the same Gateway.
- [x] Keep the daemon as the execution owner for this facade. D9 covers standalone
  Mobile and D11 covers collaboration on a phone-owned task.

### Exit evidence

- Protocol fixtures for device task creation, status, approval, and revoke.
- Mobile reconnect and resync tests show last known device/task state while offline and
  recover the original daemon task. Gateway fixtures verify workspace scoping and
  legacy-session capability isolation. Duplicate requests return the recorded result
  or pending attempt. Reusing an attempt key with a different action is rejected.
- Mobile shows the target and capability and asks the user to approve in the current
  session. The remote-client fixture verifies the exact approval binding, command
  frames, stale previews and capability checks. A stop remains available while an
  approval response is pending.
- Physical iPhone acceptance for the approved read-only and approval flows.
- Android compilation and emulator coverage; physical Android evidence remains separately
  reported until available.
- Expo production bundle export passed for iOS and Android using
  `corepack pnpm --filter @ling-stack/mobile exec expo export --platform all --output-dir "$LING_MOBILE_BUNDLE_DIR" --max-workers 2`
  with a temporary output directory. The Mobile package test suite passed 88 tests.

## D7: Playbooks and operator evidence

### Scope

- [x] Define playbook metadata, required capabilities, risk profile, expected evidence,
  and supported device profiles.
- [x] Add one Home Assistant offline-device playbook and one PC software-diagnosis
  playbook with local fallback metadata and read-only typed steps.
- [x] Project facts, hypotheses, actions, verification, and uncertainty into a shared
  report from the PC network/service and Home Assistant entity playbooks.
- [x] Check observation freshness, provenance, redaction and target binding in these
  templates. Preserve raw device text as observation references.
- [x] Provide a bounded local read-only flow that can collect redacted evidence when the
  model service is unavailable.
- [x] Add replayable fixtures for successful, failed, partial, and unknown outcomes.
- [x] Surface the structured report through the local daemon operator route. The model
  task projection remains a separate integration gate.

### Exit evidence

- Playbook contract tests.
- Fixture reports for each terminal outcome.
- Fixtures for incomplete observations, model outage, and device text that claims to
  grant authorization. Assert evidence and dispatch behavior.

## D8: Additional ecosystems

Each adapter is a separate scoped slice. The order below is a recommendation, not a claim
that support exists:

- [ ] Router and NAS APIs.
- [ ] Printer discovery, queue, driver, and network diagnosis.
- [ ] Matter, ESPHome, Zigbee, and BLE devices.
- [~] Linux network diagnosis through an authorized SSH adapter. The PC verifies
  a configured host key, persists the diagnosis and rechecks the binding after
  interruption or an endpoint change. Native Mobile SSH and real LAN and
  phone-hotspot acceptance remain.
  [PC-owned Linux SSH diagnosis](ling-device-developer-execution.md#pc-owned-linux-ssh-diagnosis)
- [x] Enroll PC-owned Android and head-unit targets using the local authorized ADB
  transport and a pinned hardware serial. Use the broker to journal OS and package
  diagnosis. Retain the device ID when the transport changes and bind the next task
  to the new connection revision.
  [PC-owned Android ADB diagnosis](ling-device-developer-execution.md#pc-owned-android-adb-diagnosis)
- [~] Android and head-unit development through a typed ADB adapter. A supplied
  development executor can expose scoped log, artifact installation and reboot
  operations. Verify DiPlay on a compatible parked vehicle using
  the [installation case](ling-device-developer-execution.md#5-case-flow-install-diplay-on-an-older-head-unit).
- [x] Connect configured PC ADB targets with an application log tag to the
  developer session's `logs` job. Capture on the pinned transport and preserve
  the job, attempt, and sensitive log observation for local retrieval.
  [PC-owned Android developer logs](ling-device-developer-execution.md#pc-owned-android-developer-logs)
- [x] Add a typed OBD vehicle adapter for vehicle identity, PID and DTC reads.
  Real OBD/OpenXC bridge and vehicle acceptance remain separate.
- [ ] Any vendor-specific adapter with a documented support matrix and authorization path.

For each adapter, record its own contract, simulator, permissions, support matrix, release
version, real-device evidence, and known unsupported models. No adapter is complete based
only on a successful install or a model response.

## D9: Standalone Mobile execution

### Scope

- [x] Reuse D1 device contracts and D3 task, approval, and recovery rules in a phone
  execution module that works without Gateway pairing. D6 and D9 have independent
  acceptance gates.
- [x] Add the native transport bridge checks for one documented device profile, including
  OS permission, target identity, connection revision, capability support and required
  transport permissions. Physical BLE/USB/LAN discovery remains a platform gate.
- [x] Define the Mobile native transport bridge boundary for BLE, USB, LAN and
  other platform transports, including discovery, OS permission gating, target
  identity checks, connection revisions and capability snapshots.
- [~] Run one setup playbook that reconnects a supported smart home device to Wi-Fi
  after explicit user confirmation. The reusable Mobile setup runner binds each
  write to an exact approval and requires a fresh target observation for readback.
  A BLE fixture verifies the approved write, journaled observation, unknown outcome,
  and no-redispatch retry behavior. Physical device provisioning remains open.
- [x] Add phone-owned Home Assistant automation recovery. A fresh observation of
  the disabled automation's configured ID, explicit confirmation and foreground
  authorization bind the action. The adapter verifies a fresh readback and retains
  the attempt on replay. [Operation](ling-device-developer-execution.md#phone-owned-home-assistant-recovery)
- [x] Provide a deterministic local read-only playbook runner for diagnosis when the
  model service is unavailable, using the same Mobile journal and attempt rules.
- [x] Expose phone-owned Home Assistant diagnosis before PC pairing and from the paired
  app. The Mobile HTTPS adapter reads a user-selected entity using the instance's
  trusted TLS endpoint and the supplied Home Assistant token. The phone records
  only the task and its typed availability evidence.
- [~] Expose phone-owned Linux diagnosis on Android. Pin the host key inside the
  handshake, use the entered credentials for the live session, and store
  enrolled endpoint metadata and typed task facts on the phone. App packaging,
  native iOS SSH and physical Android acceptance remain.
  [Phone-owned Linux SSH diagnosis](ling-device-developer-execution.md#phone-owned-linux-ssh-diagnosis)
- [x] Persist approval, action attempts, and redacted verification evidence on the
  phone. Preserve an unknown result after interruption until state can be checked.
- [x] The app applies native AppState transitions to the phone execution owner and
  recovers its journal on foreground entry. The execution module aborts
  foreground-gated writes when authorization ends.
  It journals late receipts, prevents concurrent dispatch to the same target, checks
  the live connection before dispatch, and finalizes a read-only playbook after all its
  steps.
- [~] Record the tested phone OS, device model and firmware, and transport. Each later
  phone platform or USB integration gets its own acceptance entry.

### Exit evidence

- Shared contract fixtures for capability checks, approval, and interpretation of
  verified and unknown results.
- The Mobile runtime fixture runs the Home Assistant playbook with no PC, Gateway or
  model service. It records unavailable and absent entity results, access denial and
  bounded response failures. Reopening a journal restores records and leaves an
  interrupted attempt unknown. iOS and Android production JavaScript bundles export
  successfully. This run had no available iOS simulator runtime or connected ADB device.
- The standalone Mobile runtime against Home Assistant Core 2026.11.2 on macOS
  arm64 used a trusted loopback HTTPS connection. Its journal recorded one
  `automation.turn_on` service call and one enabled readback. The request sequence
  was diagnosis GET, identity recheck GET, action POST and verification GET.
  A runtime reopen returned the same trace and did not contact the instance.
  The regression fixture also covers expired observations, changed identity,
  connection loss and a successful POST followed by an unavailable readback.
- A real phone and supported device complete the BLE flow with no PC or Gateway
  available. Exercise a local playbook while the model service is unavailable. The
  phone journal shows the approval, action, and verified result.
- On the accepted phone and device combination, denied permission, lost connection,
  and app resume leave the task in an accurate state and do not repeat a write.
- Evidence states whether the run used the local playbook or a model service and
  identifies the phone OS, adapter, and device firmware. Other OS or transport coverage
  requires its own evidence.

## D10: Developer device sessions

### Scope

- [~] Add standard and developer session entry points to PC and Mobile. Show the
  current workspace, external target, owner, and effective device authorization.
- [x] Expose a loopback-authenticated session entry point that creates a
  profile-and-connection-bound session, authorizes it with an expected revision,
  and reads existing durable workbench jobs. Standard sessions cannot admit
  developer jobs, and protocol workbench jobs retain the authorization revision.
- [x] Use the shared device contract for deploy, launch, test, and scoped diagnostics
  on an authorized development target. Bind package identity and the verified
  artifact to the approved device action.
- [x] Run a scoped Android log capture through the local developer job API. The
  fixture repeats the same job ID, reads the original log evidence through its
  session, and verifies that the shared trace omits the log text.
- [ ] Connect the operator's native workbench to supported, authorized SSH, ADB,
  and vendor maintenance tools. Record tool status, relevant evidence selected by
  the user, and readback after native maintenance.
- [~] Persist job identity and typed outcomes. Reattachment to a live build or
  test worker remains a runtime gate.
- [x] Make the Daemon coordinator use its SQLite store for session and job
  transitions. Commit each job with its session update and preserve the retained
  result on replay.
- [x] Recover daemon-owned build, test, deploy, launch, log, retest and live
  capture jobs left queued or running by a restart as `unknown`. Offline protocol
  imports remain retryable until their durable capture write succeeds.
- [x] Persist developer sessions, jobs, artifacts, phone-owned proposals and
  chunked artifact transfers in the shared daemon SQLite database.

### Exit evidence

- The SQLite fixture rejects a partial write of the job/session pair and recovers
  the accepted job and its unknown outcome across coordinator reopen.
- A supported app project completes build, install, launch, log collection, test,
  and retest through the developer entry point. Standard and developer sessions
  use the same task journal and outcome rules.
- Exercise an operator's target-pinned terminal session and a supported vendor
  maintenance handoff on a suitable device or vendor test fixture. Record the
  real-device evidence when available.
- Exercise a different artifact or target, expired authorization, injected device
  output, and a client disconnect while a supported job runs.

## D11: PC-assisted Mobile execution

### Scope

- [~] Define the contracts for an opted-in phone-owned task projection, PC proposals,
  scoped artifact transfer, and Mobile receipts. Signed transport and the Mobile
  journal integration remain open.
- [x] Keep project actions bound to the PC workspace and device actions bound to
  the phone's verified target and local authorization.
- [~] Resume the owner's journal from an acknowledged revision or a refreshed
  snapshot. Preserve known and uncertain attempt outcomes after either link fails.

### Exit evidence

- Physical Linux SSH diagnosis and compatible head-unit installation exercise the
  phone-only and paired PC assistance cases. Include a PC build or artifact
  transfer verified by the phone.
- Changing the connected target, revoking collaboration, or replaying a proposal
  leaves accepted actions and their execution ownership intact. Both peers show
  the phone's eventual verification state.

## D12: Ling Server connectivity

### Scope

- [~] Implement the self-hosted Ling Server control API, enrollment, presence,
  rendezvous, server identity, peer epochs, revocation, and metadata persistence.
  A paired Mobile signs a route request and Gateway polls the same binding.
  The application key signs the challenge-bound response and the Gateway renews
  active authority with signed poll receipts. Field deployment remains open.
- [x] Persist installations, peer bindings, route attempts, revocation epochs, and
  route state in SQLite, with daemon restart recovery fixtures.
- [x] Persist the logical peer session contract, route-generation changes, ordered
  frames, command receipts, and directional resume cursors with idempotency checks.
  Current peer epochs fence admission and replay. Frame and sequence persistence
  use one transaction. Configuration binds the two fingerprints to the peer roles.
- [x] Add a negotiated reliable DataChannel mode with a fixed channel ID for native
  Mobile WebRTC runtimes that omit incoming-channel reliability metadata. The existing
  in-band mode remains the default for browser and Pion paths.
- [~] Exchange signed WebRTC signaling on registered routes with role-specific
  key proof, replay protection and expiration. The Remote Client verifies the
  paired peer and route scope before applying SDP and ICE candidates. The Daemon
  uses its Pion worker and Mobile uses the React Native WebRTC adapter. Verify
  installed mobile runtimes, direct LAN and cross-network ICE, and configured STUN.
- [~] Issue short-lived coturn REST credentials for an active binding, role and
  registered relay route. The local operator API bounds issuance by route expiry
  and an in-process quota. Embedded WebRTC receives all configured TURN listeners
  in one credential domain and can use TLS/TCP when UDP is unavailable.
  Verify allocation behavior and TURN/TLS on TCP 443 in the deployed coturn stack.
- [~] Carry Gateway conversation, developer-collaboration, and device-task messages
  over the same peer session contract. The Gateway authenticates using the paired
  keys and signed SDP digests before it serves workspace projections and task journal
  pages on the channel. Signed v4 signaling enables recovery approvals on the same
  channel. Replacing the route retains the pairing and PC journal.
  The native fixture verifies conversation and owner-journal continuity across the
  original route deadline and a PC restart. Live collaboration and artifact lanes remain open.
- [~] Start the single-node control service with the `ling-server` binary,
  SQLite, a TLS peer listener, and a separate loopback admin listener. Packaging
  coturn and verifying a scaled deployment with PostgreSQL and relay affinity
  remain open.
- [~] Add diagnostics for control reachability, candidate paths, selected route,
  peer handshake, cursor resume, relay quotas, and revocation. Typed ephemeral
  transport configuration and redacted route diagnostics are available through the
  self-hosted control plane; native ICE/WebRTC and relay measurements remain open.
- [~] The Gateway prepares and locally confirms a versioned Ling Server profile
  against the existing PC-mobile pairing and retained command receipts. It signs
  the confirmed record with the existing Gateway key and persists it across restart.
  The authenticated Ling Server admin API verifies the signed confirmation and
  commits the exact peer binding and publication together. The paired PC exports the
  record and the Mobile confirmation stores a profile after proving the server's
  application key against the active publication. The Gateway reloads the confirmed
  profile after restart, and the Mobile connector uses it to request a signed route.

### Exit evidence

- A public listener fixture creates a direct route from the signed Mobile
  request and returns it to the signed Gateway poll. It rejects wrong-role keys,
  modified requests, replayed nonces, expired offers, stale installation revisions
  and revoked peer epochs. Remote Client fixtures validate both signatures,
  enforce the signaling instance, negotiate the fixed native channel ID, and
  exercise the authenticated Gateway WebSocket fallback.
- On macOS arm64 with Node 22.22.1 and Go 1.26.3, the Mobile connector and the
  Daemon Gateway used two Pion workers over a local TLS Ling Server. The session
  remained usable beyond the original negotiation deadline. Reopening the PC
  owner store and Gateway resumed the conversation and the same device task
  from journal sequence 2 while retaining the original attempt IDs. Revoking the
  server binding closed the channel and the next route request returned HTTP 403.
  Mobile tests exercise relay selection and Gateway fallback after unavailability,
  plus rejection of an invalid application signature and an HTTP redirect.
  [Native peer fixture](../../packages/daemon/test/ling-server-native-peer.test.ts)
  [Mobile connector fixtures](../../apps/mobile/test/mobile-ling-server-peer.test.ts)
- The Desktop package configuration builds, includes, and resolves the native
  executable with its build metadata and licenses. Linux CI builds and transports
  the worker in the shared build artifact. Desktop resource and Daemon launch
  fixtures passed, and the macOS source projection exercised real esbuild. The
  full macOS release build requires its reviewed source record and toolchain.
- The local control fixture checks peer key mismatch and revoked route selection.
  Core fixtures cover two-direction replay after reopening SQLite, route cutover,
  revocation from a separate registry instance and rollback when the cursor write
  fails. These exercise logical sessions and the HTTP control interface.
- Two isolated Chromium contexts use the built Remote Client, Ling Server TLS
  signaling, ephemeral P-256 keys and a loopback Pion TURN/UDP service. Both
  endpoints report a selected relay-to-relay pair and connected DTLS. Each
  ordered channel receives the other endpoint's three messages in order. The
  fixture registers the binding directly and accepts its loopback certificate
  only in the test contexts. Host-candidate ICE stalled on this machine for
  both the Ling path and a bare Chromium WebRTC comparison.
- A subsequent loopback test attaches the real Daemon Gateway to one Chromium
  endpoint via a local fixture transport and runs the built Remote Client in the
  other endpoint. The client authenticates through the DataChannel, receives the
  workspace snapshot and uses a task-local cursor to read the next SQLite event.
  The selected ICE pair uses UDP relay on both ends. Gateway tests exercise
  mismatched route proofs, replacement, lease expiry and a Gateway stop and
  restart, with the same owner journal and one original device write.
- Two isolated Chrome contexts used a Pion TURN/UDP loopback relay for a signed v4
  Gateway session. The built Remote Client displayed the alternate recovery path,
  sent the exact approval, and read 16 ordered events from the PC owner's journal.
  The fixture adapter received one route check and one write, followed by verified
  target readback. Both selected ICE candidates were relayed and DTLS was connected.
- Two Chromium contexts negotiated with the built Remote Client and signed Ling
  Server signaling on macOS arm64. A loopback UDP listener received and discarded
  the requests for the first advertised TURN URL. Both endpoints selected
  relay-to-relay ICE with TLS client-to-relay legs on a local Pion listener and
  reported connected DTLS. Each received the other endpoint's three messages in
  order. The Remote Client tests also cover a stalled signaling request and
  cancellation while a platform SDP operation is pending. A late completion
  publishes no answer.
- The Gateway management fixture confirms a migration for its current device,
  verifies the signature against the pinned Gateway key, and reopens SQLite to
  retrieve the same decision. A retained command returns the original message ID.
  Fixtures reject incompatible profiles, changed key or epoch, foreign or changed
  receipt references, altered confirmation digests, expired previews and revocation.
- The Ling Server admin fixture publishes the Gateway's confirmed record. It
  rejects a foreign key, altered receipt and epoch, expired first publication and
  a changed installation revision. A forced publication write failure rolls back
  the binding. An exact retry after restart retains the same receipt, and a revoked
  binding stays revoked.
- The paired Desktop settings prepare, review and export the signed confirmation.
  IPC tests check the trusted main document and local management boundary. The
  Mobile settings accept the signed record and store the verified routing profile.
  A loopback HTTPS run exercised the Gateway confirmation, administrative
  publication, Ling Server SQLite restart and the Remote Client's pin verification.
  Reopening the saved binding retained the profile and original pairing. Revocation
  denied a subsequent proof, and the validation wrote no conversation cache data.
- Test a reachable LAN, a direct connection across networks, and a NAT/firewall
  fixture requiring the Ling Relay. Include route switching during live conversation
  and device-task sync and a server outage with local execution available.
- Verify peer-key mismatch, unauthorized relay access, credential expiry, peer epoch
  revocation, malformed frames, and oversized data. Verify that the relay cannot
  read peer payloads and that reconnect resumes the same task without dispatching
  a second attempt.
- Run the complete acceptance matrix in the
  [Ling Server Connectivity design](ling-server-connectivity.md) with no Tailscale,
  Headscale, NetBird, or hosted relay account installed.

## D13: Hardware protocol development and debugging

### Scope

- [~] Daemon developer sessions pin offline replay to the target, codec and profile.
  An authenticated local session can also capture through a registered transport
  bound to the selected target and connection revision. Native drivers and
  standard-session diagnosis remain open.
- [x] Keep the hardware transport, protocol codec, and versioned device profile
  independently reusable. The Core live-transport boundary accepts platform-owned
  USB, BLE, serial, RS-485, CAN, OBD or vendor bridges without importing their APIs.
  It bounds capture duration and frame count, validates frame bytes and timestamps,
  and records connection loss or capture truncation as replayable loss metadata.
  Record the verified host, adapter and firmware combination.
- [x] Capture request and response evidence, support offline decoder replay and
  simulator fixtures, and preserve provenance and capture loss. The configured PC
  serial transport pins the USB adapter identity and reads the documented Modbus
  register range through the developer workbench.
- [x] Persist codec manifests and validated protocol captures so replay evidence
  survives a workbench or daemon restart.
- [x] Register the built-in Modbus profile and codec as a read-only hardware
  adapter. Standard device diagnosis can run the configured register read through
  the same broker, task journal and conformance projection as PC and Linux checks.
- [x] Support offline Modbus RTU register request and response decoding, exception
  replies and CRC diagnostics. Validate all capture frame digests before decoding or
  invoking any replay callback. Persist capture loss independently of frame integrity.
- [x] Register the built-in replay profile and codec through the protocol catalog.
  Vendor register maps and additional standard-session operations require bench evidence.

### Exit evidence

- Core and Daemon fixtures decode a captured register response, distinguish an
  invalid wire checksum from a changed evidence digest, and restore the capture
  and its loss metadata after reopening the runtime.
- Test a documented RS-485 Modbus RTU device on supported PC, Android USB, and
  iPhone local-bridge paths. Capture and decode a measurement, verify a documented
  setting, and read back the exact target.
- Replay normal and failed communications offline. Show the cause supported by
  the trace, capture completeness, and the same decoded results across supported
  hosts. Test disconnection and task reattachment.
- Complete the external-device workflow on Mobile without a PC. In a paired
  run, the PC analyzes shared evidence while Mobile owns the target connection.
- Complete the same measurement through the registered adapter in a standard
  session. Track later protocol families against their own field evidence.
  [Workbench design and sources](ling-hardware-protocol-workbench.md)

## D14: Semantic device graph and twin

### Scope

- [x] Add stable device, component, connection, relationship, location, and
  ownership records. Keep transport aliases separate from stable identity.
- [x] Persist graph nodes, relationships, and Twin revisions in the device fabric
  store, with containment-cycle and revision checks. The local operator route
  projects graph and Twin status for devices registered in the default workspace.
- [x] Project enrolled devices before a semantic graph record has been created.
  The local graph view derives the node ID from the enrolled device identity.
  The ADB fixture verifies the same node after reconnect with a changed
  connection revision.
- [x] Add semantic capability verbs with protocol implementations, support ranges,
  freshness, side effects, approvals, prerequisites, and verification. The resolver
  projects a workspace-scoped target view and distinguishes available, unsupported,
  stale and unavailable capabilities before planning.
- [x] Add reported, desired, pending, and verified twin views with provenance and
  freshness. Preserve unknown state after interrupted writes.
- [~] Store graph identity merges and splits against an accepted evidence reference.
  The change record carries the source, observation time, authority, revision and
  an operator confirmation digest when applicable. The store preserves the original
  result across later revisions and reopen. Adapter evidence collection and operator
  confirmation in the clients remain open.

### Exit evidence

- A PC, phone, Android head unit, vehicle bridge, hardware bridge, and smart-home
  entity resolve through one fixture model with explicit relationships.
- Stale, conflicting, revoked, and aliased identities remain distinct until their
  merge evidence is accepted. Twin projections converge after reconnect.
- A semantic verb maps to multiple adapters without changing task state or approval
  contracts.

## D15: Cross-device task graph

### Scope

- [x] Add parent graph, node, edge, target binding, node owner, precondition,
  approval, attempt, verification, recovery, and evidence contracts.
- [x] Persist validated task graph revisions and restore graph state after a store
  reopen.
- [x] Persist target owner leases with expiry and reject stale graph revisions or
  competing owners after coordinator restart.
- [~] Coordinate PC, Mobile and Linux edge nodes over their authorized device links.
  Preserve per-node ownership. Use the declared coordination mechanism for shared
  target and bridge leases.
- [x] Record partial results and graph stop requests. A dispatched node keeps its
  attempt and unknown outcome until the owner supplies terminal evidence. The
  coordinator can retry failed admission before dispatch.
- [x] Validate an owner receipt against the current stored graph, the node's
  target, capability snapshot and attempt, and the authenticated owner and
  route generation supplied by the receiving runtime.
- [~] Connect receipt ingestion and reconciliation to authenticated peer routes.

### Exit evidence

- The head-unit case exercises a PC artifact and a phone-owned app deployment.
  The home case connects a home entity and local hardware observations through a
  device identity and verifies the outcome. Both use the same graph contract.
- A PC disconnect, phone foreground loss, target reboot, duplicate proposal, and
  failed verification preserve graph ownership and node receipts.
- The parent result distinguishes verified success, partial progress, failure, and
  unresolved outcome.

## D16: Edge Runtime and bridge contract

### Scope

- [x] Define runtime enrollment, key proof, target discovery, local journal,
  connection handles, health, cancel, capture, upgrade, and revoke.
- [x] Persist edge runtime enrollment revisions and cross-layer trace spans in the
  device fabric store. The local operator can read runtime health and revision
  summaries from the owning Daemon.
- [x] Persist a sequenced per-runtime, per-owner-task journal with transactional
  append, idempotent entry replay and explicit unknown outcomes across process restart.
- [x] Evaluate and persist a placement decision against the current enrollment in
  one SQLite transaction. Bind the decision to the owner task, target, capability,
  runtime revision and evaluation time. A repeated decision keeps the original
  record. Pending and revoked runtimes produce a blocked decision.
- [~] Use recorded placement for Linux Edge dispatch, offline recovery and phone
  hardware bridge execution.

### Exit evidence

- The SQLite fixture records an offline recovery decision, reopens the store,
  and returns the same record on retry. It distinguishes targets that share a
  task and capability. Revocation produces a new blocked decision and the earlier
  decision remains available by ID.
- An edge runtime reconnects after process restart and resumes its journal without
  replaying a mutating action.
- Phone and PC can inspect the same runtime health, capability snapshot, and
  verification evidence.
- Revocation stops new dispatch and expires the runtime's active leases.

## D17: Event and telemetry plane

### Scope

- [x] Define the event envelope fields for stream ownership, generation, sequence,
  freshness, quality, provenance, redaction class, evidence references, and retention class.
- [x] Persist bounded owner event streams with replay-by-event-id, stale-cursor
  rejection, gap reporting, and a materialized snapshot cursor.
- [x] Add a reusable event projector that resumes from a persisted snapshot,
  applies contiguous deltas, and returns an explicit resync requirement for stale
  cursors or sequence gaps.
- [~] Project task state, plan, attempt, verification and public evidence from the
  append-only Daemon task journal. The local route and Gateway provide the current
  task and a bounded page by task sequence. Health, capability, resource and high-rate
  telemetry producers remain open.
- [x] Add Core peer snapshot exchange for a materialized owner stream. The
  receiving session binds the stream and generation. The snapshot cursor advances
  monotonically, and the projector can apply the next delta after a missing range.
- [x] Connect the bounded owner journal to the packaged Mobile client. The typed
  journal watcher starts from a supplied cursor, advances only after a validated
  page, restores a fresh snapshot after a generation or cursor gap, and cancels
  its subscription when the screen unsubscribes. Mobile uses bounded page refresh
  against V3/V4 Gateways and receives acknowledged pushes on V5.
  The Mobile task log uses this watcher alongside its explicit page controls.
- [~] Add backpressure, sampling and telemetry policy for high-rate producers.

### Exit evidence

- A local daemon serves the report and journal through direct loopback access.
  Core fixtures interleave other tasks while keeping the queried task's cursor
  contiguous and hiding private evidence references. An old generation requires
  the current snapshot.
- An authenticated Gateway loopback test resumes the same event sequence after
  reconnect and matches the local journal. It rejects journal reads on v2,
  rejects other workspaces and phone-owned tasks, and retains public readback
  references while omitting private observations and internal task fields.
- A state gap recovers from a retained range or current snapshot. A duplicate
  event does not change state. The Core fixture installs a scoped peer snapshot,
  resumes at its next delta and rejects a different payload at the same cursor.
  An older snapshot replay preserves the latest materialized state.
- The Remote Client watch fixture advances to the last delivered event, handles
  a duplicate and a stale cursor, and ignores pages after unsubscribe. The
  Gateway holds subsequent pushes until ACK. Ling Server control and Gateway
  fixtures pass, and the iOS and Android production JavaScript bundles export.
- High-rate sensor data is sampled or expired according to policy while task and
  revocation events remain durable.
- Model context receives the source, time, freshness, and provenance of each fact.

## D18: Resource and adapter registry

### Scope

- [x] Add digest-bound resource installation, optional signature verification,
  active revision persistence, and rollback history for adapter resources. Commit
  the payload and active revision together. Verify the active payload digest on read.
- [x] Enforce declared contract, license, platform, device, firmware and permission
  compatibility where runtime facts are available, and persist disable/health state.
- [x] Accept signed resource manifests for transports, codecs, profiles, vocabulary,
  playbooks, simulators, captures, documentation, firmware metadata, and edge
  packages through the shared resource contract.
- [~] Validate digest, signature, license, dependency, platform, device, firmware,
  permission, and Ling contract compatibility.
- [~] Import, update, disable, and roll back signed resources through the local
  Daemon API. Runtime health checks and activation for Mobile, native adapters
  and Edge packages remain open.

### Exit evidence

- Mobile activates a compatible data profile and fixture. Native Mobile
  components enter through the signed app build. PC validates a supported native
  adapter installation. Record resource revisions and artifact digests.
- A failed update restores the last verified resource without deleting task evidence.
- A SQLite fixture rejects a partial activation and preserves the working version.
  On reopen, rollback requires the retained bytes and their matching digest.
  Importing the original verified payload fills an older metadata-only active record.
- An unsupported license, dependency, platform, or firmware range blocks installation.
- The local Daemon fixture signs real bytes with Ed25519, activates and replays
  a valid import, installs a second revision, and rolls back to the original
  digest. Altered manifests, altered bytes, unknown signers, disallowed licenses,
  incompatible platforms and missing dependencies are rejected. Core fixtures
  verify that a revoked signer blocks reads and rollback.

## D19: Safety, policy, and secrets

### Scope

- [x] Declare action prerequisites in the safety policy. The evaluator checks
  target identity, observation age, policy revision, physical state, controller
  readiness, controller evidence and secret references.
- [x] Persist the local operator's Daemon dispatch stop. Activation blocks new writes
  and journals the stop for any leased task on the selected target. The owning
  adapter receives a cancellation signal. Clearing the stop leaves an interrupted
  attempt unresolved until its owner reconciles it.
- [x] Add a target-scoped secret broker and auditable secret-use references without
  persisting secret contents.
- [x] Accept certified-controller and vendor-workflow readiness evidence with a
  target, capability, policy revision, operator handoff digest and expiry. Store
  only the evidence references and digests. A critical adapter action still cannot
  substitute for the controller or vendor workflow.

### Exit evidence

- Parked head-unit app deployment and supported home and hardware configuration
  fixtures exercise condition, authority and verification checks. Safety-critical
  cases exercise the operator handoff and record the observable evidence.
- Model-visible observations cannot grant authorization or reveal secret contents.
- The Core safety fixture accepts an unexpired controller evidence record, rejects an expired record, and the SQLite fixture reopens the same evidence without any secret material.
- Cancellation, revoke, and failed recovery produce an auditable state.

## D20: Fleet and lifecycle

### Scope

- [x] Persist revisioned lifecycle transitions and reject invalid or regressing
  state changes.
- [x] Persist ownership transfer revisions and retain the previous owner history
  for task and evidence continuity.
- [x] Persist target-scoped access grants for shared read-only and developer scopes,
  with capability allowlists, expiry, revocation and revision fencing.
- [x] Persist credential rotation and revocation revisions with secret references and
  fingerprints only. Credential contents remain outside the device fabric store.
- [~] Track enrollment and ownership revisions, profile and runtime versions,
  operational health, maintenance and retirement.
- [x] Retire a local registration against its current profile and connection
  revisions. The owner commits retirement, capability invalidation and the stop
  of a leased attempt together. Historical task evidence remains readable.
- [~] Expose shared read-only and developer access grants through an authenticated
  local workflow. The grant route enforces target and capability binding, revision
  CAS, exact replay, and durable revocation. Ownership transfer, credential rotation,
  profile restore, upgrade and rollback workflows remain open.
- [~] Add fleet health and compatibility projections by runtime, adapter, profile,
  firmware, and target.

- [x] Expose a deterministic, workspace-scoped Fleet health projection from the
  Daemon. Device and Edge Runtime last-seen times retain their own sources. A
  matching capability observation updates device freshness.

### Exit evidence

- Transfer a device between users or workspaces without losing its task history.
- Rotate credentials, revoke an edge runtime, upgrade an adapter, and restore the
  previous verified revision.
- The authenticated Daemon test retires its local PC registration. Fleet reports
  the retired status without a live snapshot. A fresh diagnosis is denied and the
  original trace, capability snapshot and conformance report remain readable after
  reopening SQLite. A broker fixture preserves the unknown outcome and late
  receipt of a write during retirement and prevents another dispatch.
- The authenticated local grant fixture creates a read-only grant, rejects an
  incompatible write capability, upgrades it to a developer grant, replays the same
  request without a second history row, and revokes it durably. A stale revision,
  foreign target, foreign origin, expired grant, and cross-target grant identifier
  are rejected.

## D21: Model context and orchestration

### Scope

- [x] Build bounded context packs from target relationships, capability snapshots,
  state, evidence, policy, safety facts, freshness, and context budget. Context
  includes target profile and connection revisions, semantic capabilities, dispatch
  stop state and fact metadata. Stale or unprojectable observations stay outside
  facts, and the builder enforces the serialized byte budget.
- [x] Build Daemon planning input from the owning task, current target snapshots
  and journaled evidence in the same workspace. Project the supported diagnosis
  fields and preserve the source and freshness of each fact.
- [x] Preserve trusted fact provenance, observation time, freshness cutoff, quality,
  and redaction metadata while keeping stale, sensitive, and textual output outside
  model facts.
- [x] Validate typed model or local-playbook proposals against the bound context,
  target scope, capability catalog and dependency graph, and report nodes that need
  user approval without creating execution evidence. Check each node's owner,
  target-specific capability snapshot and supplied evidence references.
- [x] Connect Pi to typed device diagnosis proposals in the owning Daemon.
  The PC and Linux diagnosis routes use Pi to select steps from the target-bound
  playbook when the operator chooses a configured provider. The owner checks the
  current snapshot before recording the proposal and dispatching. Model service
  failure uses a recorded local fallback.
- [x] Permit an active diagnosis request to name a different fallback provider.
  A runner outage rebuilds the context, records the source provider, destination
  provider and handoff reason with the accepted plan. The owning task dispatches
  only the steps from that plan.
- [~] Connect project builds and cross-runtime planning to the same owner and
  graph journal.
- [x] Record the PC diagnosis playbook plan in the task journal before its first
  device attempt. Preserve cancellation when a planning request is interrupted.
- [x] Keep graph and node authority attached to the owning journals when PC or Mobile
  changes planners. Rebuild the context pack for the selected provider. Acceptance
  rejects a foreign owner, target, snapshot, runner revision or planning reference,
  and the owner journal keeps the accepted graph before dispatch.
- [x] Treat device output, logs, captures, and vendor text as untrusted observations.
  Only current public observations with a matching typed capability projection enter
  model facts. Other output remains an untrusted reference or uncertainty.

### Exit evidence

- The local PC diagnostic entry writes an accepted playbook graph before dispatch,
  and its owner can rebuild scoped facts from the journal. Tests reject foreign
  devices, planning references, owners, execution claims, and expired snapshots.
- A cross-device goal produces a typed graph instead of unscoped tool calls.
- Context budget and redaction fixtures exclude unrelated devices, credentials,
  unbounded logs, and observation instructions.
- The model service outage runs the declared local playbook and records the source.
- The fixture takes the selected provider offline and exercises the configured
  fallback through the Daemon API. The fallback contributes the accepted plan to
  the original task. Reopening SQLite reproduces both provider identities, the
  refreshed context ID and the outage reason in the task trace.

## D22: Observability and conformance

### Scope

- [~] Propagate conversation, graph, node, attempt, device, runtime, connection,
  adapter, resource, event, and model-turn identifiers. Daemon dispatch persists
  the adapter and profile revisions. The PC and Linux diagnosis paths bind each
  step to a recorded plan node before dispatch.
- [x] Persist runtime trace spans by trace identity so a daemon restart can rebuild
  the recorded execution path.
- [x] Persist validated conformance reports with unique checks and evidence refs for
  reproducible runtime and adapter verification.
- [x] Project the Daemon task trace from the durable owner journal. The local
  workspace-scoped read preserves interrupted attempts and links any later
  readback to the same attempt.
- [x] Project phone-owned task journals into the shared trace contract after
  restart. The Mobile export preserves attempt, adapter, profile, transport,
  connection, verification, and public evidence references. The standalone
  screen offers an explicit share action for Linux and Home Assistant records.
- [~] Add simulator, protocol replay, hardware-in-loop, network interruption, process
  restart, resource rollback, and physical acceptance reports.
- [~] Capture reproducible conformance reports from Daemon attempts. The report
  binds the owner journal sequence, target, adapter, profile and available
  firmware, transport and model-turn evidence. Mobile, Edge and field network
  reporters remain open.

### Exit evidence

- One trace links a user request to model plan, task node, runtime call, protocol
  evidence, target state, and final verification.
- Verify no duplicate dispatch and correct reconciliation after interrupted writes.
- Verify the parked-head-unit and home sensor case set across PC, Mobile and edge
  hosts, with each physical target result tied to its own attempt and evidence.

## Per-slice evidence ledger

Update this table in the same PR that changes a slice status.

D14–D22 share the design verification for Markdown links, license policy, public
repository checks, and Mermaid rendering. Runtime and physical acceptance are
recorded per slice as they complete. [Detailed design](ling-device-fabric.md)

| Slice | PR / commit | Validation command or run | Evidence link | Result boundary | Remaining work |
| --- | --- | --- | --- | --- | --- |
| D0 | #730 | Documentation and link checks | [PR #730](https://github.com/ling-stack-org/ling-stack/pull/730), [Runtime contract](ling-device-support-platform-runtime-contract.md) | Architecture and tracking only | All runtime slices |
| D1 | `66ee1fbdb` | `corepack pnpm --filter @ling-stack/contracts typecheck` and `test` | [contracts/device.ts](../../packages/contracts/src/device.ts) | Core contracts, validators, transport deployment metadata, and fake adapter fixtures are implemented | Adapter package extraction and cross-process conformance remain |
| D2 | `b21089541` | `corepack pnpm --filter @ling-stack/contracts build:ci`; `corepack pnpm --filter @ling-stack/core build:ci`; `corepack pnpm --filter @ling-stack/daemon build:ci`; `corepack pnpm --filter @ling-stack/daemon typecheck:ci`; `node --test packages/core/test/device-support.test.ts packages/daemon/test/device-support-adapters.test.ts` (35 passed) | [device-support.ts](../../packages/core/src/device-support.ts), [external-process.ts](../../packages/daemon/src/features/device-support/adapters/external-process.ts), [runtime.ts](../../packages/daemon/src/features/device-support/runtime.ts) | Registry ownership, revocation, lease migration, refresh fencing, current capability snapshots, stable identities, broker dispatch, and crash-isolated external adapter execution are covered by fixtures | External adapter package signing, production resource activation and field acceptance remain |
| D3 | `a8c56cb0f`, `fef748002` plus durable device approval queue | Contracts/Core/Daemon typechecks. Home Assistant approval queue fixture passed with restart, stale target, denial, concurrent approval and interrupted receipt cases. Existing Core broker, Gateway and Mobile recovery fixtures remain green | [Approval queue](../../packages/daemon/src/features/device-support/approval-queue.ts), [Device journal store](../../packages/core/src/storage/sqlite/device-support-store.ts), [Queue fixture](../../packages/daemon/test/device-support-runtime.test.ts) | Device proposals are projected into /approvals, bound to target, snapshot, connection, policy, normalized input and idempotency key. Local default-workspace decisions dispatch at most one attempt, and late or interrupted results stay durable | Target rollback timers, physical alternate-route recovery and paired Mobile UI acceptance remain |
| D4 | de0f2b111, approved reload and automation recovery | Contracts/Core/Daemon builds and typechecks. The focused Core and Daemon suites passed 53 tests. Home Assistant Core 2026.11.2 on macOS arm64 verified REST, WebSocket registry, integration state, and one approved automation enable with an independent entity readback | [Adapter](../../packages/daemon/src/features/device-support/adapters/home-assistant.ts), [Approval route](../../packages/daemon/src/features/device-support/routes.ts), [Runtime fixture](../../packages/daemon/test/device-support-runtime.test.ts) | The adapter distinguishes unavailable, stale and absent entities, reports selected integration state, and binds automation recovery to its registry ID. The live fixture recorded one automation.turn_on call, one verified attempt, two concurrent approvals sharing one write, and restart replay. Credentials, private registry fields and service attributes are omitted | Additional Home Assistant service actions and broader field acceptance remain |
| D5 | `4b35180dd` plus native service, process, log, and software diagnosis | Contracts/Core/Daemon builds and typechecks. Focused Daemon adapter suite (37 passed), Core diagnosis suite (50 passed), and Mobile/remote regression suites. macOS, Linux, and Windows parser fixtures cover bounded severity, source metadata, package-manager inventory, and path redaction | [PC adapter](../../packages/daemon/src/features/device-support/adapters/pc.ts), [Executor fixtures](../../packages/daemon/test/local-pc-executor.test.ts), [D5 acceptance](#d5-pc-adapter-and-target-side-executor) | The PC playbook reports service, process, native log, and installed-software counts. The owner journal retains normalized rows and explicit unavailable observations. An upgrade refreshes the capability snapshot and preserves earlier snapshots. | Linux and Windows native field acceptance, reversible network repair field acceptance, target executor installation and removal remain |
| D6 | Paired readback and owner journal | Remote Protocol and Remote Client builds, typechecks and tests (43 and 13 passed). Mobile typecheck, 98 tests and both Expo JS exports passed | [Device facade](../../packages/daemon/src/features/remote-access/device-facade.ts), [Mobile journal](../../apps/mobile/src/features/device-tasks/PcDeviceTaskJournal.tsx), [Client fixtures](../../packages/remote-client/test/client.test.ts) | Paired Mobile can check status, approve, stop, request fresh readback, and page through the PC-owned journal. The client binds journal replies to the authenticated session, workspace, task and cursor | Detailed approval presentation and packaged PC/iPhone/Android acceptance remain |
| D7 | `56e112a84` | `corepack pnpm --filter @ling-stack/core build:ci`; `corepack pnpm --filter @ling-stack/core typecheck:ci`; `node --test packages/core/test/device-support.test.ts packages/daemon/test/device-support-runtime.test.ts` | [device-playbooks.ts](../../packages/core/src/device-playbooks.ts), [device-diagnosis.ts](../../packages/core/src/device-diagnosis.ts), [routes.ts](../../packages/daemon/src/features/device-support/routes.ts) | PC and Home Assistant templates project current typed facts, hypotheses, journaled outcomes and remaining uncertainty. The local daemon route returns a report after persisting its read-only task and observations | Model task projection and physical target verification remain |
| D8 | `fdb3b50f7`, `aa273a0ba` PC ADB enrollment and developer logs | Daemon build and typecheck, 25 focused Node 22.22.1 tests. The HTTP fixture uses a simulated local ADB process | [Linux SSH operation](ling-device-developer-execution.md#pc-owned-linux-ssh-diagnosis), [ADB diagnosis](ling-device-developer-execution.md#pc-owned-android-adb-diagnosis), [ADB log capture](ling-device-developer-execution.md#pc-owned-android-developer-logs), [Runtime fixture](../../packages/daemon/test/device-support-runtime.test.ts) | The PC enrolls the target by hardware serial and journals its OS release and package count. Reconnect keeps its device ID and updates the connection revision. The developer session records one capture per job ID and retrieves the local log. The adapter rejects a changed transport, tag, fingerprint or oversized capture | Native app deployment, OBD/OpenXC bridge and physical device, hotspot and parked head-unit acceptance remain. ADB 37.0.1 reports an empty target list on the macOS test host |
| D9 | `52d415e47` plus phone-owned Home Assistant automation recovery | Mobile typecheck and suite, iOS/Android Expo JS export, and a live Home Assistant Core 2026.11.2 HTTPS loopback | [Setup runner](../../apps/mobile/src/device/playbook.ts), [Mobile runtime](../../apps/mobile/src/device/standalone-runtime.ts), [Recovery fixture](../../apps/mobile/test/standalone-device-runtime.test.ts), [Operation](ling-device-developer-execution.md#phone-owned-home-assistant-recovery) | The setup runner binds approval to the active target and retains fresh readback evidence. Mobile records the verified Home Assistant recovery and reopens the journal without a duplicate write. The Android Linux SSH runtime retains its existing acceptance | Native phone UI and physical LAN/hotspot acceptance, Android Gradle packaging, iOS SSH and physical smart-home Wi-Fi provisioning remain |
| D10 | `313886185`, `28176297d`, `57ab0771e`, `5f7d318b6`, `aa273a0ba` and Android developer logs | Contracts/Core/Daemon builds and typechecks. Core developer and Ling Server suites passed 18 tests. Focused Daemon tests cover a disconnected job retry, a typed PC log task, and authenticated Android capture and readout | [Session and log routes](../../packages/daemon/src/features/device-support/developer-routes.ts), [Developer jobs](../../packages/daemon/src/features/device-support/developer-jobs.ts), [Coordinator](../../packages/core/src/device-developer.ts), [HTTP fixture](../../packages/daemon/test/device-developer-routes.test.ts) | Developer sessions bind target revisions, authorization and idempotent job IDs. The typed broker records PC and configured Android log jobs. Terminal outcomes survive restart. Interrupted jobs and captures retain an `unknown` outcome. Offline imports retain their capture digest on retry | Native workbench UI, live build/test worker reattachment, real PC/Mobile build, and packaged target acceptance remain |
| D11 | `9e257c618`, `aac808173` | Core developer coordinator and Daemon runtime tests | [Collaboration coordinator](../../packages/core/src/device-developer.ts), [Durable artifact bytes](../../packages/core/src/storage/sqlite/device-developer-store.ts), [Transfer fixture](../../packages/core/test/device-developer.test.ts) | Phone-owned proposals bind a digest and expiry. The owner verifies stored chunk hashes, reconstructs the accepted artifact and validates its final SHA-256 before settlement. | Signed peer transport, live PC assistance, phone-side deployment and physical head-unit acceptance remain |
| D12 | Signed rendezvous, native PC peer worker, Mobile connector, and route renewal | Native Pion/TLS acceptance on macOS arm64. Mobile and Remote Client typechecks and Node 22.22.1 tests. Desktop resource, lifecycle and distribution tests (81 passed). Desktop Office source projection and source-input tests with real esbuild (1,529 passed). Prior Chromium/Pion TURN/UDP and TURN/TLS loopback runs | [Native peer fixture](../../packages/daemon/test/ling-server-native-peer.test.ts), [Mobile connector fixtures](../../apps/mobile/test/mobile-ling-server-peer.test.ts), [Desktop package verification](../../scripts/release/verify-desktop-package.mjs) | Native peer authentication preserves conversation and PC-owned task identity across route renewal and Gateway restart. Reopening the owner journal resumes at the retained sequence without adding attempts. Explicit server revocation closes the native channel. Mobile permits fallback on transport failures and rejects invalid signatures and redirects. | macOS and Windows packaged execution, iOS and Android devices, direct cross-network ICE, deployed coturn TURN/TLS on TCP 443, collaboration and artifacts, and standalone server deployment remain |
| D13 | `98ea1e92c`, `e56411729` and broker evidence checks | Core and Daemon typechecks. The combined Core broker and Daemon device suites passed 56 tests, including 5 Modbus reply cases and the authenticated local route. Earlier native macOS arm64 PTY loopback and Desktop daemon bundle checks passed | [Workbench routes](../../packages/daemon/src/features/device-support/protocol-routes.ts), [Modbus adapter](../../packages/daemon/src/features/device-support/adapters/modbus-serial.ts), [Serial target](../../packages/daemon/src/features/device-support/modbus-serial-targets.ts), [Serial fixture](../../packages/daemon/test/modbus-serial-targets.test.ts) | PC configuration pins USB path and VID/PID/serial identity, captures Modbus RTU request/response, preserves partial evidence after disconnect, and exposes a standard broker diagnosis that records register facts and capture evidence in the owner task journal. The PTY loopback decoded register value 10 using the native serial driver | Android/iOS serial paths, additional vendor register maps, packaged target installation and physical RS-485 acceptance remain |
| D14 | Identity evidence, graph history and enrolled-device projection | Daemon build and typecheck, 44 focused Core and Daemon tests on Node 22.22.1. Authenticated graph fixtures cover initial ADB enrollment, reconnect and the workspace filter | [Graph route](../../packages/daemon/src/features/device-support/routes.ts), [Identity contract](../../packages/contracts/src/device-fabric.ts), [Fabric store](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [Reopen fixture](../../packages/core/test/device-fabric-store.test.ts) | The graph projects enrolled devices with stable node IDs and the current connection bindings. The store replays the original node revision after a split and restart | Authenticated adapter evidence and operator confirmation entry points, redirects for historical external IDs and field convergence remain |
| D15 | Graph stop, admission retry and owner receipt validation | Contracts/Core builds and typechecks. Fabric suites (30 passed) | [Graph coordinator](../../packages/core/src/device-fabric.ts), [Graph persistence](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [Receipt fixture](../../packages/core/test/device-fabric.test.ts) | The SQLite graph changes only when the owner receipt matches the persisted node, attempt and authenticated route. Stale graph or route revisions, foreign owners and mismatched attempts leave it unchanged. | Cross-runtime scheduler, authenticated receipt delivery, live route recovery and physical graph cases remain |
| D16 | `e1412cc76` plus recorded placement and Edge projection | Contracts/Core/Daemon build and typecheck. Edge runtime projection is available through the authenticated Daemon device-support route. Fabric unit and SQLite store suites (28 passed) | [Placement policy](../../packages/core/src/device-fabric.ts), [Fabric store](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [Reopen fixture](../../packages/core/test/device-fabric-store.test.ts) | A decision binds the target, capability and enrollment revision and replays after reopen. The current revoked revision blocks placement while the earlier decision remains readable. The Edge journal separately preserves interrupted task evidence. | Linux Edge dispatch and offline recovery integration, phone hardware bridge and physical reconnect acceptance remain |
| D17 | `4b35180dd` plus paired owner-journal paging and V5 watch | Contracts 194/194, Remote Protocol 44/44, Core 62/62, Daemon focused 24/24, Remote Client 30/30, and Mobile 102/102 tests passed. Gateway V5 push, cumulative ACK backpressure, reconnect cursor validation, V3/V4 legacy page fallback, and Mobile unsubscribe fixtures passed | [Task event projection](../../packages/core/src/device-task-event-projector.ts), [Gateway session](../../packages/daemon/src/features/remote-access/session.ts), [Remote Client journal watch](../../packages/remote-client/src/client.ts), [Mobile task journal](../../apps/mobile/src/features/device-tasks/PcDeviceTaskJournal.tsx), [Ling Server feature publication](../../packages/daemon/src/features/ling-server/control-plane.ts) | Local and paired reads share per-task journal cursors. V5 clients receive one bounded acknowledged page at a time and recover a stale cursor through a snapshot. Legacy V3/V4 clients retain page reads with timed refresh. The Mobile client validates task, owner, workspace, generation and sequence before advancing and stops without another request on unsubscribe. | High-rate telemetry sampling, production transport and field acceptance remain |
| D18 | Signed Daemon resource imports | Contracts, Core and Daemon builds and typechecks. Core resource and Daemon runtime tests (20 passed) | [Resource contract](../../packages/contracts/src/device-fabric.ts), [Resource store](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [Daemon trust and import configuration](ling-device-fabric.md#daemon-resource-imports), [Local integration test](../../packages/daemon/test/device-support-runtime.test.ts) | The shared manifest accepts transport, codec, profile, vocabulary, playbook, simulator, capture, documentation, firmware and edge package resources. Daemon validates an Ed25519-signed manifest and its payload before committing the active revision. Local import, replay, update, rollback and disable are exercised end to end. A corrupted, incompatible or untrusted rollback leaves the active revision intact | Remote signed delivery, platform-specific runtime activation, production adapter installation and physical acceptance remain |
| D19 | Durable dispatch stop and controller evidence | Contracts/Core/Daemon builds and typechecks. Core Fabric (30), Core broker (62), and Daemon runtime (41) focused tests | [Target dispatch and stop](../../packages/core/src/device-support.ts), [Safety evaluator](../../packages/core/src/device-fabric.ts), [Controller evidence store](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [Runtime tests](../../packages/daemon/test/device-support-runtime.test.ts) | An authenticated local operator can stop a target. SQLite retains the stop through reopen, blocks new writes, allows later diagnostics and preserves late evidence after a revision-checked clear. Certified-controller and vendor-workflow readiness evidence is bound to target, capability, policy revision and expiry, with digests only. Physical-state evaluation rejects stale or foreign facts | Mobile and Edge stop propagation, target-controller integration and physical safety acceptance remain |
| D20 | Daemon Fleet projection, registry retirement, and access grants | Contracts/Core/Daemon builds and typechecks. Core device-support suite (50 passed), Daemon runtime suite, and authenticated access-grant HTTP fixture passed | [Fleet projection](../../packages/core/src/device-fabric.ts), [Access-grant route](../../packages/daemon/src/features/device-support/routes.ts), [Grant fixture](../../packages/daemon/test/device-access-grants.test.ts), [Runtime tests](../../packages/daemon/test/device-support-runtime.test.ts) | Fleet reports separately observed device and runtime health. The authenticated route rejects stale retirement, records an exact decision and denies new device work. Access grants are target-bound, capability-scoped, revision-CAS protected, idempotently replayable, and durably revocable. SQLite keeps grant history without secret contents. | Ownership transfer, credential workflows, client lifecycle, supported firmware compatibility, upgrade, restore, and field transfer/retirement acceptance remain |
| D21 | f9f0f8ab5 plus provider handoff | Core/Daemon builds and typechecks. Device support and Daemon runtime tests (41 passed) | [Owner context](../../packages/core/src/device-task-planning-context.ts), [Planner acceptance](../../packages/core/src/device-orchestration.ts), [Handoff record](../../packages/core/src/storage/sqlite/device-support-store.ts), [Loopback provider test](../../packages/daemon/test/device-support-runtime.test.ts) | Planning acceptance binds provider and runner revisions to the task owner, current target snapshots and context references. A configured fallback provider receives a rebuilt context after runner unavailability. SQLite and task trace retain the provider handoff and the task keeps one owner and one device-attempt lineage. | Project build execution and cross-runtime model planning remain |
| D22 | Mobile journal trace projection plus Daemon conformance reports | Mobile typecheck and full suite (104 passed), standalone trace fixture (12 passed), Expo iOS/Android exports, Contracts/Core/Daemon builds and focused suites | [Mobile trace projection](../../apps/mobile/src/device/trace.ts), [Mobile journal reader](../../apps/mobile/src/device/journal.ts), [Standalone runtime](../../apps/mobile/src/device/standalone-runtime.ts), [Daemon report projection](../../packages/core/src/device-task-conformance.ts) | Phone-owned tasks export the shared trace contract after restart. Public verification references retain target and adapter lineage while sensitive observations, credentials, normalized inputs, and raw transport output are omitted. Unknown and interrupted outcomes remain unknown and do not redispatch | Native share-sheet interaction, Edge/field reporters, and physical cross-runtime acceptance remain |

## Definition of platform completion

The platform is not complete until:

- at least one non-PC adapter and one PC adapter pass their contract and real-device
  acceptance gates;
- Mobile and PC show the same durable task state and evidence for a paired task;
- at least one supported recovery task completes on a phone with no PC or Gateway,
  with verification and local evidence;
- the developer project-to-device workflow passes on supported PC and phone
  combinations with recorded native-tool and interruption behavior;
- paired PC assistance preserves Mobile ownership and verified results, including
  across direct and relayed peer connections;
- the cross-device case set verifies common contracts across PC, Mobile, head unit,
  hardware and smart home, with each participating node linked to its evidence;
- device identity, twin state, capability, event, resource, runtime, and task graph
  revisions remain reproducible across upgrades and reconnects;
- read-only, reversible, mutating, and critical actions have distinct policy behavior;
- adapter and capability versions are preserved in task history;
- a failed or disconnected operation cannot silently repeat a potentially mutating action;
- a new adapter can be added without changing the core task state machine or client
  presentation contract;
- unsupported, offline, hardware-failed, and vendor-locked states are explained without
  being reported as successful repair.

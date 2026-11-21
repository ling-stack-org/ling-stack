# Ling Device Support Platform Implementation Plan

Status: tracking plan; D1–D3 core, D4/D5/D7/D8 adapters, D6/D9 execution slices, D10–D22 domain foundations, and the first durable fabric stores landed, field and platform acceptance remain queued
Owner: Ling platform maintainers
Last verified: 2026-11-22 (paired Mobile PC task journal and signed Daemon resources)
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
| D4 | [~] | Home Assistant adapter | Fixture adapter supports discovery, entity availability classification, and a low-risk service action | Daemon adapter fixture tests |
| D5 | [~] | PC adapter and target-side executor | Typed PC inventory, network/services observations, and one reversible repair are implemented | Daemon adapter fixture tests |
| D6 | [~] | Mobile device-task facade | Paired Mobile can inspect, approve, revoke, request readback, and resume the PC owner's journal through Gateway | Remote protocol and authenticated Gateway fixtures |
| D7 | [~] | Playbooks and operator evidence | Bounded read-only playbook validation and replayable task attempts are implemented | Core playbook fixture tests |
| D8 | [~] | Additional ecosystems | PC-owned Linux SSH enrolls a pinned target and journals IPv4, route, Wi-Fi and optional DNS observations | Daemon HTTP, reconnect fixtures and OpenSSH loopback |
| D9 | [~] | Standalone Mobile execution | Phone-owned typed execution, local journal, foreground gate, exact approval, and resume recovery are implemented | Mobile source fixtures |
| D10 | [~] | Developer device sessions | The Daemon coordinator persists target-bound sessions, artifacts and job outcomes | Core and Daemon developer-session fixtures |
| D11 | [~] | PC-assisted Mobile execution | Phone-owned collaboration proposals and chunked artifacts preserve owner and target binding | Core collaboration fixtures |
| D12 | [~] | Ling Server connectivity | Self-hosted control metadata, durable peer journals, and binding-scoped relay credential issuance enforce route and revocation fences. Native connectivity remains in progress | Core route, peer-journal and HTTP fixtures |
| D13 | [~] | Hardware protocol development and debugging | Daemon developer sessions import and replay target-bound Modbus RTU captures using recorded codec and profile revisions | Core protocol and authenticated Daemon restart fixtures |
| D14 | [~] | Semantic device graph and twin | Graph identity, relationships, merge/split, and freshness-aware twin views are implemented | Core graph/twin fixtures |
| D15 | [~] | Cross-device task graph | Dependency validation, ready-node placement, owner leases, partial aggregation, result lineage, cancellation, and failed-node retry are implemented | Core task-graph fixtures |
| D16 | [~] | Edge Runtime and bridge contract | Enrollment, revocation, and a durable per-task Edge journal are implemented | Core edge registry and journal fixtures |
| D17 | [~] | Event and telemetry plane | The owning Daemon journal exposes resumable event pages to local and paired Mobile clients | Core journal, authenticated Gateway and Remote Client fixtures |
| D18 | [~] | Resource and adapter registry | Daemon imports, updates, disables and rolls back signed resources through its local operator API | Core resource fixtures and Daemon HTTP integration |
| D19 | [~] | Safety, policy, and secrets | The Daemon persists an operator dispatch stop and retains unsettled attempts. The policy evaluator checks physical facts and handoff requirements | Core safety and authenticated Daemon fixtures |
| D20 | [~] | Fleet and lifecycle | Revisioned lifecycle transitions are implemented | Core lifecycle fixtures |
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
- [~] Keep adapter crashes and transport failures isolated from the daemon process where
  external adapters are used.

### Exit evidence

- Fake device discovery and capability refresh test.
- Distinct offline, unsupported, and denied results. Revocation or a stale capability
  between approval and execution prevents dispatch.
- Concurrent task lease test. Where a write requires exclusion across hosts, test the
  target session or conditional write that provides it.
- External adapter crash and reconnect test if the external-process route is implemented.

## D3: Task state, approval, verification, and evidence

### Scope

- [x] Add durable device-task transitions from creation through verification.
- [~] Reuse Ling approval policy. The broker validates exact approval bindings. Existing
  Ling approval UI and audit integration remain open.
- [~] Keep capability snapshot IDs and policy revision with each task. Retain the full
  planning snapshot and authority history for later inspection.
- [~] Show the target, capability and PC owner before a write and bind confirmation to
  the exact action and current revisions. Detailed argument, impact, verification and
  recovery views remain open.
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
- [~] Require a supported recovery plan for writes that can strand a previously
  reachable device on its control path. Verify target rollback timers or a separate
  recovery route before accepting this path.
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
- Evidence fixture showing before and after state, verification, and user outcome. For
  each supported automatic recovery path, verify restoration of the recorded baseline
  after a simulated connection loss.
- Audit review confirming no secret or raw credential enters logs or artifacts.

## D4: Home Assistant adapter

### Scope

- [x] Register a Home Assistant adapter with explicit URL, authentication, and instance
  health configuration.
- [x] Discover devices, entities, services, and current availability.
- [x] Normalize state and service metadata into Ling capabilities.
- [~] Use a read-only Home Assistant flow to verify discovery, version selection, and
  diagnosis for unavailable entities, stale state, integration failure, and automation
  failure.
- [x] Add a small set of low-risk, verified actions such as reload integration or
  re-enable a bounded automation where supported.
- [x] Preserve Home Assistant entity and service identifiers in evidence without exposing
  credentials.

### Exit evidence

- Fixture-based tests against a fake Home Assistant API.
- At least one real local Home Assistant acceptance run.
- Action approval, verification, and rollback or safe-failure evidence.
- Support matrix for Home Assistant and adapter versions.

## D5: PC adapter and target-side executor

### Scope

- [x] Define the Windows/Linux/macOS target-side executor boundary.
- [~] Implement inventory, process/service, network, log, and software-version
  observations.
- [x] Expose typed repair actions instead of arbitrary shell execution.
- [x] Add a loopback-authenticated local PC diagnosis route that returns the structured
  read-only report and persists the daemon-owned task and observations.
- [~] Add least-privilege installation, pairing, update, revoke, and uninstall behavior.
- [x] Implement one low-risk repair flow with explicit verification.
- [ ] Establish a reproducible Windows network fault on a test PC or VM. Reproduce the
  diagnosis with read-only checks before exercising an approved reversible repair and
  retesting the original symptom.
- [ ] Document when the target must have a running executor, when SSH/WinRM is enough, and
  which recovery paths exist if the operating system cannot boot.

### Exit evidence

- Adapter contract tests on a fake host.
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
- [x] Android and head-unit deployment and diagnostics through a typed ADB adapter
  with fixed inventory, packages, logs, artifact install, reboot and verification
  operations. Real authorized APIs or
  ADB where available. Verify DiPlay on a compatible parked vehicle using
  the [installation case](ling-device-developer-execution.md#5-case-flow-install-diplay-on-an-older-head-unit).
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
  after explicit user confirmation. Verify that the device comes online.
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
- [x] Use the shared device contract for deploy, launch, test, and scoped diagnostics
  on an authorized development target. Bind package identity and the verified
  artifact to the approved device action.
- [ ] Connect the operator's native workbench to supported, authorized SSH, ADB,
  and vendor maintenance tools. Record tool status, relevant evidence selected by
  the user, and readback after native maintenance.
- [~] Persist job identity and typed outcomes. Reattachment to a live build or
  test worker remains a runtime gate.
- [x] Make the Daemon coordinator use its SQLite store for session and job
  transitions. Commit each job with its session update and preserve the retained
  result on replay.
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
- [x] Persist installations, peer bindings, route attempts, revocation epochs, and
  route state in SQLite, with daemon restart recovery fixtures.
- [x] Persist the logical peer session contract, route-generation changes, ordered
  frames, command receipts, and directional resume cursors with idempotency checks.
  Current peer epochs fence admission and replay. Frame and sequence persistence
  use one transaction. Configuration binds the two fingerprints to the peer roles.
- [~] Implement signed WebRTC signaling and direct LAN or cross-network ICE paths on
  PC and Mobile. Use Ling Server's configured STUN endpoint for discovery.
- [~] Issue short-lived coturn REST credentials for an active binding, role and
  registered relay route. The local operator API bounds issuance by route expiry
  and an in-process quota. UDP, TURN/TLS on TCP 443 and allocation behavior require
  verification on the chosen stack.
- [~] Carry Gateway conversation, developer-collaboration, and device-task messages
  over the same peer session contract. Device Fabric owner-stream events now have a
  typed, idempotent peer-frame bridge; conversation, collaboration, artifact lanes,
  and native route acceptance remain open.
- [ ] Package single-node self-hosting with SQLite and define a scaled deployment
  with PostgreSQL, stateless control workers, and relay affinity.
- [~] Add diagnostics for control reachability, candidate paths, selected route,
  peer handshake, cursor resume, relay quotas, and revocation. Typed ephemeral
  transport configuration and redacted route diagnostics are available through the
  self-hosted control plane; native ICE/WebRTC and relay measurements remain open.
- [ ] Migrate existing pairings through local confirmation and an explicitly
  versioned routing profile. Exercise key mismatch and retained receipts at cutover.

### Exit evidence

- The local control fixture checks peer key mismatch and revoked route selection.
  Core fixtures cover two-direction replay after reopening SQLite, route cutover,
  revocation from a separate registry instance and rollback when the cursor write
  fails. These exercise logical sessions and the HTTP control interface.
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
  Live capture and standard diagnosis still require a registered native transport.
- [ ] Keep the hardware transport, protocol codec, and versioned device profile
  independently reusable. Record the verified host, adapter and firmware combination.
- [x] Capture request and response evidence, support offline decoder replay and
  simulator fixtures, and preserve provenance and capture loss.
- [x] Persist codec manifests and validated protocol captures so replay evidence
  survives a workbench or daemon restart.
- [x] Support offline Modbus RTU register request and response decoding, exception
  replies and CRC diagnostics. Validate all capture frame digests before decoding or
  invoking any replay callback. Persist capture loss independently of frame integrity.
- [~] Register the built-in replay profile and codec through the protocol catalog.
  Vendor register maps and standard-session operations require bench evidence.

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
  store, with containment-cycle and revision checks.
- [ ] Add semantic capability verbs with protocol implementations, support ranges,
  freshness, side effects, approvals, prerequisites, and verification.
- [x] Add reported, desired, pending, and verified twin views with provenance and
  freshness. Preserve unknown state after interrupted writes.
- [ ] Add identity merge and split workflows with adapter evidence or local operator
  confirmation.

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
- [~] Record partial results and graph stop requests. A node that may have dispatched
  retains its attempt and an unknown outcome until the owner supplies terminal
  evidence. The coordinator can retry failed admission before dispatch. Cross-runtime
  cancellation delivery, receipt reconciliation and route changes remain open.

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
  device fabric store.
- [x] Persist a sequenced per-runtime, per-owner-task journal with transactional
  append, idempotent entry replay and explicit unknown outcomes across process restart.
- [ ] Verify a Linux edge executor and a supported phone-owned hardware bridge.
  Validate executor enrollment and each placement's connection, recovery, and task
  ownership.
- [ ] Support local execution and declared offline read or recovery behavior while
  retaining task ownership and evidence.

### Exit evidence

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
- [~] Add gap recovery, snapshot projection, backpressure, sampling, and peer
  synchronization. Owner-stream events can now cross an authenticated peer frame
  with idempotent replay; snapshot exchange, backpressure and telemetry policy remain.

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
  event does not change state.
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
- [~] Add signed resource manifests for transports, codecs, profiles, vocabulary,
  playbooks, simulators, captures, documentation, firmware metadata, and edge packages.
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

- [~] Declare action prerequisites in the safety policy. The evaluator checks
  target identity, observation age, policy revision, physical state, controller
  readiness and secret references. Native controller evidence remains open.
- [x] Persist the local operator's Daemon dispatch stop. Activation blocks new writes
  and journals the stop for any leased task on the selected target. The owning
  adapter receives a cancellation signal. Clearing the stop leaves an interrupted
  attempt unresolved until its owner reconciles it.
- [x] Add a target-scoped secret broker and auditable secret-use references without
  persisting secret contents.
- [ ] Route safety-critical operations through the certified controller or the
  authorized vendor maintenance workflow. Preserve operator evidence and readback.

### Exit evidence

- Parked head-unit app deployment and supported home and hardware configuration
  fixtures exercise condition, authority and verification checks. Safety-critical
  cases exercise the operator handoff and record the observable evidence.
- Model-visible observations cannot grant authorization or reveal secret contents.
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
- [ ] Add ownership transfer, shared read-only access, developer scopes, credential
  rotation, profile restore, upgrade, rollback, and retirement evidence.
- [~] Add fleet health and compatibility projections by runtime, adapter, profile,
  firmware, and target.

- [x] Expose a deterministic, workspace-scoped Fleet health projection from the
  Daemon. It joins device lifecycle, adapter/profile revisions, Edge Runtime status,
  last-seen freshness, and explicit degradation reasons without exposing secrets.

### Exit evidence

- Transfer a device between users or workspaces without losing its task history.
- Rotate credentials, revoke an edge runtime, upgrade an adapter, and restore the
  previous verified revision.
- Retired devices cannot receive new dispatch and retain the configured evidence
  retention behavior.

## D21: Model context and orchestration

### Scope

- [ ] Build bounded context packs from target relationships, capability snapshots,
  state, evidence, policy, safety facts, freshness, and context budget.
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
- [~] Connect the existing runner and project executor to typed device proposals.
  The PC and Linux diagnosis routes use Pi to select steps from the target-bound
  playbook when the operator chooses a configured provider. The owner checks the
  current snapshot before recording the proposal and dispatching. Model service
  failure uses a recorded local fallback. Project builds and cross-runtime planning
  remain open.
- [x] Record the PC diagnosis playbook plan in the task journal before its first
  device attempt. Preserve cancellation when a planning request is interrupted.
- [ ] Keep graph and node authority attached to the owning journals when PC or Mobile
  changes planners. Rebuild the context pack for the selected provider.
- [ ] Treat device output, logs, captures, and vendor text as untrusted observations.

### Exit evidence

- The local PC diagnostic entry writes an accepted playbook graph before dispatch,
  and its owner can rebuild scoped facts from the journal. Tests reject foreign
  devices, planning references, owners, execution claims, and expired snapshots.
- A cross-device goal produces a typed graph instead of unscoped tool calls.
- Context budget and redaction fixtures exclude unrelated devices, credentials,
  unbounded logs, and observation instructions.
- The model service outage runs the declared local playbook and records the source.

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
- [~] Add simulator, protocol replay, hardware-in-loop, network interruption, process
  restart, resource rollback, and physical acceptance reports.
- [ ] Produce a reproducible conformance report for each runtime, target, adapter,
  firmware, transport, model, and tested network.

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
| D2 | `cf0146ff7` | `corepack pnpm --filter @ling-stack/core build:ci`; `corepack pnpm --filter @ling-stack/core typecheck:ci`; `node --test packages/core/test/device-support.test.ts` (14 passed) | [device-support.ts](../../packages/core/src/device-support.ts), [device-support-store.ts](../../packages/core/src/storage/sqlite/device-support-store.ts), [runtime.ts](../../packages/daemon/src/features/device-support/runtime.ts) | Registry ownership, revocation, legacy lease migration, refresh fencing, current capability snapshots, stable identities, and broker dispatch are covered by fixtures | External-adapter process isolation remains |
| D3 | `007704512` and paired readback changes | Contracts, Core and Daemon `build:ci` and `typecheck:ci`. `node --test packages/core/test/device-support.test.ts` (21 passed). `node --test packages/daemon/test/device-remote-facade.test.ts packages/daemon/test/remote-gateway-security.test.mjs` (6 passed) | [device-support.ts](../../packages/core/src/device-support.ts), [device-support-store.ts](../../packages/core/src/storage/sqlite/device-support-store.ts), [device-remote-facade.test.ts](../../packages/daemon/test/device-remote-facade.test.ts) | Atomic admission, target leases, late receipts, restart recovery and scope-checked Gateway readback preserve the original dispatch journal. An unresolved readback leaves the task unknown | Approval audit projection and physical recovery acceptance remain |
| D4 | `4a83acfb8` | `node --test packages/daemon/test/device-support-adapters.test.ts` | [home-assistant.ts](../../packages/daemon/src/features/device-support/adapters/home-assistant.ts) | Fixture Home Assistant adapter supports discovery, entity available/unavailable/absent classification, evidence observations, bounded response sizes, and a reload action without persisting the token | Real Home Assistant instance and field action acceptance remain |
| D5 | `56e112a84` | `corepack pnpm --filter @ling-stack/daemon build:ci`; `corepack pnpm --filter @ling-stack/daemon typecheck:ci`; `node --test packages/daemon/test/device-support-adapters.test.ts packages/daemon/test/local-pc-executor.test.ts packages/daemon/test/device-support-runtime.test.ts` | [pc.ts](../../packages/daemon/src/features/device-support/adapters/pc.ts), [local-pc-executor.ts](../../packages/daemon/src/features/device-support/adapters/local-pc-executor.ts), [routes.ts](../../packages/daemon/src/features/device-support/routes.ts) | Typed PC executor and loopback diagnosis route expose inventory, network/services observations, a reversible repair boundary and a persisted structured report. The route checks local origin and keeps target credentials out of the response | Windows/Linux/macOS clean-machine, target-side executor install/revoke and field acceptance remain |
| D6 | Paired readback and owner journal | Remote Protocol and Remote Client builds, typechecks and tests (43 and 13 passed). Mobile typecheck, 98 tests and both Expo JS exports passed | [Device facade](../../packages/daemon/src/features/remote-access/device-facade.ts), [Mobile journal](../../apps/mobile/src/features/device-tasks/PcDeviceTaskJournal.tsx), [Client fixtures](../../packages/remote-client/test/client.test.ts) | Paired Mobile can check status, approve, stop, request fresh readback, and page through the PC-owned journal. The client binds journal replies to the authenticated session, workspace, task and cursor | Detailed approval presentation and packaged PC/iPhone/Android acceptance remain |
| D7 | `56e112a84` | `corepack pnpm --filter @ling-stack/core build:ci`; `corepack pnpm --filter @ling-stack/core typecheck:ci`; `node --test packages/core/test/device-support.test.ts packages/daemon/test/device-support-runtime.test.ts` | [device-playbooks.ts](../../packages/core/src/device-playbooks.ts), [device-diagnosis.ts](../../packages/core/src/device-diagnosis.ts), [routes.ts](../../packages/daemon/src/features/device-support/routes.ts) | PC and Home Assistant templates project current typed facts, hypotheses, journaled outcomes and remaining uncertainty. The local daemon route returns a report after persisting its read-only task and observations | Model task projection and physical target verification remain |
| D8 | `fdb3b50f7` and PC-owned Linux SSH enrollment | Contracts, Core and Daemon `build:ci` and `typecheck:ci`. Targeted device suite (87 passed) covers same-name targets, disconnect, changed endpoint and revocation. OpenSSH loopback completed a diagnosis and rejected a mismatched host key | [Linux SSH operation](ling-device-developer-execution.md#pc-owned-linux-ssh-diagnosis), [Enrollment and diagnosis fixture](../../packages/daemon/test/linux-ssh-runtime.test.ts), [Broker readback fixture](../../packages/daemon/test/device-support-adapters.test.ts), [Android ADB adapter](../../packages/daemon/src/features/device-support/adapters/android-adb.ts), [OBD adapter](../../packages/daemon/src/features/device-support/adapters/obd.ts) | Daemon enrolls a target by verified key, then journals typed IPv4, route, Wi-Fi and optional DNS name resolution. Reconnect keeps the device ID and refreshes the connection. A lost repair receipt stays uncertain until fresh readback | Native Mobile SSH, actual LAN/hotspot and DNS evidence, PC network recovery route, ADB/OBD transport, parked head-unit and vehicle acceptance remain |
| D9 | `52d415e47` and Android Linux SSH diagnosis | Mobile `typecheck:ci` and `test:ci` (98 passed). Expo Android prebuild and both production JS exports passed. JVM loopback verified host-key rejection before authentication, fixed command execution and oversized-output rejection. The Daemon SSH regression suite passed 6 tests | [Standalone screen](../../apps/mobile/src/features/device-tasks/StandaloneDeviceScreen.tsx), [Mobile journal fixture](../../apps/mobile/test/standalone-device-runtime.test.ts), [Android host-pin test](../../apps/mobile/modules/ling-device-transport/android/src/test/java/expo/modules/lingdevicetransport/PinnedSshSessionTest.java), [Shared Linux observations](../../packages/contracts/src/device-linux-ssh.ts) | The app supports phone-owned Home Assistant diagnosis and has an Android native Linux SSH path. The SSH journal retains redacted observations, stable target identity across address changes, and interrupted outcomes after foreground changes | Complete Android native Gradle package, physical LAN/hotspot acceptance, native iOS SSH, BLE/USB discovery and smart-home Wi-Fi provisioning |
| D10 | `313886185` and durable Daemon coordination | Core and Daemon `build:ci` and `typecheck:ci`. Developer coordinator, runtime and Gateway tests plus Android adapter tests (17 passed) | [Coordinator](../../packages/core/src/device-developer.ts), [SQLite store](../../packages/core/src/storage/sqlite/device-developer-store.ts), [Android ADB adapter](../../packages/daemon/src/features/device-support/adapters/android-adb.ts) | The Daemon coordinator persists sessions and jobs atomically. Android deployment requires an explicit package identity, rejects a mismatched installer result, and verifies that exact package after dispatch. Restart restores an existing job, and replay retains its unresolved outcome | Standard and developer client entry, live job reattachment, native workbench, real PC/Mobile build and packaged target acceptance remain |
| D11 | `9e257c618` | Core build/typecheck plus `node --test packages/core/test/device-developer.test.ts`; Daemon build/typecheck plus `node --test packages/daemon/test/device-support-runtime.test.ts` (9 passed) | [device-developer.ts](../../packages/core/src/device-developer.ts), [device-developer-store.ts](../../packages/core/src/storage/sqlite/device-developer-store.ts), [runtime.ts](../../packages/daemon/src/features/device-support/runtime.ts) | Phone-owned proposals validate their digest and expiry, owner transitions and artifact chunk metadata are durable through the shared SQLite developer store. Daemon runtime exposes the collaboration coordinator alongside the developer session coordinator | Signed peer transport, live PC assistance, chunk-byte integrity and physical head-unit acceptance remain |
| D12 | Route-bound relay credentials | Contracts, Core and Daemon builds/typechecks. Ling Server protocol and loopback HTTP fixtures cover role, route and epoch checks, TTL, issuance quota and revocation | [Control plane](../../packages/daemon/src/features/ling-server/control-plane.ts), [Peer coordinator](../../packages/core/src/ling-server.ts), [Transport configuration](../../packages/core/src/ling-server-transport.ts), [SQLite peer journal](../../packages/core/src/storage/sqlite/ling-server-store.ts) | The operator API signs coturn REST credentials for a registered relay route with the current binding epoch. Retries for the same credential are idempotent. A revoked binding prevents further issuance and peer-frame admission | Signed enrollment/signaling, TLS/WSS packaging, WebRTC/ICE, coturn allocation measurement and multi-network acceptance remain |
| D13 | Developer-session capture replay | Contracts/Core/Daemon builds and typechecks. Developer coordinator, protocol profiles and Daemon runtime suites (13 passed) | [Workbench](../../packages/core/src/device-protocol.ts), [Replay operations](ling-hardware-protocol-workbench.md#local-developer-capture-replay), [Runtime tests](../../packages/daemon/test/device-support-runtime.test.ts) | The local operator imports an identified capture and resolves the recorded Modbus codec and profile. A failed persistence write leaves the same workbench job recoverable after restart. Changed target, authority and digest are rejected. Decoded values and loss metadata remain reproducible | Developer clients, vendor register maps, live USB/BLE/RS-485 and bench acceptance remain |
| D14 | `dac1b4edc` | Core build/typecheck plus `node --test packages/core/test/device-fabric-store.test.ts packages/core/test/device-fabric.test.ts` (18 passed) | [device-fabric-store.ts](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [device-fabric.ts](../../packages/core/src/device-fabric.ts) | Semantic graph, identity merge/split, relationships, Twin revisions, freshness projection, and persistent graph/Twin state are implemented. Graph identity merge and split now retain prior node revisions in SQLite history | Multi-domain identity evidence and field convergence remain |
| D15 | Graph stop and admission retry | Core build/typecheck plus `node --test packages/core/test/device-fabric-store.test.ts packages/core/test/device-fabric.test.ts` | [Graph lease and persistence](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [Coordinator tests](../../packages/core/test/device-fabric.test.ts) | Graph stop preserves in-flight attempts and leaves lease release to their owners. Verified terminal evidence can settle an unresolved stopped node. Failed admission before dispatch can be retried. SQLite rejects stale graph and lease writes | Cross-runtime scheduler recovery, owner receipt validation, route changes and physical graph case set remain |
| D16 | `e1412cc76` + Edge Runtime journal | Core/Daemon builds and typechecks plus the Fabric store and Daemon runtime fixtures | [device-fabric-store.ts](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [device-fabric.ts](../../packages/core/src/device-fabric.ts), [runtime.ts](../../packages/daemon/src/features/device-support/runtime.ts) | Edge enrollment, revocation, and per-owner-task journal entries use the durable Fabric store. Reopening the store resumes a contiguous lane and retains unknown outcomes without redispatch | Linux edge process, live bridge transport and physical reconnect acceptance remain |
| D17 | Paired owner-journal paging | Contracts/Core focused tests (33 passed), Daemon runtime and Gateway tests (11 passed), Remote Protocol and Remote Client tests (43 and 13 passed) | [Task event projection](../../packages/core/src/device-task-event-projector.ts), [Gateway fixture](../../packages/daemon/test/device-remote-facade.test.ts), [Mobile journal](../../apps/mobile/src/features/device-tasks/PcDeviceTaskJournal.tsx) | Local and paired reads share the owner's journal projection. Indexed pages keep a per-task cursor and stable event identities. The authenticated fixture resumes after reconnect, reloads a stale generation and rejects out-of-scope tasks | Live subscription, cross-runtime snapshot exchange, telemetry sampling, backpressure and physical acceptance remain |
| D18 | Signed Daemon resource imports | Contracts, Core and Daemon builds and typechecks. Core resource and Daemon runtime tests (19 passed) | [Resource store](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [Daemon trust and import configuration](ling-device-fabric.md#daemon-resource-imports), [Local integration test](../../packages/daemon/test/device-support-runtime.test.ts) | Daemon validates an Ed25519-signed manifest and its payload before committing the active revision. Local import, replay, update, rollback and disable are exercised end to end. A corrupted, incompatible or untrusted rollback leaves the active revision intact | Remote signed delivery, platform-specific runtime activation, production adapter installation and physical acceptance remain |
| D19 | Durable Daemon dispatch stop | Contracts/Core/Daemon builds and typechecks. Core broker, Fabric and Daemon runtime suites (42 passed) | [Target dispatch and stop](../../packages/core/src/device-support.ts), [Safety evaluator](../../packages/core/src/device-fabric.ts), [Runtime tests](../../packages/daemon/test/device-support-runtime.test.ts) | An authenticated local operator can stop a target. SQLite retains the stop through reopen, blocks new writes, allows later diagnostics and preserves late evidence after a revision-checked clear. Physical-state evaluation rejects stale or foreign facts | Mobile and Edge stop propagation, target-controller integration and physical safety acceptance remain |
| D20 | current grant binding + Fleet health projection | Core/Daemon builds and typechecks. `node --test packages/core/test/device-fabric.test.ts` and Daemon device-support runtime HTTP fixture | [device-access.ts](../../packages/core/src/device-access.ts), [device-fabric-store.ts](../../packages/core/src/storage/sqlite/device-fabric-store.ts), [device-fabric.ts contracts](../../packages/contracts/src/device-fabric.ts), [runtime.ts](../../packages/daemon/src/features/device-support/runtime.ts) | Revisioned lifecycle transitions, ownership transfer history, target-scoped shared/developer access grants, credential rotation/revocation metadata, and a workspace-scoped Fleet projection joining adapter/profile and Edge Runtime health are implemented | Upgrade, restore, retirement and field transfer acceptance remain |
| D21 | Pi-backed Daemon diagnosis | Core/Daemon builds and typechecks. Core orchestration, adapter and runtime suites (17 passed) | [Owner context](../../packages/core/src/device-task-planning-context.ts), [Pi diagnosis planner](../../packages/daemon/src/features/device-support/diagnosis-planner.ts), [Loopback provider test](../../packages/daemon/test/device-support-runtime.test.ts) | The real Pi adapter contacts two configured loopback providers in successive PC diagnosis tasks. Each proposal selects owned read steps and records its provider and model turn. An invalid selection creates zero attempts. A disconnected provider falls back to the recorded local playbook | Active-task provider handoff, live provider acceptance, project build and cross-runtime model planning remain |
| D22 | Daemon owner-journal trace | Contracts/Core/Daemon build and typecheck plus Daemon device runtime and Gateway reconciliation tests | [Trace projection](../../packages/core/src/device-task-trace.ts), [Local diagnosis route test](../../packages/daemon/test/device-support-runtime.test.ts), [Reconciliation fixture](../../packages/daemon/test/device-remote-facade.test.ts) | A local PC diagnosis yields a trace with plan, node, target, adapter and connection revisions, reproducible from reopened SQLite. The Pi path adds the planning model turn. Gateway readback links an unresolved and a verified result to the original unknown attempt | Conversation, protocol capture and Mobile/Edge trace integration, cross-runtime and field conformance remain |

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

# Ling Device Support Platform Implementation Plan

Status: tracking plan; implementation not started
Owner: Ling platform maintainers
Last verified: 2026-11-19
Document type: staged implementation and acceptance record
Related design: [Ling Device Support Platform](ling-device-support-platform.md)
Runtime contract: [Ling Device Support Platform Runtime Contract](ling-device-support-platform-runtime-contract.md)
Developer workflows and topology: [Device Developer Execution and Connectivity](ling-device-developer-execution.md)

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
| D1 | [ ] | Shared device contracts and adapter manifest | Strict schemas compile and reject invalid inputs | Contracts typecheck and contract tests |
| D2 | [ ] | Device registry and capability broker | A fake device can register, discover, observe, and execute a read-only capability | Daemon tests plus fake-adapter integration |
| D3 | [ ] | Task state, approval, verification, and evidence | A task survives reconnect and distinguishes unknown outcome from success | State/recovery tests and evidence inspection |
| D4 | [ ] | Home Assistant adapter | One real or fixture HA instance supports discovery, status, diagnosis, and a low-risk action | Adapter contract tests and HA acceptance |
| D5 | [ ] | PC adapter and target-side executor | A Windows PC supports bounded diagnostics and one verified repair | Windows acceptance with a clean fixture machine |
| D6 | [ ] | Mobile device-task facade | Paired Mobile can inspect, approve, follow, and revoke a device task | Remote protocol fixtures and real-device acceptance |
| D7 | [ ] | Playbooks and operator evidence | Common configuration/repair flows are explainable and replayable | Playbook fixtures and evidence review |
| D8 | [ ] | Additional ecosystems | Each added adapter meets the same contract and support gates | Per-adapter simulator and field acceptance |
| D9 | [ ] | Standalone Mobile execution | One phone restores a supported BLE device's network connection with no PC or Gateway and verifies the result | Shared contract fixtures and real phone/device acceptance |
| D10 | [ ] | Developer device sessions | Complete build, deploy, debug, verify, and native-tool workflows on supported host and target combinations | Project/device integration, native-tool and reattach acceptance |
| D11 | [ ] | PC-assisted Mobile execution | Paired PC contributes plans, artifacts, or analysis while Mobile owns the task and device link | Collaboration contract fixtures and physical device runs |
| D12 | [ ] | Ling Server connectivity | Paired conversation and device-task sync survive LAN, cross-network direct, and encrypted relay routes | Multi-network tests, peer identity and reconnect evidence |

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

- [ ] Add strict DeviceIdentity, DeviceProfile, CapabilityDescriptor, AdapterManifest,
  Observation, ActionRequest, ActionResult, VerificationResult, and DeviceTask contracts.
- [ ] Add schema versions and reject unknown fields where the contract is security- or
  wire-sensitive.
- [ ] Select a shared contract major and compatible capability schemas. Allow additive
  display metadata within a supported version.
- [ ] Define side-effect, approval, permission, idempotency, timeout, verification, and
  rollback metadata.
- [ ] Define per-operation deadlines, response size limits, and the total task budget.
- [ ] Define normalized error categories without exposing raw credentials or protocol
  payloads.
- [ ] Define adapter conformance fixtures and a fake adapter.
- [ ] Record the deployment rule for each transport: no target install, target-side
  executor, or hardware bridge, with pairing and removal behavior.

### Exit evidence

- Contract typecheck output.
- Schema fixtures for compatible peers, incompatible versions, display metadata, and
  invalid manifest and action fields.
- Fake adapter manifest and capability snapshot.
- Review confirming no UI, SQLite, provider, or model dependency in the contracts.

## D2: Device registry and capability broker

### Scope

- [ ] Add device registration, revocation, health, and capability snapshot storage.
- [ ] Resolve a stable device id independently from addresses and transport handles.
- [ ] Load adapter manifests and reject incompatible contract versions.
- [ ] Track capability support, current availability, and authorization independently.
- [ ] Refresh stale snapshots after expiry and changes to connection, firmware, adapter,
  or authority. Recheck target identity and prerequisites at dispatch.
- [ ] Add target leases and bounded concurrency for device tasks.
- [ ] Keep adapter crashes and transport failures isolated from the daemon process where
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

- [ ] Add durable device-task transitions from creation through verification.
- [ ] Reuse Ling approval policy without allowing adapter installation to change policy.
- [ ] Persist capability and policy snapshots with each task.
- [ ] Show the target, action, host, impact, verification, and recovery option before a
  write. Bind confirmation to the exact action and current device and policy revisions.
- [ ] Persist dispatch intent and an attempt ID before invoking the adapter. Serialize
  the dispatch decision with cancellation and revocation.
- [ ] Require verification for any action that claims to repair or configure a device.
- [ ] Record action response, device verification, and user outcome independently.
- [ ] Preserve unknown outcomes and reconcile by observation after a possibly
  dispatched write. Track any later authorized action under a new attempt.
- [ ] Require a supported recovery plan for writes that can strand a previously
  reachable device on its control path.
- [ ] Add redacted observations and artifact references to the existing audit/evidence
  model.
- [ ] Ensure reconnecting clients read durable task state rather than infer cancellation.

### Exit evidence

- Recovery fixtures for daemon restart, client disconnect, cancel or revoke before
  dispatch, and stop or timeout after dispatch intent. Assert the dispatch count and
  subsequent outcome evidence.
- Evidence fixture showing before and after state, verification, and user outcome. For
  each supported automatic recovery path, verify restoration of the recorded baseline
  after a simulated connection loss.
- Audit review confirming no secret or raw credential enters logs or artifacts.

## D4: Home Assistant adapter

### Scope

- [ ] Register a Home Assistant adapter with explicit URL, authentication, and instance
  health configuration.
- [ ] Discover devices, entities, services, and current availability.
- [ ] Normalize state and service metadata into Ling capabilities.
- [ ] Use a read-only Home Assistant flow to verify discovery, version selection, and
  diagnosis for unavailable entities, stale state, integration failure, and automation
  failure.
- [ ] Add a small set of low-risk, verified actions such as reload integration or
  re-enable a bounded automation where supported.
- [ ] Preserve Home Assistant entity and service identifiers in evidence without exposing
  credentials.

### Exit evidence

- Fixture-based tests against a fake Home Assistant API.
- At least one real local Home Assistant acceptance run.
- Action approval, verification, and rollback or safe-failure evidence.
- Support matrix for Home Assistant and adapter versions.

## D5: PC adapter and target-side executor

### Scope

- [ ] Define the Windows/Linux/macOS target-side executor boundary.
- [ ] Implement inventory, process/service, network, log, and software-version
  observations.
- [ ] Expose typed repair actions instead of arbitrary shell execution.
- [ ] Add least-privilege installation, pairing, update, revoke, and uninstall behavior.
- [ ] Implement one low-risk repair flow with explicit verification.
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

- [ ] Extend the Remote Gateway with a narrow device-task capability surface.
- [ ] Reuse secure pairing, device identity, replay protection, and signed frames.
- [ ] Add mobile read-only device list, capability, task status, and evidence projection.
- [ ] Add eligible approval and revoke flows with server-owned policy ceilings.
- [ ] Route eligible device-task messages through the Gateway allowlist and keep
  target credentials with the executing host.
- [ ] Keep the daemon as the execution owner for this facade. D9 covers standalone
  Mobile and D11 covers collaboration on a phone-owned task.

### Exit evidence

- Protocol fixtures for device task creation, status, approval, and revoke.
- Mobile reconnect and resync tests show last known state while offline and recover the
  original daemon task. Duplicate requests return the recorded result or pending
  attempt. Reusing an attempt key with a different action is rejected.
- Physical iPhone acceptance for the approved read-only and approval flows.
- Android compilation and emulator coverage; physical Android evidence remains separately
  reported until available.

## D7: Playbooks and operator evidence

### Scope

- [ ] Define playbook metadata, required capabilities, risk profile, expected evidence,
  and supported device profiles.
- [ ] Add one Home Assistant offline-device playbook.
- [ ] Add one PC software-diagnosis playbook.
- [ ] Add structured explanation templates that separate facts, hypotheses, actions,
  verification, and remaining uncertainty.
- [ ] Validate freshness and provenance for observations used by a branch. Treat
  arbitrary instructions in device outputs as observation content.
- [ ] Provide a bounded local read-only flow that can collect redacted evidence when the
  model service is unavailable.
- [ ] Add replayable fixtures for successful, failed, partial, and unknown outcomes.

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
- [ ] Linux network diagnosis through an authorized SSH adapter, with real LAN and
  phone-hotspot reachability and fault evidence.
- [ ] Android and head-unit deployment and diagnostics through authorized APIs or
  ADB where available. Verify DiPlay on a compatible parked vehicle using
  the [installation case](ling-device-developer-execution.md#5-case-flow-install-diplay-on-an-older-head-unit).
- [ ] OBD/OpenXC vehicle read and diagnostic operations.
- [ ] Any vendor-specific adapter with a documented support matrix and authorization path.

For each adapter, record its own contract, simulator, permissions, support matrix, release
version, real-device evidence, and known unsupported models. No adapter is complete based
only on a successful install or a model response.

## D9: Standalone Mobile execution

### Scope

- [ ] Reuse D1 device contracts and D3 task, approval, and recovery rules in a phone
  execution module that works without Gateway pairing. D6 and D9 have independent
  acceptance gates.
- [ ] Add native BLE connection and capability discovery for one documented device
  profile, including OS permission and device authorization checks.
- [ ] Run one setup playbook that reconnects a supported smart home device to Wi-Fi
  after explicit user confirmation. Verify that the device comes online.
- [ ] Persist approval, action attempts, and redacted verification evidence on the
  phone. Preserve an unknown result after interruption until state can be checked.
- [ ] Stop new dispatch after foreground authorization ends or the app is suspended.
  Recheck the target state and permissions on resume.
- [ ] Record the tested phone OS, device model and firmware, and transport. Each later
  phone platform or USB integration gets its own acceptance entry.

### Exit evidence

- Shared contract fixtures for capability checks, approval, and interpretation of
  verified and unknown results.
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

- [ ] Add standard and developer session entry points to PC and Mobile. Show the
  current workspace, external target, owner, and effective device authorization.
- [ ] Use the shared device contract for deploy, launch, test, and scoped diagnostics
  on an authorized development target. Bind package identity and the verified
  artifact to the approved device action.
- [ ] Connect the operator's native workbench to supported, authorized SSH, ADB,
  and vendor maintenance tools. Record tool status, relevant evidence selected by
  the user, and readback after native maintenance.
- [ ] Persist job identity and reconnect to running build or test work. Record
  the runtime and device outcome separately.

### Exit evidence

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

- [ ] Extend the signed remote protocol for an opted-in phone-owned task
  projection, PC proposals, scoped artifact transfer, and Mobile receipts.
- [ ] Keep project actions bound to the PC workspace and device actions bound to
  the phone's verified target and local authorization.
- [ ] Resume the owner's journal from an acknowledged revision or a refreshed
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

- [ ] Add outbound enrollment, peer rendezvous, route selection, and encrypted relay
  for paired phone and PC connections. Retain local PC pairing confirmation and
  peer identity checks across all routes.
- [ ] Carry the Gateway's eligible application messages across LAN, authenticated
  internet direct, and encrypted relay routes. Preserve protocol version
  negotiation, command receipts, and session resumption.
- [ ] Measure path establishment, relay use, and recovery after network changes.
  Track service availability, resource limits, and redacted connection diagnostics.

### Exit evidence

- Test a reachable LAN, a direct connection across networks, and a NAT/firewall
  fixture requiring relay. Include route switching during live conversation and
  device-task sync and an outage with local execution available.
- Verify peer-key mismatch, unauthorized relay access, expiry, and revocation.
  Verify that the relay carries ciphertext and that reconnect resumes the same
  task without dispatching a second attempt.

## Per-slice evidence ledger

Update this table in the same PR that changes a slice status.

| Slice | PR / commit | Validation command or run | Evidence link | Result boundary | Remaining work |
| --- | --- | --- | --- | --- | --- |
| D0 | #730 | Documentation and link checks | [PR #730](https://github.com/ling-stack-org/ling-stack/pull/730), [Runtime contract](ling-device-support-platform-runtime-contract.md) | Architecture and tracking only | All runtime slices |
| D1 | — | — | — | Not started | Contracts and SDK |
| D2 | — | — | — | Not started | Registry and broker |
| D3 | — | — | — | Not started | Task recovery and evidence |
| D4 | — | — | — | Not started | Home Assistant |
| D5 | — | — | — | Not started | PC |
| D6 | — | — | — | Not started | Mobile facade |
| D7 | — | — | — | Not started | Playbooks |
| D8 | — | — | — | Not started | Additional ecosystems |
| D9 | — | — | [Design](ling-device-support-platform.md#111-standalone-mobile-execution) | Design recorded, implementation not started | Standalone BLE execution and device acceptance |
| D10 | — | — | [Developer sessions](ling-device-developer-execution.md#1-device-sessions) | Design recorded, implementation not started | Project, device, and native tool acceptance |
| D11 | — | — | [PC collaboration](ling-device-developer-execution.md#22-pc-assisted-phone-execution) | Design recorded, implementation not started | Phone-owned collaboration and physical cases |
| D12 | — | — | [Communication design](ling-device-developer-execution.md#3-communication-design) | Design recorded, implementation not started | Direct paths, relay, and reconnect acceptance |

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
- read-only, reversible, mutating, and critical actions have distinct policy behavior;
- adapter and capability versions are preserved in task history;
- a failed or disconnected operation cannot silently repeat a potentially mutating action;
- a new adapter can be added without changing the core task state machine or client
  presentation contract;
- unsupported, offline, hardware-failed, and vendor-locked states are explained without
  being reported as successful repair.

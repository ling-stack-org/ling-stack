# Ling Device Support Platform Implementation Plan

Status: tracking plan; D1–D3 core, D4/D5/D7/D8 adapters, and D6 device-task protocol groundwork landed, later slices remain queued
Owner: Ling platform maintainers
Last verified: 2026-11-21 (D1–D3 core, D4/D5/D7/D8 adapters, D6 remote device-task protocol and facade fixtures)
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
| D3 | [x] | Task state, approval, verification, and evidence | A task persists an exact approval, dispatch attempt, verification, idempotent replay, and unknown outcome after restart | Core SQLite journal and recovery tests |
| D4 | [~] | Home Assistant adapter | Fixture adapter supports discovery, entity availability classification, and a low-risk service action | Daemon adapter fixture tests |
| D5 | [~] | PC adapter and target-side executor | Typed PC inventory, network/services observations, and one reversible repair are implemented | Daemon adapter fixture tests |
| D6 | [~] | Mobile device-task facade | Paired Mobile can inspect, approve, follow, and revoke through a typed Gateway surface | Remote protocol and facade fixtures |
| D7 | [~] | Playbooks and operator evidence | Bounded read-only playbook validation and replayable task attempts are implemented | Core playbook fixture tests |
| D8 | [~] | Additional ecosystems | Linux/SSH typed network and Wi-Fi adapter is implemented under the shared contract | Daemon Linux adapter fixture tests |
| D9 | [ ] | Standalone Mobile execution | One phone restores a supported BLE device's network connection with no PC or Gateway and verifies the result | Shared contract fixtures and real phone/device acceptance |
| D10 | [ ] | Developer device sessions | Complete build, deploy, debug, verify, and native-tool workflows on supported host and target combinations | Project/device integration, native-tool and reattach acceptance |
| D11 | [ ] | PC-assisted Mobile execution | Paired PC contributes plans, artifacts, or analysis while Mobile owns the task and device link | Collaboration contract fixtures and physical device runs |
| D12 | [ ] | Ling Server connectivity | Self-hosted control, direct peer paths, NAT traversal, encrypted relay fallback, and paired conversation/device-task sync work without third-party network services | Multi-network tests, peer identity, payload confidentiality, and reconnect evidence |
| D13 | [ ] | Hardware protocol development and debugging | Capture, decode, replay, and verify a hardware protocol and register the tested adapter for standard use | Shared codec fixtures and physical PC and Mobile device runs |
| D14 | [ ] | Semantic device graph and twin | PC, Mobile, vehicle, hardware, and smart-home identities and state views resolve through one semantic model | Identity, relationship, freshness, and twin fixtures |
| D15 | [ ] | Cross-device task graph | One task can plan and execute nodes on different owners with approvals, partial results, recovery, and verification | Graph scheduler, owner leases, and cross-device acceptance |
| D16 | [ ] | Edge Runtime and bridge contract | An enrolled Linux edge executor and a phone-owned bridge use the shared device contract | Enrollment, reconnect, local journal, capability, and bridge tests |
| D17 | [ ] | Event and telemetry plane | Device, task, health, and evidence events use one envelope with ordering, freshness, backpressure, and snapshots | Stream fixtures, gap recovery, telemetry retention, and peer projection |
| D18 | [ ] | Resource and adapter registry | Supported resources install, update, and roll back through their platform delivery channels | Manifest, license, dependency, digest, and rollback tests |
| D19 | [ ] | Safety, policy, and secrets | Actions check device authority and current operating conditions and record their verification | Risk fixtures, controller boundaries, and target-specific acceptance |
| D20 | [ ] | Fleet and lifecycle | Enrollment, ownership, health, credentials, upgrade, revoke, retire, and restore are durable | Lifecycle state machine and upgrade/recovery evidence |
| D21 | [ ] | Model context and orchestration | Model context packs and cross-device plans use bounded evidence, local playbooks, and observation trust | Context budget, prompt-injection, planner, and offline fixtures |
| D22 | [ ] | Observability and conformance | One trace links model, graph, runtime, adapter, protocol, target, and verification | Simulator, hardware-in-loop, chaos, field, and reproducible conformance report |

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
- [x] Reuse Ling approval policy without allowing adapter installation to change policy.
- [x] Persist capability and policy snapshots with each task.
- [x] Show the target, action, host, impact, verification, and recovery option before a
  write. Bind confirmation to the exact action and current device and policy revisions.
- [x] Persist dispatch intent and an attempt ID before invoking the adapter. Serialize
  the dispatch decision with cancellation and revocation.
- [x] Require verification for any action that claims to repair or configure a device.
- [x] Record action response, device verification, and user outcome independently.
- [x] Preserve unknown outcomes and reconcile by observation after a possibly
  dispatched write. Track any later authorized action under a new attempt.
- [x] Require a supported recovery plan for writes that can strand a previously
  reachable device on its control path.
- [x] Add redacted observations and artifact references to the existing audit/evidence
  model.
- [x] Ensure reconnecting clients read durable task state rather than infer cancellation.

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
- [x] Add mobile read-only device list, capability, task status, and evidence projection.
- [~] Add eligible approval and revoke flows with server-owned policy ceilings.
- [x] Route eligible device-task messages through the Gateway allowlist and keep
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

- [x] Define playbook metadata, required capabilities, risk profile, expected evidence,
  and supported device profiles.
- [ ] Add one Home Assistant offline-device playbook.
- [~] Add one PC software-diagnosis playbook.
- [ ] Add structured explanation templates that separate facts, hypotheses, actions,
  verification, and remaining uncertainty.
- [~] Validate freshness and provenance for observations used by a branch. Treat
  arbitrary instructions in device outputs as observation content.
- [x] Provide a bounded local read-only flow that can collect redacted evidence when the
  model service is unavailable.
- [~] Add replayable fixtures for successful, failed, partial, and unknown outcomes.

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
- [~] Linux network diagnosis through an authorized SSH adapter, with real LAN and
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

- [ ] Implement the self-hosted Ling Server control API, enrollment, presence,
  rendezvous, server identity, peer epochs, revocation, and metadata persistence.
- [ ] Implement signed WebRTC signaling and direct LAN or cross-network ICE paths on
  PC and Mobile. Use Ling Server's configured STUN endpoint for discovery.
- [ ] Integrate self-hosted coturn for fallback, with scoped credential issuance, UDP
  relay and TURN/TLS on TCP 443. Verify allocation limits and expiry on the chosen stack.
- [ ] Carry Gateway conversation, developer-collaboration, and device-task messages
  over the same peer session contract. Preserve cursors, receipts, idempotency,
  artifact chunking, route migration, and session resumption.
- [ ] Package single-node self-hosting with SQLite and define a scaled deployment
  with PostgreSQL, stateless control workers, and relay affinity.
- [ ] Add diagnostics for control reachability, candidate paths, selected route,
  peer handshake, cursor resume, relay quotas, and revocation.
- [ ] Migrate existing pairings through local confirmation and an explicitly
  versioned routing profile. Exercise key mismatch and retained receipts at cutover.

### Exit evidence

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

- [ ] Add a protocol workbench to the developer session, reusing D1–D3 device
  contracts, ownership, approval, and evidence.
- [ ] Keep the hardware transport, protocol codec, and versioned device profile
  independently reusable. Record the verified host, adapter and firmware combination.
- [ ] Capture request and response evidence, support offline decoder replay and
  simulator fixtures, and preserve provenance and capture loss.
- [ ] Register the verified profile and operations through the existing device
  adapter catalog. Record supported devices and verified behavior.

### Exit evidence

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

- [ ] Add stable device, component, connection, relationship, location, and
  ownership records. Keep transport aliases separate from stable identity.
- [ ] Add semantic capability verbs with protocol implementations, support ranges,
  freshness, side effects, approvals, prerequisites, and verification.
- [ ] Add reported, desired, pending, and verified twin views with provenance and
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

- [ ] Add parent graph, node, edge, target binding, node owner, precondition,
  approval, attempt, verification, recovery, and evidence contracts.
- [ ] Coordinate PC, Mobile and Linux edge nodes over their authorized device links.
  Preserve per-node ownership. Use the declared coordination mechanism for shared
  target and bridge leases.
- [ ] Support partial result, unknown outcome, graph cancellation, node retry,
  route change, and recovery without duplicating a mutating action.

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

- [ ] Define runtime enrollment, key proof, target discovery, local journal,
  connection handles, health, cancel, capture, upgrade, and revoke.
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

- [ ] Define the event envelope, stream owner, sequence, freshness, quality,
  provenance, redaction class, and retention policy.
- [ ] Add task, state, health, capability, action, verification, evidence, and
  resource events. Keep high-rate telemetry separate from durable task events.
- [ ] Add gap recovery, snapshot projection, backpressure, sampling, and peer
  synchronization.

### Exit evidence

- A state gap recovers from a retained range or current snapshot. A duplicate
  event does not change state.
- High-rate sensor data is sampled or expired according to policy while task and
  revocation events remain durable.
- Model context receives the source, time, freshness, and provenance of each fact.

## D18: Resource and adapter registry

### Scope

- [ ] Add signed resource manifests for adapters, transports, codecs, profiles,
  vocabulary, playbooks, simulators, captures, documentation, firmware metadata,
  and edge packages.
- [ ] Validate digest, signature, license, dependency, platform, device, firmware,
  permission, and Ling contract compatibility.
- [ ] Install, health-check, disable, update, and roll back resources independently.

### Exit evidence

- Mobile activates a compatible data profile and fixture. Native Mobile
  components enter through the signed app build. PC validates a supported native
  adapter installation. Record resource revisions and artifact digests.
- A failed update restores the last verified resource without deleting task evidence.
- An unsupported license, dependency, platform, or firmware range blocks installation.

## D19: Safety, policy, and secrets

### Scope

- [ ] Declare the physical and permission prerequisites of supported actions.
  Validate the target state, adapter cancellation and recovery behavior.
- [ ] Add a target-scoped secret broker and auditable secret use references.
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

- [ ] Track enrollment and ownership revisions, profile and runtime versions,
  operational health, maintenance and retirement.
- [ ] Add ownership transfer, shared read-only access, developer scopes, credential
  rotation, profile restore, upgrade, rollback, and retirement evidence.
- [ ] Add fleet health and compatibility projections by runtime, adapter, profile,
  firmware, and target.

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
- [ ] Connect the existing runner and project executor to typed device proposals.
  Record planning inputs and evidence. Support deterministic local playbooks.
- [ ] Keep graph and node authority attached to the owning journals when PC or Mobile
  changes planners. Rebuild the context pack for the selected provider.
- [ ] Treat device output, logs, captures, and vendor text as untrusted observations.

### Exit evidence

- A cross-device goal produces a typed graph instead of unscoped tool calls.
- Context budget and redaction fixtures exclude unrelated devices, credentials,
  unbounded logs, and observation instructions.
- The model service outage runs the declared local playbook and records the source.

## D22: Observability and conformance

### Scope

- [ ] Propagate conversation, graph, node, attempt, device, runtime, connection,
  adapter, resource, event, and model-turn identifiers.
- [ ] Add simulator, protocol replay, hardware-in-loop, network interruption, process
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
| D1 | `pending` | `corepack pnpm --filter @ling-stack/contracts typecheck` and `test` | [contracts/device.ts](../../packages/contracts/src/device.ts) | Core contracts, validators, transport deployment metadata, and fake adapter fixtures are implemented | Adapter package extraction and cross-process conformance remain |
| D2 | `pending` | `corepack pnpm --filter @ling-stack/core typecheck:ci`; `node --test packages/core/test/device-support.test.ts` | [device-support.ts](../../packages/core/src/device-support.ts), [device-support-store.ts](../../packages/core/src/storage/sqlite/device-support-store.ts) | Registry, capability snapshots, stable identities, revocation, leases, and broker dispatch are covered by a fake adapter | Daemon wiring and external-adapter process isolation remain |
| D3 | `pending` | `node --test packages/core/test/device-support.test.ts` | [device-support.test.ts](../../packages/core/test/device-support.test.ts) | Exact approval binding, durable dispatch intent, verification, idempotent replay, and restart-to-unknown recovery are covered | Existing Ling approval UI/audit projection and physical recovery acceptance remain |
| D4 | `pending` | `node --test packages/daemon/test/device-support-adapters.test.ts` | [home-assistant.ts](../../packages/daemon/src/features/device-support/adapters/home-assistant.ts) | Fixture Home Assistant adapter supports discovery, entity available/unavailable/absent classification, and a bounded reload action without persisting the token | Real Home Assistant instance, observation persistence, and field action acceptance remain |
| D5 | `pending` | `node --test packages/daemon/test/device-support-adapters.test.ts` | [pc.ts](../../packages/daemon/src/features/device-support/adapters/pc.ts) | Typed PC executor contract covers inventory, network/services reads, reversible network repair, and post-action verification | Windows/Linux/macOS target implementations and clean-machine acceptance remain |
| D6 | `pending` | `corepack pnpm --filter @ling-stack/remote-protocol test:ci`; `node --test packages/daemon/test/device-remote-facade.test.ts` | [device-facade.ts](../../packages/daemon/src/features/remote-access/device-facade.ts), [remote-device.ts](../../packages/contracts/src/remote-device.ts) | Gateway allowlist, strict command/event schemas, workspace-scoped device projections, revoke, and approval callback boundary are implemented | Daemon composition with a live device owner, Mobile UI, reconnect receipts, and physical iOS/Android acceptance remain |
| D7 | `pending` | `node --test packages/core/test/device-support.test.ts` | [device-playbooks.ts](../../packages/core/src/device-playbooks.ts) | Bounded read-only playbooks validate closed metadata, execute ordered typed capabilities, and leave durable attempts | HA/PC report templates, provenance projection, and full terminal-outcome fixtures remain |
| D8 | `pending` | `node --test packages/daemon/test/device-support-adapters.test.ts` | [linux-ssh.ts](../../packages/daemon/src/features/device-support/adapters/linux-ssh.ts) | Linux/SSH adapter exposes fixed network, Wi-Fi, and restart operations through the shared contract | Real LAN/hotspot and head-unit acceptance remain |
| D9 | — | — | [Design](ling-device-support-platform.md#111-standalone-mobile-execution) | Design recorded, implementation not started | Standalone BLE execution and device acceptance |
| D10 | — | — | [Developer sessions](ling-device-developer-execution.md#1-device-sessions) | Design recorded, implementation not started | Project, device, and native tool acceptance |
| D11 | — | — | [PC collaboration](ling-device-developer-execution.md#22-pc-assisted-phone-execution) | Design recorded, implementation not started | Phone-owned collaboration and physical cases |
| D12 | — | Documentation links, license and public checks plus diagram rendering | [Ling Server design](ling-server-connectivity.md) | Detailed self-hosted design recorded, implementation not started | WebRTC integration, self-hosted STUN/TURN, migration, and cross-network acceptance |
| D13 | — | Documentation, license and public checks plus diagram rendering | [Workbench design and research](ling-hardware-protocol-workbench.md) | Proposed design documented, implementation not started | Runtime and library evaluation, offline fixtures, and physical acceptance |
| D14 | — | — | [Device Fabric](ling-device-fabric.md) | Detailed design recorded, implementation not started | Semantic graph, identity merge, twin state |
| D15 | — | — | [Device Fabric](ling-device-fabric.md#5-cross-device-task-graph) | Detailed design recorded, implementation not started | Graph scheduler, owners, recovery |
| D16 | — | — | [Device Fabric](ling-device-fabric.md#6-edge-runtimes-and-bridge-contract) | Detailed design recorded, implementation not started | Runtime enrollment and bridge acceptance |
| D17 | — | — | [Device Fabric](ling-device-fabric.md#7-event-and-telemetry-plane) | Detailed design recorded, implementation not started | Event streams, freshness, retention |
| D18 | — | — | [Device Fabric](ling-device-fabric.md#9-resource-and-adapter-registry) | Detailed design recorded, implementation not started | Signed resources, updates, rollback |
| D19 | — | — | [Device Fabric](ling-device-fabric.md#10-safety-security-and-secrets) | Detailed design recorded, implementation not started | Physical safety and secret broker |
| D20 | — | — | [Device Fabric](ling-device-fabric.md#11-lifecycle-fleet-and-ownership) | Detailed design recorded, implementation not started | Fleet lifecycle, transfer, upgrades |
| D21 | — | — | [Device Fabric](ling-device-fabric.md#8-model-context-and-ai-orchestration) | Detailed design recorded, implementation not started | Context packs, planner, local fallback |
| D22 | — | — | [Device Fabric](ling-device-fabric.md#12-observability-simulation-and-conformance) | Detailed design recorded, implementation not started | Traces, simulation, chaos, field acceptance |

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

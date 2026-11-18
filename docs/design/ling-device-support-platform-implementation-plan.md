# Ling Device Support Platform Implementation Plan

Status: tracking plan; implementation not started
Owner: Ling platform maintainers
Last verified: 2026-11-18
Document type: staged implementation and acceptance record
Related design: [Ling Device Support Platform](ling-device-support-platform.md)

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
4. Do not expose raw shell, CAN, USB, or vendor commands directly to the model.
5. Do not add an adapter to the product catalog until its manifest, health behavior,
   permission profile, support matrix, contract tests, and removal path exist.
6. Record the exact adapter version, device profile, model/provider, and capability
   snapshot for every executed task.
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

## D0: Design baseline

Completed in this documentation change.

- [x] Define product scope and non-goals.
- [x] Separate client, daemon, model runner, capability broker, adapter, transport, and
  target executor ownership.
- [x] Define device identity, profile, capability, task, action, observation, and evidence
  concepts.
- [x] Define adapter lifecycle, versioning, permissions, and failure behavior.
- [x] Define mobile, local, direct-transport, hardware-bridge, and future relay topologies.
- [x] Define Home Assistant, PC, vehicle, and generic transport extension points.
- [x] Add this plan to the design index and implementation-status index.

Evidence: this PR and the linked design document. No runtime implementation or device
acceptance is claimed by D0.

## D1: Shared device contracts and adapter SDK

### Scope

- [ ] Add strict DeviceIdentity, DeviceProfile, CapabilityDescriptor, AdapterManifest,
  Observation, ActionRequest, ActionResult, VerificationResult, and DeviceTask contracts.
- [ ] Add schema versions and reject unknown fields where the contract is security- or
  wire-sensitive.
- [ ] Define side-effect, approval, permission, idempotency, timeout, verification, and
  rollback metadata.
- [ ] Define normalized error categories without exposing raw credentials or protocol
  payloads.
- [ ] Define adapter conformance fixtures and a fake adapter.
- [ ] Record the deployment rule for each transport: no target install, target-side
  executor, or hardware bridge, with pairing and removal behavior.

### Exit evidence

- Contract typecheck output.
- Positive and negative schema fixtures.
- Fake adapter manifest and capability snapshot.
- Review confirming no UI, SQLite, provider, or model dependency in the contracts.

## D2: Device registry and capability broker

### Scope

- [ ] Add device registration, revocation, health, and capability snapshot storage.
- [ ] Resolve a stable device id independently from addresses and transport handles.
- [ ] Load adapter manifests and reject incompatible contract versions.
- [ ] Dispatch only capabilities present in the current snapshot.
- [ ] Add target leases and bounded concurrency for device tasks.
- [ ] Keep adapter crashes and transport failures isolated from the daemon process where
  external adapters are used.

### Exit evidence

- Fake device discovery and capability refresh test.
- Revocation and stale-capability test.
- Concurrent-task lease test.
- External adapter crash and reconnect test if the external-process route is implemented.

## D3: Task state, approval, verification, and evidence

### Scope

- [ ] Add durable device-task transitions from creation through verification.
- [ ] Reuse Ling approval policy without allowing adapter installation to change policy.
- [ ] Persist capability and policy snapshots with each task.
- [ ] Require verification for any action that claims to repair or configure a device.
- [ ] Preserve unknown outcomes after a transport failure following dispatch.
- [ ] Add redacted observations and artifact references to the existing audit/evidence
  model.
- [ ] Ensure reconnecting clients read durable task state rather than infer cancellation.

### Exit evidence

- Recovery tests for daemon restart, client disconnect, approval race, timeout, cancel,
  and unknown outcome.
- Evidence fixture showing before/after state and verification.
- Audit review confirming no secret or raw credential enters logs or artifacts.

## D4: Home Assistant adapter

### Scope

- [ ] Register a Home Assistant adapter with explicit URL, authentication, and instance
  health configuration.
- [ ] Discover devices, entities, services, and current availability.
- [ ] Normalize state and service metadata into Ling capabilities.
- [ ] Implement read-only diagnosis for unavailable entities, stale state, integration
  failure, and automation failure.
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
- [ ] Document when the target must have a running executor, when SSH/WinRM is enough, and
  which recovery paths exist if the operating system cannot boot.

### Exit evidence

- Adapter contract tests on a fake host.
- Clean Windows acceptance with a reproducible broken-software fixture.
- Permission and uninstall checks.
- Before/after logs and verified task result.
- Explicit distinction between static package checks and field acceptance.

## D6: Mobile device-task facade

### Scope

- [ ] Extend the Remote Gateway with a narrow device-task capability surface.
- [ ] Reuse secure pairing, device identity, replay protection, and signed frames.
- [ ] Add mobile read-only device list, capability, task status, and evidence projection.
- [ ] Add eligible approval and revoke flows with server-owned policy ceilings.
- [ ] Keep raw commands, secrets, broad settings, and unrestricted execution out of Mobile.
- [ ] Preserve PC as the authority for durable device tasks until a separate mobile-only
  execution design is accepted.

### Exit evidence

- Protocol fixtures for device task creation, status, approval, and revoke.
- Mobile reconnect/resync and duplicate-command tests.
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
- [ ] Add replayable fixtures for successful, failed, partial, and unknown outcomes.

### Exit evidence

- Playbook contract tests.
- Fixture reports for each terminal outcome.
- Review showing the model cannot bypass required capability or approval metadata.

## D8: Additional ecosystems

Each adapter is a separate scoped slice. The order below is a recommendation, not a claim
that support exists:

- [ ] Router and NAS APIs.
- [ ] Printer discovery, queue, driver, and network diagnosis.
- [ ] Matter, ESPHome, Zigbee, and BLE devices.
- [ ] Android and head-unit diagnostics through authorized APIs or ADB where available.
- [ ] OBD/OpenXC vehicle read and diagnostic operations.
- [ ] Any vendor-specific adapter with a documented support matrix and authorization path.

For each adapter, record its own contract, simulator, permissions, support matrix, release
version, real-device evidence, and known unsupported models. No adapter is complete based
only on a successful install or a model response.

## Per-slice evidence ledger

Update this table in the same PR that changes a slice status.

| Slice | PR / commit | Validation command or run | Evidence link | Result boundary | Remaining work |
| --- | --- | --- | --- | --- | --- |
| D0 | This PR | Documentation and link checks | This PR | Architecture and tracking only | All runtime slices |
| D1 | — | — | — | Not started | Contracts and SDK |
| D2 | — | — | — | Not started | Registry and broker |
| D3 | — | — | — | Not started | Task recovery and evidence |
| D4 | — | — | — | Not started | Home Assistant |
| D5 | — | — | — | Not started | PC |
| D6 | — | — | — | Not started | Mobile facade |
| D7 | — | — | — | Not started | Playbooks |
| D8 | — | — | — | Not started | Additional ecosystems |

## Definition of platform completion

The platform is not complete until:

- at least one non-PC adapter and one PC adapter pass their contract and real-device
  acceptance gates;
- Mobile and PC show the same durable task state and evidence for a paired task;
- read-only, reversible, mutating, and critical actions have distinct policy behavior;
- adapter and capability versions are preserved in task history;
- a failed or disconnected operation cannot silently repeat a potentially mutating action;
- a new adapter can be added without changing the core task state machine or client
  presentation contract;
- unsupported, offline, hardware-failed, and vendor-locked states are explained without
  being reported as successful repair.

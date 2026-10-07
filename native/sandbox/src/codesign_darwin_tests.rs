//! Fault/control-flow tests, not sandbox or source certification. Native wait
//! cases use an owned finite /bin/sleep child in its own process group. Setter
//! cases use explicitly synthetic Mach facts; real capability controls are a
//! different suite. No arbitrary production target or fault flag is introduced.
use super::faults::{Fault, OwnedProcess, Plan, Scenario, Tape};
use super::*;
use std::os::unix::process::CommandExt;
use std::process::{Child as ProcessChild, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

fn synthetic_plan(faults: Vec<Fault>) -> Plan {
    Plan {
        synthetic_mach: true,
        faults,
        ..Plan::default()
    }
}

fn chdir_action() -> ChdirAction {
    // SAFETY: exactly the same fixed prototype used by production, no injected
    // pointer, arbitrary symbol or replacement dynamic library.
    unsafe {
        mem::transmute::<*mut libc::c_void, ChdirAction>(
            symbol(c"posix_spawn_file_actions_addchdir_np").expect("fixed Darwin chdir SPI"),
        )
    }
}

fn fixed_unexecuted_arguments() -> Vec<CString> {
    [
        "/usr/bin/sandbox-exec",
        "-p",
        "(version 1)\n(deny default)",
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
        "/private/tmp/NotExecutedFaultFixture.app",
    ]
    .into_iter()
    .map(|value| CString::new(value).unwrap())
    .collect()
}

fn require_one(tape: &Tape, site: &str, executed: bool) {
    let calls = tape.calls_at(site);
    assert_eq!(calls.len(), 1, "{site}: expected exactly one call");
    assert_eq!(calls[0].occurrence, 1);
    assert_eq!(
        calls[0].executed, executed,
        "{site}: OS call execution mismatch"
    );
}

fn require_closed(state: &SpawnState) {
    assert!(!state.attr_live && !state.actions_live);
    assert!(state.pipes.iter().all(|fd| fd.value.is_none()));
}

#[test]
fn synthetic_missing_symbols_refuse_before_spawn_without_fallback() {
    for denied in [
        "posix_spawn_file_actions_addchdir_np",
        "posix_spawnattr_set_registered_ports_np",
        "posix_spawnattr_setexceptionports_np",
        "posix_spawnattr_setspecialport_np",
        "bootstrap_look_up2",
    ] {
        let mut plan = synthetic_plan(Vec::new());
        plan.denied_symbols.insert(denied);
        let scenario = Scenario::install(plan);
        let result = execute(&fixed_unexecuted_arguments(), unsafe { libc::getppid() }
            as u32);
        assert!(
            matches!(result, Err(ProtocolError::CodesignApiUnsupported)),
            "{denied}"
        );
        let tape = scenario.finish();
        tape.require_consumed();
        assert!(tape.symbols.iter().any(|name| name == denied));
        assert!(
            tape.calls_at("spawn").is_empty(),
            "missing SPI must never start a child"
        );
        assert!(tape.calls_at("kill_group").is_empty());
        assert!(tape.calls_at("waitpid").is_empty());
    }
}

#[test]
fn synthetic_prepare_failure_destroys_only_successful_initializations() {
    for site in [
        "attr_init",
        "actions_init",
        "flags",
        "pgroup",
        "sigmask",
        "sigdefault",
        "registered",
        "exceptions",
        "bootstrap_null",
        "chdir",
        "pipe",
        "dup2",
        "addclose",
    ] {
        let (result_code, errno) = if site == "pipe" {
            (-1, Some(libc::EIO)) // POSIX syscall errno convention, not a setter rc.
        } else {
            (libc::EIO, None)
        };
        let scenario = Scenario::install(synthetic_plan(vec![Fault::before(
            site,
            result_code,
            errno,
        )]));
        let mut state = SpawnState::empty();
        let result = state.prepare(chdir_action());
        let expected = if ["registered", "exceptions", "bootstrap_null"].contains(&site) {
            ProtocolError::CodesignMachActionFailed
        } else {
            ProtocolError::CodesignPrepareFailed
        };
        assert_eq!(result, Err(expected), "{site}");
        assert_eq!(state.close(), Ok(()), "{site}: original cleanup");
        require_closed(&state);
        drop(state); // A Drop cannot repeat any successful checked destroy.
        let tape = scenario.finish();
        tape.require_consumed();
        require_one(&tape, site, false);
        assert_eq!(
            tape.calls_at("attr_destroy").len(),
            usize::from(site != "attr_init"),
            "{site}"
        );
        assert_eq!(
            tape.calls_at("actions_destroy").len(),
            usize::from(!["attr_init", "actions_init"].contains(&site)),
            "{site}"
        );
        assert!(tape.calls_at("spawn").is_empty());
        assert!(tape.calls_at("kill_group").is_empty());
        assert!(tape.calls_at("waitpid").is_empty());
    }
}

#[test]
fn synthetic_spawn_errno_has_no_owned_child_to_signal_or_wait() {
    let scenario = Scenario::install(synthetic_plan(vec![Fault::before(
        "spawn",
        libc::EAGAIN,
        None,
    )]));
    let result = execute(&fixed_unexecuted_arguments(), unsafe { libc::getppid() }
        as u32);
    assert!(matches!(result, Err(ProtocolError::CodesignSpawnFailed)));
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "spawn", false);
    require_one(&tape, "actions_destroy", true);
    require_one(&tape, "attr_destroy", true);
    assert!(tape.calls_at("kill_group").is_empty());
    assert!(tape.calls_at("waitpid").is_empty());
}

#[test]
fn synthetic_destroy_failure_is_not_success_and_is_never_retried_by_drop() {
    for site in ["actions_destroy", "attr_destroy"] {
        // Execute the genuine destroy first so the test does not leak a native
        // attr/actions allocation, then model an unknown/error rc at that site.
        let scenario = Scenario::install(synthetic_plan(vec![Fault::after(site, libc::EIO)]));
        let mut state = SpawnState::empty();
        assert_eq!(state.prepare(chdir_action()), Ok(()));
        assert_eq!(state.close(), Err(ProtocolError::CodesignCleanupUnknown));
        require_closed(&state);
        drop(state);
        let tape = scenario.finish();
        tape.require_consumed();
        require_one(&tape, "actions_destroy", true);
        require_one(&tape, "attr_destroy", true);
        let failed = tape.calls_at(site)[0];
        assert_eq!(
            failed.original_result,
            Some(0),
            "genuine native destroy must succeed"
        );
        assert_eq!(failed.returned_result, libc::EIO);
        assert!(tape.calls_at("spawn").is_empty());
    }
}

#[test]
fn synthetic_cleanup_failure_dominates_spawn_refusal_without_claiming_a_child() {
    let scenario = Scenario::install(synthetic_plan(vec![
        Fault::before("spawn", libc::EAGAIN, None),
        Fault::after("attr_destroy", libc::EIO),
    ]));
    let result = execute(&fixed_unexecuted_arguments(), unsafe { libc::getppid() }
        as u32);
    assert!(matches!(result, Err(ProtocolError::CodesignCleanupUnknown)));
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "spawn", false);
    require_one(&tape, "attr_destroy", true);
    assert!(tape.calls_at("kill_group").is_empty());
    assert!(tape.calls_at("waitpid").is_empty());
}

struct OwnedSleep {
    process: ProcessChild,
    reaped: Arc<AtomicBool>,
}
impl OwnedSleep {
    fn start() -> Self {
        let process = Command::new("/bin/sleep")
            .arg("2") // Finite even if a test assertion fails or cleanup is refused.
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0) // Align kill(-pid) with a private fixture group.
            .spawn()
            .expect("owned finite native fixture spawn");
        Self {
            process,
            reaped: Arc::new(AtomicBool::new(false)),
        }
    }
    fn owner(&self) -> OwnedProcess {
        OwnedProcess {
            pid: self.process.id().try_into().unwrap(),
            reaped: self.reaped.clone(),
        }
    }
    fn child(&self) -> Child {
        Child {
            pid: self.owner().pid,
            status: None,
            cleanup_attempted: false,
            wait_unknown: false,
        }
    }
    fn plan(&self, faults: Vec<Fault>) -> Plan {
        Plan {
            owned_process: Some(self.owner()),
            ..synthetic_plan(faults)
        }
    }
    fn cleanup(&mut self) {
        if self.reaped.load(Ordering::SeqCst) {
            return;
        }
        // The token is set by an actual successful raw waitpid before recorder
        // allocation/assertions. Never signal a PID already reaped by Child.
        let killed = self.process.kill();
        let waited = self.process.wait();
        if waited.is_ok() {
            self.reaped.store(true, Ordering::SeqCst);
        }
        assert!(waited.is_ok(), "fixture original reap failed: {waited:?}");
        assert!(
            killed.is_ok()
                || killed
                    .as_ref()
                    .is_err_and(|error| error.raw_os_error() == Some(libc::ESRCH)),
            "fixture original kill failed: {killed:?}"
        );
    }
}
impl Drop for OwnedSleep {
    fn drop(&mut self) {
        if !self.reaped.load(Ordering::SeqCst) {
            // Unwind-only fallback; exact std-owned finite child, never fake PID.
            let _ = self.process.kill();
            if self.process.wait().is_ok() {
                self.reaped.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[test]
fn actual_owned_wait_eintr_is_not_exit_then_real_kill_and_wait_complete() {
    let mut fixture = OwnedSleep::start();
    let scenario =
        Scenario::install(fixture.plan(vec![Fault::before("waitpid", -1, Some(libc::EINTR))]));
    let mut child = fixture.child();
    assert_eq!(child.poll(), Ok(()));
    assert!(child.status.is_none() && !child.wait_unknown);
    assert_eq!(child.stop(), Ok(()));
    assert!(child.status.is_some());
    assert!(fixture.reaped.load(Ordering::SeqCst));
    drop(child);
    let tape = scenario.finish();
    tape.require_consumed();
    assert_eq!(tape.calls_at("waitpid")[0].executed, false);
    assert!(
        tape.calls_at("waitpid")
            .iter()
            .any(|call| call.original_result == Some(fixture.owner().pid))
    );
    require_one(&tape, "kill_group", true);
    fixture.cleanup();
}

#[test]
fn actual_owned_wait_unknown_never_signals_even_when_drop_runs() {
    for errno in [libc::ECHILD, libc::EIO] {
        let mut fixture = OwnedSleep::start();
        let scenario =
            Scenario::install(fixture.plan(vec![Fault::before("waitpid", -1, Some(errno))]));
        let mut child = fixture.child();
        assert_eq!(child.poll(), Err(ProtocolError::CodesignWaitFailed));
        assert_eq!(child.stop(), Err(ProtocolError::CodesignCleanupUnknown));
        assert!(child.wait_unknown && child.status.is_none());
        drop(child);
        let tape = scenario.finish();
        tape.require_consumed();
        require_one(&tape, "waitpid", false);
        assert!(tape.calls_at("kill_group").is_empty());
        fixture.cleanup(); // Separate harness-owned real cleanup, not product drain.
    }
}

#[test]
fn actual_owned_kill_failure_latches_unknown_and_cannot_be_retried_by_drop() {
    let mut fixture = OwnedSleep::start();
    let scenario =
        Scenario::install(fixture.plan(vec![Fault::before("kill_group", -1, Some(libc::EPERM))]));
    let mut child = fixture.child();
    assert_eq!(child.stop(), Err(ProtocolError::CodesignCleanupUnknown));
    assert_eq!(child.stop(), Err(ProtocolError::CodesignCleanupUnknown));
    drop(child);
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "kill_group", false);
    assert!(tape.calls_at("waitpid").is_empty());
    fixture.cleanup();
}

#[test]
fn actual_owned_final_wait_failure_is_not_drain_even_after_real_signal() {
    let mut fixture = OwnedSleep::start();
    let scenario =
        Scenario::install(fixture.plan(vec![Fault::before("waitpid", -1, Some(libc::ECHILD))]));
    let mut child = fixture.child();
    assert_eq!(child.stop(), Err(ProtocolError::CodesignCleanupUnknown));
    assert!(child.status.is_none() && child.wait_unknown);
    drop(child);
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "kill_group", true);
    require_one(&tape, "waitpid", false);
    fixture.cleanup();
}

#[test]
fn actual_owned_cleanup_deadline_is_unknown_and_does_not_repeat_signal() {
    let mut fixture = OwnedSleep::start();
    let mut plan = fixture.plan(vec![Fault::before("waitpid", 0, None)]);
    plan.expired_deadlines.insert("cleanup_deadline");
    let scenario = Scenario::install(plan);
    let mut child = fixture.child();
    assert_eq!(child.stop(), Err(ProtocolError::CodesignCleanupUnknown));
    assert!(child.status.is_none() && child.cleanup_attempted);
    drop(child);
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "kill_group", true);
    require_one(&tape, "waitpid", false);
    fixture.cleanup();
}

#[test]
fn actual_owned_execution_deadline_refuses_capture_and_checked_cleanup_completes() {
    let mut fixture = OwnedSleep::start();
    let mut plan = fixture.plan(Vec::new());
    plan.expired_deadlines.insert("execution_deadline");
    let scenario = Scenario::install(plan);
    let mut state = SpawnState::empty();
    assert_eq!(state.prepare(chdir_action()), Ok(()));
    let mut child = fixture.child();
    assert!(matches!(
        capture(&mut child, &mut state, unsafe { libc::getppid() } as u32),
        Err(ProtocolError::CodesignTimeout)
    ));
    assert_eq!(child.stop(), Ok(()));
    assert_eq!(state.close(), Ok(()));
    require_closed(&state);
    drop(child);
    drop(state);
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "kill_group", true);
    assert!(fixture.reaped.load(Ordering::SeqCst));
    fixture.cleanup();
}

#[test]
fn actual_reaped_child_is_never_signaled_for_late_errors_or_drop() {
    let mut fixture = OwnedSleep::start();
    let scenario = Scenario::install(fixture.plan(Vec::new()));
    let mut child = fixture.child();
    assert_eq!(child.stop(), Ok(()));
    assert!(child.status.is_some() && fixture.reaped.load(Ordering::SeqCst));
    assert_eq!(child.stop(), Ok(()));
    assert_eq!(child.poll(), Ok(()));
    drop(child);
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "kill_group", true); // Only the original pre-reap kill.
    fixture.cleanup();
}

#[test]
fn actual_reaped_child_does_not_hide_late_checked_destroy_failure() {
    let mut fixture = OwnedSleep::start();
    let scenario = Scenario::install(fixture.plan(vec![Fault::after("attr_destroy", libc::EIO)]));
    let mut state = SpawnState::empty();
    assert_eq!(state.prepare(chdir_action()), Ok(()));
    let mut child = fixture.child();
    assert_eq!(child.stop(), Ok(()));
    assert!(child.status.is_some() && fixture.reaped.load(Ordering::SeqCst));
    assert_eq!(state.close(), Err(ProtocolError::CodesignCleanupUnknown));
    require_closed(&state);
    drop(child);
    drop(state);
    let tape = scenario.finish();
    tape.require_consumed();
    require_one(&tape, "kill_group", true);
    require_one(&tape, "attr_destroy", true);
    assert_eq!(tape.calls_at("attr_destroy")[0].original_result, Some(0));
    fixture.cleanup();
}

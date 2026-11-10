//! Test-only, thread-local native call recorder. Never compiled into release.
//! Overrides are Rust values held by the unit-test thread, not CLI, env or wire.
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Timing {
    Before,
    After,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Fault {
    pub site: &'static str,
    pub occurrence: usize,
    pub result: i32,
    pub errno: Option<i32>,
    pub timing: Timing,
}
impl Fault {
    pub fn before(site: &'static str, result: i32, errno: Option<i32>) -> Self {
        Self {
            site,
            occurrence: 1,
            result,
            errno,
            timing: Timing::Before,
        }
    }
    pub fn after(site: &'static str, result: i32) -> Self {
        Self {
            timing: Timing::After,
            ..Self::before(site, result, None)
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Call {
    pub site: &'static str,
    pub occurrence: usize,
    pub executed: bool,
    pub original_result: Option<i32>,
    pub returned_result: i32,
}

#[derive(Default)]
pub(super) struct Plan {
    pub faults: Vec<Fault>,
    pub denied_symbols: BTreeSet<&'static str>,
    pub expired_deadlines: BTreeSet<&'static str>,
    /// Synthetic Mach facts isolate setter/control-flow tests from OS identity.
    /// They never certify a native port or whole-source capability boundary.
    pub synthetic_mach: bool,
    pub owned_process: Option<OwnedProcess>,
}

/// The fixture supplies a PID returned by std::process::Command, never a fake
/// PID. Observe actual waitpid success before any later assertion can unwind.
#[derive(Clone)]
pub(super) struct OwnedProcess {
    pub pid: libc::pid_t,
    pub reaped: Arc<AtomicBool>,
}

struct Active {
    plan: Plan,
    counts: BTreeMap<&'static str, usize>,
    calls: Vec<Call>,
    symbols: Vec<String>,
}
thread_local! {
    static ACTIVE: RefCell<Option<Active>> = const { RefCell::new(None) };
}

#[derive(Debug)]
pub(super) struct Tape {
    pub calls: Vec<Call>,
    pub symbols: Vec<String>,
    pub unconsumed_faults: usize,
    pub unconsumed_symbols: usize,
    pub unconsumed_deadlines: usize,
}
impl Tape {
    pub fn calls_at(&self, site: &str) -> Vec<&Call> {
        self.calls.iter().filter(|call| call.site == site).collect()
    }
    pub fn require_consumed(&self) {
        assert_eq!(self.unconsumed_faults, 0, "fault never reached");
        assert_eq!(self.unconsumed_symbols, 0, "symbol gate never reached");
        assert_eq!(self.unconsumed_deadlines, 0, "deadline gate never reached");
    }
}

/// One non-nested scenario per test thread; unwind clears all test state.
pub(super) struct Scenario;
impl Scenario {
    pub fn install(plan: Plan) -> Self {
        ACTIVE.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(slot.is_none(), "native fault scenarios must not nest");
            *slot = Some(Active {
                plan,
                counts: BTreeMap::new(),
                calls: Vec::new(),
                symbols: Vec::new(),
            });
        });
        Self
    }
    pub fn finish(self) -> Tape {
        let state = ACTIVE
            .with(|slot| slot.borrow_mut().take())
            .expect("active native scenario");
        Tape {
            calls: state.calls,
            symbols: state.symbols,
            unconsumed_faults: state.plan.faults.len(),
            unconsumed_symbols: state.plan.denied_symbols.len(),
            unconsumed_deadlines: state.plan.expired_deadlines.len(),
        }
    }
}
impl Drop for Scenario {
    fn drop(&mut self) {
        ACTIVE.with(|slot| {
            slot.borrow_mut().take();
        });
    }
}

/// A before-fault does not execute the OS call. An after-fault preserves the
/// actual resource operation, then overrides rc (e.g. destroy failure reporting).
/// Neither branch invents PID, FD, port or pointer output values.
pub(crate) fn i32_call(site: &'static str, original: impl FnOnce() -> i32) -> i32 {
    let prepared = ACTIVE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let active = slot.as_mut()?;
        let count = active.counts.entry(site).or_default();
        *count += 1;
        let occurrence = *count;
        let fault = active
            .plan
            .faults
            .iter()
            .position(|fault| fault.site == site && fault.occurrence == occurrence)
            .map(|position| active.plan.faults.remove(position));
        Some((occurrence, fault, active.plan.owned_process.clone()))
    });
    let Some((occurrence, fault, owner)) = prepared else {
        return original();
    };
    let executed = !fault.is_some_and(|fault| fault.timing == Timing::Before);
    let original_result = executed.then(original);
    if site == "waitpid" {
        if let Some(owner) = owner {
            if original_result == Some(owner.pid) {
                owner.reaped.store(true, Ordering::SeqCst);
            }
        }
    }
    let result = fault.map_or_else(
        || original_result.expect("executed call"),
        |fault| fault.result,
    );
    // Recorder allocation must not obscure the real/injected syscall errno.
    let errno = fault
        .and_then(|fault| fault.errno)
        .unwrap_or_else(|| unsafe { *libc::__error() });
    ACTIVE.with(|slot| {
        slot.borrow_mut()
            .as_mut()
            .expect("scenario remains active during native call")
            .calls
            .push(Call {
                site,
                occurrence,
                executed,
                original_result,
                returned_result: result,
            });
    });
    // SAFETY: Darwin errno pointer belongs to this test thread. No pointer is
    // retained, and production has neither this recorder nor injected errno.
    unsafe { *libc::__error() = errno };
    result
}

pub(super) fn deny_symbol(name: &CStr) -> bool {
    ACTIVE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(active) = slot.as_mut() else {
            return false;
        };
        let name = name.to_str().expect("fixed native symbol name");
        active.symbols.push(name.to_owned());
        active.plan.denied_symbols.remove(name)
    })
}

pub(super) fn expired(site: &'static str) -> bool {
    ACTIVE.with(|slot| {
        slot.borrow_mut()
            .as_mut()
            .is_some_and(|active| active.plan.expired_deadlines.remove(site))
    })
}

pub(crate) fn synthetic_mach() -> bool {
    ACTIVE.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|active| active.plan.synthetic_mach)
    })
}

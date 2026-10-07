//! Fixed Darwin capability actions and OS endpoint binding for codesign.
//! This module owns native observations; wire claims do not establish authority.
use crate::codesign_darwin::{codesign_i32, symbol};
use crate::protocol::ProtocolError;
use std::mem;

// SDK exception_types.h excludes CRASH/CORPSE from EXC_MASK_ALL. Include both;
// supported arm64/x86_64 machine masks are zero. Future masks need new review.
pub const EXCEPTION_MASK: u32 = (1 << 14) - 2;
const EXCEPTION_DEFAULT: i32 = 1;
#[cfg(target_arch = "aarch64")]
const THREAD_STATE_NONE: i32 = 5;
#[cfg(target_arch = "x86_64")]
const THREAD_STATE_NONE: i32 = 13;
const MACH_PORT_NULL: u32 = 0;
const MACH_PORT_DEAD: u32 = u32::MAX;

type RegisteredSetter = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, *const u32, u32) -> i32;
type ExceptionSetter =
    unsafe extern "C" fn(*mut libc::posix_spawnattr_t, u32, u32, i32, i32) -> i32;
type SpecialSetter = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, u32, i32) -> i32;
type BootstrapLookup2 =
    unsafe extern "C" fn(u32, *const libc::c_char, *mut u32, libc::pid_t, u64) -> i32;

unsafe extern "C" {
    fn task_get_special_port(task: u32, which: i32, port: *mut u32) -> i32;
    fn mach_port_deallocate(task: u32, port: u32) -> i32;
    fn mach_port_kobject(task: u32, name: u32, object_type: *mut u32, object_addr: *mut u64)
    -> i32;
    fn mach_port_type(task: u32, name: u32, kind: *mut u32) -> i32;
}

struct Api {
    registered: RegisteredSetter,
    exception: ExceptionSetter,
    special: SpecialSetter,
    lookup2: BootstrapLookup2,
}
impl Api {
    fn read() -> Result<Self, ProtocolError> {
        Ok(Self {
            // SAFETY: exact Darwin spawn.h/SPI C prototypes. Missing symbols are
            // typed unsupported; no alternate launcher is attempted.
            registered: unsafe {
                mem::transmute::<*mut libc::c_void, RegisteredSetter>(symbol(
                    c"posix_spawnattr_set_registered_ports_np",
                )?)
            },
            exception: unsafe {
                mem::transmute::<*mut libc::c_void, ExceptionSetter>(symbol(
                    c"posix_spawnattr_setexceptionports_np",
                )?)
            },
            special: unsafe {
                mem::transmute::<*mut libc::c_void, SpecialSetter>(symbol(
                    c"posix_spawnattr_setspecialport_np",
                )?)
            },
            lookup2: unsafe {
                mem::transmute::<*mut libc::c_void, BootstrapLookup2>(symbol(
                    c"bootstrap_look_up2",
                )?)
            },
        })
    }
}

/// Observed native OS facts, not whole-source certification. HOST type3 is the
/// ordinary canonical OS host object; type4/unknown is rejected. TASK_ACCESS is
/// either absent or bound to the actual fixed privileged OS taskgated endpoint.
#[derive(Clone, Copy)]
pub struct MachFacts {
    pub host_object_type: u32,
    pub access_object_type: Option<u32>,
    pub access_service: &'static str,
}
struct SendRight {
    task: u32,
    value: Option<u32>,
}
impl SendRight {
    fn raw(&self) -> Result<u32, ProtocolError> {
        self.value.ok_or(ProtocolError::CodesignCleanupUnknown)
    }
    fn require_ordinary_send(&self) -> Result<(), ProtocolError> {
        let mut kind = 0;
        if unsafe { mach_port_type(self.task, self.raw()?, &mut kind) } != 0
            || kind & (1 << 16) == 0
            || kind & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)) != 0
        {
            return Err(ProtocolError::CodesignMachPreflightFailed);
        }
        Ok(())
    }
    fn object_type(&self) -> Result<u32, ProtocolError> {
        self.require_ordinary_send()?;
        let mut kind = 0;
        let mut address = 0_u64;
        if unsafe { mach_port_kobject(self.task, self.raw()?, &mut kind, &mut address) } != 0 {
            return Err(ProtocolError::CodesignMachPreflightFailed);
        }
        Ok(kind)
    }
    fn close(&mut self) -> Result<(), ProtocolError> {
        let Some(value) = self.value.take() else {
            return Ok(());
        };
        if unsafe { mach_port_deallocate(self.task, value) } != 0 {
            return Err(ProtocolError::CodesignCleanupUnknown);
        }
        Ok(())
    }
}
impl Drop for SendRight {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
fn special_right(task: u32, which: i32) -> Result<Option<SendRight>, ProtocolError> {
    let mut port = MACH_PORT_NULL;
    if unsafe { task_get_special_port(task, which, &mut port) } != 0 {
        return Err(ProtocolError::CodesignMachPreflightFailed);
    }
    if port == MACH_PORT_NULL {
        return Ok(None);
    }
    if port == MACH_PORT_DEAD {
        return Err(ProtocolError::CodesignMachPreflightFailed);
    }
    Ok(Some(SendRight {
        task,
        value: Some(port),
    }))
}
fn checked_slot_type(task: u32, which: i32) -> Result<Option<u32>, ProtocolError> {
    let Some(mut right) = special_right(task, which)? else {
        return Ok(None);
    };
    let result = right.object_type();
    right.close()?;
    result.map(Some)
}
fn bind_task_access(task: u32, api: &Api) -> Result<(Option<u32>, &'static str), ProtocolError> {
    let Some(mut access) = special_right(task, 9)? else {
        return Ok((None, "absent"));
    };
    let mut bootstrap = None;
    let mut endpoint = None;
    let result = (|| {
        let kind = access.object_type()?;
        bootstrap = special_right(task, 4)?;
        let original_bootstrap = bootstrap
            .as_ref()
            .ok_or(ProtocolError::CodesignTaskAccessUnbound)?;
        original_bootstrap.require_ordinary_send()?;
        let mut service = MACH_PORT_NULL;
        // Fixed name, target_pid0, PRIVILEGED_SERVER bit3. libbootstrap checks
        // the kernel MIG UserAuditToken UID0; ordinary lookup/name/type matching
        // is not substituted when authentication fails. This lookup precedes
        // the child bootstrap-null action, and all compared send rights are live.
        let code = unsafe {
            (api.lookup2)(
                original_bootstrap.raw()?,
                c"com.apple.taskgated".as_ptr(),
                &mut service,
                0,
                1 << 3,
            )
        };
        if code != 0 {
            if service != MACH_PORT_NULL {
                return Err(ProtocolError::CodesignCleanupUnknown);
            }
            return Err(ProtocolError::CodesignTaskAccessUnbound);
        }
        if service == MACH_PORT_NULL || service == MACH_PORT_DEAD {
            return Err(ProtocolError::CodesignTaskAccessUnbound);
        }
        endpoint = Some(SendRight {
            task,
            value: Some(service),
        });
        let service = endpoint
            .as_ref()
            .ok_or(ProtocolError::CodesignTaskAccessUnbound)?;
        access.require_ordinary_send()?;
        service.require_ordinary_send()?;
        if access.raw()? != service.raw()? {
            return Err(ProtocolError::CodesignTaskAccessUnbound);
        }
        Ok((Some(kind), "privileged_taskgated_v1"))
    })();
    let mut failed = false;
    if let Some(right) = endpoint.as_mut() {
        failed |= right.close().is_err();
    }
    if let Some(right) = bootstrap.as_mut() {
        failed |= right.close().is_err();
    }
    failed |= access.close().is_err();
    if failed {
        return Err(ProtocolError::CodesignCleanupUnknown);
    }
    result
}
fn inspect_special_slots(api: &Api) -> Result<MachFacts, ProtocolError> {
    let task = unsafe { libc::mach_task_self() };
    let host = checked_slot_type(task, 2)?;
    if host != Some(3) {
        return Err(ProtocolError::CodesignHostCapabilityUnsupported);
    }
    let (access, access_service) = bind_task_access(task, api)?;
    // Reviewed ipc_task_init creates DEBUG_CONTROL and RESOURCE_NOTIFY as
    // new-task local slots and does not copy either from the parent. Querying
    // this helper is not an observation of that fresh-child boundary: DEBUG
    // can already have a helper-local receive right, and RESOURCE's getter is
    // conditional on the kernel build. Do not swallow getter errors as NULL
    // or use these unrelated observations as an always-failing launch gate.
    // Completed records the static review basis, not runtime empty-slot proof.
    Ok(MachFacts {
        host_object_type: 3,
        access_object_type: access,
        access_service,
    })
}

/// The production leaf and actual controls share the same fixed setter.
fn registered_three_null(
    api: &Api,
    attr: &mut libc::posix_spawnattr_t,
) -> Result<(), ProtocolError> {
    let registered = [MACH_PORT_NULL; 3];
    // count=0 is a no-op; three explicit null slots are required.
    if unsafe { codesign_i32!("registered", (api.registered)(attr, registered.as_ptr(), 3)) } != 0 {
        return Err(ProtocolError::CodesignMachActionFailed);
    }
    Ok(())
}
fn exception_bootstrap(api: &Api, attr: &mut libc::posix_spawnattr_t) -> Result<(), ProtocolError> {
    if unsafe {
        codesign_i32!(
            "exceptions",
            (api.exception)(
                attr,
                EXCEPTION_MASK,
                MACH_PORT_NULL,
                EXCEPTION_DEFAULT,
                THREAD_STATE_NONE,
            )
        )
    } != 0
        || unsafe { codesign_i32!("bootstrap_null", (api.special)(attr, MACH_PORT_NULL, 4)) } != 0
    {
        return Err(ProtocolError::CodesignMachActionFailed);
    }
    Ok(())
}

/// Prepare the exact original native capability boundary. The role cannot
/// select a service, flag, port action or caller proof. Every SPI rc is checked.
pub fn configure(attr: &mut libc::posix_spawnattr_t) -> Result<MachFacts, ProtocolError> {
    let api = Api::read()?;
    #[cfg(test)]
    let facts = if crate::codesign_darwin::faults::synthetic_mach() {
        // Test-only control-flow fixture, not an observed native capability.
        MachFacts {
            host_object_type: 3,
            access_object_type: None,
            access_service: "absent",
        }
    } else {
        inspect_special_slots(&api)?
    };
    #[cfg(not(test))]
    let facts = inspect_special_slots(&api)?;
    registered_three_null(&api, attr)?;
    exception_bootstrap(&api, attr)?;
    // Normal SIP rejects HOST/ACCESS NULL at actual spawn despite setter0.
    // Preserve only the constrained ordinary OS host and authenticated fixed
    // Task Access endpoint, rather than silently skipping a failed null action.
    Ok(facts)
}

#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub(crate) enum CapabilityRegisteredControl {
    Inherited,
    ZeroCount,
    ThreeNull,
}

/// Only the ignored actual-control suite selects these fresh-attribute
/// counterfactuals. It creates no MachFacts and does not certify the original
/// Host special slots. The production configure() path has no control argument.
#[cfg(test)]
pub(crate) fn configure_capability_test(
    attr: &mut libc::posix_spawnattr_t,
    control: CapabilityRegisteredControl,
) -> Result<(), ProtocolError> {
    let api = Api::read()?;
    match control {
        CapabilityRegisteredControl::Inherited => {}
        CapabilityRegisteredControl::ZeroCount => {
            // A new attribute is required: applying three-null first would make
            // this no-op control incapable of detecting the real inheritance.
            let registered = [MACH_PORT_NULL; 3];
            if unsafe { (api.registered)(attr, registered.as_ptr(), 0) } != 0 {
                return Err(ProtocolError::CodesignMachActionFailed);
            }
        }
        CapabilityRegisteredControl::ThreeNull => registered_three_null(&api, attr)?,
    }
    exception_bootstrap(&api, attr)
}

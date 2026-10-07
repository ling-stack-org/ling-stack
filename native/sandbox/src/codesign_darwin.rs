//! Direct Darwin leaf for the fixed codesign role. No fork, exec, shell, PATH
//! search, SPI fallback or caller-supplied readiness is used. Successful setters
//! are not OS certification: Root must validate actual inherited capabilities.
// Non-test expansion is exactly the original native expression. The test
// recorder/module and all fault values are absent from the release binary.
#[cfg(not(test))]
macro_rules! codesign_i32 {
    ($site:literal, $call:expr) => {{ $call }};
}
#[cfg(test)]
macro_rules! codesign_i32 {
    ($site:literal, $call:expr) => {{ $crate::codesign_darwin::faults::i32_call($site, || $call) }};
}
pub(crate) use codesign_i32;

#[cfg(not(test))]
macro_rules! codesign_deadline {
    ($site:literal, $started:expr, $budget:expr) => {{ $started.elapsed() >= $budget }};
}
#[cfg(test)]
macro_rules! codesign_deadline {
    ($site:literal, $started:expr, $budget:expr) => {{ $crate::codesign_darwin::faults::expired($site) || $started.elapsed() >= $budget }};
}

#[cfg(test)]
#[path = "codesign_faults.rs"]
pub(crate) mod faults;

use crate::protocol::ProtocolError;
use std::ffi::{CStr, CString};
use std::io;
use std::mem;
use std::os::fd::RawFd;
use std::ptr;
use std::time::{Duration, Instant};

pub use crate::codesign_mach::EXCEPTION_MASK;
use crate::codesign_mach::{self, MachFacts};
const OUTPUT_BYTES: usize = 48 * 1024;
const EXECUTION_DEADLINE: Duration = Duration::from_secs(30);
const CLEANUP_DEADLINE: Duration = Duration::from_secs(2);

type ChdirAction =
    unsafe extern "C" fn(*mut libc::posix_spawn_file_actions_t, *const libc::c_char) -> i32;

/// Strict original FD lifetime. If a descriptor is closed/reused, relinquish the
/// stale integer; never close a later owner's handle or silently retry EINTR.
pub struct OwnedFd {
    value: Option<RawFd>,
    identity: Option<(libc::dev_t, libc::ino_t, libc::mode_t)>,
}
impl OwnedFd {
    fn take_new(value: RawFd) -> Result<Self, ProtocolError> {
        let mut fd = Self {
            value: Some(value),
            identity: None,
        };
        let result = fd.stat();
        if let Err(error) = result {
            return match fd.close() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(cleanup),
            };
        }
        let stat = result?;
        fd.identity = Some((stat.st_dev, stat.st_ino, stat.st_mode & libc::S_IFMT));
        Ok(fd)
    }
    pub fn raw(&self) -> Result<RawFd, ProtocolError> {
        self.value.ok_or(ProtocolError::CodesignCleanupUnknown)
    }
    pub fn stat(&self) -> Result<libc::stat, ProtocolError> {
        let fd = self.raw()?;
        let mut stat: libc::stat = unsafe { mem::zeroed() };
        // SAFETY: live borrowed FD and correctly sized writable storage.
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return Err(ProtocolError::CodesignCleanupUnknown);
        }
        if self.identity.is_some_and(|original| {
            original != (stat.st_dev, stat.st_ino, stat.st_mode & libc::S_IFMT)
        }) {
            return Err(ProtocolError::CodesignCleanupUnknown);
        }
        Ok(stat)
    }
    pub fn close(&mut self) -> Result<(), ProtocolError> {
        let Some(value) = self.value else {
            return Ok(());
        };
        if self.identity.is_some() && self.stat().is_err() {
            self.value = None;
            return Err(ProtocolError::CodesignCleanupUnknown);
        }
        self.value = None;
        // SAFETY: this original FD is consumed once. A failed close is unknown,
        // not a prompt to close the same integer again after possible reuse.
        if unsafe { libc::close(value) } != 0 {
            return Err(ProtocolError::CodesignCleanupUnknown);
        }
        Ok(())
    }
}
impl Drop for OwnedFd {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

pub fn open_directory(parent: RawFd, path: &str) -> Result<OwnedFd, ProtocolError> {
    let path = CString::new(path).map_err(|_| ProtocolError::InvalidCodesignRequest)?;
    // SAFETY: terminated path, borrowed parent FD, transferred FD ownership.
    let fd = unsafe {
        libc::openat(
            parent,
            path.as_ptr(),
            libc::O_RDONLY
                | libc::O_DIRECTORY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(ProtocolError::CodesignSourceChanged);
    }
    OwnedFd::take_new(fd)
}

/// Node pipes may be Unix socketpairs. Only these private transport classes are
/// admitted, never a regular-file stdio handle into a protected Host domain.
pub fn require_private_stdio() -> Result<u32, ProtocolError> {
    for fd in [0, 1, 2] {
        let mut stat: libc::stat = unsafe { mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut stat) } != 0
            || ![libc::S_IFIFO, libc::S_IFSOCK].contains(&(stat.st_mode & libc::S_IFMT))
        {
            return Err(ProtocolError::CodesignStdioInvalid);
        }
    }
    close_inherited_extra_fds()
}

/// A fixed single-thread helper has no reason to retain parent FDs beyond the
/// original three pipes. Enumerate actual descriptors (not a possibly lowered
/// rlimit), close each once, then read back the exact remaining set. Child
/// CLOEXEC_DEFAULT still independently rejects any later non-file-action FD.
fn list_fd_numbers() -> Result<Vec<RawFd>, ProtocolError> {
    const ENTRIES: usize = 4096;
    let mut buffer: Vec<libc::proc_fdinfo> =
        (0..ENTRIES).map(|_| unsafe { mem::zeroed() }).collect();
    let bytes = mem::size_of::<libc::proc_fdinfo>() * ENTRIES;
    let count = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDLISTFDS,
            0,
            buffer.as_mut_ptr().cast(),
            bytes as i32,
        )
    };
    if count <= 0
        || count as usize >= bytes
        || count as usize % mem::size_of::<libc::proc_fdinfo>() != 0
    {
        return Err(ProtocolError::CodesignInheritedFdUnknown);
    }
    let count = count as usize / mem::size_of::<libc::proc_fdinfo>();
    let mut values: Vec<_> = buffer[..count].iter().map(|item| item.proc_fd).collect();
    values.sort_unstable();
    if values.iter().any(|fd| *fd < 0) || values.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ProtocolError::CodesignInheritedFdUnknown);
    }
    Ok(values)
}
fn close_inherited_extra_fds() -> Result<u32, ProtocolError> {
    let inherited = list_fd_numbers()?;
    let mut closed = 0;
    for value in inherited.into_iter().filter(|fd| *fd > 2) {
        let mut fd = OwnedFd::take_new(value)?;
        fd.close()?;
        closed += 1;
    }
    if list_fd_numbers()? != [0, 1, 2] {
        return Err(ProtocolError::CodesignInheritedFdUnknown);
    }
    Ok(closed)
}

pub(crate) fn symbol(name: &CStr) -> Result<*mut libc::c_void, ProtocolError> {
    // SAFETY: fixed OS symbol names only. The source fixes the helper binary and
    // environment; no DYLD injection or wire-selected library/name is accepted.
    #[cfg(test)]
    if faults::deny_symbol(name) {
        return Err(ProtocolError::CodesignApiUnsupported);
    }
    let address = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if address.is_null() {
        Err(ProtocolError::CodesignApiUnsupported)
    } else {
        Ok(address)
    }
}
struct SpawnState {
    attr: libc::posix_spawnattr_t,
    attr_live: bool,
    actions: libc::posix_spawn_file_actions_t,
    actions_live: bool,
    pipes: Vec<OwnedFd>,
    mach: Option<MachFacts>,
}
impl SpawnState {
    fn empty() -> Self {
        Self {
            attr: ptr::null_mut(),
            attr_live: false,
            actions: ptr::null_mut(),
            actions_live: false,
            pipes: Vec::with_capacity(6),
            mach: None,
        }
    }
    fn close(&mut self) -> Result<(), ProtocolError> {
        let mut failed = false;
        for fd in &mut self.pipes {
            failed |= fd.close().is_err();
        }
        if self.actions_live {
            self.actions_live = false;
            failed |= unsafe {
                codesign_i32!(
                    "actions_destroy",
                    libc::posix_spawn_file_actions_destroy(&mut self.actions)
                )
            } != 0;
        }
        if self.attr_live {
            self.attr_live = false;
            failed |= unsafe {
                codesign_i32!(
                    "attr_destroy",
                    libc::posix_spawnattr_destroy(&mut self.attr)
                )
            } != 0;
        }
        if failed {
            Err(ProtocolError::CodesignCleanupUnknown)
        } else {
            Ok(())
        }
    }
    fn prepare_initial(&mut self) -> Result<(), ProtocolError> {
        // SAFETY: exclusive correctly typed attr/actions storage. Each successful
        // init has one checked destroy; partial failures close every owned FD.
        if unsafe { codesign_i32!("attr_init", libc::posix_spawnattr_init(&mut self.attr)) } != 0 {
            return Err(ProtocolError::CodesignPrepareFailed);
        }
        self.attr_live = true;
        if unsafe {
            codesign_i32!(
                "actions_init",
                libc::posix_spawn_file_actions_init(&mut self.actions)
            )
        } != 0
        {
            return Err(ProtocolError::CodesignPrepareFailed);
        }
        self.actions_live = true;
        Ok(())
    }
    fn prepare_fixed_flags(&mut self) -> Result<(), ProtocolError> {
        let mut mask: libc::sigset_t = unsafe { mem::zeroed() };
        let mut defaults: libc::sigset_t = unsafe { mem::zeroed() };
        let flags = (libc::POSIX_SPAWN_CLOEXEC_DEFAULT
            | libc::POSIX_SPAWN_SETPGROUP
            | libc::POSIX_SPAWN_SETSIGMASK
            | libc::POSIX_SPAWN_SETSIGDEF) as libc::c_short;
        if unsafe { libc::sigemptyset(&mut mask) } != 0
            || unsafe { libc::sigfillset(&mut defaults) } != 0
            || unsafe {
                codesign_i32!(
                    "flags",
                    libc::posix_spawnattr_setflags(&mut self.attr, flags)
                )
            } != 0
            || unsafe {
                codesign_i32!("pgroup", libc::posix_spawnattr_setpgroup(&mut self.attr, 0))
            } != 0
            || unsafe {
                codesign_i32!(
                    "sigmask",
                    libc::posix_spawnattr_setsigmask(&mut self.attr, &mask)
                )
            } != 0
            || unsafe {
                codesign_i32!(
                    "sigdefault",
                    libc::posix_spawnattr_setsigdefault(&mut self.attr, &defaults)
                )
            } != 0
        {
            return Err(ProtocolError::CodesignPrepareFailed);
        }
        Ok(())
    }
    fn prepare_fixed_io(&mut self, chdir: ChdirAction) -> Result<(), ProtocolError> {
        if unsafe { codesign_i32!("chdir", chdir(&mut self.actions, c"/".as_ptr())) } != 0 {
            return Err(ProtocolError::CodesignPrepareFailed);
        }
        for _ in 0..3 {
            let mut raw = [-1; 2];
            if unsafe { codesign_i32!("pipe", libc::pipe(raw.as_mut_ptr())) } != 0 {
                return Err(ProtocolError::CodesignPrepareFailed);
            }
            // Own both endpoints before validation so a partial fstat failure
            // cannot abandon the second endpoint. No concurrent helper thread.
            self.pipes.extend(raw.into_iter().map(|value| OwnedFd {
                value: Some(value),
                identity: None,
            }));
            let start = self.pipes.len() - 2;
            for fd in &mut self.pipes[start..] {
                let stat = fd.stat()?;
                if fd.raw()? <= 2 || stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
                    return Err(ProtocolError::CodesignPrepareFailed);
                }
                fd.identity = Some((stat.st_dev, stat.st_ino, stat.st_mode & libc::S_IFMT));
                if unsafe { libc::fcntl(fd.raw()?, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
                    return Err(ProtocolError::CodesignPrepareFailed);
                }
            }
        }
        for (source, target) in [(0, 0), (3, 1), (5, 2)] {
            let source_fd = self.pipes[source].raw()?;
            if unsafe {
                codesign_i32!(
                    "dup2",
                    libc::posix_spawn_file_actions_adddup2(&mut self.actions, source_fd, target,)
                )
            } != 0
            {
                return Err(ProtocolError::CodesignPrepareFailed);
            }
        }
        // Explicitly close all six originals after dup2. The action-source FDs
        // must not remain merely because they appeared in a Darwin file action.
        for fd in &self.pipes {
            let raw_fd = fd.raw()?;
            if unsafe {
                codesign_i32!(
                    "addclose",
                    libc::posix_spawn_file_actions_addclose(&mut self.actions, raw_fd)
                )
            } != 0
            {
                return Err(ProtocolError::CodesignPrepareFailed);
            }
        }
        for index in [2, 4] {
            let fd = self.pipes[index].raw()?;
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0
            {
                return Err(ProtocolError::CodesignPrepareFailed);
            }
        }
        Ok(())
    }
    fn prepare(&mut self, chdir: ChdirAction) -> Result<(), ProtocolError> {
        self.prepare_initial()?;
        self.prepare_fixed_flags()?;
        // The production leaf still performs the complete original preflight.
        // No control selection or alternate target is accepted by this path.
        self.mach = Some(codesign_mach::configure(&mut self.attr)?);
        self.prepare_fixed_io(chdir)
    }
}
impl Drop for SpawnState {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

pub struct CapturedProcess {
    pub child_pid: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub mach: MachFacts,
}
struct Child {
    pid: libc::pid_t,
    status: Option<i32>,
    cleanup_attempted: bool,
    wait_unknown: bool,
}
impl Child {
    fn poll(&mut self) -> Result<(), ProtocolError> {
        if self.status.is_some() {
            return Ok(());
        }
        let mut status = 0;
        let waited = unsafe {
            codesign_i32!(
                "waitpid",
                libc::waitpid(self.pid, &mut status, libc::WNOHANG)
            )
        };
        if waited == self.pid {
            self.status = Some(status);
            return Ok(());
        }
        if waited == 0
            || (waited == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR))
        {
            return Ok(());
        }
        self.wait_unknown = true;
        Err(ProtocolError::CodesignWaitFailed)
    }
    fn stop(&mut self) -> Result<(), ProtocolError> {
        // Never signal a reaped PID that could now belong to another process.
        if self.status.is_some() {
            return Ok(());
        }
        if self.cleanup_attempted || self.wait_unknown {
            return Err(ProtocolError::CodesignCleanupUnknown);
        }
        self.cleanup_attempted = true;
        if unsafe { codesign_i32!("kill_group", libc::kill(-self.pid, libc::SIGKILL)) } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(ProtocolError::CodesignCleanupUnknown);
        }
        let started = Instant::now();
        while self.status.is_none() {
            self.poll()
                .map_err(|_| ProtocolError::CodesignCleanupUnknown)?;
            if codesign_deadline!("cleanup_deadline", started, CLEANUP_DEADLINE) {
                return Err(ProtocolError::CodesignCleanupUnknown);
            }
            if self.status.is_none() {
                unsafe { libc::poll(ptr::null_mut(), 0, 20) };
            }
        }
        Ok(())
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn read_available(fd: &mut OwnedFd, output: &mut Vec<u8>) -> Result<(), ProtocolError> {
    let mut chunk = [0_u8; 4096];
    loop {
        let count = unsafe { libc::read(fd.raw()?, chunk.as_mut_ptr().cast(), chunk.len()) };
        if count == 0 {
            return fd.close();
        }
        if count < 0 {
            match io::Error::last_os_error().raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::EAGAIN) => return Ok(()),
                _ => return Err(ProtocolError::CodesignOutputUnavailable),
            }
        }
        let count = count as usize;
        if output.len() + count > OUTPUT_BYTES {
            return Err(ProtocolError::CodesignOutputBudgetExceeded);
        }
        output.extend_from_slice(&chunk[..count]);
    }
}

fn capture(
    child: &mut Child,
    state: &mut SpawnState,
    parent: u32,
) -> Result<CapturedProcess, ProtocolError> {
    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        if unsafe { libc::getppid() } as u32 != parent {
            return Err(ProtocolError::ParentMismatch);
        }
        if codesign_deadline!("execution_deadline", started, EXECUTION_DEADLINE) {
            return Err(ProtocolError::CodesignTimeout);
        }
        child.poll()?;
        let mut polls = [
            libc::pollfd {
                fd: state.pipes[2].value.unwrap_or(-1),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: state.pipes[4].value.unwrap_or(-1),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        if child.status.is_some() && polls.iter().all(|item| item.fd == -1) {
            break;
        }
        let ready = unsafe { libc::poll(polls.as_mut_ptr(), 2, 100) };
        if ready < 0 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(ProtocolError::CodesignOutputUnavailable);
        }
        for (position, output) in [(0, &mut stdout), (1, &mut stderr)] {
            if polls[position].revents & libc::POLLNVAL != 0 {
                return Err(ProtocolError::CodesignCleanupUnknown);
            }
            if polls[position].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                read_available(&mut state.pipes[2 + position * 2], output)?;
            }
        }
    }
    let status = child.status.ok_or(ProtocolError::CodesignWaitFailed)?;
    if !libc::WIFEXITED(status) && !libc::WIFSIGNALED(status) {
        return Err(ProtocolError::CodesignWaitFailed);
    }
    Ok(CapturedProcess {
        child_pid: child.pid as u32,
        exit_code: libc::WIFEXITED(status).then(|| libc::WEXITSTATUS(status)),
        signal: libc::WIFSIGNALED(status).then(|| libc::WTERMSIG(status)),
        stdout,
        stderr,
        mach: state
            .mach
            .ok_or(ProtocolError::CodesignMachPreflightFailed)?,
    })
}

/// Only the source-private fixed role calls this function. Every result after
/// actual posix_spawn is provisional until wait, endpoint cleanup and checked
/// attr/action destruction finish. No fallback executes on ENOSYS or other rc.
pub fn execute(arguments: &[CString], parent: u32) -> Result<CapturedProcess, ProtocolError> {
    if arguments.len() != 8 || arguments[0].as_c_str() != c"/usr/bin/sandbox-exec" {
        return Err(ProtocolError::InvalidCodesignRequest);
    }
    // SAFETY: fixed Darwin chdir SPI; missing symbol is a typed refusal.
    let chdir = unsafe {
        mem::transmute::<*mut libc::c_void, ChdirAction>(symbol(
            c"posix_spawn_file_actions_addchdir_np",
        )?)
    };
    let mut state = SpawnState::empty();
    let result = (|| {
        state.prepare(chdir)?;
        let env = [
            c"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            c"LANG=en_US.UTF-8",
            c"HOME=/",
            c"TMPDIR=/private/tmp/",
            c"PWD=/",
        ];
        let mut argv: Vec<_> = arguments
            .iter()
            .map(|arg| arg.as_ptr().cast_mut())
            .collect();
        let mut environment: Vec<_> = env
            .into_iter()
            .map(|value| value.as_ptr().cast_mut())
            .collect();
        argv.push(ptr::null_mut());
        environment.push(ptr::null_mut());
        let mut pid = 0;
        // SAFETY: fixed terminated strings, live attr/actions, synchronous call;
        // no pointer escapes and no general command, shell or PATH is selected.
        let code = unsafe {
            codesign_i32!(
                "spawn",
                libc::posix_spawn(
                    &mut pid,
                    c"/usr/bin/sandbox-exec".as_ptr(),
                    &state.actions,
                    &state.attr,
                    argv.as_ptr(),
                    environment.as_ptr(),
                )
            )
        };
        if code != 0 || pid <= 0 {
            return Err(ProtocolError::CodesignSpawnFailed);
        }
        let mut child = Child {
            pid,
            status: None,
            cleanup_attempted: false,
            wait_unknown: false,
        };
        let captured = (|| {
            // Helper retains only its output-read ends. Closing both stdin ends
            // supplies EOF; child write ends must be closed here for real EOF.
            for index in [0, 1, 3, 5] {
                state.pipes[index].close()?;
            }
            capture(&mut child, &mut state, parent)
        })();
        if captured.is_err() {
            child.stop()?;
        }
        captured
    })();
    state.close()?;
    result
}

#[cfg(test)]
#[path = "codesign_darwin_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "codesign_capability_tests.rs"]
mod capability_tests;

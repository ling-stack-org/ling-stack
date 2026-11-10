//! Explicit Root-run actual controls. Not the production helper/issuer gate.
//! These ignored tests require a separately built fixed single-thread observer;
//! an ignored default cargo result never supplies actual-control PASS.
use super::*;
use std::fs::{self, OpenOptions};
use std::os::fd::IntoRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
#[path = "../tests/support/codesign-capability-wire.rs"]
mod wire;
type Result<T> = std::result::Result<T, String>;
fn protocol<T>(result: std::result::Result<T, ProtocolError>) -> Result<T> {
    result.map_err(|error| format!("native_primitive:{error:?}"))
}
fn observer() -> Result<CString> {
    let path = option_env!("LING_CODESIGN_CAPABILITY_OBSERVER")
        .ok_or("observer_not_built_for_this_test")?;
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !path.starts_with("/private/tmp")
        || !path
            .file_name()
            .is_some_and(|name| name == "ling-codesign-capability-observer")
    {
        return Err("observer_build_path_invalid".into());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| "observer_metadata_unavailable")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || fs::canonicalize(&path).map_err(|_| "observer_path_unavailable")? != path
    {
        return Err("observer_original_path_invalid".into());
    }
    CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| "observer_path_invalid".into())
}
fn finish_input(state: &mut SpawnState, value: &serde_json::Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| "fixture_input_serialize")?;
    if bytes.len() > 4096 {
        return Err("fixture_input_budget".into());
    }
    let fd = protocol(state.pipes[1].raw())?;
    let mut offset = 0;
    while offset < bytes.len() {
        let count =
            unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
        if count < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if count <= 0 {
            return Err("fixture_input_write_failed".into());
        }
        offset += count as usize;
    }
    for index in [0, 1, 3, 5] {
        protocol(state.pipes[index].close())?;
    }
    Ok(())
}
fn capture_actual(child: &mut Child, state: &mut SpawnState) -> Result<serde_json::Value> {
    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        if started.elapsed() >= Duration::from_secs(6) {
            return Err("actual_observer_deadline".into());
        }
        protocol(child.poll())?;
        for (index, output) in [(2, &mut stdout), (4, &mut stderr)] {
            if state.pipes[index].value.is_some() {
                protocol(read_available(&mut state.pipes[index], output))?;
            }
        }
        if child.status.is_some()
            && state.pipes[2].value.is_none()
            && state.pipes[4].value.is_none()
        {
            break;
        }
        unsafe { libc::poll(ptr::null_mut(), 0, 10) };
    }
    let status = child.status.ok_or("actual_observer_wait_unknown")?;
    if !libc::WIFEXITED(status)
        || libc::WEXITSTATUS(status) != 0
        || !stderr.is_empty()
        || stdout.len() > 8192
    {
        return Err(format!(
            "actual_observer_bad_terminal:{status}:stdout{}:stderr{}",
            stdout.len(),
            stderr.len()
        ));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&stdout).map_err(|_| "actual_observer_bad_json")?;
    if value["type"] != "capability_fixture"
        || value["hostCertification"] != false
        || value["descendantDrain"] != "not_verified"
    {
        return Err("actual_observer_wrong_receipt".into());
    }
    Ok(value["facts"].clone())
}

/// Private test launcher only. No production execute() alternate target exists.
fn launch_actual(
    control: codesign_mach::CapabilityRegisteredControl,
    cloexec: bool,
    identity: &serde_json::Value,
    mut service: impl FnMut() -> Result<()>,
) -> Result<serde_json::Value> {
    let executable = observer()?;
    let chdir = unsafe {
        mem::transmute::<*mut libc::c_void, ChdirAction>(protocol(symbol(
            c"posix_spawn_file_actions_addchdir_np",
        ))?)
    };
    let mut state = SpawnState::empty();
    let result = (|| {
        protocol(state.prepare_initial())?;
        protocol(state.prepare_fixed_flags())?;
        if !cloexec {
            // Derive baseline from actual production flags, remove only the
            // intended CLOEXEC bit. Not a production configuration option.
            let mut flags = 0;
            wire::checked(
                unsafe { libc::posix_spawnattr_getflags(&state.attr, &mut flags) },
                "get_actual_flags",
            )?;
            wire::checked(
                unsafe {
                    libc::posix_spawnattr_setflags(
                        &mut state.attr,
                        flags & !(libc::POSIX_SPAWN_CLOEXEC_DEFAULT as libc::c_short),
                    )
                },
                "baseline_flags",
            )?;
        }
        // This tests shared fixed attr actions only. It does not pretend to
        // authenticate all original Host special slots or make synthetic facts.
        protocol(codesign_mach::configure_capability_test(
            &mut state.attr,
            control,
        ))?;
        protocol(state.prepare_fixed_io(chdir))?;
        let args = [executable.as_ptr().cast_mut(), ptr::null_mut()];
        let env = [c"PATH=/usr/bin:/bin".as_ptr().cast_mut(), ptr::null_mut()];
        let mut pid = 0;
        wire::checked(
            unsafe {
                libc::posix_spawn(
                    &mut pid,
                    executable.as_ptr(),
                    &state.actions,
                    &state.attr,
                    args.as_ptr(),
                    env.as_ptr(),
                )
            },
            "actual_observer_spawn",
        )?;
        if pid <= 0 {
            return Err("actual_observer_invalid_owned_pid".into());
        }
        let mut child = Child {
            pid,
            status: None,
            cleanup_attempted: false,
            wait_unknown: false,
        };
        let result = (|| {
            finish_input(&mut state, identity)?;
            service()?;
            capture_actual(&mut child, &mut state)
        })();
        let cleanup = if result.is_err() {
            protocol(child.stop())
        } else {
            Ok(())
        };
        match (result, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (result, Err(cleanup)) => Err(format!(
                "actual_owned_child_cleanup_unknown:{result:?};{cleanup}"
            )),
        }
    })();
    let cleanup = protocol(state.close());
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (result, Err(cleanup)) => Err(format!(
            "actual_attr_fd_cleanup_unknown:{result:?};{cleanup}"
        )),
    }
}

struct RegisteredFixture {
    original: wire::Lookup,
    saved: [u32; 3],
    port: wire::Port,
    installed: bool,
}
impl RegisteredFixture {
    fn create(slot: usize) -> Result<Self> {
        let mut original = wire::Lookup::read()?;
        if original.ports.len() > 3 {
            original.close()?;
            return Err("original_registered_shape_unsupported".into());
        }
        let mut saved = [0; 3];
        saved[..original.ports.len()].copy_from_slice(&original.ports);
        let mut port = wire::Port::receive_only()?;
        if let Err(error) = port.make_send() {
            let a = port.close();
            let b = original.close();
            return Err(format!("{error};cleanup:{a:?}:{b:?}"));
        }
        let mut fixture = Self {
            original,
            saved,
            port,
            installed: false,
        };
        let mut slots = [0; 3];
        slots[slot] = fixture.port.name;
        let code = unsafe { wire::mach_ports_register(libc::mach_task_self(), slots.as_ptr(), 3) };
        if code != 0 {
            let cleanup = fixture.close();
            return Err(format!("fixture_register:{code};cleanup:{cleanup:?}"));
        }
        fixture.installed = true;
        Ok(fixture)
    }
    fn answer(&mut self, secret: [u8; 32]) -> Result<()> {
        let request = wire::receive(self.port.name, 2000)?.ok_or("parent_service_no_request")?;
        if request.header.size != wire::MESSAGE_BYTES
            || request.header.id != wire::REQUEST_ID
            || request.header.bits & 0x80000000 != 0
            || request.header.remote == 0
            || request.header.remote == u32::MAX
            || request.header.bits & 0x1f != 18
            || request.bytes != [0; 32]
        {
            // A bad received message may own additional rights. Never claim
            // successful closure based on a borrowed integer or repeated send.
            return Err("parent_service_bad_request_cleanup_unknown".into());
        }
        let mut reply =
            wire::Message::outgoing(request.header.remote, 0, wire::REPLY_ID, secret, 18);
        wire::send(&mut reply)
            .map_err(|error| format!("parent_reply_sendonce_ownership_unknown:{error}"))?;
        // MOVE_SEND_ONCE consumed exactly the successful received reply right.
        Ok(())
    }
    fn no_message(&mut self) -> Result<()> {
        if wire::receive(self.port.name, 100)?.is_some() {
            return Err("cleared_registered_still_reached_parent_service".into());
        }
        Ok(())
    }
    fn close(&mut self) -> Result<()> {
        let mut failures = Vec::new();
        if self.installed {
            self.installed = false;
            let code = unsafe {
                wire::mach_ports_register(libc::mach_task_self(), self.saved.as_ptr(), 3)
            };
            if code != 0 {
                failures.push(format!("original_registered_restore:{code}"));
            } else {
                match wire::Lookup::read() {
                    Ok(mut verify) => {
                        let mut slots = [0; 3];
                        if verify.ports.len() > 3 {
                            failures.push("restore_readback_shape".into());
                        } else {
                            slots[..verify.ports.len()].copy_from_slice(&verify.ports);
                            if slots != self.saved {
                                failures.push("restore_readback_mismatch".into());
                            }
                        }
                        if let Err(error) = verify.close() {
                            failures.push(error);
                        }
                    }
                    Err(error) => failures.push(error),
                }
            }
        }
        if let Err(error) = self.original.close() {
            failures.push(error);
        }
        if let Err(error) = self.port.close() {
            failures.push(error);
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join(";"))
        }
    }
}
impl Drop for RegisteredFixture {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[test]
#[ignore = "Root-only actual native observer; run explicitly, never count ignored as PASS"]
fn registered_real_service_baseline_zero_count_and_three_null() {
    use codesign_mach::CapabilityRegisteredControl::{Inherited, ThreeNull, ZeroCount};
    for slot in 0..3 {
        let mut fixture = RegisteredFixture::create(slot).expect("own registered fixture");
        let result = (|| -> Result<()> {
            for control in [Inherited, ZeroCount, ThreeNull] {
                let mut secret = [0; 32];
                wire::checked(
                    unsafe { libc::getentropy(secret.as_mut_ptr().cast(), secret.len()) },
                    "parent_random_fixture",
                )?;
                let positive = !matches!(control, ThreeNull);
                let facts = launch_actual(
                    control,
                    true,
                    &serde_json::json!({ "device": null, "inode": null }),
                    || {
                        if positive {
                            fixture.answer(secret)
                        } else {
                            Ok(())
                        }
                    },
                )?;
                if facts["lookupCleanup"] != "completed" {
                    return Err("lookup_cleanup_missing".into());
                }
                let slots = facts["slots"]
                    .as_array()
                    .ok_or("child_slot_receipt_invalid")?;
                if slots.len() != 3 {
                    return Err("child_slot_receipt_size".into());
                }
                if positive {
                    for (index, value) in slots.iter().enumerate() {
                        let port = value
                            .as_u64()
                            .ok_or("baseline_registered_slot_not_integer")?;
                        if if index == slot {
                            port == 0 || port >= u32::MAX as u64
                        } else {
                            port != 0
                        } {
                            return Err("baseline_registered_slot_invalid".into());
                        }
                    }
                    if facts["replies"].as_array().map(Vec::len) != Some(1)
                        || facts["replies"][0]["slot"] != slot
                        || facts["replies"][0]["received"] != serde_json::json!(secret.to_vec())
                    {
                        return Err("actual_parent_random_response_not_received".into());
                    }
                } else {
                    if slots.iter().any(|port| port != &serde_json::json!(0))
                        || facts["replies"] != serde_json::json!([])
                    {
                        return Err("three_null_registered_not_cleared".into());
                    }
                    fixture.no_message()?; // Not the sole negative evidence.
                }
                eprintln!(
                    "actual registered slot={slot} control={control:?} positive={positive}; real_parent_message={positive}; certificate=false"
                );
            }
            Ok(())
        })();
        let cleanup = fixture.close();
        assert!(
            result.is_ok() && cleanup.is_ok(),
            "actual registered failure={result:?}; cleanup={cleanup:?}"
        );
    }
}

struct FileFixture {
    root: PathBuf,
    path: PathBuf,
    fd: Option<OwnedFd>,
    original: Option<libc::stat>,
    root_identity: libc::stat,
    closed: bool,
}
impl FileFixture {
    fn create() -> Result<Self> {
        // Do not replace an existing harness/user FD3. This isolated parent
        // must start with the slot vacant, otherwise the fixture is blocked.
        if unsafe { libc::fcntl(3, libc::F_GETFD) } != -1
            || io::Error::last_os_error().raw_os_error() != Some(libc::EBADF)
        {
            return Err("actual_parent_fd3_not_vacant".into());
        }
        let mut template = b"/private/tmp/ling-codesign-capability-XXXXXX\0".to_vec();
        let returned = unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) };
        if returned.is_null() {
            return Err("fixture_mkdtemp_failed".into());
        }
        let root = PathBuf::from(
            unsafe { CStr::from_ptr(returned) }
                .to_str()
                .map_err(|_| "fixture_path_invalid")?,
        );
        let root_name = CString::new(root.as_os_str().as_encoded_bytes())
            .map_err(|_| "fixture_path_invalid")?;
        let mut root_identity: libc::stat = unsafe { mem::zeroed() };
        if unsafe { libc::lstat(root_name.as_ptr(), &mut root_identity) } != 0
            || root_identity.st_mode & libc::S_IFMT != libc::S_IFDIR
        {
            // No unbound path is removed when its original identity is unknown.
            return Err("fixture_root_identity_cleanup_unknown".into());
        }
        let path = root.join("fixture.bin");
        let mut fixture = Self {
            root,
            path,
            fd: None,
            original: None,
            root_identity,
            closed: false,
        };
        let result = (|| -> Result<()> {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&fixture.path)
                .map_err(|_| "fixture_open_failed")?;
            fixture.fd = Some(OwnedFd {
                value: Some(file.into_raw_fd()),
                identity: None,
            });
            let fd = fixture.fd.as_mut().ok_or("fixture_fd_missing")?;
            let original = protocol(fd.stat())?;
            fd.identity = Some((
                original.st_dev,
                original.st_ino,
                original.st_mode & libc::S_IFMT,
            ));
            fixture.original = Some(original);
            if protocol(fd.raw())? != 3 {
                return Err("fixture_not_actual_fd3".into());
            }
            let bytes = [b'D'; 4096];
            let mut offset = 0;
            while offset < bytes.len() {
                let count = unsafe {
                    libc::pwrite(
                        3,
                        bytes[offset..].as_ptr().cast(),
                        bytes.len() - offset,
                        offset as libc::off_t,
                    )
                };
                if count < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                if count <= 0 {
                    return Err("fixture_write_failed".into());
                }
                offset += count as usize;
            }
            let flags = unsafe { libc::fcntl(3, libc::F_GETFD) };
            if flags < 0 {
                return Err("fixture_get_cloexec_failed".into());
            }
            wire::checked(
                unsafe { libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) },
                "fixture_clear_cloexec",
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => Ok(fixture),
            Err(error) => {
                let cleanup = fixture.close();
                Err(format!("{error};fixture_cleanup:{cleanup:?}"))
            }
        }
    }
    fn input(&self) -> Result<serde_json::Value> {
        let original = self
            .original
            .as_ref()
            .ok_or("fixture_original_identity_missing")?;
        Ok(
            serde_json::json!({ "device": original.st_dev.to_string(), "inode": original.st_ino.to_string() }),
        )
    }
    fn readback(&self) -> Result<Vec<u8>> {
        let fd = self.fd.as_ref().ok_or("fixture_original_fd_missing")?;
        let original = self
            .original
            .as_ref()
            .ok_or("fixture_original_identity_missing")?;
        let current = protocol(fd.stat())?;
        if current.st_dev != original.st_dev
            || current.st_ino != original.st_ino
            || current.st_size != 4096
        {
            return Err("fixture_original_identity_changed".into());
        }
        let mut bytes = vec![0; 4096];
        if unsafe {
            libc::pread(
                protocol(fd.raw())?,
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                0,
            )
        } != bytes.len() as isize
        {
            return Err("fixture_original_readback_failed".into());
        }
        Ok(bytes)
    }
    fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let mut failures = Vec::new();
        if let Some(fd) = self.fd.as_mut() {
            if let Err(error) = protocol(fd.close()) {
                failures.push(error);
            }
        }
        let mut identities = vec![(&self.root, &self.root_identity, true)];
        if let Some(original) = self.original.as_ref() {
            identities.push((&self.path, original, false));
        } else if fs::symlink_metadata(&self.path).is_ok() {
            failures.push("fixture_unbound_file_cleanup_unknown".into());
        }
        for (path, original, directory) in identities {
            let name = CString::new(path.as_os_str().as_encoded_bytes())
                .map_err(|_| "fixture_cleanup_path")?;
            let mut current: libc::stat = unsafe { mem::zeroed() };
            if unsafe { libc::lstat(name.as_ptr(), &mut current) } != 0
                || current.st_dev != original.st_dev
                || current.st_ino != original.st_ino
                || current.st_mode & libc::S_IFMT
                    != if directory {
                        libc::S_IFDIR
                    } else {
                        libc::S_IFREG
                    }
            {
                failures.push("fixture_cleanup_original_path_changed".into());
            }
        }
        if !failures.is_empty() {
            return Err(failures.join(";"));
        }
        if self.original.is_some() {
            fs::remove_file(&self.path).map_err(|_| "fixture_exact_unlink_failed")?;
        }
        fs::remove_dir(&self.root).map_err(|_| "fixture_exact_rmdir_failed".to_owned())
    }
}
impl Drop for FileFixture {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[test]
#[ignore = "Root-only actual native observer; run explicitly, never count ignored as PASS"]
fn fd3_actual_read_mmap_write_baseline_then_cloexec_ebadf() {
    use codesign_mach::CapabilityRegisteredControl::ThreeNull;
    for cloexec in [false, true] {
        let mut fixture = FileFixture::create().expect("fresh original FD3 fixture");
        let result = (|| -> Result<()> {
            let facts = launch_actual(ThreeNull, cloexec, &fixture.input()?, || Ok(()))?;
            let fd = &facts["fd3"];
            let original = fixture
                .original
                .as_ref()
                .ok_or("fixture_original_identity_missing")?;
            if facts["slots"] != serde_json::json!([0, 0, 0])
                || facts["replies"] != serde_json::json!([])
                || facts["lookupCleanup"] != "completed"
                || fd["maps"].as_array().map(Vec::len) != Some(2)
            {
                return Err("fd3_control_receipt_invalid".into());
            }
            if !cloexec {
                if fd["statCode"] != 0
                    || fd["device"] != original.st_dev.to_string()
                    || fd["inode"] != original.st_ino.to_string()
                    || fd["readCode"] != 32
                    || fd["readBytes"] != serde_json::json!([b'D'; 32].to_vec())
                {
                    return Err("fd3_baseline_real_identity_read_failed".into());
                }
                for index in 0..2 {
                    if fd["maps"][index]["ok"] != true
                        || fd["maps"][index]["munmap"] != 0
                        || fd["maps"][index]["sample"] != serde_json::json!([b'D'; 32].to_vec())
                    {
                        return Err("fd3_baseline_real_mmap_failed".into());
                    }
                }
                let mut expected = vec![b'D'; 4096];
                expected[0] = b'M';
                if fixture.readback()? != expected {
                    return Err("fd3_shared_mmap_parent_mutation_absent".into());
                }
            } else {
                if fd["statCode"] != -1
                    || fd["statErrno"] != libc::EBADF
                    || fd["readCode"] != -1
                    || fd["readErrno"] != libc::EBADF
                {
                    return Err("fd3_negative_not_actual_ebadf".into());
                }
                for index in 0..2 {
                    if fd["maps"][index]["ok"] != false || fd["maps"][index]["errno"] != libc::EBADF
                    {
                        return Err("fd3_negative_mmap_not_actual_ebadf".into());
                    }
                }
                if fixture.readback()? != vec![b'D'; 4096] {
                    return Err("fd3_negative_parent_fixture_mutated".into());
                }
            }
            eprintln!(
                "actual FD3 cloexec={cloexec}; parent_original_readback=true; helper_never_inherited_claim=false; certificate=false"
            );
            Ok(())
        })();
        let cleanup = fixture.close();
        assert!(
            result.is_ok() && cleanup.is_ok(),
            "actual FD3 failure={result:?}; cleanup={cleanup:?}"
        );
    }
}

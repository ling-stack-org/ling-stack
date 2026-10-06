//! A fixed original-Host codesign role, not a general command runner or grant.
//! Pipe claims are correlation only; the Host retains and checks the actual
//! source, App, helper, OS backend, build and full-operation identities.
use crate::codesign_darwin::{self, CapturedProcess, OwnedFd};
use crate::protocol::{self, ProtocolError};
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::io::{self, Read, Write};

pub const ROLE: &str = "packaged_codesign_v1";
const MAX_PATH_BYTES: usize = 4096;
const SYSTEM_READ_ROOTS: [&str; 7] = [
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/share",
    "/System/Library",
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodesignRequest {
    protocol_version: u32,
    operation: String,
    request_id: String,
    nonce: String,
    expected_helper_version: String,
    parent_pid: u32,
    host_process_epoch: String,
    app_bundle_path: String,
    app_device: String,
    app_inode: String,
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn canonical_number(value: &str) -> bool {
    value
        .parse::<u64>()
        .is_ok_and(|parsed| parsed.to_string() == value)
}

fn parse_request(bytes: &[u8], parent: u32) -> Result<CodesignRequest, ProtocolError> {
    let request: CodesignRequest =
        serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidCodesignRequest)?;
    if request.protocol_version != protocol::VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    if request.operation != ROLE {
        return Err(ProtocolError::UnsupportedOperation);
    }
    if request.expected_helper_version != env!("CARGO_PKG_VERSION") {
        return Err(ProtocolError::HelperVersionMismatch);
    }
    if request.parent_pid == 0 || request.parent_pid != parent {
        return Err(ProtocolError::ParentMismatch);
    }
    let path = &request.app_bundle_path;
    if !valid_id(&request.request_id)
        || !valid_id(&request.host_process_epoch)
        || request.nonce.len() != 64
        || !request
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !path.starts_with('/')
        || !path.ends_with(".app")
        || path.len() > MAX_PATH_BYTES
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path[1..]
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !canonical_number(&request.app_device)
        || !canonical_number(&request.app_inode)
    {
        return Err(ProtocolError::InvalidCodesignRequest);
    }
    Ok(request)
}

/// Match the independently reviewed fixed Host renderer byte-for-byte. No
/// profile, executable, environment, working directory or argv is accepted from
/// the wire. Quotes are JSON strings because backslashes/controls are rejected.
fn fixed_profile(app: &str) -> Result<String, ProtocolError> {
    let reads = SYSTEM_READ_ROOTS
        .into_iter()
        .chain(std::iter::once(app))
        .map(|path| {
            serde_json::to_string(path)
                .map(|quoted| format!("(subpath {quoted})"))
                .map_err(|_| ProtocolError::InvalidCodesignRequest)
        })
        .collect::<Result<Vec<_>, _>>()?
        .join(" ");
    Ok([
        "(version 1)".to_owned(),
        "(deny default)".to_owned(),
        "(import \"/System/Library/Sandbox/Profiles/dyld-support.sb\")".to_owned(),
        "(allow process-exec)".to_owned(),
        "(allow process-fork)".to_owned(),
        "(allow sysctl-read)".to_owned(),
        "(allow signal (target same-sandbox))".to_owned(),
        "(allow file-read-metadata)".to_owned(),
        format!("(allow file-read* file-map-executable (require-any {reads}))"),
        "(allow file-read* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))".to_owned(),
        "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/zero\"))".to_owned(),
        "(deny network*)".to_owned(),
    ].join("\n"))
}

/// The source holds this directory throughout physical execution. File actions
/// exclude it from the child, and the original Host separately retains its own
/// longer-lived App/ancestor custody. This helper does not certify that history.
fn open_app(request: &CodesignRequest) -> Result<OwnedFd, ProtocolError> {
    let mut current = codesign_darwin::open_directory(libc::AT_FDCWD, "/")?;
    let result = (|| {
        for part in request.app_bundle_path[1..].split('/') {
            let next = codesign_darwin::open_directory(current.raw()?, part)?;
            current.close()?;
            current = next;
        }
        let stat = current.stat()?;
        if stat.st_dev.to_string() != request.app_device
            || stat.st_ino.to_string() != request.app_inode
        {
            return Err(ProtocolError::CodesignSourceChanged);
        }
        Ok(())
    })();
    if let Err(error) = result {
        return match current.close() {
            Ok(()) => Err(error),
            Err(cleanup) => Err(cleanup),
        };
    }
    Ok(current)
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(HEX[(byte >> 4) as usize] as char);
        value.push(HEX[(byte & 15) as usize] as char);
    }
    value
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Completed<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    protocol_version: u32,
    helper_version: &'static str,
    role: &'static str,
    helper_pid: u32,
    parent_pid: u32,
    request_id: &'a str,
    nonce: &'a str,
    host_process_epoch: &'a str,
    app_bundle_path: &'a str,
    app_device: &'a str,
    app_inode: &'a str,
    profile: &'a str,
    child_pid: u32,
    exit_code: Option<i32>,
    signal: Option<i32>,
    stdout_hex: String,
    stderr_hex: String,
    spawn_backend: &'static str,
    registered_null_action_count: u32,
    exception_action_mask: u32,
    null_special_port_actions: [i32; 1],
    reviewed_non_inherited_special_slots: [i32; 2],
    special_slot_evidence: &'static str,
    helper_host_object_type: u32,
    helper_access_object_type: Option<u32>,
    helper_access_service: &'static str,
    helper_inherited_extra_fds_closed: u32,
    mach_capability_closure: &'static str,
    child_stdio: [i32; 3],
    descendant_drain: &'static str,
    enforcement_ready: bool,
}

/// A single request and a single complete response; no successful final frame
/// precedes native cleanup or App revalidation. No Run actor or grant is used.
pub fn respond(
    body: &[u8],
    parent: u32,
    input: &mut impl Read,
    output: &mut impl Write,
) -> Result<io::Result<()>, ProtocolError> {
    let request = parse_request(body, parent)?;
    let mut trailing = [0_u8; 1];
    loop {
        match input.read(&mut trailing) {
            Ok(0) => break,
            Ok(_) => return Err(ProtocolError::InvalidCodesignRequest),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ProtocolError::InputUnavailable),
        }
    }
    let inherited_extra_fds_closed = codesign_darwin::require_private_stdio()?;
    let profile = fixed_profile(&request.app_bundle_path)?;
    let arguments = [
        "/usr/bin/sandbox-exec",
        "-p",
        &profile,
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
        &request.app_bundle_path,
    ]
    .into_iter()
    .map(|value| CString::new(value).map_err(|_| ProtocolError::InvalidCodesignRequest))
    .collect::<Result<Vec<_>, _>>()?;
    let mut app = open_app(&request)?;
    let result = codesign_darwin::execute(&arguments, parent);
    let checked = (|| {
        let captured = result?;
        let mut current = open_app(&request)?;
        let original = app.stat();
        let observed = current.stat();
        current.close()?;
        let original = original?;
        let observed = observed?;
        if original.st_dev != observed.st_dev || original.st_ino != observed.st_ino {
            return Err(ProtocolError::CodesignSourceChanged);
        }
        Ok(captured)
    })();
    app.close()?;
    let CapturedProcess {
        child_pid,
        exit_code,
        signal,
        stdout,
        stderr,
        mach,
    } = checked?;
    Ok(protocol::write_frame(
        output,
        &Completed {
            message_type: "codesign_completed",
            protocol_version: protocol::VERSION,
            helper_version: env!("CARGO_PKG_VERSION"),
            role: ROLE,
            helper_pid: std::process::id(),
            parent_pid: parent,
            request_id: &request.request_id,
            nonce: &request.nonce,
            host_process_epoch: &request.host_process_epoch,
            app_bundle_path: &request.app_bundle_path,
            app_device: &request.app_device,
            app_inode: &request.app_inode,
            profile: &profile,
            child_pid,
            exit_code,
            signal,
            stdout_hex: hex(&stdout),
            stderr_hex: hex(&stderr),
            spawn_backend: "darwin_posix_spawn_no_fallback_v1",
            registered_null_action_count: 3,
            exception_action_mask: codesign_darwin::EXCEPTION_MASK,
            null_special_port_actions: [4],
            reviewed_non_inherited_special_slots: [10, 11],
            special_slot_evidence: "reviewed_xnu_no_parent_copy_not_runtime_observed_v1",
            helper_host_object_type: mach.host_object_type,
            helper_access_object_type: mach.access_object_type,
            helper_access_service: mach.access_service,
            helper_inherited_extra_fds_closed: inherited_extra_fds_closed,
            mach_capability_closure: "not_certified",
            child_stdio: [0, 1, 2],
            descendant_drain: "not_verified",
            enforcement_ready: false,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> serde_json::Value {
        serde_json::json!({ "protocolVersion": 1, "operation": ROLE,
        "requestId": "source-request", "nonce": "a".repeat(64),
        "expectedHelperVersion": env!("CARGO_PKG_VERSION"), "parentPid": 42,
        "hostProcessEpoch": "host-epoch", "appBundlePath": "/Applications/Ling.app",
        "appDevice": "1", "appInode": "2" })
    }
    #[test]
    fn caller_authority_and_general_commands_are_not_part_of_this_role() {
        for key in [
            "identity",
            "certified",
            "registryEpoch",
            "profile",
            "argv",
            "env",
            "cwd",
            "command",
        ] {
            let mut value = request();
            value[key] = serde_json::json!(true);
            assert!(matches!(
                parse_request(&serde_json::to_vec(&value).unwrap(), 42),
                Err(ProtocolError::InvalidCodesignRequest)
            ));
        }
        let duplicate =
            serde_json::to_string(&request())
                .unwrap()
                .replacen('{', "{\"parentPid\":42,", 1);
        assert!(matches!(
            parse_request(duplicate.as_bytes(), 42),
            Err(ProtocolError::InvalidCodesignRequest)
        ));
    }
    #[test]
    fn only_exact_bounded_app_paths_and_canonical_identities_are_accepted() {
        for value in [
            "relative.app",
            "/a/../Ling.app",
            "/a//Ling.app",
            "/a/./Ling.app",
            "/a/Ling",
            "/a/Ling\n.app",
            "/a/Ling\\.app",
        ] {
            let mut wire = request();
            wire["appBundlePath"] = value.into();
            assert!(matches!(
                parse_request(&serde_json::to_vec(&wire).unwrap(), 42),
                Err(ProtocolError::InvalidCodesignRequest)
            ));
        }
        for value in ["", "01", "-1", "18446744073709551616"] {
            let mut wire = request();
            wire["appInode"] = value.into();
            assert!(matches!(
                parse_request(&serde_json::to_vec(&wire).unwrap(), 42),
                Err(ProtocolError::InvalidCodesignRequest)
            ));
        }
        assert!(parse_request(&serde_json::to_vec(&request()).unwrap(), 42).is_ok());
    }
    #[test]
    fn renderer_contains_only_fixed_domains_and_escapes_app_quotes() {
        let profile = fixed_profile("/Applications/quoted\".app").unwrap();
        assert!(profile.contains("(subpath \"/Applications/quoted\\\".app\")"));
        assert!(profile.contains("(deny network*)"));
        assert!(!profile.contains("file-write*"));
        assert!(!profile.contains("mach-lookup"));
        assert!(!profile.contains("/Users"));
    }

    fn synthetic_completed() -> Completed<'static> {
        Completed {
            message_type: "codesign_completed",
            protocol_version: protocol::VERSION,
            helper_version: env!("CARGO_PKG_VERSION"),
            role: ROLE,
            helper_pid: 0,
            parent_pid: 0,
            request_id: "synthetic-frame-only",
            nonce: "not-authority",
            host_process_epoch: "synthetic",
            app_bundle_path: "/private/tmp/NotExecutedFixture.app",
            app_device: "0",
            app_inode: "0",
            profile: "synthetic-not-executed",
            child_pid: 0,
            exit_code: Some(0),
            signal: None,
            stdout_hex: String::new(),
            stderr_hex: String::new(),
            spawn_backend: "synthetic-not-executed",
            registered_null_action_count: 3,
            exception_action_mask: codesign_darwin::EXCEPTION_MASK,
            null_special_port_actions: [4],
            reviewed_non_inherited_special_slots: [10, 11],
            special_slot_evidence: "reviewed_xnu_no_parent_copy_not_runtime_observed_v1",
            helper_host_object_type: 3,
            helper_access_object_type: None,
            helper_access_service: "absent",
            helper_inherited_extra_fds_closed: 0,
            mach_capability_closure: "not_certified",
            child_stdio: [0, 1, 2],
            descendant_drain: "not_verified",
            enforcement_ready: false,
        }
    }

    struct FailingWriter {
        bytes: Vec<u8>,
        limit: usize,
        fail_flush: bool,
    }
    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let remaining = self.limit.saturating_sub(self.bytes.len());
            if remaining == 0 {
                return Err(io::Error::from(io::ErrorKind::BrokenPipe));
            }
            let count = remaining.min(bytes.len());
            self.bytes.extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.fail_flush {
                Err(io::Error::from(io::ErrorKind::BrokenPipe))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn synthetic_final_frame_short_write_cannot_be_a_complete_receipt() {
        for limit in [0, 2, 4, 12] {
            let mut writer = FailingWriter {
                bytes: Vec::new(),
                limit,
                fail_flush: false,
            };
            let error = protocol::write_frame(&mut writer, &synthetic_completed()).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
            assert_eq!(writer.bytes.len(), limit);
            assert!(protocol::read_frame(&mut io::Cursor::new(writer.bytes)).is_err());
        }
    }

    #[test]
    fn synthetic_final_frame_flush_error_is_not_success_even_with_complete_bytes() {
        let mut writer = FailingWriter {
            bytes: Vec::new(),
            limit: protocol::MAX_FRAME_BYTES,
            fail_flush: true,
        };
        assert_eq!(
            protocol::write_frame(&mut writer, &synthetic_completed())
                .unwrap_err()
                .kind(),
            io::ErrorKind::BrokenPipe
        );
        // A full body can exist despite transport completion failure. Host must
        // require the actual helper exit/IO outcome, not just parse these bytes.
        assert!(protocol::read_frame(&mut io::Cursor::new(writer.bytes)).is_ok());
    }
}

//! Bounded, non-executing handshake. Wire claims never establish sandbox authority.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 262_144;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptIdentity {
    pub workspace_id: String,
    pub run_id: String,
    pub work_unit_id: String,
    pub attempt_id: String,
    pub runtime_instance_id: String,
    pub fencing_token: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandshakeRequest {
    pub protocol_version: u32,
    pub operation: String,
    pub request_id: String,
    pub nonce: String,
    pub expected_helper_version: String,
    pub parent_pid: u32,
    pub identity: AttemptIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    MissingRequest,
    InvalidFrameLength,
    TruncatedFrame,
    InputUnavailable,
    InvalidRequest,
    UnsupportedVersion,
    UnsupportedOperation,
    HelperVersionMismatch,
    ParentMismatch,
    ParentUnavailable,
    UnsupportedInvocation,
    InvalidInputRequest,
    InputPathUnavailable,
    InputRootIdentityChanged,
    InputNotRegular,
    InputHardlinkRejected,
    InputBudgetExceeded,
    InputChanged,
    InvalidCodesignRequest,
    CodesignStdioInvalid,
    CodesignSourceChanged,
    CodesignApiUnsupported,
    CodesignPrepareFailed,
    CodesignMachPreflightFailed,
    CodesignHostCapabilityUnsupported,
    CodesignInheritedPortUnsupported,
    CodesignMachActionFailed,
    CodesignSpawnFailed,
    CodesignWaitFailed,
    CodesignOutputUnavailable,
    CodesignOutputBudgetExceeded,
    CodesignTimeout,
    CodesignCleanupUnknown,
    CodesignInheritedFdUnknown,
    CodesignTaskAccessUnbound,
}

impl ProtocolError {
    pub fn code(self) -> &'static str {
        match self {
            Self::MissingRequest => "missing_request",
            Self::InvalidFrameLength => "invalid_frame_length",
            Self::TruncatedFrame => "truncated_frame",
            Self::InputUnavailable => "input_unavailable",
            Self::InvalidRequest => "invalid_request",
            Self::UnsupportedVersion => "unsupported_protocol_version",
            Self::UnsupportedOperation => "unsupported_operation",
            Self::HelperVersionMismatch => "helper_version_mismatch",
            Self::ParentMismatch => "parent_mismatch",
            Self::ParentUnavailable => "parent_unavailable",
            Self::UnsupportedInvocation => "unsupported_invocation",
            Self::InvalidInputRequest => "invalid_input_request",
            Self::InputPathUnavailable => "input_path_unavailable",
            Self::InputRootIdentityChanged => "input_root_identity_changed",
            Self::InputNotRegular => "input_not_regular",
            Self::InputHardlinkRejected => "input_hardlink_rejected",
            Self::InputBudgetExceeded => "input_budget_exceeded",
            Self::InputChanged => "input_changed",
            Self::InvalidCodesignRequest => "invalid_codesign_request",
            Self::CodesignStdioInvalid => "codesign_stdio_invalid",
            Self::CodesignSourceChanged => "codesign_source_changed",
            Self::CodesignApiUnsupported => "codesign_api_unsupported",
            Self::CodesignPrepareFailed => "codesign_prepare_failed",
            Self::CodesignMachPreflightFailed => "codesign_mach_preflight_failed",
            Self::CodesignHostCapabilityUnsupported => "codesign_host_capability_unsupported",
            Self::CodesignInheritedPortUnsupported => "codesign_inherited_port_unsupported",
            Self::CodesignMachActionFailed => "codesign_mach_action_failed",
            Self::CodesignSpawnFailed => "codesign_spawn_failed",
            Self::CodesignWaitFailed => "codesign_wait_failed",
            Self::CodesignOutputUnavailable => "codesign_output_unavailable",
            Self::CodesignOutputBudgetExceeded => "codesign_output_budget_exceeded",
            Self::CodesignTimeout => "codesign_timeout",
            Self::CodesignCleanupUnknown => "codesign_cleanup_unknown",
            Self::CodesignInheritedFdUnknown => "codesign_inherited_fd_unknown",
            Self::CodesignTaskAccessUnbound => "codesign_task_access_unbound",
        }
    }
}

/// Read one bounded frame; never allocate using an unchecked wire length.
pub fn read_frame(reader: &mut impl Read) -> Result<Vec<u8>, ProtocolError> {
    let mut header = [0_u8; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Err(ProtocolError::MissingRequest),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ProtocolError::InputUnavailable),
        }
    }
    read_exact(reader, &mut header[1..])?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(ProtocolError::InvalidFrameLength);
    }
    let mut body = vec![0; size];
    read_exact(reader, &mut body)?;
    Ok(body)
}

fn read_exact(reader: &mut impl Read, buffer: &mut [u8]) -> Result<(), ProtocolError> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            ProtocolError::TruncatedFrame
        } else {
            ProtocolError::InputUnavailable
        }
    })
}

/// Parse directly into strict structs so duplicate fields cannot be overwritten.
pub fn parse_request(bytes: &[u8], parent_pid: u32) -> Result<HandshakeRequest, ProtocolError> {
    let request: HandshakeRequest =
        serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidRequest)?;
    if request.protocol_version != VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    if request.operation != "handshake" {
        return Err(ProtocolError::UnsupportedOperation);
    }
    if request.expected_helper_version != env!("CARGO_PKG_VERSION") {
        return Err(ProtocolError::HelperVersionMismatch);
    }
    if request.parent_pid == 0 || request.parent_pid != parent_pid {
        return Err(ProtocolError::ParentMismatch);
    }
    if !valid_id(&request.request_id)
        || request.nonce.len() != 64
        || !request
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || [
            &request.identity.workspace_id,
            &request.identity.run_id,
            &request.identity.work_unit_id,
            &request.identity.attempt_id,
            &request.identity.runtime_instance_id,
            &request.identity.fencing_token,
        ]
        .into_iter()
        .any(|value| !valid_id(value))
    {
        return Err(ProtocolError::InvalidRequest);
    }
    Ok(request)
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// Serialize a bounded result with no log or untrusted diagnostic text on stdout.
pub fn write_frame(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid output length",
        ));
    }
    writer.write_all(&(body.len() as u32).to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub protocol_version: u32,
    pub helper_version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
    pub pid: u32,
    pub parent_pid: u32,
    pub request_id: String,
    pub nonce: String,
    pub identity: AttemptIdentity,
    pub execution_supported: bool,
    pub enforcement_ready: bool,
    pub capabilities: [String; 0],
}

impl Hello {
    pub fn from_request(request: HandshakeRequest, parent_pid: u32) -> Self {
        Self {
            message_type: "hello",
            protocol_version: VERSION,
            helper_version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            pid: std::process::id(),
            parent_pid,
            request_id: request.request_id,
            nonce: request.nonce,
            identity: request.identity,
            execution_supported: false,
            enforcement_ready: false,
            capabilities: [],
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub protocol_version: u32,
    pub code: &'static str,
    pub enforcement_ready: bool,
}

impl From<ProtocolError> for ErrorResponse {
    fn from(error: ProtocolError) -> Self {
        Self {
            message_type: "error",
            protocol_version: VERSION,
            code: error.code(),
            enforcement_ready: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": 1, "operation": "handshake", "requestId": "request",
            "nonce": "a".repeat(64), "expectedHelperVersion": env!("CARGO_PKG_VERSION"),
            "parentPid": 42, "identity": {
                "workspaceId": "workspace", "runId": "run", "workUnitId": "unit",
                "attemptId": "attempt", "runtimeInstanceId": "runtime", "fencingToken": "fence"
            }
        })
    }

    #[test]
    fn round_trip_never_claims_enforcement() {
        let parsed = parse_request(&serde_json::to_vec(&request()).unwrap(), 42).unwrap();
        let hello = Hello::from_request(parsed, 42);
        assert!(!hello.execution_supported && !hello.enforcement_ready);
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &hello).unwrap();
        let body = read_frame(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["type"],
            "hello"
        );
    }

    #[test]
    fn length_and_truncation_fail_before_unbounded_allocation() {
        for (bytes, expected) in [
            (vec![], ProtocolError::MissingRequest),
            (vec![0], ProtocolError::TruncatedFrame),
            (vec![0, 0, 0, 0], ProtocolError::InvalidFrameLength),
            (
                u32::MAX.to_be_bytes().to_vec(),
                ProtocolError::InvalidFrameLength,
            ),
            (vec![0, 0, 0, 2, b'{'], ProtocolError::TruncatedFrame),
        ] {
            assert_eq!(read_frame(&mut Cursor::new(bytes)), Err(expected));
        }
    }

    #[test]
    fn unknown_and_duplicate_fields_are_rejected() {
        let original = serde_json::to_string(&request()).unwrap();
        let duplicate = original.replacen("{", "{\"protocolVersion\":1,", 1);
        assert!(matches!(
            parse_request(duplicate.as_bytes(), 42),
            Err(ProtocolError::InvalidRequest)
        ));
        let mut value = request();
        value["verified"] = true.into();
        assert!(matches!(
            parse_request(&serde_json::to_vec(&value).unwrap(), 42),
            Err(ProtocolError::InvalidRequest)
        ));
        value = request();
        value["identity"]["approvalId"] = "not-authority".into();
        assert!(matches!(
            parse_request(&serde_json::to_vec(&value).unwrap(), 42),
            Err(ProtocolError::InvalidRequest)
        ));
    }

    #[test]
    fn version_parent_operation_and_identity_are_closed() {
        for (key, value, expected) in [
            (
                "protocolVersion",
                serde_json::json!(2),
                ProtocolError::UnsupportedVersion,
            ),
            (
                "parentPid",
                serde_json::json!(41),
                ProtocolError::ParentMismatch,
            ),
            (
                "operation",
                serde_json::json!("execute"),
                ProtocolError::UnsupportedOperation,
            ),
            (
                "nonce",
                serde_json::json!("wrong"),
                ProtocolError::InvalidRequest,
            ),
            (
                "expectedHelperVersion",
                serde_json::json!("0.0.0"),
                ProtocolError::HelperVersionMismatch,
            ),
        ] {
            let mut wire = request();
            wire[key] = value;
            assert!(
                matches!(parse_request(&serde_json::to_vec(&wire).unwrap(), 42), Err(actual) if actual == expected)
            );
        }
        for value in ["", " ", "bad\nid"] {
            let mut wire = request();
            wire["identity"]["fencingToken"] = value.into();
            assert!(matches!(
                parse_request(&serde_json::to_vec(&wire).unwrap(), 42),
                Err(ProtocolError::InvalidRequest)
            ));
        }
    }

    #[test]
    fn diagnostics_never_echo_input() {
        let error = parse_request(b"{\"fake_secret\":\"do-not-echo\"}", 42).unwrap_err();
        let mut output = Vec::new();
        write_frame(&mut output, &ErrorResponse::from(error)).unwrap();
        let body = read_frame(&mut Cursor::new(output)).unwrap();
        assert!(!String::from_utf8(body).unwrap().contains("do-not-echo"));
    }
}

//! Read-only input capture for isolated execution copies. This is not an execution
//! grant: the Host must select the scope and validate its captured owner before
//! and after this private-pipe call. No source path is ever opened for writing.
use crate::protocol::{self, HandshakeRequest, ProtocolError};
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::MetadataExt;

const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const CHUNK_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputRequest {
    handshake: HandshakeRequest,
    root: String,
    root_device: String,
    root_inode: String,
    path: String,
    max_bytes: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileIdentity {
    device: String,
    inode: String,
    links: String,
    size_bytes: u64,
    mode: u32,
    modified_sec: String,
    modified_nsec: String,
    changed_sec: String,
    changed_nsec: String,
}
impl From<&Metadata> for FileIdentity {
    fn from(stat: &Metadata) -> Self {
        Self {
            device: stat.dev().to_string(),
            inode: stat.ino().to_string(),
            links: stat.nlink().to_string(),
            size_bytes: stat.size(),
            mode: stat.mode(),
            modified_sec: stat.mtime().to_string(),
            modified_nsec: stat.mtime_nsec().to_string(),
            changed_sec: stat.ctime().to_string(),
            changed_nsec: stat.ctime_nsec().to_string(),
        }
    }
}
struct CapturedInput {
    bytes: Vec<u8>,
    identity: FileIdentity,
}

/// Validate everything before reading content. A malformed request cannot start
/// a response stream; errors use fixed codes and never include source bytes.
fn parse_request(bytes: &[u8], parent: u32) -> Result<InputRequest, ProtocolError> {
    let request: InputRequest =
        serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidInputRequest)?;
    let handshake =
        serde_json::to_vec(&request.handshake).map_err(|_| ProtocolError::InvalidInputRequest)?;
    protocol::parse_request(&handshake, parent)?;
    let valid_number = |value: &str| {
        !value.is_empty()
            && value.len() <= 20
            && value.bytes().all(|byte| byte.is_ascii_digit())
            && value.parse::<u64>().is_ok()
    };
    if !request.root.starts_with('/')
        || request.root.len() > 4096
        || !valid_relative_path(&request.root[1..])
        || !valid_relative_path(&request.path)
        || !valid_number(&request.root_device)
        || !valid_number(&request.root_inode)
        || request.max_bytes == 0
        || request.max_bytes > MAX_INPUT_BYTES
    {
        return Err(ProtocolError::InvalidInputRequest);
    }
    Ok(request)
}
fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Every component is opened relative to an already-owned directory FD. Walking
/// the absolute root this way also rejects symlinks in its ancestors. CLOEXEC
/// and RAII prevent source handles escaping into a later command process.
fn open_at(parent: RawFd, name: &str, directory: bool) -> Result<File, ProtocolError> {
    let name = CString::new(name).map_err(|_| ProtocolError::InvalidInputRequest)?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: name is a terminated string, parent is AT_FDCWD or a live borrowed
    // FD, and successful ownership is transferred to exactly one File.
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(ProtocolError::InputPathUnavailable);
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn root_handle(request: &InputRequest) -> Result<File, ProtocolError> {
    let mut root = open_at(libc::AT_FDCWD, "/", true)?;
    for part in request.root[1..].split('/') {
        root = open_at(root.as_raw_fd(), part, true)?;
    }
    let stat = root
        .metadata()
        .map_err(|_| ProtocolError::InputPathUnavailable)?;
    if stat.dev().to_string() != request.root_device || stat.ino().to_string() != request.root_inode
    {
        return Err(ProtocolError::InputRootIdentityChanged);
    }
    Ok(root)
}
fn leaf_handle(root: &File, path: &str) -> Result<File, ProtocolError> {
    let mut parts = path.split('/').peekable();
    let mut owned_parent: Option<File> = None;
    while let Some(part) = parts.next() {
        let parent = owned_parent.as_ref().unwrap_or(root).as_raw_fd();
        let opened = open_at(parent, part, parts.peek().is_some())?;
        if parts.peek().is_none() {
            return Ok(opened);
        }
        owned_parent = Some(opened);
    }
    Err(ProtocolError::InvalidInputRequest)
}
fn capture(
    request: &InputRequest,
    after_read: impl FnOnce(),
) -> Result<CapturedInput, ProtocolError> {
    let root = root_handle(request)?;
    let mut file = leaf_handle(&root, &request.path)?;
    let before = file
        .metadata()
        .map_err(|_| ProtocolError::InputPathUnavailable)?;
    if !before.is_file() {
        return Err(ProtocolError::InputNotRegular);
    }
    // An unknown multi-link input can name protected data through an authorized
    // path. Reject it; a copy protects later writes but cannot authorize this read.
    if before.nlink() != 1 {
        return Err(ProtocolError::InputHardlinkRejected);
    }
    if before.len() > request.max_bytes {
        return Err(ProtocolError::InputBudgetExceeded);
    }
    let identity = FileIdentity::from(&before);
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(before.len() as usize)
        .map_err(|_| ProtocolError::InputBudgetExceeded)?;
    Read::by_ref(&mut file)
        .take(request.max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProtocolError::InputUnavailable)?;
    if bytes.len() as u64 > request.max_bytes {
        return Err(ProtocolError::InputBudgetExceeded);
    }
    after_read();
    let after = file.metadata().map_err(|_| ProtocolError::InputChanged)?;
    // Reopen the root and leaf via FD walking. A removed/replaced root, ancestor,
    // directory entry or changed inode invalidates this capture before any bytes
    // are published. This is a snapshot, not a promise the source stays immutable.
    let current_root = root_handle(request).map_err(|_| ProtocolError::InputChanged)?;
    let current_file =
        leaf_handle(&current_root, &request.path).map_err(|_| ProtocolError::InputChanged)?;
    let current = current_file
        .metadata()
        .map_err(|_| ProtocolError::InputChanged)?;
    if identity != FileIdentity::from(&after)
        || identity != FileIdentity::from(&current)
        || bytes.len() as u64 != before.len()
    {
        return Err(ProtocolError::InputChanged);
    }
    Ok(CapturedInput { bytes, identity })
}

/// Each response frame is bounded. Completion is sent only after the full source
/// capture has been verified; the Host must discard all chunks on a missing end
/// frame, transport error, nonzero exit, cancellation, or changed source owner.
pub fn respond(
    bytes: &[u8],
    parent: u32,
    output: &mut impl Write,
) -> Result<io::Result<()>, ProtocolError> {
    let request = parse_request(bytes, parent)?;
    let captured = capture(&request, || {})?;
    Ok(write_capture(output, &request, &captured))
}
fn write_capture(
    output: &mut impl Write,
    request: &InputRequest,
    captured: &CapturedInput,
) -> io::Result<()> {
    protocol::write_frame(
        output,
        &serde_json::json!({ "type": "input_started", "protocolVersion": protocol::VERSION,
        "requestId": request.handshake.request_id, "nonce": request.handshake.nonce, "identity": request.handshake.identity }),
    )?;
    for (index, bytes) in captured.bytes.chunks(CHUNK_BYTES).enumerate() {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut hex = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            hex.push(HEX[(byte >> 4) as usize] as char);
            hex.push(HEX[(byte & 15) as usize] as char);
        }
        protocol::write_frame(
            output,
            &serde_json::json!({ "type": "input_chunk", "index": index, "hex": hex }),
        )?;
    }
    protocol::write_frame(
        output,
        &serde_json::json!({ "type": "input_completed", "path": request.path,
        "rootDevice": request.root_device, "rootInode": request.root_inode,
        "metadata": captured.identity, "sizeBytes": captured.bytes.len() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "ling-input-rust-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self {
                root: root.canonicalize().unwrap(),
            }
        }
        fn request(&self) -> InputRequest {
            let stat = fs::metadata(&self.root).unwrap();
            let identity = protocol::AttemptIdentity {
                workspace_id: "w".into(),
                run_id: "r".into(),
                work_unit_id: "u".into(),
                attempt_id: "a".into(),
                runtime_instance_id: "i".into(),
                fencing_token: "f".into(),
            };
            InputRequest {
                handshake: HandshakeRequest {
                    protocol_version: 1,
                    operation: "handshake".into(),
                    request_id: "request".into(),
                    nonce: "a".repeat(64),
                    expected_helper_version: env!("CARGO_PKG_VERSION").into(),
                    parent_pid: 42,
                    identity,
                },
                root: self.root.to_str().unwrap().into(),
                root_device: stat.dev().to_string(),
                root_inode: stat.ino().to_string(),
                path: "input".into(),
                max_bytes: 1024,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    #[test]
    fn data_mutation_and_late_hardlink_fail_before_publication() {
        let f = Fixture::new();
        let path = f.root.join("input");
        fs::write(&path, "before").unwrap();
        let result = capture(&f.request(), || fs::write(&path, "after!").unwrap());
        assert!(matches!(result, Err(ProtocolError::InputChanged)));
        let result = capture(&f.request(), || {
            fs::hard_link(&path, f.root.join("alias")).unwrap()
        });
        assert!(matches!(result, Err(ProtocolError::InputChanged)));
    }
    #[test]
    fn replacing_a_leaf_or_parent_is_not_the_original_snapshot() {
        let f = Fixture::new();
        let dir = f.root.join("dir");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("input");
        fs::write(&path, "before").unwrap();
        let mut request = f.request();
        request.path = "dir/input".into();
        let result = capture(&request, || {
            fs::rename(&path, dir.join("old")).unwrap();
            fs::write(&path, "before").unwrap();
        });
        assert!(matches!(result, Err(ProtocolError::InputChanged)));
        let result = capture(&request, || {
            fs::rename(&dir, f.root.join("old-dir")).unwrap();
            fs::create_dir(&dir).unwrap();
            fs::write(&path, "before").unwrap();
        });
        assert!(matches!(result, Err(ProtocolError::InputChanged)));
    }
    #[test]
    fn directory_fds_remain_anchored_when_the_path_is_retargeted() {
        let f = Fixture::new();
        let scope = f.root.join("scope");
        fs::create_dir(&scope).unwrap();
        fs::write(scope.join("input"), "authorized").unwrap();
        let handle = open_at(libc::AT_FDCWD, scope.to_str().unwrap(), true).unwrap();
        fs::rename(&scope, f.root.join("previous")).unwrap();
        fs::create_dir(&scope).unwrap();
        fs::write(scope.join("input"), "replacement").unwrap();
        let mut content = String::new();
        leaf_handle(&handle, "input")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "authorized");
        assert_ne!(
            unsafe { libc::fcntl(handle.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }
}

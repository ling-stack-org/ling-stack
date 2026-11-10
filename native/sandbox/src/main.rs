#[cfg(target_os = "macos")]
mod codesign;
#[cfg(target_os = "macos")]
mod codesign_darwin;
#[cfg(target_os = "macos")]
mod codesign_mach;
#[cfg(unix)]
mod input_read;
mod protocol;

use protocol::{ErrorResponse, Hello, ProtocolError};
use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let output = &mut io::stdout().lock();
    let result = respond(output);
    let (written, code) = match result {
        Ok(written) => (written, 0),
        Err(error) => (
            protocol::write_frame(output, &ErrorResponse::from(error)),
            2,
        ),
    };
    ExitCode::from(if written.is_ok() { code } else { 3 })
}

fn respond(output: &mut impl io::Write) -> Result<io::Result<()>, ProtocolError> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1
        || (args[0] != "--stdio-handshake"
            && args[0] != "--read-input"
            && args[0] != "--verify-packaged-codesign")
    {
        return Err(ProtocolError::UnsupportedInvocation);
    }
    #[cfg(not(target_os = "macos"))]
    if args[0] == "--verify-packaged-codesign" {
        return Err(ProtocolError::UnsupportedInvocation);
    }
    let parent = parent_pid()
        .filter(|pid| *pid != 0)
        .ok_or(ProtocolError::ParentUnavailable)?;
    let mut input = io::stdin().lock();
    let body = protocol::read_frame(&mut input)?;
    #[cfg(target_os = "macos")]
    if args[0] == "--verify-packaged-codesign" {
        return codesign::respond(&body, parent, &mut input, output);
    }
    if args[0] == "--read-input" {
        #[cfg(unix)]
        return input_read::respond(&body, parent, output);
        #[cfg(not(unix))]
        return Err(ProtocolError::UnsupportedInvocation);
    }
    let request = protocol::parse_request(&body, parent)?;
    Ok(protocol::write_frame(
        output,
        &Hello::from_request(request, parent),
    ))
}

#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    // SAFETY: getppid takes no pointers and has no ownership preconditions.
    u32::try_from(unsafe { libc::getppid() }).ok()
}

#[cfg(windows)]
fn parent_pid() -> Option<u32> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: snapshot handle is checked and closed once; entry is correctly sized
    // writable storage, and no pointer escapes this synchronous lookup.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            if entry.th32ProcessID == std::process::id() {
                found = Some(entry.th32ParentProcessID);
                break;
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(not(any(unix, windows)))]
fn parent_pid() -> Option<u32> {
    None
}

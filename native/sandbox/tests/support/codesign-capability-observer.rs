//! Separately compiled, fixed single-thread observer. Never a production bin.
//! Root passes libc/serde_json from the pinned native build closure at test build.
#[cfg(not(test))]
compile_error!("standalone observer requires explicit rustc --cfg test; never a production bin");
extern crate libc;
extern crate serde_json;
#[path = "codesign-capability-wire.rs"]
mod wire;
use std::io::{self, Read, Write};
use std::mem;
use std::ptr;
fn errno() -> i32 {
    unsafe { *libc::__error() }
}
fn fd3() -> Result<serde_json::Value, String> {
    // Before creating any reply port or stdout writer; this code opens no files.
    let mut stat: libc::stat = unsafe { mem::zeroed() };
    let stat_code = unsafe { libc::fstat(3, &mut stat) };
    let stat_errno = if stat_code == 0 { 0 } else { errno() };
    let mut bytes = [0_u8; 32];
    let read_code = unsafe { libc::pread(3, bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    let read_errno = if read_code >= 0 { 0 } else { errno() };
    // Identity is correlation from this private test pipe, not authority. Never
    // mmap/write an unexpected inherited file, even if FD3 happens to be valid.
    let mut input = Vec::new();
    io::stdin()
        .take(4097)
        .read_to_end(&mut input)
        .map_err(|_| "fixture_input_unavailable")?;
    if input.len() > 4096 {
        return Err("fixture_input_budget".into());
    }
    let expected: serde_json::Value =
        serde_json::from_slice(&input).map_err(|_| "fixture_input_invalid")?;
    if stat_code == 0 {
        if stat.st_mode & libc::S_IFMT != libc::S_IFREG
            || stat.st_size < 4096
            || expected["device"] != stat.st_dev.to_string()
            || expected["inode"] != stat.st_ino.to_string()
            || read_code != 32
            || bytes != [b'D'; 32]
        {
            return Err("fixture_fd3_foreign_refused_before_mapping".into());
        }
    } else if stat_errno != libc::EBADF {
        return Err(format!("fixture_fd3_stat:{stat_errno}"));
    }
    let mut maps = Vec::new();
    for prot in [libc::PROT_READ, libc::PROT_READ | libc::PROT_WRITE] {
        let address = unsafe { libc::mmap(ptr::null_mut(), 4096, prot, libc::MAP_SHARED, 3, 0) };
        if address == libc::MAP_FAILED {
            maps.push(serde_json::json!({ "ok": false, "errno": errno() }));
        } else {
            let sample = unsafe { std::slice::from_raw_parts(address.cast::<u8>(), 32) }.to_vec();
            let write = prot & libc::PROT_WRITE != 0;
            if write {
                unsafe {
                    *address.cast::<u8>() = b'M';
                }
            }
            let unmap = unsafe { libc::munmap(address, 4096) };
            if unmap != 0 {
                return Err(format!("fixture_munmap:{}", errno()));
            }
            maps.push(serde_json::json!({ "ok": true, "sample": sample, "wrote": write, "munmap": unmap }));
        }
    }
    Ok(
        serde_json::json!({ "statCode": stat_code, "statErrno": stat_errno,
        "device": if stat_code == 0 { Some(stat.st_dev.to_string()) } else { None },
        "inode": if stat_code == 0 { Some(stat.st_ino.to_string()) } else { None },
        "readCode": read_code, "readErrno": read_errno, "readBytes": bytes.to_vec(), "maps": maps }),
    )
}
fn observe() -> Result<serde_json::Value, String> {
    let fd = fd3()?;
    let mut lookup = wire::Lookup::read()?;
    let result = (|| {
        if lookup.ports.len() > 3 {
            return Err("observer_lookup:unexpected_count".into());
        }
        let mut slots = [0_u32; 3];
        slots[..lookup.ports.len()].copy_from_slice(&lookup.ports);
        let mut replies = Vec::new();
        for (slot, port) in slots.iter().enumerate() {
            if *port == 0 {
                continue;
            }
            wire::ordinary_send(*port)?;
            let mut reply = wire::Port::receive_only()?;
            let result: Result<serde_json::Value, String> = (|| {
                // COPY_SEND preserves each lookup uref; MAKE_SEND_ONCE is for
                // this one reply receive port. No fixture secret is sent.
                let mut request = wire::Message::outgoing(
                    *port,
                    reply.name,
                    wire::REQUEST_ID,
                    [0; 32],
                    19 | (21 << 8),
                );
                wire::send(&mut request)?;
                let message = wire::receive(reply.name, 2000)?.ok_or("observer_reply:timeout")?;
                if message.header.size != wire::MESSAGE_BYTES
                    || message.header.id != wire::REPLY_ID
                    || message.header.bits & 0x80000000 != 0
                    || message.header.remote != 0
                {
                    return Err("observer_reply:invalid".into());
                }
                Ok(serde_json::json!({ "slot": slot, "received": message.bytes.to_vec() }))
            })();
            let cleanup = reply.close();
            cleanup?;
            replies.push(result?);
        }
        Ok(
            serde_json::json!({ "fd3": fd, "slots": slots.to_vec(), "replies": replies, "lookupCleanup": "completed" }),
        )
    })();
    lookup.close()?;
    result
}
fn main() {
    let result = observe();
    let value = match &result {
        Ok(value) => serde_json::json!({ "type": "capability_fixture", "facts": value,
            "hostCertification": false, "descendantDrain": "not_verified" }),
        Err(error) => serde_json::json!({ "type": "capability_fixture_error", "code": error,
            "hostCertification": false }),
    };
    let output = serde_json::to_vec(&value).expect("fixed fixture serialization");
    let mut writer = io::stdout().lock();
    if output.len() > 8192
        || writer
            .write_all(&output)
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
            .is_err()
    {
        std::process::exit(3);
    }
    if result.is_err() {
        std::process::exit(2);
    }
}

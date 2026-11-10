//! Test-build-only Darwin fixture wire. No production mode or service protocol.
#[cfg(not(test))]
compile_error!("capability fixture wire is restricted to cfg(test) builds");
use std::mem;
use std::ptr;
pub const SEND: u32 = 1;
pub const RECEIVE: u32 = 2;
pub const SEND_TIMEOUT: u32 = 0x10;
pub const RECEIVE_TIMEOUT: u32 = 0x100;
pub const RECEIVE_TIMED_OUT: i32 = 0x10004003;
pub const REQUEST_ID: i32 = 0x4c434601;
pub const REPLY_ID: i32 = 0x4c434602;
pub const MESSAGE_BYTES: u32 = 56;
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Header {
    pub bits: u32,
    pub size: u32,
    pub remote: u32,
    pub local: u32,
    pub voucher: u32,
    pub id: i32,
}
#[repr(C)]
pub struct Message {
    pub header: Header,
    pub bytes: [u8; 32],
    pub trailer: [u8; 128],
}
impl Message {
    pub fn empty() -> Self {
        unsafe { mem::zeroed() }
    }
    pub fn outgoing(remote: u32, local: u32, id: i32, bytes: [u8; 32], bits: u32) -> Self {
        Self {
            header: Header {
                bits,
                size: MESSAGE_BYTES,
                remote,
                local,
                voucher: 0,
                id,
            },
            bytes,
            trailer: [0; 128],
        }
    }
}
unsafe extern "C" {
    pub fn mach_ports_register(task: u32, ports: *const u32, count: u32) -> i32;
    fn mach_ports_lookup(task: u32, ports: *mut *mut u32, count: *mut u32) -> i32;
    fn mach_port_allocate(task: u32, right: i32, port: *mut u32) -> i32;
    fn mach_port_insert_right(task: u32, name: u32, right: u32, disposition: u32) -> i32;
    pub fn mach_port_deallocate(task: u32, port: u32) -> i32;
    fn mach_port_mod_refs(task: u32, name: u32, right: i32, delta: i32) -> i32;
    pub fn mach_port_type(task: u32, name: u32, kind: *mut u32) -> i32;
    fn mach_msg(
        message: *mut Header,
        options: u32,
        send_bytes: u32,
        receive_bytes: u32,
        receive_name: u32,
        timeout_ms: u32,
        notify: u32,
    ) -> i32;
}
pub fn checked(code: i32, stage: &str) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("{stage}:kernel:{code}"))
    }
}
pub fn send(message: &mut Message) -> Result<(), String> {
    checked(
        unsafe {
            mach_msg(
                &mut message.header,
                SEND | SEND_TIMEOUT,
                MESSAGE_BYTES,
                0,
                0,
                2000,
                0,
            )
        },
        "message_send",
    )
}
pub fn receive(port: u32, timeout_ms: u32) -> Result<Option<Message>, String> {
    let mut message = Message::empty();
    let code = unsafe {
        mach_msg(
            &mut message.header,
            RECEIVE | RECEIVE_TIMEOUT,
            0,
            mem::size_of::<Message>() as u32,
            port,
            timeout_ms,
            0,
        )
    };
    if code == RECEIVE_TIMED_OUT {
        return Ok(None);
    }
    checked(code, "message_receive")?;
    Ok(Some(message))
}
/// Each copyout owns one uref, even when multiple elements have the same name.
pub struct Lookup {
    task: u32,
    array: *mut u32,
    count: u32,
    pub ports: Vec<u32>,
    closed: bool,
}
impl Lookup {
    pub fn read() -> Result<Self, String> {
        let task = unsafe { libc::mach_task_self() };
        let mut array = ptr::null_mut();
        let mut count = 0;
        checked(
            unsafe { mach_ports_lookup(task, &mut array, &mut count) },
            "ports_lookup",
        )?;
        if count > 0 && array.is_null() {
            return Err("ports_lookup:invalid_array".into());
        }
        let ports = if count == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(array, count as usize) }.to_vec()
        };
        Ok(Self {
            task,
            array,
            count,
            ports,
            closed: false,
        })
    }
    pub fn close(&mut self) -> Result<(), String> {
        if self.closed {
            return Ok(());
        }
        self.closed = true; // Never repeat a failed kernel release.
        let mut failures = Vec::new();
        for port in &self.ports {
            if *port != 0 && *port != u32::MAX {
                let code = unsafe { mach_port_deallocate(self.task, *port) };
                if code != 0 {
                    failures.push(format!("lookup_uref:{port}:{code}"));
                }
            }
        }
        if !self.array.is_null() {
            let bytes = self.count as usize * mem::size_of::<u32>();
            if bytes == 0 {
                failures.push("lookup_array:unknown_zero_size".into());
            } else {
                let code = unsafe { libc::vm_deallocate(self.task, self.array as usize, bytes) };
                if code != 0 {
                    failures.push(format!("lookup_array:{code}"));
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join(","))
        }
    }
}
impl Drop for Lookup {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
pub struct Port {
    task: u32,
    pub name: u32,
    send_live: bool,
    receive_live: bool,
}
impl Port {
    pub fn receive_only() -> Result<Self, String> {
        let task = unsafe { libc::mach_task_self() };
        let mut name = 0;
        checked(
            unsafe { mach_port_allocate(task, 1, &mut name) },
            "receive_allocate",
        )?;
        if name == 0 || name == u32::MAX {
            return Err("receive_allocate:invalid_name".into());
        }
        Ok(Self {
            task,
            name,
            send_live: false,
            receive_live: true,
        })
    }
    pub fn make_send(&mut self) -> Result<(), String> {
        if self.send_live || !self.receive_live {
            return Err("make_send:invalid_owned_lifetime".into());
        }
        checked(
            unsafe { mach_port_insert_right(self.task, self.name, self.name, 20) },
            "make_send",
        )?;
        self.send_live = true;
        Ok(())
    }
    pub fn close(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        if self.send_live {
            self.send_live = false;
            let code = unsafe { mach_port_deallocate(self.task, self.name) };
            if code != 0 {
                failures.push(format!("owned_send_release:{code}"));
            }
        }
        if self.receive_live {
            self.receive_live = false;
            let code = unsafe { mach_port_mod_refs(self.task, self.name, 1, -1) };
            if code != 0 {
                failures.push(format!("owned_receive_release:{code}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join(","))
        }
    }
}
impl Drop for Port {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
pub fn ordinary_send(port: u32) -> Result<(), String> {
    if port == 0 || port == u32::MAX {
        return Err("ordinary_send:invalid_name".into());
    }
    let mut kind = 0;
    checked(
        unsafe { mach_port_type(libc::mach_task_self(), port, &mut kind) },
        "port_type",
    )?;
    if kind & (1 << 16) == 0 || kind & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)) != 0 {
        return Err(format!("ordinary_send:kind:{kind}"));
    }
    Ok(())
}

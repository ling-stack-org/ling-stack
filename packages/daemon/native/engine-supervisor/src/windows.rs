use crate::protocol::{ACK, Launch, invalid, read_launch};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    mem::ManuallyDrop,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation},
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, GetFileInformationByHandle,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Pipes::PeekNamedPipe,
        Threading::{CREATE_NO_WINDOW, GetCurrentProcess},
    },
};

unsafe extern "C" {
    fn _get_osfhandle(fd: i32) -> isize;
}

pub fn run() -> io::Result<i32> {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--owner-fd=3"] {
        return Err(invalid());
    }
    let ready = Arc::new(AtomicBool::new(false));
    let deadline = Arc::clone(&ready);
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(5));
        if !deadline.load(Ordering::Acquire) {
            std::process::exit(125);
        }
    });
    // libuv supplies fd 3 in STARTUPINFO's CRT descriptor table; it is a blocking pipe.
    let mut owner = owner_pipe()?;
    // Do not drop a self-containing kill-on-close job before ExitProcess chooses the exit code.
    let _job = ManuallyDrop::new(owned_job()?);
    let request = read_launch(&mut owner)?;
    let monitor = owner.try_clone()?;
    if unsafe { SetHandleInformation(monitor.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    thread::spawn(move || {
        // Blocking ReadFile on a duplicated synchronous handle can serialize ACK writes.
        // Peek instead, including during hashing/spawn; no native traffic uses this pipe.
        loop {
            let mut available = 0;
            let ok = unsafe {
                PeekNamedPipe(
                    monitor.as_raw_handle(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 || available != 0 {
                std::process::exit(125);
            }
            thread::sleep(Duration::from_millis(25));
        }
    });
    let lease = executable_lease(&request)?;
    let mut child = Command::new(&request.executable)
        .args(&request.args)
        .current_dir(&request.cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    drop(lease);
    owner.write_all(ACK)?;
    owner.flush()?;
    ready.store(true, Ordering::Release);
    let status = child.wait()?;
    Ok(status.code().unwrap_or(125))
}

fn owner_pipe() -> io::Result<File> {
    let handle = unsafe { _get_osfhandle(3) };
    if handle == 0 || handle == -1 || handle == -2 {
        return Err(invalid());
    }
    let handle = handle as HANDLE;
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // This process never uses CRT fd 3 again. File takes the handle until process exit.
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn owned_job() -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
        || unsafe { AssignProcessToJobObject(handle, GetCurrentProcess()) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

fn executable_lease(request: &Launch) -> io::Result<File> {
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&request.executable)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.nNumberOfLinks != 1
        || !file.metadata()?.is_file()
        || file.metadata()?.len() > 512 * 1024 * 1024
    {
        return Err(invalid());
    }
    let mut header = [0_u8; 64];
    file.read_exact(&mut header)?;
    let pe = u32::from_le_bytes(header[60..64].try_into().map_err(|_| invalid())?);
    if &header[..2] != b"MZ" || pe < 64 || u64::from(pe) + 4 > file.metadata()?.len() {
        return Err(invalid());
    }
    file.seek(SeekFrom::Start(u64::from(pe)))?;
    let mut signature = [0; 4];
    file.read_exact(&mut signature)?;
    if &signature != b"PE\0\0" {
        return Err(invalid());
    }
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != request.digest {
        return Err(invalid());
    }
    Ok(file)
}

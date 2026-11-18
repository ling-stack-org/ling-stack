#include "LockedUseNative.h"
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <string.h>
#include <sys/event.h>
#include <unistd.h>

int ling_copy_process_identity(int32_t pid, LingPeerIdentity *out) {
    if (!out || pid <= 0) { errno = EINVAL; return -1; }
    memset(out, 0, sizeof(*out));
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t result = task_name_for_pid(mach_task_self(), pid, &task);
    if (result != KERN_SUCCESS) { errno = EACCES; return -1; }
    audit_token_t token = {0};
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    result = task_info(task, TASK_AUDIT_TOKEN, (task_info_t)&token, &count);
    mach_port_deallocate(mach_task_self(), task);
    if (result != KERN_SUCCESS || count != TASK_AUDIT_TOKEN_COUNT || audit_token_to_pid(token) != pid) {
        errno = EACCES; return -1;
    }
    memcpy(out->audit_token, &token, sizeof(token));
    out->effective_user_id = audit_token_to_euid(token);
    out->audit_user_id = audit_token_to_auid(token);
    out->audit_session_id = audit_token_to_asid(token);
    out->process_id = pid;
    return 0;
}

int ling_process_identity_matches(int32_t pid, const uint8_t token[32]) {
    if (!token || pid <= 0) { errno = EINVAL; return -1; }
    LingPeerIdentity current;
    if (ling_copy_process_identity(pid, &current) == 0)
        return memcmp(current.audit_token, token, 32) == 0 ? 1 : 0;
    /* An inaccessible live process is unknown, never proof of exit. */
    if (kill(pid, 0) == -1 && errno == ESRCH) return 0;
    errno = EACCES; return -1;
}

int ling_watch_process(int32_t pid, const uint8_t token[32]) {
    if (ling_process_identity_matches(pid, token) != 1) { errno = EAGAIN; return -1; }
    int fd = kqueue();
    if (fd < 0) return -1;
    struct kevent event;
    EV_SET(&event, pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0 || kevent(fd, &event, 1, NULL, 0, NULL) != 0 ||
        ling_process_identity_matches(pid, token) != 1) {
        int saved = errno; close(fd); errno = saved; return -1;
    }
    return fd;
}

int ling_process_exit_event(int fd, int32_t pid) {
    struct kevent event;
    struct timespec timeout = {0, 0};
    int count = kevent(fd, NULL, 0, &event, 1, &timeout);
    if (count <= 0) return count;
    if (event.ident != (uintptr_t)pid || event.filter != EVFILT_PROC ||
        event.flags & EV_ERROR || !(event.fflags & NOTE_EXIT)) { errno = EIO; return -1; }
    return 1;
}

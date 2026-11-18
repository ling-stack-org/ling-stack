#include "LockedUseNative.h"
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    int ready[2]; assert(pipe(ready) == 0);
    pid_t pid = fork(); assert(pid >= 0);
    if (pid == 0) {
        alarm(10);
        close(ready[0]); char byte = 1; assert(write(ready[1], &byte, 1) == 1);
        for (;;) pause();
    }
    close(ready[1]); char byte; assert(read(ready[0], &byte, 1) == 1); close(ready[0]);
    LingPeerIdentity identity;
    assert(ling_copy_process_identity(pid, &identity) == 0);
    assert(identity.process_id == pid && identity.effective_user_id == geteuid());
    assert(ling_process_identity_matches(pid, identity.audit_token) == 1);
    unsigned char stale[32]; memcpy(stale, identity.audit_token, 32); stale[31] ^= 1;
    assert(ling_process_identity_matches(pid, stale) == 0);
    assert(ling_watch_process(pid, stale) == -1);
    int watch = ling_watch_process(pid, identity.audit_token); assert(watch >= 0);
    assert(ling_process_exit_event(watch, pid) == 0);
    assert(kill(pid, SIGTERM) == 0); assert(waitpid(pid, NULL, 0) == pid);
    assert(ling_process_exit_event(watch, pid) == 1); close(watch);
    assert(ling_process_identity_matches(pid, identity.audit_token) == 0);
    assert(ling_watch_process(pid, identity.audit_token) == -1);
    puts("Locked Use kernel process checks passed: audit token, stale PID version, exact exit and absent process.");
    return 0;
}

#ifndef Ling_LOCKED_USE_NATIVE_H
#define Ling_LOCKED_USE_NATIVE_H
#include <stdint.h>

typedef struct {
    uint8_t audit_token[32];
    uint32_t effective_user_id;
    uint32_t audit_user_id;
    uint32_t audit_session_id;
    int32_t process_id;
} LingPeerIdentity;

/* Kernel-supplied connection identity, including pid version in the token.
 * Never reconstruct it from a pid reported by a client. Returns 0 on success. */
int ling_copy_peer_identity(int socket_fd, LingPeerIdentity *out_identity);
/* PID is a lookup key only; the returned token includes the kernel pid version. */
int ling_copy_process_identity(int32_t process_id, LingPeerIdentity *out_identity);
/* 1: same live token; 0: original exited; -1: identity cannot be established. */
int ling_process_identity_matches(int32_t process_id, const uint8_t audit_token[32]);
/* Exact NOTE_EXIT watch, verified before and after registration. Caller owns fd. */
int ling_watch_process(int32_t process_id, const uint8_t audit_token[32]);
/* 1: NOTE_EXIT; 0: no event; -1: watch failed. */
int ling_process_exit_event(int watch_fd, int32_t process_id);
/* 0: no allow ACE grants mutation; 1: unsafe; -1: inspection failed. */
int ling_has_mutating_acl(int file_fd);
int ling_has_any_acl(int file_fd);
int ling_remove_extended_acl(int file_fd);
/* SCM_RIGHTS transfers a connected endpoint for kernel peer verification only. */
int ling_send_peer_socket(int channel_fd, int peer_fd);
int ling_receive_peer_socket(int channel_fd);
#endif

#include <assert.h>
#include <mach/mach.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
extern int32_t ling_verify_broker_task(const void *, const char *);
extern int32_t ling_diagnose_broker_task(const void *, const char *);
#ifndef LING_SIGNING_TEAM
#error "Signing team required"
#endif
int main(int argc, char **argv) {
    assert(argc == 2);
    audit_token_t token = {0};
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    assert(task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &count) == KERN_SUCCESS);
    int32_t result = ling_verify_broker_task(&token, LING_SIGNING_TEAM);
    if (result == -1) { puts("Kernel task verifier unavailable; legacy verification remains required."); return 0; }
    if (result != (strcmp(argv[1], "match") == 0 ? 1 : 0)) {
        fprintf(stderr, "Task verifier result=%d failedChecks=%d (bits: id=1 team=2 category=4 dynamic=8 signed=16 hardened=32 library=64)\n", result, ling_diagnose_broker_task(&token, LING_SIGNING_TEAM));
    }
    assert(result == (strcmp(argv[1], "match") == 0 ? 1 : 0));
    assert(ling_verify_broker_task(&token, "AAAAAAAAAA") == 0);
    assert(ling_verify_broker_task(&token, "malformed") == -2);
    assert(ling_verify_broker_task(NULL, LING_SIGNING_TEAM) == -2);

    puts("Kernel task verifier: live signature/category/runtime identity checked; wrong team and malformed input rejected.");
    return 0;
}

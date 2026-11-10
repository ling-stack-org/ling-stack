#pragma once

#include "runtime.h"
#include <sys/stat.h>

// Internal ledger/syscall helpers only. No raw-FD or caller authority API.
namespace office_local::detail {
Call& prepare_call(Result&, const char*, const Resource&);
void returned(Call&, int64_t, int) noexcept;
void fail(Session&);
bool same_identity(const Identity&, const Identity&) noexcept;
Identity identity_from_stat(const struct stat&) noexcept;
Resource& prepare_resource(Session&, const std::string&, const std::string&, const std::string&);
void attach(Resource&, int) noexcept;
bool stat_original(Session&, Resource&, Result&);
void require_retained(const Resource&);
bool guard_original_node(Session&, Resource&, Result&);
Result read_held_file(Session&, Resource&, uint64_t, uint64_t, const std::string&,
    const std::shared_ptr<Readback>& = {}, bool require_written_bytes = true);
}  // namespace office_local::detail

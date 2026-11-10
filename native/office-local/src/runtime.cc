#include "runtime-internal.h"

#include <cerrno>
#include <cstdlib>
#include <cstdio>
#include <exception>
#include <fcntl.h>
#include <stdexcept>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#if !defined(__APPLE__)
#error "office-local currently supports macOS only; no rename/copy fallback"
#endif

namespace office_local {
namespace detail {

uint64_t monotonic_now() noexcept {
  struct timespec value {};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return static_cast<uint64_t>(value.tv_sec) * 1000000000ULL + static_cast<uint64_t>(value.tv_nsec);
}

std::vector<Call>& calls(Result& result) {
  return result.publication ? result.publication->calls
      : result.readback ? result.readback->calls : result.calls;
}

Call& prepare_call(Result& result, const char* name, const Resource& resource) {
  // Any allocation happens BEFORE syscall entry. Recording the real return
  // value and errno afterwards only assigns scalar fields and cannot throw.
  auto& trace = calls(result);
  trace.push_back({name, &resource, -2, 0});
  trace.back().called_monotonic_ns = monotonic_now();
  return trace.back();
}

void returned(Call& call, int64_t value, int error) noexcept {
  call.returned = value;
  call.error = value < 0 ? error : 0;
  call.has_returned = true;
  call.returned_monotonic_ns = monotonic_now();
}

void fail(Session& session) {
  session.ever_failed = true;
  session.phase = Phase::blocked;
}

struct NativeExceptionLatch {
  Session& session;
  int exceptions = std::uncaught_exceptions();
  ~NativeExceptionLatch() noexcept { if (std::uncaught_exceptions() > exceptions) fail(session); }
};

struct ReadbackExceptionLatch {
  Readback& readback;
  int exceptions = std::uncaught_exceptions();
  ~ReadbackExceptionLatch() noexcept {
    if (std::uncaught_exceptions() > exceptions) {
      readback.native_outcome = "unknown_exception";
      readback.blocker_code = "readback_native_exception";
      readback.success = false;
    }
  }
};

bool same_identity(const Identity& first, const Identity& second) noexcept {
  return first.device == second.device && first.inode == second.inode && first.size_bytes == second.size_bytes
      && first.modified_seconds == second.modified_seconds && first.modified_nanos == second.modified_nanos
      && first.changed_seconds == second.changed_seconds && first.changed_nanos == second.changed_nanos
      && first.mode == second.mode && first.is_file == second.is_file && first.is_directory == second.is_directory;
}

Resource& prepare_resource(Session& session, const std::string& kind,
                 const std::string& name, const std::string& parent) {
  auto resource = std::make_unique<Resource>();
  resource->id = session.nonce + ":" + std::to_string(++session.next_resource);
  resource->kind = kind;
  resource->basename = name;
  resource->parent_id = parent;
  auto* pointer = resource.get();
  session.resources.push_back(std::move(resource));
  return *pointer;
}

void attach(Resource& resource, int fd) noexcept {
  resource.fd = fd;
  resource.state = fd >= 0 ? ResourceState::retained : ResourceState::not_acquired;
}

Identity identity_from_stat(const struct stat& value) noexcept {
  Identity identity;
  identity.device = static_cast<uint64_t>(value.st_dev);
  identity.inode = static_cast<uint64_t>(value.st_ino);
  identity.size_bytes = static_cast<int64_t>(value.st_size);
  identity.modified_seconds = static_cast<int64_t>(value.st_mtimespec.tv_sec);
  identity.modified_nanos = static_cast<int32_t>(value.st_mtimespec.tv_nsec);
  identity.changed_seconds = static_cast<int64_t>(value.st_ctimespec.tv_sec);
  identity.changed_nanos = static_cast<int32_t>(value.st_ctimespec.tv_nsec);
  identity.mode = static_cast<uint32_t>(value.st_mode);
  identity.is_file = S_ISREG(value.st_mode);
  identity.is_directory = S_ISDIR(value.st_mode);
  return identity;
}

bool stat_original(Session& session, Resource& resource, Result& result) {
  struct stat value {};
  auto& call = prepare_call(result, "fstat", resource);
  int value_returned = fstat(resource.fd, &value);
  const int error = errno;
  returned(call, value_returned, error);
  if (value_returned < 0) {
    if (error == EBADF) {
      // The original lifetime is already gone. Never let close/abandonment
      // act on this number after a later foreign descriptor reuses it.
      resource.fd = -1;
      resource.state = ResourceState::unknown;
    }
    // Other fstat errors do not establish that the lifetime was released.
    fail(session); return false;
  }
  const auto identity = identity_from_stat(value);
  call.has_identity = true;
  call.identity = identity;
  if (!resource.observed) {
    resource.initial_identity = identity;
    resource.initial_observed_monotonic_ns = call.returned_monotonic_ns;
  }
  resource.current_identity = identity;
  resource.device = identity.device;
  resource.inode = identity.inode;
  resource.observed_monotonic_ns = call.returned_monotonic_ns;
  resource.observed = true;
  return true;
}

// Every ancestor is opened relative to its original held predecessor; no
// symlinks or second path lookup can recover authority. All FDs remain held.
Resource* open_chain(Session& session, const std::string& path,
                     const std::string& final_kind, Result& result) {
  auto& root = prepare_resource(session, "ancestor", "/", "");
  auto& root_call = prepare_call(result, "open", root);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  const int root_error = errno;
  attach(root, fd);
  returned(root_call, fd, root_error);
  if (fd < 0) { fail(session); return nullptr; }
  if (!stat_original(session, root, result)) return nullptr;
  Resource* current = &root;
  size_t start = 1;
  while (start < path.size()) {
    size_t end = path.find('/', start);
    if (end == std::string::npos) end = path.size();
    const std::string component = path.substr(start, end - start);
    auto& child = prepare_resource(session, end == path.size() ? final_kind : "ancestor", component, current->id);
    auto& call = prepare_call(result, "openat", child);
    fd = openat(current->fd, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const int error = errno;
    attach(child, fd);
    returned(call, fd, error);
    if (fd < 0) { fail(session); return nullptr; }
    if (!stat_original(session, child, result)) return nullptr;
    current = &child;
    start = end + 1;
  }
  return current;
}

void require_retained(const Resource& resource) {
  if (resource.state != ResourceState::retained || resource.fd < 0)
    throw std::runtime_error("resource_not_retained");
}

bool guard_original_node(Session& session, Resource& resource, Result& result) {
  if (!stat_original(session, resource, result)) return false;
  const auto& current = resource.current_identity;
  const auto& original = resource.initial_identity;
  if (current.device == original.device && current.inode == original.inode
      && current.is_file == original.is_file && current.is_directory == original.is_directory) return true;
  resource.fd = -1;
  resource.state = ResourceState::unknown;
  fail(session);
  return false;
}

void require_building(const Session& session) {
  if (session.phase != Phase::building) throw std::runtime_error("session_not_building");
}

}  // namespace detail
using namespace detail;

Session::Session() {
  unsigned char bytes[16];
  arc4random_buf(bytes, sizeof(bytes));
  static constexpr char hex[] = "0123456789abcdef";
  for (const auto byte : bytes) { nonce += hex[byte >> 4]; nonce += hex[byte & 15]; }
}

Session::~Session() {
  // Abandonment is NOT explicit close proof. No result/receipt is emitted here.
  // Unknown descriptors were tombstoned before close entry and are never used.
  for (auto iterator = resources.rbegin(); iterator != resources.rend(); ++iterator) {
    auto& resource = **iterator;
    if (resource.state == ResourceState::retained && resource.fd >= 0) {
      const int fd = resource.fd;
      resource.fd = -1;
      resource.state = ResourceState::unknown;
      if (resource.kind == "publication_directory" || resource.kind == "publication_file") {
        // Abandonment still emits no explicit-close proof, but must never close
        // a foreign object after an observer descriptor was externally reused.
        struct stat value {};
        if (fstat(fd, &value) != 0) continue;
        const auto identity = identity_from_stat(value);
        const auto& original = resource.initial_identity;
        if (!resource.observed || identity.device != original.device || identity.inode != original.inode
            || identity.is_file != original.is_file || identity.is_directory != original.is_directory) continue;
      }
      (void)close(fd);
    }
  }
}

void Session::consume(const std::string& operation) {
  if (operation.empty() || operation.size() > 256 || operation.find('\0') != std::string::npos)
    throw std::runtime_error("invalid_operation_id");
  if (!operations.insert(operation).second) throw std::runtime_error("operation_already_consumed");
}

bool valid_component(const std::string& name) {
  return !name.empty() && name != "." && name != ".." && name.size() <= 255
      && name.find('/') == std::string::npos && name.find('\0') == std::string::npos;
}

bool valid_absolute_path(const std::string& path) {
  if (path.size() < 2 || path[0] != '/' || path.back() == '/' || path.find('\0') != std::string::npos)
    return false;
  size_t start = 1;
  while (start < path.size()) {
    size_t end = path.find('/', start);
    if (end == std::string::npos) end = path.size();
    if (!valid_component(path.substr(start, end - start))) return false;
    start = end + 1;
  }
  return true;
}

std::string state_name(ResourceState state) {
  switch (state) {
    case ResourceState::not_acquired: return "not_acquired";
    case ResourceState::retained: return "retained";
    case ResourceState::closed: return "closed";
    case ResourceState::unknown: return "unknown";
  }
  return "unknown";
}

std::string phase_name(Phase phase) {
  switch (phase) {
    case Phase::building: return "building";
    case Phase::blocked: return "blocked";
    case Phase::published: return "published_native_only";
    case Phase::cancelled: return "cancelled";
    case Phase::closed: return "closed";
  }
  return "unknown";
}

Result open_parents(Session& session, const std::string& stage, const std::string& destination) {
  NativeExceptionLatch latch{session};
  Result result;
  session.stage_parent = open_chain(session, stage, "stage_parent", result);
  if (session.stage_parent) session.destination_parent = open_chain(session, destination, "destination_parent", result);
  result.success = session.stage_parent && session.destination_parent;
  return result;
}

Result create_directory(Session& session, Resource& parent, const std::string& name) {
  require_building(session); require_retained(parent);
  if ((parent.kind != "stage_parent" && parent.kind != "created_directory")
      || (parent.kind == "stage_parent" && session.tree)) throw std::runtime_error("invalid_directory_parent");
  Result result;
  NativeExceptionLatch latch{session};
  auto& resource = prepare_resource(session, "created_directory", name, parent.id);
  auto& mkdir_call = prepare_call(result, "mkdirat", resource);
  int value_returned = mkdirat(parent.fd, name.c_str(), 0700);
  const int error = errno;
  returned(mkdir_call, value_returned, error);
  if (value_returned < 0) { fail(session); return result; }
  session.residual_creation = true;
  parent.synced = false;
  if (parent.kind == "stage_parent") session.tree = &resource;
  result.resource = &resource;
  auto& open_call = prepare_call(result, "openat", resource);
  const int fd = openat(parent.fd, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  const int open_error = errno;
  attach(resource, fd);
  returned(open_call, fd, open_error);
  if (fd < 0) { fail(session); return result; }
  result.success = stat_original(session, resource, result);
  return result;
}

Result create_file(Session& session, Resource& parent, const std::string& name) {
  require_building(session); require_retained(parent);
  if (parent.kind != "created_directory") throw std::runtime_error("invalid_file_parent");
  Result result;
  NativeExceptionLatch latch{session};
  auto& resource = prepare_resource(session, "created_file", name, parent.id);
  auto& call = prepare_call(result, "openat_create_exclusive", resource);
  const int fd = openat(parent.fd, name.c_str(), O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  const int error = errno;
  attach(resource, fd);
  // Failed open never acquires/adopts a resource, even if a foreign name exists.
  returned(call, fd, error);
  if (fd < 0) { fail(session); return result; }
  parent.synced = false;
  result.resource = &resource;
  result.success = stat_original(session, resource, result);
  return result;
}

Result write_file(Session& session, Resource& file, const uint8_t* bytes, size_t size) {
  require_building(session); require_retained(file);
  if (file.kind != "created_file") throw std::runtime_error("invalid_file_resource");
  if (size > 64ULL * 1024 * 1024) throw std::runtime_error("buffer_too_large");
  Result result; result.resource = &file;
  NativeExceptionLatch latch{session};
  result.maximum_syscall_attempts = (size + 65535) / 65536 + 32;
  result.calls.reserve(static_cast<size_t>(result.maximum_syscall_attempts));
  file.synced = false;
  size_t offset = 0;
  while (offset < size) {
    if (result.syscall_attempts >= result.maximum_syscall_attempts) {
      result.blocker_code = "write_operation_budget_exhausted";
      fail(session); return result;
    }
    const size_t remaining = size - offset;
    const size_t count = remaining > 65536 ? 65536 : remaining;
    auto& call = prepare_call(result, "write", file);
    call.has_io = true;
    call.requested_bytes = count;
    call.offset = file.bytes_written;
    ++result.syscall_attempts;
    const ssize_t value_returned = write(file.fd, bytes + offset, count);
    const int error = errno;
    returned(call, value_returned, error);
    if (value_returned < 0 && error == EINTR) continue;
    if (value_returned <= 0) { fail(session); return result; }
    offset += static_cast<size_t>(value_returned);
    file.bytes_written += static_cast<uint64_t>(value_returned);
  }
  result.success = true;
  return result;
}

Result read_file(Session& session, Resource& file, uint64_t expected_bytes,
    uint64_t budget_bytes, const std::string& operation) {
  // Never enter even fstat on cancelled/closed/unknown/foreign resources. The
  // N-API layer already checked the original session/capability association.
  require_building(session); require_retained(file);
  if (file.kind != "created_file") throw std::runtime_error("invalid_file_resource");
  if (!file.synced) throw std::runtime_error("file_not_synced");
  constexpr uint64_t maximum = 50ULL * 1024 * 1024;
  if (expected_bytes > maximum || budget_bytes != expected_bytes + 1)
    throw std::runtime_error("invalid_read_budget");

  return detail::read_held_file(session, file, expected_bytes, budget_bytes, operation);
}

Result detail::read_held_file(Session& session, Resource& file, uint64_t expected_bytes,
    uint64_t budget_bytes, const std::string& operation, const std::shared_ptr<Readback>& prepared,
    bool require_written_bytes) {
  require_retained(file);
  Result result; result.resource = &file;
  NativeExceptionLatch latch{session};
  auto readback = prepared ? prepared : std::make_shared<Readback>();
  readback->resource = &file;
  readback->operation_id = operation;
  readback->expected_bytes = expected_bytes;
  readback->budget_bytes = budget_bytes;
  readback->maximum_syscall_attempts = (expected_bytes + 65535) / 65536 + 1 + 32;
  session.readbacks.push_back(readback);  // Own original facts before any read entry.
  result.readback = readback;
  ReadbackExceptionLatch read_latch{*readback};
  readback->calls.reserve(static_cast<size_t>(readback->maximum_syscall_attempts + 2));
  result.bytes.resize(static_cast<size_t>(expected_bytes));  // Bounded allocation before pread.

  const auto rejected = [&](const char* code) {
    readback->blocker_code = code;
    readback->native_outcome = "returned_failed";
    readback->success = false;
    fail(session);
  };
  readback->native_outcome = "entered";
  if (!stat_original(session, file, result)) { rejected("readback_before_fstat_failed"); return result; }
  readback->before = file.current_identity;
  readback->before_observed = true;
  const auto& acquired = file.initial_identity;
  if (readback->before.device != acquired.device || readback->before.inode != acquired.inode
      || readback->before.is_file != acquired.is_file || readback->before.is_directory != acquired.is_directory) {
    // The descriptor integer no longer denotes the acquired original lifetime.
    // Never adopt, read, or close the foreign object behind that reused number.
    file.fd = -1;
    file.state = ResourceState::unknown;
    rejected("readback_original_node_mismatch"); return result;
  }
  if (!readback->before.is_file || readback->before.size_bytes < 0
      || static_cast<uint64_t>(readback->before.size_bytes) != expected_bytes
      || (require_written_bytes && file.bytes_written != expected_bytes)) {
    rejected("readback_size_mismatch"); return result;
  }

  while (readback->bytes_read < expected_bytes) {
    if (readback->syscall_attempts >= readback->maximum_syscall_attempts) {
      rejected("readback_operation_budget_exhausted"); break;
    }
    const uint64_t remaining = expected_bytes - readback->bytes_read;
    const size_t count = static_cast<size_t>(remaining > 65536 ? 65536 : remaining);
    auto& call = prepare_call(result, "pread", file);  // Allocation before this syscall, not after it.
    call.has_io = true; call.requested_bytes = count; call.offset = readback->bytes_read;
    ++readback->syscall_attempts;
    const ssize_t value_returned = pread(file.fd, result.bytes.data() + readback->bytes_read,
        count, static_cast<off_t>(readback->bytes_read));
    const int error = errno;
    returned(call, value_returned, error);
    if (value_returned < 0 && error == EINTR) continue;
    if (value_returned <= 0) {
      rejected(value_returned == 0 ? "readback_unexpected_eof" : "readback_pread_failed");
      break;
    }
    readback->bytes_read += static_cast<uint64_t>(value_returned);
  }
  if (!readback->blocker_code) {
    // A real read at expected EOF, not an inference from size/stat or a stub.
    uint8_t probe = 0;
    for (;;) {
      if (readback->syscall_attempts >= readback->maximum_syscall_attempts) {
        rejected("readback_operation_budget_exhausted"); break;
      }
      auto& call = prepare_call(result, "pread_eof_probe", file);
      call.has_io = true; call.requested_bytes = 1; call.offset = expected_bytes;
      ++readback->syscall_attempts;
      const ssize_t value_returned = pread(file.fd, &probe, 1, static_cast<off_t>(expected_bytes));
      const int error = errno;
      returned(call, value_returned, error);
      if (value_returned < 0 && error == EINTR) continue;
      readback->eof_observed = value_returned == 0;
      if (!readback->eof_observed) rejected(value_returned < 0 ? "readback_eof_probe_failed" : "readback_expected_eof");
      break;
    }
  }

  if (!stat_original(session, file, result)) { rejected("readback_after_fstat_failed"); return result; }
  readback->after = file.current_identity;
  readback->after_observed = true;
  readback->identities_match = same_identity(readback->before, readback->after);
  if (readback->after.device != acquired.device || readback->after.inode != acquired.inode
      || readback->after.is_file != acquired.is_file || readback->after.is_directory != acquired.is_directory) {
    file.fd = -1;
    file.state = ResourceState::unknown;
  }
  if (!readback->identities_match && !readback->blocker_code) rejected("readback_identity_mismatch");
  for (const auto& call : readback->calls) {
    if ((!call.has_returned || call.called_monotonic_ns == 0
        || call.returned_monotonic_ns < call.called_monotonic_ns) && !readback->blocker_code)
      rejected("readback_clock_window_unverified");
  }
  if (!readback->blocker_code) {
    readback->success = true;
    readback->native_outcome = "returned_success";
    result.success = true;
  }
  return result;
}

Result sync_resource(Session& session, Resource& resource) {
  require_retained(resource);
  if (session.phase != Phase::building && session.phase != Phase::published)
    throw std::runtime_error("session_not_syncable");
  Result result; result.resource = &resource;
  NativeExceptionLatch latch{session};
  auto& call = prepare_call(result, "fsync", resource);
  const int value_returned = fsync(resource.fd);
  const int error = errno;
  returned(call, value_returned, error);
  result.success = value_returned == 0;
  if (result.success) resource.synced = true;
  else fail(session);
  return result;
}

Result observe_resource(Session& session, Resource& resource) {
  require_retained(resource);
  if (session.phase == Phase::closed) throw std::runtime_error("session_closed");
  Result result; result.resource = &resource;
  NativeExceptionLatch latch{session};
  result.success = stat_original(session, resource, result);
  return result;
}

Result install_tree(Session& session, Resource& tree, const std::string& name) {
  require_building(session); require_retained(tree);
  require_retained(*session.stage_parent); require_retained(*session.destination_parent);
  if (&tree != session.tree || tree.parent_id != session.stage_parent->id || session.installation_entered)
    throw std::runtime_error("invalid_install_source");
  for (const auto& pointer : session.resources) {
    const auto& resource = *pointer;
    if (resource.kind == "created_file" && (resource.state != ResourceState::closed || !resource.synced))
      throw std::runtime_error("file_not_synced_and_closed");
    if (resource.kind == "created_directory" && (resource.state != ResourceState::retained || !resource.synced))
      throw std::runtime_error("directory_not_synced_and_retained");
  }
  Result result; result.resource = &tree;
  NativeExceptionLatch latch{session};
  auto installation = std::make_shared<Installation>();
  installation->tree = &tree;
  installation->source_parent = session.stage_parent;
  installation->destination_parent = session.destination_parent;
  installation->destination_name = name;
  for (const auto& pointer : session.resources) {
    auto& resource = *pointer;
    if (resource.kind != "created_directory" && resource.kind != "created_file") continue;
    Resource* parent = nullptr;
    for (const auto& candidate : session.resources)
      if (candidate->id == resource.parent_id) { parent = candidate.get(); break; }
    installation->entries.push_back({&resource, parent, resource.bytes_written});
  }
  session.installation = installation;
  auto& call = prepare_call(result, "renameatx_np_RENAME_EXCL", tree);
  installation->entered = true;
  installation->called_monotonic_ns = call.called_monotonic_ns;
  session.installation_entered = true;  // One publication syscall, including failures.
  const int value_returned = renameatx_np(session.stage_parent->fd, tree.basename.c_str(),
      session.destination_parent->fd, name.c_str(), RENAME_EXCL);
  const int error = errno;
  returned(call, value_returned, error);
  installation->has_returned = true;
  installation->returned = call.returned;
  installation->error = call.error;
  installation->returned_monotonic_ns = call.returned_monotonic_ns;
  result.success = value_returned == 0;
  if (result.success) {
    session.phase = Phase::published;
    session.residual_creation = false;
    session.stage_parent->synced = false;
    session.destination_parent->synced = false;
  } else fail(session);  // In particular, EXDEV/ENOTSUP/EEXIST have no fallback.
  return result;
}

Result close_resource(Session& session, Resource& resource) {
  require_retained(resource);
  Result result; result.resource = &resource;
  NativeExceptionLatch latch{session};
  // Publication-read handles grant no forward capability. Their guarded close
  // must not act on an externally invalidated/reused descriptor integer.
  if (resource.kind == "publication_directory" || resource.kind == "publication_file") {
    // Both fact slots are allocated before fstat entry, so the second close
    // slot cannot erase the already-returned guard fact with a bad allocation.
    result.calls.reserve(2);
    if (!guard_original_node(session, resource, result)) return result;
  }
  auto& call = prepare_call(result, "close", resource);
  const int original = resource.fd;
  resource.fd = -1;
  resource.state = ResourceState::unknown;  // Before entry: never retry this integer.
  const int value_returned = close(original);
  const int error = errno;
  returned(call, value_returned, error);
  result.success = value_returned == 0;
  if (result.success) resource.state = ResourceState::closed;
  else fail(session);
  return result;
}

Result close_session(Session& session) {
  if (session.phase == Phase::closed) throw std::runtime_error("session_already_closed");
  Result result; result.success = true;
  NativeExceptionLatch latch{session};
  // Explicit close traverses every retained original lifetime once, even after
  // another resource failed. Unknown entries are not inspected or retried.
  for (auto iterator = session.resources.rbegin(); iterator != session.resources.rend(); ++iterator) {
    auto& resource = **iterator;
    if (resource.state == ResourceState::unknown) { result.success = false; continue; }
    if (resource.state == ResourceState::closed || resource.state == ResourceState::not_acquired) continue;
    auto closed = close_resource(session, resource);
    result.success = result.success && closed.success;
    result.calls.insert(result.calls.end(), closed.calls.begin(), closed.calls.end());
  }
  session.phase = Phase::closed;
  return result;
}

}  // namespace office_local

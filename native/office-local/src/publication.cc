#include "runtime-internal.h"

#include <cerrno>
#include <exception>
#include <fcntl.h>
#include <stdexcept>
#include <unistd.h>

namespace office_local {
namespace {
using namespace detail;
constexpr uint64_t maximum_payload = 50ULL * 1024 * 1024;
constexpr size_t maximum_entries = 128;

bool same_node(const Identity& expected, const Identity& actual) noexcept {
  return expected.device == actual.device && expected.inode == actual.inode
      && expected.mode == actual.mode && expected.is_file == actual.is_file
      && expected.is_directory == actual.is_directory;
}

struct PublicationExceptionLatch {
  Session& session;
  Publication& publication;
  int exceptions = std::uncaught_exceptions();
  ~PublicationExceptionLatch() noexcept {
    if (std::uncaught_exceptions() > exceptions) {
      publication.native_outcome = "unknown_exception";
      publication.blocker_code = "publication_native_exception";
      publication.success = false;
      fail(session);
    }
  }
};

Resource* observed_parent(Session& session, const Installation& installation,
    const Publication& publication, const InstalledEntry& entry) noexcept {
  if (entry.original == installation.tree) return session.destination_parent;
  for (const auto& candidate : publication.entries)
    if (candidate.original == entry.original_parent) return candidate.observed;
  return nullptr;
}

void append_calls(Publication& publication, const std::vector<Call>& calls) {
  // The conservative whole-operation capacity was reserved before entry.
  // Call contains only scalar values/pointers; copying returned facts cannot
  // erase an entered syscall by allocating a new per-call string.
  for (const auto& call : calls) publication.calls.push_back(call);
}

bool fence_entry(Session& session, Resource& parent, Resource& observed,
    const Identity& expected, bool full_identity, Result& result) {
  struct stat value {};
  auto& call = prepare_call(result, "fstatat_no_follow", observed);
  call.entry_name = observed.basename.c_str();
  const int rc = fstatat(parent.fd, observed.basename.c_str(), &value, AT_SYMLINK_NOFOLLOW);
  const int error = errno;
  returned(call, rc, error);
  if (rc < 0) return false;
  call.has_identity = true;
  call.identity = identity_from_stat(value);
  if (full_identity ? same_identity(expected, call.identity) : same_node(expected, call.identity)) return true;
  fail(session);
  return false;
}
}  // namespace

Result observe_publication(Session& session, Resource& tree, uint64_t budget_bytes,
    const std::string& operation) {
  if (session.publication_observation_claimed) throw std::runtime_error("publication_observation_already_claimed");
  if (session.cancel_requested) throw std::runtime_error("session_cancel_requested");
  if (session.phase != Phase::published) throw std::runtime_error("session_not_published");
  const auto installation = session.installation;
  if (!installation || !installation->entered || !installation->has_returned || installation->returned != 0
      || &tree != session.tree || &tree != installation->tree
      || installation->destination_parent != session.destination_parent)
    throw std::runtime_error("invalid_publication_source");
  require_retained(*session.destination_parent);
  if (installation->entries.empty() || installation->entries.size() > maximum_entries
      || installation->entries.front().original != &tree)
    throw std::runtime_error("invalid_publication_roster");

  uint64_t expected_bytes = 0, file_count = 0, read_calls = 0;
  for (size_t i = 0; i < installation->entries.size(); ++i) {
    const auto& entry = installation->entries[i];
    if (!entry.original || !entry.original->observed || !entry.original_parent
        || (entry.original->kind != "created_directory" && entry.original->kind != "created_file"))
      throw std::runtime_error("invalid_publication_roster");
    if (entry.original != &tree) {
      bool parent_precedes = false;
      for (size_t previous = 0; previous < i; ++previous)
        if (installation->entries[previous].original == entry.original_parent
            && entry.original_parent->kind == "created_directory") parent_precedes = true;
      if (!parent_precedes) throw std::runtime_error("invalid_publication_roster");
    }
    if (entry.original->kind != "created_file") continue;
    if (entry.expected_bytes > maximum_payload - expected_bytes)
      throw std::runtime_error("publication_payload_too_large");
    expected_bytes += entry.expected_bytes;
    ++file_count;
    read_calls += (entry.expected_bytes + 65535) / 65536 + 1 + 32 + 2;
  }
  if (budget_bytes != expected_bytes + file_count) throw std::runtime_error("invalid_publication_budget");

  Result result;
  auto publication = std::make_shared<Publication>();
  publication->operation_id = operation;
  publication->expected_bytes = expected_bytes;
  publication->budget_bytes = budget_bytes;
  // before/after destination fstat; each entry open/fstat/fence/guard/close;
  // each file's bounded data+EOF calls and before/after fstat.
  publication->maximum_calls = 2 + 5 * installation->entries.size() + read_calls;
  session.publication = publication;
  session.publication_observation_claimed = true;
  result.publication = publication;
  PublicationExceptionLatch latch{session, *publication};
  publication->calls.reserve(static_cast<size_t>(publication->maximum_calls));
  publication->entries.reserve(installation->entries.size());
  session.resources.reserve(session.resources.size() + installation->entries.size());
  session.readbacks.reserve(session.readbacks.size() + static_cast<size_t>(file_count));
  result.publication_bytes.reserve(static_cast<size_t>(file_count));
  // Prepare all lifetime records and read histories BEFORE any observation
  // entry. No caller-provided name, path, FD, identity, or digest is accepted.
  for (const auto& entry : installation->entries) {
    auto* parent = observed_parent(session, *installation, *publication, entry);
    if (!parent) throw std::runtime_error("invalid_publication_roster");
    const bool file = entry.original->kind == "created_file";
    auto& observed = prepare_resource(session, file ? "publication_file" : "publication_directory",
        entry.original == &tree ? installation->destination_name : entry.original->basename, parent->id);
    std::shared_ptr<Readback> readback;
    if (file) {
      readback = std::make_shared<Readback>();
      readback->resource = &observed;
      readback->operation_id = operation;
      readback->expected_bytes = entry.expected_bytes;
      readback->budget_bytes = entry.expected_bytes + 1;
      readback->maximum_syscall_attempts = (entry.expected_bytes + 65535) / 65536 + 1 + 32;
      readback->calls.reserve(static_cast<size_t>(readback->maximum_syscall_attempts + 2));
    }
    publication->entries.push_back({entry.original, &observed, readback});
  }
  const auto rejected = [&](const char* code) {
    publication->blocker_code = code;
    publication->native_outcome = "returned_failed";
    result.blocker_code = code;
    fail(session);
  };
  publication->native_outcome = "entered";
  if (!guard_original_node(session, *session.destination_parent, result)) {
    rejected("publication_destination_parent_unavailable"); return result;
  }
  for (size_t i = 0; i < installation->entries.size(); ++i) {
    const auto& original = installation->entries[i];
    auto& entry = publication->entries[i];
    auto& observed = *entry.observed;
    auto& parent = *observed_parent(session, *installation, *publication, original);
    const bool file = original.original->kind == "created_file";
    auto& call = prepare_call(result, "openat", observed);
    call.entry_name = observed.basename.c_str();
    const int fd = openat(parent.fd, observed.basename.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
        | (file ? 0 : O_DIRECTORY));
    const int error = errno;
    attach(observed, fd);  // Own any real acquired read-only lifetime before fstat.
    returned(call, fd, error);
    if (fd < 0) { rejected("publication_entry_open_failed"); return result; }
    if (!stat_original(session, observed, result)) { rejected("publication_entry_fstat_failed"); return result; }
    if (!same_node(original.original->initial_identity, observed.current_identity)) {
      // A newly acquired foreign object is only a read-only close obligation,
      // never a created-entry adoption, payload source, or cleanup capability.
      rejected("publication_original_node_mismatch"); return result;
    }
    if (!file) continue;
    Result read;
    try {
      read = read_held_file(session, observed, original.expected_bytes, original.expected_bytes + 1,
          operation, entry.readback, false);
    } catch (...) {
      append_calls(*publication, entry.readback->calls);
      throw;
    }
    append_calls(*publication, entry.readback->calls);
    if (!read.success) { rejected(entry.readback->blocker_code); return result; }
    result.publication_bytes.push_back(std::move(read.bytes));
  }
  // The held file FD alone cannot prove that its original canonical name still
  // refers to it. Fence EVERY original installation entry after all reads,
  // starting from the original destination-parent FD (not an absolute reopen).
  for (size_t i = 0; i < installation->entries.size(); ++i) {
    const auto& original = installation->entries[i];
    const auto& entry = publication->entries[i];
    const auto& expected = entry.readback ? entry.readback->after : entry.observed->initial_identity;
    if (!fence_entry(session, *observed_parent(session, *installation, *publication, original),
        *entry.observed, expected, static_cast<bool>(entry.readback), result)) {
      rejected("publication_canonical_entry_mismatch"); return result;
    }
  }
  if (!guard_original_node(session, *session.destination_parent, result)) {
    rejected("publication_destination_parent_unavailable"); return result;
  }
  // Success requires actual explicit guarded close of every acquired observer
  // handle. Failure keeps the exact original session obligations for closeAll.
  for (auto iterator = publication->entries.rbegin(); iterator != publication->entries.rend(); ++iterator) {
    auto closed = close_resource(session, *iterator->observed);
    append_calls(*publication, closed.calls);
    if (!closed.success) { rejected("publication_readonly_close_failed"); return result; }
  }
  for (const auto& call : publication->calls) {
    if (!call.has_returned || call.called_monotonic_ns == 0
        || call.returned_monotonic_ns < call.called_monotonic_ns) {
      rejected("publication_clock_window_unverified"); return result;
    }
  }
  publication->success = true;
  publication->native_outcome = "returned_success";
  result.success = true;
  return result;
}
}  // namespace office_local

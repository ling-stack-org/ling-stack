#include "../src/runtime.h"

#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <new>
#include <sys/stat.h>
#include <unistd.h>

namespace {
enum class Injection { none, short_read, root_aba_after_eof, exception_after_eof };
Injection injection = Injection::none;
int destination_fd = -1;
bool root_replaced = false;
uint64_t real_read_calls = 0;
bool fail_next_allocation = false;

ssize_t publication_test_pread(int fd, void* bytes, size_t size, off_t offset) {
  const auto returned = pread(fd, bytes, injection == Injection::short_read && size > 1 ? 1 : size, offset);
  ++real_read_calls;
  if (injection == Injection::exception_after_eof && returned == 0) fail_next_allocation = true;
  if (injection == Injection::root_aba_after_eof && returned == 0 && !root_replaced) {
    // Deterministic real-kernel namespace interleaving, not a fake stat result.
    assert(renameat(destination_fd, "installed", destination_fd, "moved-installed") == 0);
    assert(mkdirat(destination_fd, "installed", 0700) == 0);
    root_replaced = true;
  }
  return returned;
}
}  // namespace

void* operator new(size_t size) {
  if (fail_next_allocation) { fail_next_allocation = false; throw std::bad_alloc(); }
  if (void* value = std::malloc(size == 0 ? 1 : size)) return value;
  throw std::bad_alloc();
}
void operator delete(void* value) noexcept { std::free(value); }

// Only this test executable interposes libc reads. The addon is NEVER compiled
// with these wrappers. Short I/O is explicitly injected, not kernel-spontaneous.
#define pread publication_test_pread
#include "../src/runtime.cc"
#undef pread

using namespace office_local;

std::unique_ptr<Session> installed(const char* stage, const char* destination, size_t bytes, bool second = false) {
  auto owner = std::make_unique<Session>();
  assert(open_parents(*owner, stage, destination).success);
  auto top = create_directory(*owner, *owner->stage_parent, "publication-native-tree");
  assert(top.success);
  auto file = create_file(*owner, *top.resource, "report");
  assert(file.success);
  const std::vector<uint8_t> payload(bytes, 0x41);
  assert(write_file(*owner, *file.resource, payload.data(), payload.size()).success);
  assert(sync_resource(*owner, *file.resource).success);
  assert(close_resource(*owner, *file.resource).success);
  if (second) {
    auto next = create_file(*owner, *top.resource, "second");
    assert(next.success && write_file(*owner, *next.resource, payload.data(), payload.size()).success);
    assert(sync_resource(*owner, *next.resource).success && close_resource(*owner, *next.resource).success);
  }
  assert(sync_resource(*owner, *top.resource).success);
  assert(install_tree(*owner, *top.resource, "installed").success);
  return owner;
}

Resource& retained_readonly_file(Session& owner) {
  for (const auto& resource : owner.resources)
    if (resource->kind == "publication_file" && resource->state == ResourceState::retained) return *resource;
  assert(false);
  std::terminate();
}

void readonly_lifetime(const char* stage, const char* destination, bool ebadf, bool abandon) {
  auto owner = installed(stage, destination, 0);
  const int append = openat(owner->tree->fd, "report", O_WRONLY | O_APPEND | O_CLOEXEC);
  assert(append >= 0 && write(append, "x", 1) == 1 && close(append) == 0);
  auto observation = observe_publication(*owner, *owner->tree, 1, "native-readonly-lifetime");
  assert(!observation.success && std::string(observation.publication->blocker_code) == "readback_size_mismatch");
  auto& resource = retained_readonly_file(*owner);
  const int original_number = resource.fd;
  assert(close(original_number) == 0);
  if (ebadf) {
    auto closed = close_resource(*owner, resource);
    assert(!closed.success && closed.calls.size() == 1);
    assert(std::string(closed.calls[0].name) == "fstat" && closed.calls[0].has_returned
        && closed.calls[0].returned == -1 && closed.calls[0].error == EBADF);
    assert(resource.fd == -1 && resource.state == ResourceState::unknown);
  }
  const int foreign = open("/dev/null", O_RDONLY | O_CLOEXEC);
  assert(foreign == original_number);
  if (abandon) owner.reset();
  else {
    auto closed = close_session(*owner);
    assert(!closed.success && owner->phase == Phase::closed);
    assert(resource.fd == -1 && resource.state == ResourceState::unknown);
    for (const auto& call : closed.calls)
      if (call.resource == &resource) assert(std::string(call.name) != "close");
  }
  assert(fcntl(foreign, F_GETFD) >= 0);
  assert(close(foreign) == 0);
  std::printf("{\"test\":\"publication-readonly-FD-lifetime\",\"actualEBADFBeforeReuse\":%s,"
      "\"abandonment\":%s,\"foreignFDStillOpen\":true,\"classification\":\"real-kernel-FD-reuse\"}\n",
      ebadf ? "true" : "false", abandon ? "true" : "false");
}

int main(int argc, char** argv) {
  assert(argc == 4);
  const std::string mode(argv[3]);
  if (mode == "readonly-ebadf-close" || mode == "readonly-reuse-close" || mode == "readonly-reuse-abandon") {
    readonly_lifetime(argv[1], argv[2], mode == "readonly-ebadf-close", mode == "readonly-reuse-abandon");
    return 0;
  }
  auto owner = installed(argv[1], argv[2], mode == "short-read-budget" ? 65537 : 4, mode == "unknown-after-eof");
  destination_fd = owner->destination_parent->fd;
  if (mode == "unknown-after-eof") {
    injection = Injection::exception_after_eof;
    bool threw = false;
    try { (void)observe_publication(*owner, *owner->tree, 10, "native-publication-unknown"); }
    catch (const std::bad_alloc&) { threw = true; }
    injection = Injection::none;
    assert(threw && owner->publication_observation_claimed && owner->phase == Phase::blocked);
    assert(std::string(owner->publication->native_outcome) == "unknown_exception");
    assert(owner->publication->entries[1].readback->success);
    assert(!owner->publication->calls.empty());
    const auto calls_before = owner->publication->calls.size();
    bool rejected = false;
    try { (void)observe_publication(*owner, *owner->tree, 10, "different-operation"); }
    catch (const std::runtime_error& error) { rejected = std::string(error.what()) == "publication_observation_already_claimed"; }
    assert(rejected && owner->publication->calls.size() == calls_before);
    assert(close_session(*owner).success);
    std::puts("{\"test\":\"publication-unknown-after-real-EOF\",\"originalCallsRetained\":true,"
        "\"newOperationRejectedWithoutNewCalls\":true,\"classification\":\"test-only-bad-allocation-injection-after-real-read\"}");
    return 0;
  }
  injection = mode == "short-read-budget" ? Injection::short_read : Injection::root_aba_after_eof;
  auto observation = observe_publication(*owner, *owner->tree, mode == "short-read-budget" ? 65538 : 5, "native-publication-observe");
  assert(!observation.success && owner->publication_observation_claimed);
  if (mode == "short-read-budget") {
    const auto& readback = *observation.publication->entries.back().readback;
    assert(std::string(readback.blocker_code) == "readback_operation_budget_exhausted");
    assert(readback.syscall_attempts == readback.maximum_syscall_attempts && readback.bytes_read == real_read_calls);
    std::printf("{\"test\":\"publication-injected-short-read-budget\",\"bounded\":true,\"actualPreadCalls\":%llu,"
        "\"classification\":\"test-only-injected-short-I-O-not-spontaneous-kernel-short-I-O\"}\n",
        static_cast<unsigned long long>(real_read_calls));
  } else {
    assert(mode == "root-aba-after-eof" && root_replaced);
    assert(std::string(observation.publication->blocker_code) == "publication_canonical_entry_mismatch");
    assert(observation.publication->entries.back().readback->success);
    bool real_mismatch_fence = false;
    for (const auto& call : observation.publication->calls)
      if (std::string(call.name) == "fstatat_no_follow" && call.has_identity
          && call.resource->basename == "installed"
          && call.identity.inode != owner->tree->initial_identity.inode) real_mismatch_fence = true;
    assert(real_mismatch_fence);
    std::puts("{\"test\":\"publication-root-ABA-after-real-EOF\",\"heldFileReadSucceeded\":true,"
        "\"parentRelativeFenceRejected\":true,\"classification\":\"deterministic-real-kernel-namespace-interleaving\"}");
  }
  assert(close_session(*owner).success);
}

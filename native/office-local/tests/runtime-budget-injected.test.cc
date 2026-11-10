#include "../src/runtime.h"

#include <cassert>
#include <cstdio>
#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>

using namespace office_local;

namespace {
bool inject_one_byte_reads = false;
bool inject_one_byte_writes = false;
}

// TEST EXECUTABLE ONLY: synthetic short-I/O behavior at the libc boundary.
// These wrappers are NOT linked into office-local.node. They change the
// requested count to one byte; this is not an actual spontaneous kernel short
// read/write or an injected errno claimed to be a real kernel failure.
extern "C" ssize_t pread(int fd, void* bytes, size_t count, off_t offset) {
  using Function = ssize_t (*)(int, void*, size_t, off_t);
  static auto original = reinterpret_cast<Function>(dlsym(RTLD_NEXT, "pread"));
  assert(original);
  return original(fd, bytes, inject_one_byte_reads && count > 1 ? 1 : count, offset);
}

extern "C" ssize_t write(int fd, const void* bytes, size_t count) {
  using Function = ssize_t (*)(int, const void*, size_t);
  static auto original = reinterpret_cast<Function>(dlsym(RTLD_NEXT, "write"));
  assert(original);
  return original(fd, bytes, inject_one_byte_writes && count > 1 ? 1 : count);
}

int main(int argc, char** argv) {
  assert(argc == 3);
  const std::vector<uint8_t> bytes(65537, 0x42);
  Session read_owner;
  assert(open_parents(read_owner, argv[1], argv[2]).success);
  auto read_directory = create_directory(read_owner, *read_owner.stage_parent, "read-budget-tree");
  assert(read_directory.success);
  auto read_file_resource = create_file(read_owner, *read_directory.resource, "file");
  assert(read_file_resource.success);
  assert(write_file(read_owner, *read_file_resource.resource, bytes.data(), bytes.size()).success);
  assert(sync_resource(read_owner, *read_file_resource.resource).success);
  inject_one_byte_reads = true;
  auto read = read_file(read_owner, *read_file_resource.resource, bytes.size(), bytes.size() + 1, "injected-short-read");
  inject_one_byte_reads = false;
  assert(!read.success && read.readback);
  const auto& facts = *read.readback;
  assert(std::string(facts.blocker_code) == "readback_operation_budget_exhausted");
  assert(facts.maximum_syscall_attempts == 35 && facts.syscall_attempts == 35);
  assert(facts.bytes_read == 35 && facts.calls.size() == 37);
  assert(facts.identities_match && facts.before_observed && facts.after_observed);
  assert(read_owner.phase == Phase::blocked && read_owner.ever_failed);
  assert(read_file_resource.resource->state == ResourceState::retained);
  assert(read_owner.readbacks[0]->blocker_code == facts.blocker_code);
  assert(close_session(read_owner).success);

  Session write_owner;
  assert(open_parents(write_owner, argv[1], argv[2]).success);
  auto write_directory = create_directory(write_owner, *write_owner.stage_parent, "write-budget-tree");
  assert(write_directory.success);
  auto write_file_resource = create_file(write_owner, *write_directory.resource, "file");
  assert(write_file_resource.success);
  inject_one_byte_writes = true;
  auto written = write_file(write_owner, *write_file_resource.resource, bytes.data(), bytes.size());
  inject_one_byte_writes = false;
  assert(!written.success && std::string(written.blocker_code) == "write_operation_budget_exhausted");
  assert(written.maximum_syscall_attempts == 34 && written.syscall_attempts == 34 && written.calls.size() == 34);
  assert(write_file_resource.resource->bytes_written == 34);
  struct stat observed {};
  assert(fstat(write_file_resource.resource->fd, &observed) == 0 && observed.st_size == 34);
  assert(write_owner.phase == Phase::blocked && write_owner.ever_failed);
  assert(close_session(write_owner).success);
  std::puts("{\"classification\":\"injected-test-only-libc-short-io-wrapper-not-actual-kernel-short-io\",\"readAttemptLimit\":35,\"readAttempts\":35,\"readTraceCount\":37,\"partialReadBytes\":35,\"writeAttemptLimit\":34,\"writeAttempts\":34,\"writeTraceCount\":34,\"partialWriteBytes\":34,\"blocked\":true,\"originalFactsRetained\":true}");
}

#include "../src/runtime.h"

#include <cassert>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

using namespace office_local;

struct FstatEbadfFacts {
  bool original_fstat_ebadf;
  bool tombstoned_before_reuse;
  bool close_skipped_original;
  bool foreign_still_open;
};

// The descriptor is gone BEFORE readback fstat, and reused only AFTER EBADF.
// Exercise explicit close and abandonment independently with real libc calls.
FstatEbadfFacts read_fstat_ebadf(const char* stage, const char* destination, bool abandon) {
  auto owner = std::make_unique<Session>();
  assert(open_parents(*owner, stage, destination).success);
  auto directory = create_directory(*owner, *owner->stage_parent,
      abandon ? "read-ebadf-abandon-tree" : "read-ebadf-close-tree");
  assert(directory.success);
  auto file = create_file(*owner, *directory.resource, "original");
  assert(file.success && sync_resource(*owner, *file.resource).success);
  auto& resource = *file.resource;
  const int original_number = resource.fd;
  assert(close(original_number) == 0);
  auto readback = read_file(*owner, resource, 0, 1, "read-real-fstat-ebadf");
  const auto& calls = readback.readback->calls;
  const bool actual_ebadf = !readback.success && calls.size() == 1
      && std::string(calls[0].name) == "fstat" && calls[0].has_returned
      && calls[0].returned == -1 && calls[0].error == EBADF
      && std::string(readback.readback->blocker_code) == "readback_before_fstat_failed";
  const bool tombstoned = resource.state == ResourceState::unknown && resource.fd == -1;
  const int foreign = open("/dev/null", O_RDONLY | O_CLOEXEC);
  assert(foreign >= 0 && foreign == original_number);
  bool skipped_original = true;
  if (abandon) owner.reset();
  else {
    const auto closed = close_session(*owner);
    skipped_original = !closed.success;
    for (const auto& call : closed.calls)
      if (call.resource == &resource) skipped_original = false;
    assert(owner->phase == Phase::closed);
  }
  const bool foreign_open = fcntl(foreign, F_GETFD) >= 0;
  if (foreign_open) assert(close(foreign) == 0);
  return {actual_ebadf, tombstoned, skipped_original, foreign_open};
}

// Real EBADF and real descriptor-number reuse, not a fake close return shim.
// This is deliberately native test code, not an addon-exported escape hatch.
int main(int argc, char** argv) {
  if (argc == 4 && std::string(argv[3]) == "read-fstat-ebadf") {
    const auto explicit_close = read_fstat_ebadf(argv[1], argv[2], false);
    const auto abandoned = read_fstat_ebadf(argv[1], argv[2], true);
    std::printf("{\"test\":\"real-read-fstat-EBADF-before-FD-reuse\","
        "\"originalFstatActualEBADF\":%s,\"tombstonedBeforeReuse\":%s,"
        "\"explicitCloseSkippedOriginal\":%s,\"foreignDescriptorStillOpenAfterCloseSession\":%s,"
        "\"abandonOriginalFstatActualEBADF\":%s,\"abandonTombstonedBeforeReuse\":%s,"
        "\"foreignDescriptorStillOpenAfterAbandon\":%s}\n",
        explicit_close.original_fstat_ebadf ? "true" : "false",
        explicit_close.tombstoned_before_reuse ? "true" : "false",
        explicit_close.close_skipped_original ? "true" : "false",
        explicit_close.foreign_still_open ? "true" : "false",
        abandoned.original_fstat_ebadf ? "true" : "false",
        abandoned.tombstoned_before_reuse ? "true" : "false",
        abandoned.foreign_still_open ? "true" : "false");
    return explicit_close.original_fstat_ebadf && explicit_close.tombstoned_before_reuse
        && explicit_close.close_skipped_original && explicit_close.foreign_still_open
        && abandoned.original_fstat_ebadf && abandoned.tombstoned_before_reuse
        && abandoned.foreign_still_open ? 0 : 1;
  }
  assert(argc == 3);
  Session owner;
  auto opened = open_parents(owner, argv[1], argv[2]);
  assert(opened.success);
  auto directory = create_directory(owner, *owner.stage_parent, "lifetime-tree");
  assert(directory.success);
  auto file = create_file(owner, *directory.resource, "original");
  assert(file.success);
  auto& resource = *file.resource;
  const int original_number = resource.fd;
  // Invalidate the original lifetime behind the ledger. The product close
  // really enters the kernel and gets EBADF; it MUST permanently tombstone it.
  assert(close(original_number) == 0);
  auto closed = close_resource(owner, resource);
  assert(!closed.success && closed.calls.size() == 1 && closed.calls[0].error == EBADF);
  assert(resource.state == ResourceState::unknown && resource.fd == -1);
  const int foreign = open("/dev/null", O_WRONLY | O_CLOEXEC);
  assert(foreign >= 0 && foreign == original_number);
  bool rejected = false;
  try { (void)close_resource(owner, resource); }
  catch (const std::runtime_error& error) { rejected = std::string(error.what()) == "resource_not_retained"; }
  assert(rejected);
  bool read_rejected = false;
  try { (void)read_file(owner, resource, 0, 1, "unknown-close-read"); }
  catch (const std::runtime_error& error) {
    read_rejected = std::string(error.what()) == "resource_not_retained"
        || std::string(error.what()) == "session_not_building";
  }
  assert(read_rejected);
  assert(owner.readbacks.empty());  // No fstat/pread entry or new readback record.
  auto final = close_session(owner);
  assert(!final.success);
  assert(fcntl(foreign, F_GETFD) >= 0);  // Session close did not retry/re-close the reused integer.
  for (const auto& call : final.calls) assert(call.resource != &resource);
  assert(close(foreign) == 0);

  Session retained_owner;
  assert(open_parents(retained_owner, argv[1], argv[2]).success);
  auto retained_directory = create_directory(retained_owner, *retained_owner.stage_parent, "retained-reuse-tree");
  assert(retained_directory.success);
  auto retained_file = create_file(retained_owner, *retained_directory.resource, "original");
  assert(retained_file.success);
  assert(sync_resource(retained_owner, *retained_file.resource).success);
  const int retained_number = retained_file.resource->fd;
  assert(close(retained_number) == 0);
  const int replacement = open("/dev/null", O_RDONLY | O_CLOEXEC);
  assert(replacement == retained_number);
  auto readback = read_file(retained_owner, *retained_file.resource, 0, 1, "retained-reused-read");
  assert(!readback.success && readback.readback);
  assert(std::string(readback.readback->blocker_code) == "readback_original_node_mismatch");
  assert(readback.readback->calls.size() == 1);
  assert(std::string(readback.readback->calls[0].name) == "fstat");
  assert(readback.readback->calls[0].returned == 0 && readback.readback->calls[0].error == 0);
  assert(retained_file.resource->fd == -1 && retained_file.resource->state == ResourceState::unknown);
  assert(!close_session(retained_owner).success);
  assert(fcntl(replacement, F_GETFD) >= 0);
  assert(close(replacement) == 0);
  std::puts("{\"test\":\"real-close-EBADF-then-FD-reuse\",\"unknownTombstoned\":true,\"retryRejected\":true,\"readbackRejectedBeforeFstatPread\":true,\"retainedReusedFDOriginalNodeMismatchBeforePread\":true,\"foreignDescriptorStillOpen\":true,\"explicitCloseSuccess\":false}");
}

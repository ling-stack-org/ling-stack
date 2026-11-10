#pragma once

#include <cstdint>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace office_local {

enum class ResourceState { not_acquired, retained, closed, unknown };
enum class Phase { building, blocked, published, cancelled, closed };

// These are historical syscall facts, not Core receipts or sandbox attestations.
struct Identity {
  uint64_t device = 0;
  uint64_t inode = 0;
  int64_t size_bytes = 0;
  int64_t modified_seconds = 0;
  int64_t changed_seconds = 0;
  int32_t modified_nanos = 0;
  int32_t changed_nanos = 0;
  uint32_t mode = 0;
  bool is_file = false;
  bool is_directory = false;
};

struct Resource;
struct Call {
  const char* name;
  const Resource* resource;
  int64_t returned;
  int error;
  bool has_returned = false;
  uint64_t called_monotonic_ns = 0;
  uint64_t returned_monotonic_ns = 0;
  bool has_io = false;
  uint64_t requested_bytes = 0;
  uint64_t offset = 0;
  const char* entry_name = nullptr;
  bool has_identity = false;
  Identity identity {};
};

struct Resource {
  std::string id;
  std::string kind;
  std::string basename;
  std::string parent_id;
  int fd = -1;  // Never exported to JavaScript or reconstituted from an integer.
  ResourceState state = ResourceState::not_acquired;
  uint64_t device = 0;
  uint64_t inode = 0;
  uint64_t bytes_written = 0;
  bool observed = false;
  bool synced = false;
  Identity initial_identity;
  Identity current_identity;
  uint64_t initial_observed_monotonic_ns = 0;
  uint64_t observed_monotonic_ns = 0;
};

// Kept by the native session before fstat/pread entry, including failed/partial
// reads. N-API marshalling failure cannot erase these original physical facts.
// Payload bytes themselves are not cached or reissued as an execution result.
struct Readback {
  std::string operation_id;
  Resource* resource = nullptr;
  uint64_t expected_bytes = 0;
  uint64_t budget_bytes = 0;
  uint64_t bytes_read = 0;
  uint64_t maximum_syscall_attempts = 0;
  uint64_t syscall_attempts = 0;
  bool before_observed = false;
  bool after_observed = false;
  bool eof_observed = false;
  bool identities_match = false;
  bool success = false;
  const char* native_outcome = "not_entered";
  const char* blocker_code = nullptr;
  Identity before;
  Identity after;
  std::vector<Call> calls;
};

struct InstalledEntry {
  Resource* original = nullptr;
  Resource* original_parent = nullptr;
  uint64_t expected_bytes = 0;
};

// Bound BEFORE the original single install syscall, including failed/unknown
// installation facts. Names/entry roster cannot be replaced by an observer.
struct Installation {
  Resource* tree = nullptr;
  Resource* source_parent = nullptr;
  Resource* destination_parent = nullptr;
  std::string destination_name;
  std::vector<InstalledEntry> entries;
  bool entered = false;
  bool has_returned = false;
  int64_t returned = -2;
  int error = 0;
  uint64_t called_monotonic_ns = 0;
  uint64_t returned_monotonic_ns = 0;
};

struct PublicationEntry {
  Resource* original = nullptr;
  Resource* observed = nullptr;
  std::shared_ptr<Readback> readback;
};

// Session-owned history, not payload cache, creator/cleanup authority or a Core
// receipt. Even reply/trace assembly failure cannot reopen the once claim.
struct Publication {
  std::string operation_id;
  uint64_t expected_bytes = 0;
  uint64_t budget_bytes = 0;
  uint64_t maximum_calls = 0;
  bool success = false;
  const char* native_outcome = "not_entered";
  const char* blocker_code = nullptr;
  std::vector<PublicationEntry> entries;
  std::vector<Call> calls;
};

struct Result {
  bool success = false;
  std::vector<Call> calls;
  Resource* resource = nullptr;
  std::shared_ptr<Readback> readback;
  std::shared_ptr<Publication> publication;
  std::vector<uint8_t> bytes;
  std::vector<std::vector<uint8_t>> publication_bytes;
  const char* blocker_code = nullptr;
  uint64_t maximum_syscall_attempts = 0;
  uint64_t syscall_attempts = 0;
};

// A session has no authorization, effect admission, or protection authority.
// The Host must bind it to a real protected staging scope before product use.
struct Session {
  std::string nonce;
  Phase phase = Phase::building;
  std::vector<std::unique_ptr<Resource>> resources;
  std::set<std::string> operations;
  std::vector<std::shared_ptr<Readback>> readbacks;
  std::shared_ptr<Installation> installation;
  std::shared_ptr<Publication> publication;
  Resource* stage_parent = nullptr;
  Resource* destination_parent = nullptr;
  Resource* tree = nullptr;
  bool installation_entered = false;
  bool residual_creation = false;
  bool ever_failed = false;
  bool publication_observation_claimed = false;
  bool cancel_requested = false;
  uint64_t next_resource = 0;

  Session();
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;
  void consume(const std::string& operation);
};

bool valid_component(const std::string& name);
bool valid_absolute_path(const std::string& path);
std::string state_name(ResourceState state);
std::string phase_name(Phase phase);
Result open_parents(Session& session, const std::string& stage, const std::string& destination);
Result create_directory(Session& session, Resource& parent, const std::string& name);
Result create_file(Session& session, Resource& parent, const std::string& name);
Result write_file(Session& session, Resource& file, const uint8_t* bytes, size_t size);
Result read_file(Session& session, Resource& file, uint64_t expected_bytes,
    uint64_t budget_bytes, const std::string& operation);
Result sync_resource(Session& session, Resource& resource);
Result observe_resource(Session& session, Resource& resource);
Result install_tree(Session& session, Resource& tree, const std::string& name);
Result observe_publication(Session& session, Resource& tree, uint64_t budget_bytes,
    const std::string& operation);
Result close_resource(Session& session, Resource& resource);
Result close_session(Session& session);

}  // namespace office_local

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <chrono>
#include <csignal>
#include <condition_variable>
#include <iostream>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#if defined(__APPLE__)

#include <cerrno>
#include <climits>
#include <dirent.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#elif defined(_WIN32)

#if !defined(_WIN32_WINNT)
#define _WIN32_WINNT 0x0A00
#elif _WIN32_WINNT < 0x0A00
#error "The Cua Driver package publisher requires Windows 10 or newer."
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <accctrl.h>
#include <aclapi.h>
#include <sddl.h>
#include <winternl.h>

#include <cwchar>
#else
#error "The Cua Driver package publisher supports only macOS and Windows."
#endif

namespace {

constexpr int kExitCommitted = 0;
constexpr int kExitNotCommitted = 20;
constexpr int kExitAmbiguous = 21;
constexpr int kExitInvalidInput = 22;
constexpr std::uint64_t kMaxRemovalEntries = 64;
constexpr std::uint64_t kMaxRemovalBytes = 558891008;
constexpr std::uint64_t kMaxArtifactRemovalEntries = 100000;
constexpr std::uint64_t kMaxArtifactRemovalBytes =
    4ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr std::uint64_t kMaxParentLockTimeoutMs = 300000;
constexpr std::size_t kMaxParentLockProtocolLineBytes = 16 * 1024;
#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS) && \
    defined(LING_CUA_DRIVER_PACKAGE_STAGING_TEST_WATCHDOG_MS)
constexpr std::uint64_t kParentLockOperationTimeoutMs =
    LING_CUA_DRIVER_PACKAGE_STAGING_TEST_WATCHDOG_MS;
#else
constexpr std::uint64_t kParentLockOperationTimeoutMs = 30000;
#endif

struct PublishResult {
  PublishResult(const char* outcome_value, const char* reason_value,
                std::uint64_t native_code_value, int exit_code_value,
                std::string parent_identity_value = {},
                std::string source_identity_value = {})
      : outcome(outcome_value),
        reason(reason_value),
        native_code(native_code_value),
        exit_code(exit_code_value),
        parent_identity(std::move(parent_identity_value)),
        source_identity(std::move(source_identity_value)) {}

  const char* outcome;
  const char* reason;
  std::uint64_t native_code;
  int exit_code;
  std::string parent_identity;
  std::string source_identity;
  std::string directory_identity;
  std::string owner_identity;
  std::string security_profile;
  bool children_inherit_protection = false;
  bool has_security_receipt = false;
  std::uint64_t removed_entries = 0;
  std::uint64_t removed_bytes = 0;
  bool has_remove_receipt = false;
};

void EmitResultFields(const PublishResult& result) {
#if defined(__APPLE__)
  constexpr const char* kPlatform = "darwin";
#else
  constexpr const char* kPlatform = "win32";
#endif
  std::cout << "{\"schemaVersion\":1,\"outcome\":\"" << result.outcome
            << "\",\"platform\":\"" << kPlatform << "\",\"reason\":\""
            << result.reason << "\",\"nativeCode\":" << result.native_code
            << (result.parent_identity.empty() ? "" : ",\"parentIdentity\":\"")
            << result.parent_identity
            << (result.parent_identity.empty() ? "" : "\"")
            << (result.source_identity.empty() ? "" : ",\"sourceIdentity\":\"")
            << result.source_identity
            << (result.source_identity.empty() ? "" : "\"")
            << (result.directory_identity.empty()
                    ? ""
                    : ",\"directoryIdentity\":\"")
            << result.directory_identity
            << (result.directory_identity.empty() ? "" : "\"")
            << (result.owner_identity.empty() ? "" : ",\"ownerIdentity\":\"")
            << result.owner_identity
            << (result.owner_identity.empty() ? "" : "\"")
            << (result.security_profile.empty()
                    ? ""
                    : ",\"securityProfile\":\"")
            << result.security_profile
            << (result.security_profile.empty() ? "" : "\"")
            << (result.has_security_receipt
                    ? (result.children_inherit_protection
                           ? ",\"childrenInheritProtection\":true"
                           : ",\"childrenInheritProtection\":false")
                    : "")
            << (result.has_remove_receipt
                    ? ",\"removedEntries\":" +
                          std::to_string(result.removed_entries) +
                          ",\"removedBytes\":" +
                          std::to_string(result.removed_bytes)
                    : "");
}

int EmitResult(const PublishResult& result) {
  EmitResultFields(result);
  std::cout << "}\n";
  return result.exit_code;
}

std::uint64_t CurrentOperationOwnerPid() {
#if defined(__APPLE__)
  return static_cast<std::uint64_t>(getpid());
#else
  return static_cast<std::uint64_t>(GetCurrentProcessId());
#endif
}

bool EmitOperationResult(const PublishResult& result, std::uint64_t request_id,
                         const std::string& operation) {
  EmitResultFields(result);
  std::cout << ",\"requestId\":" << request_id << ",\"operation\":\""
            << operation << "\",\"operationOwnerPid\":"
            << CurrentOperationOwnerPid() << "}\n" << std::flush;
  return std::cout.good();
}

bool EmitParentLockReceipt(const char* outcome,
                           const std::string& parent_identity,
                           bool recovered_abandoned_lock) {
#if defined(__APPLE__)
  constexpr const char* kPlatform = "darwin";
#else
  constexpr const char* kPlatform = "win32";
#endif
  std::cout << "{\"schemaVersion\":1,\"outcome\":\"" << outcome
            << "\",\"platform\":\"" << kPlatform << "\",\"reason\":\""
            << outcome << "\",\"nativeCode\":0,\"parentIdentity\":\""
            << parent_identity
            << "\",\"lockScope\":\"parent\",\"recoveredAbandonedLock\":"
            << (recovered_abandoned_lock ? "true" : "false") << "}\n"
            << std::flush;
  return std::cout.good();
}

bool EmitParentLockReleaseReceipt(const std::string& parent_identity,
                                  bool recovered_abandoned_lock,
                                  std::uint64_t request_id) {
#if defined(__APPLE__)
  constexpr const char* kPlatform = "darwin";
#else
  constexpr const char* kPlatform = "win32";
#endif
  std::cout << "{\"schemaVersion\":1,\"outcome\":\"released\",\"platform\":\""
            << kPlatform
            << "\",\"reason\":\"released\",\"nativeCode\":0,\"parentIdentity\":\""
            << parent_identity
            << "\",\"lockScope\":\"parent\",\"recoveredAbandonedLock\":"
            << (recovered_abandoned_lock ? "true" : "false")
            << ",\"requestId\":" << request_id
            << ",\"operation\":\"release\",\"operationOwnerPid\":"
            << CurrentOperationOwnerPid() << "}\n" << std::flush;
  return std::cout.good();
}

PublishResult Committed() {
  return {"committed", "committed", 0, kExitCommitted, {}, {}};
}

PublishResult Removed(std::string parent_identity,
                      std::string source_identity,
                      std::uint64_t removed_entries,
                      std::uint64_t removed_bytes) {
  PublishResult result{"removed", "removed", 0, kExitCommitted,
                       std::move(parent_identity),
                       std::move(source_identity)};
  result.removed_entries = removed_entries;
  result.removed_bytes = removed_bytes;
  result.has_remove_receipt = true;
  return result;
}

PublishResult NotCommitted(const char* reason, std::uint64_t native_code) {
  return {"not_committed", reason, native_code, kExitNotCommitted, {}, {}};
}

PublishResult Ambiguous(const char* reason, std::uint64_t native_code) {
  return {"ambiguous", reason, native_code, kExitAmbiguous, {}, {}};
}

PublishResult InvalidInput() {
  return {"not_committed", "invalid_input", 0, kExitInvalidInput, {}, {}};
}

PublishResult Inspected(std::string parent_identity,
                        std::string source_identity) {
  return {"inspected", "inspected", 0, kExitCommitted,
          std::move(parent_identity), std::move(source_identity)};
}

PublishResult PrivateDirectorySuccess(const char* outcome,
                                      std::string parent_identity,
                                      std::string directory_identity,
                                      std::string owner_identity,
                                      const char* security_profile,
                                      bool children_inherit_protection) {
  PublishResult result{outcome, outcome, 0, kExitCommitted,
                       std::move(parent_identity), {}};
  result.directory_identity = std::move(directory_identity);
  result.owner_identity = std::move(owner_identity);
  result.security_profile = security_profile;
  result.children_inherit_protection = children_inherit_protection;
  result.has_security_receipt = true;
  return result;
}

enum class ProtocolLineStatus {
  kLine,
  kEof,
  kInvalid,
};

ProtocolLineStatus ReadBoundedProtocolLine(std::string* line) {
  line->clear();
  while (true) {
    const int value = std::cin.get();
    if (value == std::char_traits<char>::eof()) {
      if (std::cin.bad() || !line->empty()) {
        return ProtocolLineStatus::kInvalid;
      }
      return ProtocolLineStatus::kEof;
    }
    if (static_cast<char>(value) == '\n') {
      return ProtocolLineStatus::kLine;
    }
    if (line->size() >= kMaxParentLockProtocolLineBytes) {
      return ProtocolLineStatus::kInvalid;
    }
    line->push_back(static_cast<char>(value));
  }
}

std::vector<std::string> SplitProtocolFields(const std::string& line) {
  std::vector<std::string> fields;
  std::size_t start = 0;
  while (true) {
    const std::size_t end = line.find('\t', start);
    fields.push_back(line.substr(
        start, end == std::string::npos ? std::string::npos : end - start));
    if (end == std::string::npos) {
      return fields;
    }
    start = end + 1;
  }
}

bool ParseCanonicalUnsigned(const std::string& value, std::uint64_t maximum,
                            std::uint64_t* output) {
  if (value.empty() || (value.size() > 1 && value.front() == '0')) {
    return false;
  }
  std::uint64_t parsed = 0;
  for (const char character : value) {
    if (character < '0' || character > '9') {
      return false;
    }
    const std::uint64_t digit = static_cast<std::uint64_t>(character - '0');
    if (parsed > (maximum - digit) / 10) {
      return false;
    }
    parsed = parsed * 10 + digit;
  }
  *output = parsed;
  return true;
}

bool IsStrictUtf8(const std::string& value) {
  std::size_t index = 0;
  while (index < value.size()) {
    const unsigned char first = static_cast<unsigned char>(value[index]);
    std::uint32_t code_point = 0;
    std::size_t continuation_count = 0;
    if (first <= 0x7f) {
      code_point = first;
    } else if (first >= 0xc2 && first <= 0xdf) {
      code_point = first & 0x1f;
      continuation_count = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      code_point = first & 0x0f;
      continuation_count = 2;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code_point = first & 0x07;
      continuation_count = 3;
    } else {
      return false;
    }
    if (index + continuation_count >= value.size()) {
      return false;
    }
    for (std::size_t offset = 1; offset <= continuation_count; ++offset) {
      const unsigned char continuation =
          static_cast<unsigned char>(value[index + offset]);
      if ((continuation & 0xc0) != 0x80) {
        return false;
      }
      code_point = (code_point << 6) | (continuation & 0x3f);
    }
    if ((continuation_count == 2 && code_point < 0x800) ||
        (continuation_count == 3 && code_point < 0x10000) ||
        (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff) {
      return false;
    }
    index += continuation_count + 1;
  }
  return true;
}

bool DecodeStrictHexArgument(const std::string& encoded, std::string* decoded) {
  if (encoded.empty() || (encoded.size() % 2) != 0) {
    return false;
  }
  decoded->clear();
  decoded->reserve(encoded.size() / 2);
  for (std::size_t index = 0; index < encoded.size(); index += 2) {
    auto nibble = [](char value, unsigned char* output) {
      if (value >= '0' && value <= '9') {
        *output = static_cast<unsigned char>(value - '0');
        return true;
      }
      if (value >= 'a' && value <= 'f') {
        *output = static_cast<unsigned char>(value - 'a' + 10);
        return true;
      }
      return false;
    };
    unsigned char high = 0;
    unsigned char low = 0;
    if (!nibble(encoded[index], &high) ||
        !nibble(encoded[index + 1], &low)) {
      return false;
    }
    const char value = static_cast<char>((high << 4) | low);
    if (value == '\0') {
      return false;
    }
    decoded->push_back(value);
  }
  return IsStrictUtf8(*decoded);
}

class ScopedOperationWatchdog {
 public:
  ScopedOperationWatchdog() : worker_([this]() {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!condition_.wait_for(
            lock, std::chrono::milliseconds(kParentLockOperationTimeoutMs),
            [this]() { return completed_; })) {
      std::_Exit(kExitAmbiguous);
    }
  }) {}

  ~ScopedOperationWatchdog() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      completed_ = true;
    }
    condition_.notify_one();
    worker_.join();
  }

  ScopedOperationWatchdog(const ScopedOperationWatchdog&) = delete;
  ScopedOperationWatchdog& operator=(const ScopedOperationWatchdog&) = delete;

 private:
  std::mutex mutex_;
  std::condition_variable condition_;
  bool completed_ = false;
  std::thread worker_;
};

enum class ParentLockSessionOutcome {
  kReleased,
  kCallerClosed,
  kFailed,
};

struct ParentLockSessionResult {
  ParentLockSessionOutcome outcome = ParentLockSessionOutcome::kFailed;
  std::uint64_t release_request_id = 0;
};

bool ReadProtocolEof() {
  const int trailing = std::cin.get();
  return trailing == std::char_traits<char>::eof() && std::cin.eof() &&
         !std::cin.bad();
}

ParentLockSessionResult FailParentLockProtocol() {
  const PublishResult result =
      Ambiguous("parent_lock_protocol_invalid", 0);
  EmitResultFields(result);
  std::cout << "}\n" << std::flush;
  return {};
}

template <typename Dispatcher>
ParentLockSessionResult RunParentLockSession(Dispatcher dispatch) {
  std::uint64_t expected_request_id = 1;
  while (true) {
    std::string line;
    const ProtocolLineStatus line_status = ReadBoundedProtocolLine(&line);
    if (line_status == ProtocolLineStatus::kEof) {
      return {ParentLockSessionOutcome::kCallerClosed, 0};
    }
    if (line_status != ProtocolLineStatus::kLine) {
      return FailParentLockProtocol();
    }
    const std::vector<std::string> fields = SplitProtocolFields(line);
    if (fields.size() < 3 || fields[0] != "LCRPC1") {
      return FailParentLockProtocol();
    }

    std::uint64_t request_id = 0;
    if (!ParseCanonicalUnsigned(
            fields[2], std::numeric_limits<std::uint64_t>::max(),
            &request_id) ||
        request_id != expected_request_id) {
      return FailParentLockProtocol();
    }

    if (fields[1] == "release") {
      if (fields.size() != 3 || !ReadProtocolEof()) {
        return FailParentLockProtocol();
      }
      return {ParentLockSessionOutcome::kReleased, request_id};
    }
    if (fields[1] != "call" || fields.size() < 6 || fields[3].empty()) {
      return FailParentLockProtocol();
    }

    std::uint64_t argument_count = 0;
    if (!ParseCanonicalUnsigned(fields[4], 16, &argument_count) ||
        fields.size() != static_cast<std::size_t>(5 + argument_count)) {
      return FailParentLockProtocol();
    }
    std::vector<std::string> arguments;
    arguments.reserve(static_cast<std::size_t>(argument_count));
    for (std::size_t index = 5; index < fields.size(); ++index) {
      std::string decoded;
      if (!DecodeStrictHexArgument(fields[index], &decoded)) {
        return FailParentLockProtocol();
      }
      arguments.push_back(std::move(decoded));
    }

    bool valid_operation = false;
    PublishResult result = InvalidInput();
    {
      ScopedOperationWatchdog watchdog;
      result = dispatch(fields[3], arguments, &valid_operation);
    }
    if (!valid_operation) {
      return FailParentLockProtocol();
    }
    if (!EmitOperationResult(result, request_id, fields[3])) {
      return {ParentLockSessionOutcome::kCallerClosed, 0};
    }
    expected_request_id += 1;
  }
}

#if defined(__APPLE__)

class ScopedFileDescriptor {
 public:
  explicit ScopedFileDescriptor(int value = -1) : value_(value) {}
  ~ScopedFileDescriptor() {
    if (value_ >= 0) {
      close(value_);
    }
  }

  ScopedFileDescriptor(const ScopedFileDescriptor&) = delete;
  ScopedFileDescriptor& operator=(const ScopedFileDescriptor&) = delete;
  ScopedFileDescriptor(ScopedFileDescriptor&& other) noexcept : value_(other.value_) {
    other.value_ = -1;
  }
  ScopedFileDescriptor& operator=(ScopedFileDescriptor&& other) noexcept {
    if (this != &other) {
      if (value_ >= 0) {
        close(value_);
      }
      value_ = other.value_;
      other.value_ = -1;
    }
    return *this;
  }

  int get() const { return value_; }
  bool valid() const { return value_ >= 0; }

 private:
  int value_;
};

class ScopedDarwinFlock {
 public:
  explicit ScopedDarwinFlock(int file_descriptor)
      : file_descriptor_(file_descriptor) {}
  ~ScopedDarwinFlock() {
    if (owned_) {
      while (flock(file_descriptor_, LOCK_UN) != 0 && errno == EINTR) {
      }
    }
  }

  ScopedDarwinFlock(const ScopedDarwinFlock&) = delete;
  ScopedDarwinFlock& operator=(const ScopedDarwinFlock&) = delete;

  void MarkOwned() { owned_ = true; }

  bool Release(int* error_code) {
    if (!owned_) {
      *error_code = 0;
      return true;
    }
    int result = -1;
    do {
      result = flock(file_descriptor_, LOCK_UN);
    } while (result != 0 && errno == EINTR);
    if (result != 0) {
      *error_code = errno;
      return false;
    }
    owned_ = false;
    *error_code = 0;
    return true;
  }

 private:
  int file_descriptor_;
  bool owned_ = false;
};

struct FileIdentity {
  dev_t device;
  ino_t inode;
};

struct NamedEntry {
  bool exists = false;
  bool query_failed = false;
  int error_code = 0;
  FileIdentity identity{};
};

bool SameIdentity(const FileIdentity& left, const FileIdentity& right) {
  return left.device == right.device && left.inode == right.inode;
}

FileIdentity IdentityFromStat(const struct stat& metadata) {
  return {metadata.st_dev, metadata.st_ino};
}

std::string IdentityString(const FileIdentity& identity) {
  std::ostringstream stream;
  stream << std::hex << static_cast<std::uint64_t>(identity.device) << ":"
         << static_cast<std::uint64_t>(identity.inode);
  return stream.str();
}

NamedEntry QueryNamedEntry(int parent_fd, const std::string& name) {
  struct stat metadata {};
  if (fstatat(parent_fd, name.c_str(), &metadata, AT_SYMLINK_NOFOLLOW) == 0) {
    return {true, false, 0, IdentityFromStat(metadata)};
  }
  const int error_code = errno;
  if (error_code == ENOENT) {
    return {};
  }
  return {false, true, error_code, {}};
}

bool NamedEntryIsSymlink(int parent_fd, const std::string& name) {
  struct stat metadata {};
  return fstatat(parent_fd, name.c_str(), &metadata, AT_SYMLINK_NOFOLLOW) == 0 &&
         S_ISLNK(metadata.st_mode);
}

bool IsValidLeafName(const std::string& value) {
  if (value.empty() || value == "." || value == ".." || value.size() > 240) {
    return false;
  }
  return value.find('/') == std::string::npos &&
         value.find('\\') == std::string::npos &&
         value.find(':') == std::string::npos;
}

ScopedFileDescriptor OpenAbsoluteDirectoryNoLinks(const std::string& path,
                                                  int* error_code,
                                                  bool* reparse_forbidden) {
  *error_code = 0;
  *reparse_forbidden = false;
  if (path.empty() || path.front() != '/' ||
      (path.size() > 1 && path.back() == '/')) {
    *error_code = EINVAL;
    return ScopedFileDescriptor();
  }

  ScopedFileDescriptor current(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                             O_NOFOLLOW));
  if (!current.valid()) {
    *error_code = errno;
    return ScopedFileDescriptor();
  }

  std::size_t start = 1;
  while (start < path.size()) {
    const std::size_t end = path.find('/', start);
    const std::string component = path.substr(
        start, end == std::string::npos ? std::string::npos : end - start);
    if (component.empty() || component == "." || component == ".." ||
        component.size() > NAME_MAX) {
      *error_code = EINVAL;
      return ScopedFileDescriptor();
    }

    ScopedFileDescriptor next(openat(current.get(), component.c_str(),
                                     O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                         O_NOFOLLOW));
    if (!next.valid()) {
      *error_code = errno;
      struct stat metadata {};
      if (*error_code == ELOOP ||
          (fstatat(current.get(), component.c_str(), &metadata,
                   AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(metadata.st_mode))) {
        *reparse_forbidden = true;
      }
      return ScopedFileDescriptor();
    }
    current = std::move(next);
    if (end == std::string::npos) {
      break;
    }
    start = end + 1;
  }
  return current;
}

bool PrepareOperationParentOnDarwin(
    const std::string& parent_root, int held_parent_fd,
    ScopedFileDescriptor* owned_parent, int* parent_fd, int* error_code,
    bool* reparse_forbidden) {
  *error_code = 0;
  *reparse_forbidden = false;
  if (held_parent_fd >= 0) {
    struct stat metadata {};
    if (fstat(held_parent_fd, &metadata) != 0 ||
        !S_ISDIR(metadata.st_mode)) {
      *error_code = errno == 0 ? ENOTDIR : errno;
      return false;
    }
    *parent_fd = held_parent_fd;
    return true;
  }
  *owned_parent = OpenAbsoluteDirectoryNoLinks(
      parent_root, error_code, reparse_forbidden);
  if (!owned_parent->valid()) {
    return false;
  }
  *parent_fd = owned_parent->get();
  return true;
}

bool NamedParentMatchesHeldOnDarwin(
    const std::string& parent_root, const FileIdentity& held_identity,
    const char** reason, int* error_code) {
  int named_parent_error = 0;
  bool named_parent_reparse = false;
  ScopedFileDescriptor named_parent = OpenAbsoluteDirectoryNoLinks(
      parent_root, &named_parent_error, &named_parent_reparse);
  if (!named_parent.valid()) {
    *reason = named_parent_reparse ? "parent_reparse_forbidden"
                                  : "parent_invalid";
    *error_code = named_parent_error;
    return false;
  }
  struct stat named_parent_metadata {};
  if (fstat(named_parent.get(), &named_parent_metadata) != 0) {
    *reason = "parent_invalid";
    *error_code = errno;
    return false;
  }
  if (!S_ISDIR(named_parent_metadata.st_mode)) {
    *reason = "parent_invalid";
    *error_code = ENOTDIR;
    return false;
  }
  if (!SameIdentity(IdentityFromStat(named_parent_metadata), held_identity)) {
    *reason = "parent_identity_mismatch";
    *error_code = 0;
    return false;
  }
  *reason = "matched";
  *error_code = 0;
  return true;
}

bool AcquireParentLockOnDarwin(int file_descriptor,
                               std::uint64_t timeout_ms,
                               const char** reason,
                               int* error_code) {
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(timeout_ms);
  while (true) {
    if (flock(file_descriptor, LOCK_EX | LOCK_NB) == 0) {
      *reason = "locked";
      *error_code = 0;
      return true;
    }
    const int lock_error = errno;
    if (lock_error != EWOULDBLOCK && lock_error != EAGAIN &&
        lock_error != EINTR) {
      *reason = "parent_lock_acquire_failed";
      *error_code = lock_error;
      return false;
    }
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      *reason = "parent_lock_timeout";
      *error_code = ETIMEDOUT;
      return false;
    }
    const auto remaining = std::chrono::duration_cast<
        std::chrono::milliseconds>(deadline - now);
    std::this_thread::sleep_for(
        std::min(std::chrono::milliseconds(10), remaining));
  }
}

PublishResult DispatchParentLockOperationOnDarwin(
    const std::string& operation, const std::vector<std::string>& arguments,
    const std::string& parent_root, int held_parent_fd,
    bool* valid_operation);

int HoldParentLockOnDarwin(const std::string& parent_root,
                           std::uint64_t timeout_ms) {
  std::signal(SIGPIPE, SIG_IGN);
  if (parent_root.empty() || parent_root.front() != '/') {
    return EmitResult(InvalidInput());
  }
  int parent_error = 0;
  bool parent_reparse = false;
  ScopedFileDescriptor parent = OpenAbsoluteDirectoryNoLinks(
      parent_root, &parent_error, &parent_reparse);
  if (!parent.valid()) {
    return EmitResult(NotCommitted(
        parent_reparse ? "parent_reparse_forbidden" : "parent_invalid",
        static_cast<std::uint64_t>(parent_error)));
  }
  struct stat parent_metadata {};
  if (fstat(parent.get(), &parent_metadata) != 0 ||
      !S_ISDIR(parent_metadata.st_mode)) {
    return EmitResult(NotCommitted(
        "parent_invalid", static_cast<std::uint64_t>(errno)));
  }
  const FileIdentity parent_identity_value =
      IdentityFromStat(parent_metadata);
  const std::string parent_identity =
      IdentityString(parent_identity_value);

  const char* acquire_reason = "parent_lock_acquire_failed";
  int acquire_error = 0;
  if (!AcquireParentLockOnDarwin(
          parent.get(), timeout_ms, &acquire_reason, &acquire_error)) {
    return EmitResult(NotCommitted(
        acquire_reason, static_cast<std::uint64_t>(acquire_error)));
  }
  ScopedDarwinFlock held_lock(parent.get());
  held_lock.MarkOwned();

  int named_parent_error = 0;
  bool named_parent_reparse = false;
  ScopedFileDescriptor named_parent = OpenAbsoluteDirectoryNoLinks(
      parent_root, &named_parent_error, &named_parent_reparse);
  struct stat named_parent_metadata {};
  if (!named_parent.valid() ||
      fstat(named_parent.get(), &named_parent_metadata) != 0 ||
      !S_ISDIR(named_parent_metadata.st_mode) ||
      !SameIdentity(IdentityFromStat(named_parent_metadata),
                    parent_identity_value)) {
    return EmitResult(NotCommitted(
        named_parent_reparse ? "parent_reparse_forbidden"
                             : "parent_identity_mismatch",
        static_cast<std::uint64_t>(named_parent_error)));
  }
  if (!EmitParentLockReceipt("locked", parent_identity, false)) {
    return kExitAmbiguous;
  }
  const ParentLockSessionResult session = RunParentLockSession(
      [&](const std::string& operation,
          const std::vector<std::string>& arguments, bool* valid_operation) {
        return DispatchParentLockOperationOnDarwin(
            operation, arguments, parent_root, parent.get(), valid_operation);
      });
  int release_error = 0;
  if (!held_lock.Release(&release_error)) {
    return EmitResult(Ambiguous(
        "parent_lock_release_failed",
        static_cast<std::uint64_t>(release_error)));
  }
  if (session.outcome == ParentLockSessionOutcome::kFailed) {
    return kExitAmbiguous;
  }
  if (session.outcome == ParentLockSessionOutcome::kCallerClosed) {
    return kExitCommitted;
  }
  return EmitParentLockReleaseReceipt(
             parent_identity, false, session.release_request_id)
             ? kExitCommitted : kExitAmbiguous;
}

PublishResult InspectOnDarwin(const std::string& parent_root,
                              const std::string& source_name,
                              int held_parent_fd = -1) {
  if (parent_root.empty() || parent_root.front() != '/' ||
      !IsValidLeafName(source_name)) {
    return InvalidInput();
  }
  int parent_error = 0;
  bool parent_reparse = false;
  ScopedFileDescriptor owned_parent;
  int parent_fd = -1;
  if (!PrepareOperationParentOnDarwin(
          parent_root, held_parent_fd, &owned_parent, &parent_fd,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  struct stat parent_metadata {};
  if (fstat(parent_fd, &parent_metadata) != 0 ||
      !S_ISDIR(parent_metadata.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  ScopedFileDescriptor source(openat(parent_fd, source_name.c_str(),
                                     O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!source.valid()) {
    const int error_code = errno;
    return NotCommitted(error_code == ELOOP ||
                                NamedEntryIsSymlink(parent_fd, source_name)
                            ? "source_reparse_forbidden"
                            : error_code == ENOENT ? "source_missing"
                                                  : "source_invalid",
                        static_cast<std::uint64_t>(error_code));
  }
  struct stat metadata {};
  if (fstat(source.get(), &metadata) != 0 || !S_ISDIR(metadata.st_mode)) {
    return NotCommitted("source_invalid", static_cast<std::uint64_t>(errno));
  }
  return Inspected(IdentityString(IdentityFromStat(parent_metadata)),
                   IdentityString(IdentityFromStat(metadata)));
}

bool VerifyPrivateDirectoryMetadataOnDarwin(
    int directory_fd, struct stat* metadata, int* error_code) {
  if (fstat(directory_fd, metadata) != 0) {
    *error_code = errno;
    return false;
  }
  if (!S_ISDIR(metadata->st_mode)) {
    *error_code = ENOTDIR;
    return false;
  }
  if (metadata->st_uid != geteuid()) {
    *error_code = EPERM;
    return false;
  }
  if ((metadata->st_mode & 07777) != 0700) {
    *error_code = EACCES;
    return false;
  }
  *error_code = 0;
  return true;
}

PublishResult PrivateDirectoryOnDarwin(
    const std::string& parent_root, const std::string& directory_name,
    bool apply_security, const std::string& expected_parent_identity,
    const std::string& expected_directory_identity,
    int held_parent_fd = -1) {
  if (parent_root.empty() || parent_root.front() != '/' ||
      !IsValidLeafName(directory_name)) {
    return InvalidInput();
  }

  int parent_error = 0;
  bool parent_reparse = false;
  ScopedFileDescriptor owned_parent;
  int parent_fd = -1;
  if (!PrepareOperationParentOnDarwin(
          parent_root, held_parent_fd, &owned_parent, &parent_fd,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  struct stat parent_metadata {};
  if (fstat(parent_fd, &parent_metadata) != 0 ||
      !S_ISDIR(parent_metadata.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  const FileIdentity parent_identity_value =
      IdentityFromStat(parent_metadata);
  const std::string parent_identity =
      IdentityString(parent_identity_value);
  if (!expected_parent_identity.empty() &&
      parent_identity != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }

  ScopedFileDescriptor directory(openat(
      parent_fd, directory_name.c_str(),
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!directory.valid()) {
    const int error_code = errno;
    return NotCommitted(error_code == ELOOP ||
                                NamedEntryIsSymlink(parent_fd, directory_name)
                            ? "directory_reparse_forbidden"
                            : error_code == ENOENT ? "directory_missing"
                                                  : "directory_invalid",
                        static_cast<std::uint64_t>(error_code));
  }

  struct stat before {};
  if (fstat(directory.get(), &before) != 0 || !S_ISDIR(before.st_mode)) {
    return NotCommitted("directory_invalid",
                        static_cast<std::uint64_t>(errno));
  }
  const FileIdentity directory_identity_value = IdentityFromStat(before);
  const std::string directory_identity =
      IdentityString(directory_identity_value);
  if (!expected_directory_identity.empty() &&
      directory_identity != expected_directory_identity) {
    return NotCommitted("directory_identity_mismatch", 0);
  }
  if (before.st_uid != geteuid()) {
    return NotCommitted("directory_owner_mismatch", 0);
  }

  if (apply_security && fchmod(directory.get(), 0700) != 0) {
    return NotCommitted("directory_security_set_failed",
                        static_cast<std::uint64_t>(errno));
  }
  struct stat verified {};
  int verify_error = 0;
  if (!VerifyPrivateDirectoryMetadataOnDarwin(
          directory.get(), &verified, &verify_error)) {
    return NotCommitted("directory_security_invalid",
                        static_cast<std::uint64_t>(verify_error));
  }
  if (!SameIdentity(IdentityFromStat(verified), IdentityFromStat(before))) {
    return NotCommitted("directory_identity_mismatch", 0);
  }
  struct stat verified_parent {};
  if (fstat(parent_fd, &verified_parent) != 0 ||
      !S_ISDIR(verified_parent.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  if (!SameIdentity(IdentityFromStat(verified_parent), parent_identity_value) ||
      (!expected_parent_identity.empty() &&
       IdentityString(IdentityFromStat(verified_parent)) !=
           expected_parent_identity)) {
    return NotCommitted("parent_identity_mismatch", 0);
  }
  int named_parent_error = 0;
  bool named_parent_reparse = false;
  ScopedFileDescriptor named_parent = OpenAbsoluteDirectoryNoLinks(
      parent_root, &named_parent_error, &named_parent_reparse);
  if (!named_parent.valid()) {
    return NotCommitted(named_parent_reparse ? "parent_reparse_forbidden"
                                             : "parent_invalid",
                        static_cast<std::uint64_t>(named_parent_error));
  }
  struct stat named_parent_metadata {};
  if (fstat(named_parent.get(), &named_parent_metadata) != 0 ||
      !S_ISDIR(named_parent_metadata.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  if (!SameIdentity(IdentityFromStat(named_parent_metadata),
                    parent_identity_value)) {
    return NotCommitted("parent_identity_mismatch", 0);
  }
  const NamedEntry named_after = QueryNamedEntry(parent_fd, directory_name);
  if (named_after.query_failed) {
    return NotCommitted("directory_identity_unavailable",
                        static_cast<std::uint64_t>(named_after.error_code));
  }
  if (!named_after.exists ||
      !SameIdentity(named_after.identity, directory_identity_value)) {
    return NotCommitted("directory_identity_mismatch", 0);
  }

  return PrivateDirectorySuccess(
      apply_security ? "secured" : "verified", parent_identity,
      directory_identity,
      "euid:" + std::to_string(static_cast<std::uint64_t>(geteuid())),
      "current-euid-mode-0700", false);
}

bool DirectoryIsEmptyOnDarwin(int directory_fd, bool* empty,
                              int* error_code) {
  const int duplicate_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate_fd < 0) {
    *error_code = errno;
    return false;
  }
  DIR* directory = fdopendir(duplicate_fd);
  if (directory == nullptr) {
    *error_code = errno;
    close(duplicate_fd);
    return false;
  }

  bool success = true;
  *empty = true;
  while (true) {
    errno = 0;
    dirent* entry = readdir(directory);
    if (entry == nullptr) {
      if (errno != 0) {
        *error_code = errno;
        success = false;
      }
      break;
    }
    const std::string name(entry->d_name);
    if (name != "." && name != "..") {
      *empty = false;
      break;
    }
  }
  const int close_result = closedir(directory);
  if (success && close_result != 0) {
    *error_code = errno;
    return false;
  }
  if (success) {
    *error_code = 0;
  }
  return success;
}

PublishResult RemoveUnsecuredEmptyOnDarwin(
    const std::string& parent_root, const std::string& source_name,
    const std::string& expected_parent_identity,
    const std::string& expected_source_identity,
    int held_parent_fd = -1) {
  if (parent_root.empty() || parent_root.front() != '/' ||
      !IsValidLeafName(source_name) || expected_parent_identity.empty() ||
      expected_source_identity.empty()) {
    return InvalidInput();
  }

  int parent_error = 0;
  bool parent_reparse = false;
  ScopedFileDescriptor owned_parent;
  int parent_fd = -1;
  if (!PrepareOperationParentOnDarwin(
          parent_root, held_parent_fd, &owned_parent, &parent_fd,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  struct stat parent_metadata {};
  if (fstat(parent_fd, &parent_metadata) != 0 ||
      !S_ISDIR(parent_metadata.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  const FileIdentity parent_identity_value =
      IdentityFromStat(parent_metadata);
  const std::string parent_identity =
      IdentityString(parent_identity_value);
  if (parent_identity != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }

  ScopedFileDescriptor source(openat(
      parent_fd, source_name.c_str(),
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!source.valid()) {
    const int open_error = errno;
    return NotCommitted(open_error == ELOOP ||
                                NamedEntryIsSymlink(parent_fd, source_name)
                            ? "source_reparse_forbidden"
                            : open_error == ENOENT ? "source_missing"
                                                  : "source_invalid",
                        static_cast<std::uint64_t>(open_error));
  }
  struct stat source_metadata {};
  if (fstat(source.get(), &source_metadata) != 0 ||
      !S_ISDIR(source_metadata.st_mode)) {
    return NotCommitted("source_invalid", static_cast<std::uint64_t>(errno));
  }
  const FileIdentity source_identity_value =
      IdentityFromStat(source_metadata);
  const std::string source_identity = IdentityString(source_identity_value);
  if (source_identity != expected_source_identity) {
    return NotCommitted("source_identity_mismatch", 0);
  }
  if (source_metadata.st_uid != geteuid()) {
    return NotCommitted("directory_owner_mismatch", 0);
  }

  bool empty = false;
  int empty_error = 0;
  if (!DirectoryIsEmptyOnDarwin(source.get(), &empty, &empty_error)) {
    return NotCommitted("tree_enumeration_failed",
                        static_cast<std::uint64_t>(empty_error));
  }
  if (!empty) {
    return NotCommitted("directory_not_empty",
                        static_cast<std::uint64_t>(ENOTEMPTY));
  }

  struct stat verified_parent {};
  struct stat verified_source {};
  if (fstat(parent_fd, &verified_parent) != 0 ||
      !S_ISDIR(verified_parent.st_mode) ||
      !SameIdentity(IdentityFromStat(verified_parent), parent_identity_value)) {
    return NotCommitted("parent_identity_mismatch",
                        static_cast<std::uint64_t>(errno));
  }
  if (fstat(source.get(), &verified_source) != 0 ||
      !S_ISDIR(verified_source.st_mode) ||
      !SameIdentity(IdentityFromStat(verified_source), source_identity_value)) {
    return NotCommitted("source_identity_mismatch",
                        static_cast<std::uint64_t>(errno));
  }
  if (verified_source.st_uid != geteuid()) {
    return NotCommitted("directory_owner_mismatch", 0);
  }
  int named_parent_error = 0;
  bool named_parent_reparse = false;
  ScopedFileDescriptor named_parent = OpenAbsoluteDirectoryNoLinks(
      parent_root, &named_parent_error, &named_parent_reparse);
  if (!named_parent.valid()) {
    return NotCommitted(named_parent_reparse ? "parent_reparse_forbidden"
                                             : "parent_invalid",
                        static_cast<std::uint64_t>(named_parent_error));
  }
  struct stat named_parent_metadata {};
  if (fstat(named_parent.get(), &named_parent_metadata) != 0 ||
      !S_ISDIR(named_parent_metadata.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  if (!SameIdentity(IdentityFromStat(named_parent_metadata),
                    parent_identity_value)) {
    return NotCommitted("parent_identity_mismatch", 0);
  }
  const NamedEntry named_before = QueryNamedEntry(parent_fd, source_name);
  if (named_before.query_failed) {
    return NotCommitted("source_identity_unavailable",
                        static_cast<std::uint64_t>(named_before.error_code));
  }
  if (!named_before.exists ||
      !SameIdentity(named_before.identity, source_identity_value)) {
    return NotCommitted("source_identity_mismatch", 0);
  }

  if (unlinkat(parent_fd, source_name.c_str(), AT_REMOVEDIR) != 0) {
    const int delete_error = errno;
    return NotCommitted(delete_error == ENOTEMPTY || delete_error == EEXIST
                            ? "directory_not_empty"
                            : "delete_failed",
                        static_cast<std::uint64_t>(delete_error));
  }
  const NamedEntry named_after = QueryNamedEntry(parent_fd, source_name);
  if (named_after.query_failed) {
    return Ambiguous("post_delete_state_ambiguous",
                     static_cast<std::uint64_t>(named_after.error_code));
  }
  if (named_after.exists) {
    return Ambiguous("source_name_changed_after_delete", 0);
  }
  struct stat parent_after {};
  if (fstat(parent_fd, &parent_after) != 0 ||
      !S_ISDIR(parent_after.st_mode) ||
      !SameIdentity(IdentityFromStat(parent_after), parent_identity_value)) {
    return Ambiguous("parent_identity_mismatch",
                     static_cast<std::uint64_t>(errno));
  }
  int named_parent_after_error = 0;
  bool named_parent_after_reparse = false;
  ScopedFileDescriptor named_parent_after = OpenAbsoluteDirectoryNoLinks(
      parent_root, &named_parent_after_error, &named_parent_after_reparse);
  if (!named_parent_after.valid()) {
    return Ambiguous(named_parent_after_reparse ? "parent_reparse_forbidden"
                                               : "parent_identity_mismatch",
                     static_cast<std::uint64_t>(named_parent_after_error));
  }
  struct stat named_parent_after_metadata {};
  if (fstat(named_parent_after.get(), &named_parent_after_metadata) != 0 ||
      !S_ISDIR(named_parent_after_metadata.st_mode) ||
      !SameIdentity(IdentityFromStat(named_parent_after_metadata),
                    parent_identity_value)) {
    return Ambiguous("parent_identity_mismatch",
                     static_cast<std::uint64_t>(errno));
  }
  return Removed(parent_identity, source_identity, 0, 0);
}

enum class RemovalEntryKindDarwin {
  kDirectory,
  kRegularFile,
  kSymbolicLink,
};

struct RemovalEntryDarwin {
  std::vector<std::string> components;
  FileIdentity identity;
  off_t size;
  RemovalEntryKindDarwin kind;
};

bool CollectRemovalPlanDarwin(
    int directory_fd, dev_t root_device, std::vector<std::string>* components,
    std::vector<RemovalEntryDarwin>* plan, std::uint64_t* entry_count,
    std::uint64_t* total_bytes, std::uint64_t maximum_entries,
    std::uint64_t maximum_bytes, bool allow_symbolic_links,
    const char** reason, int* error_code) {
  const int duplicate_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate_fd < 0) {
    *reason = "tree_enumeration_failed";
    *error_code = errno;
    return false;
  }
  DIR* directory = fdopendir(duplicate_fd);
  if (directory == nullptr) {
    *reason = "tree_enumeration_failed";
    *error_code = errno;
    close(duplicate_fd);
    return false;
  }

  bool success = true;
  while (success) {
    errno = 0;
    dirent* entry = readdir(directory);
    if (entry == nullptr) {
      if (errno != 0) {
        *reason = "tree_enumeration_failed";
        *error_code = errno;
        success = false;
      }
      break;
    }
    const std::string name(entry->d_name);
    if (name == "." || name == "..") {
      continue;
    }
    if (!IsValidLeafName(name)) {
      *reason = "tree_entry_invalid";
      *error_code = EINVAL;
      success = false;
      break;
    }

    struct stat metadata {};
    if (fstatat(directory_fd, name.c_str(), &metadata,
                AT_SYMLINK_NOFOLLOW) != 0) {
      *reason = "tree_changed_before_delete";
      *error_code = errno;
      success = false;
      break;
    }
    const bool symbolic_link = S_ISLNK(metadata.st_mode);
    if (symbolic_link && !allow_symbolic_links) {
      *reason = "tree_reparse_forbidden";
      *error_code = ELOOP;
      success = false;
      break;
    }
    if (metadata.st_dev != root_device) {
      *reason = "tree_mount_forbidden";
      *error_code = EXDEV;
      success = false;
      break;
    }
    *entry_count += 1;
    if (*entry_count > maximum_entries) {
      *reason = "tree_entry_limit_exceeded";
      *error_code = E2BIG;
      success = false;
      break;
    }

    components->push_back(name);
    if (symbolic_link) {
      plan->push_back({*components, IdentityFromStat(metadata), 0,
                       RemovalEntryKindDarwin::kSymbolicLink});
    } else if (S_ISDIR(metadata.st_mode)) {
      ScopedFileDescriptor child(openat(
          directory_fd, name.c_str(),
          O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
      const int open_error = child.valid() ? 0 : errno;
      struct stat opened {};
      const bool stat_failed = child.valid() && fstat(child.get(), &opened) != 0;
      const int stat_error = stat_failed ? errno : 0;
      if (!child.valid() || stat_failed || !S_ISDIR(opened.st_mode) ||
          !SameIdentity(IdentityFromStat(metadata), IdentityFromStat(opened))) {
        *reason = "tree_changed_before_delete";
        *error_code = !child.valid() ? open_error : stat_error;
        success = false;
      } else if (!CollectRemovalPlanDarwin(
                     child.get(), root_device, components, plan, entry_count,
                     total_bytes, maximum_entries, maximum_bytes,
                     allow_symbolic_links, reason, error_code)) {
        success = false;
      } else {
        plan->push_back({*components, IdentityFromStat(opened), 0,
                         RemovalEntryKindDarwin::kDirectory});
      }
    } else if (S_ISREG(metadata.st_mode) && metadata.st_nlink == 1 &&
               metadata.st_size >= 0) {
      const std::uint64_t size = static_cast<std::uint64_t>(metadata.st_size);
      if (size > maximum_bytes ||
          *total_bytes > maximum_bytes - size) {
        *reason = "tree_byte_limit_exceeded";
        *error_code = EFBIG;
        success = false;
      } else {
        *total_bytes += size;
        plan->push_back({*components, IdentityFromStat(metadata),
                         metadata.st_size,
                         RemovalEntryKindDarwin::kRegularFile});
      }
    } else {
      *reason = S_ISREG(metadata.st_mode) && metadata.st_nlink != 1
                    ? "tree_hardlink_forbidden"
                    : "tree_non_regular_entry";
      *error_code = EINVAL;
      success = false;
    }
    components->pop_back();
  }
  const int close_error = closedir(directory);
  if (success && close_error != 0) {
    *reason = "tree_enumeration_failed";
    *error_code = errno;
    return false;
  }
  return success;
}

ScopedFileDescriptor OpenRemovalParentDarwin(
    int root_fd, const std::vector<std::string>& components,
    const char** reason, int* error_code) {
  ScopedFileDescriptor current(fcntl(root_fd, F_DUPFD_CLOEXEC, 0));
  if (!current.valid()) {
    *reason = "tree_changed_during_delete";
    *error_code = errno;
    return ScopedFileDescriptor();
  }
  for (std::size_t index = 0; index + 1 < components.size(); ++index) {
    ScopedFileDescriptor next(openat(
        current.get(), components[index].c_str(),
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (!next.valid()) {
      *reason = "tree_changed_during_delete";
      *error_code = errno;
      return ScopedFileDescriptor();
    }
    current = std::move(next);
  }
  return current;
}

bool DeleteRemovalEntryDarwin(int root_fd, const RemovalEntryDarwin& entry,
                              const char** reason, int* error_code) {
  ScopedFileDescriptor parent = OpenRemovalParentDarwin(
      root_fd, entry.components, reason, error_code);
  if (!parent.valid()) {
    return false;
  }
  const std::string& name = entry.components.back();
  const bool directory = entry.kind == RemovalEntryKindDarwin::kDirectory;
  const bool regular_file =
      entry.kind == RemovalEntryKindDarwin::kRegularFile;
  const bool symbolic_link =
      entry.kind == RemovalEntryKindDarwin::kSymbolicLink;
  struct stat observed {};
  const bool stat_failed = fstatat(
      parent.get(), name.c_str(), &observed, AT_SYMLINK_NOFOLLOW) != 0;
  const int stat_error = stat_failed ? errno : 0;
  if (stat_failed ||
      !SameIdentity(IdentityFromStat(observed), entry.identity) ||
      (directory ? !S_ISDIR(observed.st_mode)
                 : regular_file ? !S_ISREG(observed.st_mode)
                                : !symbolic_link || !S_ISLNK(observed.st_mode)) ||
      (regular_file &&
       (observed.st_nlink != 1 || observed.st_size != entry.size))) {
    *reason = "tree_changed_during_delete";
    *error_code = stat_error;
    return false;
  }
  if (unlinkat(parent.get(), name.c_str(),
               directory ? AT_REMOVEDIR : 0) != 0) {
    *reason = "delete_failed";
    *error_code = errno;
    return false;
  }
  return true;
}

PublishResult RemoveTreeOnDarwin(
    const std::string& parent_root, const std::string& source_name,
    const std::string& expected_parent_identity,
    const std::string& expected_source_identity,
    std::uint64_t expected_entries, std::uint64_t expected_bytes,
    std::uint64_t maximum_entries, std::uint64_t maximum_bytes,
    bool allow_symbolic_links, int held_parent_fd = -1) {
  if (parent_root.empty() || parent_root.front() != '/' ||
      !IsValidLeafName(source_name) || expected_entries > maximum_entries ||
      expected_bytes > maximum_bytes) {
    return InvalidInput();
  }
  int parent_error = 0;
  bool parent_reparse = false;
  ScopedFileDescriptor owned_parent;
  int parent_fd = -1;
  if (!PrepareOperationParentOnDarwin(
          parent_root, held_parent_fd, &owned_parent, &parent_fd,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  struct stat parent_metadata {};
  if (fstat(parent_fd, &parent_metadata) != 0 ||
      !S_ISDIR(parent_metadata.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  const std::string parent_identity =
      IdentityString(IdentityFromStat(parent_metadata));
  if (parent_identity != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }

  ScopedFileDescriptor source(openat(
      parent_fd, source_name.c_str(),
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!source.valid()) {
    const int open_error = errno;
    return NotCommitted(open_error == ELOOP ||
                                NamedEntryIsSymlink(parent_fd, source_name)
                            ? "source_reparse_forbidden"
                            : open_error == ENOENT ? "source_missing"
                                                  : "source_invalid",
                        static_cast<std::uint64_t>(open_error));
  }
  struct stat source_metadata {};
  int security_error = 0;
  if (!VerifyPrivateDirectoryMetadataOnDarwin(
          source.get(), &source_metadata, &security_error)) {
    return NotCommitted("directory_security_invalid",
                        static_cast<std::uint64_t>(security_error));
  }
  const FileIdentity source_identity_value =
      IdentityFromStat(source_metadata);
  const std::string source_identity = IdentityString(source_identity_value);
  if (source_identity != expected_source_identity) {
    return NotCommitted("source_identity_mismatch", 0);
  }

  std::vector<RemovalEntryDarwin> plan;
  std::vector<std::string> components;
  std::uint64_t entries = 0;
  std::uint64_t bytes = 0;
  const char* reason = "tree_enumeration_failed";
  int error_code = 0;
  if (!CollectRemovalPlanDarwin(
          source.get(), source_metadata.st_dev, &components, &plan, &entries,
          &bytes, maximum_entries, maximum_bytes, allow_symbolic_links,
          &reason, &error_code)) {
    return NotCommitted(reason, static_cast<std::uint64_t>(error_code));
  }
  if (entries != expected_entries || bytes != expected_bytes) {
    return NotCommitted("tree_inventory_mismatch", 0);
  }

  std::uint64_t removed_entries = 0;
  for (const RemovalEntryDarwin& entry : plan) {
    if (!DeleteRemovalEntryDarwin(
            source.get(), entry, &reason, &error_code)) {
      return removed_entries == 0
                 ? NotCommitted(reason,
                                static_cast<std::uint64_t>(error_code))
                 : Ambiguous(reason,
                             static_cast<std::uint64_t>(error_code));
    }
    removed_entries += 1;
  }

  struct stat named_source {};
  if (fstatat(parent_fd, source_name.c_str(), &named_source,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameIdentity(IdentityFromStat(named_source), source_identity_value)) {
    return Ambiguous("source_name_changed_after_delete",
                     static_cast<std::uint64_t>(errno));
  }
  if (unlinkat(parent_fd, source_name.c_str(), AT_REMOVEDIR) != 0) {
    return Ambiguous("delete_failed", static_cast<std::uint64_t>(errno));
  }
  return Removed(parent_identity, source_identity, entries, bytes);
}

bool ParseBoundedUnsignedDarwin(const char* value, std::uint64_t maximum,
                                std::uint64_t* output) {
  if (value == nullptr || *value == '\0') {
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const unsigned long long parsed = std::strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed > maximum) {
    return false;
  }
  *output = static_cast<std::uint64_t>(parsed);
  return true;
}

#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
bool RunPostCommitTestGateOnDarwin(
    int parent_fd, const std::string& ready_name,
    const std::string& gate_name, const char** reason, int* error_code);
#endif

PublishResult PublishOnDarwin(const std::string& parent_root,
                              const std::string& source_name,
                              const std::string& destination_name,
                              const std::string& expected_parent_identity,
                              const std::string& expected_source_identity,
                              int held_parent_fd = -1
#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
                              , const std::string* post_commit_ready_name = nullptr,
                              const std::string* post_commit_gate_name = nullptr
#endif
                              ) {
  if (parent_root.empty() || parent_root.front() != '/' ||
      !IsValidLeafName(source_name) || !IsValidLeafName(destination_name) ||
      source_name == destination_name) {
    return InvalidInput();
  }

  int parent_error = 0;
  bool parent_reparse = false;
  ScopedFileDescriptor owned_parent;
  int parent_fd = -1;
  if (!PrepareOperationParentOnDarwin(
          parent_root, held_parent_fd, &owned_parent, &parent_fd,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  struct stat parent_metadata {};
  if (fstat(parent_fd, &parent_metadata) != 0 ||
      !S_ISDIR(parent_metadata.st_mode)) {
    return NotCommitted("parent_invalid", static_cast<std::uint64_t>(errno));
  }
  const FileIdentity parent_identity = IdentityFromStat(parent_metadata);
  if (IdentityString(parent_identity) != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }
  const char* named_parent_reason = "parent_identity_mismatch";
  int named_parent_error = 0;
  if (!NamedParentMatchesHeldOnDarwin(
          parent_root, parent_identity, &named_parent_reason,
          &named_parent_error)) {
    return NotCommitted(
        named_parent_reason,
        static_cast<std::uint64_t>(named_parent_error));
  }

  ScopedFileDescriptor source(openat(parent_fd, source_name.c_str(),
                                     O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (!source.valid()) {
    const int error_code = errno;
    if (error_code == ELOOP ||
        NamedEntryIsSymlink(parent_fd, source_name)) {
      return NotCommitted("source_reparse_forbidden",
                          static_cast<std::uint64_t>(error_code));
    }
    return NotCommitted(error_code == ENOENT ? "source_missing" : "source_invalid",
                        static_cast<std::uint64_t>(error_code));
  }
  struct stat source_metadata {};
  if (fstat(source.get(), &source_metadata) != 0 ||
      !S_ISDIR(source_metadata.st_mode)) {
    return NotCommitted("source_invalid", static_cast<std::uint64_t>(errno));
  }
  const FileIdentity source_identity = IdentityFromStat(source_metadata);
  if (IdentityString(source_identity) != expected_source_identity) {
    return NotCommitted("source_identity_mismatch", 0);
  }

  if (!NamedParentMatchesHeldOnDarwin(
          parent_root, parent_identity, &named_parent_reason,
          &named_parent_error)) {
    return NotCommitted(
        named_parent_reason,
        static_cast<std::uint64_t>(named_parent_error));
  }

  // This is the single commit syscall. RENAME_EXCL guarantees that an existing
  // destination of any kind is never replaced.
  const int commit_result = renameatx_np(parent_fd, source_name.c_str(), parent_fd,
                                         destination_name.c_str(), RENAME_EXCL);
  const int commit_error = commit_result == 0 ? 0 : errno;

#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
  if (post_commit_ready_name != nullptr && post_commit_gate_name != nullptr) {
    const char* test_gate_reason = "test_post_commit_gate_failed";
    int test_gate_error = 0;
    if (!RunPostCommitTestGateOnDarwin(
            parent_fd, *post_commit_ready_name, *post_commit_gate_name,
            &test_gate_reason, &test_gate_error)) {
      return Ambiguous(
          test_gate_reason,
          static_cast<std::uint64_t>(test_gate_error));
    }
  }
#endif

  const NamedEntry source_after = QueryNamedEntry(parent_fd, source_name);
  const NamedEntry destination_after = QueryNamedEntry(parent_fd, destination_name);
  const bool source_still_named = source_after.exists &&
                                  SameIdentity(source_after.identity, source_identity);
  const bool destination_names_source = destination_after.exists &&
                                        SameIdentity(destination_after.identity,
                                                     source_identity);

  if (!NamedParentMatchesHeldOnDarwin(
          parent_root, parent_identity, &named_parent_reason,
          &named_parent_error)) {
    return Ambiguous(
        named_parent_reason,
        static_cast<std::uint64_t>(named_parent_error));
  }

  if (!source_after.query_failed && !destination_after.query_failed &&
      destination_names_source && !source_after.exists) {
    return Committed();
  }
  if (commit_result == 0 || source_after.query_failed ||
      destination_after.query_failed || !source_still_named) {
    return Ambiguous("post_commit_state_ambiguous",
                     static_cast<std::uint64_t>(commit_error));
  }
  if (destination_after.exists) {
    return NotCommitted("destination_exists",
                        static_cast<std::uint64_t>(commit_error));
  }
  if (commit_error == ENOTSUP || commit_error == EOPNOTSUPP) {
    return NotCommitted("atomic_no_replace_unsupported",
                        static_cast<std::uint64_t>(commit_error));
  }
  return NotCommitted("native_rejected", static_cast<std::uint64_t>(commit_error));
}

#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
constexpr std::uint64_t kTestPublishGateTimeoutMs = 10000;

bool CreateTestMarkerOnDarwin(int parent_fd, const std::string& name,
                              int* error_code) {
  if (!IsValidLeafName(name)) {
    *error_code = EINVAL;
    return false;
  }
  ScopedFileDescriptor marker(openat(
      parent_fd, name.c_str(),
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
  if (!marker.valid()) {
    *error_code = errno;
    return false;
  }
  *error_code = 0;
  return true;
}

bool WaitForTestGateOnDarwin(int parent_fd, const std::string& name,
                             int* error_code) {
  if (!IsValidLeafName(name)) {
    *error_code = EINVAL;
    return false;
  }
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(kTestPublishGateTimeoutMs);
  while (true) {
    const NamedEntry gate = QueryNamedEntry(parent_fd, name);
    if (gate.query_failed) {
      *error_code = gate.error_code;
      return false;
    }
    if (gate.exists) {
      *error_code = 0;
      return true;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      *error_code = ETIMEDOUT;
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
}

bool RunPostCommitTestGateOnDarwin(
    int parent_fd, const std::string& ready_name,
    const std::string& gate_name, const char** reason, int* error_code) {
  if (!CreateTestMarkerOnDarwin(parent_fd, ready_name, error_code)) {
    *reason = "test_post_commit_ready_create_failed";
    return false;
  }
  if (!WaitForTestGateOnDarwin(parent_fd, gate_name, error_code)) {
    *reason = *error_code == ETIMEDOUT
                  ? "test_post_commit_gate_timeout"
                  : "test_post_commit_gate_wait_failed";
    return false;
  }
  *reason = "test_post_commit_gate_released";
  *error_code = 0;
  return true;
}
#endif

PublishResult DispatchParentLockOperationOnDarwin(
    const std::string& operation, const std::vector<std::string>& arguments,
    const std::string& parent_root, int held_parent_fd,
    bool* valid_operation) {
  *valid_operation = true;
  if (operation == "inspect" && arguments.size() == 1) {
    return InspectOnDarwin(parent_root, arguments[0], held_parent_fd);
  }
  if (operation == "secure-private" &&
      (arguments.size() == 1 || arguments.size() == 3)) {
    return PrivateDirectoryOnDarwin(
        parent_root, arguments[0], true,
        arguments.size() == 3 ? arguments[1] : "",
        arguments.size() == 3 ? arguments[2] : "", held_parent_fd);
  }
  if (operation == "verify-private" && arguments.size() == 3) {
    return PrivateDirectoryOnDarwin(
        parent_root, arguments[0], false, arguments[1], arguments[2],
        held_parent_fd);
  }
  if (operation == "publish" && arguments.size() == 4) {
    return PublishOnDarwin(
        parent_root, arguments[0], arguments[1], arguments[2], arguments[3],
        held_parent_fd);
  }
  if ((operation == "remove-tree" && arguments.size() == 5) ||
      (operation == "remove-artifact-tree" &&
       (arguments.size() == 5 || arguments.size() == 6))) {
    const bool artifact_removal = operation == "remove-artifact-tree";
    const std::uint64_t maximum_entries = artifact_removal
        ? kMaxArtifactRemovalEntries : kMaxRemovalEntries;
    const std::uint64_t maximum_bytes = artifact_removal
        ? kMaxArtifactRemovalBytes : kMaxRemovalBytes;
    std::uint64_t expected_entries = 0;
    std::uint64_t expected_bytes = 0;
    if (!ParseBoundedUnsignedDarwin(
            arguments[3].c_str(), maximum_entries, &expected_entries) ||
        !ParseBoundedUnsignedDarwin(
            arguments[4].c_str(), maximum_bytes, &expected_bytes) ||
        (arguments.size() == 6 &&
         arguments[5] != "darwin-artifact-symlinks")) {
      return InvalidInput();
    }
    return RemoveTreeOnDarwin(
        parent_root, arguments[0], arguments[1], arguments[2],
        expected_entries, expected_bytes, maximum_entries, maximum_bytes,
        arguments.size() == 6,
        held_parent_fd);
  }
  if (operation == "remove-unsecured-empty" && arguments.size() == 3) {
    return RemoveUnsecuredEmptyOnDarwin(
        parent_root, arguments[0], arguments[1], arguments[2],
        held_parent_fd);
  }
#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
  if (operation == "test-hold-publish" && arguments.size() == 7) {
    int marker_error = 0;
    if (!CreateTestMarkerOnDarwin(
            held_parent_fd, arguments[4], &marker_error)) {
      return NotCommitted(
          "test_ready_create_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    if (!WaitForTestGateOnDarwin(
            held_parent_fd, arguments[5], &marker_error)) {
      return NotCommitted(
          marker_error == ETIMEDOUT ? "test_gate_timeout"
                                    : "test_gate_wait_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    PublishResult result = PublishOnDarwin(
        parent_root, arguments[0], arguments[1], arguments[2], arguments[3],
        held_parent_fd);
    if (std::strcmp(result.outcome, "committed") == 0 &&
        !CreateTestMarkerOnDarwin(
            held_parent_fd, arguments[6], &marker_error)) {
      return Ambiguous(
          "test_completion_create_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    return result;
  }
  if (operation == "test-post-commit-hold-publish" &&
      arguments.size() == 7) {
    PublishResult result = PublishOnDarwin(
        parent_root, arguments[0], arguments[1], arguments[2], arguments[3],
        held_parent_fd, &arguments[4], &arguments[5]);
    int marker_error = 0;
    if (std::strcmp(result.outcome, "committed") == 0 &&
        !CreateTestMarkerOnDarwin(
            held_parent_fd, arguments[6], &marker_error)) {
      return Ambiguous(
          "test_completion_create_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    return result;
  }
#endif
  *valid_operation = false;
  return InvalidInput();
}

#elif defined(_WIN32)

class ScopedHandle {
 public:
  explicit ScopedHandle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~ScopedHandle() {
    if (valid()) {
      CloseHandle(value_);
    }
  }

  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : value_(other.value_) {
    other.value_ = INVALID_HANDLE_VALUE;
  }
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) {
      reset();
      value_ = other.value_;
      other.value_ = INVALID_HANDLE_VALUE;
    }
    return *this;
  }

  HANDLE get() const { return value_; }
  bool valid() const {
    return value_ != INVALID_HANDLE_VALUE && value_ != nullptr;
  }
  void reset(HANDLE next = INVALID_HANDLE_VALUE) {
    if (valid()) {
      CloseHandle(value_);
    }
    value_ = next;
  }

 private:
  HANDLE value_;
};

class ScopedMutexOwnership {
 public:
  explicit ScopedMutexOwnership(HANDLE mutex) : mutex_(mutex) {}
  ~ScopedMutexOwnership() {
    if (owned_) {
      ReleaseMutex(mutex_);
    }
  }

  ScopedMutexOwnership(const ScopedMutexOwnership&) = delete;
  ScopedMutexOwnership& operator=(const ScopedMutexOwnership&) = delete;

  void MarkOwned() { owned_ = true; }

  bool Release(DWORD* error_code) {
    if (!owned_) {
      *error_code = ERROR_SUCCESS;
      return true;
    }
    if (!ReleaseMutex(mutex_)) {
      *error_code = GetLastError();
      return false;
    }
    owned_ = false;
    *error_code = ERROR_SUCCESS;
    return true;
  }

 private:
  HANDLE mutex_;
  bool owned_ = false;
};

class ScopedLocalMemory {
 public:
  explicit ScopedLocalMemory(HLOCAL value = nullptr) : value_(value) {}
  ~ScopedLocalMemory() {
    if (value_ != nullptr) {
      LocalFree(value_);
    }
  }

  ScopedLocalMemory(const ScopedLocalMemory&) = delete;
  ScopedLocalMemory& operator=(const ScopedLocalMemory&) = delete;

  HLOCAL get() const { return value_; }

 private:
  HLOCAL value_;
};

class ScopedProcThreadAttributeList {
 public:
  ScopedProcThreadAttributeList() = default;
  ~ScopedProcThreadAttributeList() {
    if (value_ != nullptr) {
      DeleteProcThreadAttributeList(value_);
    }
  }

  ScopedProcThreadAttributeList(const ScopedProcThreadAttributeList&) = delete;
  ScopedProcThreadAttributeList& operator=(
      const ScopedProcThreadAttributeList&) = delete;

  bool Initialize(DWORD attribute_count, DWORD* error_code) {
    SIZE_T required_bytes = 0;
    const BOOL sizing_result = InitializeProcThreadAttributeList(
        nullptr, attribute_count, 0, &required_bytes);
    const DWORD sizing_error = GetLastError();
    if (sizing_result != FALSE || sizing_error != ERROR_INSUFFICIENT_BUFFER ||
        required_bytes == 0) {
      *error_code = sizing_result != FALSE || sizing_error == ERROR_SUCCESS
                        ? ERROR_INVALID_DATA
                        : sizing_error;
      return false;
    }
    storage_.resize(required_bytes);
    value_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data());
    if (!InitializeProcThreadAttributeList(
            value_, attribute_count, 0, &required_bytes)) {
      *error_code = GetLastError();
      value_ = nullptr;
      storage_.clear();
      return false;
    }
    *error_code = ERROR_SUCCESS;
    return true;
  }

  LPPROC_THREAD_ATTRIBUTE_LIST get() const { return value_; }

 private:
  std::vector<std::byte> storage_;
  LPPROC_THREAD_ATTRIBUTE_LIST value_ = nullptr;
};

struct FileIdentity {
  ULONGLONG volume_serial_number{};
  BYTE identifier[16]{};
};

struct NamedEntry {
  bool exists = false;
  bool query_failed = false;
  DWORD error_code = ERROR_SUCCESS;
  FileIdentity identity{};
};

bool SameIdentity(const FileIdentity& left, const FileIdentity& right) {
  return left.volume_serial_number == right.volume_serial_number &&
         std::memcmp(left.identifier, right.identifier, sizeof(left.identifier)) == 0;
}

std::string IdentityString(const FileIdentity& identity) {
  std::ostringstream stream;
  stream << std::hex << identity.volume_serial_number << ":";
  for (const BYTE value : identity.identifier) {
    stream.width(2);
    stream.fill('0');
    stream << static_cast<unsigned int>(value);
  }
  return stream.str();
}

bool ReadIdentity(HANDLE handle, FileIdentity* output) {
  FILE_ID_INFO info {};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info))) {
    return false;
  }
  output->volume_serial_number = info.VolumeSerialNumber;
  std::memcpy(output->identifier, info.FileId.Identifier, sizeof(output->identifier));
  return true;
}

bool IsDirectory(HANDLE handle) {
  FILE_STANDARD_INFO info {};
  return GetFileInformationByHandleEx(handle, FileStandardInfo, &info, sizeof(info)) &&
         info.Directory != FALSE;
}

bool ReadReparsePoint(HANDLE handle, bool* output) {
  FILE_ATTRIBUTE_TAG_INFO info {};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) {
    return false;
  }
  *output = (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  return true;
}

bool IsValidLeafName(const std::wstring& value) {
  if (value.empty() || value == L"." || value == L".." || value.size() > 240) {
    return false;
  }
  return value.find(L'/') == std::wstring::npos &&
         value.find(L'\\') == std::wstring::npos &&
         value.find(L':') == std::wstring::npos;
}

ScopedHandle OpenMetadataHandle(const std::wstring& path, DWORD access) {
  return ScopedHandle(CreateFileW(path.c_str(), access,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                  nullptr, OPEN_EXISTING,
                                  FILE_FLAG_BACKUP_SEMANTICS |
                                      FILE_FLAG_OPEN_REPARSE_POINT,
                                  nullptr));
}

using NtOpenFileFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK,
                                            POBJECT_ATTRIBUTES,
                                            PIO_STATUS_BLOCK, ULONG, ULONG);
using RtlNtStatusToDosErrorFunction = ULONG(WINAPI*)(NTSTATUS);

NtOpenFileFunction ResolveNtOpenFile() {
  static const auto function = reinterpret_cast<NtOpenFileFunction>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtOpenFile"));
  return function;
}

DWORD NtStatusToDosError(NTSTATUS status) {
  static const auto function = reinterpret_cast<RtlNtStatusToDosErrorFunction>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
  return function == nullptr ? static_cast<DWORD>(status) : function(status);
}

HANDLE OpenRelativeMetadataHandle(HANDLE parent, const std::wstring& leaf,
                                  ACCESS_MASK access, bool directory_only,
                                  DWORD* error_code) {
  const NtOpenFileFunction nt_open_file = ResolveNtOpenFile();
  if (nt_open_file == nullptr) {
    *error_code = ERROR_PROC_NOT_FOUND;
    return INVALID_HANDLE_VALUE;
  }

  UNICODE_STRING name {};
  name.Length = static_cast<USHORT>(leaf.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  name.Buffer = const_cast<PWSTR>(leaf.data());

  OBJECT_ATTRIBUTES attributes {};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &name;
  attributes.Attributes = OBJ_CASE_INSENSITIVE;

  IO_STATUS_BLOCK io_status {};
  HANDLE handle = INVALID_HANDLE_VALUE;
  ULONG options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT |
                  FILE_OPEN_REPARSE_POINT;
  if (directory_only) {
    options |= FILE_DIRECTORY_FILE;
  }
  const NTSTATUS status = nt_open_file(
      &handle, access, &attributes, &io_status,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, options);
  if (status < 0) {
    *error_code = NtStatusToDosError(status);
    return INVALID_HANDLE_VALUE;
  }
  *error_code = ERROR_SUCCESS;
  return handle;
}

NamedEntry QueryNamedEntry(HANDLE parent, const std::wstring& name) {
  DWORD open_error = ERROR_SUCCESS;
  ScopedHandle entry(OpenRelativeMetadataHandle(
      parent, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE, false, &open_error));
  if (!entry.valid()) {
    if (open_error == ERROR_FILE_NOT_FOUND || open_error == ERROR_PATH_NOT_FOUND) {
      return {};
    }
    return {false, true, open_error, {}};
  }
  FileIdentity identity {};
  if (!ReadIdentity(entry.get(), &identity)) {
    return {false, true, GetLastError(), {}};
  }
  return {true, false, ERROR_SUCCESS, identity};
}

bool IsWindowsSeparator(wchar_t value) {
  return value == L'\\' || value == L'/';
}

bool IsAsciiDriveLetter(wchar_t value) {
  return (value >= L'A' && value <= L'Z') ||
         (value >= L'a' && value <= L'z');
}

ScopedHandle OpenAbsoluteDirectoryNoReparse(const std::wstring& path,
                                            DWORD* error_code,
                                            bool* reparse_forbidden) {
  *error_code = ERROR_SUCCESS;
  *reparse_forbidden = false;

  std::size_t component_start = 0;
  std::wstring volume_root;
  if (path.size() >= 3 && IsAsciiDriveLetter(path[0]) && path[1] == L':' &&
      IsWindowsSeparator(path[2])) {
    volume_root = path.substr(0, 3);
    volume_root[2] = L'\\';
    component_start = 3;
  } else if (path.size() >= 7 && path.compare(0, 4, L"\\\\?\\") == 0 &&
             IsAsciiDriveLetter(path[4]) && path[5] == L':' &&
             IsWindowsSeparator(path[6])) {
    volume_root = path.substr(0, 7);
    volume_root[6] = L'\\';
    component_start = 7;
  } else {
    *error_code = ERROR_INVALID_NAME;
    return ScopedHandle();
  }
  if (path.size() > component_start && IsWindowsSeparator(path.back())) {
    *error_code = ERROR_INVALID_NAME;
    return ScopedHandle();
  }

  ScopedHandle current = OpenMetadataHandle(
      volume_root,
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE);
  if (!current.valid()) {
    *error_code = GetLastError();
    return ScopedHandle();
  }
  bool root_reparse = false;
  if (!ReadReparsePoint(current.get(), &root_reparse) ||
      !IsDirectory(current.get())) {
    *error_code = GetLastError();
    return ScopedHandle();
  }
  if (root_reparse) {
    *reparse_forbidden = true;
    return ScopedHandle();
  }

  while (component_start < path.size()) {
    const std::size_t component_end =
        path.find_first_of(L"\\/", component_start);
    const std::wstring component = path.substr(
        component_start,
        component_end == std::wstring::npos
            ? std::wstring::npos
            : component_end - component_start);
    if (component.empty() || component == L"." || component == L".." ||
        component.size() > 240) {
      *error_code = ERROR_INVALID_NAME;
      return ScopedHandle();
    }

    DWORD open_error = ERROR_SUCCESS;
    ScopedHandle next(OpenRelativeMetadataHandle(
        current.get(), component,
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        false, &open_error));
    if (!next.valid()) {
      *error_code = open_error;
      return ScopedHandle();
    }
    bool reparse = false;
    if (!ReadReparsePoint(next.get(), &reparse)) {
      *error_code = GetLastError();
      return ScopedHandle();
    }
    if (reparse) {
      *reparse_forbidden = true;
      return ScopedHandle();
    }
    if (!IsDirectory(next.get())) {
      *error_code = ERROR_DIRECTORY;
      return ScopedHandle();
    }
    current = std::move(next);
    if (component_end == std::wstring::npos) {
      break;
    }
    component_start = component_end + 1;
  }
  return current;
}

bool PrepareOperationParentOnWindows(
    const std::wstring& parent_root, HANDLE held_parent,
    ScopedHandle* owned_parent, HANDLE* parent, DWORD* error_code,
    bool* reparse_forbidden) {
  *error_code = ERROR_SUCCESS;
  *reparse_forbidden = false;
  if (held_parent != INVALID_HANDLE_VALUE && held_parent != nullptr) {
    if (!IsDirectory(held_parent)) {
      *error_code = ERROR_DIRECTORY;
      return false;
    }
    *parent = held_parent;
    return true;
  }
  *owned_parent = OpenAbsoluteDirectoryNoReparse(
      parent_root, error_code, reparse_forbidden);
  if (!owned_parent->valid()) {
    return false;
  }
  *parent = owned_parent->get();
  return true;
}

bool NamedParentMatchesHeldOnWindows(
    const std::wstring& parent_root, const FileIdentity& held_identity,
    const char** reason, DWORD* error_code) {
  DWORD named_parent_error = ERROR_SUCCESS;
  bool named_parent_reparse = false;
  ScopedHandle named_parent = OpenAbsoluteDirectoryNoReparse(
      parent_root, &named_parent_error, &named_parent_reparse);
  if (!named_parent.valid()) {
    *reason = named_parent_reparse ? "parent_reparse_forbidden"
                                  : "parent_invalid";
    *error_code = named_parent_error;
    return false;
  }
  FileIdentity named_parent_identity {};
  if (!ReadIdentity(named_parent.get(), &named_parent_identity)) {
    const DWORD identity_error = GetLastError();
    *reason = "parent_invalid";
    *error_code = identity_error == ERROR_SUCCESS
                      ? ERROR_INVALID_DATA
                      : identity_error;
    return false;
  }
  if (!SameIdentity(named_parent_identity, held_identity)) {
    *reason = "parent_identity_mismatch";
    *error_code = ERROR_SUCCESS;
    return false;
  }
  *reason = "matched";
  *error_code = ERROR_SUCCESS;
  return true;
}

bool ReadCurrentUserSid(std::vector<std::byte>* token_buffer, PSID* sid,
                        DWORD* error_code) {
  ScopedHandle token;
  HANDLE raw_token = INVALID_HANDLE_VALUE;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) {
    *error_code = GetLastError();
    return false;
  }
  token.reset(raw_token);

  DWORD required_bytes = 0;
  if (GetTokenInformation(token.get(), TokenUser, nullptr, 0,
                          &required_bytes) ||
      GetLastError() != ERROR_INSUFFICIENT_BUFFER || required_bytes == 0) {
    *error_code = GetLastError();
    return false;
  }
  token_buffer->resize(required_bytes);
  if (!GetTokenInformation(token.get(), TokenUser, token_buffer->data(),
                           required_bytes, &required_bytes)) {
    *error_code = GetLastError();
    return false;
  }
  auto* token_user = reinterpret_cast<TOKEN_USER*>(token_buffer->data());
  if (!IsValidSid(token_user->User.Sid)) {
    *error_code = ERROR_INVALID_SID;
    return false;
  }
  *sid = token_user->User.Sid;
  *error_code = ERROR_SUCCESS;
  return true;
}

bool CreatePinnedWellKnownSid(WELL_KNOWN_SID_TYPE type,
                              std::vector<BYTE>* sid_buffer, PSID* sid,
                              DWORD* error_code) {
  sid_buffer->resize(SECURITY_MAX_SID_SIZE);
  DWORD sid_bytes = static_cast<DWORD>(sid_buffer->size());
  if (!CreateWellKnownSid(type, nullptr, sid_buffer->data(), &sid_bytes)) {
    *error_code = GetLastError();
    return false;
  }
  sid_buffer->resize(sid_bytes);
  *sid = sid_buffer->data();
  *error_code = ERROR_SUCCESS;
  return true;
}

void AppendUniqueSid(std::vector<PSID>* values, PSID candidate) {
  for (PSID existing : *values) {
    if (EqualSid(existing, candidate)) {
      return;
    }
  }
  values->push_back(candidate);
}

bool SidToAsciiString(PSID sid, std::string* value, DWORD* error_code) {
  LPSTR text = nullptr;
  if (!ConvertSidToStringSidA(sid, &text)) {
    *error_code = GetLastError();
    return false;
  }
  ScopedLocalMemory memory(reinterpret_cast<HLOCAL>(text));
  *value = text;
  *error_code = ERROR_SUCCESS;
  return true;
}

bool ApplyPrivateDirectorySecurityOnWindows(
    HANDLE directory, PSID current_user_sid, PSID system_sid,
    PSID administrators_sid, DWORD* error_code) {
  std::vector<PSID> allowed_sids;
  AppendUniqueSid(&allowed_sids, current_user_sid);
  AppendUniqueSid(&allowed_sids, system_sid);
  AppendUniqueSid(&allowed_sids, administrators_sid);

  std::vector<EXPLICIT_ACCESSW> entries(allowed_sids.size());
  for (std::size_t index = 0; index < allowed_sids.size(); ++index) {
    entries[index].grfAccessPermissions = FILE_ALL_ACCESS;
    entries[index].grfAccessMode = SET_ACCESS;
    entries[index].grfInheritance =
        SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    BuildTrusteeWithSidW(&entries[index].Trustee, allowed_sids[index]);
  }

  PACL raw_acl = nullptr;
  const DWORD acl_error = SetEntriesInAclW(
      static_cast<ULONG>(entries.size()), entries.data(), nullptr, &raw_acl);
  if (acl_error != ERROR_SUCCESS) {
    *error_code = acl_error;
    return false;
  }
  ScopedLocalMemory acl_memory(reinterpret_cast<HLOCAL>(raw_acl));
  const SECURITY_INFORMATION security_information =
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
      PROTECTED_DACL_SECURITY_INFORMATION;
  const DWORD set_error = SetSecurityInfo(
      directory, SE_FILE_OBJECT, security_information, current_user_sid,
      nullptr, raw_acl, nullptr);
  if (set_error != ERROR_SUCCESS) {
    *error_code = set_error;
    return false;
  }
  *error_code = ERROR_SUCCESS;
  return true;
}

bool VerifyPrivateDirectorySecurityOnWindows(
    HANDLE directory, PSID current_user_sid, PSID system_sid,
    PSID administrators_sid, std::string* owner_identity,
    DWORD* error_code) {
  PSID owner_sid = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  const DWORD get_error = GetSecurityInfo(
      directory, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner_sid,
      nullptr, &dacl, nullptr, &raw_descriptor);
  if (get_error != ERROR_SUCCESS) {
    *error_code = get_error;
    return false;
  }
  ScopedLocalMemory descriptor_memory(
      reinterpret_cast<HLOCAL>(raw_descriptor));
  if (owner_sid == nullptr || !IsValidSid(owner_sid) ||
      !EqualSid(owner_sid, current_user_sid) || dacl == nullptr ||
      !IsValidAcl(dacl)) {
    *error_code = ERROR_INVALID_SECURITY_DESCR;
    return false;
  }

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(raw_descriptor, &control, &revision)) {
    *error_code = GetLastError();
    return false;
  }
  if ((control & SE_DACL_PRESENT) == 0 ||
      (control & SE_DACL_PROTECTED) == 0 ||
      (control & SE_DACL_DEFAULTED) != 0 ||
      (control & SE_OWNER_DEFAULTED) != 0) {
    *error_code = ERROR_INVALID_SECURITY_DESCR;
    return false;
  }

  std::vector<PSID> allowed_sids;
  AppendUniqueSid(&allowed_sids, current_user_sid);
  AppendUniqueSid(&allowed_sids, system_sid);
  AppendUniqueSid(&allowed_sids, administrators_sid);
  if (static_cast<std::size_t>(dacl->AceCount) != allowed_sids.size()) {
    *error_code = ERROR_INVALID_ACL;
    return false;
  }
  std::vector<bool> observed(allowed_sids.size(), false);
  constexpr BYTE kRequiredInheritance = static_cast<BYTE>(
      OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw_ace = nullptr;
    if (!GetAce(dacl, index, &raw_ace) || raw_ace == nullptr) {
      *error_code = GetLastError();
      return false;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
        header->AceFlags != kRequiredInheritance) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    if (ace->Mask != FILE_ALL_ACCESS) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
    PSID ace_sid = const_cast<DWORD*>(&ace->SidStart);
    if (!IsValidSid(ace_sid)) {
      *error_code = ERROR_INVALID_SID;
      return false;
    }
    bool matched = false;
    for (std::size_t allowed_index = 0;
         allowed_index < allowed_sids.size(); ++allowed_index) {
      if (EqualSid(ace_sid, allowed_sids[allowed_index]) &&
          !observed[allowed_index]) {
        observed[allowed_index] = true;
        matched = true;
        break;
      }
    }
    if (!matched) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
  }
  for (const bool was_observed : observed) {
    if (!was_observed) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
  }
  return SidToAsciiString(current_user_sid, owner_identity, error_code);
}

bool ReadCurrentUserOwnerOnWindows(HANDLE directory, PSID current_user_sid,
                                   bool* owner_matches, DWORD* error_code) {
  PSID owner_sid = nullptr;
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  const DWORD get_error = GetSecurityInfo(
      directory, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner_sid,
      nullptr, nullptr, nullptr, &raw_descriptor);
  if (get_error != ERROR_SUCCESS) {
    *error_code = get_error;
    return false;
  }
  ScopedLocalMemory descriptor_memory(
      reinterpret_cast<HLOCAL>(raw_descriptor));
  if (owner_sid == nullptr || !IsValidSid(owner_sid)) {
    *error_code = ERROR_INVALID_SECURITY_DESCR;
    return false;
  }
  *owner_matches = EqualSid(owner_sid, current_user_sid) != FALSE;
  *error_code = ERROR_SUCCESS;
  return true;
}

std::wstring ParentLockMutexName(const FileIdentity& parent_identity) {
  std::string identity = IdentityString(parent_identity);
  for (char& value : identity) {
    if (value == ':') {
      value = '-';
    }
  }
  return L"Global\\LingCuaStage-" +
         std::wstring(identity.begin(), identity.end());
}

bool BuildPrivateMutexAclOnWindows(
    PSID current_user_sid, PSID system_sid, PSID administrators_sid,
    PACL* acl, DWORD* error_code) {
  std::vector<PSID> allowed_sids;
  AppendUniqueSid(&allowed_sids, current_user_sid);
  AppendUniqueSid(&allowed_sids, system_sid);
  AppendUniqueSid(&allowed_sids, administrators_sid);

  std::vector<EXPLICIT_ACCESSW> entries(allowed_sids.size());
  for (std::size_t index = 0; index < allowed_sids.size(); ++index) {
    entries[index].grfAccessPermissions = MUTEX_ALL_ACCESS;
    entries[index].grfAccessMode = SET_ACCESS;
    entries[index].grfInheritance = NO_INHERITANCE;
    BuildTrusteeWithSidW(&entries[index].Trustee, allowed_sids[index]);
  }
  const DWORD acl_error = SetEntriesInAclW(
      static_cast<ULONG>(entries.size()), entries.data(), nullptr, acl);
  if (acl_error != ERROR_SUCCESS) {
    *error_code = acl_error;
    return false;
  }
  *error_code = ERROR_SUCCESS;
  return true;
}

bool VerifyPrivateMutexSecurityOnWindows(
    HANDLE mutex, PSID current_user_sid, PSID system_sid,
    PSID administrators_sid, DWORD* error_code) {
  PSID owner_sid = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  const DWORD get_error = GetSecurityInfo(
      mutex, SE_KERNEL_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner_sid,
      nullptr, &dacl, nullptr, &raw_descriptor);
  if (get_error != ERROR_SUCCESS) {
    *error_code = get_error;
    return false;
  }
  ScopedLocalMemory descriptor_memory(
      reinterpret_cast<HLOCAL>(raw_descriptor));
  if (owner_sid == nullptr || !IsValidSid(owner_sid) ||
      !EqualSid(owner_sid, current_user_sid) || dacl == nullptr ||
      !IsValidAcl(dacl)) {
    *error_code = ERROR_INVALID_SECURITY_DESCR;
    return false;
  }

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(raw_descriptor, &control, &revision)) {
    *error_code = GetLastError();
    return false;
  }
  if ((control & SE_DACL_PRESENT) == 0 ||
      (control & SE_DACL_PROTECTED) == 0 ||
      (control & SE_DACL_DEFAULTED) != 0 ||
      (control & SE_OWNER_DEFAULTED) != 0) {
    *error_code = ERROR_INVALID_SECURITY_DESCR;
    return false;
  }

  std::vector<PSID> allowed_sids;
  AppendUniqueSid(&allowed_sids, current_user_sid);
  AppendUniqueSid(&allowed_sids, system_sid);
  AppendUniqueSid(&allowed_sids, administrators_sid);
  if (static_cast<std::size_t>(dacl->AceCount) != allowed_sids.size()) {
    *error_code = ERROR_INVALID_ACL;
    return false;
  }
  std::vector<bool> observed(allowed_sids.size(), false);
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw_ace = nullptr;
    if (!GetAce(dacl, index, &raw_ace) || raw_ace == nullptr) {
      *error_code = GetLastError();
      return false;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
        header->AceFlags != NO_INHERITANCE) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    if (ace->Mask != MUTEX_ALL_ACCESS) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
    PSID ace_sid = const_cast<DWORD*>(&ace->SidStart);
    if (!IsValidSid(ace_sid)) {
      *error_code = ERROR_INVALID_SID;
      return false;
    }
    bool matched = false;
    for (std::size_t allowed_index = 0;
         allowed_index < allowed_sids.size(); ++allowed_index) {
      if (EqualSid(ace_sid, allowed_sids[allowed_index]) &&
          !observed[allowed_index]) {
        observed[allowed_index] = true;
        matched = true;
        break;
      }
    }
    if (!matched) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
  }
  for (const bool was_observed : observed) {
    if (!was_observed) {
      *error_code = ERROR_INVALID_ACL;
      return false;
    }
  }
  *error_code = ERROR_SUCCESS;
  return true;
}

PublishResult DispatchParentLockOperationOnWindows(
    const std::string& operation, const std::vector<std::string>& arguments,
    const std::wstring& parent_root, HANDLE held_parent,
    bool* valid_operation);
#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
bool CreateTestMarkerOnWindows(const std::wstring& parent_root,
                               const std::wstring& name,
                               DWORD* error_code);
#endif

int HoldParentLockOnWindows(const std::wstring& parent_root,
                            std::uint64_t timeout_ms,
                            const std::wstring& waiter_ready_name = L"") {
  DWORD parent_error = ERROR_SUCCESS;
  bool parent_reparse = false;
  ScopedHandle parent = OpenAbsoluteDirectoryNoReparse(
      parent_root, &parent_error, &parent_reparse);
  if (!parent.valid()) {
    return EmitResult(NotCommitted(
        parent_reparse ? "parent_reparse_forbidden" : "parent_invalid",
        static_cast<std::uint64_t>(parent_error)));
  }
  FileIdentity parent_identity_value {};
  if (!IsDirectory(parent.get()) ||
      !ReadIdentity(parent.get(), &parent_identity_value)) {
    return EmitResult(NotCommitted(
        "parent_invalid", static_cast<std::uint64_t>(GetLastError())));
  }
  const std::string parent_identity = IdentityString(parent_identity_value);

  std::vector<std::byte> current_user_buffer;
  std::vector<BYTE> system_buffer;
  std::vector<BYTE> administrators_buffer;
  PSID current_user_sid = nullptr;
  PSID system_sid = nullptr;
  PSID administrators_sid = nullptr;
  DWORD security_error = ERROR_SUCCESS;
  if (!ReadCurrentUserSid(
          &current_user_buffer, &current_user_sid, &security_error) ||
      !CreatePinnedWellKnownSid(
          WinLocalSystemSid, &system_buffer, &system_sid,
          &security_error) ||
      !CreatePinnedWellKnownSid(
          WinBuiltinAdministratorsSid, &administrators_buffer,
          &administrators_sid, &security_error)) {
    return EmitResult(NotCommitted(
        "parent_lock_security_unavailable",
        static_cast<std::uint64_t>(security_error)));
  }

  PACL raw_acl = nullptr;
  if (!BuildPrivateMutexAclOnWindows(
          current_user_sid, system_sid, administrators_sid, &raw_acl,
          &security_error)) {
    return EmitResult(NotCommitted(
        "parent_lock_security_unavailable",
        static_cast<std::uint64_t>(security_error)));
  }
  ScopedLocalMemory acl_memory(reinterpret_cast<HLOCAL>(raw_acl));
  SECURITY_DESCRIPTOR descriptor {};
  if (!InitializeSecurityDescriptor(
          &descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(
          &descriptor, current_user_sid, FALSE) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, raw_acl, FALSE) ||
      !SetSecurityDescriptorControl(
          &descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    return EmitResult(NotCommitted(
        "parent_lock_security_unavailable",
        static_cast<std::uint64_t>(GetLastError())));
  }
  SECURITY_ATTRIBUTES attributes {};
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = &descriptor;
  attributes.bInheritHandle = FALSE;

  const std::wstring mutex_name =
      ParentLockMutexName(parent_identity_value);
  SetLastError(ERROR_SUCCESS);
  ScopedHandle mutex(CreateMutexW(
      &attributes, FALSE, mutex_name.c_str()));
  if (!mutex.valid()) {
    return EmitResult(NotCommitted(
        "parent_lock_create_failed",
        static_cast<std::uint64_t>(GetLastError())));
  }
  if (!VerifyPrivateMutexSecurityOnWindows(
          mutex.get(), current_user_sid, system_sid, administrators_sid,
          &security_error)) {
    return EmitResult(NotCommitted(
        "parent_lock_security_invalid",
        static_cast<std::uint64_t>(security_error)));
  }

#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
  if (!waiter_ready_name.empty()) {
    DWORD marker_error = ERROR_SUCCESS;
    if (!CreateTestMarkerOnWindows(
            parent_root, waiter_ready_name, &marker_error)) {
      return EmitResult(NotCommitted(
          "test_waiter_ready_create_failed",
          static_cast<std::uint64_t>(marker_error)));
    }
  }
#else
  static_cast<void>(waiter_ready_name);
#endif

  const DWORD wait_result = WaitForSingleObject(
      mutex.get(), static_cast<DWORD>(timeout_ms));
  const bool recovered_abandoned_lock = wait_result == WAIT_ABANDONED;
  if (wait_result == WAIT_TIMEOUT) {
    return EmitResult(NotCommitted(
        "parent_lock_timeout", static_cast<std::uint64_t>(ERROR_TIMEOUT)));
  }
  if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED) {
    return EmitResult(NotCommitted(
        "parent_lock_acquire_failed",
        static_cast<std::uint64_t>(GetLastError())));
  }
  ScopedMutexOwnership held_lock(mutex.get());
  held_lock.MarkOwned();

  DWORD named_parent_error = ERROR_SUCCESS;
  bool named_parent_reparse = false;
  ScopedHandle named_parent = OpenAbsoluteDirectoryNoReparse(
      parent_root, &named_parent_error, &named_parent_reparse);
  FileIdentity named_parent_identity {};
  if (!named_parent.valid() || !IsDirectory(named_parent.get()) ||
      !ReadIdentity(named_parent.get(), &named_parent_identity) ||
      !SameIdentity(named_parent_identity, parent_identity_value)) {
    return EmitResult(NotCommitted(
        named_parent_reparse ? "parent_reparse_forbidden"
                             : "parent_identity_mismatch",
        static_cast<std::uint64_t>(named_parent_error)));
  }

  if (!EmitParentLockReceipt(
          "locked", parent_identity, recovered_abandoned_lock)) {
    return kExitAmbiguous;
  }
  const ParentLockSessionResult session = RunParentLockSession(
      [&](const std::string& operation,
          const std::vector<std::string>& arguments, bool* valid_operation) {
        return DispatchParentLockOperationOnWindows(
            operation, arguments, parent_root, parent.get(), valid_operation);
      });
  DWORD release_error = ERROR_SUCCESS;
  if (!held_lock.Release(&release_error)) {
    return EmitResult(Ambiguous(
        "parent_lock_release_failed",
        static_cast<std::uint64_t>(release_error)));
  }
  if (session.outcome == ParentLockSessionOutcome::kFailed) {
    return kExitAmbiguous;
  }
  if (session.outcome == ParentLockSessionOutcome::kCallerClosed) {
    return kExitCommitted;
  }
  return EmitParentLockReleaseReceipt(
             parent_identity, recovered_abandoned_lock,
             session.release_request_id)
             ? kExitCommitted : kExitAmbiguous;
}

PublishResult PrivateDirectoryOnWindows(
    const std::wstring& parent_root, const std::wstring& directory_name,
    bool apply_security, const std::string& expected_parent_identity,
    const std::string& expected_directory_identity,
    HANDLE held_parent = INVALID_HANDLE_VALUE) {
  if (parent_root.empty() || !IsValidLeafName(directory_name)) {
    return InvalidInput();
  }

  DWORD parent_error = ERROR_SUCCESS;
  bool parent_reparse = false;
  ScopedHandle owned_parent;
  HANDLE parent = INVALID_HANDLE_VALUE;
  if (!PrepareOperationParentOnWindows(
          parent_root, held_parent, &owned_parent, &parent,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  FileIdentity parent_identity_value {};
  if (!ReadIdentity(parent, &parent_identity_value)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  const std::string parent_identity = IdentityString(parent_identity_value);
  if (!expected_parent_identity.empty() &&
      parent_identity != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }

  ACCESS_MASK directory_access =
      FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
  if (apply_security) {
    directory_access |= WRITE_DAC | WRITE_OWNER;
  }
  DWORD directory_error = ERROR_SUCCESS;
  ScopedHandle directory(OpenRelativeMetadataHandle(
      parent, directory_name, directory_access, true,
      &directory_error));
  if (!directory.valid()) {
    return NotCommitted(directory_error == ERROR_FILE_NOT_FOUND ||
                                directory_error == ERROR_PATH_NOT_FOUND
                            ? "directory_missing"
                            : "directory_invalid",
                        static_cast<std::uint64_t>(directory_error));
  }
  bool directory_reparse = false;
  if (!ReadReparsePoint(directory.get(), &directory_reparse)) {
    return NotCommitted("directory_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (directory_reparse) {
    return NotCommitted("directory_reparse_forbidden", 0);
  }
  if (!IsDirectory(directory.get())) {
    return NotCommitted("directory_invalid", 0);
  }
  FileIdentity directory_identity_value {};
  if (!ReadIdentity(directory.get(), &directory_identity_value)) {
    return NotCommitted("directory_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  const std::string directory_identity =
      IdentityString(directory_identity_value);
  if (!expected_directory_identity.empty() &&
      directory_identity != expected_directory_identity) {
    return NotCommitted("directory_identity_mismatch", 0);
  }

  std::vector<std::byte> token_buffer;
  std::vector<BYTE> system_sid_buffer;
  std::vector<BYTE> administrators_sid_buffer;
  PSID current_user_sid = nullptr;
  PSID system_sid = nullptr;
  PSID administrators_sid = nullptr;
  DWORD security_error = ERROR_SUCCESS;
  if (!ReadCurrentUserSid(&token_buffer, &current_user_sid,
                          &security_error) ||
      !CreatePinnedWellKnownSid(WinLocalSystemSid, &system_sid_buffer,
                                &system_sid, &security_error) ||
      !CreatePinnedWellKnownSid(WinBuiltinAdministratorsSid,
                                &administrators_sid_buffer,
                                &administrators_sid, &security_error)) {
    return NotCommitted("directory_security_unavailable",
                        static_cast<std::uint64_t>(security_error));
  }
  if (apply_security && !ApplyPrivateDirectorySecurityOnWindows(
                            directory.get(), current_user_sid, system_sid,
                            administrators_sid, &security_error)) {
    return NotCommitted("directory_security_set_failed",
                        static_cast<std::uint64_t>(security_error));
  }
  std::string owner_identity;
  if (!VerifyPrivateDirectorySecurityOnWindows(
          directory.get(), current_user_sid, system_sid, administrators_sid,
          &owner_identity, &security_error)) {
    return NotCommitted("directory_security_invalid",
                        static_cast<std::uint64_t>(security_error));
  }
  FileIdentity verified_identity {};
  if (!ReadIdentity(directory.get(), &verified_identity) ||
      !SameIdentity(verified_identity, directory_identity_value)) {
    return NotCommitted("directory_identity_mismatch",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  FileIdentity verified_parent_identity {};
  if (!ReadIdentity(parent, &verified_parent_identity)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (!SameIdentity(verified_parent_identity, parent_identity_value) ||
      (!expected_parent_identity.empty() &&
       IdentityString(verified_parent_identity) != expected_parent_identity)) {
    return NotCommitted("parent_identity_mismatch", 0);
  }
  DWORD named_parent_error = ERROR_SUCCESS;
  bool named_parent_reparse = false;
  ScopedHandle named_parent = OpenAbsoluteDirectoryNoReparse(
      parent_root, &named_parent_error, &named_parent_reparse);
  if (!named_parent.valid()) {
    return NotCommitted(named_parent_reparse ? "parent_reparse_forbidden"
                                             : "parent_invalid",
                        static_cast<std::uint64_t>(named_parent_error));
  }
  FileIdentity named_parent_identity {};
  if (!ReadIdentity(named_parent.get(), &named_parent_identity)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (!SameIdentity(named_parent_identity, parent_identity_value)) {
    return NotCommitted("parent_identity_mismatch", 0);
  }
  bool verified_reparse = false;
  if (!ReadReparsePoint(directory.get(), &verified_reparse)) {
    return NotCommitted("directory_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (verified_reparse) {
    return NotCommitted("directory_reparse_forbidden", 0);
  }
  const NamedEntry named_after = QueryNamedEntry(parent, directory_name);
  if (named_after.query_failed) {
    return NotCommitted("directory_identity_unavailable",
                        static_cast<std::uint64_t>(named_after.error_code));
  }
  if (!named_after.exists ||
      !SameIdentity(named_after.identity, directory_identity_value)) {
    return NotCommitted("directory_identity_mismatch", 0);
  }

  return PrivateDirectorySuccess(
      apply_security ? "secured" : "verified", parent_identity,
      directory_identity, owner_identity,
      "protected-dacl-current-user-system-administrators", true);
}

struct RemovalEntryWindows {
  std::vector<std::wstring> components;
  FileIdentity identity;
  LONGLONG size;
  bool directory;
};

bool ReadStandardInfo(HANDLE handle, FILE_STANDARD_INFO* output) {
  return GetFileInformationByHandleEx(
             handle, FileStandardInfo, output, sizeof(*output)) != FALSE;
}

bool DirectoryIsEmptyOnWindows(HANDLE directory, bool* empty,
                               DWORD* error_code) {
  std::vector<std::byte> buffer(4 * 1024);
  FILE_INFO_BY_HANDLE_CLASS info_class = FileIdBothDirectoryRestartInfo;
  *empty = true;
  while (true) {
    if (!GetFileInformationByHandleEx(
            directory, info_class, buffer.data(),
            static_cast<DWORD>(buffer.size()))) {
      const DWORD enumeration_error = GetLastError();
      if (enumeration_error == ERROR_NO_MORE_FILES) {
        *error_code = ERROR_SUCCESS;
        return true;
      }
      *error_code = enumeration_error;
      return false;
    }
    info_class = FileIdBothDirectoryInfo;
    auto* info = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
    while (true) {
      const std::wstring name(
          info->FileName,
          static_cast<std::size_t>(info->FileNameLength / sizeof(wchar_t)));
      if (name != L"." && name != L"..") {
        *empty = false;
        *error_code = ERROR_SUCCESS;
        return true;
      }
      if (info->NextEntryOffset == 0) {
        break;
      }
      info = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(
          reinterpret_cast<std::byte*>(info) + info->NextEntryOffset);
    }
  }
}

bool CollectRemovalPlanWindows(
    HANDLE directory, ULONGLONG root_volume,
    std::vector<std::wstring>* components,
    std::vector<RemovalEntryWindows>* plan, std::uint64_t* entry_count,
    std::uint64_t* total_bytes, std::uint64_t maximum_entries,
    std::uint64_t maximum_bytes, const char** reason, DWORD* error_code) {
  std::vector<std::byte> buffer(64 * 1024);
  FILE_INFO_BY_HANDLE_CLASS info_class = FileIdBothDirectoryRestartInfo;
  while (true) {
    if (!GetFileInformationByHandleEx(
            directory, info_class, buffer.data(),
            static_cast<DWORD>(buffer.size()))) {
      const DWORD enumeration_error = GetLastError();
      if (enumeration_error == ERROR_NO_MORE_FILES) {
        return true;
      }
      *reason = "tree_enumeration_failed";
      *error_code = enumeration_error;
      return false;
    }
    info_class = FileIdBothDirectoryInfo;
    auto* info = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
    while (true) {
      const std::wstring name(
          info->FileName,
          static_cast<std::size_t>(info->FileNameLength / sizeof(wchar_t)));
      if (name != L"." && name != L"..") {
        if (!IsValidLeafName(name)) {
          *reason = "tree_entry_invalid";
          *error_code = ERROR_INVALID_NAME;
          return false;
        }
        if ((info->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
          *reason = "tree_reparse_forbidden";
          *error_code = ERROR_CANT_ACCESS_FILE;
          return false;
        }
        *entry_count += 1;
        if (*entry_count > maximum_entries) {
          *reason = "tree_entry_limit_exceeded";
          *error_code = ERROR_BUFFER_OVERFLOW;
          return false;
        }

        const bool directory_entry =
            (info->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        DWORD child_error = ERROR_SUCCESS;
        const ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE |
            (directory_entry ? FILE_LIST_DIRECTORY : 0);
        ScopedHandle child(OpenRelativeMetadataHandle(
            directory, name, access, directory_entry, &child_error));
        if (!child.valid()) {
          *reason = "tree_changed_before_delete";
          *error_code = child_error;
          return false;
        }
        bool child_reparse = false;
        FileIdentity child_identity {};
        FILE_STANDARD_INFO standard {};
        if (!ReadReparsePoint(child.get(), &child_reparse) ||
            child_reparse || !ReadIdentity(child.get(), &child_identity) ||
            !ReadStandardInfo(child.get(), &standard) ||
            (standard.Directory != FALSE) != directory_entry) {
          *reason = child_reparse ? "tree_reparse_forbidden"
                                  : "tree_changed_before_delete";
          *error_code = GetLastError();
          return false;
        }
        if (child_identity.volume_serial_number != root_volume) {
          *reason = "tree_mount_forbidden";
          *error_code = ERROR_NOT_SAME_DEVICE;
          return false;
        }

        components->push_back(name);
        if (directory_entry) {
          if (!CollectRemovalPlanWindows(
                  child.get(), root_volume, components, plan, entry_count,
                  total_bytes, maximum_entries, maximum_bytes, reason,
                  error_code)) {
            components->pop_back();
            return false;
          }
          plan->push_back({*components, child_identity, 0, true});
        } else {
          if (standard.NumberOfLinks != 1) {
            *reason = "tree_hardlink_forbidden";
            *error_code = ERROR_INVALID_DATA;
            components->pop_back();
            return false;
          }
          if (standard.EndOfFile.QuadPart < 0) {
            *reason = "tree_non_regular_entry";
            *error_code = ERROR_INVALID_DATA;
            components->pop_back();
            return false;
          }
          const std::uint64_t size =
              static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
          if (size > maximum_bytes ||
              *total_bytes > maximum_bytes - size) {
            *reason = "tree_byte_limit_exceeded";
            *error_code = ERROR_FILE_TOO_LARGE;
            components->pop_back();
            return false;
          }
          *total_bytes += size;
          plan->push_back(
              {*components, child_identity, standard.EndOfFile.QuadPart,
               false});
        }
        components->pop_back();
      }
      if (info->NextEntryOffset == 0) {
        break;
      }
      info = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(
          reinterpret_cast<std::byte*>(info) + info->NextEntryOffset);
    }
  }
}

ScopedHandle OpenRemovalParentWindows(
    HANDLE root, const std::vector<std::wstring>& components,
    const char** reason, DWORD* error_code) {
  HANDLE duplicate = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), root, GetCurrentProcess(),
                       &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    *reason = "tree_changed_during_delete";
    *error_code = GetLastError();
    return ScopedHandle();
  }
  ScopedHandle current(duplicate);
  for (std::size_t index = 0; index + 1 < components.size(); ++index) {
    DWORD open_error = ERROR_SUCCESS;
    ScopedHandle next(OpenRelativeMetadataHandle(
        current.get(), components[index],
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, true,
        &open_error));
    if (!next.valid()) {
      *reason = "tree_changed_during_delete";
      *error_code = open_error;
      return ScopedHandle();
    }
    bool reparse = false;
    if (!ReadReparsePoint(next.get(), &reparse) || reparse) {
      *reason = reparse ? "tree_reparse_forbidden"
                        : "tree_changed_during_delete";
      *error_code = GetLastError();
      return ScopedHandle();
    }
    current = std::move(next);
  }
  return current;
}

bool MarkHandleForDeletion(HANDLE handle, DWORD* error_code) {
  FILE_DISPOSITION_INFO disposition {};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(
          handle, FileDispositionInfo, &disposition, sizeof(disposition))) {
    *error_code = GetLastError();
    return false;
  }
  *error_code = ERROR_SUCCESS;
  return true;
}

PublishResult RemoveUnsecuredEmptyOnWindows(
    const std::wstring& parent_root, const std::wstring& source_name,
    const std::string& expected_parent_identity,
    const std::string& expected_source_identity,
    HANDLE held_parent = INVALID_HANDLE_VALUE) {
  if (parent_root.empty() || !IsValidLeafName(source_name) ||
      expected_parent_identity.empty() || expected_source_identity.empty()) {
    return InvalidInput();
  }

  DWORD parent_error = ERROR_SUCCESS;
  bool parent_reparse = false;
  ScopedHandle owned_parent;
  HANDLE parent = INVALID_HANDLE_VALUE;
  if (!PrepareOperationParentOnWindows(
          parent_root, held_parent, &owned_parent, &parent,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  FileIdentity parent_identity_value {};
  if (!ReadIdentity(parent, &parent_identity_value)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  const std::string parent_identity = IdentityString(parent_identity_value);
  if (parent_identity != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }

  DWORD source_error = ERROR_SUCCESS;
  ScopedHandle source(OpenRelativeMetadataHandle(
      parent, source_name,
      DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL |
          SYNCHRONIZE,
      true, &source_error));
  if (!source.valid()) {
    return NotCommitted(source_error == ERROR_FILE_NOT_FOUND ||
                                source_error == ERROR_PATH_NOT_FOUND
                            ? "source_missing"
                            : "source_invalid",
                        static_cast<std::uint64_t>(source_error));
  }
  bool source_reparse = false;
  FileIdentity source_identity_value {};
  if (!ReadReparsePoint(source.get(), &source_reparse)) {
    return NotCommitted("source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (source_reparse) {
    return NotCommitted("source_reparse_forbidden", 0);
  }
  if (!IsDirectory(source.get()) ||
      !ReadIdentity(source.get(), &source_identity_value)) {
    return NotCommitted("source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  const std::string source_identity = IdentityString(source_identity_value);
  if (source_identity != expected_source_identity) {
    return NotCommitted("source_identity_mismatch", 0);
  }

  std::vector<std::byte> token_buffer;
  PSID current_user_sid = nullptr;
  DWORD owner_error = ERROR_SUCCESS;
  bool owner_matches = false;
  if (!ReadCurrentUserSid(&token_buffer, &current_user_sid, &owner_error) ||
      !ReadCurrentUserOwnerOnWindows(
          source.get(), current_user_sid, &owner_matches, &owner_error)) {
    return NotCommitted("directory_owner_unavailable",
                        static_cast<std::uint64_t>(owner_error));
  }
  if (!owner_matches) {
    return NotCommitted("directory_owner_mismatch", 0);
  }
  DWORD named_parent_error = ERROR_SUCCESS;
  bool named_parent_reparse = false;
  ScopedHandle named_parent = OpenAbsoluteDirectoryNoReparse(
      parent_root, &named_parent_error, &named_parent_reparse);
  if (!named_parent.valid()) {
    return NotCommitted(named_parent_reparse ? "parent_reparse_forbidden"
                                             : "parent_invalid",
                        static_cast<std::uint64_t>(named_parent_error));
  }
  FileIdentity named_parent_identity {};
  if (!ReadIdentity(named_parent.get(), &named_parent_identity)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (!SameIdentity(named_parent_identity, parent_identity_value)) {
    return NotCommitted("parent_identity_mismatch", 0);
  }

  bool empty = false;
  DWORD empty_error = ERROR_SUCCESS;
  if (!DirectoryIsEmptyOnWindows(source.get(), &empty, &empty_error)) {
    return NotCommitted("tree_enumeration_failed",
                        static_cast<std::uint64_t>(empty_error));
  }
  if (!empty) {
    return NotCommitted("directory_not_empty",
                        static_cast<std::uint64_t>(ERROR_DIR_NOT_EMPTY));
  }

  FileIdentity verified_parent_identity {};
  FileIdentity verified_source_identity {};
  if (!ReadIdentity(parent, &verified_parent_identity) ||
      !SameIdentity(verified_parent_identity, parent_identity_value)) {
    return NotCommitted("parent_identity_mismatch",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (!ReadIdentity(source.get(), &verified_source_identity) ||
      !SameIdentity(verified_source_identity, source_identity_value)) {
    return NotCommitted("source_identity_mismatch",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  bool verified_reparse = false;
  if (!ReadReparsePoint(source.get(), &verified_reparse)) {
    return NotCommitted("source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (verified_reparse) {
    return NotCommitted("source_reparse_forbidden", 0);
  }
  if (!ReadCurrentUserOwnerOnWindows(
          source.get(), current_user_sid, &owner_matches, &owner_error)) {
    return NotCommitted("directory_owner_unavailable",
                        static_cast<std::uint64_t>(owner_error));
  }
  if (!owner_matches) {
    return NotCommitted("directory_owner_mismatch", 0);
  }
  const NamedEntry named_before = QueryNamedEntry(parent, source_name);
  if (named_before.query_failed) {
    return NotCommitted("source_identity_unavailable",
                        static_cast<std::uint64_t>(named_before.error_code));
  }
  if (!named_before.exists ||
      !SameIdentity(named_before.identity, source_identity_value)) {
    return NotCommitted("source_identity_mismatch", 0);
  }

  DWORD delete_error = ERROR_SUCCESS;
  if (!MarkHandleForDeletion(source.get(), &delete_error)) {
    return NotCommitted(delete_error == ERROR_DIR_NOT_EMPTY
                            ? "directory_not_empty"
                            : "delete_failed",
                        static_cast<std::uint64_t>(delete_error));
  }
  source.reset();
  const NamedEntry named_after = QueryNamedEntry(parent, source_name);
  if (named_after.query_failed || named_after.exists) {
    return Ambiguous(named_after.exists ? "source_name_changed_after_delete"
                                        : "post_delete_state_ambiguous",
                     static_cast<std::uint64_t>(named_after.error_code));
  }
  FileIdentity parent_after {};
  if (!ReadIdentity(parent, &parent_after) ||
      !SameIdentity(parent_after, parent_identity_value)) {
    return Ambiguous("parent_identity_mismatch",
                     static_cast<std::uint64_t>(GetLastError()));
  }
  DWORD named_parent_after_error = ERROR_SUCCESS;
  bool named_parent_after_reparse = false;
  ScopedHandle named_parent_after = OpenAbsoluteDirectoryNoReparse(
      parent_root, &named_parent_after_error, &named_parent_after_reparse);
  if (!named_parent_after.valid()) {
    return Ambiguous(named_parent_after_reparse ? "parent_reparse_forbidden"
                                               : "parent_identity_mismatch",
                     static_cast<std::uint64_t>(named_parent_after_error));
  }
  FileIdentity named_parent_after_identity {};
  if (!ReadIdentity(named_parent_after.get(), &named_parent_after_identity) ||
      !SameIdentity(named_parent_after_identity, parent_identity_value)) {
    return Ambiguous("parent_identity_mismatch",
                     static_cast<std::uint64_t>(GetLastError()));
  }
  return Removed(parent_identity, source_identity, 0, 0);
}

bool DeleteRemovalEntryWindows(
    HANDLE root, const RemovalEntryWindows& entry, const char** reason,
    DWORD* error_code, bool* mutation) {
  ScopedHandle parent = OpenRemovalParentWindows(
      root, entry.components, reason, error_code);
  if (!parent.valid()) {
    return false;
  }
  const std::wstring& name = entry.components.back();
  DWORD open_error = ERROR_SUCCESS;
  const ACCESS_MASK access = DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE |
      (entry.directory ? FILE_LIST_DIRECTORY : 0);
  ScopedHandle child(OpenRelativeMetadataHandle(
      parent.get(), name, access, entry.directory, &open_error));
  if (!child.valid()) {
    *reason = "tree_changed_during_delete";
    *error_code = open_error;
    return false;
  }
  bool reparse = false;
  FileIdentity identity {};
  FILE_STANDARD_INFO standard {};
  if (!ReadReparsePoint(child.get(), &reparse) || reparse ||
      !ReadIdentity(child.get(), &identity) ||
      !SameIdentity(identity, entry.identity) ||
      !ReadStandardInfo(child.get(), &standard) ||
      (standard.Directory != FALSE) != entry.directory ||
      (!entry.directory &&
       (standard.NumberOfLinks != 1 ||
        standard.EndOfFile.QuadPart != entry.size))) {
    *reason = reparse ? "tree_reparse_forbidden"
                      : "tree_changed_during_delete";
    *error_code = GetLastError();
    return false;
  }
  if (!MarkHandleForDeletion(child.get(), error_code)) {
    *reason = "delete_failed";
    return false;
  }
  child.reset();
  *mutation = true;
  const NamedEntry after = QueryNamedEntry(parent.get(), name);
  if (after.query_failed || after.exists) {
    *reason = after.exists ? "tree_changed_during_delete"
                           : "post_delete_state_ambiguous";
    *error_code = after.error_code;
    return false;
  }
  return true;
}

PublishResult RemoveTreeOnWindows(
    const std::wstring& parent_root, const std::wstring& source_name,
    const std::string& expected_parent_identity,
    const std::string& expected_source_identity,
    std::uint64_t expected_entries, std::uint64_t expected_bytes,
    std::uint64_t maximum_entries, std::uint64_t maximum_bytes,
    HANDLE held_parent = INVALID_HANDLE_VALUE) {
  if (parent_root.empty() || !IsValidLeafName(source_name) ||
      expected_entries > maximum_entries ||
      expected_bytes > maximum_bytes) {
    return InvalidInput();
  }
  DWORD parent_error = ERROR_SUCCESS;
  bool parent_reparse = false;
  ScopedHandle owned_parent;
  HANDLE parent = INVALID_HANDLE_VALUE;
  if (!PrepareOperationParentOnWindows(
          parent_root, held_parent, &owned_parent, &parent,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  FileIdentity parent_identity_value {};
  if (!ReadIdentity(parent, &parent_identity_value)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  const std::string parent_identity = IdentityString(parent_identity_value);
  if (parent_identity != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }

  DWORD source_error = ERROR_SUCCESS;
  ScopedHandle source(OpenRelativeMetadataHandle(
      parent, source_name,
      DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL |
          SYNCHRONIZE,
      true, &source_error));
  if (!source.valid()) {
    return NotCommitted(source_error == ERROR_FILE_NOT_FOUND ||
                                source_error == ERROR_PATH_NOT_FOUND
                            ? "source_missing"
                            : "source_invalid",
                        static_cast<std::uint64_t>(source_error));
  }
  bool source_reparse = false;
  FileIdentity source_identity_value {};
  if (!ReadReparsePoint(source.get(), &source_reparse) || source_reparse ||
      !ReadIdentity(source.get(), &source_identity_value) ||
      !IsDirectory(source.get())) {
    return NotCommitted(source_reparse ? "source_reparse_forbidden"
                                       : "source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  const std::string source_identity = IdentityString(source_identity_value);
  if (source_identity != expected_source_identity) {
    return NotCommitted("source_identity_mismatch", 0);
  }

  std::vector<std::byte> token_buffer;
  std::vector<BYTE> system_sid_buffer;
  std::vector<BYTE> administrators_sid_buffer;
  PSID current_user_sid = nullptr;
  PSID system_sid = nullptr;
  PSID administrators_sid = nullptr;
  DWORD security_error = ERROR_SUCCESS;
  std::string owner_identity;
  if (!ReadCurrentUserSid(&token_buffer, &current_user_sid, &security_error) ||
      !CreatePinnedWellKnownSid(WinLocalSystemSid, &system_sid_buffer,
                                &system_sid, &security_error) ||
      !CreatePinnedWellKnownSid(WinBuiltinAdministratorsSid,
                                &administrators_sid_buffer,
                                &administrators_sid, &security_error) ||
      !VerifyPrivateDirectorySecurityOnWindows(
          source.get(), current_user_sid, system_sid, administrators_sid,
          &owner_identity, &security_error)) {
    return NotCommitted("directory_security_invalid",
                        static_cast<std::uint64_t>(security_error));
  }

  std::vector<RemovalEntryWindows> plan;
  std::vector<std::wstring> components;
  std::uint64_t entries = 0;
  std::uint64_t bytes = 0;
  const char* reason = "tree_enumeration_failed";
  DWORD error_code = ERROR_SUCCESS;
  if (!CollectRemovalPlanWindows(
          source.get(), source_identity_value.volume_serial_number,
          &components, &plan, &entries, &bytes, maximum_entries,
          maximum_bytes, &reason, &error_code)) {
    return NotCommitted(reason, static_cast<std::uint64_t>(error_code));
  }
  if (entries != expected_entries || bytes != expected_bytes) {
    return NotCommitted("tree_inventory_mismatch", 0);
  }

  std::uint64_t removed_entries = 0;
  for (const RemovalEntryWindows& entry : plan) {
    bool mutation = false;
    if (!DeleteRemovalEntryWindows(
            source.get(), entry, &reason, &error_code, &mutation)) {
      if (mutation) {
        removed_entries += 1;
      }
      return removed_entries == 0
                 ? NotCommitted(reason,
                                static_cast<std::uint64_t>(error_code))
                 : Ambiguous(reason,
                             static_cast<std::uint64_t>(error_code));
    }
    removed_entries += 1;
  }
  if (!MarkHandleForDeletion(source.get(), &error_code)) {
    return removed_entries == 0
               ? NotCommitted("delete_failed",
                              static_cast<std::uint64_t>(error_code))
               : Ambiguous("delete_failed",
                           static_cast<std::uint64_t>(error_code));
  }
  source.reset();
  const NamedEntry after = QueryNamedEntry(parent, source_name);
  // The exact source handle was dispositioned, but a same-name replacement is
  // still a changed namespace, never proof of a clean completed removal.
  if (after.query_failed || after.exists) {
    return Ambiguous(after.exists ? "source_name_changed_after_delete"
                                  : "post_delete_state_ambiguous",
                     static_cast<std::uint64_t>(after.error_code));
  }
  return Removed(parent_identity, source_identity, entries, bytes);
}

bool IsAbsoluteWindowsCommand(const std::wstring& value) {
  return (value.size() >= 3 && IsAsciiDriveLetter(value[0]) &&
          value[1] == L':' && IsWindowsSeparator(value[2])) ||
         (value.size() >= 2 && IsWindowsSeparator(value[0]) &&
          IsWindowsSeparator(value[1]));
}

std::wstring QuoteWindowsCommandLineArgument(const std::wstring& value) {
  if (!value.empty() &&
      value.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    return value;
  }
  std::wstring result = L"\"";
  std::size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      backslashes += 1;
      continue;
    }
    if (character == L'\"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(L'\"');
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(character);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

ScopedHandle InheritableStandardHandle(DWORD standard_handle,
                                       DWORD null_access,
                                       DWORD* error_code) {
  HANDLE current = GetStdHandle(standard_handle);
  if (current != nullptr && current != INVALID_HANDLE_VALUE) {
    HANDLE duplicate = INVALID_HANDLE_VALUE;
    if (DuplicateHandle(GetCurrentProcess(), current, GetCurrentProcess(),
                        &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      *error_code = ERROR_SUCCESS;
      return ScopedHandle(duplicate);
    }
    *error_code = GetLastError();
    return ScopedHandle();
  }
  SECURITY_ATTRIBUTES attributes {};
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;
  HANDLE null_handle = CreateFileW(
      L"NUL", null_access,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &attributes,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (null_handle == INVALID_HANDLE_VALUE) {
    *error_code = GetLastError();
    return ScopedHandle();
  }
  *error_code = ERROR_SUCCESS;
  return ScopedHandle(null_handle);
}

int OwnedProcessFailure(const wchar_t* phase, DWORD error_code) {
  std::wcerr << L"run-owned " << phase << L" failed: " << error_code
             << L"\n";
  return kExitNotCommitted;
}

int RunOwnedWindowsProcess(int argc, wchar_t* argv[]) {
  if (argc < 3 || !IsAbsoluteWindowsCommand(argv[2])) {
    return OwnedProcessFailure(L"input", ERROR_INVALID_PARAMETER);
  }
  const std::wstring command(argv[2]);
  std::wstring command_line;
  for (int index = 2; index < argc; ++index) {
    if (!command_line.empty()) {
      command_line.push_back(L' ');
    }
    command_line += QuoteWindowsCommandLineArgument(argv[index]);
  }
  if (command_line.size() >= 32767) {
    return OwnedProcessFailure(L"command-line", ERROR_FILENAME_EXCED_RANGE);
  }

  ScopedHandle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.valid()) {
    return OwnedProcessFailure(L"create-job", GetLastError());
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits {};
  job_limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
          job.get(), JobObjectExtendedLimitInformation, &job_limits,
          sizeof(job_limits))) {
    return OwnedProcessFailure(L"configure-job", GetLastError());
  }

  DWORD standard_error = ERROR_SUCCESS;
  ScopedHandle standard_input = InheritableStandardHandle(
      STD_INPUT_HANDLE, GENERIC_READ, &standard_error);
  if (!standard_input.valid()) {
    return OwnedProcessFailure(L"stdin", standard_error);
  }
  ScopedHandle standard_output = InheritableStandardHandle(
      STD_OUTPUT_HANDLE, GENERIC_WRITE, &standard_error);
  if (!standard_output.valid()) {
    return OwnedProcessFailure(L"stdout", standard_error);
  }
  ScopedHandle standard_error_handle = InheritableStandardHandle(
      STD_ERROR_HANDLE, GENERIC_WRITE, &standard_error);
  if (!standard_error_handle.valid()) {
    return OwnedProcessFailure(L"stderr", standard_error);
  }

  HANDLE job_handles[] = {job.get()};
  HANDLE inherited_handles[] = {
      standard_input.get(),
      standard_output.get(),
      standard_error_handle.get(),
  };
  // Attribute values must outlive the attribute list itself. Declare the RAII
  // list after both backing arrays so its destructor runs first.
  ScopedProcThreadAttributeList attributes;
  DWORD attribute_error = ERROR_SUCCESS;
  if (!attributes.Initialize(2, &attribute_error)) {
    return OwnedProcessFailure(L"initialize-attributes", attribute_error);
  }
  if (!UpdateProcThreadAttribute(
          attributes.get(), 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, job_handles,
          sizeof(job_handles), nullptr, nullptr)) {
    return OwnedProcessFailure(L"job-attribute", GetLastError());
  }
  if (!UpdateProcThreadAttribute(
          attributes.get(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          inherited_handles, sizeof(inherited_handles), nullptr, nullptr)) {
    return OwnedProcessFailure(L"handle-attribute", GetLastError());
  }

  STARTUPINFOEXW startup {};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = standard_input.get();
  startup.StartupInfo.hStdOutput = standard_output.get();
  startup.StartupInfo.hStdError = standard_error_handle.get();
  startup.lpAttributeList = attributes.get();
  PROCESS_INFORMATION process_info {};
  if (!CreateProcessW(
          command.c_str(), command_line.data(), nullptr, nullptr, TRUE,
          CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
          nullptr, nullptr, &startup.StartupInfo, &process_info)) {
    return OwnedProcessFailure(L"create-process", GetLastError());
  }
  ScopedHandle process(process_info.hProcess);
  ScopedHandle thread(process_info.hThread);

  if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
    const DWORD resume_error = GetLastError();
    TerminateProcess(process.get(), kExitNotCommitted);
    WaitForSingleObject(process.get(), INFINITE);
    return OwnedProcessFailure(L"resume-process", resume_error);
  }
  thread.reset();
  const DWORD wait_result = WaitForSingleObject(process.get(), INFINITE);
  if (wait_result != WAIT_OBJECT_0) {
    return OwnedProcessFailure(L"wait-process", GetLastError());
  }
  DWORD exit_code = 0;
  if (!GetExitCodeProcess(process.get(), &exit_code) ||
      exit_code == STILL_ACTIVE) {
    return OwnedProcessFailure(L"exit-code", GetLastError());
  }

  // A normal return explicitly drains descendants. If this helper is killed
  // by Node timeout/maxBuffer/abort instead, KILL_ON_JOB_CLOSE applies the
  // same ownership boundary when the kernel closes this Job handle.
  if (!TerminateJobObject(job.get(), kExitNotCommitted)) {
    return OwnedProcessFailure(L"terminate-descendants", GetLastError());
  }
  bool drained = false;
  for (DWORD attempt = 0; attempt < 500; ++attempt) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting {};
    if (!QueryInformationJobObject(
            job.get(), JobObjectBasicAccountingInformation, &accounting,
            sizeof(accounting), nullptr)) {
      return OwnedProcessFailure(L"query-descendants", GetLastError());
    }
    if (accounting.ActiveProcesses == 0) {
      drained = true;
      break;
    }
    Sleep(10);
  }
  if (!drained) {
    return OwnedProcessFailure(L"wait-descendants", ERROR_TIMEOUT);
  }
  job.reset();
  return static_cast<int>(exit_code);
}

bool RenameHandleNoReplace(HANDLE source, HANDLE parent,
                           const std::wstring& destination_name,
                           DWORD* error_code) {
  const DWORD destination_bytes =
      static_cast<DWORD>(destination_name.size() * sizeof(wchar_t));
  const std::size_t rename_info_bytes =
      sizeof(FILE_RENAME_INFO) + destination_bytes;
  std::vector<std::byte> rename_buffer(rename_info_bytes, std::byte{0});
  auto* rename_info = reinterpret_cast<FILE_RENAME_INFO*>(rename_buffer.data());
  rename_info->ReplaceIfExists = FALSE;
  rename_info->RootDirectory = parent;
  rename_info->FileNameLength = destination_bytes;
  std::memcpy(rename_info->FileName, destination_name.data(), destination_bytes);
  if (!SetFileInformationByHandle(source, FileRenameInfo, rename_info,
                                  static_cast<DWORD>(rename_buffer.size()))) {
    *error_code = GetLastError();
    return false;
  }
  *error_code = ERROR_SUCCESS;
  return true;
}

PublishResult InspectOnWindows(const std::wstring& parent_root,
                               const std::wstring& source_name,
                               HANDLE held_parent = INVALID_HANDLE_VALUE) {
  if (parent_root.empty() || !IsValidLeafName(source_name)) {
    return InvalidInput();
  }
  DWORD parent_error = ERROR_SUCCESS;
  bool parent_reparse = false;
  ScopedHandle owned_parent;
  HANDLE parent = INVALID_HANDLE_VALUE;
  if (!PrepareOperationParentOnWindows(
          parent_root, held_parent, &owned_parent, &parent,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  FileIdentity parent_identity {};
  if (!ReadIdentity(parent, &parent_identity)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  DWORD source_error = ERROR_SUCCESS;
  ScopedHandle source(OpenRelativeMetadataHandle(
      parent, source_name, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      false, &source_error));
  if (!source.valid()) {
    return NotCommitted(source_error == ERROR_FILE_NOT_FOUND ||
                                source_error == ERROR_PATH_NOT_FOUND
                            ? "source_missing"
                            : "source_invalid",
                        static_cast<std::uint64_t>(source_error));
  }
  bool source_reparse = false;
  if (!ReadReparsePoint(source.get(), &source_reparse)) {
    return NotCommitted("source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (source_reparse) {
    return NotCommitted("source_reparse_forbidden", 0);
  }
  if (!IsDirectory(source.get())) {
    return NotCommitted("source_invalid", 0);
  }
  FileIdentity identity {};
  if (!ReadIdentity(source.get(), &identity)) {
    return NotCommitted("source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  return Inspected(IdentityString(parent_identity), IdentityString(identity));
}

#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
bool RunPostCommitTestGateOnWindows(
    const std::wstring& parent_root, HANDLE parent,
    const std::wstring& ready_name, const std::wstring& gate_name,
    const char** reason, DWORD* error_code);
#endif

PublishResult PublishOnWindows(const std::wstring& parent_root,
                               const std::wstring& source_name,
                               const std::wstring& destination_name,
                               const std::string& expected_parent_identity,
                               const std::string& expected_source_identity,
                               HANDLE held_parent = INVALID_HANDLE_VALUE
#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
                               , const std::wstring* post_commit_ready_name = nullptr,
                               const std::wstring* post_commit_gate_name = nullptr
#endif
                               ) {
  if (parent_root.empty() || !IsValidLeafName(source_name) ||
      !IsValidLeafName(destination_name) ||
      _wcsicmp(source_name.c_str(), destination_name.c_str()) == 0) {
    return InvalidInput();
  }

  DWORD parent_error = ERROR_SUCCESS;
  bool parent_reparse = false;
  ScopedHandle owned_parent;
  HANDLE parent = INVALID_HANDLE_VALUE;
  if (!PrepareOperationParentOnWindows(
          parent_root, held_parent, &owned_parent, &parent,
          &parent_error, &parent_reparse)) {
    return NotCommitted(parent_reparse ? "parent_reparse_forbidden"
                                       : "parent_invalid",
                        static_cast<std::uint64_t>(parent_error));
  }
  FileIdentity parent_identity {};
  if (!ReadIdentity(parent, &parent_identity)) {
    return NotCommitted("parent_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (IdentityString(parent_identity) != expected_parent_identity) {
    return NotCommitted("parent_identity_mismatch", 0);
  }
  const char* named_parent_reason = "parent_identity_mismatch";
  DWORD named_parent_error = ERROR_SUCCESS;
  if (!NamedParentMatchesHeldOnWindows(
          parent_root, parent_identity, &named_parent_reason,
          &named_parent_error)) {
    return NotCommitted(
        named_parent_reason,
        static_cast<std::uint64_t>(named_parent_error));
  }

  DWORD source_open_error = ERROR_SUCCESS;
  ScopedHandle source(OpenRelativeMetadataHandle(
      parent, source_name, DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      false, &source_open_error));
  if (!source.valid()) {
    return NotCommitted(source_open_error == ERROR_FILE_NOT_FOUND ||
                                source_open_error == ERROR_PATH_NOT_FOUND
                            ? "source_missing"
                            : "source_invalid",
                        static_cast<std::uint64_t>(source_open_error));
  }
  bool source_reparse = false;
  if (!ReadReparsePoint(source.get(), &source_reparse)) {
    return NotCommitted("source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (source_reparse) {
    return NotCommitted("source_reparse_forbidden", 0);
  }
  if (!IsDirectory(source.get())) {
    return NotCommitted("source_invalid", 0);
  }
  FileIdentity source_identity {};
  if (!ReadIdentity(source.get(), &source_identity)) {
    return NotCommitted("source_invalid",
                        static_cast<std::uint64_t>(GetLastError()));
  }
  if (IdentityString(source_identity) != expected_source_identity) {
    return NotCommitted("source_identity_mismatch", 0);
  }

  if (!NamedParentMatchesHeldOnWindows(
          parent_root, parent_identity, &named_parent_reason,
          &named_parent_error)) {
    return NotCommitted(
        named_parent_reason,
        static_cast<std::uint64_t>(named_parent_error));
  }

  // This is the single commit syscall. ReplaceIfExists=FALSE is the Windows
  // no-replace contract, while the source and destination parent stay pinned
  // by handles for the whole operation.
  DWORD commit_error = ERROR_SUCCESS;
  const bool commit_result = RenameHandleNoReplace(
      source.get(), parent, destination_name, &commit_error);

#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
  if (post_commit_ready_name != nullptr && post_commit_gate_name != nullptr) {
    const char* test_gate_reason = "test_post_commit_gate_failed";
    DWORD test_gate_error = ERROR_SUCCESS;
    if (!RunPostCommitTestGateOnWindows(
            parent_root, parent, *post_commit_ready_name,
            *post_commit_gate_name, &test_gate_reason, &test_gate_error)) {
      return Ambiguous(
          test_gate_reason,
          static_cast<std::uint64_t>(test_gate_error));
    }
  }
#endif

  const NamedEntry source_after = QueryNamedEntry(parent, source_name);
  const NamedEntry destination_after = QueryNamedEntry(parent, destination_name);
  const bool source_still_named = source_after.exists &&
                                  SameIdentity(source_after.identity, source_identity);
  const bool destination_names_source = destination_after.exists &&
                                        SameIdentity(destination_after.identity,
                                                     source_identity);

  if (!NamedParentMatchesHeldOnWindows(
          parent_root, parent_identity, &named_parent_reason,
          &named_parent_error)) {
    return Ambiguous(
        named_parent_reason,
        static_cast<std::uint64_t>(named_parent_error));
  }

  if (!source_after.query_failed && !destination_after.query_failed &&
      destination_names_source && !source_after.exists) {
    return Committed();
  }
  if (commit_result || source_after.query_failed ||
      destination_after.query_failed || !source_still_named) {
    return Ambiguous("post_commit_state_ambiguous",
                     static_cast<std::uint64_t>(commit_error));
  }
  if (destination_after.exists) {
    return NotCommitted("destination_exists",
                        static_cast<std::uint64_t>(commit_error));
  }
  return NotCommitted("native_rejected", static_cast<std::uint64_t>(commit_error));
}

bool ProtocolUtf8ToWide(const std::string& value, std::wstring* output) {
  if (value.empty() ||
      value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return false;
  }
  const int required = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (required <= 0) {
    return false;
  }
  output->resize(static_cast<std::size_t>(required));
  return MultiByteToWideChar(
             CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
             static_cast<int>(value.size()), output->data(), required) == required;
}

bool ProtocolValueIsAscii(const std::string& value) {
  if (value.empty()) {
    return false;
  }
  for (const unsigned char character : value) {
    if (character > 0x7f) {
      return false;
    }
  }
  return true;
}

#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
constexpr std::uint64_t kTestPublishGateTimeoutMs = 10000;

bool CreateTestMarkerOnWindows(const std::wstring& parent_root,
                               const std::wstring& name,
                               DWORD* error_code) {
  if (!IsValidLeafName(name)) {
    *error_code = ERROR_INVALID_NAME;
    return false;
  }
  const std::wstring path = parent_root + L"\\" + name;
  ScopedHandle marker(CreateFileW(
      path.c_str(), GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (!marker.valid()) {
    *error_code = GetLastError();
    return false;
  }
  *error_code = ERROR_SUCCESS;
  return true;
}

bool WaitForTestGateOnWindows(HANDLE parent, const std::wstring& name,
                              DWORD* error_code) {
  if (!IsValidLeafName(name)) {
    *error_code = ERROR_INVALID_NAME;
    return false;
  }
  const ULONGLONG deadline = GetTickCount64() + kTestPublishGateTimeoutMs;
  while (true) {
    const NamedEntry gate = QueryNamedEntry(parent, name);
    if (gate.query_failed) {
      *error_code = gate.error_code;
      return false;
    }
    if (gate.exists) {
      *error_code = ERROR_SUCCESS;
      return true;
    }
    if (GetTickCount64() >= deadline) {
      *error_code = ERROR_TIMEOUT;
      return false;
    }
    Sleep(10);
  }
}

bool RunPostCommitTestGateOnWindows(
    const std::wstring& parent_root, HANDLE parent,
    const std::wstring& ready_name, const std::wstring& gate_name,
    const char** reason, DWORD* error_code) {
  if (!CreateTestMarkerOnWindows(parent_root, ready_name, error_code)) {
    *reason = "test_post_commit_ready_create_failed";
    return false;
  }
  if (!WaitForTestGateOnWindows(parent, gate_name, error_code)) {
    *reason = *error_code == ERROR_TIMEOUT
                  ? "test_post_commit_gate_timeout"
                  : "test_post_commit_gate_wait_failed";
    return false;
  }
  *reason = "test_post_commit_gate_released";
  *error_code = ERROR_SUCCESS;
  return true;
}
#endif

PublishResult DispatchParentLockOperationOnWindows(
    const std::string& operation, const std::vector<std::string>& arguments,
    const std::wstring& parent_root, HANDLE held_parent,
    bool* valid_operation) {
  *valid_operation = true;
  if (operation == "inspect" && arguments.size() == 1) {
    std::wstring source_name;
    if (!ProtocolUtf8ToWide(arguments[0], &source_name)) {
      return InvalidInput();
    }
    return InspectOnWindows(parent_root, source_name, held_parent);
  }
  if (operation == "secure-private" &&
      (arguments.size() == 1 || arguments.size() == 3)) {
    std::wstring directory_name;
    if (!ProtocolUtf8ToWide(arguments[0], &directory_name) ||
        (arguments.size() == 3 &&
         (!ProtocolValueIsAscii(arguments[1]) ||
          !ProtocolValueIsAscii(arguments[2])))) {
      return InvalidInput();
    }
    return PrivateDirectoryOnWindows(
        parent_root, directory_name, true,
        arguments.size() == 3 ? arguments[1] : "",
        arguments.size() == 3 ? arguments[2] : "", held_parent);
  }
  if (operation == "verify-private" && arguments.size() == 3) {
    std::wstring directory_name;
    if (!ProtocolUtf8ToWide(arguments[0], &directory_name) ||
        !ProtocolValueIsAscii(arguments[1]) ||
        !ProtocolValueIsAscii(arguments[2])) {
      return InvalidInput();
    }
    return PrivateDirectoryOnWindows(
        parent_root, directory_name, false, arguments[1], arguments[2],
        held_parent);
  }
  if (operation == "publish" && arguments.size() == 4) {
    std::wstring source_name;
    std::wstring destination_name;
    if (!ProtocolUtf8ToWide(arguments[0], &source_name) ||
        !ProtocolUtf8ToWide(arguments[1], &destination_name) ||
        !ProtocolValueIsAscii(arguments[2]) ||
        !ProtocolValueIsAscii(arguments[3])) {
      return InvalidInput();
    }
    return PublishOnWindows(
        parent_root, source_name, destination_name, arguments[2], arguments[3],
        held_parent);
  }
  if ((operation == "remove-tree" || operation == "remove-artifact-tree") &&
      arguments.size() == 5) {
    std::wstring source_name;
    std::uint64_t expected_entries = 0;
    std::uint64_t expected_bytes = 0;
    const bool artifact_removal = operation == "remove-artifact-tree";
    const std::uint64_t maximum_entries = artifact_removal
        ? kMaxArtifactRemovalEntries : kMaxRemovalEntries;
    const std::uint64_t maximum_bytes = artifact_removal
        ? kMaxArtifactRemovalBytes : kMaxRemovalBytes;
    if (!ProtocolUtf8ToWide(arguments[0], &source_name) ||
        !ProtocolValueIsAscii(arguments[1]) ||
        !ProtocolValueIsAscii(arguments[2]) ||
        !ParseCanonicalUnsigned(
            arguments[3], maximum_entries, &expected_entries) ||
        !ParseCanonicalUnsigned(
            arguments[4], maximum_bytes, &expected_bytes)) {
      return InvalidInput();
    }
    return RemoveTreeOnWindows(
        parent_root, source_name, arguments[1], arguments[2], expected_entries,
        expected_bytes, maximum_entries, maximum_bytes, held_parent);
  }
  if (operation == "remove-unsecured-empty" && arguments.size() == 3) {
    std::wstring source_name;
    if (!ProtocolUtf8ToWide(arguments[0], &source_name) ||
        !ProtocolValueIsAscii(arguments[1]) ||
        !ProtocolValueIsAscii(arguments[2])) {
      return InvalidInput();
    }
    return RemoveUnsecuredEmptyOnWindows(
        parent_root, source_name, arguments[1], arguments[2], held_parent);
  }
#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
  if (operation == "test-hold-publish" && arguments.size() == 7) {
    std::wstring source_name;
    std::wstring destination_name;
    std::wstring ready_name;
    std::wstring gate_name;
    std::wstring completion_name;
    if (!ProtocolUtf8ToWide(arguments[0], &source_name) ||
        !ProtocolUtf8ToWide(arguments[1], &destination_name) ||
        !ProtocolValueIsAscii(arguments[2]) ||
        !ProtocolValueIsAscii(arguments[3]) ||
        !ProtocolUtf8ToWide(arguments[4], &ready_name) ||
        !ProtocolUtf8ToWide(arguments[5], &gate_name) ||
        !ProtocolUtf8ToWide(arguments[6], &completion_name)) {
      return InvalidInput();
    }
    DWORD marker_error = ERROR_SUCCESS;
    if (!CreateTestMarkerOnWindows(
            parent_root, ready_name, &marker_error)) {
      return NotCommitted(
          "test_ready_create_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    if (!WaitForTestGateOnWindows(
            held_parent, gate_name, &marker_error)) {
      return NotCommitted(
          marker_error == ERROR_TIMEOUT ? "test_gate_timeout"
                                        : "test_gate_wait_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    PublishResult result = PublishOnWindows(
        parent_root, source_name, destination_name, arguments[2], arguments[3],
        held_parent);
    if (std::strcmp(result.outcome, "committed") == 0 &&
        !CreateTestMarkerOnWindows(
            parent_root, completion_name, &marker_error)) {
      return Ambiguous(
          "test_completion_create_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    return result;
  }
  if (operation == "test-post-commit-hold-publish" &&
      arguments.size() == 7) {
    std::wstring source_name;
    std::wstring destination_name;
    std::wstring ready_name;
    std::wstring gate_name;
    std::wstring completion_name;
    if (!ProtocolUtf8ToWide(arguments[0], &source_name) ||
        !ProtocolUtf8ToWide(arguments[1], &destination_name) ||
        !ProtocolValueIsAscii(arguments[2]) ||
        !ProtocolValueIsAscii(arguments[3]) ||
        !ProtocolUtf8ToWide(arguments[4], &ready_name) ||
        !ProtocolUtf8ToWide(arguments[5], &gate_name) ||
        !ProtocolUtf8ToWide(arguments[6], &completion_name)) {
      return InvalidInput();
    }
    PublishResult result = PublishOnWindows(
        parent_root, source_name, destination_name, arguments[2], arguments[3],
        held_parent, &ready_name, &gate_name);
    DWORD marker_error = ERROR_SUCCESS;
    if (std::strcmp(result.outcome, "committed") == 0 &&
        !CreateTestMarkerOnWindows(
            parent_root, completion_name, &marker_error)) {
      return Ambiguous(
          "test_completion_create_failed",
          static_cast<std::uint64_t>(marker_error));
    }
    return result;
  }
#endif
  *valid_operation = false;
  return InvalidInput();
}

#endif

}  // namespace

#if defined(__APPLE__)

int main(int argc, char* argv[]) {
  if (argc == 2 && std::string(argv[1]) == "probe") {
    return EmitResult(Inspected({}, {}));
  }
  if (argc == 4 && std::string(argv[1]) == "hold-parent-lock") {
    std::uint64_t timeout_ms = 0;
    if (!ParseBoundedUnsignedDarwin(
            argv[3], kMaxParentLockTimeoutMs, &timeout_ms)) {
      return EmitResult(InvalidInput());
    }
    return HoldParentLockOnDarwin(argv[2], timeout_ms);
  }
  if (argc == 4 && std::string(argv[1]) == "inspect") {
    return EmitResult(InspectOnDarwin(argv[2], argv[3]));
  }
  if (argc == 6 && std::string(argv[1]) == "verify-private") {
    return EmitResult(PrivateDirectoryOnDarwin(
        argv[2], argv[3], false, argv[4], argv[5]));
  }
  return EmitResult(InvalidInput());
}

#elif defined(_WIN32)

bool NarrowAscii(const std::wstring& value, std::string* output) {
  output->clear();
  output->reserve(value.size());
  for (const wchar_t character : value) {
    if (character > 0x7f) {
      return false;
    }
    output->push_back(static_cast<char>(character));
  }
  return true;
}

bool ParseBoundedUnsignedWindows(const wchar_t* value,
                                 std::uint64_t maximum,
                                 std::uint64_t* output) {
  if (value == nullptr || *value == L'\0') {
    return false;
  }
  wchar_t* end = nullptr;
  const unsigned long long parsed = _wcstoui64(value, &end, 10);
  if (end == value || *end != L'\0' || parsed > maximum) {
    return false;
  }
  *output = static_cast<std::uint64_t>(parsed);
  return true;
}

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 2 && std::wstring(argv[1]) == L"probe") {
    return EmitResult(Inspected({}, {}));
  }
#if defined(LING_CUA_DRIVER_PACKAGE_STAGING_TESTS)
  if (argc == 5 &&
      std::wstring(argv[1]) == L"hold-parent-lock-test-wait-ready") {
    std::uint64_t timeout_ms = 0;
    if (!ParseBoundedUnsignedWindows(
            argv[3], kMaxParentLockTimeoutMs, &timeout_ms) ||
        !IsValidLeafName(argv[4])) {
      return EmitResult(InvalidInput());
    }
    return HoldParentLockOnWindows(argv[2], timeout_ms, argv[4]);
  }
#endif
  if (argc == 4 && std::wstring(argv[1]) == L"hold-parent-lock") {
    std::uint64_t timeout_ms = 0;
    if (!ParseBoundedUnsignedWindows(
            argv[3], kMaxParentLockTimeoutMs, &timeout_ms)) {
      return EmitResult(InvalidInput());
    }
    return HoldParentLockOnWindows(argv[2], timeout_ms);
  }
  if (argc >= 3 && std::wstring(argv[1]) == L"run-owned") {
    return RunOwnedWindowsProcess(argc, argv);
  }
  if (argc == 4 && std::wstring(argv[1]) == L"inspect") {
    return EmitResult(InspectOnWindows(argv[2], argv[3]));
  }
  if (argc == 6 && std::wstring(argv[1]) == L"verify-private") {
    std::string expected_parent_identity;
    std::string expected_directory_identity;
    if (!NarrowAscii(argv[4], &expected_parent_identity) ||
        !NarrowAscii(argv[5], &expected_directory_identity)) {
      return EmitResult(InvalidInput());
    }
    return EmitResult(PrivateDirectoryOnWindows(
        argv[2], argv[3], false, expected_parent_identity,
        expected_directory_identity));
  }
  return EmitResult(InvalidInput());
}

#endif

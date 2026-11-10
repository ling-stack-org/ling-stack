#include <node_api.h>

#include "runtime.h"

#include <functional>
#include <cmath>
#include <exception>
#include <stdexcept>
#include <utility>

namespace {
using namespace office_local;

const napi_type_tag session_tag = {0x4f66666963654c6fULL, 0x63616c5365737331ULL};
const napi_type_tag resource_tag = {0x4f66666963654c6fULL, 0x63616c5265737331ULL};
struct SessionCap { std::shared_ptr<Session> owner; };
struct ResourceCap { std::shared_ptr<Session> owner; Resource* resource; };
struct ReplyExceptionLatch {
  Session& session;
  int exceptions = std::uncaught_exceptions();
  ~ReplyExceptionLatch() noexcept {
    if (std::uncaught_exceptions() > exceptions) {
      session.ever_failed = true;
      if (session.phase != Phase::closed) session.phase = Phase::blocked;
    }
  }
};

void check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("napi_failure");
}

napi_value object(napi_env env) { napi_value value; check(napi_create_object(env, &value)); return value; }
napi_value string(napi_env env, const std::string& text) {
  napi_value value; check(napi_create_string_utf8(env, text.data(), text.size(), &value)); return value;
}
napi_value boolean(napi_env env, bool enabled) {
  napi_value value; check(napi_get_boolean(env, enabled, &value)); return value;
}
napi_value number(napi_env env, int64_t integer) {
  napi_value value; check(napi_create_int64(env, integer, &value)); return value;
}
void set(napi_env env, napi_value target, const char* name, napi_value value) {
  check(napi_set_named_property(env, target, name, value));
}

std::vector<napi_value> arguments(napi_env env, napi_callback_info info, size_t count) {
  // Request an extra argument so surplus input cannot silently change meaning.
  std::vector<napi_value> values(count + 1);
  size_t actual = values.size();
  check(napi_get_cb_info(env, info, &actual, values.data(), nullptr, nullptr));
  if (actual != count) throw std::runtime_error("invalid_argument_count");
  values.resize(count); return values;
}

std::string get_string(napi_env env, napi_value value) {
  napi_valuetype type; check(napi_typeof(env, value, &type));
  if (type != napi_string) throw std::runtime_error("expected_string");
  size_t size = 0; check(napi_get_value_string_utf8(env, value, nullptr, 0, &size));
  if (size > 4096) throw std::runtime_error("string_too_large");
  std::vector<char> bytes(size + 1);
  size_t copied = 0; check(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &copied));
  return {bytes.data(), copied};
}

uint64_t get_budget(napi_env env, napi_value value, uint64_t maximum = 50ULL * 1024 * 1024 + 1) {
  napi_valuetype type; check(napi_typeof(env, value, &type));
  double integer = 0;
  if (type != napi_number || napi_get_value_double(env, value, &integer) != napi_ok
      || !std::isfinite(integer) || integer < 0 || std::floor(integer) != integer
      || integer > static_cast<double>(maximum)) throw std::runtime_error("invalid_read_budget");
  return static_cast<uint64_t>(integer);
}

template <typename T> T* unwrap(napi_env env, napi_value value, const napi_type_tag& tag) {
  napi_valuetype type; check(napi_typeof(env, value, &type));
  if (type != napi_object) throw std::runtime_error("invalid_capability");
  bool matches = false;
  if (napi_check_object_type_tag(env, value, &tag, &matches) != napi_ok || !matches)
    throw std::runtime_error("invalid_capability");
  void* pointer = nullptr; check(napi_unwrap(env, value, &pointer));
  if (!pointer) throw std::runtime_error("invalid_capability");
  return static_cast<T*>(pointer);
}

std::shared_ptr<Session> session(napi_env env, napi_value value) {
  return unwrap<SessionCap>(env, value, session_tag)->owner;
}
Resource& resource(napi_env env, napi_value value, const std::shared_ptr<Session>& owner) {
  auto* cap = unwrap<ResourceCap>(env, value, resource_tag);
  if (cap->owner.get() != owner.get()) throw std::runtime_error("foreign_session_capability");
  return *cap->resource;
}

void finalize_session(napi_env, void* pointer, void*) { delete static_cast<SessionCap*>(pointer); }
void finalize_resource(napi_env, void* pointer, void*) { delete static_cast<ResourceCap*>(pointer); }

napi_value wrap_session(napi_env env, const std::shared_ptr<Session>& owner) {
  napi_value value = object(env);
  auto cap = std::make_unique<SessionCap>(); cap->owner = owner;
  check(napi_type_tag_object(env, value, &session_tag));
  check(napi_wrap(env, value, cap.get(), finalize_session, nullptr, nullptr));
  cap.release(); return value;
}
napi_value wrap_resource(napi_env env, const std::shared_ptr<Session>& owner, Resource& held) {
  napi_value value = object(env);
  auto cap = std::make_unique<ResourceCap>(); cap->owner = owner; cap->resource = &held;
  check(napi_type_tag_object(env, value, &resource_tag));
  check(napi_wrap(env, value, cap.get(), finalize_resource, nullptr, nullptr));
  cap.release(); return value;
}

std::string decimal_ns(int64_t seconds, int32_t nanos) {
  // Wide intermediate avoids overflow even for unusual filesystem timestamps.
  __int128 value = static_cast<__int128>(seconds) * 1000000000 + nanos;
  const bool negative = value < 0;
  if (negative) value = -value;
  std::string digits;
  do { digits.insert(digits.begin(), static_cast<char>('0' + value % 10)); value /= 10; } while (value);
  return negative ? "-" + digits : digits;
}

napi_value identity_fact(napi_env env, const Identity& identity) {
  auto value = object(env);
  set(env, value, "device", string(env, std::to_string(identity.device)));
  set(env, value, "inode", string(env, std::to_string(identity.inode)));
  set(env, value, "sizeBytes", string(env, std::to_string(identity.size_bytes)));
  set(env, value, "modifiedNs", string(env, decimal_ns(identity.modified_seconds, identity.modified_nanos)));
  set(env, value, "changedNs", string(env, decimal_ns(identity.changed_seconds, identity.changed_nanos)));
  set(env, value, "mode", number(env, identity.mode));
  set(env, value, "isFile", boolean(env, identity.is_file));
  set(env, value, "isDirectory", boolean(env, identity.is_directory));
  return value;
}

napi_value fact(napi_env env, const Resource& held) {
  napi_value value = object(env);
  set(env, value, "lifetimeId", string(env, held.id));
  set(env, value, "kind", string(env, held.kind));
  set(env, value, "basename", string(env, held.basename));
  set(env, value, "parentLifetimeId", string(env, held.parent_id));
  set(env, value, "state", string(env, state_name(held.state)));
  set(env, value, "identityObserved", boolean(env, held.observed));
  set(env, value, "device", string(env, std::to_string(held.device)));
  set(env, value, "inode", string(env, std::to_string(held.inode)));
  set(env, value, "bytesWritten", string(env, std::to_string(held.bytes_written)));
  set(env, value, "fsyncReturned", boolean(env, held.synced));
  if (held.observed) {
    set(env, value, "initialIdentity", identity_fact(env, held.initial_identity));
    set(env, value, "identity", identity_fact(env, held.current_identity));
    set(env, value, "initialObservedAtMonotonicNs", string(env, std::to_string(held.initial_observed_monotonic_ns)));
    set(env, value, "observedAtMonotonicNs", string(env, std::to_string(held.observed_monotonic_ns)));
  }
  return value;
}

napi_value call_facts(napi_env env, const std::vector<Call>& native_calls) {
  napi_value calls;
  check(napi_create_array_with_length(env, native_calls.size(), &calls));
  for (uint32_t i = 0; i < native_calls.size(); ++i) {
    const auto& call = native_calls[i];
    napi_value item = object(env);
    set(env, item, "syscall", string(env, call.name));
    set(env, item, "resourceLifetimeId", string(env, call.resource->id));
    set(env, item, "parentLifetimeId", string(env, call.resource->parent_id));
    set(env, item, "nativeReturnState", string(env, call.has_returned ? "returned" : "not_returned"));
    set(env, item, "calledAtMonotonicNs", string(env, std::to_string(call.called_monotonic_ns)));
    set(env, item, "returnedAtMonotonicNs", string(env, std::to_string(call.returned_monotonic_ns)));
    if (call.has_io) {
      set(env, item, "requestedBytes", string(env, std::to_string(call.requested_bytes)));
      set(env, item, "offset", string(env, std::to_string(call.offset)));
    }
    if (call.entry_name) set(env, item, "entryName", string(env, call.entry_name));
    if (call.has_identity) set(env, item, "identity", identity_fact(env, call.identity));
    if (call.has_returned) {
      const std::string syscall(call.name);
      const bool descriptor = syscall == "open" || syscall == "openat" || syscall == "openat_create_exclusive";
      set(env, item, "returned", descriptor && call.returned >= 0
          ? string(env, "descriptor_acquired_redacted") : number(env, call.returned));
      set(env, item, "success", boolean(env, call.returned >= 0));
      set(env, item, "errno", number(env, call.error));
    }
    check(napi_set_element(env, calls, i, item));
  }
  return calls;
}

napi_value readback_fact(napi_env env, const Readback& readback) {
  auto value = object(env);
  set(env, value, "operationId", string(env, readback.operation_id));
  set(env, value, "resourceLifetimeId", string(env, readback.resource->id));
  set(env, value, "expectedBytes", string(env, std::to_string(readback.expected_bytes)));
  set(env, value, "budgetBytes", string(env, std::to_string(readback.budget_bytes)));
  set(env, value, "bytesRead", string(env, std::to_string(readback.bytes_read)));
  set(env, value, "maximumSyscallAttempts", string(env, std::to_string(readback.maximum_syscall_attempts)));
  set(env, value, "syscallAttempts", string(env, std::to_string(readback.syscall_attempts)));
  set(env, value, "eofObserved", boolean(env, readback.eof_observed));
  set(env, value, "identitiesMatch", boolean(env, readback.identities_match));
  set(env, value, "success", boolean(env, readback.success));
  set(env, value, "nativeOutcome", string(env, readback.native_outcome));
  set(env, value, "calls", call_facts(env, readback.calls));
  if (readback.blocker_code) set(env, value, "blockerCode", string(env, readback.blocker_code));
  if (readback.before_observed) set(env, value, "identityBefore", identity_fact(env, readback.before));
  if (readback.after_observed) set(env, value, "identityAfter", identity_fact(env, readback.after));
  return value;
}

napi_value installation_fact(napi_env env, const Installation& installation) {
  auto value = object(env);
  set(env, value, "treeLifetimeId", string(env, installation.tree->id));
  set(env, value, "sourceParentLifetimeId", string(env, installation.source_parent->id));
  set(env, value, "destinationParentLifetimeId", string(env, installation.destination_parent->id));
  set(env, value, "destinationName", string(env, installation.destination_name));
  set(env, value, "entered", boolean(env, installation.entered));
  set(env, value, "nativeReturnState", string(env, installation.has_returned ? "returned" : "not_returned"));
  set(env, value, "calledAtMonotonicNs", string(env, std::to_string(installation.called_monotonic_ns)));
  set(env, value, "returnedAtMonotonicNs", string(env, std::to_string(installation.returned_monotonic_ns)));
  if (installation.has_returned) {
    set(env, value, "returned", number(env, installation.returned));
    set(env, value, "errno", number(env, installation.error));
  }
  napi_value entries;
  check(napi_create_array_with_length(env, installation.entries.size(), &entries));
  for (uint32_t i = 0; i < installation.entries.size(); ++i) {
    const auto& entry = installation.entries[i];
    auto item = object(env);
    set(env, item, "resourceLifetimeId", string(env, entry.original->id));
    set(env, item, "parentLifetimeId", string(env, entry.original_parent->id));
    set(env, item, "expectedBytes", string(env, std::to_string(entry.expected_bytes)));
    check(napi_set_element(env, entries, i, item));
  }
  set(env, value, "entries", entries);
  return value;
}

napi_value publication_fact(napi_env env, const Publication& publication) {
  auto value = object(env);
  set(env, value, "operationId", string(env, publication.operation_id));
  set(env, value, "observationBasis", string(env, "original_destination_parent_relative"));
  set(env, value, "expectedBytes", string(env, std::to_string(publication.expected_bytes)));
  set(env, value, "budgetBytes", string(env, std::to_string(publication.budget_bytes)));
  set(env, value, "maximumCalls", string(env, std::to_string(publication.maximum_calls)));
  set(env, value, "success", boolean(env, publication.success));
  set(env, value, "nativeOutcome", string(env, publication.native_outcome));
  set(env, value, "calls", call_facts(env, publication.calls));
  if (publication.blocker_code) set(env, value, "blockerCode", string(env, publication.blocker_code));
  napi_value entries;
  check(napi_create_array_with_length(env, publication.entries.size(), &entries));
  for (uint32_t i = 0; i < publication.entries.size(); ++i) {
    const auto& entry = publication.entries[i];
    auto item = object(env);
    set(env, item, "originalLifetimeId", string(env, entry.original->id));
    if (entry.observed) set(env, item, "observedLifetimeId", string(env, entry.observed->id));
    if (entry.readback) set(env, item, "readback", readback_fact(env, *entry.readback));
    check(napi_set_element(env, entries, i, item));
  }
  set(env, value, "entries", entries);
  return value;
}

napi_value snapshot(napi_env env, const Session& owner) {
  napi_value value = object(env), resources;
  check(napi_create_array_with_length(env, owner.resources.size(), &resources));
  for (uint32_t i = 0; i < owner.resources.size(); ++i)
    check(napi_set_element(env, resources, i, fact(env, *owner.resources[i])));
  set(env, value, "sessionNonce", string(env, owner.nonce));
  set(env, value, "phase", string(env, phase_name(owner.phase)));
  set(env, value, "resources", resources);
  set(env, value, "installationEntered", boolean(env, owner.installation_entered));
  set(env, value, "residualCreation", boolean(env, owner.residual_creation));
  set(env, value, "everFailed", boolean(env, owner.ever_failed));
  set(env, value, "publicationObservationClaimed", boolean(env, owner.publication_observation_claimed));
  set(env, value, "cancelRequested", boolean(env, owner.cancel_requested));
  if (owner.installation) set(env, value, "installation", installation_fact(env, *owner.installation));
  if (owner.publication) set(env, value, "publication", publication_fact(env, *owner.publication));
  napi_value readbacks;
  check(napi_create_array_with_length(env, owner.readbacks.size(), &readbacks));
  for (uint32_t i = 0; i < owner.readbacks.size(); ++i)
    check(napi_set_element(env, readbacks, i, readback_fact(env, *owner.readbacks[i])));
  set(env, value, "readbacks", readbacks);
  // These constants cannot be promoted by passing a digest or a boolean.
  set(env, value, "scopeBinding", string(env, "unbound"));
  set(env, value, "protectedStageVerified", boolean(env, false));
  set(env, value, "coreSafe", boolean(env, false));
  set(env, value, "packaged", boolean(env, false));
  return value;
}

napi_value result(napi_env env, const std::shared_ptr<Session>& owner,
                  const Result& native, const std::string& operation = "") {
  napi_value value = object(env);
  set(env, value, "success", boolean(env, native.success));
  set(env, value, "nativeOutcome", string(env, "returned"));
  set(env, value, "hostAcknowledgment", string(env, "not_provided"));
  set(env, value, "operationId", string(env, operation));
  if (native.maximum_syscall_attempts) {
    set(env, value, "maximumSyscallAttempts", string(env, std::to_string(native.maximum_syscall_attempts)));
    set(env, value, "syscallAttempts", string(env, std::to_string(native.syscall_attempts)));
  }
  if (native.blocker_code) set(env, value, "blockerCode", string(env, native.blocker_code));
  set(env, value, "calls", call_facts(env, native.publication ? native.publication->calls
      : native.readback ? native.readback->calls : native.calls));
  set(env, value, "snapshot", snapshot(env, *owner));
  if (native.resource) {
    set(env, value, "resourceFact", fact(env, *native.resource));
    if (native.resource->state == ResourceState::retained
        && native.resource->kind != "publication_directory" && native.resource->kind != "publication_file")
      set(env, value, "capability", wrap_resource(env, owner, *native.resource));
  }
  if (native.readback) {
    set(env, value, "readback", readback_fact(env, *native.readback));
    if (native.success) {
      napi_value bytes;
      check(napi_create_buffer_copy(env, native.bytes.size(), native.bytes.data(), nullptr, &bytes));
      set(env, value, "bytes", bytes);
    }
  }
  if (native.publication) {
    set(env, value, "publication", publication_fact(env, *native.publication));
    if (native.success) {
      napi_value files;
      check(napi_create_array_with_length(env, native.publication_bytes.size(), &files));
      uint32_t index = 0;
      for (const auto& entry : native.publication->entries) {
        if (!entry.readback) continue;
        auto item = object(env);
        set(env, item, "originalLifetimeId", string(env, entry.original->id));
        set(env, item, "observedLifetimeId", string(env, entry.observed->id));
        const auto& payload = native.publication_bytes.at(index);
        napi_value bytes;
        check(napi_create_buffer_copy(env, payload.size(), payload.data(), nullptr, &bytes));
        set(env, item, "bytes", bytes);
        check(napi_set_element(env, files, index++, item));
      }
      set(env, value, "publicationFiles", files);
    }
  }
  return value;
}

template <typename Function> napi_value boundary(napi_env env, Function action) {
  try { return action(); }
  catch (const std::exception& error) {
    bool pending = false; napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, error.what(), error.what());
    return nullptr;
  } catch (...) { napi_throw_error(env, "native_unknown_exception", "native_unknown_exception"); return nullptr; }
}

napi_value open_session(napi_env env, napi_callback_info info) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 2);
    const auto stage = get_string(env, args[0]), destination = get_string(env, args[1]);
    if (!valid_absolute_path(stage) || !valid_absolute_path(destination)) throw std::runtime_error("invalid_parent_path");
    auto owner = std::make_shared<Session>();
    // Retained originals exist before returning to the Host; no async transport.
    auto native = open_parents(*owner, stage, destination);
    ReplyExceptionLatch latch{*owner};
    auto value = result(env, owner, native);
    set(env, value, "session", wrap_session(env, owner));
    if (owner->stage_parent) set(env, value, "stageParent", wrap_resource(env, owner, *owner->stage_parent));
    if (owner->destination_parent) set(env, value, "destinationParent", wrap_resource(env, owner, *owner->destination_parent));
    return value;
  });
}

napi_value create(napi_env env, napi_callback_info info, bool directory) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 4);
    auto owner = session(env, args[0]);
    auto& parent = resource(env, args[1], owner);
    const auto name = get_string(env, args[2]), operation = get_string(env, args[3]);
    if (!valid_component(name)) throw std::runtime_error("invalid_basename");
    owner->consume(operation);
    auto native = directory ? create_directory(*owner, parent, name) : create_file(*owner, parent, name);
    ReplyExceptionLatch latch{*owner};
    return result(env, owner, native, operation);
  });
}
napi_value create_dir(napi_env env, napi_callback_info info) { return create(env, info, true); }
napi_value create_regular(napi_env env, napi_callback_info info) { return create(env, info, false); }

napi_value write_regular(napi_env env, napi_callback_info info) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 4);
    auto owner = session(env, args[0]);
    auto& file = resource(env, args[1], owner);
    bool is_buffer = false; check(napi_is_buffer(env, args[2], &is_buffer));
    if (!is_buffer) throw std::runtime_error("expected_buffer");
    void* bytes = nullptr; size_t size = 0; check(napi_get_buffer_info(env, args[2], &bytes, &size));
    if (size > 64 * 1024 * 1024) throw std::runtime_error("buffer_too_large");
    const auto operation = get_string(env, args[3]);
    owner->consume(operation);
    auto native = write_file(*owner, file, static_cast<uint8_t*>(bytes), size);
    ReplyExceptionLatch latch{*owner};
    return result(env, owner, native, operation);
  });
}

napi_value read_regular(napi_env env, napi_callback_info info) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 5);
    auto owner = session(env, args[0]);
    auto& file = resource(env, args[1], owner);
    const auto expected = get_budget(env, args[2]), budget = get_budget(env, args[3]);
    const auto operation = get_string(env, args[4]);
    owner->consume(operation);
    auto native = read_file(*owner, file, expected, budget, operation);
    ReplyExceptionLatch latch{*owner};
    return result(env, owner, native, operation);
  });
}

using ResourceAction = Result (*)(Session&, Resource&);
napi_value resource_action(napi_env env, napi_callback_info info, ResourceAction action) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 3);
    auto owner = session(env, args[0]);
    auto& held = resource(env, args[1], owner);
    const auto operation = get_string(env, args[2]);
    owner->consume(operation);
    auto native = action(*owner, held);
    ReplyExceptionLatch latch{*owner};
    return result(env, owner, native, operation);
  });
}
napi_value fsync_original(napi_env env, napi_callback_info info) { return resource_action(env, info, sync_resource); }
napi_value observe_original(napi_env env, napi_callback_info info) { return resource_action(env, info, observe_resource); }
napi_value close_original(napi_env env, napi_callback_info info) { return resource_action(env, info, close_resource); }

napi_value install(napi_env env, napi_callback_info info) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 4);
    auto owner = session(env, args[0]);
    auto& tree = resource(env, args[1], owner);
    const auto name = get_string(env, args[2]), operation = get_string(env, args[3]);
    if (!valid_component(name)) throw std::runtime_error("invalid_basename");
    owner->consume(operation);
    auto native = install_tree(*owner, tree, name);
    ReplyExceptionLatch latch{*owner};
    return result(env, owner, native, operation);
  });
}

napi_value observe_installed(napi_env env, napi_callback_info info) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 4);
    auto owner = session(env, args[0]);
    auto& tree = resource(env, args[1], owner);
    const auto budget = get_budget(env, args[2], 50ULL * 1024 * 1024 + 128);
    const auto operation = get_string(env, args[3]);
    owner->consume(operation);
    auto native = observe_publication(*owner, tree, budget, operation);
    ReplyExceptionLatch latch{*owner};
    return result(env, owner, native, operation);
  });
}

napi_value inspect(napi_env env, napi_callback_info info) {
  return boundary(env, [&] { auto args = arguments(env, info, 1); return snapshot(env, *session(env, args[0])); });
}
napi_value cancel(napi_env env, napi_callback_info info) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 1); auto owner = session(env, args[0]);
    if (owner->phase == Phase::closed) throw std::runtime_error("session_closed");
    owner->cancel_requested = true;
    if (owner->phase == Phase::building) owner->phase = Phase::cancelled;
    return snapshot(env, *owner);
  });
}
napi_value close_all(napi_env env, napi_callback_info info) {
  return boundary(env, [&] {
    auto args = arguments(env, info, 1); auto owner = session(env, args[0]);
    auto native = close_session(*owner);
    ReplyExceptionLatch latch{*owner};
    return result(env, owner, native);
  });
}

napi_value initialize(napi_env env, napi_value exports) {
  return boundary(env, [&] {
    const napi_property_descriptor methods[] = {
      {"openSession", nullptr, open_session, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createDirectory", nullptr, create_dir, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createFile", nullptr, create_regular, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeFile", nullptr, write_regular, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readFile", nullptr, read_regular, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"fsyncResource", nullptr, fsync_original, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"observeResource", nullptr, observe_original, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeResource", nullptr, close_original, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"installTree", nullptr, install, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"observePublication", nullptr, observe_installed, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"inspectSession", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancelSession", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeSession", nullptr, close_all, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    check(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
    set(env, exports, "protocolVersion", number(env, 2));
    set(env, exports, "scopeBinding", string(env, "unbound"));
    set(env, exports, "coreSafe", boolean(env, false));
    set(env, exports, "protectedStageVerified", boolean(env, false));
    set(env, exports, "packaged", boolean(env, false));
    return exports;
  });
}
}  // namespace

NAPI_MODULE(office_local, initialize)

#include <windows.h>
#include <bcrypt.h>
#include <wtsapi32.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <winrt/base.h>

#include <array>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#pragma comment(lib, "Advapi32.lib")
#pragma comment(lib, "Bcrypt.lib")
#pragma comment(lib, "RuntimeObject.lib")
#pragma comment(lib, "User32.lib")
#pragma comment(lib, "WindowsApp.lib")
#pragma comment(lib, "Wtsapi32.lib")

using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Security::Credentials::UI::UserConsentVerificationResult;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifier;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifierAvailability;

namespace {

struct SessionSnapshot {
  std::string digest;
  bool active = false;
  bool locked = true;
};

std::string sha256(const std::string& input) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_bytes = 0;
  DWORD digest_bytes = 0;
  DWORD written = 0;
  std::vector<std::uint8_t> object;
  std::array<std::uint8_t, 32> digest{};
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0
      || BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_bytes), sizeof(object_bytes), &written, 0) != 0
      || BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
          reinterpret_cast<PUCHAR>(&digest_bytes), sizeof(digest_bytes), &written, 0) != 0
      || digest_bytes != digest.size()) {
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    throw std::runtime_error("sha256_unavailable");
  }
  object.resize(object_bytes);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr, 0, 0) != 0
      || BCryptHashData(hash,
          reinterpret_cast<PUCHAR>(const_cast<char*>(input.data())),
          static_cast<ULONG>(input.size()), 0) != 0
      || BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) != 0) {
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    throw std::runtime_error("sha256_failed");
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  std::ostringstream output;
  output << std::hex << std::setfill('0');
  for (const auto byte : digest) output << std::setw(2) << static_cast<unsigned>(byte);
  return output.str();
}

std::wstring input_desktop_name() {
  HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop) return L"";
  DWORD required = 0;
  GetUserObjectInformationW(desktop, UOI_NAME, nullptr, 0, &required);
  std::wstring name(required / sizeof(wchar_t), L'\0');
  if (required == 0 || !GetUserObjectInformationW(desktop, UOI_NAME, name.data(), required, &required)) {
    CloseDesktop(desktop);
    return L"";
  }
  CloseDesktop(desktop);
  while (!name.empty() && name.back() == L'\0') name.pop_back();
  return name;
}

bool wts_session_active(DWORD session_id) {
  LPWSTR buffer = nullptr;
  DWORD bytes = 0;
  if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session_id,
        WTSConnectState, &buffer, &bytes) || !buffer) return false;
  const bool active = bytes >= sizeof(WTS_CONNECTSTATE_CLASS)
      && *reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(buffer) == WTSActive;
  WTSFreeMemory(buffer);
  return active;
}

SessionSnapshot read_session() {
  DWORD session_id = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id)) {
    throw std::runtime_error("session_unavailable");
  }
  HANDLE token = nullptr;
  TOKEN_STATISTICS statistics{};
  DWORD bytes = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)
      || !GetTokenInformation(token, TokenStatistics, &statistics, sizeof(statistics), &bytes)) {
    if (token) CloseHandle(token);
    throw std::runtime_error("token_unavailable");
  }
  CloseHandle(token);
  const std::wstring desktop = input_desktop_name();
  const bool default_desktop = _wcsicmp(desktop.c_str(), L"Default") == 0;
  const bool active = session_id != 0 && wts_session_active(session_id)
      && default_desktop && GetSystemMetrics(SM_REMOTESESSION) == 0;
  const std::string material = "ling-locked-control-session-v1|"
      + std::to_string(session_id) + "|"
      + std::to_string(statistics.AuthenticationId.HighPart) + "|"
      + std::to_string(statistics.AuthenticationId.LowPart);
  return {sha256(material), active, !default_desktop || !active};
}

std::string verify_identity(const std::wstring& reason) {
  const auto session = read_session();
  if (!session.active || session.locked) return "failed";
  const auto availability = UserConsentVerifier::CheckAvailabilityAsync().get();
  if (availability != UserConsentVerifierAvailability::Available) return "unavailable";
  const auto result = UserConsentVerifier::RequestVerificationAsync(reason).get();
  if (result == UserConsentVerificationResult::Verified) return "verified";
  if (result == UserConsentVerificationResult::Canceled) return "cancelled";
  return result == UserConsentVerificationResult::DeviceBusy
      || result == UserConsentVerificationResult::RetriesExhausted
    ? "failed" : "unavailable";
}

JsonObject session_json(const SessionSnapshot& session) {
  JsonObject output;
  output.SetNamedValue(L"platform", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"win32"));
  output.SetNamedValue(L"sessionBindingDigest", winrt::Windows::Data::Json::JsonValue::CreateStringValue(winrt::to_hstring(session.digest)));
  output.SetNamedValue(L"sessionActive", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(session.active));
  output.SetNamedValue(L"sessionLocked", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(session.locked));
  return output;
}

void write_json(const JsonObject& output) {
  std::cout << winrt::to_string(output.Stringify()) << "\n";
}

}  // namespace

int wmain() {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    std::string input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
    if (input.empty() || input.size() > 16 * 1024) return 2;
    const JsonObject request = JsonObject::Parse(winrt::to_hstring(input));
    if (request.GetNamedString(L"platform", L"") != L"win32") return 2;
    const auto command = request.GetNamedString(L"command", L"");
    if (command == L"identity") {
      JsonObject output;
      output.SetNamedValue(L"status", winrt::Windows::Data::Json::JsonValue::CreateStringValue(
        winrt::to_hstring(verify_identity(request.GetNamedString(L"localizedReason", L"Authorize Ling computer control")))));
      write_json(output);
      return 0;
    }
    const auto session = read_session();
    if (command == L"session") {
      write_json(session_json(session));
      return 0;
    }
    if (command == L"attest") {
      JsonObject output;
      output.SetNamedValue(L"platform", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"win32"));
      output.SetNamedValue(L"sessionBindingDigest", winrt::Windows::Data::Json::JsonValue::CreateStringValue(winrt::to_hstring(session.digest)));
      output.SetNamedValue(L"lockEpoch", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(request.GetNamedNumber(L"lockEpoch")));
      output.SetNamedValue(L"providerGeneration", winrt::Windows::Data::Json::JsonValue::CreateNumberValue(request.GetNamedNumber(L"providerGeneration")));
      output.SetNamedValue(L"sameUserSession", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(
        request.GetNamedString(L"expectedSessionBindingDigest", L"") == winrt::to_hstring(session.digest)));
      // Standard Medium-IL cannot claim a user-desktop target while the input
      // desktop is Winlogon/UAC. Keep the capability negative and do not add
      // privilege or service escape hatches here.
      output.SetNamedValue(L"userDesktopTargeted", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(false));
      output.SetNamedValue(L"captureReady", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(false));
      output.SetNamedValue(L"inputReady", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(false));
      output.SetNamedValue(L"secureSurfaceExcluded", winrt::Windows::Data::Json::JsonValue::CreateBooleanValue(false));
      write_json(output);
      return 0;
    }
  } catch (...) {
    return 2;
  }
  return 2;
}

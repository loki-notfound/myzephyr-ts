#include <iostream>
#include "zephyr_wasm_bridge.h"
#include "wallet/monero_wallet_keys.h"
#include "misc_log_ex.h"
#include "utils/monero_utils.h"
#include "wallet/monero_wallet_full.h"
#include "http_client_wasm.h"
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <algorithm>
#include <map>
#include <memory>
#include "oracle/asset_types.h"

using namespace std;
using namespace zephyr_wasm_bridge;

// ----------------------- TEST-ONLY INSTRUMENTATION --------------------------

// Compiled only with ZEPHYR_TS_TEST_INSTRUMENTATION, which the separately identified test module
// defines; the release module contains none of this code, bindings or imports. The hooks read
// and record state on the JavaScript module object (Module.__zephyrTsTestHooks), so no native
// export has to be called while an operation is suspended at a barrier.
#if defined(ZEPHYR_TS_TEST_INSTRUMENTATION)
#include <emscripten.h>
#include <malloc.h>

// returns the armed failure kind for this hook point (after skipping armed passes), else 0:
// 1 std::runtime_error whose text carries the call's inputs, 2 a non-standard exception,
// 3 std::bad_alloc, 4 tools::error::invalid_password, 5 tools::error::wallet_internal_error with the
// pinned core's literal "invalid password" (wallet2::load_keys_buf) (h.kind[name], default 1)
EM_JS(int, zephyr_ts_test_inject, (const char* point), {
  var h = Module["__zephyrTsTestHooks"];
  if (!h) return 0;
  var name = UTF8ToString(point);
  if (!h.events) h.events = [];
  h.events.push("hook:" + name);
  if (h.skip && h.skip[name] > 0) { h.skip[name]--; return 0; }
  if (h.fail && h.fail[name] > 0) {
    h.fail[name]--; h.events.push("injected:" + name);
    var kind = h.kind && h.kind[name] ? h.kind[name] : 1;
    return kind >= 1 && kind <= 5 ? kind : 1;
  }
  return 0;
});

// returns 1 while an armed barrier at this point is not released; records entry and exit
EM_JS(int, zephyr_ts_test_barrier_wait, (const char* point), {
  var h = Module["__zephyrTsTestHooks"];
  var name = UTF8ToString(point);
  if (!h || !h.barrier || h.barrier.point !== name) return 0;
  if (!h.events) h.events = [];
  if (!h.barrier.entered) { h.barrier.entered = true; h.events.push("barrier-entered:" + name); }
  if (h.barrier.released) { h.events.push("barrier-left:" + name); h.barrier = undefined; return 0; }
  return 1;
});

// counts bridge-owned buffer allocations (the matching frees are counted at the JS release)
EM_JS(void, zephyr_ts_test_buffer_allocated, (int pointer, int length), {
  var h = Module["__zephyrTsTestHooks"];
  if (!h) return;
  if (!h.buffers) h.buffers = { allocated: 0, bytes: 0, live: {} };
  h.buffers.allocated++; h.buffers.bytes += length; h.buffers.live[pointer] = length;
});

static bool test_inject(const char* point) { return zephyr_ts_test_inject(point) != 0; }

// test-only failure of the armed kind; kind 1 deliberately carries the call's inputs (passwords,
// recovery material, addresses) in the exception text so the tests can prove it never reaches JS
static void test_throw(const char* point, const std::string& inputs) {
  int kind = zephyr_ts_test_inject(point);
  if (kind == 0) return;
  if (kind == 2) throw 7;
  if (kind == 3) throw std::bad_alloc();
  if (kind == 4) THROW_WALLET_EXCEPTION(tools::error::invalid_password);
  if (kind == 5) THROW_WALLET_EXCEPTION(tools::error::wallet_internal_error, "invalid password");
  throw std::runtime_error(std::string("injected ") + point + " failure: " + inputs);
}
static void test_barrier(const char* point) { while (zephyr_ts_test_barrier_wait(point)) emscripten_sleep(2); }
static void test_buffer_allocated(void* pointer, size_t length) { zephyr_ts_test_buffer_allocated((int) (uintptr_t) pointer, (int) length); }

int zephyr_wasm_bridge::test_heap_in_use() {
  struct mallinfo info = mallinfo();
  return info.uordblks;
}
// test-only failure injection: the inputs expression is evaluated only in the test module
#define ZEPHYR_TS_TEST_THROW(point, inputs) test_throw(point, inputs)
#else
#define ZEPHYR_TS_TEST_THROW(point, inputs) ((void) 0)
static inline bool test_inject(const char*) { return false; }
static inline void test_barrier(const char*) {}
static inline void test_buffer_allocated(void*, size_t) {}
#endif

// ------------------------- OWNED BYTE BUFFERS -------------------------------

// Ownership contract for wallet byte buffers returned to JavaScript (get_keys_file_buffer and
// get_cache_file_buffer): the bridge copies the bytes into one block allocated with malloc()
// and returns {"pointer":<address>,"length":<bytes>}. The caller copies the bytes out and then
// releases the block exactly once with the module's _free() (the same C allocator), also when
// its copy fails. An empty buffer is returned as pointer 0 and length 0 and has nothing to
// release. Failures return {"error":"<identifier>"} with a fixed identifier and own nothing.
static string owned_buffer_error(const char* identifier) {
  return string("{\"error\":\"") + identifier + "\"}";
}

static string to_owned_buffer(const string& bytes) {
  size_t length = test_inject("buffer.empty") ? 0 : bytes.size();
  if (length == 0) return string("{\"pointer\":0,\"length\":0}");
  if (length > (size_t) INT32_MAX) return owned_buffer_error("BUFFER_TOO_LARGE");
  string out(64, '\0'); // allocated before the block: nothing after malloc() can throw and leak it
  void* block = test_inject("buffer.alloc") ? nullptr : malloc(length);
  if (block == nullptr) return owned_buffer_error("BUFFER_ALLOCATION_FAILED");
  memcpy(block, bytes.data(), length);
  int n = snprintf(&out[0], out.size(), "{\"pointer\":%lu,\"length\":%lu}", (unsigned long) (uintptr_t) block, (unsigned long) length);
  if (n <= 0 || (size_t) n >= out.size()) { free(block); return owned_buffer_error("BUFFER_FORMAT_FAILED"); }
  out.resize((size_t) n);
  test_buffer_allocated(block, length);
  return out;
}

// --------------------------- FIXED BRIDGE ERRORS ----------------------------

// Error protocol of the retained lifecycle bindings. No native exception text, stack,
// input value or URL crosses into JavaScript. A failure is reported as {"error":"<IDENTIFIER>"}
// (change_wallet_password adds "passwordState"); integer results use -1. The identifier is a
// fixed token chosen in this file: from a typed core exception where the core has one
// (tools::error::invalid_password), from the bridge's own checks (bridge_failure), from the exact
// table of the pinned core's fixed messages below for the create/restore and address contexts,
// and otherwise the context's fixed fallback. Exception text is only compared here, then dropped.
// Every binding builds its result inside try/catch and invokes callbacks outside of it.

namespace {
  // a failure detected by the bridge itself; carries only a fixed identifier
  struct bridge_failure : public std::exception {
    explicit bridge_failure(const char* identifier) : m_identifier(identifier) {}
    const char* what() const noexcept override { return m_identifier; }
    const char* m_identifier;
  };

  // one exact fixed message of the pinned core and its identifier; a message ending in '*' is a
  // fixed prefix that the core completes with caller input (the input is never compared or kept)
  struct core_message_rule { const char* message; const char* identifier; };

  // BEGIN CORE MESSAGE TABLE (create/restore contexts); every message must occur in the pinned core
  const core_message_rule CREATE_MESSAGE_RULES[] = {
    {"Invalid mnemonic", "CORE_INVALID_MNEMONIC"},
    {"Unknown language: *", "CORE_UNKNOWN_LANGUAGE"},
    {"Failed to create mnemonic from private spend key for language: *", "CORE_INVALID_MNEMONIC"},
    {"Cannot specify language when creating wallet from mnemonic", "CORE_INVALID_MNEMONIC"},
    {"Cannot specify seed offset when creating wallet from keys", "CORE_INVALID_MNEMONIC"},
    {"Cannot specify seed offset when creating random wallet", "CORE_INVALID_MNEMONIC"},
    {"Cannot specify restore height when creating random wallet", "CORE_UNCLASSIFIED"},
    {"No subaddress lookahead provided with account lookahead", "CORE_LOOKAHEAD"},
    {"No account lookahead provided with subaddress lookahead", "CORE_LOOKAHEAD"},
    {"Subaddress major lookahead may not be zero", "CORE_LOOKAHEAD"},
    {"Subaddress major lookahead is too large", "CORE_LOOKAHEAD"},
    {"Subaddress minor lookahead may not be zero", "CORE_LOOKAHEAD"},
    {"Subaddress minor lookahead is too large", "CORE_LOOKAHEAD"},
    {"failed to parse secret spend key", "CORE_INVALID_KEY"},
    {"failed to parse secret view key", "CORE_INVALID_KEY"},
    {"Neither spend key nor view key supplied", "CORE_INVALID_KEY"},
    {"failed to verify secret spend key", "CORE_INVALID_KEY"},
    {"failed to verify secret view key", "CORE_INVALID_KEY"},
    {"must provide address if providing private view key", "CORE_INVALID_ADDRESS"},
    {"must provide primary address if providing private view key", "CORE_INVALID_ADDRESS"},
    {"failed to parse address", "CORE_INVALID_ADDRESS"},
    {"spend key does not match address", "CORE_INVALID_ADDRESS"},
    {"view key does not match address", "CORE_INVALID_ADDRESS"}
  };
  // END CORE MESSAGE TABLE

  // BEGIN CORE MESSAGE TABLE (open context)
  // wallet2::load_keys_buf throws wallet_internal_error with this literal when bytes decrypted with a
  // wrong password parse as JSON that is not an object; it is a wrong password
  const core_message_rule OPEN_MESSAGE_RULES[] = {
    {"invalid password", "CORE_INVALID_PASSWORD"}
  };
  // END CORE MESSAGE TABLE

  // BEGIN CORE MESSAGE TABLE (daemon context)
  // fixed messages of the pinned core for daemon calls. Any other text of a daemon failure,
  // including status or error text supplied by the node, is never compared beyond these entries.
  const core_message_rule DAEMON_MESSAGE_RULES[] = {
    {"Wallet is not connected to daemon", "DAEMON_NOT_CONNECTED"},
    {"Failed to connect to daemon", "DAEMON_UNREACHABLE"}
  };
  // END CORE MESSAGE TABLE

  // BEGIN CORE MESSAGE TABLE (address context)
  const core_message_rule ADDRESS_MESSAGE_RULES[] = {
    {"Invalid address", "CORE_INVALID_ADDRESS"},
    {"The given address already has a payment id", "CORE_INVALID_ADDRESS"},
    {"Invalid payment id", "CORE_UNCLASSIFIED"},
    {"Address doesn't belong to the wallet", "CORE_INVALID_ADDRESS"},
    {"Invalid payment ID: *", "CORE_UNCLASSIFIED"},
    {"Subaddress shouldn't be used", "CORE_INVALID_ADDRESS"},
    {"Already integrated address", "CORE_INVALID_ADDRESS"},
    {"Payment ID shouldn't be left unspecified", "CORE_UNCLASSIFIED"},
    {"Address is not an integrated address", "CORE_INVALID_ADDRESS"},
    {"monero_wallet_keys::get_integrated_address() not implemented", "CORE_INVALID_ADDRESS"},
    {"monero_wallet_keys::decode_integrated_address() not implemented", "CORE_INVALID_ADDRESS"}
  };
  // END CORE MESSAGE TABLE

  template <size_t N>
  const char* match_core_message(const core_message_rule (&rules)[N], const char* text, const char* fallback) {
    if (text == nullptr) return fallback;
    for (size_t i = 0; i < N; i++) {
      const char* m = rules[i].message;
      size_t n = strlen(m);
      if (n > 0 && m[n - 1] == '*') { if (strncmp(text, m, n - 1) == 0) return rules[i].identifier; }
      else if (strcmp(text, m) == 0) return rules[i].identifier;
    }
    return fallback;
  }

  // fixed results; identifiers and states are literals of this file only
  string bridge_error(const char* identifier) {
    return string("{\"error\":\"") + identifier + "\"}";
  }
}

// Classify the exception being handled (call only inside a catch handler). The context selects
// the table and the fallback; the exception text never leaves this function.
const char* zephyr_wasm_bridge::classify_current_exception(int context) {
  try {
    throw;
  } catch (const bridge_failure& e) {
    return e.m_identifier;
  } catch (const tools::error::invalid_password&) {
    return context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : context == ERROR_CONTEXT_BUFFER ? "NATIVE_BUFFER_FAILED" : "CORE_INVALID_PASSWORD";
  } catch (const tools::error::no_connection_to_daemon&) {
    // the core received no usable answer; refined by the transport's failure kind (daemon_failure)
    return context == ERROR_CONTEXT_DAEMON || context == ERROR_CONTEXT_SYNC ? "DAEMON_UNREACHABLE" : context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::wallet_rpc_error&) {
    // busy, payment or other daemon status, including node-supplied text that is not read
    return context == ERROR_CONTEXT_DAEMON || context == ERROR_CONTEXT_SYNC ? "DAEMON_RESPONSE" : context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::refresh_error&) {
    // failed daemon request or unusable daemon data during refresh (blocks, hashes, pool, indices)
    return context == ERROR_CONTEXT_DAEMON || context == ERROR_CONTEXT_SYNC ? "DAEMON_RESPONSE" : context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : "CORE_UNCLASSIFIED";
  } catch (const std::exception& e) {
    switch (context) {
      case ERROR_CONTEXT_CREATE: return match_core_message(CREATE_MESSAGE_RULES, e.what(), "CORE_UNCLASSIFIED");
      case ERROR_CONTEXT_ADDRESS: return match_core_message(ADDRESS_MESSAGE_RULES, e.what(), "CORE_UNCLASSIFIED");
      case ERROR_CONTEXT_OPEN: return match_core_message(OPEN_MESSAGE_RULES, e.what(), "CORE_WALLET_DATA");
      case ERROR_CONTEXT_CLOSE: return "CORE_CLOSE_FAILED";
      case ERROR_CONTEXT_BUFFER: return "NATIVE_BUFFER_FAILED";
      case ERROR_CONTEXT_DAEMON: return match_core_message(DAEMON_MESSAGE_RULES, e.what(), "DAEMON_RESPONSE");
      case ERROR_CONTEXT_SYNC: return match_core_message(DAEMON_MESSAGE_RULES, e.what(), "SYNC_FAILED");
      default: return "CORE_UNCLASSIFIED";
    }
  } catch (...) {
    return context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : context == ERROR_CONTEXT_BUFFER ? "NATIVE_BUFFER_FAILED" : context == ERROR_CONTEXT_SYNC ? "SYNC_FAILED" : context == ERROR_CONTEXT_DAEMON ? "DAEMON_RESPONSE" : "CORE_UNCLASSIFIED";
  }
}

// After a failed native password change whose old password was verified, report which password
// the native wallet holds now, using the core's deterministic cache-key test (no core change).
const char* zephyr_wasm_bridge::probe_password_state(int handle, const string& old_password, const string& new_password) {
#if defined BUILD_WALLET_FULL
  if (test_inject("password_probe")) return "unknown"; // test-only: deterministic unknown state; always false in release
  monero_wallet_full* full = (monero_wallet_full*) handle;
  for (int i = 0; i < 2; i++) {
    try {
      std::string probe = full->get_keys_file_buffer(i == 0 ? old_password : new_password, full->is_view_only());
      std::fill(probe.begin(), probe.end(), '\0');
      return i == 0 ? "unchanged" : "changed";
    } catch (...) {
      // not this password; try the next one
    }
  }
#endif
  return "unknown";
}

// ------------------------- DAEMON ROUTES --------------------------

// Each full wallet's HTTP clients share one route (http_client_wasm.h): the bridge keeps it per
// wallet handle from construction to a successful close, sets the validated base path before the
// core receives the origin, and reads the transport's last failure kind to classify daemon errors.
namespace {
  std::map<int, std::shared_ptr<epee::net_utils::http::http_client_wasm_route>> WALLET_ROUTES;

  std::shared_ptr<epee::net_utils::http::http_client_wasm_route> route_of(int handle) {
    auto it = WALLET_ROUTES.find(handle);
    if (it == WALLET_ROUTES.end()) throw bridge_failure("DAEMON_CONNECTION"); // not a full wallet of this bridge
    return it->second;
  }

  // the SDK validates and normalizes the address before the call; these checks are a backstop
  bool valid_daemon_origin(const string& uri) {
    if (uri.empty()) return true; // clears the connection
    if (uri.size() > 512) return false;
    size_t authority = uri.rfind("https://", 0) == 0 ? 8 : uri.rfind("http://", 0) == 0 ? 7 : 0;
    if (authority == 0 || authority == uri.size()) return false;
    for (size_t i = authority; i < uri.size(); i++) {
      char c = uri[i];
      bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == ':' || c == '[' || c == ']';
      if (!ok) return false; // no path, query, fragment, credentials or whitespace
    }
    return true;
  }

  bool valid_base_path(const string& path) {
    if (path.empty()) return true;
    if (path.size() > 256 || path[0] != '/' || path[path.size() - 1] == '/') return false;
    for (size_t i = 0; i < path.size(); i++) {
      char c = path[i];
      bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' || c == '~' || c == '/';
      if (!ok) return false;
      if (c == '/' && i + 1 < path.size() && (path[i + 1] == '/' || (path[i + 1] == '.' && (i + 2 == path.size() || path[i + 2] == '/' || (path[i + 2] == '.' && (i + 3 == path.size() || path[i + 3] == '/')))))) return false;
    }
    return true;
  }

  // A failed daemon call that the core reports as "no connection" is refined by what the transport
  // saw last: no HTTP response at all (unreachable), or a response the core could not use.
  const char* daemon_failure(int handle, const char* identifier) {
    if (strcmp(identifier, "DAEMON_UNREACHABLE") != 0) return identifier;
    auto it = WALLET_ROUTES.find(handle);
    if (it != WALLET_ROUTES.end() && it->second->last_failure != 1) return "DAEMON_RESPONSE";
    return identifier;
  }

  // exact decimal text of an unsigned 64-bit value
  string decimal(uint64_t value) { return std::to_string(value); }

  // strict decimal height text (the SDK sends a checked safe integer); "" selects the core default
  uint64_t parse_height(const string& text) {
    if (text.empty() || text.size() > 20) throw bridge_failure("SYNC_START_HEIGHT");
    for (char c : text) if (c < '0' || c > '9') throw bridge_failure("SYNC_START_HEIGHT");
    if (text.size() > 1 && text[0] == '0') throw bridge_failure("SYNC_START_HEIGHT");
    if (text.size() == 20 && text > string("18446744073709551615")) throw bridge_failure("SYNC_START_HEIGHT");
    return std::stoull(text);
  }

  // asset types of the pinned core (oracle::ASSET_TYPES and ASSET_TYPES_V2); any other text is rejected
  bool is_core_asset_type(const string& asset) {
    for (const auto& a : oracle::ASSET_TYPES) if (a == asset) return true;
    for (const auto& a : oracle::ASSET_TYPES_V2) if (a == asset) return true;
    return false;
  }

  // {"<asset>":"<decimal>",...} with the core's keys and values; keys are core constants
  string asset_map_json(const std::map<std::string, uint64_t>& amounts) {
    string out = "{";
    bool first = true;
    for (const auto& entry : amounts) {
      if (!is_core_asset_type(entry.first)) throw bridge_failure("UNEXPECTED_ASSET_TYPE");
      if (!first) out += ",";
      first = false;
      out += "\"" + entry.first + "\":\"" + decimal(entry.second) + "\"";
    }
    return out + "}";
  }
}

// ----------------------------- PRIVATE INNER --------------------------------

static const int DEFAULT_SYNC_INTERVAL_MILLIS = 1000 * 10;   // default refresh interval 10 sec
static const int DEFAULT_CONNECTION_TIMEOUT_MILLIS = 1000 * 30; // default connection timeout 30 sec

string strip_last_char(const string& str) {
  return str.substr(0, str.size() - 1);
}

std::string tools::dns_utils::get_account_address_as_str_from_url(const std::string& url, bool& dnssec_valid, std::function<std::string(const std::string&, const std::vector<std::string>&, bool)> dns_confirm) {
  throw std::runtime_error("Invalid destination address");
}

#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
/**
 * Listens for wallet notifications and notifies the listener in JavaScript.
 */
struct wallet_wasm_listener : public monero_wallet_listener {

  emscripten::val m_on_sync_progress;
  emscripten::val m_on_new_block;
  emscripten::val m_on_balances_changed;
  emscripten::val m_on_output_received;
  emscripten::val m_on_output_spent;

  wallet_wasm_listener(emscripten::val on_sync_progress, emscripten::val on_new_block, emscripten::val on_balances_changed, emscripten::val on_output_received, emscripten::val on_output_spent):
    m_on_sync_progress(on_sync_progress),
    m_on_new_block(on_new_block),
    m_on_balances_changed(on_balances_changed),
    m_on_output_received(on_output_received),
    m_on_output_spent(on_output_spent)
  { }

  ~wallet_wasm_listener() { };

  void on_sync_progress(uint64_t height, uint64_t start_height, uint64_t end_height, double percent_done, const string& message) override {
    m_on_sync_progress((long) height, (long) start_height, (long) end_height, percent_done, message);
  }

  void on_new_block(uint64_t height) override {
    m_on_new_block((long) height);
  }

  void on_balances_changed(uint64_t new_balance, uint64_t new_unlocked_balance) override {
    m_on_balances_changed(to_string(new_balance), to_string(new_unlocked_balance));
  }

  void on_output_received(const monero_output_wallet& output) override {
    boost::optional<uint64_t> height = output.m_tx->get_height();
    int version = output.m_tx->m_version == boost::none ? 2 : *output.m_tx->m_version; // TODO: version not present in unlocked output notification, defaulting to 2
    bool is_locked = std::static_pointer_cast<monero_tx_wallet>(output.m_tx)->m_is_locked.get();
    m_on_output_received(height == boost::none ? (long) 0 : (long) *height, output.m_tx->m_hash.get(), to_string(*output.m_amount), (int) *output.m_account_index, (int) *output.m_subaddress_index, version, to_string(*output.m_tx->m_unlock_time), is_locked);
  }

  void on_output_spent(const monero_output_wallet& output) override {
    boost::optional<uint64_t> height = output.m_tx->get_height();
    string account_idx_str = output.m_account_index == boost::none ? "" : to_string(*output.m_account_index).c_str();
    string subaddress_idx_str = output.m_subaddress_index == boost::none ? "" : to_string(*output.m_subaddress_index).c_str();
    int version = output.m_tx->m_version == boost::none ? 2 : *output.m_tx->m_version; // TODO: version not present in unlocked output notification, defaulting to 2
    bool is_locked = std::static_pointer_cast<monero_tx_wallet>(output.m_tx)->m_is_locked.get();
    m_on_output_spent(height == boost::none ? (long) 0 : (long) *height, output.m_tx->m_hash.get(), to_string(*output.m_amount), account_idx_str, subaddress_idx_str, version, to_string(*output.m_tx->m_unlock_time), is_locked);
  }
};

// ------------------------------- UTILITIES ----------------------------------

#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
string zephyr_wasm_bridge::set_log_level(int level)
{
  try {
    ZEPHYR_TS_TEST_THROW("error.utility", "log level");
    mlog_set_log_level(level); // the fixed core has no monero_utils::set_log_level(); epee's function is what it wraps upstream
    return string("");
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_UTILITY));
  }
}

string zephyr_wasm_bridge::get_integrated_address_util(int network_type, const string& standard_address, const string& payment_id)
{
  try {
    ZEPHYR_TS_TEST_THROW("error.address", standard_address + " " + payment_id);
    return monero_utils::get_integrated_address(static_cast<monero_network_type>(network_type), standard_address, payment_id).serialize();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_ADDRESS));
  }
}

string zephyr_wasm_bridge::validate_address(const string& address, int network_type)
{
  try {
    ZEPHYR_TS_TEST_THROW("error.address", address);
    monero_utils::validate_address(address, static_cast<monero_network_type>(network_type));
    return string("");
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_ADDRESS));
  }
}

#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
string zephyr_wasm_bridge::get_exception_message(int exception_ptr)
{
  return std::string(reinterpret_cast<std::exception *>(exception_ptr)->what()); // not bound: native text must not reach JavaScript
}

string zephyr_wasm_bridge::malloc_binary_from_json(const std::string &buff_json)
{
  // convert json to binary string
  string buff_bin;
  monero_utils::json_to_binary(buff_json, buff_bin);

  // copy binary string to heap and keep pointer
  std::string* ptr = new std::string(buff_bin.c_str(), buff_bin.length());

  // create object with binary string memory address info
  // TODO: switch to rapidjson
  boost::property_tree::ptree root;
  root.put("ptr", reinterpret_cast<intptr_t>(ptr->c_str()));
  root.put("length", ptr->length());

  // serialize memory info to json str
  return gen_utils::serialize(root);
}

string zephyr_wasm_bridge::binary_to_json(const std::string &bin_mem_info_str)
{
  // deserialize memory address info to json
  boost::property_tree::ptree root;
  gen_utils::deserialize(bin_mem_info_str, root);

  // get ptr and length of binary data
  char* ptr = (char*) root.get<int>("ptr"); // TODO: reinterpret_cast<intptr_t>?
  int length = root.get<int>("length");

  // read binary
  std::string buff_bin(ptr, length);

  // convert binary to json and return
  std::string buff_json;
  monero_utils::binary_to_json(buff_bin, buff_json);
  return buff_json;
}

string zephyr_wasm_bridge::binary_blocks_to_json(const std::string &bin_mem_info_str)
{
  // deserialize memory address info to json
  boost::property_tree::ptree root;
  gen_utils::deserialize(bin_mem_info_str, root);

  // get ptr and length of binary data
  char* ptr = (char*) root.get<int>("ptr"); // TODO: reinterpret_cast<intptr_t>?
  int length = root.get<int>("length");

  // read binary
  std::string buff_bin(ptr, length);

  // convert binary to json and return
  std::string buff_json;
  monero_utils::binary_blocks_to_json(buff_bin, buff_json);
  return buff_json;
}

// -------------------------- STATIC WALLET UTILS -----------------------------

#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
void zephyr_wasm_bridge::open_wallet_full(const string& password, int network_type, const string& keys_data, const string& cache_data, const string& daemon_uri, const string& daemon_username, const string& daemon_password, const string& reject_unauthorized_fn_id, bool regtest, emscripten::val callback) {
  monero_wallet* wallet = nullptr;
  string error;
#if defined BUILD_WALLET_FULL
  try {
    if (regtest) throw bridge_failure("REGTEST");
    ZEPHYR_TS_TEST_THROW("error.open", password);
    if (!daemon_uri.empty() || !daemon_username.empty() || !daemon_password.empty()) throw bridge_failure("DAEMON_CONNECTION"); // construction is offline; the SDK sets the daemon afterwards
    std::shared_ptr<http_client_wasm_route> route = std::make_shared<http_client_wasm_route>();
    wallet = monero_wallet_full::open_wallet_data(password, static_cast<monero_network_type>(network_type), keys_data, cache_data, monero_rpc_connection(), std::unique_ptr<http_client_wasm_factory>(new http_client_wasm_factory(reject_unauthorized_fn_id, route)));
    WALLET_ROUTES[(int) wallet] = route;
  } catch (...) {
    error = bridge_error(classify_current_exception(ERROR_CONTEXT_OPEN));
  }
#else
  error = bridge_error("CORE_UNCLASSIFIED");
#endif
  if (error.empty()) callback((int) wallet); // callback with wallet memory address
  else callback(error);
}

void zephyr_wasm_bridge::create_full_wallet(const string& config_json, const string& reject_unauthorized_fn_id, emscripten::val callback) {
  monero_wallet* wallet = nullptr;
  string error;
#if defined BUILD_WALLET_FULL
  try {
    shared_ptr<monero_wallet_config> config = monero_wallet_config::deserialize(config_json);
    config->m_path = std::string("");
    if (config->m_server_uri != boost::none || config->m_server_username != boost::none || config->m_server_password != boost::none) throw bridge_failure("DAEMON_CONNECTION"); // construction is offline
    ZEPHYR_TS_TEST_THROW("error.create", config_json);
    std::shared_ptr<http_client_wasm_route> route = std::make_shared<http_client_wasm_route>();
    wallet = monero_wallet_full::create_wallet(*config, std::unique_ptr<http_client_wasm_factory>(new http_client_wasm_factory(reject_unauthorized_fn_id, route)));
    WALLET_ROUTES[(int) wallet] = route;
  } catch (...) {
    error = bridge_error(classify_current_exception(ERROR_CONTEXT_CREATE));
  }
#else
  error = bridge_error("CORE_UNCLASSIFIED");
#endif
  if (error.empty()) callback((int) wallet); // callback with wallet memory address
  else callback(error);
}

string zephyr_wasm_bridge::get_full_wallet_seed_languages() {
  try {
#if defined BUILD_WALLET_FULL
    ZEPHYR_TS_TEST_THROW("error.utility", "languages");
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("languages", monero_utils::to_rapidjson_val(doc.GetAllocator(), monero_wallet_full::get_mnemonic_languages()), doc.GetAllocator());
    return monero_utils::serialize(doc);
#else
    return bridge_error("CORE_UNCLASSIFIED");
#endif
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_UTILITY));
  }
}

// The fixed core's keys-only wallet takes explicit arguments instead of a config. Fields that
// the keys-only API cannot honour are rejected instead of being ignored silently.
static monero_network_type keys_wallet_network_type(const monero_wallet_config& config) {
  if (config.m_network_type == boost::none) throw bridge_failure("NETWORK_TYPE");
  if (config.m_restore_height != boost::none) throw bridge_failure("KEYS_ONLY_RESTORE_HEIGHT");
  if (config.m_account_lookahead != boost::none || config.m_subaddress_lookahead != boost::none) throw bridge_failure("KEYS_ONLY_LOOKAHEAD");
  if ((config.m_server_uri != boost::none && !config.m_server_uri->empty()) || (config.m_server_username != boost::none && !config.m_server_username->empty()) || (config.m_server_password != boost::none && !config.m_server_password->empty())) throw bridge_failure("DAEMON_CONNECTION");
  return config.m_network_type.get();
}

static bool has_value(const boost::optional<std::string>& value) {
  return value != boost::none && !value->empty();
}

void zephyr_wasm_bridge::create_keys_wallet_random(const string& config_json, emscripten::val callback) {
  monero_wallet* wallet = nullptr;
  string error;
  try {
    shared_ptr<monero_wallet_config> config = monero_wallet_config::deserialize(config_json);
    monero_network_type network_type = keys_wallet_network_type(*config);
    if (has_value(config->m_mnemonic) || has_value(config->m_seed_offset) || has_value(config->m_primary_address) || has_value(config->m_private_view_key) || has_value(config->m_private_spend_key)) throw bridge_failure("CREATE_MODE");
    ZEPHYR_TS_TEST_THROW("error.create", config_json);
    wallet = monero_wallet_keys::create_wallet_random(network_type, has_value(config->m_language) ? config->m_language.get() : std::string("English"));
  } catch (...) {
    error = bridge_error(classify_current_exception(ERROR_CONTEXT_CREATE));
  }
  if (error.empty()) callback((int) wallet); // callback with wallet memory address
  else callback(error);
}

void zephyr_wasm_bridge::create_keys_wallet_from_seed(const string& config_json, emscripten::val callback) {
  monero_wallet* wallet = nullptr;
  string error;
  try {
    shared_ptr<monero_wallet_config> config = monero_wallet_config::deserialize(config_json);
    monero_network_type network_type = keys_wallet_network_type(*config);
    if (!has_value(config->m_mnemonic)) throw bridge_failure("SEED_EMPTY");
    if (has_value(config->m_language)) throw bridge_failure("SEED_LANGUAGE");
    if (has_value(config->m_primary_address) || has_value(config->m_private_view_key) || has_value(config->m_private_spend_key)) throw bridge_failure("SEED_AND_KEYS");
    ZEPHYR_TS_TEST_THROW("error.create", config_json);
    wallet = monero_wallet_keys::create_wallet_from_mnemonic(network_type, config->m_mnemonic.get(), has_value(config->m_seed_offset) ? config->m_seed_offset.get() : std::string(""));
  } catch (...) {
    error = bridge_error(classify_current_exception(ERROR_CONTEXT_CREATE));
  }
  if (error.empty()) callback((int) wallet); // callback with wallet memory address
  else callback(error);
}

void zephyr_wasm_bridge::create_keys_wallet_from_keys(const string& config_json, emscripten::val callback) {
  monero_wallet* wallet = nullptr;
  string error;
  try {
    shared_ptr<monero_wallet_config> config = monero_wallet_config::deserialize(config_json);
    monero_network_type network_type = keys_wallet_network_type(*config);
    if (has_value(config->m_mnemonic) || has_value(config->m_seed_offset)) throw bridge_failure("SEED_AND_KEYS");
    if (!has_value(config->m_primary_address) && !has_value(config->m_private_spend_key)) throw bridge_failure("KEYS_MISSING");
    ZEPHYR_TS_TEST_THROW("error.create", config_json);
    wallet = monero_wallet_keys::create_wallet_from_keys(network_type, has_value(config->m_primary_address) ? config->m_primary_address.get() : std::string(""), has_value(config->m_private_view_key) ? config->m_private_view_key.get() : std::string(""), has_value(config->m_private_spend_key) ? config->m_private_spend_key.get() : std::string(""), has_value(config->m_language) ? config->m_language.get() : std::string("English"));
  } catch (...) {
    error = bridge_error(classify_current_exception(ERROR_CONTEXT_CREATE));
  }
  if (error.empty()) callback((int) wallet); // callback with wallet memory address
  else callback(error);
}

string zephyr_wasm_bridge::get_keys_wallet_seed_languages() {
  try {
    ZEPHYR_TS_TEST_THROW("error.utility", "languages");
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("languages", monero_utils::to_rapidjson_val(doc.GetAllocator(), monero_wallet_keys::get_mnemonic_languages()), doc.GetAllocator());
    return monero_utils::serialize(doc);
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_UTILITY));
  }
}

// ------------------------ WALLET INSTANCE METHODS ---------------------------

int zephyr_wasm_bridge::is_view_only(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", "view only");
    return wallet->is_view_only() ? 1 : 0;
  } catch (...) {
    return -1; // failure (no text): the TypeScript layer accepts only 0 and 1
  }
}

#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
string zephyr_wasm_bridge::get_daemon_connection(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  std::shared_ptr<monero_rpc_connection> daemon_connection = wallet->get_daemon_connection();
  return daemon_connection == nullptr ? "" : daemon_connection->serialize();
}

bool zephyr_wasm_bridge::is_daemon_trusted(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->is_daemon_trusted();
}

void zephyr_wasm_bridge::get_daemon_max_peer_height(int handle, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback((long) wallet->get_daemon_max_peer_height());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

//void add_listener(int handle, monero_wallet_listener& listener);
//void remove_listener(int handle, monero_wallet_listener& listener);
//set<monero_wallet_listener*> get_listeners(int handle);
//  int get_network_type(int handle) const;

#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
// ----------------- DAEMON CONNECTION, SYNC AND BALANCES -----------------

// Read-only daemon access. Callers are full wallets only (the SDK gates the kind; a keys-only
// handle has no route and rejects with DAEMON_CONNECTION). Results are fixed-format strings; a
// failure is {"error":"<IDENTIFIER>"}. Calls that reach the network run through Asyncify and
// report through the callback, invoked outside every try block.

void zephyr_wasm_bridge::set_daemon_connection(int handle, const string& uri, const string& base_path, emscripten::val callback) {
  string result;
  try {
    ZEPHYR_TS_TEST_THROW("error.daemon", uri + base_path);
    if (!valid_daemon_origin(uri) || !valid_base_path(base_path) || (uri.empty() && !base_path.empty())) throw bridge_failure("DAEMON_ADDRESS");
    std::shared_ptr<epee::net_utils::http::http_client_wasm_route> route = route_of(handle);
    route->base_path = base_path;
    route->last_failure = 0;
    monero_wallet* wallet = (monero_wallet*) handle;
    wallet->set_daemon_connection(uri, "", ""); // no credentials: the SDK rejects them before this call
  } catch (...) {
    result = bridge_error(daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_DAEMON)));
  }
  callback(result);
}

void zephyr_wasm_bridge::is_connected_to_daemon(int handle, emscripten::val callback) {
  string result;
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.daemon", "connected");
    monero_wallet* wallet = (monero_wallet*) handle;
    result = wallet->is_connected_to_daemon() ? "true" : "false";
  } catch (...) {
    result = bridge_error(daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_DAEMON)));
  }
  callback(result);
}

void zephyr_wasm_bridge::get_daemon_height(int handle, emscripten::val callback) {
  string result;
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.daemon", "daemon height");
    monero_wallet* wallet = (monero_wallet*) handle;
    result = decimal(wallet->get_daemon_height());
  } catch (...) {
    result = bridge_error(daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_DAEMON)));
  }
  callback(result);
}

// Restore height of a newly created random wallet, with the rule of the core's own random-wallet
// creation (monero_wallet_full::create_wallet_random): if the daemon connection check succeeds, the
// restore height becomes the daemon height; otherwise the core's date-based estimate stays. The SDK
// creates wallets offline and sets the daemon afterwards, so it applies this rule in a second step.
// Result "true" (set from the daemon height) or "false" (estimate kept); a failure is a fixed identifier.
void zephyr_wasm_bridge::set_restore_height_from_daemon(int handle, emscripten::val callback) {
  string result;
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.daemon", "restore height from daemon");
    monero_wallet* wallet = (monero_wallet*) handle;
    if (wallet->is_connected_to_daemon()) {
      wallet->set_restore_height(wallet->get_daemon_height());
      result = "true";
    } else {
      result = "false";
    }
  } catch (...) {
    result = bridge_error(daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_DAEMON)));
  }
  callback(result);
}

// wallet height (core uint64_t) as exact decimal text; no network access
string zephyr_wasm_bridge::get_height(int handle) {
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.height", "height");
    monero_wallet* wallet = (monero_wallet*) handle;
    return decimal(wallet->get_height());
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// one blocking sync; start_height "" uses the core's default start, otherwise exact decimal text
void zephyr_wasm_bridge::sync(int handle, const string& start_height, emscripten::val callback) {
  string result;
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.sync", start_height);
    monero_wallet* wallet = (monero_wallet*) handle;
    monero_sync_result sync_result = start_height.empty() ? wallet->sync() : wallet->sync(parse_height(start_height));
    test_barrier("sync.after");
    result = string("{\"numBlocksFetched\":\"") + decimal(sync_result.m_num_blocks_fetched) + "\",\"receivedMoney\":" + (sync_result.m_received_money ? "true" : "false") + "}";
  } catch (...) {
    result = bridge_error(daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_SYNC)));
  }
  callback(result);
}

// {"balances":{"<asset>":"<decimal>",...}}: the core's wallet map, including its zero entries
string zephyr_wasm_bridge::get_balance_wallet(int handle) {
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.balance", "wallet");
    monero_wallet* wallet = (monero_wallet*) handle;
    return string("{\"balances\":") + asset_map_json(wallet->get_balance()) + "}";
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_unlocked_balance_wallet(int handle) {
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.balance", "wallet unlocked");
    monero_wallet* wallet = (monero_wallet*) handle;
    return string("{\"balances\":") + asset_map_json(wallet->get_unlocked_balance()) + "}";
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// {"balances":{"<subaddress index>":{"<asset>":"<decimal>",...},...}}: the core's account map;
// subaddresses without an entry in the core's map stay absent
static string account_map_json(const std::map<uint32_t, std::map<std::string, uint64_t>>& amounts) {
  string out = "{\"balances\":{";
  bool first = true;
  for (const auto& entry : amounts) {
    if (!first) out += ",";
    first = false;
    out += "\"" + std::to_string(entry.first) + "\":" + asset_map_json(entry.second);
  }
  return out + "}}";
}

string zephyr_wasm_bridge::get_balance_account(int handle, const uint32_t account_idx) {
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.balance", "account");
    monero_wallet* wallet = (monero_wallet*) handle;
    return account_map_json(wallet->get_balance(account_idx));
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_unlocked_balance_account(int handle, const uint32_t account_idx) {
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.balance", "account unlocked");
    monero_wallet* wallet = (monero_wallet*) handle;
    return account_map_json(wallet->get_unlocked_balance(account_idx));
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// asset-first scalar: exact decimal text of the core's value for a core asset type
string zephyr_wasm_bridge::get_balance_asset(int handle, const string& asset_type, const uint32_t account_idx, bool has_subaddress, const uint32_t subaddress_idx) {
  try {
    route_of(handle);
    if (!is_core_asset_type(asset_type)) throw bridge_failure("ASSET_TYPE");
    ZEPHYR_TS_TEST_THROW("error.balance", asset_type);
    monero_wallet* wallet = (monero_wallet*) handle;
    return decimal(has_subaddress ? wallet->get_balance(asset_type, account_idx, subaddress_idx) : wallet->get_balance(asset_type, account_idx));
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_unlocked_balance_asset(int handle, const string& asset_type, const uint32_t account_idx, bool has_subaddress, const uint32_t subaddress_idx) {
  try {
    route_of(handle);
    if (!is_core_asset_type(asset_type)) throw bridge_failure("ASSET_TYPE");
    ZEPHYR_TS_TEST_THROW("error.balance", asset_type);
    monero_wallet* wallet = (monero_wallet*) handle;
    return decimal(has_subaddress ? wallet->get_unlocked_balance(asset_type, account_idx, subaddress_idx) : wallet->get_unlocked_balance(asset_type, account_idx));
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_version(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", "version");
    return wallet->get_version().serialize();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_seed(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_mnemonic());
    return wallet->get_mnemonic();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_seed_language(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_mnemonic_language());
    return wallet->get_mnemonic_language();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_public_view_key(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_private_view_key());
    return wallet->get_public_view_key();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_private_view_key(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_private_view_key());
    return wallet->get_private_view_key();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_public_spend_key(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_private_spend_key());
    return wallet->get_public_spend_key();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_private_spend_key(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_private_spend_key());
    return wallet->get_private_spend_key();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_address(int handle, const uint32_t account_idx, const uint32_t subaddress_idx) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_private_spend_key());
    return wallet->get_address(account_idx, subaddress_idx);
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

string zephyr_wasm_bridge::get_address_index(int handle, const string& address) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.address", address);
    monero_subaddress subaddress = wallet->get_address_index(address);
    return subaddress.serialize();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_ADDRESS));
  }
}

string zephyr_wasm_bridge::get_integrated_address(int handle, const string& standard_address, const string& payment_id) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.address", standard_address + " " + payment_id);
    monero_integrated_address integrated_address = wallet->get_integrated_address(standard_address, payment_id);
    return integrated_address.serialize();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_ADDRESS));
  }
}

string zephyr_wasm_bridge::decode_integrated_address(int handle, const string& integrated_address_str) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.address", integrated_address_str);
    monero_integrated_address integrated_address = wallet->decode_integrated_address(integrated_address_str);
    return integrated_address.serialize();
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_ADDRESS));
  }
}

#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
void zephyr_wasm_bridge::get_height_by_date(int handle, uint16_t year, uint8_t month, uint8_t day, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback((long) wallet->get_height_by_date(year, month, day));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::is_daemon_synced(int handle, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->is_daemon_synced());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::is_synced(int handle, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  callback(wallet->is_synced());
}

#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
int zephyr_wasm_bridge::get_network_type(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", "network type");
    return (int) wallet->get_network_type();
  } catch (...) {
    return -1; // failure (no text): the TypeScript layer accepts only 0, 1 and 2
  }
}

// The core height is uint64_t; WASM32 long is 32 bits. Return exact decimal text, which the
// TypeScript layer converts with a checked safe-integer conversion.
string zephyr_wasm_bridge::get_restore_height(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("error.getter", wallet->get_private_spend_key());
    return std::to_string(wallet->get_restore_height());
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
void zephyr_wasm_bridge::set_restore_height(int handle, long restore_height) {
  monero_wallet* wallet = (monero_wallet*) handle;
  wallet->set_restore_height(restore_height);
}

void zephyr_wasm_bridge::set_listener(int wallet_handle, int old_listener_handle, emscripten::val callback, emscripten::val on_sync_progress, emscripten::val on_new_block, emscripten::val on_balances_changed, emscripten::val on_output_received, emscripten::val on_output_spent) {
  monero_wallet* wallet = (monero_wallet*) wallet_handle;
  try {

    // remove old listener
    wallet_wasm_listener* old_listener = (wallet_wasm_listener*) old_listener_handle;
    if (old_listener != nullptr) {
      wallet->remove_listener(*old_listener);
      delete old_listener;
    }

    // done if listeners not given
    if (on_sync_progress == emscripten::val::undefined()) {
      callback(0);
      return;
    }

    // add new listener
    wallet_wasm_listener* listener = new wallet_wasm_listener(on_sync_progress, on_new_block, on_balances_changed, on_output_received, on_output_spent);
    wallet->add_listener(*listener);
    callback((int) listener);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::stop_syncing(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  wallet->stop_syncing();
}

void zephyr_wasm_bridge::rescan_spent(int handle, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    wallet->rescan_spent();
    callback();
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::scan_txs(int handle, const string& args, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize args to property tree
    std::istringstream iss = std::istringstream(args);
    boost::property_tree::ptree node;
    boost::property_tree::read_json(iss, node);

    // get tx hashes from args
    vector<string> tx_hashes;
    boost::property_tree::ptree tx_hashes_node = node.get_child("txHashes");
    for (const auto& child : tx_hashes_node) tx_hashes.push_back(child.second.get_value<string>());

    // scan txs
    wallet->scan_txs(tx_hashes);
    callback();
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::rescan_blockchain(int handle, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    wallet->rescan_blockchain();
    callback();
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

string zephyr_wasm_bridge::get_balance_subaddress(int handle, const uint32_t account_idx, const uint32_t subaddress_idx) {
  monero_wallet* wallet = (monero_wallet*) handle;

  // serialize wallet balance to json string {"balance": ...}
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::Value value;
  doc.AddMember("balance", rapidjson::Value().SetUint64(wallet->get_balance(account_idx, subaddress_idx)), doc.GetAllocator());
  return gen_utils::serialize(doc);
}

string zephyr_wasm_bridge::get_unlocked_balance_subaddress(int handle, const uint32_t account_idx, const uint32_t subaddress_idx) {
  monero_wallet* wallet = (monero_wallet*) handle;

  // serialize subaddress unlocked balance to json string {"unlockedBalance": ...}
  rapidjson::Document doc;
  doc.SetObject();
  rapidjson::Value value;
  doc.AddMember("unlockedBalance", rapidjson::Value().SetUint64(wallet->get_unlocked_balance(account_idx, subaddress_idx)), doc.GetAllocator());
  return gen_utils::serialize(doc);
}

string zephyr_wasm_bridge::get_accounts(int handle, bool include_subaddresses, const string& tag) {

  // get accounts
  monero_wallet* wallet = (monero_wallet*) handle;
  vector<monero_account> accounts = wallet->get_accounts(include_subaddresses, tag);

  // wrap and serialize accounts
  rapidjson::Document doc;
  doc.SetObject();
  doc.AddMember("accounts", monero_utils::to_rapidjson_val(doc.GetAllocator(), accounts), doc.GetAllocator());
  return gen_utils::serialize(doc);
}

string zephyr_wasm_bridge::get_account(int handle, uint32_t account_idx, bool include_subaddresses) {
  monero_wallet* wallet = (monero_wallet*) handle;
  monero_account account = wallet->get_account(account_idx, include_subaddresses);
  return account.serialize();
}

string zephyr_wasm_bridge::create_account(int handle, const string& label) {
  monero_wallet* wallet = (monero_wallet*) handle;
  monero_account account = wallet->create_account(label);
  return account.serialize();
}

string zephyr_wasm_bridge::get_subaddresses(int handle, const string& args) {
  monero_wallet* wallet = (monero_wallet*) handle;

  // deserialize args to property tree
  std::istringstream iss = std::istringstream(args);
  boost::property_tree::ptree node;
  boost::property_tree::read_json(iss, node);

  // get account index argument
  uint32_t account_idx = node.get_child("accountIdx").get_value<uint32_t>();

  // get subaddresses indices argument
  vector<uint32_t> subaddress_indices;
  for (const auto& item : node.get_child("subaddressIndices")) {
    subaddress_indices.push_back(item.second.get_value<uint32_t>());
  }

  // get subaddresses
  vector<monero_subaddress> subaddresses = wallet->get_subaddresses(account_idx, subaddress_indices);

  // wrap and serialize subaddresses
  rapidjson::Document doc;
  doc.SetObject();
  doc.AddMember("subaddresses", monero_utils::to_rapidjson_val(doc.GetAllocator(), subaddresses), doc.GetAllocator());
  return gen_utils::serialize(doc);
}

string zephyr_wasm_bridge::create_subaddress(int handle, const uint32_t account_idx, const string& label) {
  monero_wallet* wallet = (monero_wallet*) handle;
  monero_subaddress subaddress = wallet->create_subaddress(account_idx, label);
  return subaddress.serialize();
}

void zephyr_wasm_bridge::set_subaddress_label(int handle, const uint32_t account_idx, const uint32_t subaddress_idx, const string& label) {
  monero_wallet* wallet = (monero_wallet*) handle;
  wallet->set_subaddress_label(account_idx, subaddress_idx, label);
}

void zephyr_wasm_bridge::get_txs(int handle, const string& tx_query_json, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize tx query string
    shared_ptr<monero_tx_query> tx_query = monero_tx_query::deserialize_from_block(tx_query_json);

    // get txs
    vector<shared_ptr<monero_tx_wallet>> txs = wallet->get_txs(*tx_query);

    // wrap and serialize blocks
    vector<shared_ptr<monero_block>> blocks = monero_utils::get_blocks_from_txs(txs);
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("blocks", monero_utils::to_rapidjson_val(doc.GetAllocator(), blocks), doc.GetAllocator());
    callback(gen_utils::serialize(doc));

    // free memory
    monero_utils::free(blocks);
    monero_utils::free(tx_query);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::get_transfers(int handle, const string& transfer_query_json, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize transfer query
    shared_ptr<monero_transfer_query> transfer_query = monero_transfer_query::deserialize_from_block(transfer_query_json);

  //  // log query
  //  if (transfer_query->m_tx_query != boost::none) {
  //    if ((*transfer_query->m_tx_query)->m_block == boost::none) cout << "Transfer query's tx query rooted at [tx]:" << (*transfer_query->m_tx_query)->serialize() << endl;
  //    else cout << "Transfer query's tx query rooted at [block]: " << (*(*transfer_query->m_tx_query)->m_block)->serialize() << endl;
  //  } else cout << "Transfer query: " << transfer_query->serialize() << endl;

    // get transfers
    vector<shared_ptr<monero_transfer>> transfers = wallet->get_transfers(*transfer_query);

    // wrap and serialize blocks
    vector<shared_ptr<monero_block>> blocks = monero_utils::get_blocks_from_transfers(transfers);
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("blocks", monero_utils::to_rapidjson_val(doc.GetAllocator(), blocks), doc.GetAllocator());
    callback(gen_utils::serialize(doc));

    // free memory
    monero_utils::free(blocks);
    monero_utils::free(transfer_query->m_tx_query);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

//  emscripten::function("get_incoming_transfers", &zephyr_wasm_bridge::TODO);
//  emscripten::function("get_outgoing_transfers", &zephyr_wasm_bridge::TODO);

void zephyr_wasm_bridge::get_outputs(int handle, const string& output_query_json, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize output query
    shared_ptr<monero_output_query> output_query = monero_output_query::deserialize_from_block(output_query_json);

    // get outputs
    vector<shared_ptr<monero_output_wallet>> outputs = wallet->get_outputs(*output_query);

    // wrap and serialize blocks
    vector<shared_ptr<monero_block>> blocks = monero_utils::get_blocks_from_outputs(outputs);
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("blocks", monero_utils::to_rapidjson_val(doc.GetAllocator(), blocks), doc.GetAllocator());
    callback(gen_utils::serialize(doc));

    // free memory
    monero_utils::free(blocks);
    monero_utils::free(output_query->m_tx_query);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::export_outputs(int handle, bool all, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->export_outputs(all));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::import_outputs(int handle, const string& outputs_hex, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->import_outputs(outputs_hex));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::export_key_images(int handle, bool all, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->export_key_images(all)->serialize());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::import_key_images(int handle, const string& key_images_str, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    shared_ptr<monero_key_image_export_result> exported = monero_key_image_export_result::deserialize(key_images_str);
    callback(wallet->import_key_images(exported->m_key_images, exported->m_offset == boost::none ? 0 : exported->m_offset.get())->serialize());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

//  emscripten::function("get_new_key_images_from_last_import", &zephyr_wasm_bridge::get_new_key_images_from_last_import);

void zephyr_wasm_bridge::freeze_output(int handle, const string& key_image, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    wallet->freeze_output(key_image);
    callback();
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::thaw_output(int handle, const string& key_image, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    wallet->thaw_output(key_image);
    callback();
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::is_output_frozen(int handle, const string& key_image, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->is_output_frozen(key_image));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::get_default_fee_priority(int handle, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(static_cast<int>(wallet->get_default_fee_priority()));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::create_txs(int handle, const string& config_json, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize tx config
    shared_ptr<monero_tx_config> config = monero_tx_config::deserialize(config_json);

    // create txs
    vector<shared_ptr<monero_tx_wallet>> txs = wallet->create_txs(*config);

    // serialize and return tx set
    string tx_set_json = txs[0]->m_tx_set->serialize();
    monero_utils::free(txs);
    callback(tx_set_json);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::sweep_output(int handle, const string& config_json, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize tx config
    shared_ptr<monero_tx_config> config = monero_tx_config::deserialize(config_json);

    // sweep output
    shared_ptr<monero_tx_wallet> tx = wallet->sweep_output(*config);

    // serialize and return tx set
    string tx_set_json = tx->m_tx_set->serialize();
    monero_utils::free(tx);
    callback(tx_set_json);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::sweep_unlocked(int handle, const string& config_json, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize tx config
    shared_ptr<monero_tx_config> config = monero_tx_config::deserialize(config_json);

    // sweep unlocked
    vector<shared_ptr<monero_tx_wallet>> txs = wallet->sweep_unlocked(*config);

    // collect tx sets
    vector<shared_ptr<monero_tx_set>> tx_sets;
    for (int i = 0; i < txs.size(); i++) {
      if (std::find(tx_sets.begin(), tx_sets.end(), txs[i]->m_tx_set) == tx_sets.end()) {
        tx_sets.push_back(txs[i]->m_tx_set);
      }
    }

    // wrap and serialize tx sets
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("txSets", monero_utils::to_rapidjson_val(doc.GetAllocator(), tx_sets), doc.GetAllocator());
    string tx_sets_json = gen_utils::serialize(doc);

    // free and return
    monero_utils::free(txs);
    callback(tx_sets_json);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::sweep_dust(int handle, bool relay, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    vector<shared_ptr<monero_tx_wallet>> txs = wallet->sweep_dust(relay);
    string tx_set_json = txs.empty() ? string("{}") : txs[0]->m_tx_set->serialize();
    monero_utils::free(txs);
    callback(tx_set_json);
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::relay_txs(int handle, const string& args, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize args to property tree
    std::istringstream iss = std::istringstream(args);
    boost::property_tree::ptree node;
    boost::property_tree::read_json(iss, node);

    // get tx metadatas from args
    vector<string> tx_metadatas;
    boost::property_tree::ptree tx_metadatas_node = node.get_child("txMetadatas");
    for (const auto& child : tx_metadatas_node) tx_metadatas.push_back(child.second.get_value<string>());

    // relay txs
    vector<string> tx_hashes = wallet->relay_txs(tx_metadatas);

    // wrap and serialize tx hashes
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("txHashes", monero_utils::to_rapidjson_val(doc.GetAllocator(), tx_hashes), doc.GetAllocator());
    callback(gen_utils::serialize(doc));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

string zephyr_wasm_bridge::describe_tx_set(int handle, const string& tx_set_str) {
  monero_wallet* wallet = (monero_wallet*) handle;
  shared_ptr<monero_tx_set> tx_set = monero_tx_set::deserialize(tx_set_str);
  monero_tx_set described_tx_set = wallet->describe_tx_set(*tx_set);
  std::string zephyr_tx_set_json = described_tx_set.serialize();
  monero_utils::free(described_tx_set.m_txs);
  return zephyr_tx_set_json;
}

string zephyr_wasm_bridge::sign_txs(int handle, const string& unsigned_tx_hex) {
  monero_wallet* wallet = (monero_wallet*) handle;
  monero_tx_set signed_tx_set = wallet->sign_txs(unsigned_tx_hex);
  std::string zephyr_tx_set_json = signed_tx_set.serialize();
  monero_utils::free(signed_tx_set.m_txs);
  return zephyr_tx_set_json;
}

void zephyr_wasm_bridge::submit_txs(int handle, const string& signed_tx_hex, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    vector<string> tx_hashes = wallet->submit_txs(signed_tx_hex);

    // wrap and serialize tx hashes
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("txHashes", monero_utils::to_rapidjson_val(doc.GetAllocator(), tx_hashes), doc.GetAllocator());
    callback(gen_utils::serialize(doc));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

string zephyr_wasm_bridge::sign_message(int handle, const string& msg, uint32_t signature_type_num, uint32_t account_idx, uint32_t subaddress_idx) {
  monero_wallet* wallet = (monero_wallet*) handle;
  monero_message_signature_type signature_type = signature_type_num == 0 ? monero_message_signature_type::SIGN_WITH_SPEND_KEY : monero_message_signature_type::SIGN_WITH_VIEW_KEY;
  return wallet->sign_message(msg, signature_type, account_idx, subaddress_idx);
}

string zephyr_wasm_bridge::verify_message(int handle, const string& msg, const string& address, const string& signature) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->verify_message(msg, address, signature).serialize();
}

string zephyr_wasm_bridge::get_tx_key(int handle, const string& tx_hash) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->get_tx_key(tx_hash);
}

void zephyr_wasm_bridge::check_tx_key(int handle, const string& tx_hash, const string& tx_key, const string& address, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->check_tx_key(tx_hash, tx_key, address)->serialize());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::get_tx_proof(int handle, const string& tx_hash, const string& address, const string& message, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->get_tx_proof(tx_hash, address, message));
  } catch (exception& e) {
    callback(string("error: ") + string(e.what())); // indicate error with prefix
  }
}

void zephyr_wasm_bridge::check_tx_proof(int handle, const string& tx_hash, const string& address, const string& message, const string& signature, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->check_tx_proof(tx_hash, address, message, signature)->serialize());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::get_spend_proof(int handle, const string& tx_hash, const string& message, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->get_spend_proof(tx_hash, message));
  } catch (exception& e) {
    callback(string("error: ") + string(e.what()));
  }
}

void zephyr_wasm_bridge::check_spend_proof(int handle, const string& tx_hash, const string& message, const string& signature, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->check_spend_proof(tx_hash, message, signature));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::get_reserve_proof_wallet(int handle, const string& message, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->get_reserve_proof_wallet(message));
  } catch (exception& e) {
    callback(string("error: ") + string(e.what()));
  }
}

void zephyr_wasm_bridge::get_reserve_proof_account(int handle, uint32_t account_idx, const string& amount_str, const string& message, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    std::stringstream sstr(amount_str);
    uint64_t amount;
    sstr >> amount;
    callback(wallet->get_reserve_proof_account(account_idx, amount, message));
  } catch (exception& e) {
    callback(string("error: ") + string(e.what()));
  }
}

void zephyr_wasm_bridge::check_reserve_proof(int handle, const string& address, const string& message, const string& signature, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    callback(wallet->check_reserve_proof(address, message, signature)->serialize());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

string zephyr_wasm_bridge::get_tx_notes(int handle, const string& args) {
  monero_wallet* wallet = (monero_wallet*) handle;

  // deserialize args to property tree
  std::istringstream iss = std::istringstream(args);
  boost::property_tree::ptree node;
  boost::property_tree::read_json(iss, node);

  // get tx hashes from args
  vector<string> tx_hashes;
  boost::property_tree::ptree tx_hashes_node = node.get_child("txHashes");
  for (const auto& child : tx_hashes_node) tx_hashes.push_back(child.second.get_value<string>());

  // get tx notes
  vector<string> notes = wallet->get_tx_notes(tx_hashes);

  // wrap and serialize notes
  rapidjson::Document doc;
  doc.SetObject();
  doc.AddMember("txNotes", monero_utils::to_rapidjson_val(doc.GetAllocator(), notes), doc.GetAllocator());
  return gen_utils::serialize(doc);
}

void zephyr_wasm_bridge::set_tx_notes(int handle, const string& args) {
  monero_wallet* wallet = (monero_wallet*) handle;

  // deserialize args to property tree
  std::istringstream iss = std::istringstream(args);
  boost::property_tree::ptree node;
  boost::property_tree::read_json(iss, node);

  // get tx hashes from args
  vector<string> tx_hashes;
  boost::property_tree::ptree tx_hashes_node = node.get_child("txHashes");
  for (const auto& child : tx_hashes_node) tx_hashes.push_back(child.second.get_value<string>());

  // get tx notes from args
  vector<string> tx_notes;
  boost::property_tree::ptree tx_notes_node = node.get_child("txNotes");
  for (const auto& child : tx_notes_node) tx_notes.push_back(child.second.get_value<string>());

  // set tx notes
  wallet->set_tx_notes(tx_hashes, tx_notes);
}

string zephyr_wasm_bridge::get_address_book_entries(int handle, const string& args) {
  monero_wallet* wallet = (monero_wallet*) handle;

  // deserialize args to property tree
  std::istringstream iss = std::istringstream(args);
  boost::property_tree::ptree node;
  boost::property_tree::read_json(iss, node);

  // get entry indices from args
  vector<uint64_t> entry_indices;
  boost::property_tree::ptree entry_indices_node = node.get_child("entryIndices");
  for (const auto& child : entry_indices_node) entry_indices.push_back(child.second.get_value<uint64_t>());

  // get address book entries
  vector<monero_address_book_entry> entries = wallet->get_address_book_entries(entry_indices);

  // wrap and serialize entries
  rapidjson::Document doc;
  doc.SetObject();
  doc.AddMember("entries", monero_utils::to_rapidjson_val(doc.GetAllocator(), entries), doc.GetAllocator());
  return gen_utils::serialize(doc);
}

int zephyr_wasm_bridge::add_address_book_entry(int handle, const string& address, const string& description) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->add_address_book_entry(address, description);
}

void zephyr_wasm_bridge::edit_address_book_entry(int handle, int index, bool set_address, const string& address, bool set_description, const string& description) {
  monero_wallet* wallet = (monero_wallet*) handle;
  wallet->edit_address_book_entry(index, set_address, address, set_description, description);
}

void zephyr_wasm_bridge::delete_address_book_entry(int handle, int index) {
  monero_wallet* wallet = (monero_wallet*) handle;
  wallet->delete_address_book_entry(index);
}

void zephyr_wasm_bridge::tag_accounts(int handle, const string& args) {
  cout << "string zephyr_wasm_bridge::tag_accounts()" << endl;
  throw runtime_error("Not implemented");
}

void zephyr_wasm_bridge::untag_accounts(int handle, const string& args) {
  cout << "string zephyr_wasm_bridge::untag_accounts()" << endl;
  throw runtime_error("Not implemented");
}

string zephyr_wasm_bridge::get_account_tags(int handle) {
  cout << "string zephyr_wasm_bridge::get_account_tags()" << endl;
  throw runtime_error("Not implemented");
}

void zephyr_wasm_bridge::set_account_tag_label(int handle, const string& tag, const string& label) {
  cout << "string zephyr_wasm_bridge::set_account_tag_label()" << endl;
  throw runtime_error("Not implemented");
}

string zephyr_wasm_bridge::get_payment_uri(int handle, const string& config_json) {
  monero_wallet* wallet = (monero_wallet*) handle;
  shared_ptr<monero_tx_config> config = monero_tx_config::deserialize(config_json);
  return wallet->get_payment_uri(*config);
}

string zephyr_wasm_bridge::parse_payment_uri(int handle, const string& uri) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->parse_payment_uri(uri)->serialize();
}

string zephyr_wasm_bridge::get_attribute(int handle, const string& key) {
  monero_wallet* wallet = (monero_wallet*) handle;
  string value;
  if (!wallet->get_attribute(key, value)) return "";
  return value;
}

void zephyr_wasm_bridge::set_attribute(int handle, const string& key, const string& val) {
  monero_wallet* wallet = (monero_wallet*) handle;
  wallet->set_attribute(key, val);
}

bool zephyr_wasm_bridge::is_multisig_import_needed(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->is_multisig_import_needed();
}

string zephyr_wasm_bridge::get_multisig_info(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->get_multisig_info().serialize();
}

string zephyr_wasm_bridge::prepare_multisig(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->prepare_multisig();
}

void zephyr_wasm_bridge::make_multisig(int handle, const string& args, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize args to property tree
    std::istringstream iss = std::istringstream(args);
    boost::property_tree::ptree node;
    boost::property_tree::read_json(iss, node);

    // get multisig hexes from args
    vector<string> multisig_hexes;
    boost::property_tree::ptree multisig_hexes_node = node.get_child("multisigHexes");
    for (const auto& child : multisig_hexes_node) multisig_hexes.push_back(child.second.get_value<string>());

    // get threshold and password from args
    int threshold = node.get_child("threshold").get_value<int>();
    string password = node.get_child("password").get_value<string>();

    // make multisig
    callback(wallet->make_multisig(multisig_hexes, threshold, password));
  } catch (exception& e) {
    callback(string("error: ") + string(e.what())); // indicate error with prefix
  }
}

void zephyr_wasm_bridge::exchange_multisig_keys(int handle, const string& args, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize args to property tree
    std::istringstream iss = std::istringstream(args);
    boost::property_tree::ptree node;
    boost::property_tree::read_json(iss, node);

    // get multisig hexes from args
    vector<string> multisig_hexes;
    boost::property_tree::ptree multisig_hexes_node = node.get_child("multisigHexes");
    for (const auto& child : multisig_hexes_node) multisig_hexes.push_back(child.second.get_value<string>());

    // get password from args
    string password = node.get_child("password").get_value<string>();

    // exchange multisig keys
    callback(wallet->exchange_multisig_keys(multisig_hexes, password).serialize());
  } catch (exception& e) {
    callback(string("error: ") + string(e.what())); // indicate error with prefix
  }
}

string zephyr_wasm_bridge::export_multisig_hex(int handle) {
  monero_wallet* wallet = (monero_wallet*) handle;
  return wallet->export_multisig_hex();
}

void zephyr_wasm_bridge::import_multisig_hex(int handle, const string& args, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {

    // deserialize args to property tree
    std::istringstream iss = std::istringstream(args);
    boost::property_tree::ptree node;
    boost::property_tree::read_json(iss, node);

    // extract args
    vector<string> multisig_hexes;
    boost::property_tree::ptree multisig_hexes_node = node.get_child("multisigHexes");
    for (const auto& child : multisig_hexes_node) multisig_hexes.push_back(child.second.get_value<string>());
    bool refresh_after_import = node.get_child("refreshAfterImport").get_value<bool>();

    // import multisig hex
    callback(wallet->import_multisig_hex(multisig_hexes, refresh_after_import));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::sign_multisig_tx_hex(int handle, const string& multisig_tx_hex, emscripten::val callback) {
  try {
    monero_wallet* wallet = (monero_wallet*) handle;
    monero_multisig_sign_result result = wallet->sign_multisig_tx_hex(multisig_tx_hex);
    callback(result.serialize());
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

void zephyr_wasm_bridge::submit_multisig_tx_hex(int handle, const string& signed_multisig_tx_hex, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  try {
    vector<string> tx_hashes = wallet->submit_multisig_tx_hex(signed_multisig_tx_hex);

    // wrap and serialize tx hashes
    rapidjson::Document doc;
    doc.SetObject();
    doc.AddMember("txHashes", monero_utils::to_rapidjson_val(doc.GetAllocator(), tx_hashes), doc.GetAllocator());
    callback(gen_utils::serialize(doc));
  } catch (exception& e) {
    callback(string(e.what()));
  }
}

#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
// Result: callback() on success, else callback({"error":"<ID>","passwordState":"<STATE>"}) where
// STATE is "unchanged" (the native wallet still holds the old password), "changed" (it holds the
// new one although the call failed) or "unknown" (neither password passes the cache-key test).
void zephyr_wasm_bridge::change_wallet_password(int handle, const string& old_password, const string& new_password, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  string error;
  bool verified = false;
  try {
    test_barrier("change_password"); // test-only synchronization point while the handle is in use
    ZEPHYR_TS_TEST_THROW("change_password", old_password + " " + new_password); // test-only operation failure before verification
#if defined BUILD_WALLET_FULL
    // Under __EMSCRIPTEN__ the fixed core skips verify_password() in change_password() and wallet2
    // runs unattended, so change_password() alone accepts any old password. Verify it first with
    // the core's own deterministic check: get_keys_file_data() compares the cache key derived from
    // the given password and throws invalid_password otherwise. No core code or format changes.
    monero_wallet_full* full = dynamic_cast<monero_wallet_full*>(wallet);
    if (full == nullptr) throw bridge_failure("KEYS_ONLY_PASSWORD");
    {
      std::string checked = full->get_keys_file_buffer(old_password, full->is_view_only());
      std::fill(checked.begin(), checked.end(), '\0'); // discard the encrypted keys copy
    }
    verified = true;
#endif
    wallet->change_password(old_password, new_password);
    ZEPHYR_TS_TEST_THROW("change_password.after", old_password + " " + new_password); // test-only failure after the core changed the password
  } catch (...) {
    const char* identifier = classify_current_exception(ERROR_CONTEXT_CHANGE_PASSWORD);
    const char* state = verified ? probe_password_state(handle, old_password, new_password) : "unchanged";
    error = string("{\"error\":\"") + identifier + "\",\"passwordState\":\"" + state + "\"}";
  }
  if (error.empty()) callback();
  else callback(error);
}

// bypass embind, which waits on the active Asyncify call even for synchronous exports
#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
extern "C" EMSCRIPTEN_KEEPALIVE void request_wallet_shutdown(int handle) {
  ((monero_wallet_full*) handle)->request_shutdown();
}

#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
void zephyr_wasm_bridge::close(int handle, bool save, int listener_handle, emscripten::val callback) {
  monero_wallet* wallet = (monero_wallet*) handle;
  string error;
  try {
    if (listener_handle != 0) throw bridge_failure("LISTENER"); // set_listener is not bound in this build
    if (save) throw bridge_failure("SAVE_ON_CLOSE"); // saving is handled outside WebAssembly
    ZEPHYR_TS_TEST_THROW("close.native", "close"); // test-only; the handle stays valid
    wallet->close(save); // drain native work before deleting the wallet
    delete wallet;
    WALLET_ROUTES.erase(handle); // no-op for keys-only wallets
  } catch (...) {
    error = bridge_error(classify_current_exception(ERROR_CONTEXT_CLOSE));
  }
  if (error.empty()) callback();
  else callback(error);
}

string zephyr_wasm_bridge::get_keys_file_buffer(int handle, string password, bool view_only) {
#if defined BUILD_WALLET_FULL
  monero_wallet_full* wallet = (monero_wallet_full*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("buffer.native", password);
    return to_owned_buffer(wallet->get_keys_file_buffer(password, view_only));
  } catch (...) {
    return owned_buffer_error(classify_current_exception(ERROR_CONTEXT_BUFFER));
  }
#else
  return owned_buffer_error("NATIVE_BUFFER_FAILED");
#endif
}

string zephyr_wasm_bridge::get_cache_file_buffer(int handle) {
#if defined BUILD_WALLET_FULL
  monero_wallet_full* wallet = (monero_wallet_full*) handle;
  try {
    ZEPHYR_TS_TEST_THROW("buffer.native", wallet->get_private_spend_key());
    return to_owned_buffer(wallet->get_cache_file_buffer());
  } catch (...) {
    return owned_buffer_error(classify_current_exception(ERROR_CONTEXT_BUFFER));
  }
#else
  return owned_buffer_error("NATIVE_BUFFER_FAILED");
#endif
}

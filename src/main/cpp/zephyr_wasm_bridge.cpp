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
#include "cryptonote_core/cryptonote_tx_utils.h"
#include "cryptonote_basic/cryptonote_basic_impl.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "rapidjson/writer.h"
#include "rapidjson/stringbuffer.h"

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
// pinned core's literal "invalid password" (wallet2::load_keys_buf); 11 to 19 typed build failures
// (test_throw_build) (h.kind[name], default 1)
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
    return (kind >= 1 && kind <= 5) || (kind >= 11 && kind <= 19) ? kind : 1;
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

// test-only synthetic incoming pool records ({"records":[{"hash","amount","asset"?,"accountIndex","subaddressIndex"},..]})
// that refresh_pool adds to the core's selection; returns a malloc'd JSON text or 0 when none is armed
EM_JS(char*, zephyr_ts_test_pool_records, (), {
  var h = Module["__zephyrTsTestHooks"];
  if (!h || !h.poolRecords) return 0;
  var s = JSON.stringify({ records: h.poolRecords });
  if (!h.events) h.events = [];
  h.events.push("pool-records:" + h.poolRecords.length);
  var n = lengthBytesUTF8(s) + 1;
  var p = _malloc(n);
  stringToUTF8(s, p, n);
  return p;
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

  // BEGIN CORE MESSAGE TABLE (daemon context of builds)
  // fixed messages of the pinned core's build path for failed daemon requests (wallet2::use_fork_rules);
  // any other text of a build failure is never compared beyond these entries (TX_BUILD_FAILED)
  const core_message_rule BUILD_DAEMON_MESSAGE_RULES[] = {
    {"Failed to get height", "DAEMON_RESPONSE"},
    {"Failed to get earliest fork height", "DAEMON_RESPONSE"},
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

  // BEGIN CORE MESSAGE TABLE (address index context)
  // get_address_index of the wallet wrapper: a malformed address (or one of another network), and a
  // well-formed address that none of the wallet's subaddresses has
  const core_message_rule ADDRESS_INDEX_MESSAGE_RULES[] = {
    {"Invalid address", "CORE_INVALID_ADDRESS"},
    {"Address doesn't belong to the wallet", "ADDRESS_NOT_IN_WALLET"}
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
    return context == ERROR_CONTEXT_DAEMON || context == ERROR_CONTEXT_SYNC || context == ERROR_CONTEXT_BUILD ? "DAEMON_UNREACHABLE" : context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::wallet_rpc_error&) {
    // busy, payment or other daemon status, including node-supplied text that is not read
    return context == ERROR_CONTEXT_DAEMON || context == ERROR_CONTEXT_SYNC || context == ERROR_CONTEXT_BUILD ? "DAEMON_RESPONSE" : context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::refresh_error&) {
    // failed daemon request or unusable daemon data during refresh (blocks, hashes, pool, indices)
    return context == ERROR_CONTEXT_DAEMON || context == ERROR_CONTEXT_SYNC || context == ERROR_CONTEXT_BUILD ? "DAEMON_RESPONSE" : context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::not_enough_unlocked_money&) {
    // the transfer errors of the core's transaction build (build_txs); no other binding builds
    return context == ERROR_CONTEXT_BUILD ? "NOT_ENOUGH_UNLOCKED" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::not_enough_money&) {
    return context == ERROR_CONTEXT_BUILD ? "NOT_ENOUGH_MONEY" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::tx_not_possible&) {
    return context == ERROR_CONTEXT_BUILD ? "NOT_ENOUGH_FOR_FEE" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::not_enough_outs_to_mix&) {
    return context == ERROR_CONTEXT_BUILD ? "NOT_ENOUGH_OUTS_TO_MIX" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::tx_too_big&) {
    return context == ERROR_CONTEXT_BUILD ? "TX_TOO_LARGE" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::zero_amount&) {
    return context == ERROR_CONTEXT_BUILD ? "AMOUNT_ZERO" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::tx_sum_overflow&) {
    return context == ERROR_CONTEXT_BUILD ? "AMOUNT_RANGE" : "CORE_UNCLASSIFIED";
  } catch (const tools::error::get_outs_error&) {
    // the ring member request failed at the daemon
    return context == ERROR_CONTEXT_BUILD ? "DAEMON_RESPONSE" : "CORE_UNCLASSIFIED";
  } catch (const std::exception& e) {
    switch (context) {
      case ERROR_CONTEXT_CREATE: return match_core_message(CREATE_MESSAGE_RULES, e.what(), "CORE_UNCLASSIFIED");
      case ERROR_CONTEXT_ADDRESS: return match_core_message(ADDRESS_MESSAGE_RULES, e.what(), "CORE_UNCLASSIFIED");
      case ERROR_CONTEXT_ADDRESS_INDEX: return match_core_message(ADDRESS_INDEX_MESSAGE_RULES, e.what(), "CORE_UNCLASSIFIED");
      case ERROR_CONTEXT_OPEN: return match_core_message(OPEN_MESSAGE_RULES, e.what(), "CORE_WALLET_DATA");
      case ERROR_CONTEXT_CLOSE: return "CORE_CLOSE_FAILED";
      case ERROR_CONTEXT_BUFFER: return "NATIVE_BUFFER_FAILED";
      case ERROR_CONTEXT_DAEMON: return match_core_message(DAEMON_MESSAGE_RULES, e.what(), "DAEMON_RESPONSE");
      case ERROR_CONTEXT_SYNC: return match_core_message(DAEMON_MESSAGE_RULES, e.what(), "SYNC_FAILED");
      case ERROR_CONTEXT_BUILD: return match_core_message(BUILD_DAEMON_MESSAGE_RULES, e.what(), "TX_BUILD_FAILED");
      default: return "CORE_UNCLASSIFIED";
    }
  } catch (...) {
    return context == ERROR_CONTEXT_CLOSE ? "CORE_CLOSE_FAILED" : context == ERROR_CONTEXT_BUFFER ? "NATIVE_BUFFER_FAILED" : context == ERROR_CONTEXT_SYNC ? "SYNC_FAILED" : context == ERROR_CONTEXT_DAEMON ? "DAEMON_RESPONSE" : context == ERROR_CONTEXT_BUILD ? "TX_BUILD_FAILED" : "CORE_UNCLASSIFIED";
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

  // ---- accounts and subaddresses: existence, labels and fixed-format results ----

  // The wrapper has no count of accounts or subaddresses; the core's own listings give them. Every
  // account has its subaddress 0, so an account index the wallet does not have lists no subaddress.
  void require_account(monero_wallet* wallet, uint32_t account_idx) {
    if ((size_t) account_idx >= wallet->get_accounts(false, "").size()) throw bridge_failure("ACCOUNT_NOT_FOUND");
  }

  // every subaddress of an account, index-ordered (the core lists indices 0..n-1); none: no such account
  std::vector<monero_subaddress> subaddresses_of(monero_wallet* wallet, uint32_t account_idx) {
    std::vector<monero_subaddress> all = wallet->get_subaddresses(account_idx, std::vector<uint32_t>());
    if (all.empty()) throw bridge_failure("ACCOUNT_NOT_FOUND");
    for (size_t i = 0; i < all.size(); i++) if (!all[i].m_index || (size_t) *all[i].m_index != i) throw bridge_failure("UNEXPECTED_RESULT");
    return all;
  }

  void require_subaddress(monero_wallet* wallet, uint32_t account_idx, uint32_t subaddress_idx) {
    if ((size_t) subaddress_idx >= subaddresses_of(wallet, account_idx).size()) throw bridge_failure("SUBADDRESS_NOT_FOUND");
  }

  // full wallets only: a keys-only handle has no route (the SDK rejects keys-only wallets before this)
  monero_wallet* accounts_wallet(int handle) {
    if (WALLET_ROUTES.find(handle) == WALLET_ROUTES.end()) throw bridge_failure("KEYS_ONLY_ACCOUNTS");
    return (monero_wallet*) handle;
  }

  // Backstop of the SDK's label rules: well-formed UTF-8 of at most 255 bytes without C0 or C1
  // control characters or DEL. The label itself never appears in a result other than its own field.
  void check_label(const string& label) {
    if (label.size() > 255) throw bridge_failure("LABEL_LENGTH");
    const unsigned char* b = (const unsigned char*) label.data();
    size_t n = label.size();
    for (size_t i = 0; i < n;) {
      unsigned char c = b[i];
      if (c < 0x80) {
        if (c < 0x20 || c == 0x7f) throw bridge_failure("LABEL_CHARACTERS");
        i++;
        continue;
      }
      size_t len = (c >= 0xc2 && c <= 0xdf) ? 2 : (c >= 0xe0 && c <= 0xef) ? 3 : (c >= 0xf0 && c <= 0xf4) ? 4 : 0;
      if (len == 0 || i + len > n) throw bridge_failure("LABEL_CHARACTERS");
      for (size_t k = 1; k < len; k++) if ((b[i + k] & 0xc0) != 0x80) throw bridge_failure("LABEL_CHARACTERS");
      if (c == 0xc2 && b[i + 1] <= 0x9f) throw bridge_failure("LABEL_CHARACTERS");                 // C1 controls U+0080..U+009F
      if (c == 0xe0 && b[i + 1] < 0xa0) throw bridge_failure("LABEL_CHARACTERS");                  // overlong
      if (c == 0xed && b[i + 1] >= 0xa0) throw bridge_failure("LABEL_CHARACTERS");                 // UTF-16 surrogates
      if (c == 0xf0 && b[i + 1] < 0x90) throw bridge_failure("LABEL_CHARACTERS");                  // overlong
      if (c == 0xf4 && b[i + 1] >= 0x90) throw bridge_failure("LABEL_CHARACTERS");                 // above U+10FFFF
      i += len;
    }
  }

  // strict "i,j,k" list of distinct uint32 decimal indices (the SDK sends checked indices); "" means none
  std::vector<uint32_t> parse_indices(const string& text, uint32_t max_count) {
    std::vector<uint32_t> out;
    if (text.empty()) return out;
    size_t pos = 0;
    while (true) {
      size_t end = text.find(',', pos);
      string item = text.substr(pos, end == string::npos ? string::npos : end - pos);
      if (item.empty() || item.size() > 10 || (item.size() > 1 && item[0] == '0')) throw bridge_failure("SUBADDRESS_INDICES");
      for (char c : item) if (c < '0' || c > '9') throw bridge_failure("SUBADDRESS_INDICES");
      unsigned long long v = std::stoull(item);
      if (v > 4294967295ULL) throw bridge_failure("SUBADDRESS_INDICES");
      if (std::find(out.begin(), out.end(), (uint32_t) v) != out.end()) throw bridge_failure("SUBADDRESS_INDICES");
      out.push_back((uint32_t) v);
      if (out.size() > max_count) throw bridge_failure("LISTING_LIMIT");
      if (end == string::npos) break;
      pos = end + 1;
    }
    return out;
  }

  typedef rapidjson::Writer<rapidjson::StringBuffer> json_writer;

  void write_string(json_writer& w, const string& value) {
    w.String(value.data(), (rapidjson::SizeType) value.size());
  }

  void write_asset_map(json_writer& w, const std::map<std::string, uint64_t>& amounts) {
    w.StartObject();
    for (const auto& entry : amounts) {
      if (!is_core_asset_type(entry.first)) throw bridge_failure("UNEXPECTED_ASSET_TYPE");
      write_string(w, entry.first);
      write_string(w, decimal(entry.second));
    }
    w.EndObject();
  }

  // {"accountIndex":a,"index":i,"address":"..","label":"..","balance":{..},"unlockedBalance":{..},"isUsed":b,"numUnspentOutputs":"n"}
  void write_subaddress(json_writer& w, const monero_subaddress& s) {
    if (!s.m_account_index || !s.m_index || !s.m_address || !s.m_label || !s.m_balance || !s.m_unlocked_balance || !s.m_is_used || !s.m_num_unspent_outputs) throw bridge_failure("UNEXPECTED_RESULT");
    w.StartObject();
    w.Key("accountIndex"); w.Uint(*s.m_account_index);
    w.Key("index"); w.Uint(*s.m_index);
    w.Key("address"); write_string(w, *s.m_address);
    w.Key("label"); write_string(w, *s.m_label);
    w.Key("balance"); write_asset_map(w, *s.m_balance);
    w.Key("unlockedBalance"); write_asset_map(w, *s.m_unlocked_balance);
    w.Key("isUsed"); w.Bool(*s.m_is_used);
    w.Key("numUnspentOutputs"); write_string(w, decimal(*s.m_num_unspent_outputs));
    w.EndObject();
  }

  // {"index":a,"primaryAddress":"..","label":"..","subaddressCount":n,"balance":{..},"unlockedBalance":{..}[,"subaddresses":[..]]}
  // The account's label is the label of its subaddress 0 (wallet2 stores it there).
  void write_account(json_writer& w, const monero_account& a, const std::vector<monero_subaddress>& subaddresses, bool include_subaddresses) {
    if (!a.m_index || !a.m_primary_address || !a.m_balance || !a.m_unlocked_balance || subaddresses.empty() || !subaddresses[0].m_label) throw bridge_failure("UNEXPECTED_RESULT");
    w.StartObject();
    w.Key("index"); w.Uint(*a.m_index);
    w.Key("primaryAddress"); write_string(w, *a.m_primary_address);
    w.Key("label"); write_string(w, *subaddresses[0].m_label);
    w.Key("subaddressCount"); w.Uint((unsigned) subaddresses.size());
    w.Key("balance"); write_asset_map(w, *a.m_balance);
    w.Key("unlockedBalance"); write_asset_map(w, *a.m_unlocked_balance);
    if (include_subaddresses) {
      w.Key("subaddresses");
      w.StartArray();
      for (const auto& s : subaddresses) write_subaddress(w, s);
      w.EndArray();
    }
    w.EndObject();
  }

  string account_result(monero_wallet* wallet, uint32_t account_idx, bool include_subaddresses, uint32_t max_subaddresses) {
    std::vector<monero_subaddress> subaddresses = subaddresses_of(wallet, account_idx);
    if (include_subaddresses && subaddresses.size() > max_subaddresses) throw bridge_failure("LISTING_LIMIT");
    monero_account account = wallet->get_account(account_idx, false);
    rapidjson::StringBuffer buffer;
    json_writer w(buffer);
    write_account(w, account, subaddresses, include_subaddresses);
    return string(buffer.GetString(), buffer.GetSize());
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
    require_account(wallet, account_idx);
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
    require_account(wallet, account_idx);
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
    if (has_subaddress) require_subaddress(wallet, account_idx, subaddress_idx); else require_account(wallet, account_idx);
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
    if (has_subaddress) require_subaddress(wallet, account_idx, subaddress_idx); else require_account(wallet, account_idx);
    return decimal(has_subaddress ? wallet->get_unlocked_balance(asset_type, account_idx, subaddress_idx) : wallet->get_unlocked_balance(asset_type, account_idx));
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// ------------------------- DAEMON STATE ----------------------------

// whether the connected daemon reports itself synchronized with the network: the core's answer
// (daemon height at least its peers' highest height and above 1), "true" or "false"
void zephyr_wasm_bridge::is_daemon_synced(int handle, emscripten::val callback) {
  string result;
  try {
    route_of(handle);
    ZEPHYR_TS_TEST_THROW("error.daemon", "daemon synced");
    monero_wallet* wallet = (monero_wallet*) handle;
    result = wallet->is_daemon_synced() ? "true" : "false";
  } catch (...) {
    result = bridge_error(daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_DAEMON)));
  }
  callback(result);
}

// --------------------- ACCOUNTS AND SUBADDRESSES --------------------------

// Accounts and subaddresses of full wallets, with the core's balance maps by asset. Every index is
// checked against the wallet's own accounts and subaddresses before the core is asked about it: an
// account or subaddress the wallet does not have rejects with ACCOUNT_NOT_FOUND or
// SUBADDRESS_NOT_FOUND instead of the core's empty answer. Listings are bounded by the limits the SDK
// passes (LISTING_LIMIT); creation is one account or subaddress per call. Results are fixed-format
// JSON (see write_account and write_subaddress); a failure is {"error":"<IDENTIFIER>"}.

// {"accounts":[<account>,...]}: every account, with its subaddresses if requested
string zephyr_wasm_bridge::get_accounts(int handle, bool include_subaddresses, uint32_t max_accounts, uint32_t max_subaddresses) {
  try {
    monero_wallet* wallet = accounts_wallet(handle);
    ZEPHYR_TS_TEST_THROW("error.accounts", "accounts");
    std::vector<monero_account> accounts = wallet->get_accounts(true, "");
    if (accounts.size() > max_accounts) throw bridge_failure("LISTING_LIMIT");
    size_t total = 0;
    for (size_t i = 0; i < accounts.size(); i++) {
      if (!accounts[i].m_index || (size_t) *accounts[i].m_index != i) throw bridge_failure("UNEXPECTED_RESULT");
      total += accounts[i].m_subaddresses.size();
    }
    if (include_subaddresses && total > max_subaddresses) throw bridge_failure("LISTING_LIMIT");
    rapidjson::StringBuffer buffer;
    json_writer w(buffer);
    w.StartObject();
    w.Key("accounts");
    w.StartArray();
    for (const auto& account : accounts) write_account(w, account, account.m_subaddresses, include_subaddresses);
    w.EndArray();
    w.EndObject();
    return string(buffer.GetString(), buffer.GetSize());
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// <account>: one account of the wallet, with its subaddresses if requested
string zephyr_wasm_bridge::get_account(int handle, uint32_t account_idx, bool include_subaddresses, uint32_t max_subaddresses) {
  try {
    monero_wallet* wallet = accounts_wallet(handle);
    ZEPHYR_TS_TEST_THROW("error.accounts", "account");
    return account_result(wallet, account_idx, include_subaddresses, max_subaddresses);
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// <account>: a new account with the given label (also the label of its subaddress 0)
string zephyr_wasm_bridge::create_account(int handle, const string& label) {
  try {
    monero_wallet* wallet = accounts_wallet(handle);
    check_label(label);
    ZEPHYR_TS_TEST_THROW("error.accounts", label);
    monero_account created = wallet->create_account(label);
    if (!created.m_index) throw bridge_failure("UNEXPECTED_RESULT");
    return account_result(wallet, *created.m_index, false, 0);
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// {"subaddresses":[<subaddress>,...]}: the account's subaddresses at the given indices, in the given
// order ("i,j,..."), or every subaddress of the account ("")
string zephyr_wasm_bridge::get_subaddresses(int handle, uint32_t account_idx, const string& subaddress_indices, uint32_t max_subaddresses) {
  try {
    monero_wallet* wallet = accounts_wallet(handle);
    ZEPHYR_TS_TEST_THROW("error.accounts", "subaddresses");
    std::vector<uint32_t> indices = parse_indices(subaddress_indices, max_subaddresses);
    std::vector<monero_subaddress> all = subaddresses_of(wallet, account_idx);
    if (indices.empty() && all.size() > max_subaddresses) throw bridge_failure("LISTING_LIMIT");
    for (uint32_t i : indices) if ((size_t) i >= all.size()) throw bridge_failure("SUBADDRESS_NOT_FOUND");
    rapidjson::StringBuffer buffer;
    json_writer w(buffer);
    w.StartObject();
    w.Key("subaddresses");
    w.StartArray();
    if (indices.empty()) { for (const auto& sub : all) write_subaddress(w, sub); }
    else { for (uint32_t i : indices) write_subaddress(w, all[i]); }
    w.EndArray();
    w.EndObject();
    return string(buffer.GetString(), buffer.GetSize());
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// <subaddress>: a new subaddress of an account with the given label
string zephyr_wasm_bridge::create_subaddress(int handle, const uint32_t account_idx, const string& label) {
  try {
    monero_wallet* wallet = accounts_wallet(handle);
    check_label(label);
    ZEPHYR_TS_TEST_THROW("error.accounts", label);
    require_account(wallet, account_idx); // ACCOUNT_NOT_FOUND before the core is asked
    monero_subaddress created = wallet->create_subaddress(account_idx, label);
    if (!created.m_index) throw bridge_failure("UNEXPECTED_RESULT");
    std::vector<monero_subaddress> listed = wallet->get_subaddresses(account_idx, std::vector<uint32_t>{*created.m_index});
    if (listed.size() != 1 || !listed[0].m_index || *listed[0].m_index != *created.m_index) throw bridge_failure("UNEXPECTED_RESULT");
    rapidjson::StringBuffer buffer;
    json_writer w(buffer);
    write_subaddress(w, listed[0]);
    return string(buffer.GetString(), buffer.GetSize());
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// "" after the label of an existing subaddress (subaddress 0: the account's label) was set
string zephyr_wasm_bridge::set_subaddress_label(int handle, const uint32_t account_idx, const uint32_t subaddress_idx, const string& label) {
  try {
    monero_wallet* wallet = accounts_wallet(handle);
    check_label(label);
    ZEPHYR_TS_TEST_THROW("error.accounts", label);
    require_subaddress(wallet, account_idx, subaddress_idx);
    wallet->set_subaddress_label(account_idx, subaddress_idx, label);
    return "";
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_GETTER));
  }
}

// -------------------------------- HISTORY ------------------------------------

// Read-only transactions of full wallets with their transfers, from what the wallet stored at its
// last sync; no request reaches the daemon. The core's get_transfers is asked only for selections
// that stay inside the wallet: confirmed incoming and outgoing transfers (wallet2::get_payments,
// get_payments_out) and failed or pending outgoing transfers (wallet2::get_unconfirmed_payments_out).
// Its incoming pool selection is never requested, because the core first asks the daemon for its pool
// (wallet2::update_pool_state); an incoming transfer still in the pool is therefore not listed until
// it is confirmed. Every transaction is returned with all of its transfers (the selections carry no
// transfer filter), checked against the selection and the core's types before anything is written.
namespace {
  // strict "h1,h2,..." of distinct transaction hashes (64 lowercase hex characters); "" means none
  std::vector<std::string> parse_tx_hashes(const string& text, uint32_t max_count) {
    std::vector<std::string> out;
    if (text.empty()) return out;
    size_t pos = 0;
    while (true) {
      size_t end = text.find(',', pos);
      string item = text.substr(pos, end == string::npos ? string::npos : end - pos);
      if (item.size() != 64) throw bridge_failure("TX_HASH");
      for (char c : item) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw bridge_failure("TX_HASH");
      if (std::find(out.begin(), out.end(), item) != out.end()) throw bridge_failure("TX_HASH");
      out.push_back(item);
      if (out.size() > max_count) throw bridge_failure("LISTING_LIMIT");
      if (end == string::npos) break;
      pos = end + 1;
    }
    return out;
  }

  // "" (none) or strict decimal height text (the SDK sends checked safe integers)
  boost::optional<uint64_t> parse_optional_height(const string& text) {
    if (text.empty()) return boost::none;
    if (text.size() > 20 || (text.size() > 1 && text[0] == '0')) throw bridge_failure("HEIGHT_RANGE");
    for (char c : text) if (c < '0' || c > '9') throw bridge_failure("HEIGHT_RANGE");
    if (text.size() == 20 && text > string("18446744073709551615")) throw bridge_failure("HEIGHT_RANGE");
    return (uint64_t) std::stoull(text);
  }

  bool is_tx_hash(const boost::optional<std::string>& hash) {
    if (!hash || hash->size() != 64) return false;
    for (char c : *hash) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
  }

  // An address as the wallet stored it: written only if it has the form of an address (base58
  // characters, 90 to 140 of them); any other stored text is left out, never copied.
  bool is_address_text(const std::string& text) {
    if (text.size() < 90 || text.size() > 140) return false;
    for (char c : text) {
      bool ok = (c >= '1' && c <= '9') || (c >= 'A' && c <= 'H') || (c >= 'J' && c <= 'N') || (c >= 'P' && c <= 'Z') || (c >= 'a' && c <= 'k') || (c >= 'm' && c <= 'z');
      if (!ok) return false;
    }
    return true;
  }

  // the asset of a transfer or destination: absent when the core reports none, else one of its types
  void write_asset_field(json_writer& w, const std::string& asset) {
    if (asset.empty()) return;
    if (!is_core_asset_type(asset)) throw bridge_failure("UNEXPECTED_ASSET_TYPE");
    w.Key("asset"); write_string(w, asset);
  }

  // {"asset":".."?,"amount":"n","accountIndex":a,"subaddressIndex":s}
  void write_incoming_transfer(json_writer& w, const monero_incoming_transfer& t) {
    if (!t.m_amount || !t.m_account_index || !t.m_subaddress_index) throw bridge_failure("UNEXPECTED_RESULT");
    w.StartObject();
    write_asset_field(w, t.m_asset_type);
    w.Key("amount"); write_string(w, decimal(*t.m_amount));
    w.Key("accountIndex"); w.Uint(*t.m_account_index);
    w.Key("subaddressIndex"); w.Uint(*t.m_subaddress_index);
    w.EndObject();
  }

  // {"asset":".."?,"amount":"n","accountIndex":a,"subaddressIndices":[..],"destinations":[{"address":".."?,"amount":"n","asset":".."?},..]}
  void write_outgoing_transfer(json_writer& w, const monero_outgoing_transfer& t) {
    if (!t.m_amount || !t.m_account_index) throw bridge_failure("UNEXPECTED_RESULT");
    w.StartObject();
    write_asset_field(w, t.m_asset_type);
    w.Key("amount"); write_string(w, decimal(*t.m_amount));
    w.Key("accountIndex"); w.Uint(*t.m_account_index);
    w.Key("subaddressIndices");
    w.StartArray();
    for (uint32_t i : t.m_subaddress_indices) w.Uint(i);
    w.EndArray();
    w.Key("destinations");
    w.StartArray();
    for (const auto& d : t.m_destinations) {
      if (!d || !d->m_amount) throw bridge_failure("UNEXPECTED_RESULT");
      w.StartObject();
      if (d->m_address && is_address_text(*d->m_address)) { w.Key("address"); write_string(w, *d->m_address); }
      w.Key("amount"); write_string(w, decimal(*d->m_amount));
      write_asset_field(w, d->m_asset_type);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }

  // the transaction's place in the selection: confirmed, pending in the pool, or failed
  bool tx_in_selection(const monero_tx_wallet& tx, const string& status, bool height_filter) {
    if (!tx.m_is_confirmed || !tx.m_in_tx_pool || !tx.m_is_failed) throw bridge_failure("UNEXPECTED_RESULT");
    bool confirmed = *tx.m_is_confirmed, pool = *tx.m_in_tx_pool, failed = *tx.m_is_failed;
    if ((int) confirmed + (int) pool + (int) failed != 1) throw bridge_failure("UNEXPECTED_RESULT");
    if (height_filter && !confirmed) return false;
    if (status == "confirmed") return confirmed;
    if (status == "pool") return pool;
    if (status == "failed") return failed;
    return true;
  }

  // {"hash":"..","height":"n"?,"timestamp":"n"?,"confirmations":"n","isConfirmed":b,"inPool":b,"isFailed":b,
  //  "isLocked":b,"isMinerTx":b,"fee":"n"?,"unlockTime":"n","incoming":[..],"outgoing":{..}?}
  void write_tx(json_writer& w, const monero_tx_wallet& tx) {
    if (!is_tx_hash(tx.m_hash) || !tx.m_num_confirmations || !tx.m_is_locked || !tx.m_is_miner_tx || !tx.m_unlock_height) throw bridge_failure("UNEXPECTED_RESULT");
    bool confirmed = *tx.m_is_confirmed;
    if (confirmed != (tx.m_block != boost::none)) throw bridge_failure("UNEXPECTED_RESULT");
    if (confirmed && (!tx.m_block.get() || !tx.m_block.get()->m_height || !tx.m_block.get()->m_timestamp)) throw bridge_failure("UNEXPECTED_RESULT");
    w.StartObject();
    w.Key("hash"); write_string(w, *tx.m_hash);
    if (confirmed) {
      w.Key("height"); write_string(w, decimal(*tx.m_block.get()->m_height));
      w.Key("timestamp"); write_string(w, decimal(*tx.m_block.get()->m_timestamp));
    }
    w.Key("confirmations"); write_string(w, decimal(*tx.m_num_confirmations));
    w.Key("isConfirmed"); w.Bool(confirmed);
    w.Key("inPool"); w.Bool(*tx.m_in_tx_pool);
    w.Key("isFailed"); w.Bool(*tx.m_is_failed);
    w.Key("isLocked"); w.Bool(*tx.m_is_locked);
    w.Key("isMinerTx"); w.Bool(*tx.m_is_miner_tx);
    if (tx.m_fee) { w.Key("fee"); write_string(w, decimal(*tx.m_fee)); }
    w.Key("unlockTime"); write_string(w, decimal(*tx.m_unlock_height));
    w.Key("incoming");
    w.StartArray();
    for (const auto& t : tx.m_incoming_transfers) { if (!t) throw bridge_failure("UNEXPECTED_RESULT"); write_incoming_transfer(w, *t); }
    w.EndArray();
    if (tx.m_outgoing_transfer != boost::none) {
      if (!tx.m_outgoing_transfer.get()) throw bridge_failure("UNEXPECTED_RESULT");
      w.Key("outgoing"); write_outgoing_transfer(w, *tx.m_outgoing_transfer.get());
    }
    w.EndObject();
  }

  // the core's transactions reference their blocks and transfers and back: break those references
  // so that the result is freed (as monero_utils::free does for blocks)
  void release_txs(const std::vector<std::shared_ptr<monero_tx_wallet>>& txs) {
    for (const auto& tx : txs) {
      if (tx->m_block != boost::none && tx->m_block.get()) {
        std::shared_ptr<monero_block> block = tx->m_block.get();
        for (auto& other : block->m_txs) if (other) other->m_block.reset();
        block->m_txs.clear();
      }
      tx->m_block.reset();
      if (tx->m_outgoing_transfer != boost::none && tx->m_outgoing_transfer.get()) tx->m_outgoing_transfer.get()->m_tx.reset();
      for (auto& t : tx->m_incoming_transfers) if (t) t->m_tx.reset();
    }
  }

  // one local selection of the core: transfers of the wallet, collected into their transactions
  void collect_selection(monero_wallet* wallet, bool pool, bool confirmed_only, bool failed_only, const boost::optional<uint64_t>& min_height, const boost::optional<uint64_t>& max_height,
                         const std::vector<std::string>& hashes, std::vector<std::shared_ptr<monero_tx_wallet>>& txs) {
    std::shared_ptr<monero_tx_query> tx_query = std::make_shared<monero_tx_query>();
    std::shared_ptr<monero_transfer_query> transfer_query = std::make_shared<monero_transfer_query>();
    if (pool) {
      // own pending outgoing transfers only: with outgoing transfers selected the core never takes its
      // incoming pool path, which would ask the daemon for the pool
      transfer_query->m_is_incoming = false;
      tx_query->m_in_tx_pool = true;
      tx_query->m_is_failed = false;
    } else {
      tx_query->m_in_tx_pool = false; // confirmed and failed transfers; never the pool
      if (confirmed_only) tx_query->m_is_confirmed = true;
      if (failed_only) tx_query->m_is_failed = true;
      tx_query->m_min_height = min_height;
      tx_query->m_max_height = max_height;
    }
    tx_query->m_hashes = hashes;
    transfer_query->m_tx_query = tx_query;
    tx_query->m_transfer_query = transfer_query;
    std::vector<std::shared_ptr<monero_transfer>> transfers;
    try {
      transfers = wallet->get_transfers(*transfer_query);
    } catch (...) {
      tx_query->m_transfer_query = boost::none;
      transfer_query->m_tx_query = boost::none;
      throw;
    }
    tx_query->m_transfer_query = boost::none; // break the query's own reference cycle
    transfer_query->m_tx_query = boost::none;
    for (const auto& transfer : transfers) {
      std::shared_ptr<monero_tx_wallet> tx = transfer ? std::dynamic_pointer_cast<monero_tx_wallet>(transfer->m_tx) : nullptr;
      if (!tx) { release_txs(txs); throw bridge_failure("UNEXPECTED_RESULT"); }
      if (std::find(txs.begin(), txs.end(), tx) == txs.end()) txs.push_back(tx);
    }
  }

  // confirmed transactions by height then hash, unconfirmed ones after them by hash
  bool tx_before(const std::shared_ptr<monero_tx_wallet>& a, const std::shared_ptr<monero_tx_wallet>& b) {
    bool ca = a->m_block != boost::none && a->m_block.get() && a->m_block.get()->m_height;
    bool cb = b->m_block != boost::none && b->m_block.get() && b->m_block.get()->m_height;
    if (ca != cb) return ca;
    if (ca && *a->m_block.get()->m_height != *b->m_block.get()->m_height) return *a->m_block.get()->m_height < *b->m_block.get()->m_height;
    return a->m_hash.value_or("") < b->m_hash.value_or("");
  }
}

// ------------------------------ POOL REFRESH -------------------------------

// The wallet's incoming transfers that are still in the pool. Listing them is a daemon request: the
// core's incoming pool selection (get_transfers with incoming transfers in the pool) first calls
// wallet2::update_pool_state, which asks the daemon for the hashes in its pool
// (/get_transaction_pool_hashes.bin) and then for the transactions the wallet has not scanned before
// (/gettransactions, pruned, at most 100 hashes per request); a transaction the wallet sent itself
// or already recorded as received is not asked for. No key image and no address is sent. The core
// then processes the new pool transactions (wallet2::process_pool_state, which records the ones that
// pay this wallet) and lists every incoming pool transfer it holds. refresh_pool keeps that listing
// as a per-wallet snapshot of plain records; get_txs adds the snapshot to its selections without any
// request, so history reads stay request-free. The snapshot is replaced by the next refresh_pool and
// released at close; a transaction of the snapshot that the wallet holds as confirmed, failed or own
// pending is listed as that, not from the snapshot.
namespace {
  struct pool_incoming { std::string asset; uint64_t amount; uint32_t account_index; uint32_t subaddress_index; };
  struct pool_record { std::string hash; boost::optional<uint64_t> fee; uint64_t unlock_time; std::vector<pool_incoming> incoming; };
  std::map<int, std::vector<pool_record>> WALLET_POOL;

  bool pool_record_before(const pool_record& a, const pool_record& b) { return a.hash < b.hash; }

  bool pool_incoming_before(const pool_incoming& a, const pool_incoming& b) {
    return a.account_index != b.account_index ? a.account_index < b.account_index : a.subaddress_index < b.subaddress_index;
  }

  // one incoming pool transaction of the core's selection as a plain record, checked like write_tx
  pool_record pool_record_of(const monero_tx_wallet& tx) {
    if (!is_tx_hash(tx.m_hash) || !tx.m_is_confirmed || *tx.m_is_confirmed || !tx.m_in_tx_pool || !*tx.m_in_tx_pool || !tx.m_unlock_height
        || tx.m_outgoing_transfer != boost::none || tx.m_incoming_transfers.empty()) throw bridge_failure("UNEXPECTED_RESULT");
    pool_record r;
    r.hash = *tx.m_hash;
    r.fee = tx.m_fee;
    r.unlock_time = *tx.m_unlock_height;
    for (const auto& t : tx.m_incoming_transfers) {
      if (!t || !t->m_amount || !t->m_account_index || !t->m_subaddress_index) throw bridge_failure("UNEXPECTED_RESULT");
      if (!t->m_asset_type.empty() && !is_core_asset_type(t->m_asset_type)) throw bridge_failure("UNEXPECTED_ASSET_TYPE");
      r.incoming.push_back({t->m_asset_type, *t->m_amount, *t->m_account_index, *t->m_subaddress_index});
    }
    std::sort(r.incoming.begin(), r.incoming.end(), pool_incoming_before);
    return r;
  }

#if defined(ZEPHYR_TS_TEST_INSTRUMENTATION)
  // test-only: synthetic records armed by the test layer, appended after the core's selection
  void test_pool_records(std::vector<pool_record>& records) {
    char* text = zephyr_ts_test_pool_records();
    if (text == nullptr) return;
    rapidjson::Document doc;
    doc.Parse(text);
    free(text);
    if (doc.HasParseError() || !doc.IsObject() || !doc.HasMember("records") || !doc["records"].IsArray()) throw bridge_failure("UNEXPECTED_RESULT");
    for (const auto& v : doc["records"].GetArray()) {
      if (!v.IsObject() || !v.HasMember("hash") || !v["hash"].IsString() || !v.HasMember("amount") || !v["amount"].IsString() || !v.HasMember("accountIndex") || !v["accountIndex"].IsUint()
          || !v.HasMember("subaddressIndex") || !v["subaddressIndex"].IsUint()) throw bridge_failure("UNEXPECTED_RESULT");
      pool_record r;
      r.hash = v["hash"].GetString();
      if (!is_tx_hash(boost::optional<std::string>(r.hash))) throw bridge_failure("UNEXPECTED_RESULT");
      r.unlock_time = 0;
      std::string asset = v.HasMember("asset") && v["asset"].IsString() ? v["asset"].GetString() : "";
      if (!asset.empty() && !is_core_asset_type(asset)) throw bridge_failure("UNEXPECTED_ASSET_TYPE");
      r.incoming.push_back({asset, std::stoull(v["amount"].GetString()), v["accountIndex"].GetUint(), v["subaddressIndex"].GetUint()});
      records.push_back(r);
    }
  }
#else
  inline void test_pool_records(std::vector<pool_record>&) {}
#endif

  // {"hash":"..","confirmations":"0","isConfirmed":false,"inPool":true,"isFailed":false,"isLocked":true,"isMinerTx":false,"fee":"n"?,"unlockTime":"n","incoming":[..]}
  void write_pool_record(json_writer& w, const pool_record& r) {
    w.StartObject();
    w.Key("hash"); write_string(w, r.hash);
    w.Key("confirmations"); write_string(w, "0");
    w.Key("isConfirmed"); w.Bool(false);
    w.Key("inPool"); w.Bool(true);
    w.Key("isFailed"); w.Bool(false);
    w.Key("isLocked"); w.Bool(true);
    w.Key("isMinerTx"); w.Bool(false);
    if (r.fee) { w.Key("fee"); write_string(w, decimal(*r.fee)); }
    w.Key("unlockTime"); write_string(w, decimal(r.unlock_time));
    w.Key("incoming");
    w.StartArray();
    for (const auto& t : r.incoming) {
      w.StartObject();
      write_asset_field(w, t.asset);
      w.Key("amount"); write_string(w, decimal(t.amount));
      w.Key("accountIndex"); w.Uint(t.account_index);
      w.Key("subaddressIndex"); w.Uint(t.subaddress_index);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
}

// {"poolTxs":n}: refresh the wallet's view of its incoming pool transfers (a daemon request, see above)
// and keep it for get_txs. More than max_txs incoming pool transactions reject with LISTING_LIMIT and
// leave no snapshot; any failure leaves no snapshot.
void zephyr_wasm_bridge::refresh_pool(int handle, uint32_t max_txs, emscripten::val callback) {
  string result;
  std::vector<std::shared_ptr<monero_tx_wallet>> txs;
  try {
    route_of(handle);
    WALLET_POOL.erase(handle);
    ZEPHYR_TS_TEST_THROW("error.pool", "pool");
    monero_wallet* wallet = (monero_wallet*) handle;
    boost::optional<monero_rpc_connection> connection = wallet->get_daemon_connection(); // no request
    if (!test_inject("pool.core") && (!connection || !connection->m_uri || connection->m_uri->empty())) throw bridge_failure("DAEMON_NOT_CONNECTED");
    std::shared_ptr<monero_tx_query> tx_query = std::make_shared<monero_tx_query>();
    std::shared_ptr<monero_transfer_query> transfer_query = std::make_shared<monero_transfer_query>();
    transfer_query->m_is_incoming = true;
    tx_query->m_in_tx_pool = true;
    transfer_query->m_tx_query = tx_query;
    tx_query->m_transfer_query = transfer_query;
    std::vector<std::shared_ptr<monero_transfer>> transfers;
    try {
      if (!test_inject("pool.core")) transfers = wallet->get_transfers(*transfer_query); // test module only: skipped while armed (synthetic records)
    } catch (...) {
      tx_query->m_transfer_query = boost::none;
      transfer_query->m_tx_query = boost::none;
      throw;
    }
    tx_query->m_transfer_query = boost::none; // break the query's own reference cycle
    transfer_query->m_tx_query = boost::none;
    for (const auto& transfer : transfers) {
      std::shared_ptr<monero_tx_wallet> tx = transfer ? std::dynamic_pointer_cast<monero_tx_wallet>(transfer->m_tx) : nullptr;
      if (!tx) throw bridge_failure("UNEXPECTED_RESULT");
      if (std::find(txs.begin(), txs.end(), tx) == txs.end()) txs.push_back(tx);
    }
    std::vector<pool_record> records;
    for (const auto& tx : txs) records.push_back(pool_record_of(*tx));
    test_pool_records(records);
    std::sort(records.begin(), records.end(), pool_record_before);
    for (size_t i = 1; i < records.size(); i++) if (records[i].hash == records[i - 1].hash) throw bridge_failure("UNEXPECTED_RESULT");
    if (records.size() > max_txs) throw bridge_failure("LISTING_LIMIT");
    size_t count = records.size();
    WALLET_POOL[handle] = std::move(records);
    release_txs(txs);
    result = string("{\"poolTxs\":") + std::to_string(count) + "}";
  } catch (...) {
    const char* identifier = daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_DAEMON));
    release_txs(txs);
    WALLET_POOL.erase(handle);
    result = bridge_error(identifier);
  }
  callback(result);
}

// {"txs":[<tx>,...]}: the wallet's transactions in the selection. status: "all" (confirmed, pending,
// failed and the incoming pool transactions of the last refresh_pool), "confirmed", "pool" (own pending
// outgoing and the incoming pool transactions of the last refresh_pool) or "failed"; min_height and
// max_height "" or decimal (only confirmed transactions in that range, both inclusive); hashes "" or
// "h1,h2,..." (TX_NOT_FOUND if one of them is not in the selection). At most max_txs transactions with at
// most max_transfers transfers in total, else LISTING_LIMIT, checked before the result is written. No
// request: the pool part is the snapshot of the last refresh_pool.
string zephyr_wasm_bridge::get_txs(int handle, const string& status, const string& min_height, const string& max_height, const string& hashes, uint32_t max_txs, uint32_t max_transfers) {
  std::vector<std::shared_ptr<monero_tx_wallet>> txs;
  std::vector<std::shared_ptr<monero_tx_wallet>> confirmed_pool;
  try {
    if (WALLET_ROUTES.find(handle) == WALLET_ROUTES.end()) throw bridge_failure("KEYS_ONLY_HISTORY");
    monero_wallet* wallet = (monero_wallet*) handle;
    if (status != "all" && status != "confirmed" && status != "pool" && status != "failed") throw bridge_failure("UNEXPECTED_RESULT");
    boost::optional<uint64_t> min_h = parse_optional_height(min_height);
    boost::optional<uint64_t> max_h = parse_optional_height(max_height);
    if (min_h && max_h && *min_h > *max_h) throw bridge_failure("HEIGHT_RANGE");
    std::vector<std::string> requested = parse_tx_hashes(hashes, max_txs);
    bool height_filter = min_h || max_h;
    ZEPHYR_TS_TEST_THROW("error.history", hashes);
    if (status != "pool") collect_selection(wallet, false, status == "confirmed" || height_filter, status == "failed", min_h, max_h, requested, txs);
    if ((status == "all" || status == "pool") && !height_filter) collect_selection(wallet, true, false, false, boost::none, boost::none, requested, txs);
    std::vector<std::shared_ptr<monero_tx_wallet>> selected;
    for (const auto& tx : txs) if (tx_in_selection(*tx, status, height_filter)) selected.push_back(tx);
    std::sort(selected.begin(), selected.end(), tx_before);
    for (size_t i = 1; i < selected.size(); i++) if (selected[i]->m_hash == selected[i - 1]->m_hash) throw bridge_failure("UNEXPECTED_RESULT");
    // incoming pool transactions of the last refresh_pool that the wallet does not hold otherwise
    std::vector<const pool_record*> pool;
    auto snapshot = WALLET_POOL.find(handle);
    if ((status == "all" || status == "pool") && !height_filter && snapshot != WALLET_POOL.end() && !snapshot->second.empty()) {
      std::vector<std::string> candidates;
      for (const auto& r : snapshot->second) if (requested.empty() || std::find(requested.begin(), requested.end(), r.hash) != requested.end()) candidates.push_back(r.hash);
      if (status == "pool" && !candidates.empty()) collect_selection(wallet, false, false, false, boost::none, boost::none, candidates, confirmed_pool); // confirmed or failed meanwhile
      for (const auto& r : snapshot->second) {
        if (std::find(candidates.begin(), candidates.end(), r.hash) == candidates.end()) continue;
        bool held = false;
        for (const auto& tx : txs) if (tx->m_hash && *tx->m_hash == r.hash) { held = true; break; }
        for (const auto& tx : confirmed_pool) if (tx->m_hash && *tx->m_hash == r.hash) { held = true; break; }
        if (!held) pool.push_back(&r);
      }
    }
    for (const auto& h : requested) {
      bool found = false;
      for (const auto& tx : selected) if (tx->m_hash && *tx->m_hash == h) { found = true; break; }
      for (const auto* r : pool) if (r->hash == h) { found = true; break; }
      if (!found) throw bridge_failure("TX_NOT_FOUND");
    }
    if (selected.size() + pool.size() > max_txs) throw bridge_failure("LISTING_LIMIT");
    size_t transfers = 0;
    for (const auto& tx : selected) transfers += tx->m_incoming_transfers.size() + (tx->m_outgoing_transfer != boost::none ? 1 : 0);
    for (const auto* r : pool) transfers += r->incoming.size();
    if (transfers > max_transfers) throw bridge_failure("LISTING_LIMIT");
    rapidjson::StringBuffer buffer;
    json_writer w(buffer);
    w.StartObject();
    w.Key("txs");
    w.StartArray();
    // confirmed by height then hash, then every unconfirmed one (own pending, failed, incoming pool) by hash
    size_t p = 0;
    for (const auto& tx : selected) {
      bool confirmed = tx->m_block != boost::none && tx->m_block.get() && tx->m_block.get()->m_height;
      while (!confirmed && p < pool.size() && pool[p]->hash < tx->m_hash.value_or("")) write_pool_record(w, *pool[p++]);
      write_tx(w, *tx);
    }
    while (p < pool.size()) write_pool_record(w, *pool[p++]);
    w.EndArray();
    w.EndObject();
    release_txs(txs);
    release_txs(confirmed_pool);
    return string(buffer.GetString(), buffer.GetSize());
  } catch (...) {
    const char* identifier = classify_current_exception(ERROR_CONTEXT_GETTER);
    release_txs(txs);
    release_txs(confirmed_pool);
    return bridge_error(identifier);
  }
}

// ------------------------- TRANSACTION BUILD (NO RELAY) ----------------------------

// Builds the transactions of a same-asset transfer of a full wallet, describes them and discards them.
// The core builds and signs them inside the module (monero_wallet_full::create_txs with m_relay fixed to
// false: wallet2::commit_tx is never reached, nothing is relayed or stored); this binding reads each built
// transaction's own bytes inside the module (asset types, ring size, inputs, outputs, unlock time), writes
// a description without any of those bytes, wipes every secret-bearing string of the result (transaction
// bytes, metadata, transaction keys, key images) and breaks the result's reference cycles so that it is
// freed before the binding returns. No byte of a built transaction crosses into JavaScript.
//
// Requests: the core asks the daemon for what it needs to build (heights and fork rules, the fee
// estimate, the priority's backlog estimate, output distributions and ring members); it sends no key
// image. Every value is checked before the core's transaction code runs: the asset (a V2 asset), the
// destinations (addresses with the core's own parser for the wallet's network, amounts above zero and
// their sum within uint64), the account and subaddresses (the wallet's own), the priority; then the
// wallet's unlocked balance of that asset in the selected account or subaddresses must cover the amounts
// (a necessary condition read from the core's own balance; the core's check with the fee stays
// authoritative), so an obviously short build sends no request.
namespace {
  // the outputs a transaction can carry today (V2 assets only: since hard fork 11 the chain rejects V1 outputs)
  bool is_v2_asset(const string& asset) {
    for (const auto& a : oracle::ASSET_TYPES_V2) if (a == asset) return true;
    return false;
  }

  // strict "a1,a2,..." of addresses (base58 characters, 90 to 140 of them), 1..max_count entries
  std::vector<std::string> parse_destination_addresses(const string& text, uint32_t max_count) {
    std::vector<std::string> out;
    size_t pos = 0;
    while (true) {
      size_t end = text.find(',', pos);
      string item = text.substr(pos, end == string::npos ? string::npos : end - pos);
      if (!is_address_text(item)) throw bridge_failure("CORE_INVALID_ADDRESS");
      out.push_back(item);
      if (out.size() > max_count) throw bridge_failure("TOO_MANY_DESTINATIONS");
      if (end == string::npos) break;
      pos = end + 1;
    }
    return out;
  }

  // strict "n1,n2,..." of decimal uint64 amounts above zero whose sum fits uint64
  std::vector<uint64_t> parse_destination_amounts(const string& text, size_t count) {
    std::vector<uint64_t> out;
    uint64_t sum = 0;
    size_t pos = 0;
    while (true) {
      size_t end = text.find(',', pos);
      string item = text.substr(pos, end == string::npos ? string::npos : end - pos);
      if (item.empty() || item.size() > 20 || (item.size() > 1 && item[0] == '0')) throw bridge_failure("AMOUNT_RANGE");
      for (char c : item) if (c < '0' || c > '9') throw bridge_failure("AMOUNT_RANGE");
      if (item.size() == 20 && item > string("18446744073709551615")) throw bridge_failure("AMOUNT_RANGE");
      uint64_t v = std::stoull(item);
      if (v == 0) throw bridge_failure("AMOUNT_ZERO");
      if (sum + v < sum) throw bridge_failure("AMOUNT_RANGE");
      sum += v;
      out.push_back(v);
      if (end == string::npos) break;
      pos = end + 1;
    }
    if (out.size() != count) throw bridge_failure("UNEXPECTED_RESULT");
    return out;
  }

  // the core's own address parser for the wallet's network; a valid address of another network and an
  // integrated address have their own identifiers. The address text never leaves this function.
  void check_destination_address(const std::string& address, monero_network_type network) {
    cryptonote::network_type nettype = network == monero_network_type::MAINNET ? cryptonote::MAINNET : network == monero_network_type::TESTNET ? cryptonote::TESTNET : cryptonote::STAGENET;
    cryptonote::address_parse_info info;
    if (!cryptonote::get_account_address_from_str(info, nettype, address)) {
      for (cryptonote::network_type other : {cryptonote::MAINNET, cryptonote::TESTNET, cryptonote::STAGENET}) {
        cryptonote::address_parse_info ignored;
        if (other != nettype && cryptonote::get_account_address_from_str(ignored, other, address)) throw bridge_failure("ADDRESS_NETWORK");
      }
      throw bridge_failure("CORE_INVALID_ADDRESS");
    }
    if (info.has_payment_id) throw bridge_failure("INTEGRATED_ADDRESS");
  }

  void wipe(boost::optional<std::string>& text) {
    if (text) { std::fill(text->begin(), text->end(), '\0'); text->clear(); text = boost::none; }
  }

  // wipe the secret-bearing strings of built transactions and break their reference cycles (transaction ->
  // input -> transaction, transaction <-> transaction set, transaction <-> transfers)
  void release_built(std::vector<std::shared_ptr<monero_tx_wallet>>& txs) {
    for (auto& tx : txs) {
      if (!tx) continue;
      wipe(tx->m_full_hex);
      wipe(tx->m_metadata);
      wipe(tx->m_key);
      for (auto& input : tx->m_inputs) {
        if (!input) continue;
        if (input->m_key_image != boost::none && input->m_key_image.get()) wipe(input->m_key_image.get()->m_hex);
        input->m_tx.reset();
      }
      tx->m_inputs.clear();
      for (auto& t : tx->m_incoming_transfers) if (t) t->m_tx.reset();
      if (tx->m_outgoing_transfer != boost::none && tx->m_outgoing_transfer.get()) tx->m_outgoing_transfer.get()->m_tx.reset();
      if (tx->m_tx_set != boost::none && tx->m_tx_set.get()) {
        std::shared_ptr<monero_tx_set> set = tx->m_tx_set.get();
        wipe(set->m_signed_tx_hex);
        wipe(set->m_unsigned_tx_hex);
        wipe(set->m_multisig_tx_hex);
        set->m_txs.clear();
      }
      tx->m_tx_set = boost::none;
    }
    txs.clear();
  }

  struct built_description {
    std::string hash, source_asset, destination_asset;
    uint64_t amount, fee, change, weight, unlock_time;
    size_t inputs, outputs, ring_size;
  };

  // one built transaction, described from the core's values and from its own bytes, parsed in place
  built_description describe_built_tx(const monero_tx_wallet& tx, const string& asset) {
    if (!is_tx_hash(tx.m_hash) || !tx.m_full_hex || !tx.m_fee || !tx.m_change_amount || !tx.m_weight || tx.m_outgoing_transfer == boost::none || !tx.m_outgoing_transfer.get()
        || !tx.m_outgoing_transfer.get()->m_amount || tx.m_outgoing_transfer.get()->m_asset_type != asset || !tx.m_is_relayed || *tx.m_is_relayed || !tx.m_in_tx_pool || *tx.m_in_tx_pool) throw bridge_failure("UNEXPECTED_RESULT");
    built_description d;
    cryptonote::blobdata blob;
    if (!epee::string_tools::parse_hexstr_to_binbuff(*tx.m_full_hex, blob)) throw bridge_failure("UNEXPECTED_RESULT");
    cryptonote::transaction parsed;
    crypto::hash hash;
    bool ok = cryptonote::parse_and_validate_tx_from_blob(blob, parsed, hash);
    std::fill(blob.begin(), blob.end(), '\0');
    if (!ok || epee::string_tools::pod_to_hex(hash) != *tx.m_hash) throw bridge_failure("UNEXPECTED_RESULT");
    if (!cryptonote::get_tx_asset_types(parsed, hash, d.source_asset, d.destination_asset, false)) throw bridge_failure("UNEXPECTED_RESULT");
    if (!is_core_asset_type(d.source_asset) || !is_core_asset_type(d.destination_asset)) throw bridge_failure("UNEXPECTED_ASSET_TYPE");
    if (parsed.vin.empty() || parsed.vout.empty() || parsed.rct_signatures.txnFee != *tx.m_fee) throw bridge_failure("UNEXPECTED_RESULT");
    d.ring_size = 0;
    for (const auto& in : parsed.vin) {
      if (in.type() != typeid(cryptonote::txin_zephyr_key)) throw bridge_failure("UNEXPECTED_RESULT");
      size_t ring = boost::get<cryptonote::txin_zephyr_key>(in).key_offsets.size();
      if (ring == 0 || (d.ring_size != 0 && ring != d.ring_size)) throw bridge_failure("UNEXPECTED_RESULT");
      d.ring_size = ring;
    }
    d.hash = *tx.m_hash;
    d.inputs = parsed.vin.size();
    d.outputs = parsed.vout.size();
    d.unlock_time = parsed.unlock_time;
    d.amount = *tx.m_outgoing_transfer.get()->m_amount;
    d.fee = *tx.m_fee;
    d.change = *tx.m_change_amount;
    d.weight = *tx.m_weight;
    if (d.amount + d.fee < d.amount) throw bridge_failure("UNEXPECTED_RESULT");
    return d;
  }


#if defined(ZEPHYR_TS_TEST_INSTRUMENTATION)
  // test-only: a typed failure of the core's build path at the armed point (h.kind[name]): 11 not enough
  // unlocked money, 12 not enough money, 13 not enough for the fee, 14 not enough outputs to mix, 15 too
  // large, 16 no connection to the daemon, 17 a busy daemon, 18 a failed ring member request carrying a
  // node status with the destinations; any other kind an untyped failure whose text carries the destinations
  void test_throw_build(const char* point, const std::string& inputs) {
    int kind = zephyr_ts_test_inject(point);
    switch (kind) {
      case 0: return;
      case 11: THROW_WALLET_EXCEPTION(tools::error::not_enough_unlocked_money, 1, 2, 3);
      case 12: THROW_WALLET_EXCEPTION(tools::error::not_enough_money, 1, 2, 3);
      case 13: THROW_WALLET_EXCEPTION(tools::error::tx_not_possible, 1, 2, 3);
      case 14: THROW_WALLET_EXCEPTION(tools::error::not_enough_outs_to_mix, tools::error::not_enough_outs_to_mix::scanty_outs_t(), 15);
      case 15: THROW_WALLET_EXCEPTION(tools::error::tx_too_big, 200000, 100000);
      case 16: THROW_WALLET_EXCEPTION(tools::error::no_connection_to_daemon, "get_outs.bin");
      case 17: THROW_WALLET_EXCEPTION(tools::error::daemon_busy, "get_outs.bin");
      case 18: THROW_WALLET_EXCEPTION(tools::error::get_outs_error, std::string("injected node status ") + inputs);
      default: throw std::runtime_error(std::string("injected build failure: ") + inputs);
    }
  }
#else
  inline void test_throw_build(const char*, const std::string&) {}
#endif
}

// {"txs":[{"hash","sourceAsset","destinationAsset","amount","fee","feeAsset","totalDebited","change","ringSize",
// "inputs","outputs","weight","unlockTime"[,"destinations":[{"address","amount"},..]]},..]}: the transactions the
// core built for a same-asset transfer of asset from account_idx (and subaddress_indices "" or "i,j,..."), with
// priority 0..3, discarded inside the module. addresses "a1,a2,..." and amounts "n1,n2,..." name the
// destinations (at most max_destinations). Nothing is relayed: m_relay is the constant false below.
void zephyr_wasm_bridge::build_txs(int handle, const string& asset, const string& addresses, const string& amounts, uint32_t account_idx, const string& subaddress_indices,
                                   uint32_t priority, uint32_t max_destinations, emscripten::val callback) {
  string result;
  std::vector<std::shared_ptr<monero_tx_wallet>> txs;
  monero_tx_config config;
  try {
    if (WALLET_ROUTES.find(handle) == WALLET_ROUTES.end()) throw bridge_failure("KEYS_ONLY_TX");
    monero_wallet* wallet = (monero_wallet*) handle;
    if (wallet->is_view_only()) throw bridge_failure("VIEW_ONLY_TX");
    if (wallet->is_multisig()) throw bridge_failure("MULTISIG");
    if (!is_core_asset_type(asset)) throw bridge_failure("ASSET_TYPE");
    if (!is_v2_asset(asset)) throw bridge_failure("TX_ASSET");
    if (priority > 3) throw bridge_failure("TX_PRIORITY");
    std::vector<std::string> destination_addresses = parse_destination_addresses(addresses, max_destinations);
    std::vector<uint64_t> destination_amounts = parse_destination_amounts(amounts, destination_addresses.size());
    std::vector<uint32_t> indices = parse_indices(subaddress_indices, 1000);
    require_account(wallet, account_idx);
    if (!indices.empty()) {
      size_t count = subaddresses_of(wallet, account_idx).size();
      for (uint32_t i : indices) if ((size_t) i >= count) throw bridge_failure("SUBADDRESS_NOT_FOUND");
    }
    monero_network_type network = wallet->get_network_type();
    for (const auto& a : destination_addresses) check_destination_address(a, network);
    ZEPHYR_TS_TEST_THROW("error.build", addresses + " " + amounts);
    test_throw_build("build.core", addresses + " " + amounts); // test module only: the core's typed build failures
    // a necessary condition from the core's own balance of this asset in the selected outputs (no request)
    uint64_t needed = 0, unlocked = 0, balance = 0;
    for (uint64_t v : destination_amounts) needed += v;
    if (indices.empty()) {
      unlocked = wallet->get_unlocked_balance(asset, account_idx);
      balance = wallet->get_balance(asset, account_idx);
    } else {
      for (uint32_t i : indices) { unlocked += wallet->get_unlocked_balance(asset, account_idx, i); balance += wallet->get_balance(asset, account_idx, i); }
    }
    if (needed > balance) throw bridge_failure("NOT_ENOUGH_MONEY");
    if (needed > unlocked) throw bridge_failure("NOT_ENOUGH_UNLOCKED");
    config.m_account_index = account_idx;
    config.m_subaddress_indices = indices;
    config.source_currency = asset;
    config.destination_currency = asset;
    config.m_priority = (monero_tx_priority) priority;
    config.m_can_split = true;
    config.m_relay = false; // the only value this binding ever passes: the core does not commit or relay
    for (size_t i = 0; i < destination_addresses.size(); i++) {
      std::shared_ptr<monero_destination> d = std::make_shared<monero_destination>();
      d->m_address = destination_addresses[i];
      d->m_amount = destination_amounts[i];
      d->m_asset_type = asset;
      config.m_destinations.push_back(d);
    }
    txs = wallet->create_txs(config);
    test_barrier("build.after");
    if (txs.empty() || txs.size() > 64) throw bridge_failure("UNEXPECTED_RESULT");
    std::vector<built_description> described;
    for (const auto& tx : txs) {
      if (!tx) throw bridge_failure("UNEXPECTED_RESULT");
      built_description d = describe_built_tx(*tx, asset);
      if (d.source_asset != asset || d.destination_asset != asset) throw bridge_failure("UNEXPECTED_RESULT");
      described.push_back(d);
    }
    rapidjson::StringBuffer buffer;
    json_writer w(buffer);
    w.StartObject();
    w.Key("txs");
    w.StartArray();
    for (const auto& d : described) {
      w.StartObject();
      w.Key("hash"); write_string(w, d.hash);
      w.Key("sourceAsset"); write_string(w, d.source_asset);
      w.Key("destinationAsset"); write_string(w, d.destination_asset);
      w.Key("amount"); write_string(w, decimal(d.amount));
      w.Key("fee"); write_string(w, decimal(d.fee));
      w.Key("feeAsset"); write_string(w, d.source_asset); // the chain books the fee in the source asset (tx_memory_pool: fee_asset_type)
      w.Key("totalDebited"); write_string(w, decimal(d.amount + d.fee));
      w.Key("change"); write_string(w, decimal(d.change));
      w.Key("ringSize"); w.Uint((unsigned) d.ring_size);
      w.Key("inputs"); w.Uint((unsigned) d.inputs);
      w.Key("outputs"); w.Uint((unsigned) d.outputs);
      w.Key("weight"); write_string(w, decimal(d.weight));
      w.Key("unlockTime"); write_string(w, decimal(d.unlock_time));
      if (described.size() == 1) { // the core attributes destinations only when it built one transaction
        w.Key("destinations");
        w.StartArray();
        for (size_t i = 0; i < destination_addresses.size(); i++) {
          w.StartObject();
          w.Key("address"); write_string(w, destination_addresses[i]);
          w.Key("amount"); write_string(w, decimal(destination_amounts[i]));
          w.EndObject();
        }
        w.EndArray();
      }
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    release_built(txs);
    config.m_destinations.clear();
    result = string(buffer.GetString(), buffer.GetSize());
  } catch (...) {
    const char* identifier = daemon_failure(handle, classify_current_exception(ERROR_CONTEXT_BUILD));
    release_built(txs);
    config.m_destinations.clear();
    result = bridge_error(identifier);
  }
  callback(result);
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

// {"accountIndex":a,"index":i}: the account and subaddress of an address of this full wallet. A
// malformed address or one of another network: CORE_INVALID_ADDRESS; a well-formed address none of
// the wallet's subaddresses has: ADDRESS_NOT_IN_WALLET.
string zephyr_wasm_bridge::get_address_index(int handle, const string& address) {
  try {
    monero_wallet* wallet = accounts_wallet(handle);
    ZEPHYR_TS_TEST_THROW("error.address", address);
    monero_subaddress subaddress = wallet->get_address_index(address);
    if (!subaddress.m_account_index || !subaddress.m_index) throw bridge_failure("UNEXPECTED_RESULT");
    return string("{\"accountIndex\":") + std::to_string(*subaddress.m_account_index) + ",\"index\":" + std::to_string(*subaddress.m_index) + "}";
  } catch (...) {
    return bridge_error(classify_current_exception(ERROR_CONTEXT_ADDRESS_INDEX));
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
    WALLET_POOL.erase(handle);
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

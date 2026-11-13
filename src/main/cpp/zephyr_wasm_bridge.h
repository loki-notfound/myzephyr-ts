/**
 * Provides a bridge from WebAssembly to the Zephyr wallet.
 */
#ifndef zephyr_wasm_bridge_h
#define zephyr_wasm_bridge_h

#include <emscripten/bind.h>
#include <string>

using namespace std;
using namespace emscripten;

// override tools::dns_utils::get_account_address_as_str_from_url() so error caught when sending to invalid address
namespace tools {
  namespace dns_utils {
    std::string get_account_address_as_str_from_url(const std::string& url, bool& dnssec_valid, std::function<std::string(const std::string&, const std::vector<std::string>&, bool)> dns_confirm);
  }
}

namespace zephyr_wasm_bridge
{

  // ------------------------------ UTILITIES ---------------------------------

  // Retained bindings report failures with the fixed error protocol of zephyr_wasm_bridge.cpp
  // ({"error":"<IDENTIFIER>"} or -1); no native exception text reaches JavaScript.
  enum error_context { ERROR_CONTEXT_CREATE = 1, ERROR_CONTEXT_OPEN, ERROR_CONTEXT_CHANGE_PASSWORD, ERROR_CONTEXT_CLOSE, ERROR_CONTEXT_ADDRESS, ERROR_CONTEXT_GETTER, ERROR_CONTEXT_BUFFER, ERROR_CONTEXT_UTILITY, ERROR_CONTEXT_DAEMON, ERROR_CONTEXT_SYNC, ERROR_CONTEXT_ADDRESS_INDEX };
  const char* classify_current_exception(int context); // only inside a catch handler
  const char* probe_password_state(int handle, const string& old_password, const string& new_password);
  const char* classify_build_exception(int handle); // only inside a catch handler of build_txs

  string set_log_level(int level);
  string get_integrated_address_util(int network_type, const string& standard_address, const string& payment_id);
  string validate_address(const string& address, int network_type);
#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
  string get_exception_message(int exception_ptr); // not bound: native exception text must not reach JavaScript
  string malloc_binary_from_json(const string& args_string);
  string binary_to_json(const string& args_string);
  string binary_blocks_to_json(const string& args_string);

  // ------------------------- STATIC WALLET UTILS ----------------------------

#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
  void open_wallet_full(const string& password, int network_type, const string& keys_data, const string& cache_data, const string& daemon_uri, const string& daemon_username, const string& daemon_password, const string& reject_unauthorized_fn_id, bool regtest, emscripten::val callback);
  void create_full_wallet(const string& config_json, const string& reject_unauthorized_fn_id, emscripten::val callback);
  string get_full_wallet_seed_languages();

  void create_keys_wallet_random(const string& config_json, emscripten::val callback);
  void create_keys_wallet_from_seed(const string& config_json, emscripten::val callback);
  void create_keys_wallet_from_keys(const string& config_json, emscripten::val callback);
  string get_keys_wallet_seed_languages();

  // ----------------------- WALLET INSTANCE METHODS --------------------------

  int is_view_only(int handle); // 1, 0, or -1 on failure
#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
  string get_daemon_connection(int handle);
  bool is_daemon_trusted(int handle);
  void get_daemon_max_peer_height(int handle, emscripten::val callback);
#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
  // read-only daemon access: daemon connection with an optional base path, heights, one
  // blocking sync, the asset balance maps (decimal strings) and the daemon's sync state; full wallets only
  void set_daemon_connection(int handle, const string& uri, const string& base_path, emscripten::val callback);
  void is_connected_to_daemon(int handle, emscripten::val callback);
  void get_daemon_height(int handle, emscripten::val callback);
  void set_restore_height_from_daemon(int handle, emscripten::val callback);
  string get_height(int handle);
  void sync(int handle, const string& start_height, emscripten::val callback);
  string get_balance_wallet(int handle);
  string get_unlocked_balance_wallet(int handle);
  string get_balance_account(int handle, const uint32_t account_idx);
  string get_unlocked_balance_account(int handle, const uint32_t account_idx);
  string get_balance_asset(int handle, const string& asset_type, const uint32_t account_idx, bool has_subaddress, const uint32_t subaddress_idx);
  string get_unlocked_balance_asset(int handle, const string& asset_type, const uint32_t account_idx, bool has_subaddress, const uint32_t subaddress_idx);
  void is_daemon_synced(int handle, emscripten::val callback);
  // accounts and subaddresses of full wallets: fixed-format JSON results, indices checked against the
  // wallet's own accounts and subaddresses, listings bounded by the given limits
  string get_accounts(int handle, bool include_subaddresses, uint32_t max_accounts, uint32_t max_subaddresses);
  string get_account(int handle, uint32_t account_idx, bool include_subaddresses, uint32_t max_subaddresses);
  string create_account(int handle, const string& label);
  string get_subaddresses(int handle, uint32_t account_idx, const string& subaddress_indices, uint32_t max_subaddresses);
  string create_subaddress(int handle, const uint32_t account_idx, const string& label);
  string set_subaddress_label(int handle, const uint32_t account_idx, const uint32_t subaddress_idx, const string& label);
  // read-only history of full wallets: transactions with their transfers from what the last sync
  // stored and the last pool refresh kept (no daemon request), fixed-format JSON, bounded by the given limits
  string get_txs(int handle, const string& status, const string& min_height, const string& max_height, const string& hashes, uint32_t max_txs, uint32_t max_transfers);
  // explicit pool refresh of full wallets: one daemon request set (pool hashes, then the pool transactions not
  // scanned before), keeps the wallet's incoming pool transfers for get_txs; at most max_txs of them
  void refresh_pool(int handle, uint32_t max_txs, emscripten::val callback);
  // build, describe and discard the transactions of a same-asset transfer of a full wallet; never relays
  // (m_relay is fixed to false) and returns no byte of a built transaction
  void build_txs(int handle, const string& asset, const string& addresses, const string& amounts, uint32_t account_idx, const string& subaddress_indices, uint32_t priority, uint32_t max_destinations, emscripten::val callback);
  string get_version(int handle);
  string get_seed(int handle);
  string get_seed_language(int handle);
  string get_public_view_key(int handle);
  string get_private_view_key(int handle);
  string get_public_spend_key(int handle);
  string get_private_spend_key(int handle);
  string get_address(int handle, const uint32_t account_idx, const uint32_t subaddress_idx); // indices are validated as uint32 before dispatch
  string get_address_index(int handle, const string& address);
  string get_integrated_address(int handle, const string& standard_address = "", const string& payment_id = "");
  string decode_integrated_address(int handle, const string& integrated_address);
#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
  void get_height_by_date(int handle, uint16_t year, uint8_t month, uint8_t day, emscripten::val callback);
  void is_synced(int handle, emscripten::val callback);
#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
  int get_network_type(int handle); // 0, 1, 2, or -1 on failure
  string get_restore_height(int handle); // exact decimal text of the core uint64_t height
#if defined(ZEPHYR_WASM_BRIDGE_UNPORTED) // not part of the supported surface; targets monero-cpp APIs the fixed core lacks or is not yet adapted
  void set_restore_height(int handle, long restore_height);
//  long get_daemon_height(int handle);
//  long get_daemon_max_peer_height(int handle);
  //void add_listener(int handle, monero_wallet_listener& listener);
  //void remove_listener(int handle, monero_wallet_listener& listener);
  //set<monero_wallet_listener*> get_listeners(int handle);
  void set_listener(int wallet_handle, int old_listener_handle, emscripten::val callback, emscripten::val on_sync_progress = emscripten::val::undefined(), emscripten::val on_new_block = emscripten::val::undefined(), emscripten::val on_balances_changed = emscripten::val::undefined(), emscripten::val on_output_received = emscripten::val::undefined(), emscripten::val on_output_spent = emscripten::val::undefined());
  void stop_syncing(int handle);
  void scan_txs(int handle, const string& args, emscripten::val callback);
  void rescan_spent(int handle, emscripten::val callback);
  void rescan_blockchain(int handle, emscripten::val callback);
  string get_balance_subaddress(int handle, const uint32_t account_idx, const uint32_t subaddress_idx);
  string get_unlocked_balance_subaddress(int handle, const uint32_t account_idx, const uint32_t subaddress_idx);
  void get_transfers(int handle, const string& transfer_query_json, emscripten::val callback);
  void get_outputs(int handle, const string& output_query_json, emscripten::val callback);
  void export_outputs(int handle, bool all, emscripten::val callback);
  void import_outputs(int handle, const string& outputs_hex, emscripten::val callback);
  void export_key_images(int handle, bool all, emscripten::val callback);
  void import_key_images(int handle, const string& key_images_str, emscripten::val callback);
  //  emscripten::function("get_new_key_images_from_last_import", &zephyr_wasm_bridge::get_new_key_images_from_last_import);
  void freeze_output(int handle, const string& key_image, emscripten::val callback);
  void thaw_output(int handle, const string& key_image, emscripten::val callback);
  void is_output_frozen(int handle, const string& key_image, emscripten::val callback);
  void get_default_fee_priority(int handle, emscripten::val callback);
  void create_txs(int handle, const string& config_json, emscripten::val callback);
  void sweep_output(int handle, const string& config_json, emscripten::val callback);
  void sweep_unlocked(int handle, const string& config_json, emscripten::val callback);
  void sweep_dust(int handle, bool relay, emscripten::val callback);
  void relay_txs(int handle, const string& args, emscripten::val callback);
  string describe_tx_set(int handle, const string& tx_set_str);
  string sign_txs(int handle, const string& unsigned_tx_hex);
  void submit_txs(int handle, const string& signed_tx_hex, emscripten::val callback);
  string sign_message(int handle, const string& msg, uint32_t signature_type_num, uint32_t account_idx, uint32_t subaddress_idx);
  string verify_message(int handle, const string& msg, const string& address, const string& signature);
  string get_tx_key(int handle, const string& tx_hash);
  void check_tx_key(int handle, const string& tx_hash, const string& tx_key, const string& address, emscripten::val callback);
  void get_tx_proof(int handle, const string& tx_hash, const string& address, const string& message, emscripten::val callback);
  void check_tx_proof(int handle, const string& tx_hash, const string& address, const string& message, const string& signature, emscripten::val callback);
  void get_spend_proof(int handle, const string& tx_hash, const string& message, emscripten::val callback);
  void check_spend_proof(int handle, const string& tx_hash, const string& message, const string& signature, emscripten::val callback);
  void get_reserve_proof_wallet(int handle, const string& message, emscripten::val callback);
  void get_reserve_proof_account(int handle, uint32_t account_idx, const string& amount_str, const string& message, emscripten::val callback);
  void check_reserve_proof(int handle, const string& address, const string& message, const string& signature, emscripten::val callback);
  string get_tx_notes(int handle, const string& args);
  void set_tx_notes(int handle, const string& args);
  string get_address_book_entries(int handle, const string& args);
  int add_address_book_entry(int handle, const string& address, const string& description);
  void edit_address_book_entry(int handle, int index, bool setAddress, const string& address, bool setDescription, const string& description);
  void delete_address_book_entry(int handle, int entry_idx);
  void tag_accounts(int handle, const string& args);
  void untag_accounts(int handle, const string& args);
  string get_account_tags(int handle);
  void set_account_tag_label(int handle, const string& tag, const string& label);
  string get_payment_uri(int handle, const string& config_json);
  string parse_payment_uri(int handle, const string& uri);
  string get_attribute(int handle, const string& key);
  void set_attribute(int handle, const string& key, const string& val);
  bool is_multisig_import_needed(int handle);
  string get_multisig_info(int handle);
  string prepare_multisig(int handle);
  void make_multisig(int handle, const string& args, emscripten::val callback);
  void exchange_multisig_keys(int handle, const string& args, emscripten::val callback);
  string export_multisig_hex(int handle);
  void import_multisig_hex(int handle, const string& args, emscripten::val callback);
  void sign_multisig_tx_hex(int handle, const string& multisig_tx_hex, emscripten::val callback);
  void submit_multisig_tx_hex(int handle, const string& signed_multisig_tx_hex, emscripten::val callback);
#endif // ZEPHYR_WASM_BRIDGE_UNPORTED
  void change_wallet_password(int handle, const string& old_password, const string& new_password, emscripten::val callback);
  void close(int handle, bool save, int listener_handle, emscripten::val callback);
  // return {"pointer","length"} of a malloc() block the caller releases once with _free(), or {"error"}
  string get_keys_file_buffer(int handle, string password, bool view_only);
  string get_cache_file_buffer(int handle);

#if defined(ZEPHYR_TS_TEST_INSTRUMENTATION)
  int test_heap_in_use(); // test module only: bytes in use by the C allocator
#endif
}

#endif /* zephyr_wasm_bridge_h */

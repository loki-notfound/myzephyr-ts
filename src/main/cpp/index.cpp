#include <stdio.h>
#include <emscripten/bind.h>
//#include <emscripten.h>

#include "zephyr_wasm_bridge.h"

// register bindings from JS to C++ using emscripten
EMSCRIPTEN_BINDINGS(module)
{
  // Supported wallet lifecycle, read-only daemon access, accounts and subaddresses, read-only
  // history, the explicit pool refresh and building transactions without relay: only the bindings
  // below are exported. Every other inherited monero-ts binding is excluded together with its
  // definition in zephyr_wasm_bridge.cpp (ZEPHYR_WASM_BRIDGE_UNPORTED) until it is adapted to the
  // fixed core.

  // ------------------------------ UTILITIES ---------------------------------

  emscripten::function("set_log_level", &zephyr_wasm_bridge::set_log_level);
  emscripten::function("get_integrated_address_util", &zephyr_wasm_bridge::get_integrated_address_util);
  emscripten::function("validate_address", &zephyr_wasm_bridge::validate_address);
  // get_exception_message is not bound: native exception text must not reach JavaScript

  // --------------------------- WALLET CREATION ------------------------------

  emscripten::function("open_wallet_full", &zephyr_wasm_bridge::open_wallet_full);
  emscripten::function("create_full_wallet", &zephyr_wasm_bridge::create_full_wallet);
  emscripten::function("get_full_wallet_seed_languages", &zephyr_wasm_bridge::get_full_wallet_seed_languages);

  emscripten::function("create_keys_wallet_random", &zephyr_wasm_bridge::create_keys_wallet_random);
  emscripten::function("create_keys_wallet_from_seed", &zephyr_wasm_bridge::create_keys_wallet_from_seed);
  emscripten::function("create_keys_wallet_from_keys", &zephyr_wasm_bridge::create_keys_wallet_from_keys);
  emscripten::function("get_keys_wallet_seed_languages", &zephyr_wasm_bridge::get_keys_wallet_seed_languages);

  // ----------------------- WALLET INSTANCE METHODS --------------------------

  emscripten::function("is_view_only", &zephyr_wasm_bridge::is_view_only);
  emscripten::function("get_version", &zephyr_wasm_bridge::get_version);
  emscripten::function("get_seed", &zephyr_wasm_bridge::get_seed);
  emscripten::function("get_seed_language", &zephyr_wasm_bridge::get_seed_language);
  emscripten::function("get_private_spend_key", &zephyr_wasm_bridge::get_private_spend_key);
  emscripten::function("get_private_view_key", &zephyr_wasm_bridge::get_private_view_key);
  emscripten::function("get_public_view_key", &zephyr_wasm_bridge::get_public_view_key);
  emscripten::function("get_public_spend_key", &zephyr_wasm_bridge::get_public_spend_key);
  emscripten::function("get_address", &zephyr_wasm_bridge::get_address);
  emscripten::function("get_address_index", &zephyr_wasm_bridge::get_address_index);
  emscripten::function("get_integrated_address", &zephyr_wasm_bridge::get_integrated_address);
  emscripten::function("decode_integrated_address", &zephyr_wasm_bridge::decode_integrated_address);
  emscripten::function("get_network_type", &zephyr_wasm_bridge::get_network_type);
  emscripten::function("get_restore_height", &zephyr_wasm_bridge::get_restore_height);
  emscripten::function("get_keys_file_buffer", &zephyr_wasm_bridge::get_keys_file_buffer);
  emscripten::function("get_cache_file_buffer", &zephyr_wasm_bridge::get_cache_file_buffer);
  emscripten::function("change_wallet_password", &zephyr_wasm_bridge::change_wallet_password);

  // read-only daemon access
  emscripten::function("set_daemon_connection", &zephyr_wasm_bridge::set_daemon_connection);
  emscripten::function("is_connected_to_daemon", &zephyr_wasm_bridge::is_connected_to_daemon);
  emscripten::function("get_daemon_height", &zephyr_wasm_bridge::get_daemon_height);
  emscripten::function("set_restore_height_from_daemon", &zephyr_wasm_bridge::set_restore_height_from_daemon);
  emscripten::function("get_height", &zephyr_wasm_bridge::get_height);
  emscripten::function("sync", &zephyr_wasm_bridge::sync);
  emscripten::function("get_balance_wallet", &zephyr_wasm_bridge::get_balance_wallet);
  emscripten::function("get_unlocked_balance_wallet", &zephyr_wasm_bridge::get_unlocked_balance_wallet);
  emscripten::function("get_balance_account", &zephyr_wasm_bridge::get_balance_account);
  emscripten::function("get_unlocked_balance_account", &zephyr_wasm_bridge::get_unlocked_balance_account);
  emscripten::function("get_balance_asset", &zephyr_wasm_bridge::get_balance_asset);
  emscripten::function("get_unlocked_balance_asset", &zephyr_wasm_bridge::get_unlocked_balance_asset);
  emscripten::function("is_daemon_synced", &zephyr_wasm_bridge::is_daemon_synced);

  // accounts and subaddresses (full wallets)
  emscripten::function("get_accounts", &zephyr_wasm_bridge::get_accounts);
  emscripten::function("get_account", &zephyr_wasm_bridge::get_account);
  emscripten::function("create_account", &zephyr_wasm_bridge::create_account);
  emscripten::function("get_subaddresses", &zephyr_wasm_bridge::get_subaddresses);
  emscripten::function("create_subaddress", &zephyr_wasm_bridge::create_subaddress);
  emscripten::function("set_subaddress_label", &zephyr_wasm_bridge::set_subaddress_label);

  // read-only history (full wallets)
  emscripten::function("get_txs", &zephyr_wasm_bridge::get_txs);

  // explicit pool refresh (full wallets; a daemon request the caller chooses)
  emscripten::function("refresh_pool", &zephyr_wasm_bridge::refresh_pool);

  // build, describe and discard same-asset transactions and conversions (full wallets); there is no relay binding
  emscripten::function("build_txs", &zephyr_wasm_bridge::build_txs);
  emscripten::function("build_conversion", &zephyr_wasm_bridge::build_conversion);
  emscripten::function("close", &zephyr_wasm_bridge::close);

#if defined(ZEPHYR_TS_TEST_INSTRUMENTATION)
  // test module only; never part of the release module's exports
  emscripten::function("test_heap_in_use", &zephyr_wasm_bridge::test_heap_in_use);
#endif
}
extern "C"
{
  // stub so libc's socket-dependent implementation stays out of the link
  unsigned int if_nametoindex(const char*) { return 0; }
}

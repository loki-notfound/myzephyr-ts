cmake_minimum_required(VERSION 3.5)

project(zephyr-ts-wasm)

# build with exception whitelist from file
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS wasm_exception_whitelist.txt) # reconfigure when the whitelist changes so flags are not stale
file(STRINGS wasm_exception_whitelist.txt WASM_EXCEPTION_WHITELIST)
string(REPLACE ";" "," WASM_EXCEPTION_WHITELIST "${WASM_EXCEPTION_WHITELIST}")
SET(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++14 -Oz -s EXCEPTION_CATCHING_ALLOWED='[${WASM_EXCEPTION_WHITELIST}]' -D_REENTRANT")
add_definitions(-DAUTO_INITIALIZE_EASYLOGGINGPP -DNO_AES)
# libsodium comes from zephyr-cpp (verify.c only), so the
# CONFIGURED define for monero-ts's own vendored libsodium sources is not needed.

##############
# C++ bridge
##############

include_directories("src/cpp")

#####################
# zephyr-cpp (signed backports core, fixed pin)
#####################

set(ZEPHYR_CPP "external/zephyr-cpp")
set(ZEPHYR_CPP_SRC "${ZEPHYR_CPP}/src")

# headers
include_directories("${ZEPHYR_CPP_SRC}")
include_directories("${ZEPHYR_CPP}/external/libsodium/include")
include_directories("${ZEPHYR_CPP}/external/libsodium/include/sodium")

##################
# zephyr (core submodule of zephyr-cpp, derived from monero-project)
##################

set(ZEPHYR_PROJECT "${ZEPHYR_CPP}/external/zephyr")
set(ZEPHYR_PROJECT_SRC "${ZEPHYR_PROJECT}/src")

# no generated version.cpp: zephyr-cpp's get_version() does not read MONERO_VERSION*

# headers
include_directories("src/main/cpp")
include_directories("${ZEPHYR_PROJECT_SRC}/")
include_directories("${ZEPHYR_PROJECT_SRC}/checkpoints")
include_directories("${ZEPHYR_PROJECT_SRC}/common")
include_directories("${ZEPHYR_PROJECT_SRC}/oracle")
#include_directories("${ZEPHYR_PROJECT_SRC}/crypto")
#include_directories("${ZEPHYR_PROJECT_SRC}/crypto/crypto_ops_builder/include/")    # DISABLED?
#include_directories("${ZEPHYR_PROJECT_SRC}/crypto/crypto_ops_builder/include/sodium")    # DISABLED?
include_directories("${ZEPHYR_PROJECT_SRC}/cryptonote_basic")
#include_directories("${ZEPHYR_PROJECT_SRC}/multisig")
#include_directories("${ZEPHYR_PROJECT_SRC}/cryptonote_core")
#include_directories("${ZEPHYR_PROJECT_SRC}/cryptonote_protocol")
#include_directories("${ZEPHYR_PROJECT_SRC}/wallet")
#include_directories("${ZEPHYR_PROJECT_SRC}/rpc")
#include_directories("${ZEPHYR_PROJECT_SRC}/mnemonics")
include_directories("${ZEPHYR_PROJECT}/external/")
include_directories("${ZEPHYR_PROJECT}/external/easylogging++")
include_directories("${ZEPHYR_PROJECT}/external/rapidjson/include")
include_directories("${ZEPHYR_PROJECT}/external/unbound/libunbound")
include_directories("${ZEPHYR_PROJECT}/external/db_drivers/liblmdb")
include_directories("${ZEPHYR_PROJECT}/contrib/epee/include")
include_directories("${ZEPHYR_PROJECT}/contrib/epee/include/net")

#include_directories("${CMAKE_CURRENT_BINARY_DIR}")
#include_directories("${ZEPHYR_PROJECT_SRC}/wallet/api")

include_directories("${ZEPHYR_PROJECT}/build/release/translations")

# generate empty crypto/wallet/ops.h to select monero-project's internal wallet crypto (supercop asm is not wasm-compatible)
configure_file("${ZEPHYR_PROJECT_SRC}/crypto/wallet/empty.h.in" "${CMAKE_BINARY_DIR}/generated_include/crypto/wallet/ops.h" COPYONLY)
include_directories("${CMAKE_BINARY_DIR}/generated_include")

#############
# Unbound
#############

# unbound 1.19.1 headers only; the build passes their location through CXXFLAGS (-I),
# because CMake does not expand "~" in include paths.

#############
# OpenSSL
#############

#find_package(OpenSSL REQUIRED)
#message(STATUS "Using OpenSSL include dir at ${OPENSSL}")

set(OPENSSL ${CMAKE_SOURCE_DIR}/build/openssl)
include_directories("${OPENSSL}")
include_directories("${OPENSSL}/include") # must exist already - run bin/build-openssl-emscripten.sh

add_library(openssl_crypto STATIC IMPORTED)
set_target_properties(
    openssl_crypto PROPERTIES IMPORTED_LOCATION
    ${OPENSSL}/lib/libcrypto.a
)

add_library(openssl_ssl STATIC IMPORTED)
set_target_properties(
    openssl_ssl PROPERTIES IMPORTED_LOCATION
    ${OPENSSL}/lib/libssl.a
)

#############
# Boost
#############

set(BOOST ${CMAKE_SOURCE_DIR}/build/boost)
include_directories("${BOOST}")
include_directories("${BOOST}/include") # must exist already - run bin/build_boost_emscripten.sh

add_library(boost_chrono STATIC IMPORTED)
set_target_properties(
    boost_chrono PROPERTIES IMPORTED_LOCATION
    ${BOOST}/lib/libboost_chrono.a
)

add_library(boost_system STATIC IMPORTED)
set_target_properties(
    boost_system PROPERTIES IMPORTED_LOCATION
    ${BOOST}/lib/libboost_system.a
)

add_library(boost_thread STATIC IMPORTED)
set_target_properties(
    boost_thread PROPERTIES IMPORTED_LOCATION
    ${BOOST}/lib/libboost_thread.a
)

add_library(boost_serialization STATIC IMPORTED)
set_target_properties(
    boost_serialization PROPERTIES IMPORTED_LOCATION
    ${BOOST}/lib/libboost_serialization.a
)

add_library(boost_filesystem STATIC IMPORTED)
set_target_properties(
    boost_filesystem PROPERTIES IMPORTED_LOCATION
    ${BOOST}/lib/libboost_filesystem.a
)

add_library(boost_regex STATIC IMPORTED)
set_target_properties(
    boost_regex PROPERTIES IMPORTED_LOCATION
    ${BOOST}/lib/libboost_regex.a
)

#add_library(boost_atomic STATIC IMPORTED)
#set_target_properties(
    #boost_atomic PROPERTIES IMPORTED_LOCATION
    #${BOOST}/lib/libboost_atomic.a
#)

################################
# Keys-only wallet source files
################################

set(
    ZEPHYR_WALLET_KEYS_SRC_FILES
    
    # monero-ts WASM bridge
    src/main/cpp/index.cpp
    src/main/cpp/zephyr_wasm_bridge.cpp
    
    # zephyr-cpp (established Zephyr WASM source list)
    ${ZEPHYR_CPP_SRC}/utils/monero_utils.cpp
    ${ZEPHYR_CPP_SRC}/daemon/monero_daemon_model.cpp
    ${ZEPHYR_CPP_SRC}/wallet/monero_wallet_model.cpp
    ${ZEPHYR_CPP_SRC}/wallet/monero_wallet_keys.cpp
    ${ZEPHYR_CPP}/external/libsodium/src/crypto_verify/verify.c
    
    # zephyr (established Zephyr WASM source list)
    ${ZEPHYR_PROJECT_SRC}/cryptonote_basic/cryptonote_basic_impl.cpp
    ${ZEPHYR_PROJECT_SRC}/cryptonote_basic/account.cpp
    ${ZEPHYR_PROJECT_SRC}/cryptonote_basic/cryptonote_format_utils.cpp
    ${ZEPHYR_PROJECT_SRC}/oracle/pricing_record.cpp
    ${ZEPHYR_PROJECT_SRC}/crypto/crypto.cpp
    ${ZEPHYR_PROJECT_SRC}/crypto/hash.c
    ${ZEPHYR_PROJECT_SRC}/crypto/slow-hash.c
    ${ZEPHYR_PROJECT_SRC}/crypto/oaes_lib.c
    ${ZEPHYR_PROJECT_SRC}/crypto/crypto-ops.c
    ${ZEPHYR_PROJECT_SRC}/crypto/crypto-ops-data.c
    ${ZEPHYR_PROJECT_SRC}/crypto/keccak.c
    ${ZEPHYR_PROJECT_SRC}/crypto/chacha.c
    ${ZEPHYR_PROJECT_SRC}/crypto/random.c
    ${ZEPHYR_PROJECT_SRC}/crypto/aesb.c
    ${ZEPHYR_PROJECT_SRC}/crypto/tree-hash.c
    ${ZEPHYR_PROJECT_SRC}/crypto/hash-extra-blake.c
    ${ZEPHYR_PROJECT_SRC}/crypto/blake256.c
    ${ZEPHYR_PROJECT_SRC}/crypto/hash-extra-groestl.c
    ${ZEPHYR_PROJECT_SRC}/crypto/hash-extra-jh.c
    ${ZEPHYR_PROJECT_SRC}/crypto/hash-extra-skein.c
    ${ZEPHYR_PROJECT_SRC}/crypto/groestl.c
    ${ZEPHYR_PROJECT_SRC}/crypto/jh.c
    ${ZEPHYR_PROJECT_SRC}/crypto/skein.c
    ${ZEPHYR_PROJECT_SRC}/cryptonote_core/cryptonote_tx_utils.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/byte_stream.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/byte_slice.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/hex.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/string_tools.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/memwipe.c
    ${ZEPHYR_PROJECT}/contrib/epee/src/mlocker.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/mlog.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/wipeable_string.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/portable_storage.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/net_parse_helpers.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/parserse_base_utils.cpp
    ${ZEPHYR_PROJECT_SRC}/common/base58.cpp
    ${ZEPHYR_PROJECT_SRC}/device/device.cpp
    ${ZEPHYR_PROJECT_SRC}/device/device_default.cpp
    ${ZEPHYR_PROJECT_SRC}/hardforks/hardforks.cpp
    ${ZEPHYR_PROJECT_SRC}/multisig/multisig.cpp
    ${ZEPHYR_PROJECT_SRC}/multisig/multisig_account.cpp
    ${ZEPHYR_PROJECT_SRC}/multisig/multisig_account_kex_impl.cpp
    ${ZEPHYR_PROJECT_SRC}/multisig/multisig_clsag_context.cpp
    ${ZEPHYR_PROJECT_SRC}/multisig/multisig_kex_msg.cpp
    ${ZEPHYR_PROJECT_SRC}/multisig/multisig_tx_builder_ringct.cpp
    ${ZEPHYR_PROJECT_SRC}/ringct/rctOps.cpp
    ${ZEPHYR_PROJECT_SRC}/ringct/rctTypes.cpp
    ${ZEPHYR_PROJECT_SRC}/ringct/rctCryptoOps.c
    ${ZEPHYR_PROJECT_SRC}/ringct/rctSigs.cpp
    # bulletproofs.cc is not compiled separately: zephyr's rctSigs.cpp #includes it
    ${ZEPHYR_PROJECT_SRC}/ringct/bulletproofs_plus.cc
    ${ZEPHYR_PROJECT_SRC}/ringct/multiexp.cc
    ${ZEPHYR_PROJECT_SRC}/mnemonics/electrum-words.cpp
    ${ZEPHYR_PROJECT}/external/easylogging++/easylogging++.cc
)

################################
# Full wallet source files
################################

set(
    ZEPHYR_WALLET_FULL_SRC_FILES
    
    # monero-ts WASM bridge
    src/main/cpp/http_client_wasm.cpp
    # fail-closed rx_slow_hash stub (re-expressed rx-slow-hash-stub build patch)
    src/main/cpp/zeph_wasm_stubs.c
    
    # zephyr-cpp (established Zephyr WASM source list)
    ${ZEPHYR_CPP_SRC}/wallet/monero_wallet_full.cpp
    
    # zephyr (established Zephyr WASM source list)
    ${ZEPHYR_PROJECT}/external/db_drivers/liblmdb/mdb.c
    ${ZEPHYR_PROJECT}/external/db_drivers/liblmdb/midl.c
    ${ZEPHYR_PROJECT}/external/randomx/src/randomx.cpp
    ${ZEPHYR_PROJECT}/external/randomx/src/randomx.h
    ${ZEPHYR_PROJECT}/contrib/epee/src/abstract_http_client.cpp
    ${ZEPHYR_PROJECT}/contrib/epee/src/file_io_utils.cpp
    #${ZEPHYR_PROJECT}/contrib/epee/src/http_auth.cpp
    ${ZEPHYR_PROJECT_SRC}/wallet/wallet2.cpp
    ${ZEPHYR_PROJECT_SRC}/wallet/message_store.cpp
    ${ZEPHYR_PROJECT_SRC}/wallet/message_transporter.cpp
    ${ZEPHYR_PROJECT_SRC}/wallet/node_rpc_proxy.cpp
    #${ZEPHYR_PROJECT_SRC}/blockchain_db/lmdb/db_lmdb.cpp
    ${ZEPHYR_PROJECT_SRC}/crypto/hash-ops.h
    ${ZEPHYR_PROJECT_SRC}/cryptonote_core/cryptonote_tx_utils.cpp
    ${ZEPHYR_PROJECT_SRC}/checkpoints/checkpoints.cpp
    ${ZEPHYR_PROJECT_SRC}/common/perf_timer.cpp
    ${ZEPHYR_PROJECT_SRC}/common/threadpool.cpp
    ${ZEPHYR_PROJECT_SRC}/common/aligned.c
    ${ZEPHYR_PROJECT_SRC}/common/util.cpp
    ${ZEPHYR_PROJECT_SRC}/common/i18n.cpp
    ${ZEPHYR_PROJECT_SRC}/common/combinator.cpp
    ${ZEPHYR_PROJECT_SRC}/rpc/rpc_payment_signature.cpp
    ${ZEPHYR_PROJECT_SRC}/wallet/ringdb.cpp
    ${ZEPHYR_PROJECT_SRC}/cryptonote_basic/miner.cpp
    ${ZEPHYR_PROJECT_SRC}/cryptonote_basic/difficulty.cpp
    ${ZEPHYR_PROJECT_SRC}/cryptonote_core/tx_sanity_check.cpp
)

####################
# Build parameters
####################

#-s USE_PTHREADS=1 \
#-s PTHREAD_POOL_SIZE=2 \
#-s PROXY_TO_PTHREAD \
#-s DISABLE_EXCEPTION_CATCHING=0 \
#-s ASYNCIFY=1 \
#-s 'ASYNCIFY_IMPORTS=[\"js_send_json_request\",\"js_send_binary_request\",\"emscripten_sleep\"]' \
#-s ALLOW_MEMORY_GROWTH=0 \
#-s INITIAL_MEMORY=1536MB \
#-s MALLOC=emmalloc \
#-s INITIAL_MEMORY=1024MB \
#-s TOTAL_STACK=512MB \

set (
EMCC_LINKER_FLAGS_BASE

# unsure if the -I...boost..include is necessary here due to include above
# TODO? does EXPORT_NAME need to be the same for both targets? (or should it be set per-target with …_WASM, …_ASMJS?)

"-Wall -Werror -Wl,--allow-undefined -std=c++14 -Oz -D_REENTRANT \
--bind \
-s MODULARIZE=1 \
-s 'EXPORT_NAME=\"zephyr_ts\"' \
-s ERROR_ON_UNDEFINED_SYMBOLS=0 \
-s ASSERTIONS=0 \
-s EXIT_RUNTIME=0 \
-s PRECISE_F32=1 \
-s EXCEPTION_DEBUG=0 \
-s NO_DYNAMIC_EXECUTION=1 \
-s NODEJS_CATCH_EXIT=0 \
-s RESERVED_FUNCTION_POINTERS=5 \
-s EXPORTED_RUNTIME_METHODS='[\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\",\"intArrayToString\",\"getTempRet0\",\"addFunction\"]' \
-s SINGLE_FILE=0 \
-s ALLOW_MEMORY_GROWTH=1 \
-s WASM_BIGINT=1 \
-s EXPORTED_FUNCTIONS='[_free, _malloc]' \
-s TOTAL_STACK=5MB \
-s DEFAULT_PTHREAD_STACK_SIZE=2MB \
"
    # • Disabling exception catching does not introduce silent failures 
    # • Probably don't need PRECISE_F32 but wouldn't want to not use it
    #
    #
    # -s SAFE_HEAP=1 \
    # -g \
)

set(
EMCC_LINKER_FLAGS_FULL
"${EMCC_LINKER_FLAGS_BASE} \
-s ASYNCIFY=1 \
-s 'ASYNCIFY_IMPORTS=[\"js_send_json_request\",\"js_send_binary_request\",\"emscripten_sleep\"]' \
"
)

message(STATUS "EMCC_LINKER_FLAGS_FULL ${EMCC_LINKER_FLAGS_FULL}")

####################
# Build targets
####################

add_executable(zephyr ${ZEPHYR_WALLET_FULL_SRC_FILES} ${ZEPHYR_WALLET_KEYS_SRC_FILES})
set_target_properties(zephyr PROPERTIES LINK_FLAGS "${EMCC_LINKER_FLAGS_FULL}")
target_compile_definitions(zephyr PRIVATE BUILD_WALLET_FULL=1)

# Test-only instrumentation (barrier, failure injection, allocator accounting) for the separately
# built and identified test module. The release module is always built with this option OFF.
option(ZEPHYR_TS_TEST_INSTRUMENTATION "Build the test-instrumented lifecycle module" OFF)
if (ZEPHYR_TS_TEST_INSTRUMENTATION)
  target_compile_definitions(zephyr PRIVATE ZEPHYR_TS_TEST_INSTRUMENTATION=1)
endif()
target_link_libraries(
    zephyr
    #
    #openssl_ssl
    #openssl_crypto
    #
    boost_chrono
    boost_system
    boost_thread
    boost_serialization
    boost_filesystem
    boost_regex
    #boost_atomic
    #
    ${log-lib}
)

# build to bitcode instead of wasm
#SET(CMAKE_EXECUTABLE_SUFFIX ".bc")
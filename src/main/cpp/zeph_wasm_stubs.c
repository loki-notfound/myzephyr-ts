/*
 * Stubs for the wallet-only WebAssembly build.
 *
 * rx_slow_hash (RandomX proof-of-work) is referenced by cryptonote::get_block_longhash().
 * In the wallet build the only path to it is:
 *
 *   wallet2::generate_genesis() -> cryptonote::generate_genesis_block()
 *     -> miner::find_nonce_for_given_block(..., difficulty = 1)
 *     -> get_block_longhash(pbc = NULL, ...)            (seed hash zeroed by the caller)
 *     -> rx_slow_hash(seed = 32 zero bytes, ...)
 *
 * The PoW result is only passed to check_hash(h, 1), which returns true for every hash
 * (src/cryptonote_basic/difficulty.cpp, check_hash_64), so the loop stops at the first
 * nonce and the genesis block stays exactly as hard-coded. wallet2 only uses
 * get_block_hash(genesis), which does not depend on the PoW value. A wallet never
 * verifies proof-of-work, so it never needs real RandomX (which would need a 256 MiB
 * cache in the browser).
 *
 * Fail-closed: any call that does not look like this genesis path (non-zero seed hash)
 * aborts instead of returning a fake hash. The build additionally checks the compiled
 * objects so that nothing else references get_block_longhash / rx_slow_hash.
 */
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

void rx_slow_hash(const char *seedhash, const void *data, size_t length, char *result_hash)
{
  static const char zero[32] = {0};
  (void)data;
  (void)length;
  if (seedhash == NULL || memcmp(seedhash, zero, sizeof(zero)) != 0)
    abort(); /* unexpected caller: refuse rather than return a fake PoW hash */
  memset(result_hash, 0, 32);
}

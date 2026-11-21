# 9. Errors

Every failure of the library is a `ZephyrWalletError` with a fixed code and, usually, a fixed
diagnostic. This chapter explains the class, the codes and diagnostics, which of them a wallet must
handle, and why no text from a node or the core reaches an error.

## The error class

```ts
import { ZephyrWalletError } from "@loki-notfound/zephyr-ts";
import type { ZephyrWalletErrorCode, ZephyrWalletErrorDiagnostic } from "@loki-notfound/zephyr-ts";

function describe(err: unknown): string {
  if (!(err instanceof ZephyrWalletError)) return "unexpected error";
  const code: ZephyrWalletErrorCode = err.code;
  const diagnostic: ZephyrWalletErrorDiagnostic | undefined = err.diagnostic;
  return diagnostic === undefined ? code : `${code}/${diagnostic}`;
}
```

A `ZephyrWalletError` extends `Error`. Its `name` is `"ZephyrWalletError"`, its `code` one of thirteen
codes, its `diagnostic` one identifier of a fixed list or `undefined`, and its `message` a fixed text
per code, for example `"Daemon request failed"` for `DAEMON_ERROR`. Promise-returning calls reject with
it; they do not throw synchronously. A wallet error from a worker is rebuilt from its code and
diagnostic only.

## Codes

| Code | Meaning |
|---|---|
| `UNSUPPORTED_CAPABILITY` | the call or option is outside the supported surface, or not available for this kind of wallet |
| `INVALID_CONFIG` | a configuration or argument was rejected; also an account, subaddress or transaction the wallet does not have, and a void relay token |
| `INVALID_RECOVERY_MATERIAL` | a seed or keys were rejected |
| `WRONG_PASSWORD` | the password does not open the wallet bytes, or the old password of a change is wrong |
| `INVALID_WALLET_DATA` | the wallet bytes could not be opened |
| `INVALID_ADDRESS` | an address is malformed, of another network, or not of this wallet |
| `WALLET_CLOSED` | the wallet was closed or stopped |
| `MALFORMED_MESSAGE` | a message between the library and a worker did not have the expected form |
| `NATIVE_ERROR` | a native operation failed; also the WebAssembly module and worker failures |
| `DAEMON_ERROR` | a daemon request failed |
| `TX_NOT_POSSIBLE` | a transaction cannot be built or relayed with the wallet's funds or the chain's state |
| `TX_REJECTED` | the daemon refused a relayed transaction |
| `RELAY_UNKNOWN` | a relay request was sent and no usable answer came |

## Diagnostics

The diagnostic says what failed, as a fixed identifier chosen by the library: `DAEMON_NOT_CONNECTED`,
`NOT_ENOUGH_UNLOCKED`, `RESERVE_RATIO`, `WASM_MODULE_MISMATCH` and so on. None is derived from your
input or copied from native text. The [error reference](reference/errors.md) lists every code and
every diagnostic with its meaning. Treat the code as the category your interface reacts to and the
diagnostic as the detail for the message and for a support log.

## Codes a wallet must handle

| Code and diagnostic | Where | What the user interface does |
|---|---|---|
| `WRONG_PASSWORD` | `openWalletData`, `changePassword` | ask for the password again; do not count it as damaged data |
| `INVALID_WALLET_DATA` | `openWalletData` | the stored bytes are damaged, of another network, or not wallet bytes; offer a restore from the seed |
| `INVALID_RECOVERY_MATERIAL` | restores | the seed or keys are wrong; let the user check the words (`SEED_WORD_COUNT`: wrong number of words) |
| `INVALID_ADDRESS` | addresses, transfers | the address is malformed (`CORE_INVALID_ADDRESS`), of another network (`ADDRESS_NETWORK`) or not of this wallet (`ADDRESS_NOT_IN_WALLET`); ask for a correct address |
| `INVALID_CONFIG` | all | usually a bug in your code; for user input such as amounts and labels, map `AMOUNT_ZERO`, `AMOUNT_RANGE`, `AMOUNT_PRECISION`, `LABEL_LENGTH` and `LABEL_CHARACTERS` to field messages |
| `DAEMON_ERROR`/`DAEMON_NOT_CONNECTED` | daemon calls | no daemon, or it cannot be reached; in a browser also CORS or the worker's policy; show the connection state and let the user change the daemon |
| `DAEMON_ERROR`/`DAEMON_UNREACHABLE`, `DAEMON_RESPONSE` | daemon calls | the daemon did not answer or answered with an error; offer to retry or to use another daemon |
| `TX_NOT_POSSIBLE`/`NOT_ENOUGH_UNLOCKED` | builds | not enough unlocked funds in that asset and account; some funds may still be locked |
| `TX_NOT_POSSIBLE`/`NOT_ENOUGH_MONEY`, `NOT_ENOUGH_FOR_FEE` | builds | not enough funds for the amount, or for the amount and the fee |
| `TX_NOT_POSSIBLE`/`RESERVE_RATIO` | conversions | the reserve ratio does not allow this pair now |
| `TX_NOT_POSSIBLE`/`PRICING_RECORD_AGE` | relay of a conversion | the rate has expired; prepare again and show the new amounts |
| `TX_REJECTED` | relay | the daemon refused the transaction; sync and prepare again |
| `INVALID_CONFIG`/`TX_KEY_UNAVAILABLE`, `ADDRESS_NOT_IN_TX`, `TX_NOT_SENT` | proofs and keys | this wallet cannot prove that: it holds no key for the transaction (restored, or bytes from before the send), the address received nothing in it, or the wallet spent nothing in it ([chapter 6](06-history.md#proofs-and-transaction-keys)) |
| `RELAY_UNKNOWN` | relay | the transaction may have been sent; never show it as not sent ([chapter 7](07-sending.md#outcomes-of-a-relay)) |
| `WALLET_CLOSED` | all | the wallet was closed or stopped (`WALLET_TERMINATED`); open it again |
| `NATIVE_ERROR`/`WASM_MODULE_*`, `WORKER_FAILED` | first construction | the deployment is wrong: the module file, the secure context or the policy ([chapter 10](10-deploying-a-web-wallet.md)) |
| `NATIVE_ERROR`/`PASSWORD_STATE_UNKNOWN` | after a failed `changePassword` | close the wallet and open the bytes saved before |
| `UNSUPPORTED_CAPABILITY` | all | a bug or a missing feature, not a user error |

Write messages that say what happened, why if known, and what to do next, for example: "Not enough
unlocked ZSD in account 0. Some funds may still be locked; try again after more confirmations."

## No node text in errors

The core would pass text from the daemon into its errors, and native exception text can contain
recovery material, passwords, keys or credentials. The library never carries such text:

- the native bridge reports failures only as fixed identifiers, and any other failure is mapped by
  its context to a fixed code without reading its message;
- every daemon failure becomes `DAEMON_ERROR` with a fixed diagnostic; at relay the daemon's reason
  is read from the reply's status and boolean flags, never from its reason text;
- addresses, labels, configuration values and URLs are never copied into an error;
- only the code and the diagnostic cross the worker boundary; a received error is checked strictly
  and rebuilt.

So an error is safe to log and to show, but it does not tell you the node's own words. For a daemon
problem, check the daemon itself.

## Handling errors in code

Compare `code` and `diagnostic`; never parse `message`.

```ts run
import { createRandomWallet, openWalletData, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

function userMessage(err: unknown): string {
  if (!(err instanceof ZephyrWalletError)) return "Unexpected error. Please report it.";
  switch (err.code) {
    case "WRONG_PASSWORD":
      return "The password does not open this wallet. Enter the password again.";
    case "INVALID_WALLET_DATA":
      return "The stored wallet could not be opened. Restore it from its seed.";
    case "DAEMON_ERROR":
      return err.diagnostic === "DAEMON_NOT_CONNECTED"
        ? "Not connected to a daemon. Check the daemon address in the settings."
        : "The daemon did not answer. Try again or choose another daemon.";
    default:
      return `Wallet error ${err.code}${err.diagnostic === undefined ? "" : "/" + err.diagnostic}.`;
  }
}

const wallet = await createRandomWallet({ networkType: "mainnet", password: "right passphrase" });
const { keys, cache } = await wallet.getData();
try {
  await wallet.getDaemonHeight();
} catch (err) {
  console.log(userMessage(err));
}
await wallet.close();

try {
  await openWalletData({ networkType: "mainnet", password: "wrong passphrase", keysData: keys, cacheData: cache });
} catch (err) {
  console.log(userMessage(err));
}
try {
  await openWalletData({ networkType: "mainnet", password: "right passphrase", keysData: keys.slice(0, 100), cacheData: cache });
} catch (err) {
  console.log(userMessage(err));
}
```

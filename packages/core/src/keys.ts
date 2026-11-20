/**
 * A state key identifies one piece of state a transaction can depend on:
 *   "<address>:<slot>"     a storage slot (slot is a 32-byte hex word)
 *   "<address>:balance"    an account's native balance
 *   "<address>:nonce"      an account's nonce
 *   "<address>:page:<n>"   a 128-slot storage page (MIP-8), used for page-granularity analysis
 * Addresses and slots are lowercase so keys compare as plain strings.
 */
export type StateKey = string;

export function storageKey(address: string, slot: string): StateKey {
  return `${address.toLowerCase()}:${normalizeWord(slot)}`;
}

export function accountKey(address: string, field: "balance" | "nonce"): StateKey {
  return `${address.toLowerCase()}:${field}`;
}

export function parseKey(key: StateKey): { address: string; slot: string; isStorage: boolean } {
  const i = key.indexOf(":");
  const address = key.slice(0, i);
  const slot = key.slice(i + 1);
  return { address, slot, isStorage: slot.startsWith("0x") || slot.startsWith("page:") };
}

/**
 * Why a key makes txs wait, by who can fix it:
 *   storage  - a contract slot: contract design.
 *   balance  - native MON balance of an account that txs from *different* senders change (payments into one
 *              contract or address). Design too: e.g. prefund once and debit an internal balance per tx.
 *              (A sender's own gas payments are folded into nonce ordering when the graph is built.)
 *   nonce    - one sender's txs run in nonce order. Nothing to fix in a contract.
 */
export type KeyKind = "storage" | "balance" | "nonce";

export function keyKind(key: StateKey): KeyKind {
  if (isStorageKey(key)) return "storage";
  return key.endsWith(":nonce") ? "nonce" : "balance";
}

/** Storage slot or storage page, as opposed to balance/nonce. */
export function isStorageKey(key: StateKey): boolean {
  return key.includes(":0x") || key.includes(":page:");
}

/**
 * Ethereum precompiles (0x01–0x11), P256VERIFY (0x100) and Monad's system precompiles (staking at 0x1000).
 * None of them run EVM code, so their "storage" is not something a contract reads.
 */
export function isPrecompile(address: string): boolean {
  return BigInt(address) < 0x10000n;
}

export function normalizeWord(word: string): string {
  return "0x" + BigInt(word).toString(16).padStart(64, "0");
}
